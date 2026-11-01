import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cliCommand } from "./cli-command.js";

const run = promisify(execFile);
async function until(read, diagnostic) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(diagnostic());
}
async function tree(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.relative(directory, path.join(entry.parentPath, entry.name))).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(path.join(directory, file))])));
}
function answer(response, content, call) {
  const frame = (delta, finish_reason) => `data: ${JSON.stringify({ id: "release-fixture", object: "chat.completion.chunk", model: "release-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(frame(call ? { tool_calls: [{ index: 0, id: "reused-provider-id", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content }, null)
    + frame({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n");
}
const say = text => (_payload, response) => answer(response, text);
const tool = (name, args = {}) => (_payload, response) => answer(response, "", { name, args: { target: "long_term", ...args } });
const echo = (payload, response) => answer(response, String(payload.messages.at(-1).content));

// The combined contract is deliberately here: focused migration, memory receipt
// and publication crash permutations remain owned by their existing suites.
test("two courses preserve legacy/protected lectures and scoped feedback across GUI kill, CLI resume and real export", { timeout: 150_000 }, async t => {
  assert.ok(process.env.TUTOR_RECTO_ROOT, "Real document tools are required");
  const root = await mkdtemp(path.join(tmpdir(), "tutor-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), agent = path.join(root, "pi");
  await mkdir(agent);
  let steps = [], modelCalls = 0, ocrCalls = 0;
  const requests = [];
  async function serve(handler) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function body(request) { let text = ""; for await (const chunk of request) text += chunk; return JSON.parse(text); }
  const model = await serve(async (request, response) => {
    try {
      const payload = await body(request); requests.push(payload); modelCalls++;
      const step = steps.shift();
      if (!step) throw new Error("Unexpected model request");
      await step(payload, response);
    } catch (error) { response.writeHead(400).end(JSON.stringify({ error: { message: error.message } })); }
  });
  const ocr = await serve(async (request, response) => {
    await body(request); ocrCalls++;
    response.end(JSON.stringify({ pages: [{ index: 0, markdown: "# Fixture source\nOne original courseware page." }] }));
  });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: model + "/v1", api: "openai-completions", apiKey: "fixture-only",
    compat: { supportsUsageInStreaming: false }, models: [{ id: "release-model", input: ["text", "image"] }],
  } } }));
  const env = { ...process.env, MISTRAL_API_KEY: "fixture-only", PI_MEMORY_DIR: path.join(root, "memory"), NO_COLOR: "1" };
  const settings = ["--agent-dir", agent, "--model", "fixture/release-model", "--ocr", "mistral", "--mistral-base-url", ocr];
  const common = ["--data-dir", data, ...settings];
  function start(args, input = "") {
    const child = spawn(cliCommand[0], [...cliCommand.slice(1), ...args], { cwd: root, env });
    let output = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve({ code, output })); });
    t.after(async () => { child.kill("SIGKILL"); await exited; });
    child.stdin.end(input);
    return { child, exited, output: () => output, stop: async () => { child.kill("SIGKILL"); await exited; } };
  }
  async function cli(args, responses = [], input = "") {
    assert.equal(steps.length, 0, "the previous provider exchange must finish"); steps = [...responses];
    const result = await start([...common, ...args], input).exited;
    assert.equal(result.code, 0, result.output); assert.equal(steps.length, 0, result.output);
    return result.output;
  }
  async function pdf(name, title) {
    const typ = path.join(root, name + ".typ"), target = path.join(root, name + ".pdf");
    await writeFile(typ, `#set page(width: 10cm, height: 3cm)\n= ${title}\nSynthetic ${title} courseware.\n`);
    await run("typst", ["compile", typ, target]); return target;
  }
  const course = slug => readFile(path.join(data, slug, "course.json"), "utf8").then(JSON.parse);
  const route = (...titles) => `## Teaching order\n${titles.map((title, index) => `${index + 1}. ${title}`).join("\n")}`;
  const logicPdf = await pdf("logic", "Logic gates"), calculusPdf = await pdf("calculus", "Limits");
  await cli(["--course", "Logic", "--pdf", logicPdf, "--pages", "1"], [say(route("Logic gates")), say("# Original logic lecture\n\nAND requires both inputs. Source: PDF page 1.")], "confirm\ndone\n");
  const legacyOutput = await tree(path.join(data, "logic", "output"));
  // The actual exported old-format draft/output become migration inputs.
  await rm(path.join(data, "logic", "course.json"));
  await cli(["--course", "Logic", "--chapters"]);
  const migrated = await course("logic");
  const oldLogic = migrated.chapters[0];
  assert.equal(oldLogic.status, "pending"); assert.equal(oldLogic.lecture.status, "published");
  assert.deepEqual(await tree(path.join(data, "logic", "chapters", oldLogic.id, "output")), legacyOutput);
  const legacySources = Object.fromEntries((await Promise.all(["source", "original-pages", "parsed"].map(async name => [name, await tree(path.join(data, "logic", name))]))));

  await cli(["--course", "Calculus", "--pdf", calculusPdf, "--pages", "1"], [say(route("Limits")), say("# Limits lecture\n\nLimits describe nearby values. Source: PDF page 1.")], "confirm\ndone\n");
  const calcInitial = await course("calculus"), oldCalc = calcInitial.chapters[0];
  await cli(["--course", "Calculus", "--chapter-id", oldCalc.id, "--generate"], [say("# Limits chapter\n\nLimits describe nearby values. Source: PDF page 1.")]);
  await cli(["--course", "Logic", "--chapter-id", oldLogic.id, "--progress", "learned"]);

  const logicFact = "#preference Use truth tables for examples.";
  const calcFact = "#preference Use geometric pictures for examples.";
  const globalFact = "#preference Include detailed derivations.";
  await cli(["--course", "Logic", "--memory", "Remember: use truth tables for examples"], [tool("memory_write", { content: logicFact }), echo]);
  await cli(["--course", "Calculus", "--memory", "Remember: use geometric pictures for examples"], [tool("memory_write", { content: calcFact }), echo]);
  await cli(["--course", "Logic", "--memory", "Across courses include detailed derivations"], [tool("memory_write", { scope: "global", content: globalFact }), echo]);

  async function gui() {
    const process = start(["gui", "--no-open", "--port", "0", ...common]);
    const url = await until(() => process.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], process.output);
    const html = await (await fetch(url)).text(), token = html.match(/name="tutor-session" content="([^"]+)"/)?.[1];
    assert.ok(token);
    const request = async (route, value, expected = 200) => {
      const form = value instanceof FormData;
      const response = await fetch(url + route, { method: value ? "POST" : "GET", headers: { "x-tutor-session": token, ...value && !form ? { "content-type": "application/json" } : {} }, body: form ? value : value ? JSON.stringify(value) : undefined });
      assert.equal(response.status, expected, await response.clone().text()); return response;
    };
    const job = (id, status) => until(async () => {
      const state = await (await request("/api/state")).json(), current = state.tasks.find(task => task.id === id);
      if (["failed", "needs-attention"].includes(current?.status)) throw new Error(JSON.stringify(current));
      return current?.status === status && current;
    }, () => process.output());
    return { ...process, request, job };
  }
  let g = await gui();
  await g.request(`/api/courses/calculus/chapters/${oldCalc.id}/progress`, { status: "in_progress" });
  const protectedLogic = await course("logic"), protectedCalc = await course("calculus");
  assert.equal(protectedLogic.chapters[0].status, "learned");
  assert.equal(protectedCalc.chapters[0].status, "in_progress");
  assert.notEqual(protectedLogic.id, protectedCalc.id);
  const protectedTrees = await Promise.all([["logic", oldLogic.id], ["calculus", oldCalc.id]].map(([slug, id]) => tree(path.join(data, slug, "chapters", id, "output"))));
  async function assertProtected() {
    for (const [index, slug, before] of [[0, "logic", protectedLogic], [1, "calculus", protectedCalc]]) {
      const current = await course(slug);
      assert.equal(current.id, before.id);
      assert.deepEqual(current.chapters.find(chapter => chapter.id === before.chapters[0].id), before.chapters[0]);
      assert.deepEqual(current.materials.find(material => material.id === before.materials[0].id), before.materials[0]);
      assert.equal(current.route.chapterIds[0], before.chapters[0].id);
      assert.deepEqual(await tree(path.join(data, slug, "chapters", before.chapters[0].id, "output")), protectedTrees[index]);
    }
    for (const [name, files] of Object.entries(legacySources)) {
      for (const [file, bytes] of Object.entries(files)) assert.deepEqual(await readFile(path.join(data, "logic", name, file)), bytes, `legacy ${name}/${file}`);
    }
  }

  const supplement = await pdf("logic-new", "Sequential logic");
  steps = [say(route("Logic gates", "Sequential logic"))];
  const form = new FormData();
  form.set("course", "Logic"); form.set("selectionMode", "pages"); form.set("selection", "1");
  form.set("pdf", new Blob([await readFile(supplement)], { type: "application/pdf" }), "logic-new.pdf");
  const accepted = await (await g.request("/api/jobs", form, 202)).json();
  const waiting = await g.job(accepted.id, "awaiting-route");
  const afterAppend = await course("logic");
  assert.deepEqual(afterAppend.chapters.map(chapter => chapter.title), ["Logic gates", "Sequential logic"]);
  assert.equal(afterAppend.chapters[1].status, "pending");
  assert.notEqual(afterAppend.materials[0].id, afterAppend.materials[1].id);
  const completedBeforeKill = { modelCalls, ocrCalls };
  assert.equal(ocrCalls, 3, "each of the three admitted one-page sources was parsed once");
  await g.stop(); g = await gui();
  assert.equal((await g.job(accepted.id, "awaiting-route")).route, waiting.route);
  assert.deepEqual({ modelCalls, ocrCalls }, completedBeforeKill, "reopening cannot redo completed OCR/route or imply confirmation");
  assert.deepEqual((await course("logic")).route.chapterIds, afterAppend.route.chapterIds);

  // Stop a real model request in flight, then continue the original admitted task.
  steps = [() => {}];
  await g.request("/api/jobs/input", { id: accepted.id, confirm: true, route: waiting.route });
  await until(() => modelCalls === completedBeforeKill.modelCalls + 1, g.output);
  await g.stop();
  // Export the real memory tool result; the provider fixture supplies no facts.
  const memoryLecture = (payload, response) => answer(response, "# Sequential logic lecture\n\nA register retains state. Source: PDF page 1.\n\n" + payload.messages.at(-1).content);
  await cli(["--task-id", accepted.id, "--resume"], [tool("memory_read"), memoryLecture]);
  assert.equal(ocrCalls, completedBeforeKill.ocrCalls);
  await assertProtected();
  const delivered = await readFile(path.join(data, "logic", "output", "content.md"), "utf8");
  assert.match(delivered, /register retains state/);
  for (const fact of [logicFact, globalFact]) assert.equal(delivered.split(fact).length - 1, 1, "real scoped facts appear once in the exported result");
  assert.ok(!delivered.includes(calcFact));
  assert.ok(!JSON.stringify(requests.at(-2).messages).includes(calcFact));
  const completedCalls = modelCalls;
  await cli(["--task-id", accepted.id, "--resume"]);
  assert.equal(modelCalls, completedCalls, "reopening a completed task does not repeat generation");
  assert.equal(await readFile(path.join(data, "logic", "output", "content.md"), "utf8"), delivered);
  const tasks = JSON.parse(await cli(["tasks", "--json"])).tasks;
  assert.equal(tasks.filter(task => task.id === accepted.id && task.status === "succeeded").length, 1);
  assert.equal(tasks.find(task => task.id === accepted.id).courseId, migrated.id);

  const calcNew = await pdf("calculus-new", "Derivatives");
  await cli(["--course", "Calculus", "--pdf", calcNew, "--pages", "1"], [say(route("Limits", "Derivatives")), tool("memory_read"), (payload, response) => answer(response, "# Derivatives lecture\n\nThe derivative measures local change. Source: PDF page 1.\n\n" + payload.messages.at(-1).content)], "confirm\ndone\n");
  await assertProtected();
  assert.equal(ocrCalls, 4, "the second course's appended source is the only additional OCR work");
  const calcContent = await readFile(path.join(data, "calculus", "output", "content.md"), "utf8");
  for (const fact of [calcFact, globalFact]) assert.equal(calcContent.split(fact).length - 1, 1);
  assert.ok(!calcContent.includes(logicFact));
  assert.ok(!JSON.stringify(requests.at(-2).messages).includes(logicFact));
  const counts = { modelCalls, ocrCalls };
  await cli(["--course", "Logic", "--pdf", supplement, "--pages", "1"]);
  assert.deepEqual({ modelCalls, ocrCalls }, counts, "duplicate input is not parsed/generated again after recovery");
  assert.equal((await course("logic")).materials.length, 2);
  assert.equal((await course("calculus")).materials.length, 2);
  g = await gui();
  for (const [slug, title, input] of [["logic", "Sequential logic lecture", supplement], ["calculus", "Derivatives lecture", calcNew]]) {
    const files = await tree(path.join(data, slug, "output"));
    for (const file of ["content.md", "typst/document.typ", "document.pdf", "lecture.json"]) {
      const response = await g.request(`/api/courses/${slug}/files/${file}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), files[file]);
    }
    const manifest = JSON.parse(files["lecture.json"].toString());
    assert.ok(manifest.context.confirmedAt);
    const current = await course(slug);
    assert.equal(current.materials[1].sourceHash, createHash("sha256").update(await readFile(input)).digest("hex"));
    assert.equal(manifest.context.pages.length, 1, "the appended single-chapter selection supplies this lecture");
    assert.deepEqual(manifest.context.pages, current.materials[1].pages, "published provenance stays bound to the new material, not a protected chapter");
    assert.equal(manifest.route, current.route.markdown);
    const { stdout } = await run("pdftotext", [path.join(data, slug, "output", "document.pdf"), "-"]);
    assert.ok(stdout.includes(title), stdout);
    assert.ok(files["typst/document.typ"].toString().includes(title));
  }
  await g.stop();
  await assertProtected();
  assert.equal(steps.length, 0);
});

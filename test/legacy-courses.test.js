import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cliCommand } from "./cli-command.js";

const run = promisify(execFile);

function cli(args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(cliCommand[0], [...cliCommand.slice(1), ...args], { env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

async function succeeds(args, env, input) {
  const result = await cli(args, env, input);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return result.stdout;
}

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function body(request) {
  let value = "";
  for await (const chunk of request) value += chunk;
  return JSON.parse(value);
}

function sse(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "legacy-1", object: "chat.completion.chunk", created: 1, model: "legacy-model" };
  response.end([
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]", "",
  ].join("\n\n"));
}

async function tree(directory) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name))).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(path.join(directory, file))])));
}

async function startGui(t, dataDir, env) {
  const child = spawn(cliCommand[0], [...cliCommand.slice(1), "gui", "--no-open", "--port", "0", "--data-dir", dataDir], { env });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
  });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`GUI did not start: ${output}`)), 15_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on("data", (chunk) => (output += chunk));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const html = await (await fetch(url)).text();
  const token = html.match(/name="tutor-session" content="([^"]+)"/)?.[1];
  assert.ok(token);
  const request = (pathname, init = {}) => fetch(url + pathname, {
    ...init, headers: { "x-tutor-session": token, ...init.headers },
  });
  request.stop = async () => { child.kill("SIGTERM"); if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve)); };
  return request;
}

async function fixture(t) {
  assert.ok(process.env.TUTOR_RECTO_ROOT, "Real Recto export is required");
  const root = await mkdtemp(path.join(tmpdir(), "tutor-legacy-courses-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ocr = await serve(t, async (request, response) => {
    await body(request);
    response.end(JSON.stringify({ pages: [{ index: 0, markdown: "# Logic gates\nF = xy; AND truth table." }] }));
  });
  let publications = 0;
  const model = await serve(t, async (request, response) => {
    const payload = await body(request);
    if (JSON.stringify(payload.messages).includes("Write the complete lecture")) {
      publications++;
      return sse(response, publications === 1
        ? "# Original Boolean algebra lecture\n\nAn AND gate outputs 1 only when both inputs are 1.\n\n$$F = xy$$\n"
        : "# New whole course lecture\n\nSequential logic stores a state; this is new publication content.\n");
    }
    const message = payload.messages.findLast((entry) => entry.role === "user");
    const prompt = typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n");
    const titles = [...prompt.matchAll(/^\d+\.\s+(.+)$/gm)].map((match) => match[1]);
    sse(response, `## Teaching order\n${titles.map((title, index) => `${index + 1}. ${title}`).join("\n")}`);
  });
  const agentDir = path.join(root, "pi");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `${model}/v1`, api: "openai-completions", apiKey: "synthetic-legacy-key",
    compat: { supportsUsageInStreaming: false }, models: [{ id: "legacy-model", input: ["text", "image"] }],
  } } }));
  const dataDir = path.join(root, "data");
  const courseDir = path.join(dataDir, "digital-design");
  const env = { ...process.env, MISTRAL_API_KEY: "synthetic-ocr-key", PI_MEMORY_DIR: path.join(root, "memory"), NO_COLOR: "1" };
  const common = ["--course", "Digital Design", "--data-dir", dataDir, "--agent-dir", agentDir,
    "--model", "fixture/legacy-model", "--ocr", "mistral", "--mistral-base-url", ocr];
  const pdf = async (name, titles) => {
    const typ = path.join(root, `${name}.typ`);
    const target = path.join(root, `${name}.pdf`);
    await writeFile(typ, `#set page(width: 10cm, height: 3cm)\n${titles.map((title) => `= ${title}\nF = xy`).join("\n#pagebreak()\n")}\n`);
    await run("typst", ["compile", typ, target]);
    return target;
  };
  const originalPdf = await pdf("original", ["Boolean algebra"]);
  await succeeds([...common, "--pdf", originalPdf, "--chapter", "Boolean algebra"], env, "confirm\ndone\n");
  const originalLecture = JSON.parse(await readFile(path.join(courseDir, "output", "lecture.json"), "utf8"));
  const { stdout } = await run("pdftotext", [path.join(courseDir, "output", "document.pdf"), "-"]);
  assert.match(stdout, /Original Boolean algebra lecture/);
  await rm(path.join(courseDir, "course.json"));
  return { root, dataDir, courseDir, common, env, pdf, originalLecture };
}

test("legacy published chapter stays viewable and byte-identical through append, confirm and whole-course publication", { timeout: 120_000 }, async (t) => {
  const { dataDir, courseDir, common, env, pdf, originalLecture } = await fixture(t);
  // Earliest legacy format: separate context/route, no published manifest.
  await writeFile(path.join(courseDir, "context.json"), JSON.stringify(originalLecture.context));
  await writeFile(path.join(courseDir, "route.md"), originalLecture.route);
  await rm(path.join(courseDir, "draft.json"));
  await rm(path.join(courseDir, "output", "lecture.json"));
  const originalFiles = await tree(courseDir);
  const originalOutput = await tree(path.join(courseDir, "output"));
  const listed = await succeeds([...common, "--chapters"], env);
  assert.match(listed, /\[pending\].*Boolean algebra.*lecture published/, "Legacy export must be published without inferring learning progress");
  const migrated = JSON.parse(await readFile(path.join(courseDir, "course.json"), "utf8"));
  const chapter = migrated.chapters[0];
  const output = path.join(courseDir, "chapters", chapter.id, "output");
  const source = structuredClone(chapter.source);
  const material = structuredClone(migrated.materials[0]);
  assert.deepEqual(material.pages, originalLecture.context.pages);
  const chapterFiles = await tree(output);
  for (const [file, bytes] of Object.entries(originalOutput)) assert.deepEqual(chapterFiles[file], bytes, file);
  assert.deepEqual(JSON.parse(chapterFiles["lecture.json"].toString()), originalLecture);
  for (const [file, bytes] of Object.entries(originalFiles)) assert.deepEqual(await readFile(path.join(courseDir, file)), bytes, file);

  let request = await startGui(t, dataDir, env);
  const assertViewable = async () => {
    const response = await request("/api/courses/digital-design");
    assert.equal(response.status, 200);
    const detail = await response.json();
    const view = detail.chapters.find((entry) => entry.id === chapter.id);
    assert.equal(view.lecture.status, "published");
    assert.equal(view.lecture.content, originalOutput["content.md"].toString());
    for (const file of ["document.pdf", "content.md", "typst/document.typ"]) {
      const download = await request(`/api/courses/digital-design/chapters/${chapter.id}/files/${file}`);
      assert.equal(download.status, 200, file);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), originalOutput[file], file);
    }
  };
  await assertViewable();
  const marked = await request(`/api/courses/digital-design/chapters/${chapter.id}/progress`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "learned" }),
  });
  assert.equal(marked.status, 200);
  const boundFiles = await tree(output);
  const assertPreserved = async () => {
    const course = JSON.parse(await readFile(path.join(courseDir, "course.json"), "utf8"));
    const old = course.chapters.find((entry) => entry.id === chapter.id);
    assert.equal(old.status, "learned");
    assert.deepEqual(old.source, source);
    assert.deepEqual(course.materials.find((entry) => entry.id === material.id), material);
    assert.deepEqual(await tree(output), boundFiles);
    for (const [file, bytes] of Object.entries(originalFiles)) {
      if (/^(source\/|original-pages\/|parsed\/|context.json$|route.md$|\.course-name$)/.test(file)) {
        assert.deepEqual(await readFile(path.join(courseDir, file)), bytes, file);
      }
    }
  };
  await request.stop();
  const supplement = await pdf("supplement", ["Combinational logic", "Sequential logic"]);
  await succeeds([...common, "--pdf", supplement, "--pages", "1-2"], env);
  await assertPreserved();
  for (const [file, bytes] of Object.entries(originalOutput)) {
    assert.deepEqual(await readFile(path.join(courseDir, "output", file)), bytes, file);
  }
  // Stop at the real post-confirmation boundary before a later publication succeeds.
  const confirmed = await cli([...common, "--resume"], {
    ...env, TUTOR_RECTO_ROOT: path.join(courseDir, "missing-recto"),
    TUTOR_STUDY_NOTES: env.TUTOR_STUDY_NOTES ?? path.resolve(env.TUTOR_RECTO_ROOT, "../study-notes/SKILL.md"),
  }, "confirm\n");
  assert.equal(confirmed.code, 1, confirmed.stdout + confirmed.stderr);
  assert.match(confirmed.stderr, /Recto export failed/);
  assert.ok(JSON.parse(await readFile(path.join(courseDir, "course.json"), "utf8")).route.confirmedAt);
  await assertPreserved();
  const published = await succeeds([...common, "--generate"], env);
  assert.match(published, /Lecture exported/);
  await assertPreserved();
  assert.match(await readFile(path.join(courseDir, "output", "content.md"), "utf8"), /New whole course lecture/);
  request = await startGui(t, dataDir, env);
  await assertViewable();
  await request.stop();
  const reentered = await succeeds([...common, "--chapters"], env);
  assert.match(reentered, /\[learned\].*Boolean algebra.*lecture published/);
  await assertPreserved();
});

test("failed legacy binding preserves its inputs and retries using the published source rather than a newer draft", { timeout: 90_000 }, async (t) => {
  const { dataDir, courseDir, common, env, originalLecture } = await fixture(t);
  const candidate = structuredClone(originalLecture);
  candidate.context.selection.title = "Unconfirmed replacement";
  candidate.context.confirmedAt = null;
  candidate.route = "## New candidate\n1. Unconfirmed replacement\n";
  await writeFile(path.join(courseDir, "draft.json"), JSON.stringify(candidate));
  const originalFiles = await tree(courseDir);
  const originalOutput = await tree(path.join(courseDir, "output"));
  // A real filesystem obstruction fails after the exported lecture has been copied.
  const blocker = path.join(courseDir, "chapters");
  await writeFile(blocker, "Not a directory; migration must report failure without committing course.json.\n");
  const failed = await cli([...common, "--chapters"], env);
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /migration failed.*retry/i);
  await assert.rejects(readFile(path.join(courseDir, "course.json")), { code: "ENOENT" });
  for (const [file, bytes] of Object.entries(originalFiles)) assert.deepEqual(await readFile(path.join(courseDir, file)), bytes, file);
  await rm(blocker);

  const retry = await succeeds([...common, "--chapters"], env);
  assert.match(retry, /\[pending\].*Boolean algebra.*lecture published/);
  assert.doesNotMatch(retry, /Unconfirmed replacement/);
  const course = JSON.parse(await readFile(path.join(courseDir, "course.json"), "utf8"));
  assert.equal(course.chapters.length, 1);
  assert.equal(course.materials.length, 1);
  assert.equal(course.route.markdown, originalLecture.route);
  assert.equal(course.route.confirmedAt, originalLecture.context.confirmedAt);
  assert.deepEqual(course.materials[0].pages, originalLecture.context.pages);
  const chapter = course.chapters[0];
  assert.equal(chapter.source.startHeading, "Boolean algebra");
  assert.deepEqual(await tree(path.join(courseDir, "chapters", chapter.id, "output")), originalOutput);
  for (const [file, bytes] of Object.entries(originalFiles)) assert.deepEqual(await readFile(path.join(courseDir, file)), bytes, file);
  let request = await startGui(t, dataDir, env);
  const file = await request(`/api/courses/digital-design/chapters/${chapter.id}/files/document.pdf`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), originalOutput["document.pdf"]);
  await request.stop();
  await succeeds([...common, "--chapters"], env);
  assert.equal(JSON.parse(await readFile(path.join(courseDir, "course.json"), "utf8")).chapters[0].id, chapter.id);
});

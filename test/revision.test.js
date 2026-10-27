import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cli = path.join(import.meta.dirname, "..", "bin", "tutor.js");

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
}

async function body(request) {
  let data = "";
  for await (const chunk of request) data += chunk;
  return JSON.parse(data);
}

function sse(response, delta, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "1", object: "chat.completion.chunk", created: 1, model: "revision-model" };
  response.end([
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta } }] })}`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`,
    "data: [DONE]", "",
  ].join("\n\n"));
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

function userText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

test("CLI revises delivered lectures across processes while preserving usable output", { timeout: 120_000 }, async (t) => {
  assert.ok(process.env.TUTOR_RECTO_ROOT, "Set TUTOR_RECTO_ROOT to the installed Recto skill directory");
  const root = await mkdtemp(path.join(tmpdir(), "tutor-revision-"));
  const courseDir = path.join(root, "data", "digital-design");
  const parsed = path.join(courseDir, "parsed", "page-21");
  const output = path.join(courseDir, "output");
  await mkdir(parsed, { recursive: true });
  await mkdir(path.join(output, "media"), { recursive: true });
  await mkdir(path.join(output, "figures"), { recursive: true });
  await writeFile(path.join(parsed, "full.md"), "Boolean function F = xy with AND truth table.\n");
  await mkdir(path.join(courseDir, "original-pages"), { recursive: true });
  await writeFile(path.join(courseDir, "original-pages", "page-21.png"), "");
  await mkdir(path.join(courseDir, "source"), { recursive: true });
  await writeFile(path.join(courseDir, "source", "lecture.pdf"), "");
  await writeFile(path.join(courseDir, "route.md"), "## Route\n1. Boolean functions\n2. OR gates\n");
  await writeFile(path.join(courseDir, "context.json"), JSON.stringify({
    course: "Digital Design",
    selection: {
      type: "chapter",
      title: "Chapter One",
      startHeading: "Chapter One",
      startPage: 21,
      endHeading: "Chapter Two",
      endPage: 22,
    },
    confirmedAt: "2026-01-01T00:00:00.000Z",
    pages: [{
      sourcePage: 21,
      pagePdf: path.join(courseDir, "source", "lecture.pdf"),
      originalPageImage: path.join(courseDir, "original-pages", "page-21.png"),
      parsedDirectory: parsed,
      markdown: "Boolean function F = xy with AND truth table.",
    }],
    screenshots: [],
  }));
  const gate = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><path d="M0 5H20" stroke="black"/></svg>';
  await writeFile(path.join(output, "media", "gate.svg"), gate);
  const figureSource = "// source drawing retained for later regeneration\n";
  await writeFile(path.join(output, "figures", "gate-source.typ"), figureSource);
  const lecture = [
    "# Boolean logic", "", "## Boolean functions", "",
    "Original explanation. The formula needs both inputs at 1. 来源：PDF 第 21 页。", "",
    "$$F = xy$$", "", "Derivation: none.", "", "## OR gates", "",
    "OR outputs 1 unless both inputs are 0. Source: PDF page 22.", "",
    "Coverage: 来源：PDF 第 21–24 页。", "",
    "![AND gate, source PDF page 21](media/gate.svg)", "", "## Examples", "",
    "Original example: compute F when x=1 and y=1.", "",
  ].join("\n");
  await writeFile(path.join(output, "content.md"), lecture);

  const replacements = new Map([
    ["Rewrite the Boolean functions section", { oldText: "Original explanation.", newText: "Rewritten explanation from a different prerequisite route." }],
    ["Add the missing derivation", { oldText: "Derivation: none.", newText: "Added derivation: AND gives 1 only for x=1 and y=1." }],
    ["Use a different example", { oldText: "Original example: compute F when x=1 and y=1.", newText: "Replacement example: compute F when x=1 and y=0." }],
    ["Break export", { oldText: "Added derivation: AND gives 1 only for x=1 and y=1.", newText: "Added derivation: AND gives 1 only for x=1 and y=1.\n\n<div>Unsupported revision markup</div>" }],
  ]);
  let mode = "success";
  const requests = [];
  const model = await serve(t, async (request, response) => {
    const payload = await body(request);
    requests.push(payload);
    if (payload.messages.at(-1)?.role === "tool") return sse(response, { content: "Revision complete." });
    const prompt = userText(payload.messages.findLast((message) => message.role === "user"));
    const source = prompt.match(/\.revision-[^\s]+\/content\.md/)?.[0];
    const feedback = [...replacements.keys()].find((text) => prompt.includes(text));
    if (!source || !feedback) return response.writeHead(500).end(JSON.stringify({ error: { message: "fixture could not identify revision" } }));
    if (mode === "model-error") return response.writeHead(401).end(JSON.stringify({ error: { message: "fixture model unavailable" } }));
    const { oldText, newText } = replacements.get(feedback);
    return sse(response, {
      content: "I will make the targeted edit.",
      tool_calls: [{ index: 0, id: "edit-source", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: source, edits: [{ oldText, newText }] }) } }],
    }, "tool_calls");
  });

  const agentDir = path.join(root, "pi");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { tutorTest: {
    baseUrl: `${model}/v1`, api: "openai-completions", apiKey: "test-only",
    compat: { supportsUsageInStreaming: false }, models: [{ id: "revision-model", input: ["text", "image"] }],
  } } }));
  const common = ["--course", "Digital Design", "--data-dir", path.join(root, "data"), "--agent-dir", agentDir, "--model", "tutorTest/revision-model"];
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.MINERU_API_TOKEN;
  delete env.MISTRAL_API_KEY;

  const scoped = await runCli([...common, "--revise", "Remove the OR section and put examples first"], env);
  assert.equal(scoped.code, 1);
  assert.match(scoped.stderr, /teaching route.*confirm/i);
  assert.equal(requests.length, 0, "scope changes must not reach the revision model");

  await writeFile(path.join(courseDir, "revision-session.json"), JSON.stringify({ sessionFile: "../escaped.jsonl" }));
  const unsafeSession = await runCli([...common, "--revise", "Rewrite the Boolean functions section"], env);
  assert.equal(unsafeSession.code, 1);
  assert.match(unsafeSession.stderr, /stay inside \.sessions/);
  await rm(path.join(courseDir, "revision-session.json"));

  const citationFeedback = "Re-explain Boolean functions";
  replacements.set(citationFeedback, { oldText: "来源：PDF 第 21 页。", newText: "" });
  const citation = await runCli([...common, "--revise", citationFeedback], env);
  assert.equal(citation.code, 1, "Unrequested Chinese source-citation removal must fail");
  assert.match(citation.stderr, /revision would remove source citations: PDF 第 21 页/);
  assert.equal(await readFile(path.join(output, "content.md"), "utf8"), lecture);

  const rangeFeedback = "Condense the source coverage note";
  replacements.set(rangeFeedback, { oldText: "Coverage: 来源：PDF 第 21–24 页。", newText: "" });
  const range = await runCli([...common, "--revise", rangeFeedback], env);
  assert.equal(range.code, 1, "Unrequested Chinese source-range removal must fail");
  assert.match(range.stderr, /revision would remove source citations: PDF 第 21–24 页/);
  assert.equal(await readFile(path.join(output, "content.md"), "utf8"), lecture);

  for (const feedback of replacements.keys()) {
    if (feedback === "Break export") continue;
    if (feedback === citationFeedback) continue;
    if (feedback === rangeFeedback) continue;
    const revised = await runCli([...common, "--revise", feedback], env);
    assert.equal(revised.code, 0, revised.stderr);
    assert.match(revised.stdout, /Lecture revised/);
  }
  const source = await readFile(path.join(output, "content.md"), "utf8");
  assert.match(source, /Rewritten explanation/);
  assert.match(source, /Added derivation/);
  assert.match(source, /Replacement example/);
  assert.match(source, /OR outputs 1 unless both inputs are 0\. Source: PDF page 22\./);
  assert.match(source, /media\/[^)]*gate\.svg/);
  assert.match(source, /来源：PDF 第 21 页。/);
  assert.match(source, /来源：PDF 第 21(?:–|--)24 页。/);
  const mediaFile = (await readdir(path.join(output, "media"), { recursive: true })).find((file) => file.endsWith("gate.svg"));
  assert.equal(await readFile(path.join(output, "media", mediaFile), "utf8"), gate);
  assert.equal(await readFile(path.join(output, "figures", "gate-source.typ"), "utf8"), figureSource);
  const promptFor = (feedback) => {
    const payload = requests.findLast((payload) => {
      const message = payload.messages.findLast((message) => message.role === "user");
      return message !== undefined && userText(message).includes(feedback);
    });
    assert.ok(payload, `missing revision request: ${feedback}`);
    return userText(payload.messages.findLast((message) => message.role === "user"));
  };
  const currentPrompt = promptFor(citationFeedback);
  const reopenedPrompt = promptFor("Add the missing derivation");
  assert.match(currentPrompt, /Re-explain Boolean functions/);
  assert.match(reopenedPrompt, /Add the missing derivation/);
  assert.match(currentPrompt, /Requested chapter: Chapter One/);
  assert.match(currentPrompt, /do not cover Chapter Two/);
  assert.match(reopenedPrompt, /Requested chapter: Chapter One/);
  assert.match(reopenedPrompt, /do not cover Chapter Two/);

  const ordered = await readFile(path.join(output, "content.md"), "utf8");
  const examplesStart = ordered.indexOf("## Examples");
  const functionsStart = ordered.indexOf("## Boolean functions");
  const reordered = ordered.slice(0, functionsStart) + ordered.slice(examplesStart) + "\n" + ordered.slice(functionsStart, examplesStart);
  const orderFeedback = "Move the examples before the Boolean functions";
  replacements.set(orderFeedback, { oldText: ordered, newText: reordered });
  const orderChange = await runCli([...common, "--revise", orderFeedback], env);
  assert.equal(orderChange.code, 1, "changing teaching order without route confirmation must fail");
  assert.match(orderChange.stderr, /teaching route.*confirm/i);
  assert.equal(await readFile(path.join(output, "content.md"), "utf8"), ordered);

  const { stdout: pdfText } = await run("pdftotext", [path.join(output, "document.pdf"), "-"]);
  assert.match(pdfText, /Rewritten explanation/);
  await run("typst", ["compile", "--root", ".", "--font-path", "typst/fonts", "typst/document.typ", path.join(root, "rebuilt.pdf")], { cwd: output });

  const good = await readFile(path.join(output, "content.md"));
  mode = "export-error";
  const failed = await runCli([...common, "--revise", "Break export"], env);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Recto export failed/);
  assert.deepEqual(await readFile(path.join(output, "content.md")), good);
  const stages = (await readdir(courseDir)).filter((name) => name.startsWith(".revision-"));
  const drafts = await Promise.all(stages.map((stage) => readFile(path.join(courseDir, stage, "content.md"), "utf8").catch(() => "")));
  assert.ok(drafts.some((draft) => draft.includes("Unsupported revision markup")), "failed export must retain its staged source");
});

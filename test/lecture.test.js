import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cli = path.join(import.meta.dirname, "..", "bin", "tutor.js");

function runCli(args, input, env) {
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
    child.stdin.end(input);
  });
}

async function body(request) {
  let data = "";
  for await (const chunk of request) data += chunk;
  return JSON.parse(data);
}

function sse(response, delta, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "1", object: "chat.completion.chunk", created: 1, model: "lecture-model" };
  response.end([
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta } }] })}`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`,
    "data: [DONE]", "",
  ].join("\n\n"));
}

function userText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
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

test("confirmed CLI task exports portable lecture assets and preserves them on failures and restart", { timeout: 120_000 }, async (t) => {
  assert.ok(process.env.TUTOR_RECTO_ROOT, "Set TUTOR_RECTO_ROOT to the installed Recto 0.3.1 skill directory for real export tests");
  const root = await mkdtemp(path.join(tmpdir(), "tutor-lecture-"));
  const pdf = path.join(root, "lecture.pdf");
  await writeFile(
    path.join(root, "lecture.typ"),
    [
      "#set page(width: 5cm, height: 3cm)",
      "= Front Matter",
      "Course introduction",
      "#pagebreak()",
      "= Chapter One",
      "Boolean function",
      "#pagebreak()",
      "= Chapter Two",
      "Complement of a function",
    ].join("\n"),
  );
  await run("typst", ["compile", path.join(root, "lecture.typ"), pdf]);
  await run("pdftoppm", ["-jpeg", "-singlefile", pdf, path.join(root, "screenshot")]);
  const parsed = path.join(root, "parsed");
  await mkdir(path.join(parsed, "images"), { recursive: true });
  await writeFile(path.join(parsed, "full.md"), "Boolean function: F = xy. Distinct source detail: AND truth table.\n![AND gate](images/gate.svg)\n");
  await writeFile(path.join(parsed, "images", "gate.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect x="60" y="10" width="100" height="60" fill="white" stroke="black"/><text x="85" y="45">AND</text><path d="M0 25H60M0 55H60M160 40H240" stroke="black"/></svg>');
  await run("zip", ["-qr", path.join(root, "result.zip"), "."], { cwd: parsed });
  const zipBytes = await readFile(path.join(root, "result.zip"));
  let imports = [];
  const ocr = await serve(t, async (request, response) => {
    if (request.url === "/api/v4/file-urls/batch") {
      imports = (await body(request)).files;
      return response.end(JSON.stringify({ code: 0, data: { batch_id: "batch", file_urls: imports.map(() => `${ocr}/upload`) } }));
    }
    if (request.url === "/upload") { request.resume(); return response.end(); }
    if (request.url === "/api/v4/extract-results/batch/batch") {
      return response.end(JSON.stringify({ code: 0, data: { extract_result: imports.map((file) => ({ file_name: file.name, state: "done", full_zip_url: `${ocr}/result.zip` })) } }));
    }
    if (request.url === "/result.zip") return response.end(zipBytes);
    response.writeHead(404).end();
  });
  let mode = "success";
  const modelSecret = "lecture-command-key";
  const lectureRequests = [];
  const routeRequests = [];
  const model = await serve(t, async (request, response) => {
    const payload = await body(request);
    const messages = JSON.stringify(payload.messages);
    const prompt = userText(payload.messages.findLast((message) => message.role === "user"));
    if (prompt.includes("Edit exactly .revision-")) {
      if (payload.messages.at(-1)?.role === "tool") return sse(response, { content: "Revision complete." });
      const source = prompt.match(/\.revision-[^\s]+\/content\.md/)?.[0];
      return sse(response, {
        content: "I will make the targeted edit.",
        tool_calls: [{ index: 0, id: "edit-source", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: source, edits: [{
          oldText: "新增例题：输入都是 1 时，与运算才输出 1。",
          newText: "补充推导：先固定 x=1、y=1，再检查与运算条件。\n\n新增例题：输入都是 1 时，与运算才输出 1。",
        }] }) } }],
      }, "tool_calls");
    }
    if (messages.includes("Learner memory request:")) {
      if (payload.messages.at(-1).role === "tool") return sse(response, { content: String(payload.messages.at(-1).content) });
      return sse(response, { tool_calls: [{ index: 0, id: "read-memory", type: "function", function: {
        name: "memory_read", arguments: JSON.stringify({ target: "long_term" }),
      } }] }, "tool_calls");
    }
    if (!messages.includes("Write the complete lecture")) {
      routeRequests.push(payload);
      return sse(response, { content: messages.includes("Start with gates") ? "## Confirmed order\nGates first; Boolean functions second.\nUser preference: concise Chinese." : "## Route\nBoolean functions first; gates second." });
    }
    lectureRequests.push(payload);
    if (mode === "model-error") return response.writeHead(401).end(JSON.stringify({ error: { message: `Invalid key ${modelSecret}; upstream-private-detail` } }));
    if (mode === "truncated") return sse(response, { content: "# Incomplete lecture" }, "length");
    if (!payload.messages.some((message) => message.role === "tool")) {
      return sse(response, {
        content: "I will inspect the source before writing.",
        tool_calls: [{ index: 0, id: "read-source", type: "function", function: mode === "memory-error"
          ? { name: "memory_restore", arguments: JSON.stringify({ recoveryId: "invalid-id" }) }
          : { name: "read", arguments: JSON.stringify({ path: "route.md" }) } }],
      }, "tool_calls");
    }
    const content = mode === "export-error" ? "# Draft retained\n\n<div>Unsupported raw HTML</div>" : [
      "# Gates first", "", "布尔函数（Boolean function）在二值输入上定义输出。原公式见 PDF 第 1 页。", "",
      "\\[F = xy\\]", "", "The inline expression is \\(xy\\).", "", "| x | y | F |", "|---|---|---|", "| 0 | 0 | 0 |", "| 0 | 1 | 0 |", "| 1 | 0 | 0 |", "| 1 | 1 | 1 |", "",
      "![AND gate，来源 PDF 第 2 页](media/parsed-page-2/images/gate.svg)", "", "新增例题：输入都是 1 时，与运算才输出 1。", "",
    ].join("\n");
    return sse(response, { content });
  });
  const agentDir = path.join(root, "pi");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { tutorTest: {
    baseUrl: `${model}/v1`, api: "openai-completions", apiKey: `!printf ${modelSecret}`,
    compat: { supportsUsageInStreaming: false }, models: [{ id: "lecture-model", input: ["text", "image"] }],
  } } }));
  const dataDir = path.join(root, "data");
  const courseDir = path.join(dataDir, "digital-design");
  const env = { ...process.env, MINERU_API_TOKEN: "test-only-token", PI_MEMORY_DIR: path.join(root, "memory"), NO_COLOR: "1" };
  const common = ["--course", "Digital Design", "--data-dir", dataDir, "--agent-dir", agentDir, "--model", "tutorTest/lecture-model"];
  const args = [...common, "--pdf", pdf, "--chapter", "Chapter One", "--screenshots", path.join(root, "screenshot.jpg"), "--mineru-base-url", ocr];
  const unconfirmed = await runCli(args, "", env);
  assert.equal(unconfirmed.code, 0, unconfirmed.stderr);
  assert.match(unconfirmed.stdout, /Route was not confirmed/);
  const importContext = JSON.parse(await readFile(path.join(courseDir, "context.json"), "utf8"));
  assert.equal(importContext.selection.type, "chapter");
  assert.equal(importContext.selection.title, "Chapter One");
  assert.equal(importContext.selection.startHeading, "Chapter One");
  assert.equal(importContext.selection.startPage, 2);
  assert.equal(importContext.selection.endHeading, "Chapter Two");
  assert.equal(importContext.selection.endPage, 3);
  assert.deepEqual(importContext.pages.map((page) => page.sourcePage), [2, 3]);
  const routePrompt = JSON.stringify(routeRequests[0].messages);
  assert.match(routePrompt, /Requested chapter: Chapter One/);
  assert.match(routePrompt, /It ends at heading \\"Chapter Two\\" on PDF page 3/);
  assert.match(routePrompt, /Boundary page 3 may also contain/);
  assert.match(routePrompt, /do not cover Chapter Two/);
  await assert.rejects(readFile(path.join(courseDir, "output", "document.pdf")), { code: "ENOENT" });
  const denied = await runCli([...common, "--generate"], "", env);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Confirm the teaching route/);
  assert.equal(lectureRequests.length, 0, "unconfirmed material must never reach generation");

  const confirmed = await runCli(args, "Start with gates\nconfirm\nAdd the missing derivation\ndone\n", env);
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.match(confirmed.stdout, /Lecture exported/);
  assert.match(confirmed.stdout, /Lecture revised/);
  const prompt = JSON.stringify(lectureRequests[0].messages);
  assert.match(prompt, /Requested chapter: Chapter One/);
  assert.match(prompt, /It ends at heading \\"Chapter Two\\" on PDF page 3/);
  assert.match(prompt, /Boundary page 3 may also contain/);
  assert.match(prompt, /do not cover Chapter Two/);
  assert.match(prompt, /Gates first; Boolean functions second/);
  assert.match(prompt, /AND truth table/);
  assert.match(prompt, /data:image\/jpeg;base64/);
  assert.match(prompt, /data:image\/png;base64/);
  const output = path.join(courseDir, "output");
  const source = await readFile(path.join(output, "content.md"), "utf8");
  assert.doesNotMatch(source, /I will inspect/);
  assert.match(source, /media\//);
  assert.match(source, /\$\$F = xy\$\$/);
  assert.match(source, /\$xy\$/);
  assert.match(source, /补充推导：先固定 x=1、y=1/);
  const { stdout: extracted } = await run("pdftotext", [path.join(output, "document.pdf"), "-"]);
  assert.match(extracted, /Boolean function/);
  assert.match(extracted, /AND/);
  await run("typst", ["compile", "--root", ".", "--font-path", "typst/fonts", "typst/document.typ", path.join(root, "rebuilt.pdf")], { cwd: output });
  const learnerMemory = await runCli([...common, "--memory", "Show my learner memory"], "", env);
  assert.equal(learnerMemory.code, 0, learnerMemory.stderr);
  assert.match(learnerMemory.stdout, /empty or does not exist/, "generation without learner feedback must not create memory facts");
  const files = (await readdir(output, { recursive: true })).filter((file) => /\.(md|pdf|typ|svg)$/.test(file));
  const good = await Promise.all(files.map((file) => readFile(path.join(output, file))));
  // Generation is a separate caller: route/maintenance tests cannot catch it bypassing the shared guard.
  for (const failure of ["export-error", "truncated", "model-error", "memory-error"]) {
    mode = failure;
    const failed = await runCli([...common, "--generate"], "", env);
    assert.equal(failed.code, 1, `${failure}: ${failed.stdout}`);
    assert.doesNotMatch(failed.stdout, /Lecture exported/);
    assert.match(failed.stderr, failure === "export-error" ? /Unsupported Div/ : /generation failed/);
    if (failure === "memory-error") assert.match(failed.stderr, /memory operation failed.*memory_restore/);
    if (failure === "model-error") {
      assert.match(failed.stderr, /HTTP 401.*credentials/);
      assert.doesNotMatch(failed.stderr, /lecture-command-key|upstream-private-detail/);
    }
    assert.deepEqual(await Promise.all(files.map((file) => readFile(path.join(output, file)))), good);
    const context = JSON.parse(await readFile(path.join(courseDir, "context.json"), "utf8"));
    await readFile(path.join(context.pages[0].parsedDirectory, "full.md"));
    await readFile(context.pages[0].pagePdf);
  }
  const stages = (await readdir(courseDir)).filter((name) => name.startsWith(".lecture-"));
  const drafts = await Promise.all(stages.map((stage) => readFile(path.join(courseDir, stage, "content.md"), "utf8").catch(() => "")));
  assert.ok(drafts.some((draft) => draft.includes("Draft retained")), "failed export must keep the usable generated source");
  assert.ok(drafts.some((draft) => draft.includes("Incomplete lecture")), "failed generation must keep partial source");
  mode = "success";
  const resumed = await runCli([...common, "--generate"], "", env);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, /Lecture exported/);

  const lastChapterDataDir = path.join(root, "last-chapter-data");
  const lastChapter = await runCli([
    "--course", "Digital Design", "--data-dir", lastChapterDataDir, "--agent-dir", agentDir,
    "--model", "tutorTest/lecture-model", "--pdf", pdf, "--chapter", "Chapter Two",
    "--screenshots", path.join(root, "screenshot.jpg"), "--mineru-base-url", ocr,
  ], "", env);
  assert.equal(lastChapter.code, 0, lastChapter.stderr);
  const lastPrompt = JSON.stringify(routeRequests.at(-1).messages);
  assert.match(lastPrompt, /It runs through the final PDF page 3/);
  assert.doesNotMatch(lastPrompt, /do not cover end of PDF/);
  const lastContext = JSON.parse(await readFile(path.join(lastChapterDataDir, "digital-design", "context.json"), "utf8"));
  assert.equal(lastContext.selection.endHeading, null);
});

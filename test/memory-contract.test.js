import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cliCommand } from "./cli-command.js";
const run = promisify(execFile);
async function body(req) { let text = ""; for await (const chunk of req) text += chunk; return JSON.parse(text); }
function sse(res, delta, finish = "stop") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason) => JSON.stringify({ id: "memory-contract", object: "chat.completion.chunk", model: "memory-model", choices: [{ index: 0, delta, finish_reason }] });
  res.end(`data: ${chunk({ role: "assistant", ...delta }, null)}\n\ndata: ${chunk({}, finish)}\n\ndata: [DONE]\n\n`);
}
const say = (content) => (_req, res) => sse(res, { content });
const tool = (name, args) => (_req, res) => sse(res, { tool_calls: [{ index: 0, id: "reused-provider-id", type: "function", function: { name, arguments: JSON.stringify({ ...(name.startsWith("memory_") ? { target: "long_term" } : {}), ...args }) } }] }, "tool_calls");
const read = tool("memory_read", { target: "long_term" });
const echo = (req, res) => sse(res, { content: String(req.messages.at(-1).content) });
const waitUntil = async (check, diagnostic) => {
  const deadline = Date.now() + 15000;
  while (!await check()) { if (Date.now() > deadline) throw new Error(diagnostic()); await new Promise((resolve) => setTimeout(resolve, 15)); }
};
function start(args, env, input = "") {
  const child = spawn(cliCommand[0], [...cliCommand.slice(1), ...args], { env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => stdout += c); child.stderr.on("data", (c) => stderr += c);
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr })));
  child.stdin.end(input);
  return { child, exited, output: () => ({ stdout, stderr }) };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-memory-contract-"));
  const agent = path.join(root, "pi"), data = path.join(root, "data"), memory = path.join(root, "memory");
  await mkdir(agent); await mkdir(memory); await mkdir(data);
  const requests = []; let steps = [];
  const server = createServer(async (req, res) => {
    const payload = await body(req); requests.push(payload);
    try { const step = steps.shift(); if (!step) throw new Error("Unexpected model request"); await step(payload, res); }
    catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture-only", compat: { supportsUsageInStreaming: false }, models: [{ id: "memory-model", input: ["text", "image"] }] } } }));
  const env = { ...process.env, PI_MEMORY_DIR: memory, NO_COLOR: "1" };
  const args = (course) => ["--course", course, "--data-dir", data, "--agent-dir", agent, "--model", "fixture/memory-model"];
  const invoke = async (course, request, responses = [read, echo], extra = []) => {
    steps = [...responses]; const result = await start([...args(course), "--memory", request, ...extra], env).exited;
    assert.equal(result.code, 0, result.stderr); return result.stdout;
  };
  return { root, data, memory, agent, env, args, requests, invoke,
    steps: (responses) => { steps = [...responses]; },
    raw: (course, extra, input = "") => start([...args(course), ...extra], env, input),
  };
}

// Distinct from the legacy migration owner: live writes, stable UUID ownership,
// real GUI transport and authoritative progress must agree across new processes.
test("CLI and GUI memory enforce current-course scope, explicit global, temporary requests and chapter authority", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = "#preference [[course:logic]] Use truth tables.";
  const b = "#preference [[course:calculus]] Use geometric examples.";
  const global = "#preference [[learner-global]] Prefer detailed derivations.";
  await f.invoke("Logic", "Remember: use truth tables", [tool("memory_write", { content: a }), echo]);
  const course = JSON.parse(await readFile(path.join(f.data, "logic", "course.json")));
  await f.invoke("Calculus", "Remember: use geometric examples", [tool("memory_write", { content: b }), echo]);
  await f.invoke("Logic", "Across courses prefer detailed derivations", [tool("memory_write", { scope: "global", content: global }), echo]);
  const removedGlobal = await f.invoke("Logic", "Delete my global derivation preference", [tool("memory_forget", { scope: "global", match: "detailed derivations" }), echo]);
  const globalRecovery = removedGlobal.match(/Recovery ID: ([0-9a-f-]+)/i)[1];
  assert.ok(!(await f.invoke("Calculus", "Show memory")).includes(global));
  await f.invoke("Logic", `Restore global preference ${globalRecovery}`, [tool("memory_restore", { scope: "global", recoveryId: globalRecovery }), echo]);
  let result = await f.invoke("Calculus", "Show memory");
  assert.ok(result.includes(b) && result.includes(global) && !result.includes(a), result);
  assert.ok(!JSON.stringify(f.requests.at(-2).messages).includes(a));
  f.steps([tool("memory_write", { scope: "global", content: "#preference Prefer short answers" }), say("Saved")]);
  const implicitGlobal = await f.raw("Logic", ["--memory", "Prefer short answers"]).exited;
  assert.equal(implicitGlobal.code, 1); assert.match(implicitGlobal.stderr, /explicit cross-course/);
  for (const [name, args] of [
    ["memory_read", { scope: "calculus" }],
    ["memory_write", { content: b }],
    ["memory_forget", { scope: "calculus", match: "examples" }],
    ["read", { path: "../calculus/course.json" }],
  ]) {
    f.steps([tool(name, args), echo]);
    const attempt = await f.raw("Logic", ["--memory", "Read or update this course"]).exited;
    if (name === "read") assert.ok(!attempt.stdout.includes("geometric examples"));
    else { assert.equal(attempt.code, 1); assert.match(attempt.stderr, /scope|another course/); }
  }
  const deleted = await f.invoke("Calculus", "Delete geometric examples", [tool("memory_forget", { match: "geometric examples" }), echo]);
  const recoveryId = deleted.match(/Recovery ID: ([0-9a-f-]+)/i)[1];
  f.steps([tool("memory_restore", { recoveryId }), say("Restored")]);
  const denied = await f.raw("Logic", ["--memory", `Restore ${recoveryId}`]).exited;
  assert.equal(denied.code, 1); assert.match(denied.stderr, /unavailable in the selected scope/);
  await f.invoke("Calculus", `Restore ${recoveryId}`, [tool("memory_restore", { recoveryId }), echo]);
  // Temporary instructions reach the model without becoming durable preference.
  f.steps([tool("memory_write", { content: "#preference Use one example" }), say("Saved")]);
  const temporary = await f.raw("Logic", ["--memory", "Only for this reply use one example"]).exited;
  assert.equal(temporary.code, 1); assert.match(temporary.stderr, /temporary request/);
  result = await f.invoke("Logic", "Show memory");
  assert.ok(result.includes(a) && result.includes(global) && !result.includes("#preference Use one example"));
  const chapterId = "11111111-1111-4111-8111-111111111111";
  // Synthetic course-state fixture; all progress changes below use CLI or HTTP.
  course.chapters = [{ id: chapterId, version: 1, title: "Truth tables", status: "pending", order: 1,
    source: { materialId: "fixture", materialVersion: "fixture" }, needsConfirmation: false, progressUpdatedAt: null, lecture: { status: "none", courseVersion: 1 } }];
  course.route = { version: 1, markdown: "## Teaching order\n1. Truth tables", confirmedAt: null, chapterIds: [chapterId] };
  const otherFile = path.join(f.data, "calculus", "course.json");
  const otherCourse = JSON.parse(await readFile(otherFile));
  const otherChapter = "55555555-5555-4555-8555-555555555555";
  otherCourse.chapters = [{ ...course.chapters[0], id: otherChapter }];
  otherCourse.route = { ...course.route, chapterIds: [otherChapter] };
  await writeFile(otherFile, JSON.stringify(otherCourse));
  await f.invoke("Calculus", "I have learned Truth tables", [tool("memory_write", { content: "#progress Truth tables", chapterId: otherChapter, status: "learned", evidence: "I have learned Truth tables" }), echo]);
  await f.invoke("Calculus", "I swapped geometric axes twice", [tool("memory_write", { content: "#weakness Geometric axes private canary", evidence: "swapped geometric axes twice", inferred: true }), echo]);

  await writeFile(path.join(f.data, "logic", "course.json"), JSON.stringify(course));
  for (const evidence of ["Show memory", "Show my learned chapters", "请显示我已学完的章节", "I have not yet mastered Truth tables"]) {
    f.steps([tool("memory_write", { content: "#progress Truth tables", chapterId, status: "learned", evidence }), say("Saved")]);
    const invented = await f.raw("Logic", ["--memory", evidence]).exited;
    assert.equal(invented.code, 1, "a read request or negative feedback cannot authorize learned progress");
  }
  const evidence = "I have learned Truth tables";
  await f.invoke("Logic", evidence, [tool("memory_write", { content: "#progress Truth tables", chapterId, status: "learned", evidence }), echo]);
  result = await f.invoke("Logic", "Show memory");
  assert.match(result, /Truth tables: learned/);
  assert.equal((result.match(/#progress/g) ?? []).length, 1, "no duplicate text progress authority");
  assert.match((await f.raw("Logic", ["--chapters"]).exited).stdout, /learned/);
  await f.invoke("Logic", "I confused the rows twice", [tool("memory_write", { content: "#weakness Confusing table rows", evidence: "confused the rows twice", inferred: true }), echo]);
  assert.match(await f.invoke("Logic", "Show memory"), /Status: pending verification/);
  f.steps([tool("memory_write", { content: "#weakness Unable to reason", inferred: true }), say("Saved")]);
  assert.equal((await f.raw("Logic", ["--memory", "Help me with this topic"]).exited).code, 1, "inferences without evidence must fail");

  const guiChild = spawn(cliCommand[0], [...cliCommand.slice(1), "gui", "--no-open", "--port", "0", "--data-dir", f.data, "--agent-dir", f.agent, "--model", "fixture/memory-model"], { env: f.env });
  let log = "";
  guiChild.stdout.on("data", (c) => log += c); guiChild.stderr.on("data", (c) => log += c);
  t.after(() => guiChild.kill("SIGTERM"));
  await waitUntil(() => /http:\/\/127\.0\.0\.1:\d+/.test(log), () => log);
  const url = log.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const html = await (await fetch(url)).text(); const token = html.match(/name="tutor-session" content="([^"]+)"/)[1];
  const request = (route, data) => fetch(url + route, { method: data ? "POST" : "GET", headers: { "x-tutor-session": token, "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  const marked = await request(`/api/courses/logic/chapters/${chapterId}/progress`, { status: "in_progress" });
  assert.equal(marked.status, 200);
  assert.match(await f.invoke("Logic", "Show memory"), /Truth tables: in_progress/, "GUI marks and CLI memory share progress");
  await f.invoke("Logic", "I have not yet learned Truth tables", [tool("memory_write", { content: "#progress Truth tables", chapterId, status: "pending", evidence: "I have not yet learned Truth tables" }), echo]);
  assert.match((await f.raw("Logic", ["--chapters"]).exited).stdout, /pending/);
  assert.equal((await request(`/api/courses/logic/chapters/${chapterId}/progress`, { status: "in_progress" })).status, 200);
  const forgottenProgress = await f.invoke("Logic", "Delete the chapter progress", [tool("memory_forget", { match: chapterId }), echo]);
  const progressRecovery = forgottenProgress.match(/Recovery ID: ([0-9a-f-]+)/i)[1];
  assert.match(await f.invoke("Logic", "Show memory"), /Truth tables: pending/);
  await f.invoke("Logic", `Restore ${progressRecovery}`, [tool("memory_restore", { recoveryId: progressRecovery }), echo]);
  const progressView = await f.invoke("Logic", "Show memory");
  assert.match(progressView, /Truth tables: in_progress/); assert.equal((progressView.match(/#progress/g) ?? []).length, 1);
  assert.ok(!progressView.includes(otherChapter) && !progressView.includes("Geometric axes private canary"));
  assert.match((await f.raw("Calculus", ["--chapters"]).exited).stdout, /learned/, "other-course chapter progress survives correction/deletion/restoration");

  const before = await f.invoke("Calculus", "Show memory");
  f.steps([read, echo]);
  const accepted = await request("/api/jobs", { action: "memory", courseId: "logic", feedback: "Show memory" });
  assert.equal(accepted.status, 202);
  let job;
  await waitUntil(async () => { job = (await (await request("/api/state")).json()).job; return ["failed", "succeeded"].includes(job?.status); }, () => JSON.stringify(job));
  assert.equal(job.status, "succeeded", job.log);
  assert.ok(job.log.includes(a) && job.log.includes(global) && !job.log.includes(b), job.log);
  assert.equal(await f.invoke("Calculus", "Show memory"), before, "maintenance never changes another course");
  // UUID, rather than directory slug, remains the memory owner after relocation.
  await rename(path.join(f.data, "logic"), path.join(f.data, "renamed-logic"));
  await writeFile(path.join(f.data, "renamed-logic", ".course-name"), "Renamed Logic\n");
  course.name = "Renamed Logic";
  const relocated = JSON.parse(await readFile(path.join(f.data, "renamed-logic", "course.json")));
  relocated.name = "Renamed Logic"; await writeFile(path.join(f.data, "renamed-logic", "course.json"), JSON.stringify(relocated));
  assert.ok((await f.invoke("Renamed Logic", "Show memory")).includes(a));
});

// The FIFO pauses a real course-file read after Pi has committed tool intent.
// A real SQLite writer then blocks ONLY the official receipt. The effect is
// observed through another course's public global read before SIGKILL.
test("CLI replays a memory effect killed after write but before receipt exactly once", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  await f.raw("Logic", ["--chapters"]).exited;
  await f.raw("Observer", ["--chapters"]).exited;
  const file = path.join(f.data, "logic", "course.json");
  const original = await readFile(file, "utf8");
  const backup = path.join(f.data, "logic", ".course-before-fifo.json");
  let writer; let locked; let first;
  t.after(() => { first?.child.kill("SIGKILL"); writer?.kill("SIGKILL"); locked?.kill("SIGKILL"); });
  const opened = Promise.withResolvers();
  f.steps([async (payload, response) => {
    await rename(file, backup);
    await run("mkfifo", [file]);
    writer = spawn("python3", ["-c", "import sys\nf=open(sys.argv[1], 'w')\nprint('opened', flush=True)\nf.write(sys.stdin.read())\nf.close()", file]);
    writer.stdout.once("data", () => opened.resolve());
    tool("memory_write", { scope: "global", content: "#preference [[learner-global]] Replay boundary canary." })(payload, response);
  }]);
  first = f.raw("Logic", ["--memory", "Across courses remember replay boundary canary"]);
  await Promise.race([opened.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(JSON.stringify(first.output()))), 15000))]);
  const sqlite = path.join(f.data, "logic", ".durable", "session.sqlite");
  locked = spawn("/usr/bin/sqlite3", [sqlite]);
  locked.stdin.write(".timeout 5000\nBEGIN IMMEDIATE;\n.print receipt-blocked\n");
  await new Promise((resolve, reject) => { locked.stdout.once("data", resolve); locked.once("exit", (code) => reject(new Error(`SQLite lock exited ${code}`))); });
  writer.stdin.end(original);
  await new Promise((resolve) => writer.once("exit", resolve));
  await rm(file); await rename(backup, file);
  const visible = await f.invoke("Observer", "Show global memory");
  assert.equal(visible.split("Replay boundary canary.").length - 1, 1, "effect committed while the official receipt is blocked");
  assert.equal(first.child.exitCode, null);
  assert.equal(f.requests.length, 3, "blocked receipt cannot reach a post-tool request");
  first.child.kill("SIGKILL"); await first.exited;
  locked.stdin.end("ROLLBACK;\n.quit\n");
  await new Promise((resolve) => locked.once("exit", resolve)); locked = undefined;
  const resumed = await f.invoke("Logic", "resume", [echo], ["--resume"]);
  assert.match(resumed, /Learner memory saved/);
  const after = await f.invoke("Observer", "Show global memory");
  assert.equal(after.split("Replay boundary canary.").length - 1, 1);
  // Provider IDs deliberately repeat; a new admitted invocation still applies.
  await f.invoke("Logic", "Across courses remember replay boundary canary", [tool("memory_write", { scope: "global", content: "#preference [[learner-global]] Replay boundary canary." }), echo]);
  assert.equal((await f.invoke("Observer", "Show global memory")).split("Replay boundary canary.").length - 1, 2);
});

test("legacy migration retries without loss, binds known progress, and quarantines mixed/unassigned records", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  await f.raw("Logic", ["--chapters"]).exited; await f.raw("Calculus", ["--chapters"]).exited;
  const file = path.join(f.data, "logic", "course.json");
  const course = JSON.parse(await readFile(file));
  const chapterId = "22222222-2222-4222-8222-222222222222";
  course.chapters = [{ id: chapterId, version: 1, title: "Truth tables", status: "pending", order: 1, source: { materialId: "fixture", materialVersion: "fixture" }, needsConfirmation: false, progressUpdatedAt: null, lecture: { status: "none", courseVersion: 1 } }];
  course.route.chapterIds = [chapterId]; await writeFile(file, JSON.stringify(course));
  const stamped = "<!-- 2026-01-01 10:00:00 [legacy] -->\r\n#preference [[course:Logic]] Explain each row.\r\n\r\nKeep the second paragraph with this fact.";
  const raw = `\uFEFF#preference [[learner-global]] Use Chinese.\r\n\r\n${stamped}\r\n<!-- 2026-01-01 10:00:01 [legacy] -->\r\n#preference [[course:logic]] Mixed private A.\r\n\r\n#weakness [[course:calculus]] Mixed private B.\r\n<!-- 2026-01-01 10:00:02 [legacy] -->\r\n#progress [[course:logic]] Truth tables: already learned, per learner feedback.\r\n<!-- 2026-01-01 10:00:03 [legacy] -->\r\n#progress [[course:logic]] Unknown concept: already learned.\r\n<!-- 2026-01-01 10:00:04 [legacy] -->\r\n#preference [[course:future]] Future-course canary.\r\n`;
  await writeFile(path.join(f.memory, "MEMORY.md"), raw);
  await mkdir(path.join(f.memory, "daily")); await writeFile(path.join(f.memory, "daily", "2026-01-01.md"), "Unassigned daily private canary");
  await mkdir(path.join(f.memory, "recovery"));
  const recoveryId = "33333333-3333-4333-8333-333333333333";
  const recovery = JSON.stringify({ version: 1, id: recoveryId, createdAt: "2026-01-01T00:00:00Z", target: "long_term", removedContent: ["#preference [[course:logic]] Restored legacy canary."] });
  await writeFile(path.join(f.memory, "recovery", `${recoveryId}.json`), recovery);
  const broken = path.join(f.memory, "recovery", "broken.json"); await writeFile(broken, "{not-json");
  const failed = await f.raw("Logic", ["--memory", "Show memory"]).exited;
  assert.equal(failed.code, 1); assert.match(failed.stderr, /memory read\/setup failed/); assert.equal(f.requests.length, 0);
  assert.equal(await readFile(path.join(f.memory, "MEMORY.md"), "utf8"), raw);
  await writeFile(broken, JSON.stringify({ version: 1, id: "44444444-4444-4444-8444-444444444444", target: "daily", removedContent: ["Unassigned recovery private canary"] }));
  let visible = await f.invoke("Logic", "Show memory");
  assert.ok(visible.includes("Explain each row.") && visible.includes("Keep the second paragraph") && visible.includes("Use Chinese."));
  assert.match(visible, /Truth tables: learned/, "unambiguous old learner progress maps to course chapter authority");
  for (const canary of ["Mixed private A", "Mixed private B", "Unknown concept", "Future-course canary", "daily private", "recovery private"]) {
    assert.ok(!visible.includes(canary), visible);
    assert.ok(!JSON.stringify(f.requests.at(-2).messages).includes(canary));
  }
  assert.match((await f.raw("Logic", ["--chapters"]).exited).stdout, /learned/);
  const deleted = await f.invoke("Logic", "Delete row preference", [tool("memory_forget", { match: "Explain each row." }), echo]);
  const newRecovery = deleted.match(/Recovery ID: ([0-9a-f-]+)/i)[1];
  visible = await f.invoke("Logic", "Show memory");
  assert.ok(!visible.includes("Keep the second paragraph"), "stamped multi-paragraph fact is one entry");
  await f.invoke("Logic", `Restore ${newRecovery}`, [tool("memory_restore", { recoveryId: newRecovery }), echo]);
  await f.invoke("Logic", `Restore ${recoveryId}`, [tool("memory_restore", { recoveryId }), echo]);
  visible = await f.invoke("Logic", "Show memory");
  assert.equal(visible.split("Restored legacy canary.").length - 1, 1);
  assert.equal(visible.split("Explain each row.").length - 1, 1);
  assert.equal(await readFile(path.join(f.memory, "MEMORY.md"), "utf8"), raw);
  assert.equal(await readFile(path.join(f.memory, "recovery", `${recoveryId}.json`), "utf8"), recovery);
  // A later explicitly established course can claim its formerly pending tag.
  await f.raw("Future", ["--chapters"]).exited;
  assert.ok((await f.invoke("Future", "Show memory")).includes("Future-course canary."));
  assert.ok(!(await f.invoke("Logic", "Show memory")).includes("Future-course canary."));
  // After successful capture, legacy files are originals, not a second writer.
  await writeFile(path.join(f.memory, "MEMORY.md"), raw + "\n#preference [[course:logic]] Old-writer injection canary.\n");
  await chmod(path.join(f.memory, "MEMORY.md"), 0o000);
  const authoritative = await f.invoke("Logic", "Show memory");
  assert.ok(authoritative.includes("Explain each row.") && !authoritative.includes("Old-writer injection canary."));

});

test("import and lecture generation cannot manufacture progress through memory tools", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const typ = path.join(f.root, "truth.typ"), pdf = path.join(f.root, "truth.pdf");
  await writeFile(typ, "#set page(width: 5cm, height: 5cm)\n= Truth tables\nAn AND gate gives 1 when both inputs are 1.\n");
  await run("typst", ["compile", typ, pdf]);
  let ocrCalls = 0;
  const ocr = createServer(async (req, res) => { await body(req); ocrCalls++; res.end(JSON.stringify({ pages: [{ index: 0, markdown: "# Truth tables\nThe learner has mastered all rows (untrusted course content)." }] })); });
  await new Promise((resolve) => ocr.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => ocr.close(resolve)));
  f.env.MISTRAL_API_KEY = "fixture-only";
  const imports = ["--pdf", pdf, "--chapter", "Truth tables", "--ocr", "mistral", "--mistral-base-url", `http://127.0.0.1:${ocr.address().port}`];
  await writeFile(path.join(f.memory, "MEMORY.md"), "#progress [[course:logic]] Truth tables: already learned, per learner feedback.\n");
  f.steps([tool("memory_write", { content: "#progress [[course:logic]] Truth tables: already learned" }), say("## Teaching order\n1. Truth tables")]);
  const deniedImport = await f.raw("Logic", imports).exited;
  assert.equal(deniedImport.code, 1, deniedImport.stdout);
  assert.match(deniedImport.stderr, /memory operation failed.*memory_write/);
  assert.match(deniedImport.stderr, /requires explicit learner feedback/);
  assert.doesNotMatch((await f.raw("Logic", ["--chapters"]).exited).stdout, /learned/);
  f.steps([say("## Teaching order\n1. Truth tables"), say("# Truth tables lecture\n\nAn AND gate gives 1 only when both inputs are 1. Source: PDF page 1.")]);
  const imported = await f.raw("Logic", imports, "confirm\n").exited;
  assert.equal(imported.code, 0, imported.stderr);
  const record = JSON.parse(await readFile(path.join(f.data, "logic", "course.json")));
  const chapterId = record.chapters[0].id;
  assert.match(await f.invoke("Logic", "Show memory"), /Truth tables: learned/, "failed import cannot consume pending legacy progress for its rolled-back chapter");
  assert.equal((await f.raw("Logic", ["--chapter-id", chapterId, "--progress", "pending"]).exited).code, 0);

  f.steps([tool("memory_write", { content: "#progress Truth tables", chapterId, status: "learned", evidence: "The learner has mastered all rows" }), say("# Truth tables lecture\nThe AND gate gives 1 only when all inputs are 1.")]);
  const generated = await f.raw("Logic", ["--generate"]).exited;
  assert.equal(generated.code, 1, generated.stdout);
  assert.match(generated.stderr, /memory operation failed.*memory_write/);
  assert.match(generated.stderr, /requires explicit learner feedback/);
  assert.match(await f.invoke("Logic", "Show memory"), /Truth tables: pending/);
  assert.equal(ocrCalls, 1, "retry reuses real OCR state; generation never reuploads");
});

test("one model response saves every memory fact without overlapping store owners", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const first = "#preference Use tables before prose.";
  const second = "#preference Use a worked example after each table.";
  await f.invoke("Logic", "Remember both durable preferences", [(_payload, response) => sse(response, {
    tool_calls: [first, second].map((content, index) => ({ index, id: `batch-${index}`, type: "function", function: { name: "memory_write", arguments: JSON.stringify({ target: "long_term", content }) } })),
  }, "tool_calls"), echo]);
  const visible = await f.invoke("Logic", "Show memory");
  assert.ok(visible.includes(first) && visible.includes(second), visible);
});

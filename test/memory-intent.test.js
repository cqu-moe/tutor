import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliCommand } from "./cli-command.js";

function sse(res, delta, finish = "stop") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason) => JSON.stringify({ id: "memory-intent", object: "chat.completion.chunk", model: "memory-model", choices: [{ index: 0, delta, finish_reason }] });
  res.end(`data: ${chunk({ role: "assistant", ...delta }, null)}\n\ndata: ${chunk({}, finish)}\n\ndata: [DONE]\n\n`);
}
const tool = (name, args = {}) => (_req, res) => sse(res, { tool_calls: [{ index: 0, id: "reused-provider-id", type: "function", function: { name, arguments: JSON.stringify({ target: "long_term", ...args }) } }] }, "tool_calls");
const echo = (req, res) => sse(res, { content: String(req.messages.at(-1).content) });

// Only provider responses are fixed. Each invocation reopens real CLI storage.
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-memory-intent-"));
  const agent = path.join(root, "pi"), data = path.join(root, "data"), memory = path.join(root, "memory");
  for (const dir of [agent, data, memory]) await mkdir(dir);
  let steps = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const step = steps.shift();
    if (!step) { res.writeHead(400); res.end("Unexpected model request"); return; }
    step(JSON.parse(raw), res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture-only",
    compat: { supportsUsageInStreaming: false }, models: [{ id: "memory-model", input: ["text", "image"] }],
  } } }));
  const cli = async (course, extra) => {
    const child = spawn(cliCommand[0], [...cliCommand.slice(1), "--course", course, "--data-dir", data, "--agent-dir", agent, "--model", "fixture/memory-model", ...extra], { env: { ...process.env, PI_MEMORY_DIR: memory, NO_COLOR: "1" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve({ code, stdout, stderr })); });
    child.stdin.end(); return exited;
  };
  const request = async (course, feedback, responses = [tool("memory_read"), echo]) => {
    steps = [...responses]; return cli(course, ["--memory", feedback]);
  };
  const invoke = async (...args) => { const result = await request(...args); assert.equal(result.code, 0, result.stderr); return result.stdout; };
  const deny = async (feedback, name, args, reason) => {
    const result = await request("Logic", feedback, [tool(name, args), echo]);
    assert.equal(result.code, 1, `${feedback}: ${name} must be denied`);
    assert.match(result.stderr, reason);
  };
  return { data, cli, invoke, deny };
}
const recoveryId = (output) => { const id = output.match(/Recovery ID: ([0-9a-f-]+)/i)?.[1]; assert.ok(id, output); return id; };

test("global deletion and restoration require the learner's global scope", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const fact = "#preference Prefer detailed derivations.";
  await f.invoke("Logic", "Across courses prefer detailed derivations", [tool("memory_write", { scope: "global", content: fact }), echo]);
  const before = await f.invoke("Observer", "Show global memory");
  await f.deny("Delete this course preference", "memory_forget", { scope: "global", match: "detailed derivations" }, /explicit cross-course/);
  assert.equal(await f.invoke("Observer", "Show global memory"), before, "denial preserves the global fact and recoveries");
  const id = recoveryId(await f.invoke("Logic", "Delete global preference for derivations", [tool("memory_forget", { scope: "global", match: "detailed derivations" }), echo]));
  const deleted = await f.invoke("Observer", "Show global memory");
  assert.ok(!deleted.includes(fact));
  await f.deny(`Restore this course preference ${id}`, "memory_restore", { scope: "global", recoveryId: id }, /explicit cross-course/);
  assert.equal(await f.invoke("Observer", "Show global memory"), deleted, "denial leaves deletion recoverable and unapplied");
  await f.invoke("Logic", `Restore global preference ${id}`, [tool("memory_restore", { scope: "global", recoveryId: id }), echo]);
  assert.equal(await f.invoke("Observer", "Show global memory"), before);
});

test("universal future wording and natural global maintenance work without promoting course feedback", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const chinese = "#preference 讲解尽量简洁。";
  await f.invoke("Logic", "以后都这样，讲解尽量简洁。", [tool("memory_write", { scope: "global", content: chinese }), echo]);
  assert.ok((await f.invoke("Calculus", "Show memory")).includes(chinese));
  const english = "#preference Prefer detailed derivations.";
  await f.invoke("Logic", "In all future courses, prefer detailed derivations", [tool("memory_write", { scope: "global", content: english }), echo]);
  const id = recoveryId(await f.invoke("Logic", "Delete my global derivation preference", [tool("memory_forget", { scope: "global", match: "detailed derivations" }), echo]));
  assert.ok(!(await f.invoke("Calculus", "Show memory")).includes(english));
  await f.invoke("Logic", `Restore my global derivation preference ${id}`, [tool("memory_restore", { scope: "global", recoveryId: id }), echo]);
  assert.ok((await f.invoke("Calculus", "Show memory")).includes(english));
  const course = "#preference Use diagrams before formulas.";
  await f.invoke("Logic", "Diagrams before formulas work better for me", [tool("memory_write", { content: course }), echo]);
  const details = "#preference Explain derivations step by step.";
  await f.invoke("Logic", "Tell me more details when deriving equations", [tool("memory_write", { content: details }), echo]);
  const visible = await f.invoke("Logic", "Show memory");
  assert.ok(visible.includes(course) && visible.includes(details) && visible.includes(chinese) && visible.includes(english));
  assert.ok(!(await f.invoke("Calculus", "Show memory")).includes(course));
  await f.deny("Diagrams before formulas work better for me", "memory_write", { scope: "global", content: course }, /explicit cross-course/);
  assert.equal(await f.invoke("Logic", "Show memory"), visible);
});

test("read requests cannot write, forget or restore preferences or chapter progress", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const fact = "#preference Use truth tables.";
  await f.invoke("Logic", "Truth tables help me understand", [tool("memory_write", { content: fact }), echo]);
  const file = path.join(f.data, "logic", "course.json");
  const chapterId = "77777777-7777-4777-8777-777777777777";
  const course = JSON.parse(await readFile(file, "utf8"));
  course.chapters = [{ id: chapterId, version: 1, title: "Truth tables", status: "pending", order: 1,
    source: { materialId: "fixture", materialVersion: "fixture" }, needsConfirmation: false, progressUpdatedAt: null, lecture: { status: "none", courseVersion: 1 } }];
  course.route = { version: 1, markdown: "## Teaching order\n1. Truth tables", confirmedAt: null, chapterIds: [chapterId] };
  await writeFile(file, JSON.stringify(course));
  assert.equal((await f.cli("Logic", ["--chapter-id", chapterId, "--progress", "learned"])).code, 0);
  const before = await f.invoke("Logic", "Show memory");
  const chapterBefore = await readFile(file, "utf8");
  for (const [feedback, name, args] of [
    ["Show memory", "memory_forget", { match: chapterId }],
    ["Show memory", "memory_write", { content: "#preference Invented preference." }],
    ["Please list my preferences", "memory_forget", { match: "Use truth tables" }],
    ["Can you show my memory?", "memory_write", { content: "#preference Invented preference." }],
    ["What is my global preference?", "memory_write", { scope: "global", content: "#preference Invented global." }],
    ["请显示我已学完的章节", "memory_forget", { match: chapterId }],
    ["查看我的偏好", "memory_write", { content: "#preference Invented preference." }],
    ["Show whether I have not yet learned Truth tables", "memory_write", { content: "#progress Truth tables", chapterId, status: "pending", evidence: "I have not yet learned Truth tables" }],
  ]) {
    await f.deny(feedback, name, args, /read-only/);
    assert.equal(await f.invoke("Logic", "Show memory"), before, `${name} leaves facts and recoveries unchanged`);
    assert.equal(await readFile(file, "utf8"), chapterBefore, `${name} preserves actual learned progress and version`);
  }
  const preferenceRecovery = recoveryId(await f.invoke("Logic", "Delete my truth table preference", [tool("memory_forget", { match: "Use truth tables" }), echo]));
  const progressRecovery = recoveryId(await f.invoke("Logic", "Delete the chapter progress", [tool("memory_forget", { match: chapterId }), echo]));
  const deleted = await f.invoke("Logic", "Show memory");
  const pending = await readFile(file, "utf8");
  assert.ok(!deleted.includes(fact));
  assert.equal(JSON.parse(pending).chapters[0].status, "pending");
  for (const id of [preferenceRecovery, progressRecovery]) {
    const beforeRestore = await f.invoke("Logic", "Show memory");
    const progressBefore = await readFile(file, "utf8");
    await f.deny(`Show memory recovery ${id}`, "memory_restore", { recoveryId: id }, /read-only/);
    assert.equal(await f.invoke("Logic", "Show memory"), beforeRestore);
    assert.equal(await readFile(file, "utf8"), progressBefore);
    await f.invoke("Logic", `Restore ${id}`, [tool("memory_restore", { recoveryId: id }), echo]);
  }
  assert.ok((await f.invoke("Logic", "Show memory")).includes(fact));
  assert.equal(JSON.parse(await readFile(file, "utf8")).chapters[0].status, "learned");
});

test("scope exclusions cannot authorize global effects while course preferences remain implicit", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const global = "#preference Prefer detailed derivations.";
  const course = "#preference Use diagrams.";
  await f.invoke("Logic", "Across courses prefer detailed derivations", [tool("memory_write", { scope: "global", content: global }), echo]);
  const before = await f.invoke("Observer", "Show global memory");
  for (const feedback of [
    "Global variables confuse me; use diagrams",
    "For this course only, not globally: use diagrams",
    "Only this course should use diagrams; don't change my global preference",
    "只修改本课程，不要修改全局偏好，用图解释。",
  ]) {
    await f.deny(feedback, "memory_write", { scope: "global", content: course }, /explicit cross-course/);
    assert.equal(await f.invoke("Observer", "Show global memory"), before);
  }
  for (const feedback of [
    "Delete only this course preference, not my global derivation preference",
    "不要删除全局偏好，只删除本课程偏好。",
  ]) {
    await f.deny(feedback, "memory_forget", { scope: "global", match: "detailed derivations" }, /explicit cross-course/);
    assert.equal(await f.invoke("Observer", "Show global memory"), before);
  }
  const id = recoveryId(await f.invoke("Logic", "Delete my global derivation preference", [tool("memory_forget", { scope: "global", match: "detailed derivations" }), echo]));
  const deleted = await f.invoke("Observer", "Show global memory");
  for (const feedback of [
    `Restore only this course preference, not the global preference ${id}`,
    `不要恢复全局偏好，只恢复本课程偏好 ${id}`,
  ]) {
    await f.deny(feedback, "memory_restore", { scope: "global", recoveryId: id }, /explicit cross-course/);
    assert.equal(await f.invoke("Observer", "Show global memory"), deleted);
  }
  await f.invoke("Logic", `Restore global preference ${id}`, [tool("memory_restore", { scope: "global", recoveryId: id }), echo]);
  assert.equal(await f.invoke("Observer", "Show global memory"), before);
  await f.invoke("Logic", "Only for this course, not globally, diagrams work better", [tool("memory_write", { content: course }), echo]);
  assert.ok((await f.invoke("Logic", "Show memory")).includes(course));
  const replacement = "#preference Use a worked example instead of diagrams.";
  await f.invoke("Logic", "Actually diagrams are confusing; worked examples help me more", [
    tool("memory_forget", { match: "Use diagrams" }), tool("memory_write", { content: replacement }), echo,
  ]);
  const corrected = await f.invoke("Logic", "Show memory");
  assert.ok(corrected.includes(replacement) && !corrected.includes(course));
  assert.equal(await f.invoke("Observer", "Show global memory"), before);
});

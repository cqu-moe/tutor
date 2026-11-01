import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cliCommand } from "./cli-command.js";

const run = promisify(execFile);

async function body(request) {
  let value = "";
  for await (const chunk of request) value += chunk;
  return JSON.parse(value);
}

function sse(response, delta, finish = "stop") {
  const base = { id: "durable", object: "chat.completion.chunk", created: 1, model: "durable-model" };
  const chunk = (delta, finishReason) => JSON.stringify({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, finish)}\n\ndata: [DONE]\n\n`);
}

function toolCalls(response, calls, finish = "tool_calls") {
  const base = { id: "durable", object: "chat.completion.chunk", created: 1, model: "durable-model" };
  const chunk = (delta, finishReason) => JSON.stringify({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${chunk({ tool_calls: calls.map((call, index) => ({ ...call, index })) }, null)}\n\ndata: ${chunk({}, finish)}\n\ndata: [DONE]\n\n`);
}

function startCli(args, env, input = "") {
  const child = spawn(cliCommand[0], [...cliCommand.slice(1), ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input);
  return {
    child,
    output: () => ({ stdout, stderr }),
  };
}

test("route CLI resumes the original durable submission and completed read after SIGKILL", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-durable-"));
  const agentDir = path.join(root, "pi");
  const courseDir = path.join(root, "data", "digital-design");
  const pdf = path.join(root, "lecture.pdf");
  const screenshotBase = path.join(root, "question");
  const screenshot = `${screenshotBase}.png`;
  const secret = path.join(root, "credentials.txt");
  await mkdir(agentDir);
  await writeFile(secret, "durable-secret-value");
  await writeFile(path.join(root, "lecture.typ"), "#set page(width: 5cm, height: 5cm)\n= Boolean algebra\nF = xy + x'z\n");
  await run("typst", ["compile", path.join(root, "lecture.typ"), pdf]);
  await run("pdftoppm", ["-png", "-r", "36", "-singlefile", pdf, screenshotBase]);
  await mkdir(courseDir, { recursive: true });
  await writeFile(path.join(courseDir, ".course-name"), "Digital Design\n");
  await symlink(secret, path.join(courseDir, "credential-link.txt"));

  let ocrCalls = 0;
  const ocrInputs = [];
  const ocr = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/ocr");
    ocrCalls++;
    const payload = await body(request);
    ocrInputs.push(payload.document.type);
    response.end(JSON.stringify({ pages: [{ index: 0, markdown: "# Boolean functions\nF = xy + x'z" }] }));
  });
  await new Promise((resolve, reject) => {
    ocr.on("error", reject);
    ocr.listen(0, "127.0.0.1", resolve);
  });

  const modelRequests = [];
  let persistedReadResults = 0;
  const preference = "#preference [[course:digital-design]] Use truth tables.";
  const model = createServer(async (request, response) => {
    const payload = await body(request);
    modelRequests.push(payload);
    if (JSON.stringify(payload.messages).includes('"tool_call_id":"read-course"')) persistedReadResults++;
    if (modelRequests.length === 1) {
      toolCalls(response, [{
          id: "read-course",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: ".course-name" }) },
        }, {
          id: "read-credentials",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: secret }) },
        }, {
          id: "read-symlink",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "credential-link.txt" }) },
      }]);
      return;
    }
    // The first process stays in this request. Reaching it proves the read result
    // committed; SIGKILL then leaves the official durable task unfinished.
    if (modelRequests.length === 2) return;
    if (modelRequests.length === 4) {
      toolCalls(response, [{ id: "remember-adjustment", type: "function", function: {
        name: "memory_write", arguments: JSON.stringify({ target: "long_term", content: preference }),
      } }]);
      return;
    }
    if (modelRequests.length === 5) return;
    if (modelRequests.length === 7) {
      toolCalls(response, [{ id: "read-memory", type: "function", function: { name: "memory_read", arguments: JSON.stringify({ target: "long_term" }) } }]); return;
    }
    if (modelRequests.length === 8) { sse(response, { content: String(payload.messages.at(-1).content) }); return; }
    const transcript = JSON.stringify(payload.messages);
    sse(response, { content: transcript.includes("durable-secret-value")
      ? `Leaked credential: durable-secret-value`
      : `## Teaching order\n1. Boolean algebra${modelRequests.length >= 6 ? "\n\nMaterial doubts: none; use truth tables." : ""}` });
  });
  await new Promise((resolve, reject) => {
    model.on("error", reject);
    model.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => ocr.close(resolve)),
      new Promise((resolve) => model.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { tutorTest: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
    api: "openai-completions",
    apiKey: "durable-fixture-secret",
    compat: { supportsUsageInStreaming: false },
    models: [{ id: "durable-model", input: ["text", "image"] }],
  } } }));
  const args = [
    "--course", "Digital Design",
    "--data-dir", path.join(root, "data"),
    "--agent-dir", agentDir,
    "--model", "tutorTest/durable-model",
    "--pdf", pdf,
    "--chapter", "Boolean algebra",
    "--screenshots", screenshot,
    "--ocr", "mistral",
    "--mistral-base-url", `http://127.0.0.1:${ocr.address().port}`,
  ];
  const env = { ...process.env, MISTRAL_API_KEY: "durable-ocr-fixture-secret", PI_MEMORY_DIR: path.join(root, "memory"), NO_COLOR: "1" };

  const first = startCli(args, env);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const { stdout, stderr } = first.output();
      reject(new Error(`route did not reach its interrupted model request (ocr=${ocrCalls}, model=${modelRequests.length})\n${stdout}\n${stderr}`));
    }, 30_000);
    const check = () => modelRequests.length >= 2 ? (clearTimeout(timer), resolve()) : setImmediate(check);
    check();
  });
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));

  const resumeArgs = [
    "--course", "Digital Design",
    "--data-dir", path.join(root, "data"),
    "--agent-dir", agentDir,
    "--model", "tutorTest/durable-model",
    "--resume",
  ];
  const second = startCli(resumeArgs, env);
  const exit = await new Promise((resolve) => second.child.once("exit", resolve));
  const { stdout, stderr } = second.output();
  assert.equal(exit, 0, stderr);
  assert.match(stdout, /## Teaching order\n1\. Boolean algebra/);
  assert.deepEqual(
    ocrInputs,
    ["document_url", "image_url"],
    "OCR runs once per source before the crash and is cached on reopen",
  );
  assert.equal(modelRequests.length, 3, "the original model run resumes without replaying its first response");
  assert.equal(persistedReadResults, 2, "the completed read result remains in both post-tool requests");
  assert.ok(!stdout.includes("durable-secret-value"), stdout);
  assert.ok(modelRequests[0].messages.at(-1).content.some((part) => part.type === "image_url"), "route input retains image support");
  const draft = JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8"));
  assert.equal(draft.route, "## Teaching order\n1. Boolean algebra");
  assert.ok(!draft.context.confirmedAt, "recovery must keep the route waiting for confirmation");
  const waiting = startCli(resumeArgs, env);
  assert.equal(await new Promise((resolve) => waiting.child.once("exit", resolve)), 0, waiting.output().stderr);
  assert.match(waiting.output().stdout, /Route was not confirmed/);
  assert.equal(modelRequests.length, 3, "opening a waiting route must not invoke the model again");

  const adjustment = startCli(resumeArgs, env, "Use truth tables and remember this course preference.\n");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`adjustment never committed its memory tool\n${JSON.stringify(adjustment.output())}`)), 30_000);
    const check = () => modelRequests.length >= 5 ? (clearTimeout(timer), resolve()) : setImmediate(check);
    check();
  });
  adjustment.child.kill("SIGKILL");
  await new Promise((resolve) => adjustment.child.once("exit", resolve));
  const resumedAdjustment = startCli(resumeArgs, env);
  assert.equal(await new Promise((resolve) => resumedAdjustment.child.once("exit", resolve)), 0, resumedAdjustment.output().stderr);
  assert.match(resumedAdjustment.output().stdout, /Material doubts: none; use truth tables/);
  assert.equal(modelRequests.length, 6, "resume must wait on the original adjustment, not return the earlier route");
  const memoryRead = startCli([...resumeArgs.filter((arg) => arg !== "--resume"), "--memory", "Show current learner memory"], env);
  assert.equal(await new Promise((resolve) => memoryRead.child.once("exit", resolve)), 0, memoryRead.output().stderr);
  assert.equal(memoryRead.output().stdout.split(preference).length - 1, 1, "completed memory effect must occur once");
  assert.ok(await readFile(path.join(courseDir, ".durable/session.sqlite")), "official SQLite storage remains in the course");
});

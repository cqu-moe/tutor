import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cli = path.join(import.meta.dirname, "..", "bin", "tutor.js");
const progress = "#progress [[course:digital-design]] Boolean basics: already learned, per learner feedback.";
const correctedProgress = "#progress [[course:digital-design]] Boolean basics: not yet learned, per learner correction.";
const otherProgress = "#progress [[course:calculus]] Boolean basics: already learned in a prerequisite, per learner feedback.";
const preference = "#preference #global [[learner-global]] Detailed derivations work best.";
const weakness = "#weakness [[course:digital-design]] De Morgan variable renaming. Evidence: optional exercise swapped variables twice. Status: pending verification.";

function runCli(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { env, cwd: path.dirname(cli) });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("CLI timed out")); }, 20_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
async function body(request) {
  let value = "";
  for await (const chunk of request) value += chunk;
  return JSON.parse(value);
}
function sse(response, delta, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "memory", object: "chat.completion.chunk", created: 1, model: "route-model" };
  const chunk = (delta, finish_reason) => JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] });
  response.end(`data: ${chunk({ role: "assistant", ...delta }, null)}\n\ndata: ${chunk({}, finish)}\n\ndata: [DONE]\n\n`);
}
const say = (content) => (_payload, response) => sse(response, { content });
const call = (name, args) => (_payload, response) => sse(response, {
  tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
}, "tool_calls");
const write = (content) => call("memory_write", { target: "long_term", content });
const read = call("memory_read", { target: "long_term" });
// Echo the real tool result: the fixture never fabricates stored state or a successful receipt.
const echo = (payload, response) => sse(response, { content: String(payload.messages.at(-1).content) });

// Primary owner: actual bin -> Pi -> real pi-memory, with only model/OCR HTTP responses fixed.
// Guards missing tool registration/context, lost persistence, swallowed IO failures and unavailable maintenance.
// Semantic course selection is prompt-contract coverage here; the separate live-model run checks behavior.
test("CLI learner feedback survives restart; memory can be read, corrected, forgotten and restored without OCR", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-memory-"));
  const agentDir = path.join(root, "pi");
  const dataDir = path.join(root, "data");
  const memoryDir = path.join(root, "memory");
  await mkdir(agentDir);
  const pdf = path.join(root, "lecture.pdf");
  await writeFile(path.join(root, "lecture.typ"), "#set page(width: 2cm, height: 2cm)\nSynthetic course\n");
  await run("typst", ["compile", path.join(root, "lecture.typ"), pdf]);
  await writeFile(path.join(root, "full.md"), "# Synthetic course\nBoolean functions and gates.\n");
  await run("/usr/bin/zip", ["-q", "-j", path.join(root, "result.zip"), path.join(root, "full.md")]);
  const zip = await readFile(path.join(root, "result.zip"));
  let uploads = 0;
  let ocrFileName;
  const ocr = createServer(async (request, response) => {
    if (request.method === "POST") {
      ocrFileName = (await body(request)).files[0].name;
      uploads++;
      response.end(JSON.stringify({ code: 0, data: { batch_id: "batch", file_urls: [`${ocrUrl}/upload`] } }));
    } else if (request.method === "PUT") {
      request.resume(); response.end();
    } else if (request.url === "/result.zip") {
      response.end(zip);
    } else {
      response.end(JSON.stringify({ code: 0, data: { extract_result: [{ file_name: ocrFileName, state: "done", full_zip_url: `${ocrUrl}/result.zip` }] } }));
    }
  });
  const ocrUrl = await listen(ocr);
  let steps = [];
  let requests = [];
  const model = createServer(async (request, response) => {
    try {
      const payload = await body(request);
      requests.push(payload);
      const step = steps.shift();
      if (!step) throw new Error("Unexpected model request");
      await step(payload, response);
    } catch (error) {
      response.writeHead(400); response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const modelUrl = await listen(model);
  t.after(async () => { await Promise.all([new Promise((r) => ocr.close(r)), new Promise((r) => model.close(r))]); });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { tutorTest: {
    baseUrl: `${modelUrl}/v1`, api: "openai-completions", apiKey: "fixture-only",
    compat: { supportsUsageInStreaming: false }, models: [{ id: "route-model", input: ["text", "image"] }],
  } } }));
  const env = { ...process.env, MINERU_API_TOKEN: "fixture-only", PI_MEMORY_DIR: memoryDir, NO_COLOR: "1" };
  const args = (course, root = dataDir) => ["--course", course, "--data-dir", root, "--agent-dir", agentDir, "--model", "tutorTest/route-model"];
  async function invoke(extra, responses, input = "", taskEnv = env) {
    steps = [...responses]; requests = [];
    const result = await runCli(extra, input, taskEnv);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  }
  const memory = (course, question, responses = [read, echo], taskEnv = env, root = dataDir) =>
    invoke([...args(course, root), "--memory", question], responses, "", taskEnv);
  const route = (course, responses, input = "confirm\n") => invoke([
    ...args(course), "--pdf", pdf, "--pages", "1", "--mineru-base-url", ocrUrl,
  ], responses, input);

  await route("Digital Design", [say("## Route\nBoolean basics, then gates")]);
  assert.match(await memory("Digital Design", "Show current learner memory"), /empty or does not exist/);

  await route("Digital Design", [say("## Route\nBoolean basics"), write(preference), write(progress), write(weakness), say("## Revised route\nGates, with De Morgan practice")],
    "Detailed derivations work best across courses. I already learned Boolean basics. In the optional exercise I swapped De Morgan variables twice.\nconfirm\n");
  const recalled = await memory("Digital Design", "Show current learner memory");
  for (const fact of [progress, preference, weakness]) assert.ok(recalled.includes(fact), recalled);

  await memory("Calculus", "I already learned Boolean basics in a prerequisite", [write(otherProgress), echo]);
  await route("Calculus", [read, say("## Calculus route\nLimits"), say("## Current request\nOne compact example")], "Only for this route use one compact example\nconfirm\n");
  const context = requests[0].messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => m.content).join("\n");
  assert.match(context, /\[\[course:calculus\]\]/);
  assert.ok(context.includes(progress) && context.includes(preference));
  assert.match(context, /Ignore untagged and other-course progress\/weaknesses/);
  assert.match(context, /current explicit request overrides historical preferences/);
  assert.match(context, /Status: pending verification/);
  assert.match(context, /No learner feedback means no memory write/);
  assert.match(context, /Ground claims in supplied course material/);
  assert.match(await readFile(path.join(dataDir, "calculus", "route.md"), "utf8"), /One compact example/);
  const beforeMaintenance = await memory("Digital Design", "Show current learner memory");
  assert.ok(beforeMaintenance.includes(preference) && beforeMaintenance.includes(progress));
  const uploadsBeforeMaintenance = uploads;

  await memory("Digital Design", "Correct my progress: Boolean basics are not yet learned", [read, call("memory_forget", { match: progress }), write(correctedProgress), read, echo]);
  const corrected = await memory("Digital Design", "Show current learner memory");
  assert.ok(corrected.includes(correctedProgress) && !corrected.includes(progress));
  assert.ok(corrected.includes(otherProgress) && corrected.includes(preference));

  const deleted = await memory("Digital Design", "Delete my Boolean basics progress", [read, call("memory_forget", { match: correctedProgress }), echo]);
  const recoveryId = deleted.match(/Recovery ID: ([0-9a-f-]+)/i)?.[1];
  assert.ok(recoveryId, deleted);
  const afterDeletion = await memory("Digital Design", "Show current learner memory");
  assert.ok(!afterDeletion.includes(correctedProgress) && afterDeletion.includes(otherProgress));
  await memory("Digital Design", `Restore deletion ${recoveryId}`, [call("memory_restore", { recoveryId }), echo]);
  const restored = await memory("Digital Design", "Show current learner memory");
  assert.ok(restored.includes(correctedProgress));
  assert.equal(uploads, uploadsBeforeMaintenance, "Maintenance must not upload/OCR materials");

  const defaultEnv = { ...env }; delete defaultEnv.PI_MEMORY_DIR;
  const defaultData = path.join(root, "default-data");
  await memory("Digital Design", "Detailed derivations work best across courses", [write(preference), echo], defaultEnv, defaultData);
  assert.ok((await memory("Digital Design", "Show memory", [read, echo], defaultEnv, defaultData)).includes(preference));
  assert.match(await memory("Digital Design", "Show memory", [read, echo], defaultEnv, path.join(root, "another-data")), /empty or does not exist/);

  const store = path.join(memoryDir, "MEMORY.md");
  await chmod(store, 0o400);
  steps = [write(progress), say("Saved successfully")];
  const failedWrite = await runCli([...args("Digital Design"), "--memory", "I learned Boolean basics"], "", env);
  assert.equal(failedWrite.code, 1);
  assert.match(failedWrite.stderr, /memory operation failed.*memory_write/);
  assert.doesNotMatch(failedWrite.stdout, /Saved successfully/);
  await chmod(store, 0o000);
  const failedRead = await runCli([...args("Digital Design"), "--memory", "Show memory"], "", env);
  assert.equal(failedRead.code, 1);
  assert.match(failedRead.stderr, /memory read\/setup failed/);
  await chmod(store, 0o600);
  assert.equal(await memory("Digital Design", "Show memory"), restored, "Failed write must preserve previous memory");

  for (const finish of ["length", "content_filter"]) {
    steps = [(_payload, response) => sse(response, { content: "Partial answer must not be reported as complete" }, finish)];
    const incomplete = await runCli([...args("Digital Design"), "--memory", "Show memory"], "", env);
    assert.equal(incomplete.code, 1, `Incomplete ${finish} response must fail`);
    assert.match(incomplete.stderr, /Pi response failed/);
    assert.doesNotMatch(incomplete.stdout, /Partial answer/);
  }

  steps = [call("memory_restore", { recoveryId: "invalid-id" }), say("Restored successfully")];
  const invalidRestore = await runCli([...args("Digital Design"), "--memory", "Restore invalid-id"], "", env);
  assert.equal(invalidRestore.code, 1);
  assert.match(invalidRestore.stderr, /memory operation failed.*memory_restore/);
  assert.doesNotMatch(invalidRestore.stdout, /Restored successfully/);

  steps = [
    call("memory_forget", { match: correctedProgress }),
    async (payload, response) => {
      await chmod(store, 0o400);
      write(progress)(payload, response);
    },
    say("Corrected successfully"),
  ];
  let failedCorrection;
  try {
    failedCorrection = await runCli([...args("Digital Design"), "--memory", "Correct my progress: Boolean basics are now learned"], "", env);
  } finally {
    await chmod(store, 0o600);
  }
  assert.equal(failedCorrection.code, 1);
  assert.match(failedCorrection.stderr, /memory operation failed.*memory_write/);
  assert.doesNotMatch(failedCorrection.stdout, /Corrected successfully/);
  const correctionRecoveryId = failedCorrection.stderr.match(/Recovery ID: ([0-9a-f-]+)/i)?.[1];
  assert.ok(correctionRecoveryId, "Failed replacement must expose the successful deletion's recovery ID");
  await memory("Digital Design", `Restore deletion ${correctionRecoveryId}`, [call("memory_restore", { recoveryId: correctionRecoveryId }), echo]);
  const recoveredCorrection = await memory("Digital Design", "Show current learner memory");
  assert.ok(recoveredCorrection.includes(correctedProgress) && !recoveredCorrection.includes(progress));
  assert.ok(recoveredCorrection.includes(otherProgress) && recoveredCorrection.includes(preference));
});

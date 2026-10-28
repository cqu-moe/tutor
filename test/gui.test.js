import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cliCommand } from "./cli-command.js";

const run = promisify(execFile);

async function start(t, dataDir, extra = [], env = process.env) {
  const child = spawn(cliCommand[0], [...cliCommand.slice(1), "gui", "--no-open", "--port", "0", "--data-dir", dataDir, ...extra], { env });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
  });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`GUI did not start: ${output}`)), 10_000);
    child.on("error", reject);
    child.stderr.on("data", (chunk) => output += chunk);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`GUI exited ${code}: ${output}`)); });
  });
  const html = await (await fetch(url)).text();
  const token = html.match(/name="tutor-session" content="([^"]+)"/)?.[1];
  assert.ok(token, "GUI HTML bootstraps a per-run session");
  const request = (pathname, init = {}) => fetch(url + pathname, {
    ...init, headers: { "x-tutor-session": token, ...init.headers },
  });
  return { url, request, child };
}

async function body(request) {
  let value = "";
  for await (const chunk of request) value += chunk;
  return JSON.parse(value);
}

function sse(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "gui-1", object: "chat.completion.chunk", created: 1, model: "gui-model" };
  const delta = { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
  const end = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  response.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
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

async function waitForJob(request, predicate) {
  for (let index = 0; index < 600; index++) {
    const state = await (await request("/api/state")).json();
    const job = state.job;
    if (job && predicate(job)) return job;
    if (job?.status === "failed") throw new Error(`GUI job failed unexpectedly: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("GUI job did not reach the expected state");
}

async function modelFixture(t, apiKey, respond) {
  const requests = [];
  const url = await serve(t, async (request, response) => {
    const payload = await body(request);
    requests.push(payload);
    const result = respond(payload, requests.length);
    if (result.status) {
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: result.message } }));
      return;
    }
    sse(response, result.content);
  });
  return { requests, url };
}

async function writeAgentConfig(directory, modelUrl, apiKey) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "models.json"), JSON.stringify({
    providers: {
      tutorTest: {
        baseUrl: `${modelUrl}/v1`,
        api: "openai-completions",
        apiKey,
        compat: { supportsUsageInStreaming: false },
        models: [{ id: "gui-model", input: ["text", "image"] }],
      },
    },
  }));
}

async function importForm(pdf) {
  const form = new FormData();
  form.set("course", "Digital Design");
  form.set("selectionMode", "pages");
  form.set("selection", "1");
  form.set("pdf", new File([await readFile(pdf)], "lecture.pdf", { type: "application/pdf" }));
  return form;
}

test("GUI serves saved courses and confines local access and downloads", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-gui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const course = path.join(data, "logic");
  await mkdir(path.join(course, "output"), { recursive: true });
  await writeFile(path.join(course, ".course-name"), "Logic\n");
  await writeFile(path.join(course, "draft.json"), JSON.stringify({
    context: { course: "Logic", confirmedAt: null, pages: [], screenshots: [] }, route: "## Teaching order\n1. Logic gates",
  }));
  await writeFile(path.join(course, "output/content.md"), "# Saved lecture\nDo not replace me.");
  await writeFile(path.join(root, "private.txt"), "private-data");
  await symlink(path.join(root, "private.txt"), path.join(course, "output/leak.md"));
  await symlink(root, path.join(data, "outside"));
  const { url, request } = await start(t, data);
  assert.equal((await fetch(url + "/api/state")).status, 403);
  assert.equal((await request("/api/state", { headers: { origin: "https://attacker.example" } })).status, 403);
  const state = await (await request("/api/state")).json();
  assert.deepEqual(state.courses.map((entry) => entry.name), ["Logic"]);
  assert.equal(state.courses[0].confirmed, false);
  const detail = await (await request("/api/courses/logic")).json();
  assert.match(detail.route, /Logic gates/);
  assert.match(detail.content, /Do not replace me/);
  assert.equal(detail.files.some((file) => file === "leak.md"), false);
  assert.equal(await (await request("/api/courses/logic/files/content.md")).text(), "# Saved lecture\nDo not replace me.");
  for (const file of ["leak.md", "%2e%2e%2f%2e%2e%2fprivate.txt", "%2fetc%2fpasswd"]) {
    assert.ok((await request(`/api/courses/logic/files/${file}`)).status >= 400);
  }
  assert.equal((await request("/api/courses/outside")).status, 404);
  const bad = await request("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "arbitrary-command", course: "Logic" }) });
  assert.equal(bad.status, 400);
});

test("GUI import persists an adjusted route across restart without repeating OCR", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-gui-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const agentDir = path.join(root, "pi");
  const pdf = path.join(root, "lecture.pdf");
  await writeFile(path.join(root, "lecture.typ"), "#set page(width: 2cm, height: 2cm)\nBoolean algebra\n");
  await run("typst", ["compile", path.join(root, "lecture.typ"), pdf]);
  const courseDir = path.join(data, "digital-design");
  const previousContent = "# Previous lecture\nDo not replace me.\n";
  const previousManifest = JSON.stringify({
    context: { course: "Digital Design", confirmedAt: "2026-01-01T00:00:00.000Z", pages: [], screenshots: [] },
    route: "## Previous route",
  });
  await mkdir(path.join(courseDir, "output"), { recursive: true });
  await writeFile(path.join(courseDir, ".course-name"), "Digital Design\n");
  await writeFile(path.join(courseDir, "output", "content.md"), previousContent);
  await writeFile(path.join(courseDir, "output", "lecture.json"), previousManifest);

  let ocrCalls = 0;
  const ocrUrl = await serve(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/ocr");
    assert.equal(request.headers.authorization, "Bearer gui-ocr-fixture-secret");
    const payload = await body(request);
    assert.equal(payload.model, "mistral-ocr-latest");
    assert.match(payload.document.document_url, /^data:application\/pdf;base64,/);
    ocrCalls++;
    response.end(JSON.stringify({ pages: [{ index: 0, markdown: "# Boolean functions\nF = xy + x'z" }] }));
  });

  let modelMode = "propose";
  const modelSecret = "gui-model-fixture-secret";
  const model = await modelFixture(t, modelSecret, (payload) => {
    if (modelMode === "fail") {
      return { status: 401, message: `Invalid key ${modelSecret}; gui-upstream-fixture-detail` };
    }
    const adjustment = JSON.stringify(payload.messages).includes("Put logic gates first");
    return { content: adjustment ? "## Adjusted route\n1. Logic gates" : "## Proposed route\n1. Boolean functions" };
  });
  await writeAgentConfig(agentDir, model.url, modelSecret);

  const extra = ["--ocr", "mistral", "--mistral-base-url", ocrUrl, "--agent-dir", agentDir, "--model", "tutorTest/gui-model"];
  const env = { ...process.env, MISTRAL_API_KEY: "gui-ocr-fixture-secret", NO_COLOR: "1" };
  const first = await start(t, data, extra, env);
  const imported = await first.request("/api/jobs", { method: "POST", body: await importForm(pdf) });
  assert.equal(imported.status, 202);
  const concurrent = await first.request("/api/jobs", { method: "POST", body: await importForm(pdf) });
  assert.equal(concurrent.status, 409);

  await waitForJob(first.request, (job) => job.status === "awaiting-route");
  assert.equal(ocrCalls, 1);
  assert.equal(model.requests.length, 1);
  const adjusted = await first.request("/api/jobs/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: (await (await first.request("/api/state")).json()).job.id, feedback: "Put logic gates first" }),
  });
  assert.equal(adjusted.status, 200);
  await waitForJob(first.request, (job) => job.status === "awaiting-route" && job.log.includes("Adjusted route"));
  assert.equal(model.requests.length, 2);

  const staleConfirm = await first.request("/api/jobs/input", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: (await (await first.request("/api/state")).json()).job.id, confirm: true, route: "## Proposed route\n1. Boolean functions" }),
  });
  assert.equal(staleConfirm.status, 409, "a stale tab cannot confirm a route it has not displayed");

  const persisted = JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8"));
  assert.match(persisted.route, /Adjusted route/);
  assert.equal(persisted.context.confirmedAt, null);
  first.child.kill("SIGTERM");
  await new Promise((resolve) => first.child.once("exit", resolve));

  assert.equal((await readdir(data)).filter((name) => name.startsWith(".upload-")).length, 0, "stopping the GUI removes its temporary upload copies");

  const second = await start(t, data, extra, env);
  const resumed = await second.request("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "resume", courseId: "digital-design" }),
  });
  assert.equal(resumed.status, 202);
  await waitForJob(second.request, (job) => job.status === "awaiting-route");
  assert.equal(ocrCalls, 1);
  assert.equal(model.requests.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8")).route, persisted.route);

  const pending = (await (await second.request("/api/state")).json()).job;
  const deferred = await second.request("/api/jobs/input", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: pending.id, defer: true }),
  });
  assert.equal(deferred.status, 200);
  await waitForJob(second.request, (job) => job.status === "succeeded" && job.stage === "saved");
  assert.equal(JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8")).context.confirmedAt, null);
  assert.equal((await second.request("/api/jobs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "resume", courseId: "digital-design" }),
  })).status, 202);
  await waitForJob(second.request, (job) => job.status === "awaiting-route");
  assert.equal(model.requests.length, 2);

  modelMode = "fail";
  const failedInput = await second.request("/api/jobs/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: (await (await second.request("/api/state")).json()).job.id, feedback: "Explain gates first" }),
  });
  assert.equal(failedInput.status, 200);
  const failed = await waitForJob(second.request, (job) => job.status === "failed");
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(modelSecret));
  assert.doesNotMatch(JSON.stringify(failed), /gui-upstream-fixture-detail/);
  assert.equal(JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8")).route, persisted.route);
  assert.equal(await readFile(path.join(courseDir, "output", "content.md"), "utf8"), previousContent);
  assert.equal(await readFile(path.join(courseDir, "output", "lecture.json"), "utf8"), previousManifest);
});

test("GUI confirmation persists before a controlled generation export failure", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-gui-confirm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const courseDir = path.join(data, "logic");
  const parsed = path.join(courseDir, "parsed", "page-1");
  const originalPage = path.join(courseDir, "original-pages", "page-1.png");
  await mkdir(parsed, { recursive: true });
  await mkdir(path.dirname(originalPage), { recursive: true });
  await writeFile(path.join(parsed, "full.md"), "Boolean function F = xy with an AND truth table.\n");
  await writeFile(originalPage, "png");
  await mkdir(path.join(courseDir, "source"), { recursive: true });
  await writeFile(path.join(courseDir, "source", "lecture.pdf"), "pdf");
  await writeFile(path.join(courseDir, ".course-name"), "Logic\n");
  const context = {
    course: "Logic",
    pages: [{
      sourcePage: 1,
      pagePdf: path.join(courseDir, "source", "lecture.pdf"),
      originalPageImage: originalPage,
      parsedDirectory: parsed,
      markdown: "Boolean function F = xy with an AND truth table.",
    }],
    screenshots: [],
    confirmedAt: null,
  };
  await writeFile(path.join(courseDir, "draft.json"), JSON.stringify({ context, route: "## Teaching order\n1. Logic gates" }));

  const previousContent = "# Previous lecture\nDo not replace me.\n";
  const previousManifest = JSON.stringify({ context: { ...context, confirmedAt: "2026-01-01T00:00:00.000Z" }, route: "## Previous route" });
  await mkdir(path.join(courseDir, "output"), { recursive: true });
  await writeFile(path.join(courseDir, "output", "content.md"), previousContent);
  await writeFile(path.join(courseDir, "output", "lecture.json"), previousManifest);
  await writeFile(path.join(root, "study-notes.md"), "Write a complete lecture.\n");

  const modelSecret = "gui-generation-fixture-secret";
  const model = await modelFixture(t, modelSecret, () => ({ content: "# Candidate lecture\nF = xy" }));
  const agentDir = path.join(root, "pi");
  await writeAgentConfig(agentDir, model.url, modelSecret);
  const gui = await start(t, data, ["--agent-dir", agentDir, "--model", "tutorTest/gui-model"], {
    ...process.env,
    NO_COLOR: "1",
    TUTOR_STUDY_NOTES: path.join(root, "study-notes.md"),
    TUTOR_RECTO_ROOT: path.join(root, "missing-recto"),
  });

  const resumed = await gui.request("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "resume", courseId: "logic" }),
  });
  assert.equal(resumed.status, 202);
  const awaiting = await waitForJob(gui.request, (job) => job.status === "awaiting-route");
  const confirmed = await gui.request("/api/jobs/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: awaiting.id, confirm: true, route: "## Teaching order\n1. Logic gates" }),
  });
  assert.equal(confirmed.status, 200);

  const failed = await waitForJob(gui.request, (job) => job.status === "failed");
  assert.match(failed.log, /Recto export failed/);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(modelSecret));

  const draft = JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8"));
  assert.ok(draft.context.confirmedAt);
  assert.match(draft.route, /Logic gates/);
  assert.equal(model.requests.length, 1);
  assert.match(JSON.stringify(model.requests[0].messages), /Write the complete lecture/);
  assert.equal(await readFile(path.join(courseDir, "output", "content.md"), "utf8"), previousContent);
  assert.equal(await readFile(path.join(courseDir, "output", "lecture.json"), "utf8"), previousManifest);
  const stages = (await readdir(courseDir)).filter((name) => name.startsWith(".lecture-"));
  assert.ok(stages.length, "failed generation must retain its staged source");
});

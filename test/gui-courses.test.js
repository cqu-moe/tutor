import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cliCommand } from "./cli-command.js";

const run = promisify(execFile);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function body(request) {
  let value = "";
  for await (const chunk of request) value += chunk;
  return JSON.parse(value);
}

function sse(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "gui-course-1", object: "chat.completion.chunk", created: 1, model: "gui-course-model" };
  const delta = { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
  const end = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  response.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
}

async function start(t, dataDir, extra, env) {
  const child = spawn(cliCommand[0], [...cliCommand.slice(1), "gui", "--no-open", "--port", "0", "--data-dir", dataDir, ...extra], { env });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
  });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`GUI did not start: ${output}`)), 15_000);
    child.on("error", reject);
    child.stderr.on("data", (chunk) => (output += chunk));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  const html = await (await fetch(url)).text();
  const token = html.match(/name="tutor-session" content="([^"]+)"/)?.[1];
  assert.ok(token);
  const request = (pathname, init = {}) => fetch(url + pathname, {
    ...init,
    headers: { "x-tutor-session": token, ...init.headers },
  });
  return { request };
}

async function waitForJob(request, predicate) {
  for (let index = 0; index < 600; index++) {
    const state = await (await request("/api/state")).json();
    if (state.job && predicate(state.job)) return state.job;
    if (state.job?.status === "failed") throw new Error(`GUI job failed: ${JSON.stringify(state.job)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("GUI chapter job did not finish");
}

test("GUI exposes chapter progress, generation, and chapter files", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-gui-courses-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const courseDir = path.join(dataDir, "logic");
  const parsed = path.join(courseDir, "parsed", "page-1");
  const originalPage = path.join(courseDir, "original-pages", "page-0001.png");
  const source = path.join(courseDir, "source", "logic.pdf");
  await mkdir(parsed, { recursive: true });
  await mkdir(path.dirname(originalPage), { recursive: true });
  await mkdir(path.dirname(source), { recursive: true });
  const typ = path.join(root, "logic.typ");
  await writeFile(typ, "#set page(width: 10cm, height: 2cm)\n= Logic gates\nAND and OR gates\n");
  await run("typst", ["compile", typ, source]);
  await run("pdftoppm", ["-png", "-singlefile", "-r", "36", source, originalPage.replace(/\.png$/, "")]);
  await writeFile(path.join(parsed, "full.md"), "# Logic gates\nAND and OR gates\n");
  await writeFile(path.join(courseDir, ".course-name"), "Logic\n");

  const materialId = "11111111-1111-4111-8111-111111111111";
  const chapterId = "22222222-2222-4222-8222-222222222222";
  const secondChapterId = "77777777-7777-4777-8777-777777777777";
  const page = {
    sourcePage: 1,
    pagePdf: source,
    originalPageImage: originalPage,
    parsedDirectory: parsed,
    markdown: "# Logic gates\nAND and OR gates",
  };
  await writeFile(path.join(courseDir, "course.json"), JSON.stringify({
    schemaVersion: 1,
    id: "33333333-3333-4333-8333-333333333333",
    version: 1,
    name: "Logic",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    materials: [{
      id: materialId,
      signature: "fixture-material",
      version: "fixture-version",
      name: "logic.pdf",
      sourceHash: "fixture-version",
      importedAt: "2026-01-01T00:00:00.000Z",
      sourcePages: [1],
      pages: [page],
      screenshots: [],
      chapterIds: [chapterId, secondChapterId],
    }],
    chapters: [chapterId, secondChapterId].map((id, index) => ({
      id,
      version: 1,
      title: index === 0 ? "Logic gates" : "Combinational logic",
      status: "pending",
      order: index + 1,
      source: {
        materialId,
        materialVersion: "fixture-version",
        startPage: index + 1,
        endPage: index + 1,
        startHeading: index === 0 ? "Logic gates" : "Combinational logic",
        endHeading: null,
      },
      needsConfirmation: false,
      progressUpdatedAt: null,
      lecture: { status: "none", courseVersion: 1 },
    })),
    route: {
      version: 1,
      markdown: "## Teaching order\n1. Logic gates\n",
      confirmedAt: "2026-01-01T00:00:00.000Z",
    chapterIds: [chapterId, secondChapterId],
    },
  }));

  const modelUrl = await listen(createServer(async (request, response) => {
    await body(request);
    sse(response, "# Logic gates lecture\n\nAn AND gate outputs 1 only when every input is 1.");
  }));
  const agentDir = path.join(root, "pi");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      tutorTest: {
        baseUrl: `${modelUrl}/v1`,
        api: "openai-completions",
        apiKey: "gui-course-model-test",
        compat: { supportsUsageInStreaming: false },
        models: [{ id: "gui-course-model", input: ["text", "image"] }],
      },
    },
  }));
  const gui = await start(t, dataDir, ["--agent-dir", agentDir, "--model", "tutorTest/gui-course-model"], {
    ...process.env,
    NO_COLOR: "1",
  });

  let state = await (await gui.request("/api/state")).json();
  assert.equal(state.courses[0].chapters[0].title, "Logic gates");
  assert.equal(state.courses[0].materials, 1);
  let detail = await (await gui.request("/api/courses/logic")).json();
  assert.equal(detail.chapters[0].status, "pending");

  const [marked, secondMarked] = await Promise.all([
    gui.request(`/api/courses/logic/chapters/${chapterId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    }),
    gui.request(`/api/courses/logic/chapters/${secondChapterId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "learned" }),
    }),
  ]);
  assert.equal(marked.status, 200);
  assert.equal(secondMarked.status, 200);
  state = await (await gui.request("/api/state")).json();
  assert.equal(state.courses[0].chapters[0].status, "in_progress");
  assert.equal(state.courses[0].chapters[1].status, "learned");
  detail = await (await gui.request("/api/courses/logic")).json();
  assert.equal(detail.chapters[0].status, "in_progress");

  const job = await gui.request("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "generate", courseId: "logic", chapterId }),
  });
  assert.equal(job.status, 202);
  await waitForJob(gui.request, (entry) => entry.status === "succeeded");
  detail = await (await gui.request("/api/courses/logic")).json();
  assert.ok(detail.chapters, JSON.stringify(detail));
  assert.equal(detail.chapters[0].lecture.status, "published");
  assert.match(detail.chapters[0].lecture.content, /Logic gates lecture/);
  const pdf = await gui.request(`/api/courses/logic/chapters/${chapterId}/files/document.pdf`);
  assert.equal(pdf.status, 200);
});

test("GUI exposes and resolves ambiguous chapter titles", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-gui-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const courseDir = path.join(dataDir, "logic");
  await mkdir(courseDir, { recursive: true });
  await writeFile(path.join(courseDir, ".course-name"), "Logic\n");
  const materialId = "11111111-1111-4111-8111-111111111111";
  const chapters = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"].map((id, index) => ({
    id,
    version: 1,
    title: "Repeated",
    status: "pending",
    order: index + 1,
    source: { materialId, materialVersion: "fixture", startPage: index + 1, endPage: index + 1 },
    needsConfirmation: true,
    progressUpdatedAt: null,
    lecture: { status: "none", courseVersion: 1 },
  }));
  await writeFile(path.join(courseDir, "course.json"), JSON.stringify({
    schemaVersion: 1,
    id: "66666666-6666-4666-8666-666666666666",
    version: 1,
    name: "Logic",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    materials: [{
      id: materialId, signature: "fixture", version: "fixture", name: "logic.pdf", sourceHash: "fixture",
      importedAt: "2026-01-01T00:00:00.000Z", sourcePages: [1, 2], pages: [], screenshots: [], chapterIds: chapters.map((chapter) => chapter.id),
    }],
    chapters,
    route: { version: 1, markdown: "## Teaching order\n1. Repeated\n2. Repeated\n", confirmedAt: null, chapterIds: chapters.map((chapter) => chapter.id) },
  }));
  const gui = await start(t, dataDir, [], process.env);

  let state = await (await gui.request("/api/state")).json();
  assert.equal(state.courses[0].chapters.filter((chapter) => chapter.needsConfirmation).length, 2);
  let detail = await (await gui.request("/api/courses/logic")).json();
  assert.equal(detail.chapters.filter((chapter) => chapter.needsConfirmation).length, 2);

  const blocked = await gui.request("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "generate", courseId: "logic", chapterId: chapters[0].id }),
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /章节名待确认/);

  const duplicate = await gui.request(`/api/courses/logic/chapters/${chapters[0].id}/title`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Repeated" }),
  });
  assert.equal(duplicate.status, 400);
  await gui.request(`/api/courses/logic/chapters/${chapters[0].id}/title`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Repeated first" }),
  });
  await gui.request(`/api/courses/logic/chapters/${chapters[1].id}/title`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Repeated second" }),
  });
  state = await (await gui.request("/api/state")).json();
  assert.equal(state.courses[0].chapters.filter((chapter) => chapter.needsConfirmation).length, 0);
  detail = await (await gui.request("/api/courses/logic")).json();
  assert.deepEqual(detail.chapters.map((chapter) => chapter.title), ["Repeated first", "Repeated second"]);
});

test("GUI creates and re-enters an empty durable course", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-gui-empty-course-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const gui = await start(t, dataDir, [], process.env);

  const create = async (name) => {
    const response = await gui.request("/api/courses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return { status: response.status, body: await response.json() };
  };
  const first = await create("Future Logic");
  assert.equal(first.status, 201);
  const second = await create("Future Logic");
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.courseId, first.body.courseId);

  const state = await (await gui.request("/api/state")).json();
  assert.deepEqual(state.courses.map((course) => course.name), ["Future Logic"]);
  assert.deepEqual(state.courses[0].chapters, []);
  assert.equal(state.courses[0].courseId, first.body.courseId);
  const detail = await (await gui.request(`/api/courses/${first.body.id}`)).json();
  assert.deepEqual(detail.chapters, []);
  assert.equal(detail.courseId, first.body.courseId);
  assert.equal(detail.route, "");
});

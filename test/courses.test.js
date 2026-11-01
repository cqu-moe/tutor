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
const outputLines = (value) => value.trim().split("\n");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function requestBody(request) {
  let value = "";
  for await (const chunk of request) value += chunk;
  return JSON.parse(value);
}

function sse(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "course-1", object: "chat.completion.chunk", created: 1, model: "course-model" };
  const delta = { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
  const end = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  response.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
}

async function compileChapters(root, name, firstPage, booleanTitle = "Boolean algebra", combinationalTitle = "Combinational logic") {
  const typ = path.join(root, `${name}.typ`);
  const pdf = path.join(root, `${name}.pdf`);
  await writeFile(typ, [
    "#set page(width: 10cm, height: 2cm)",
    `= ${booleanTitle}\n${firstPage}`,
    "#pagebreak()",
    `= ${combinationalTitle}\nOutput equations`,
    "#pagebreak()",
    "= Sequential logic\nState registers",
  ].join("\n"));
  await run("typst", ["compile", typ, pdf]);
  return pdf;
}

async function compileRepeatedChapters(root) {
  const typ = path.join(root, "repeated.typ");
  const pdf = path.join(root, "repeated.pdf");
  await writeFile(typ, [
    "#set page(width: 10cm, height: 2cm)",
    "= Repeated\nFirst occurrence",
    "#pagebreak()",
    "= Unique\nUnique occurrence",
    "#pagebreak()",
    "= Repeated\nSecond occurrence",
  ].join("\n"));
  await run("typst", ["compile", typ, pdf]);
  return pdf;
}

function runCli(args, env = process.env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(cliCommand[0], [...cliCommand.slice(1), ...args], { env: { ...env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`CLI exited ${code}\n${stdout}\n${stderr}`));
    });
    child.stdin.end(input);
  });
}

test("CLI migrates a legacy chapter and changes progress only when marked", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-courses-legacy-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const courseDir = path.join(dataDir, "digital-design");
  const parsed = path.join(courseDir, "parsed", "legacy-page");
  const originalPage = path.join(courseDir, "original-pages", "page-0001.png");
  const source = path.join(courseDir, "source", "lecture.pdf");
  await mkdir(parsed, { recursive: true });
  await mkdir(path.dirname(originalPage), { recursive: true });
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(path.join(parsed, "full.md"), "# Boolean functions\nF = xy + x'z\n");
  await writeFile(originalPage, "png");
  await writeFile(source, "pdf");
  await writeFile(path.join(courseDir, ".course-name"), "Digital Design\n");
  await writeFile(path.join(courseDir, "draft.json"), JSON.stringify({
    context: {
      course: "Digital Design",
      selection: {
        type: "chapter",
        title: "Boolean algebra",
        startHeading: "Boolean algebra",
        startPage: 1,
        endHeading: "Combinational logic",
        endPage: 2,
      },
      pages: [{
        sourcePage: 1,
        pagePdf: source,
        originalPageImage: originalPage,
        parsedDirectory: parsed,
        markdown: "# Boolean functions\nF = xy + x'z",
      }],
      screenshots: [],
      confirmedAt: "2026-01-01T00:00:00.000Z",
    },
    route: "## Teaching order\n1. Boolean algebra\n",
  }));

  const initial = await runCli(["--course", "Digital Design", "--data-dir", dataDir, "--chapters"]);
  assert.match(initial, /Boolean algebra/);
  assert.match(initial, /\[pending\]/);
  assert.match(initial, /chapter [0-9a-f-]{36}/);
  const chapterId = initial.match(/chapter ([0-9a-f-]{36})/)?.[1];

  const unchanged = await runCli(["--course", "Digital Design", "--data-dir", dataDir, "--chapters"]);
  assert.match(unchanged, /\[pending\]/);
  assert.match(unchanged, /1\. Boolean algebra/);

  const marked = await runCli([
    "--course", "Digital Design", "--data-dir", dataDir,
    "--chapter-id", chapterId, "--progress", "learned",
  ]);
  assert.equal(marked, "");
  const listed = await runCli(["--course", "Digital Design", "--data-dir", dataDir, "--chapters"]);
  assert.match(listed, /\[learned\]/);
  assert.match(listed, /1\. Boolean algebra/);
});

test("CLI creates and re-enters an empty course with one durable identity", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-course-empty-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const common = ["--course", "Future Course", "--data-dir", dataDir, "--chapters"];

  const first = await runCli(common);
  assert.match(first, /Course Future Course · course [0-9a-f-]{36}/);
  assert.match(first, /No chapters yet/);
  const courseId = first.match(/course ([0-9a-f-]{36})/)?.[1];
  const second = await runCli(common);
  assert.equal(second.match(/course ([0-9a-f-]{36})/)?.[1], courseId);
});

test("CLI accumulates versioned chapters and protects learned entries", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-courses-accumulate-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const firstPdf = await compileChapters(root, "lecture-v1", "F = xy + x'z");
  const secondPdf = await compileChapters(root, "lecture-v2", "F = xy + xz");
  const agentDir = path.join(root, "pi");
  await mkdir(agentDir, { recursive: true });

  let ocrCalls = 0;
  const ocrUrl = await listen(createServer(async (request, response) => {
    await requestBody(request);
    ocrCalls++;
    response.end(JSON.stringify({ pages: [{ index: 0, markdown: "# Course page\nBoolean functions" }] }));
  }));
  const modelRequests = [];
  const modelUrl = await listen(createServer(async (request, response) => {
    const payload = await requestBody(request);
    modelRequests.push(payload);
    if (modelRequests.length === 2) {
      sse(response, "## Teaching order\n1. Boolean algebra\n2. Combinational logic\n3. Sequential logic\n4. Boolean algebra\n5. Combinational logic");
      return;
    }
    if (modelRequests.length === 3) {
      sse(response, "## Teaching order\n1. Boolean algebra\n2. Combinational logic\n3. Sequential logic\n4. Boolean algebra v2\n5. Combinational logic v2\n6. Renamed pending chapter\n7. Combinational logic v3");
      return;
    }
    if (modelRequests.length === 4) {
      sse(response, "## Teaching order\n1. Combinational logic\n2. Boolean algebra\n3. Sequential logic\n4. Boolean algebra v2\n5. Combinational logic v2\n6. Boolean algebra v3\n7. Combinational logic v3");
      return;
    }
    sse(response, "## Teaching order\n1. Boolean algebra\n2. Combinational logic\n3. Sequential logic");
  }));
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      tutorTest: {
        baseUrl: `${modelUrl}/v1`,
        api: "openai-completions",
        apiKey: "course-model-test",
        compat: { supportsUsageInStreaming: false },
        models: [{ id: "course-model", input: ["text", "image"] }],
      },
    },
  }));
  const common = [
    "--course", "Digital Design", "--data-dir", dataDir,
    "--ocr", "mistral", "--mistral-base-url", ocrUrl,
    "--agent-dir", agentDir, "--model", "tutorTest/course-model",
  ];
  const env = { ...process.env, MISTRAL_API_KEY: "course-ocr-test", NO_COLOR: "1" };

  await runCli([...common, "--pdf", firstPdf, "--pages", "1-3"], env);
  let chapters = await runCli([...common, "--chapters"], env);
  assert.equal(outputLines(chapters).length, 4);
  assert.match(chapters, /Boolean algebra/);
  assert.match(chapters, /Combinational logic/);
  assert.match(chapters, /Sequential logic/);
  const learnedId = chapters.match(/\[pending\] 1\. Boolean algebra .*chapter ([0-9a-f-]{36})/)?.[1];
  const protectedId = chapters.match(/\[pending\] 2\. Combinational logic .*chapter ([0-9a-f-]{36})/)?.[1];

  await runCli([...common, "--chapter-id", learnedId, "--progress", "learned"], env);
  await runCli([...common, "--chapter-id", protectedId, "--progress", "in_progress"], env);
  await runCli([...common, "--pdf", secondPdf, "--pages", "1-2"], env);
  chapters = await runCli([...common, "--chapters"], env);
  assert.equal(outputLines(chapters).filter((line) => line.includes("Boolean algebra")).length, 2);
  assert.match(chapters, /\[learned\] 1\. Boolean algebra/);
  assert.match(chapters, /\[pending\] 4\. Boolean algebra/);
  const firstVersion = chapters.match(/lecture-v1\.pdf\s+([^\s·]+)/)?.[1];
  const secondVersion = chapters.match(/lecture-v2\.pdf\s+([^\s·]+)/)?.[1];
  assert.ok(firstVersion && secondVersion, chapters);
  assert.notEqual(firstVersion, secondVersion);
  const secondBooleanId = chapters.match(/\[pending\] 4\. Boolean algebra .*chapter ([0-9a-f-]{36})/)?.[1];
  const secondCombinationalId = chapters.match(/\[pending\] 5\. Combinational logic .*chapter ([0-9a-f-]{36})/)?.[1];
  assert.match(chapters, /4\. Boolean algebra .*title needs confirmation/);
  assert.match(chapters, /5\. Combinational logic .*title needs confirmation/);
  await runCli([...common, "--confirm-chapter", "--chapter-id", secondBooleanId, "--title", "Boolean algebra v2"], env);
  await runCli([...common, "--confirm-chapter", "--chapter-id", secondCombinationalId, "--title", "Combinational logic v2"], env);

  await runCli([...common, "--pdf", firstPdf, "--pages", "1-3"], env);
  const deduplicated = await runCli([...common, "--chapters"], env);
  assert.equal(outputLines(deduplicated).filter((line) => line.includes("Boolean algebra")).length, 2);
  assert.equal(ocrCalls, 5);
  assert.equal(modelRequests.length, 2);

  const thirdPdf = await compileChapters(root, "lecture-v3", "F = x + yz", "Boolean algebra v3", "Combinational logic v3");
  await assert.rejects(
    () => runCli([...common, "--pdf", thirdPdf, "--pages", "1-2"], env, "confirm\n"),
    /Teaching route does not match the course chapters exactly/,
  );
  await assert.rejects(
    () => runCli([...common, "--pdf", thirdPdf, "--pages", "1-2"], env, "confirm\n"),
    /Teaching route would move protected chapter/,
  );
  const protectedRoute = await runCli([...common, "--chapters"], env);
  assert.match(protectedRoute, /\[learned\] 1\. Boolean algebra/);
  assert.match(protectedRoute, /\[in_progress\] 2\. Combinational logic/);
  assert.equal(outputLines(protectedRoute).length, 6);
  assert.equal(ocrCalls, 7);
});

test("CLI keeps ambiguous chapter titles pending until explicit confirmation", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-courses-ambiguous-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const pdf = await compileRepeatedChapters(root);
  const agentDir = path.join(root, "pi");
  await mkdir(agentDir, { recursive: true });
  const ocrUrl = await listen(createServer(async (request, response) => {
    await requestBody(request);
    response.end(JSON.stringify({ pages: [{ index: 0, markdown: "# Repeated chapter" }] }));
  }));
  const modelUrl = await listen(createServer(async (request, response) => {
    await requestBody(request);
    sse(response, "## Teaching order\n1. Repeated\n2. Unique\n3. Repeated");
  }));
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      tutorTest: {
        baseUrl: `${modelUrl}/v1`,
        api: "openai-completions",
        apiKey: "course-model-test",
        compat: { supportsUsageInStreaming: false },
        models: [{ id: "course-model", input: ["text", "image"] }],
      },
    },
  }));
  const common = [
    "--course", "Repeated Course", "--data-dir", dataDir,
    "--ocr", "mistral", "--mistral-base-url", ocrUrl,
    "--agent-dir", agentDir, "--model", "tutorTest/course-model",
  ];
  const env = { ...process.env, MISTRAL_API_KEY: "course-ocr-test", NO_COLOR: "1" };

  await assert.rejects(
    () => runCli([...common, "--pdf", pdf, "--pages", "1-3"], env, "confirm\n"),
    /2 chapter titles need confirmation/,
  );
  let chapters = await runCli([...common, "--chapters"], env);
  assert.equal(outputLines(chapters).filter((line) => line.includes("title needs confirmation")).length, 2);
  assert.match(chapters, /--confirm-chapter --chapter-id <id> --title <courseware title>/);
  const ids = [...chapters.matchAll(/chapter ([0-9a-f-]{36})/g)].map((match) => match[1]);

  await assert.rejects(
    () => runCli([...common, "--generate", "--chapter-id", ids[0]], env),
    /Resolve the chapter title before generating its lecture/,
  );
  await runCli([...common, "--confirm-chapter", "--chapter-id", ids[0], "--title", "Repeated - first pass"], env);
  await runCli([...common, "--confirm-chapter", "--chapter-id", ids[2], "--title", "Repeated - second pass"], env);
  chapters = await runCli([...common, "--chapters"], env);
  assert.doesNotMatch(chapters, /title needs confirmation/);

  await runCli([...common, "--resume"], env, "confirm\n");
  const confirmed = await runCli([...common, "--chapters"], env);
  assert.doesNotMatch(confirmed, /title needs confirmation/);
});

test("CLI generates a lecture for one selected course chapter", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-courses-chapter-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const pdf = await compileChapters(root, "chapter-lecture", "F = xy + x'z");
  const agentDir = path.join(root, "pi");
  await mkdir(agentDir, { recursive: true });

  const ocrUrl = await listen(createServer(async (request, response) => {
    await requestBody(request);
    response.end(JSON.stringify({ pages: [{ index: 0, markdown: "# Course page\nBoolean functions" }] }));
  }));
  const modelUrl = await listen(createServer(async (request, response) => {
    const payload = await requestBody(request);
    const generation = JSON.stringify(payload.messages).includes("Write the complete lecture");
    if (generation) {
      sse(response, "# Boolean algebra lecture\n\nF = xy + x'z means either x and y, or not x and z.");
      return;
    }
    routeRequests++;
    sse(response, routeRequests === 1
      ? "## Teaching order\n1. Boolean algebra\n2. Combinational logic\n3. Sequential logic"
      : "## Teaching order\n1. Boolean algebra\n2. Combinational logic\n3. Sequential logic\n4. Boolean algebra supplement\n5. Combinational logic supplement");
  }));
  let routeRequests = 0;
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      tutorTest: {
        baseUrl: `${modelUrl}/v1`,
        api: "openai-completions",
        apiKey: "course-model-test",
        compat: { supportsUsageInStreaming: false },
        models: [{ id: "course-model", input: ["text", "image"] }],
      },
    },
  }));
  const common = [
    "--course", "Digital Design", "--data-dir", dataDir,
    "--ocr", "mistral", "--mistral-base-url", ocrUrl,
    "--agent-dir", agentDir, "--model", "tutorTest/course-model",
  ];
  const env = { ...process.env, MISTRAL_API_KEY: "course-ocr-test", NO_COLOR: "1" };

  await runCli([...common, "--pdf", pdf, "--pages", "1-3"], env, "confirm\n");
  const chapters = await runCli([...common, "--chapters"], env);
  const chapterId = chapters.match(/\[pending\] 2\. Combinational logic .*chapter ([0-9a-f-]{36})/)?.[1];
  assert.ok(chapterId, chapters);

  const output = await runCli([...common, "--generate", "--chapter-id", chapterId], env);
  assert.match(output, new RegExp(`Lecture exported: .*chapters/${chapterId}/output`));
  const content = await readFile(path.join(dataDir, "digital-design", "chapters", chapterId, "output", "content.md"), "utf8");
  assert.match(content, /Boolean algebra lecture/);
  const listed = await runCli([...common, "--chapters"], env);
  assert.match(listed, /\[pending\] 2\. Combinational logic .*lecture published/);

  const supplement = await compileChapters(
    root,
    "chapter-supplement",
    "F = x + yz",
    "Boolean algebra supplement",
    "Combinational logic supplement",
  );
  await runCli([...common, "--pdf", supplement, "--pages", "1-2"], env);
  const supplemented = await runCli([...common, "--chapters"], env);
  assert.match(supplemented, /\[pending\] 2\. Combinational logic .*chapter-lecture\.pdf .*lecture published/);
  assert.match(supplemented, /4\. Boolean algebra supplement/);
  assert.match(supplemented, /5\. Combinational logic supplement/);
});

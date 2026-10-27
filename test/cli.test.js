import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

function runCli(executable, args, input, env) {
  let settled = false;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout);
      else reject(new Error(`CLI exited ${code}\n${stdout}\n${stderr}`));
    });
    child.stdin.end(input);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out\n${stdout}\n${stderr}`));
    }, 15_000).unref();
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address())));
}

function body(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}

function sse(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "route-1", object: "chat.completion.chunk", created: 1, model: "route-model" };
  const delta = { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
  const end = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  response.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
}

test("CLI proposes and adjusts a teaching route without confirmation", { timeout: 30_000 }, async () => {
  const root = await mkdir(path.join(tmpdir(), `tutor-issue2-${Date.now()}`), { recursive: true });
  const pdf = path.join(root, "lecture.pdf");
  await writeFile(path.join(root, "lecture.typ"), "#set page(width: 2cm, height: 2cm)\nBoolean algebra\n");
  await run("typst", ["compile", path.join(root, "lecture.typ"), pdf]);

  const zip = path.join(root, "result.zip");
  const parsed = path.join(root, "parsed");
  await mkdir(parsed);
  await writeFile(path.join(parsed, "full.md"), "# Page 21\nF = xy + x'z\n");
  await writeFile(path.join(parsed, "layout.json"), "{}\n");
  await run("/usr/bin/zip", ["-q", "-j", zip, path.join(parsed, "full.md"), path.join(parsed, "layout.json")]);
  const zipBytes = await readFile(zip);

  const mineruRequests = [];
  const mineru = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/v4/file-urls/batch") {
      mineruRequests.push(JSON.parse(await body(request)));
      response.end(JSON.stringify({
        code: 0,
        data: {
          batch_id: "batch-1",
          file_urls: [`http://${mineruAddress.address}:${mineruAddress.port}/upload`],
        },
      }));
      return;
    }
    if (request.method === "PUT" && request.url === "/upload") {
      request.resume();
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/api/v4/extract-results/batch/batch-1") {
      response.end(JSON.stringify({
        code: 0,
        data: {
          batch_id: "batch-1",
          extract_result: [{
            file_name: "page-0001.pdf",
            state: "done",
            full_zip_url: `http://${mineruAddress.address}:${mineruAddress.port}/result.zip`,
          }],
        },
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/result.zip") {
      response.end(zipBytes);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const mineruAddress = await listen(mineru);

  const modelRequests = [];
  const model = createServer(async (request, response) => {
    const payload = JSON.parse(await body(request));
    modelRequests.push(payload);
    const adjustment = JSON.stringify(payload.messages).includes("Put logic gates first");
    sse(response, adjustment ? "## Adjusted route\n1. Logic gates" : "## Proposed route\n1. Boolean algebra\nDoubt: table boundary");
  });
  const modelAddress = await listen(model);

  const agentDir = path.join(root, "pi");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      tutorTest: {
        baseUrl: `http://${modelAddress.address}:${modelAddress.port}/v1`,
        api: "openai-completions",
        apiKey: "test-only",
        compat: { supportsUsageInStreaming: false },
        models: [{ id: "route-model", input: ["text", "image"] }],
      },
    },
  }));

  const dataDir = path.join(root, "data");
  const cli = path.join(import.meta.dirname, "..", "bin", "tutor.js");
  try {
    const stdout = await runCli(cli, [
      "--course", "Digital Design",
      "--pdf", pdf,
      "--pages", "1",
      "--data-dir", dataDir,
      "--agent-dir", agentDir,
      "--model", "tutorTest/route-model",
      "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}`,
    ], "Put logic gates first\n", {
      ...process.env,
      MINERU_API_TOKEN: "test-only-token",
      NO_COLOR: "1",
    });

    assert.match(stdout, /## Proposed route/);
    assert.match(stdout, /## Adjusted route/);
    assert.match(stdout, /Route was not confirmed/);
    assert.match(stdout, /Type an adjustment, or type 'confirm'/);

    const context = JSON.parse(await readFile(path.join(dataDir, "digital-design", "context.json")));
    assert.equal(context.course, "Digital Design");
    assert.equal(context.pages[0].sourcePage, 1);
    await assert.rejects(() => readFile(path.join(dataDir, "digital-design", "output", "content.md")));

    const unconfirmed = await runCli(cli, [
      "--course", "Digital Design",
      "--pdf", pdf,
      "--pages", "1",
      "--data-dir", dataDir,
      "--agent-dir", agentDir,
      "--model", "tutorTest/route-model",
      "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}`,
    ], "", {
      ...process.env,
      MINERU_API_TOKEN: "test-only-token",
      NO_COLOR: "1",
    });
    assert.match(unconfirmed, /Route was not confirmed/);
    await readFile(path.join(dataDir, "digital-design", "route-draft.md"));
  } finally {
    await new Promise((resolve) => mineru.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});

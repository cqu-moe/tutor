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
  const end = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  response.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
}

test("default model receives original page and screenshot images", { timeout: 30_000 }, async () => {
  const root = await mkdir(path.join(tmpdir(), `tutor-models-${Date.now()}`), { recursive: true });
  const pdf = path.join(root, "lecture.pdf");
  await writeFile(path.join(root, "lecture.typ"), "#set page(width: 2cm, height: 2cm)\nBoolean algebra\n");
  await run("typst", ["compile", path.join(root, "lecture.typ"), pdf]);
  const pageImage = path.join(root, "page.png");
  await run("pdftoppm", ["-jpeg", "-r", "30", "-singlefile", pdf, pageImage]);
  const screenshot = `${pageImage}.jpg`;

  const zip = path.join(root, "result.zip");
  const parsed = path.join(root, "parsed");
  await mkdir(parsed);
  await writeFile(path.join(parsed, "full.md"), "# Material\nF = xy + x'z\n");
  await run("/usr/bin/zip", ["-q", "-j", zip, path.join(parsed, "full.md")]);
  const zipBytes = await readFile(zip);

  const mineruFiles = [];
  const mineru = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/v4/file-urls/batch") {
      const payload = JSON.parse(await body(request));
      mineruFiles.push(...payload.files);
      response.end(JSON.stringify({
        code: 0,
        data: {
          batch_id: "batch-1",
          file_urls: payload.files.map((file) => (
            `http://${mineruAddress.address}:${mineruAddress.port}/upload-${file.data_id}`
          )),
        },
      }));
      return;
    }
    if (request.method === "PUT" && request.url.startsWith("/upload-")) {
      request.resume();
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/api/v4/extract-results/batch/batch-1") {
      response.end(JSON.stringify({
        code: 0,
        data: {
          batch_id: "batch-1",
          extract_result: mineruFiles.map((file, index) => ({
            file_name: file.name,
            state: "done",
            full_zip_url: `http://${mineruAddress.address}:${mineruAddress.port}/result-${index}.zip`,
          })),
        },
      }));
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/result-")) {
      response.end(zipBytes);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const mineruAddress = await listen(mineru);

  const requests = [];
  const model = createServer(async (request, response) => {
    const payload = JSON.parse(await body(request));
    requests.push(payload);
    sse(response, "## Proposed route\n1. Boolean algebra");
  });
  const modelAddress = await listen(model);

  const agentDir = path.join(root, "pi");
  await mkdir(agentDir);
  const provider = (id) => ({
    baseUrl: `http://${modelAddress.address}:${modelAddress.port}/v1`,
    api: "openai-completions",
    apiKey: `${id}-key`,
    compat: { supportsUsageInStreaming: false },
    models: [{ id: `${id}-model`, input: ["text", "image"] }],
  });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      first: { ...provider("first"), models: [{ id: "first-model", input: ["text", "image"] }] },
      magpie: { ...provider("magpie"), models: [{ id: "codex/gpt-6.1-sol", input: ["text", "image"] }] },
    },
  }));

  try {
    const cli = path.join(import.meta.dirname, "..", "bin", "tutor.js");
    const stdout = await runCli(cli, [
      "--course", "Digital Design",
      "--pdf", pdf,
      "--pages", "1",
      "--screenshots", screenshot,
      "--data-dir", path.join(root, "data"),
      "--agent-dir", agentDir,
      "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}`,
    ], "confirm\n", { ...process.env, MINERU_API_TOKEN: "test-only-token", NO_COLOR: "1" });

    assert.match(stdout, /Teaching route confirmed/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, "codex/gpt-6.1-sol");
    const images = requests[0].messages.at(-1).content.filter((part) => part.type === "image_url");
    assert.deepEqual(images.map((part) => part.image_url.url.split(";")[0]), ["data:image/png", "data:image/jpeg"]);
  } finally {
    await new Promise((resolve) => mineru.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});

test("model failures are actionable, redacted, and preserve course work", { timeout: 45_000 }, async () => {
  const root = await mkdir(path.join(tmpdir(), `tutor-model-errors-${Date.now()}`), { recursive: true });
  const pdf = path.join(root, "lecture.pdf");
  await writeFile(path.join(root, "lecture.typ"), "#set page(width: 2cm, height: 2cm)\nBoolean algebra\n");
  await run("typst", ["compile", path.join(root, "lecture.typ"), pdf]);

  const zip = path.join(root, "result.zip");
  const parsed = path.join(root, "parsed");
  await mkdir(parsed);
  await writeFile(path.join(parsed, "full.md"), "# Material\nF = xy + x'z\n");
  await run("/usr/bin/zip", ["-q", "-j", zip, path.join(parsed, "full.md")]);
  const zipBytes = await readFile(zip);

  const mineruFiles = [];
  const mineru = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/v4/file-urls/batch") {
      const payload = JSON.parse(await body(request));
      mineruFiles.push(payload.files);
      response.end(JSON.stringify({
        code: 0,
        data: {
          batch_id: `batch-${mineruFiles.length}`,
          file_urls: payload.files.map((file) => `http://${mineruAddress.address}:${mineruAddress.port}/upload`),
        },
      }));
      return;
    }
    if (request.method === "PUT" && request.url === "/upload") {
      request.resume();
      response.end();
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/v4/extract-results/batch/")) {
      const files = mineruFiles.at(-1);
      response.end(JSON.stringify({
        code: 0,
        data: {
          extract_result: files.map((file) => ({
            file_name: file.name,
            state: "done",
            full_zip_url: `http://${mineruAddress.address}:${mineruAddress.port}/result.zip`,
          })),
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
  const modelSecret = "model-secret-value";
  const oauthSecret = "oauth-access-secret";
  const model = createServer(async (request, response) => {
    const payload = JSON.parse(await body(request));
    modelRequests.push(payload);
    if (payload.model === "failing-model") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Invalid API key: ${modelSecret}; access ${oauthSecret}; upstream-private-detail` } }));
      return;
    }
    sse(response, "## Proposed route");
  });
  const modelAddress = await listen(model);

  const agentDir = path.join(root, "pi");
  await mkdir(agentDir);
  const base = {
    baseUrl: `http://${modelAddress.address}:${modelAddress.port}/v1`,
    api: "openai-completions",
    compat: { supportsUsageInStreaming: false },
  };
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      text: { ...base, apiKey: "text-key", models: [{ id: "text-model", input: ["text"] }] },
      invalid: { ...base, api: "not-a-protocol", apiKey: "protocol-key", models: [{ id: "protocol-model", input: ["text", "image"] }] },
      echo: { ...base, apiKey: `!printf ${modelSecret}`, models: [{ id: "failing-model", input: ["text", "image"] }] },
    },
  }));

  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ unused: { type: "oauth", access: oauthSecret, refresh: "oauth-refresh-secret", expires: 0 } }));

  const cases = [
    { model: "text/text-model", failure: /cannot read course images/ },
    { model: "invalid/protocol-model", failure: /unsupported model API protocol.*models.json/ },
    { model: "echo/failing-model", failure: /HTTP 401.*credentials/ },
  ];
  const cli = path.join(import.meta.dirname, "..", "bin", "tutor.js");
  try {
    for (const [index, testCase] of cases.entries()) {
      const dataDir = path.join(root, `data-${index}`);
      await assert.rejects(
        runCli(cli, [
          "--course", "Digital Design",
          "--pdf", pdf,
          "--pages", "1",
          "--data-dir", dataDir,
          "--agent-dir", agentDir,
          "--model", testCase.model,
          "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}`,
        ], "", { ...process.env, MINERU_API_TOKEN: "test-only-token", NO_COLOR: "1" }),
        (error) => {
          assert.match(error.message, testCase.failure);
          assert.doesNotMatch(error.message, new RegExp(modelSecret));
          assert.doesNotMatch(error.message, new RegExp(oauthSecret));
          assert.doesNotMatch(error.message, /upstream-private-detail/);
          return true;
        },
      );
      await readFile(path.join(dataDir, "digital-design", "context.json"));
    }
    assert.deepEqual(modelRequests.map((request) => request.model), ["failing-model"]);
  } finally {
    await new Promise((resolve) => mineru.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});

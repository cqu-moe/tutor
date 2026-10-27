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

test("CLI selects OCR, reuses exact sources, and preserves partial results after failures", { timeout: 90_000 }, async () => {
  const root = await mkdir(path.join(tmpdir(), `tutor-issue5-${Date.now()}`), { recursive: true });
  const pdf = path.join(root, "lecture.pdf");
  await writeFile(path.join(root, "lecture.typ"), "#set page(width: 8cm, height: 8cm)\nBoolean Functions\n#pagebreak()\nComplement of a Function\n");
  await run("typst", ["compile", path.join(root, "lecture.typ"), pdf]);
  const changedPdf = path.join(root, "changed.pdf");
  await writeFile(path.join(root, "changed.typ"), "#set page(width: 2cm, height: 2cm)\nComplement of a Function\n");
  await run("typst", ["compile", path.join(root, "changed.typ"), changedPdf]);
  await run("pdftoppm", ["-f", "1", "-singlefile", "-png", "-scale-to", "100", pdf, path.join(root, "question")]);
  const screenshot = path.join(root, "question.png");

  const parsed = path.join(root, "mineru-result");
  await mkdir(parsed);
  await writeFile(path.join(parsed, "full.md"), "# Page 21\nF = xy + x'z\n");
  await writeFile(path.join(parsed, "layout.json"), "{}\n");
  await writeFile(path.join(parsed, "figure.png"), "png\n");
  const zip = path.join(root, "result.zip");
  await run("/usr/bin/zip", ["-q", "-j", zip, path.join(parsed, "full.md"), path.join(parsed, "layout.json"), path.join(parsed, "figure.png")]);
  const zipBytes = await readFile(zip);
  const unsafeZip = Buffer.from(zipBytes.toString("latin1").replaceAll("full.md", "../x.md"), "latin1");

  let mineruTasks = 0;
  let mineruFileName = "page-0001.pdf";
  let mineruRejects = false;
  let mineruFiles = [];
  let mineruMode = "normal";
  const mineru = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/v4/file-urls/batch") {
      if (mineruRejects) {
        response.statusCode = 503;
        response.end(JSON.stringify({ message: "MinerU is unavailable" }));
        return;
      }
      mineruTasks += 1;
      const payload = JSON.parse(await body(request));
      mineruFileName = payload.files[0].name;
      mineruFiles = payload.files;
      response.end(JSON.stringify({
        code: 0,
        data: {
          batch_id: "batch-1",
          file_urls: payload.files.map(() => `http://${mineru.address().address}:${mineru.address().port}/upload`),
        },
      }));
      assert.equal(payload.model_version, "vlm");
      return;
    }
    if (request.method === "PUT" && request.url === "/upload") {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["content-type"], undefined);
      request.resume();
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/api/v4/extract-results/batch/batch-1") {
      response.end(JSON.stringify({
        code: 0,
        data: { extract_result: mineruFiles.map((file, index) => ({
          file_name: file.name, state: mineruMode === "partial" && index === 0 ? "failed" : "done",
          err_msg: "page processing failed", full_zip_url: `http://${mineru.address().address}:${mineru.address().port}/result.zip`,
        })) },
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/result.zip") {
      response.end(mineruMode === "unsafe" ? unsafeZip : zipBytes);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const mineruAddress = await listen(mineru);

  let mistralCalls = 0;
  let mistralRejects = false;
  let mistralMode = "normal";
  const mistral = createServer(async (request, response) => {
    if (mistralRejects) {
      response.statusCode = 503;
      response.end(JSON.stringify({ message: "Mistral is unavailable" }));
      return;
    }
    mistralCalls += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/ocr");
    assert.equal(request.headers.authorization, "Bearer test-only-mistral");
    const payload = JSON.parse(await body(request));
    assert.equal(payload.model, "mistral-ocr-latest");
    const isImage = payload.document.type === "image_url";
    assert.match(isImage ? payload.document.image_url : payload.document.document_url, isImage ? /^data:image\/png;base64,/ : /^data:application\/pdf;base64,/);
    if ((mistralMode === "image-fails" && isImage) || (mistralMode === "documents-fail" && !isImage)) {
      response.statusCode = 429;
      response.end(JSON.stringify({ message: "quota exceeded test-only-mistral https://upload.example/file?Signature=secret-signature" }));
      return;
    }
    response.end(JSON.stringify({
      model: mistralMode === "normal" ? "mistral-ocr-latest" : "mistral-ocr-2512",
      pages: [{ index: 0, markdown: "# Boolean Functions\nF₄ = xy′ + x′z\n\n![img-0.png](img-0.png)", images: [{ id: mistralMode === "unsafe" ? "../img-0.png" : "img-0.png", image_base64: "data:image/png;base64,cG5n" }] }],
    }));
  });
  const mistralAddress = await listen(mistral);

  const model = createServer(async (request, response) => {
    await body(request);
    sse(response, "## Teaching route\n1. Boolean Functions");
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

  const cli = path.join(import.meta.dirname, "..", "bin", "tutor.js");
  const dataDir = path.join(root, "data");
  const common = ["--course", "Digital Design", "--pdf", pdf, "--pages", "1", "--data-dir", dataDir, "--agent-dir", agentDir, "--model", "tutorTest/route-model"];
  const env = { ...process.env, MINERU_API_TOKEN: "test-only-mineru", MISTRAL_API_KEY: "test-only-mistral", NO_COLOR: "1" };
  try {
    await runCli(cli, [...common, "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}`], "confirm\n", env);
    let context = JSON.parse(await readFile(path.join(dataDir, "digital-design", "context.json")));
    assert.equal(context.pages[0].sourcePage, 1);
    assert.match(context.pages[0].markdown, /F = xy \+ x'z/);
    await readFile(path.join(context.pages[0].parsedDirectory, "figure.png"));
    mineruRejects = true;

    await runCli(cli, [...common, "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}`], "confirm\n", env);
    assert.equal(mineruTasks, 1);

    await runCli(cli, [...common, "--ocr", "mistral", "--mistral-base-url", `http://${mistralAddress.address}:${mistralAddress.port}`], "confirm\n", env);
    context = JSON.parse(await readFile(path.join(dataDir, "digital-design", "context.json")));
    assert.equal(context.pages[0].sourcePage, 1);
    assert.match(context.pages[0].markdown, /Boolean Functions/);
    await readFile(path.join(context.pages[0].parsedDirectory, "img-0.png"));
    mistralRejects = true;

    await runCli(cli, [...common, "--ocr", "mistral", "--mistral-base-url", `http://${mistralAddress.address}:${mistralAddress.port}`], "confirm\n", env);
    assert.equal(mistralCalls, 1);

    const mistralContext = JSON.parse(await readFile(path.join(dataDir, "digital-design", "context.json")));
    await assert.rejects(
      () => runCli(cli, [
        "--course", "Digital Design",
        "--pdf", changedPdf,
        "--pages", "1",
        "--data-dir", dataDir,
        "--agent-dir", agentDir,
        "--model", "tutorTest/route-model",
        "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}`,
      ], "confirm\n", env),
      (error) => {
        assert.match(error.message, /MinerU task creation failed \(HTTP 503\): MinerU is unavailable/);
        assert.doesNotMatch(error.message, /test-only-(mineru|mistral)/);
        return true;
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dataDir, "digital-design", "context.json"))),
      mistralContext,
    );
    assert.match(mistralContext.pages[0].markdown, /Boolean Functions/);

    // The endpoint is part of the selected service identity, even on the same host.
    await assert.rejects(
      () => runCli(cli, [...common, "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}/other-service`], "", env),
      /MinerU task creation.*HTTP 404/,
    );

    mistralRejects = false;
    mistralMode = "image-fails";
    const expanded = [...common, "--pages", "2", "--screenshots", screenshot, "--ocr", "mistral", "--mistral-base-url", `http://${mistralAddress.address}:${mistralAddress.port}`];
    await assert.rejects(() => runCli(cli, expanded, "", env), (error) => {
      assert.match(error.message, /HTTP 429.*quota exceeded/);
      assert.doesNotMatch(error.message, /test-only-mistral|secret-signature/);
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "digital-design", "context.json"))), mistralContext);
    mistralMode = "documents-fail";
    await runCli(cli, expanded, "confirm\n", env);
    const recovered = JSON.parse(await readFile(path.join(dataDir, "digital-design", "context.json")));
    assert.deepEqual(recovered.pages.map((page) => page.sourcePage), [2]);
    assert.equal(recovered.screenshots.length, 1);
    assert.deepEqual(await readFile(recovered.screenshots[0].source), await readFile(screenshot));
    await readFile(path.join(recovered.screenshots[0].parsedDirectory, "img-0.png"));

    mistralMode = "unsafe";
    await assert.rejects(() => runCli(cli, [...expanded, "--course", "Unsafe image"], "", env), /unsafe image resource/);

    mineruRejects = false;
    mineruMode = "unsafe";
    const mineruArgs = [...common, "--mineru-base-url", `http://${mineruAddress.address}:${mineruAddress.port}`];
    await assert.rejects(() => runCli(cli, [...mineruArgs, "--course", "Unsafe archive"], "", env), /archive contains an unsafe path/);

    mineruMode = "partial";
    await assert.rejects(() => runCli(cli, [...mineruArgs, "--course", "Partial MinerU", "--pages", "1-2"], "", env), /page processing failed/);
    mineruRejects = true;
    await runCli(cli, [...mineruArgs, "--course", "Partial MinerU", "--pages", "2"], "confirm\n", env);
  } finally {
    await new Promise((resolve) => mineru.close(resolve));
    await new Promise((resolve) => mistral.close(resolve));
    await new Promise((resolve) => model.close(resolve));
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliCommand } from "./cli-command.js";

test("doctor is local, preserves configuration, checks only selected OCR and loads env files explicitly", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-doctor-test-"));
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const agentDir = path.join(root, "agent");
    await mkdir(agentDir);
    const marker = path.join(root, "credential-command-ran");
    const modelConfig = JSON.stringify({ providers: { openai: { apiKey: `!touch '${marker}'; printf doctor-model-secret` }, doctorTest: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
      apiKey: `!touch '${marker}'; printf doctor-model-secret`,
      models: [{ id: "vision", input: ["text", "image"], contextWindow: 8192, maxTokens: 1024 }],
    } } });
    await writeFile(path.join(agentDir, "models.json"), modelConfig);
    const env = { ...process.env };
    delete env.MISTRAL_API_KEY;
    delete env.MINERU_API_TOKEN;
    await writeFile(path.join(root, ".env"), "MISTRAL_API_KEY=doctor-implicit-secret\n");
    const envFile = path.join(root, "explicit.env");
    await writeFile(envFile, "MISTRAL_API_KEY=doctor-explicit-secret\n");
    const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
      const child = spawn(cliCommand[0], [...cliCommand.slice(1), ...args], { cwd: root, env: { ...env, ...extraEnv }, timeout: 30_000 });
      let output = "";
      child.stdout.on("data", (part) => { output += part; });
      child.stderr.on("data", (part) => { output += part; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
    const args = ["doctor", "--ocr", "mistral", "--agent-dir", agentDir, "--model", "doctorTest/vision"];
    const implicit = await run(args);
    assert.equal(implicit.code, 1);
    assert.match(implicit.output, /FAIL OCR MISTRAL_API_KEY/);
    assert.doesNotMatch(implicit.output, /MINERU_API_TOKEN/);
    const explicit = await run([...args, "--env-file", envFile]);
    assert.match(explicit.output, /PASS OCR MISTRAL_API_KEY/);
    assert.match(explicit.output, /PASS model credentials/);
    assert.match(explicit.output, /PASS model configuration and image support/);
    const precedence = await run([...args, "--env-file", envFile], { MISTRAL_API_KEY: "" });
    assert.match(precedence.output, /FAIL OCR MISTRAL_API_KEY/);
    for (const result of [implicit, explicit, precedence]) {
      assert.doesNotMatch(result.output, /doctor-(implicit|explicit|model)-secret/);
    }
    assert.equal(requests, 0);
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.deepEqual(await readdir(agentDir), ["models.json"]);
    assert.equal(await readFile(path.join(agentDir, "models.json"), "utf8"), modelConfig);
    const missing = await run(["--env-file", path.join(root, "missing"), "--version"]);
    assert.equal(missing.code, 1);
    assert.match(missing.output, /Cannot read --env-file/);
    const version = await run(["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.output, /^tutor \d+\.\d+\.\d+/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

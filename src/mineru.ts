import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { responseBytes, safeReason, saveCache } from "./ocr.ts";
import type { Input } from "./types.ts";

const execute = promisify(execFile);

async function command(command: string, args: string[]) {
  try {
    return await execute(command, args, { maxBuffer: 1024 * 1024 * 32 });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
    throw new Error(`${path.basename(command)} failed: ${detail}`);
  }
}

async function jsonFetch(url: string, init: RequestInit, stage: string) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(`MinerU ${stage} request failed`);
  }
  let payload: any;
  try {
    payload = JSON.parse((await responseBytes(response, 1024 * 1024)).toString("utf8"));
  } catch {
    throw new Error(`MinerU ${stage} returned an invalid response (HTTP ${response.status})`);
  }
  if (!response.ok || payload.code !== 0) throw new Error(`MinerU ${stage} failed (HTTP ${response.status}): ${safeReason(payload)}`);
  return payload;
}

async function safeUnzip(zip: string, output: string) {
  const details = await command("/usr/bin/unzip", ["-Zl", zip]);
  if (details.stdout.split("\n").some((line) => /^\s*l/.test(line))) throw new Error("MinerU result archive contains a symbolic link");
  const listing = await command("/usr/bin/unzip", ["-Z1", zip]);
  for (const entry of listing.stdout.split("\n")) {
    if (!entry || entry.endsWith("/")) continue;
    if (path.isAbsolute(entry) || entry.includes("\\") || entry.split("/").includes("..")) {
      throw new Error("MinerU result archive contains an unsafe path");
    }
  }
  await mkdir(output, { recursive: true });
  await command("/usr/bin/unzip", ["-q", "-o", zip, "-d", output]);
}

async function failureReason(response: Response) {
  const text = (await responseBytes(response, 64 * 1024)).toString("utf8");
  const xml = text.match(/<Message>([\s\S]*?)<\/Message>/);
  return safeReason(xml ? xml[1] : text);
}

export async function parseWithMinerU(inputs: Input[], baseUrl: string, token: string) {
  const created = await jsonFetch(`${baseUrl}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      files: inputs.map((input) => ({ name: input.name, data_id: input.name })),
      model_version: "vlm",
      enable_formula: true,
      enable_table: true,
    }),
  }, "task creation");

  const urls = created.data.file_urls;
  if (urls?.length !== inputs.length) throw new Error("MinerU did not return one upload URL per file");
  for (const [index, input] of inputs.entries()) {
    let upload: Response;
    try {
      upload = await fetch(urls[index], { method: "PUT", body: await readFile(input.uploadPath), signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new Error(`MinerU upload failed for ${input.name}: request failed or timed out after 120 seconds`);
    }
    if (!upload.ok) throw new Error(`MinerU upload failed for ${input.name} (HTTP ${upload.status}): ${await failureReason(upload)}`);
  }

  const deadline = Date.now() + 10 * 60 * 1000;
  let results;
  do {
    if (Date.now() > deadline) throw new Error("MinerU parsing timed out after 10 minutes");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const status = await jsonFetch(`${baseUrl}/api/v4/extract-results/batch/${created.data.batch_id}`, {
      headers: { authorization: `Bearer ${token}` },
    }, "status polling");
    results = status.data.extract_result ?? [];
  } while (results.length !== inputs.length || results.some((result: any) => ["pending", "waiting-file", "running", "converting"].includes(result.state)));

  for (const input of inputs) {
    const result = results.find((item: any) => item.file_name === input.name || item.data_id === input.name);
    if (!result || result.state !== "done" || !result.full_zip_url) {
      throw new Error(`MinerU parsing failed for ${input.name}: ${safeReason({ message: result?.err_msg })}`);
    }
    let download: Response;
    try {
      download = await fetch(result.full_zip_url, { signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new Error(`MinerU result download failed for ${input.name}: request failed or timed out after 120 seconds`);
    }
    if (!download.ok) throw new Error(`MinerU result download failed for ${input.name} (HTTP ${download.status}): ${await failureReason(download)}`);
    const output = input.parsedDirectory!;
    const zip = `${output}.zip`;
    const partial = `${zip}.download`;
    await mkdir(output, { recursive: true });
    await writeFile(partial, await responseBytes(download, 512 * 1024 * 1024));
    await rename(partial, zip);
    await safeUnzip(zip, output);
    await saveCache(input, "mineru", "vlm", baseUrl);
  }
}

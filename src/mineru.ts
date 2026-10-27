import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createOutput, request, safeReason, safeRelativePath, saveCache } from "./ocr.ts";
import type { Input } from "./types.ts";

const execute = promisify(execFile);

async function command(command: string, args: string[]) {
  try {
    return await execute(command, args, { maxBuffer: 1024 * 1024 * 32, timeout: 120_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
    throw new Error(`${path.basename(command)} failed: ${detail}`);
  }
}

async function jsonFetch(url: string, init: RequestInit, stage: string) {
  const { bytes, status } = await request(url, init, `MinerU ${stage}`, 1024 * 1024, 30_000);
  let payload: any;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`MinerU ${stage} returned an invalid response (HTTP ${status})`);
  }
  if (payload?.code !== 0) throw new Error(`MinerU ${stage} failed (HTTP ${status}): ${safeReason(payload)}`);
  return payload;
}

async function safeUnzip(zip: string, output: string) {
  const details = await command("/usr/bin/unzip", ["-Zl", zip]);
  const records = details.stdout.split("\n").filter((line) => /^[-dlcbps?]/.test(line));
  if (records.some((line) => !/^[-d]/.test(line))) throw new Error("MinerU result archive contains a symbolic link or special file");
  const sizes = records.map((line) => Number(line.trim().split(/\s+/)[3]));
  if (sizes.some((size) => !Number.isSafeInteger(size)) || sizes.reduce((sum, size) => sum + size, 0) > 512 * 1024 * 1024) {
    throw new Error("MinerU result archive exceeds the 512 MiB extraction limit");
  }
  const listing = await command("/usr/bin/unzip", ["-Z1", zip]);
  const paths = listing.stdout.trimEnd().split("\n");
  if (records.length !== paths.length) throw new Error("MinerU result archive has an ambiguous file listing");
  for (const entry of paths) {
    if (!safeRelativePath(entry)) {
      throw new Error("MinerU result archive contains an unsafe path");
    }
  }
  await command("/usr/bin/unzip", ["-q", "-n", zip, "-d", output]);
}

export async function parseWithMinerU(inputs: Input[], baseUrl: string, token: string) {
  const created = await jsonFetch(`${baseUrl}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      files: inputs.map((input, index) => ({ name: input.name, data_id: String(index) })),
      model_version: "vlm",
      enable_formula: true,
      enable_table: true,
    }),
  }, "task creation");

  const urls = created.data?.file_urls;
  const batchId = created.data?.batch_id;
  if (!Array.isArray(urls) || urls.length !== inputs.length || typeof batchId !== "string") throw new Error("MinerU did not return one upload URL per file and a batch ID (HTTP 200)");
  const completed = new Set<number>();
  const failures: string[] = [];
  for (const [index, input] of inputs.entries()) {
    try {
      // Signed uploads require an empty Content-Type and no API Authorization header.
      await request(urls[index], { method: "PUT", body: await readFile(input.uploadPath) }, `MinerU upload for ${input.name}`, 64 * 1024);
    } catch (error) {
      completed.add(index);
      failures.push((error as Error).message);
    }
  }

  const deadline = Date.now() + 10 * 60 * 1000;
  while (completed.size < inputs.length) {
    if (Date.now() > deadline) throw new Error("MinerU parsing timed out after 10 minutes");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const status = await jsonFetch(`${baseUrl}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, {
      headers: { authorization: `Bearer ${token}` },
    }, "status polling");
    const results = status.data?.extract_result;
    if (!Array.isArray(results)) throw new Error("MinerU status polling returned an invalid result list (HTTP 200)");
    for (const [index, input] of inputs.entries()) {
      if (completed.has(index)) continue;
      const result = results.find((item: any) => item.data_id === String(index))
        ?? results.find((item: any) => !item.data_id && item.file_name === input.name);
      if (!result || ["pending", "waiting-file", "running", "converting"].includes(result.state)) continue;
      completed.add(index);
      try {
        if (result.state !== "done" || !result.full_zip_url) {
          throw new Error(`MinerU parsing failed for ${input.name} (HTTP 200): ${safeReason({ message: result.err_msg })}`);
        }
        const { bytes } = await request(result.full_zip_url, {}, `MinerU result download for ${input.name}`, 512 * 1024 * 1024);
        const output = await createOutput(input);
        const zip = `${output}.zip`;
        await writeFile(zip, bytes);
        await safeUnzip(zip, output);
        await saveCache(input, "mineru", "vlm", baseUrl, output);
        await rm(zip, { force: true }).catch(() => {});
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

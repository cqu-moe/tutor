import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
    response = await fetch(url, init);
  } catch {
    throw new Error(`MinerU ${stage} request failed`);
  }
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`MinerU ${stage} returned an invalid response (HTTP ${response.status})`);
  }
  if (!response.ok || payload.code !== 0) throw new Error(`MinerU ${stage} failed (HTTP ${response.status})`);
  return payload;
}

export async function parseWithMinerU(inputs: Input[], baseUrl: string, token: string, courseDir: string) {
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
    const upload = await fetch(urls[index], { method: "PUT", body: await readFile(input.uploadPath) });
    if (!upload.ok) throw new Error(`MinerU upload failed for ${input.name} (HTTP ${upload.status})`);
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
    if (!result || result.state !== "done" || !result.full_zip_url) throw new Error(`MinerU parsing failed for ${input.name}`);
    const zip = path.join(courseDir, "parsed", `${path.parse(input.name).name}.zip`);
    const download = await fetch(result.full_zip_url);
    if (!download.ok) throw new Error(`MinerU result download failed for ${input.name} (HTTP ${download.status})`);
    await writeFile(zip, Buffer.from(await download.arrayBuffer()));
    const output = path.join(courseDir, "parsed", path.parse(input.name).name);
    await mkdir(output, { recursive: true });
    await command("/usr/bin/unzip", ["-q", "-o", zip, "-d", output]);
  }
}

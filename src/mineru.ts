import { ownedCommand as execute } from "./owned-process.ts";
import { readFile, rm, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { createOutput, request, safeReason, safeRelativePath, saveCache } from "./ocr.ts";
import { NeedsAttention, type TeachingCheckpoint } from "./teaching.ts";
import type { Input } from "./types.ts";



async function command(command: string, args: string[]) {
  try {
    return await execute(command, args, { maxBuffer: 1024 * 1024 * 32, timeout: 120_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
    throw new Error(`${path.basename(command)} failed: ${detail}`);
  }
}

async function jsonFetch(url: string, init: RequestInit, stage: string, signal?: AbortSignal) {
  const { bytes, status } = await request(url, init, `MinerU ${stage}`, 1024 * 1024, 30_000, signal);
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

export async function parseWithMinerU(inputs: Input[], baseUrl: string, token: string, recovery?: {
  state: NonNullable<TeachingCheckpoint['ocr']>; save: (state: NonNullable<TeachingCheckpoint['ocr']>) => Promise<void>; signal: AbortSignal; pending?: string[];
}) {
  const state = recovery?.state ?? {};
  const save = async () => { await recovery?.save({ ...state }); };
  const signal = recovery?.signal;
  const missing = new Set(recovery?.pending ?? inputs.map(input => input.parsedDirectory!));
  const completed = new Set<number>();
  const receive = async (index: number) => {
    const input = inputs[index], zip = `${input.parsedDirectory}.received.zip`;
    const output = await createOutput(input);
    await safeUnzip(zip, output);
    await saveCache(input, 'mineru', 'vlm', baseUrl, output);
    await rm(zip, { force: true }); completed.add(index);
  };
  for (const [index, input] of inputs.entries()) {
    if (!missing.has(input.parsedDirectory!)) completed.add(index);
    else if (await Bun.file(`${input.parsedDirectory}.received.zip`).exists()) await receive(index);
  }
  if (completed.size === inputs.length) return;
  if (!token) throw new Error("MINERU_API_TOKEN is required. MinerU's precision API uses a Bearer token.");
  let urls: string[] | undefined;
  if (!state.batchId) {
    if (state.started) throw new NeedsAttention('MinerU batch creation outcome is unknown; no batch ID was received. Inspect external tasks, cancel and explicitly reimport if necessary.', true);
    state.started = true; state.batchIndices = inputs.map((_, index) => index).filter(index => !completed.has(index)); await save();
    const created = await jsonFetch(`${baseUrl}/api/v4/file-urls/batch`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files: state.batchIndices!.map(index => ({ name: inputs[index].name, data_id: String(index) })), model_version: 'vlm', enable_formula: true, enable_table: true }),
    }, 'task creation', signal);
    const batchId = created.data?.batch_id;
    urls = created.data?.file_urls;
    if (!Array.isArray(urls) || urls.length !== state.batchIndices!.length || typeof batchId !== 'string') throw new NeedsAttention('MinerU did not return one upload URL per file and a batch ID (HTTP 200); submission outcome unknown', true);
    state.batchId = batchId; state.uploaded = []; await save();
  }
  if (urls) for (const [slot, index] of state.batchIndices!.entries()) {
    const input = inputs[index];
    state.uploading = index; await save();
    await request(urls[slot], { method: 'PUT', body: await readFile(input.uploadPath) }, `MinerU upload for ${input.name}`, 64 * 1024, 120_000, signal);
    state.uploaded = [...state.uploaded ?? [], index]; delete state.uploading; await save();
  }
  const failures: string[] = [];
  const deadline = Date.now() + 10 * 60 * 1000;
  while (completed.size < inputs.length) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error('MinerU parsing timed out after 10 minutes; retry polling this known batch');
    const status = await jsonFetch(`${baseUrl}/api/v4/extract-results/batch/${encodeURIComponent(state.batchId!)}`, { headers: { authorization: `Bearer ${token}` } }, 'status polling', signal);
    const results = status.data?.extract_result;
    if (!Array.isArray(results)) throw new Error('MinerU status polling returned an invalid result list (HTTP 200)');
    for (const [index, input] of inputs.entries()) {
      if (completed.has(index)) continue;
      const result = results.find((item: any) => item.data_id === String(index)) ?? results.find((item: any) => !item.data_id && item.file_name === input.name);
      if (!result || ['pending', 'waiting-file', 'running', 'converting'].includes(result.state)) {
        if ((!result || ['pending', 'waiting-file'].includes(result.state)) && !state.uploaded?.includes(index)) throw new NeedsAttention(`MinerU batch ${state.batchId}: upload outcome for ${input.name} is unknown or unfinished. Poll identity is retained; no upload is blindly repeated. Inspect the external batch, cancel and explicitly reimport if necessary.`, true);
        continue;
      }
      if (result.state !== 'done' || !result.full_zip_url) {
        failures.push(`MinerU parsing failed for ${input.name} (HTTP 200): ${safeReason({ message: result.err_msg })}`); completed.add(index); continue;
      }
      const zip = `${input.parsedDirectory}.received.zip`;
      await mkdir(path.dirname(zip), { recursive: true });
      if (!await Bun.file(zip).exists()) {
        const { bytes } = await request(result.full_zip_url, {}, `MinerU result download for ${input.name}`, 512 * 1024 * 1024, 120_000, signal);
        await writeFile(`${zip}.tmp`, bytes); await rename(`${zip}.tmp`, zip);
      }
      await receive(index);
    }
    if (failures.length) throw new Error(failures.join("\n"));
    if (completed.size < inputs.length) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2000);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
}

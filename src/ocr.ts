import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Input } from "./types.ts";

export type OcrProvider = "mineru" | "mistral";

export async function hashFile(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export function endpointIdentity(baseUrl: string) {
  return createHash("sha256").update(new URL(baseUrl).href).digest("hex");
}

export function parsedDirectory(courseDir: string, provider: OcrProvider, input: Input, baseUrl: string, model: string) {
  const prefix = input.kind === "pdf-page" ? `page-${input.sourcePage}-` : "screenshot-";
  return path.join(courseDir, "parsed", provider, endpointIdentity(`${baseUrl}/${model}`), `${prefix}${input.contentHash}${path.extname(input.uploadPath).toLowerCase()}`);
}

export async function uncachedInputs(inputs: Input[], courseDir: string, provider: OcrProvider, model: string, baseUrl: string) {
  const expected = {
    version: 1,
    provider,
    model,
    endpoint: endpointIdentity(baseUrl),
  };
  const missing = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    input.parsedDirectory = parsedDirectory(courseDir, provider, input, baseUrl, model);
    if (seen.has(input.parsedDirectory)) continue;
    seen.add(input.parsedDirectory);
    try {
      const cached = JSON.parse(await readFile(path.join(input.parsedDirectory, "cache.json"), "utf8"));
      if (cached.contentHash !== input.contentHash || cached.kind !== input.kind || cached.sourcePage !== input.sourcePage
        || Object.entries(expected).some(([key, value]) => cached[key] !== value)) throw new Error("OCR cache identity changed");
      if (!Array.isArray(cached.files) || !cached.files.length) throw new Error("Incomplete OCR cache");
      for (const file of cached.files) {
        if (!safeRelativePath(file) || !(await lstat(path.join(input.parsedDirectory, file))).isFile()) throw new Error("Missing OCR resource");
      }
      await readOcrResult(input.parsedDirectory);
    } catch {
      missing.push(input);
    }
  }
  return missing;
}

export async function createOutput(input: Input) {
  await mkdir(path.dirname(input.parsedDirectory!), { recursive: true });
  return mkdtemp(`${input.parsedDirectory}-pending-`);
}

export async function readOcrResult(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name === "full.md");
  if (files.length !== 1) throw new Error("OCR result must contain one full.md");
  const file = files[0];
  const markdown = await readFile(path.join(file.parentPath, file.name), "utf8");
  if (!markdown.trim()) throw new Error("OCR result contained empty Markdown");
  return { markdown, parsedDirectory: file.parentPath };
}

export async function saveCache(input: Input, provider: OcrProvider, model: string, baseUrl: string, output: string) {
  if (!input.parsedDirectory) throw new Error("OCR output directory was not prepared");
  await readOcrResult(output);
  const entries = await readdir(output, { recursive: true, withFileTypes: true });
  const marker = {
    version: 1,
    provider,
    model,
    endpoint: endpointIdentity(baseUrl),
    contentHash: input.contentHash,
    kind: input.kind,
    sourcePage: input.sourcePage,
    files: entries.filter((entry) => entry.isFile() && entry.name !== "cache.json")
      .map((entry) => path.relative(output, path.join(entry.parentPath, entry.name))),
  };
  await writeFile(path.join(output, "cache.json"), `${JSON.stringify(marker, null, 2)}\n`);
  try {
    await rename(input.parsedDirectory, `${input.parsedDirectory}-previous-${randomUUID()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(output, input.parsedDirectory);
}

const controlCharacters = /[\u0000-\u001f\u007f]/g;

export function safeReason(payload: any) {
  const value = payload && typeof payload === "object" ? payload.msg ?? payload.message ?? payload.detail ?? payload.error?.message : payload;
  if (typeof value !== "string" || !value.trim()) return "unspecified API reason";
  let safe = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret && /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY_ID)$/i.test(key)) {
      safe = safe.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
    }
  }
  return safe.trim().replace(controlCharacters, " ").replace(/https?:\/\/\S+/g, "[url redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
}

export function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && !!value && !/^[a-z]:|^[\\/]|[\\\x00-\x1f\x7f]/i.test(value) && !value.split("/").includes("..");
}

export async function responseBytes(response: Response, limitBytes: number) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limitBytes) {
    await response.body?.cancel();
    throw new Error(`response exceeds ${limitBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${limitBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function request(url: string, init: RequestInit, stage: string, limit: number, timeout = 120_000) {
  let response: Response | undefined;
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))) {
      throw new Error("use HTTPS (HTTP is allowed only on loopback)");
    }
    response = await fetch(target, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
    const bytes = await responseBytes(response, response.ok ? limit : 64 * 1024);
    if (!response.ok) {
      let reason: unknown;
      const text = bytes.toString("utf8");
      try { reason = JSON.parse(text); } catch {
        const code = text.match(/<Code>([^<]*)<\/Code>/)?.[1];
        const message = text.match(/<Message>([^<]*)<\/Message>/)?.[1];
        reason = code || message ? `${code ?? ""}: ${message ?? ""}` : text;
      }
      throw new Error(safeReason(reason));
    }
    return { bytes, status: response.status };
  } catch (error) {
    const detail = response ? safeReason(error instanceof Error ? error.message : "response failed") : `request failed, redirected, or timed out (limit ${timeout / 1000}s)`;
    throw new Error(`${stage} failed${response ? ` (HTTP ${response.status})` : ""}: ${detail}`);
  }
}

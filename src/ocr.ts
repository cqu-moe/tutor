import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  return path.join(courseDir, "parsed", provider, endpointIdentity(`${baseUrl}/${model}`), `${prefix}${input.contentHash}`);
}

export async function uncachedInputs(inputs: Input[], courseDir: string, provider: OcrProvider, model: string, baseUrl: string) {
  const expected = {
    version: 1,
    provider,
    model,
    endpoint: endpointIdentity(baseUrl),
  };
  const missing = [];
  for (const input of inputs) {
    input.parsedDirectory = parsedDirectory(courseDir, provider, input, baseUrl, model);
    try {
      const cached = JSON.parse(await readFile(path.join(input.parsedDirectory, "cache.json"), "utf8"));
      if (cached.contentHash !== input.contentHash || cached.kind !== input.kind || cached.sourcePage !== input.sourcePage
        || Object.entries(expected).some(([key, value]) => cached[key] !== value)) throw new Error("OCR cache identity changed");
      await readFile(path.join(input.parsedDirectory, "full.md"));
    } catch {
      missing.push(input);
    }
  }
  return missing;
}

export async function saveCache(input: Input, provider: OcrProvider, model: string, baseUrl: string) {
  if (!input.parsedDirectory) throw new Error("OCR output directory was not prepared");
  await mkdir(input.parsedDirectory, { recursive: true });
  const marker = {
    version: 1,
    provider,
    model,
    endpoint: endpointIdentity(baseUrl),
    contentHash: input.contentHash,
    kind: input.kind,
    sourcePage: input.sourcePage,
  };
  await writeFile(path.join(input.parsedDirectory, "cache.json"), `${JSON.stringify(marker, null, 2)}\n`);
}

const controlCharacters = /[\u0000-\u001f\u007f]/g;

export function safeReason(payload: any) {
  const value = payload && typeof payload === "object" ? payload.msg ?? payload.message ?? payload.detail : payload;
  if (typeof value !== "string" || !value.trim()) return "unspecified API reason";
  return value.trim().replace(controlCharacters, " ").replace(/https?:\/\/\S+/g, "[url redacted]").slice(0, 300);
}

export async function responseBytes(response: Response, limitBytes: number) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limitBytes) throw new Error(`response exceeds ${limitBytes} bytes`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) throw new Error(`response exceeds ${limitBytes} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

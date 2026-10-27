import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { responseBytes, safeReason, saveCache } from "./ocr.ts";
import type { Input } from "./types.ts";

const mimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
]);

export async function parseWithMistral(inputs: Input[], baseUrl: string, apiKey: string) {
  for (const input of inputs) {
    const extension = path.extname(input.uploadPath).toLowerCase();
    const mimeType = mimeTypes.get(extension);
    if (!mimeType) throw new Error(`Mistral OCR cannot read ${input.name}`);
    const bytes = await readFile(input.uploadPath);
    const document = extension === ".pdf"
      ? { type: "document_url", document_url: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}` }
      : { type: "image_url", image_url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` };
    let response: Response;
    try {
      response = await fetch(new URL("/v1/ocr", baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "mistral-ocr-latest", document, include_image_base64: true }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new Error("Mistral OCR request failed or timed out after 120 seconds");
    }
    const raw = await responseBytes(response, 100 * 1024 * 1024);
    let payload: any;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error(`Mistral OCR returned an invalid response (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`Mistral OCR failed (HTTP ${response.status}): ${safeReason(payload)}`);
    const page = payload.pages?.[0];
    if (payload.pages?.length !== 1 || page?.index !== 0 || typeof page?.markdown !== "string" || !page.markdown.trim()) {
      throw new Error(`Mistral OCR returned an incomplete result for ${input.name} (HTTP ${response.status})`);
    }

    const output = input.parsedDirectory!;
    await mkdir(output, { recursive: true });
    for (const image of page.images ?? []) {
      const name = path.basename(String(image.id ?? ""));
      const encoded = String(image.image_base64 ?? "").replace(/^data:[^,]+,/, "");
      if (!name || name.includes("/") || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw new Error(`Mistral OCR returned an unsafe image resource for ${input.name}`);
      }
      await writeFile(path.join(output, name), Buffer.from(encoded, "base64"));
    }
    await writeFile(path.join(output, "response.json"), `${JSON.stringify(payload, null, 2)}\n`);
    await writeFile(path.join(output, "full.md"), `${page.markdown}\n`);
    await saveCache(input, "mistral", "mistral-ocr-latest", baseUrl);
  }
}

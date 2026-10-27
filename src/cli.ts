#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { hashFile, readOcrResult, uncachedInputs, type OcrProvider } from "./ocr.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { exportLecture } from "./export.ts";
import { generateLecture } from "./lecture.ts";
import { parseWithMinerU } from "./mineru.ts";
import { parseWithMistral } from "./mistral.ts";
import { proposeRoute } from "./model.ts";
import { createTutorSession } from "./runtime.ts";
import { promptWithMemory } from "./memory.ts";
import type { Context, Input } from "./types.ts";

const execute = promisify(execFile);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function parsePages(value: string | undefined): number[] {
  if (!value) throw new Error("--pages is required for a PDF (for example: 21-24 or 21,23-24)");
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !part)) throw new Error("--pages must contain positive one-based page numbers");

  let count = 0;
  for (const part of parts) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (!range) {
      if (!/^\d+$/.test(part)) throw new Error("--pages must contain positive one-based page numbers");
      count += 1;
      continue;
    }
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (!start || !end || start > end) throw new Error("--pages must contain positive one-based page numbers");
    count += end - start + 1;
  }
  if (!count || count > 50) {
    throw new Error(count > 50 ? "Select at most 50 pages per teaching task" : "--pages must contain positive one-based page numbers");
  }

  const pages = parts.flatMap((part) => {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (!range) return [Number(part)];
    const start = Number(range[1]);
    const end = Number(range[2]);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
  if (pages.some((page) => !Number.isInteger(page) || page < 1)) {
    throw new Error("--pages must contain positive one-based page numbers");
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

async function command(command: string, args: string[]) {
  try {
    return await execute(command, args, { maxBuffer: 1024 * 1024 * 32 });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
    throw new Error(`${path.basename(command)} failed: ${detail}`);
  }
}

async function courseDirectory(course: string, dataDir: string) {
  const slug = course.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("--course must contain a course name");
  return path.resolve(dataDir, slug);
}

async function prepareMaterials(pdf: string, pages: number[], screenshots: string[], courseDir: string) {
  await mkdir(path.join(courseDir, "original-pages"), { recursive: true });
  await mkdir(path.join(courseDir, "parsed"), { recursive: true });
  await mkdir(path.join(courseDir, "source"), { recursive: true });
  const sourceHash = await hashFile(pdf);
  const sourceCopy = path.join(courseDir, "source", `${path.parse(pdf).name}-${sourceHash}.pdf`);
  try {
    await readFile(sourceCopy);
  } catch {
    await copyFile(pdf, sourceCopy);
  }

  const inputs: Input[] = [];
  for (const page of pages) {
    const stem = `page-${String(page).padStart(4, "0")}`;
    const contentHash = sourceHash;
    const name = `${stem}-${contentHash}.pdf`;
    const pagePdf = path.join(courseDir, "original-pages", name);
    const image = `${stem}-${contentHash}.png`;
    try {
      await access(pagePdf);
      await access(path.join(courseDir, "original-pages", image));
    } catch {
      const temporary = path.join(courseDir, "original-pages", `${stem}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await command("pdfseparate", ["-f", String(page), "-l", String(page), sourceCopy, `${temporary}.pdf`]);
      await command("pdftoppm", ["-png", "-r", "150", "-singlefile", `${temporary}.pdf`, temporary]);
      await rename(`${temporary}.pdf`, pagePdf);
      await rename(`${temporary}.png`, path.join(courseDir, "original-pages", image));
    }
    const input: Input = { name: `${stem}.pdf`, uploadPath: pagePdf, kind: "pdf-page", sourcePage: page, image, contentHash };
    inputs.push(input);
  }

  for (const screenshot of screenshots) {
    const contentHash = await hashFile(screenshot);
    const name = path.basename(screenshot);
    const copied = path.join(courseDir, "source", `screenshot-${contentHash}${path.extname(screenshot)}`);
    try {
      await readFile(copied);
    } catch {
      await copyFile(screenshot, copied);
    }
    const input: Input = { name, uploadPath: copied, kind: "screenshot", contentHash };
    inputs.push(input);
  }
  return inputs;
}

async function buildContext(course: string, inputs: Input[], courseDir: string): Promise<Context> {
  const context: Context = { course, pages: [], screenshots: [], confirmedAt: null };
  for (const input of inputs) {
    const { markdown, parsedDirectory } = await readOcrResult(input.parsedDirectory!);
    if (input.kind === "pdf-page") {
      context.pages.push({
        sourcePage: input.sourcePage!,
        pagePdf: input.uploadPath,
        originalPageImage: path.join(courseDir, "original-pages", input.image!),
        parsedDirectory,
        markdown,
      });
    } else {
      context.screenshots.push({ name: input.name, source: input.uploadPath, parsedDirectory, markdown });
    }
  }
  await writeFile(path.join(courseDir, "context.json"), JSON.stringify(context, null, 2));
  return context;
}

let agentDirForDiagnostics: string | undefined;

function addConfiguredSecret(secrets: string[], value: unknown) {
  if (typeof value !== "string" || !value || value.startsWith("$!") || value.startsWith("$$")) return;
  if (value.startsWith("$")) {
    for (const [, braced, plain] of value.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const secret = process.env[braced ?? plain];
      if (secret) secrets.push(secret);
    }
    return;
  }
  secrets.push(value);
}

function collectSecrets(value: unknown, secrets: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, secrets);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (["apiKey", "key", "token", "access", "refresh", "accessToken", "refreshToken", "authorization"].includes(key)) {
      addConfiguredSecret(secrets, item);
    }
    if (key === "headers" && typeof item === "object" && item !== null) {
      for (const header of Object.values(item)) addConfiguredSecret(secrets, header);
    }
    if (key === "env" && typeof item === "object" && item !== null) {
      for (const secret of Object.values(item)) if (typeof secret === "string") secrets.push(secret);
    }
    collectSecrets(item, secrets);
  }
}

async function redactedMessage(raw: string, agentDir: string | undefined) {
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(name) && value)
    .map(([, value]) => value!);
  for (const file of ["models.json", "auth.json"]) {
    try {
      collectSecrets(JSON.parse(await readFile(path.join(agentDir ?? "", file), "utf8")), secrets);
    } catch {
      // Missing or invalid model configuration must not hide the original error.
    }
  }
  return secrets.reduce((message, secret) => message.split(secret).join("[redacted]"), raw);
}

async function main() {
  const { values } = parseArgs({
    options: {
      course: { type: "string" },
      pdf: { type: "string" },
      pages: { type: "string" },
      screenshots: { type: "string", multiple: true },
      "data-dir": { type: "string", default: ".tutor" },
      "agent-dir": { type: "string" },
      model: { type: "string" },
      memory: { type: "string" },
      generate: { type: "boolean" },
      ocr: { type: "string", default: "mineru" },
      "mineru-base-url": { type: "string", default: "https://mineru.net" },
      "mistral-base-url": { type: "string", default: "https://api.mistral.ai" },
    },
  });
  agentDirForDiagnostics = values["agent-dir"] ?? getAgentDir();
  if (!values.course) throw new Error("--course is required");
  const courseDir = await courseDirectory(values.course, values["data-dir"]!);
  if (values.memory !== undefined) {
    if (!values.memory.trim()) throw new Error("--memory requires a learner-memory request");
    await mkdir(courseDir, { recursive: true });
    const session = await createTutorSession(courseDir, values["agent-dir"], values.model, { tools: [] });
    try {
      console.log(await promptWithMemory(session, `Course: ${values.course}\nLearner memory request: ${values.memory}`));
    } finally {
      session.dispose();
    }
    return;
  }
  if (values.generate) {
    if (values.pdf || values.pages || values.screenshots) throw new Error("--generate uses the saved confirmed materials; omit new input options");
    const context: Context = JSON.parse(await readFile(path.join(courseDir, "context.json"), "utf8"));
    await deliverLecture(context, courseDir, values["agent-dir"], values.model);
    return;
  }
  if (!values.pdf) throw new Error("--pdf is required");
  if (!values.pages) throw new Error("--pages is required");
  const pages = parsePages(values.pages);
  const provider = values.ocr as OcrProvider;
  if (provider !== "mineru" && provider !== "mistral") throw new Error("--ocr must be mineru or mistral");
  if (pages.length > 50) throw new Error("Select at most 50 pages per teaching task");

  const pdf = path.resolve(values.pdf);
  const screenshots = (values.screenshots ?? []).map((file) => path.resolve(file));
  if (!pdf.toLowerCase().endsWith(".pdf")) throw new Error("--pdf must point to a PDF file");
  for (const screenshot of screenshots) {
    if (!imageExtensions.has(path.extname(screenshot).toLowerCase())) throw new Error(`Unsupported screenshot type: ${path.basename(screenshot)}`);
  }
  const mineruBaseUrl = values["mineru-base-url"]!.replace(/\/$/, "");
  const mistralBaseUrl = values["mistral-base-url"]!.replace(/\/$/, "");
  const inputs = await prepareMaterials(pdf, pages, screenshots, courseDir);
  const pending = await uncachedInputs(
    inputs,
    courseDir,
    provider,
    provider === "mineru" ? "vlm" : "mistral-ocr-latest",
    provider === "mineru" ? mineruBaseUrl : mistralBaseUrl,
  );
  if (pending.length) {
    if (provider === "mineru") {
      const token = process.env.MINERU_API_TOKEN;
      if (!token) throw new Error("MINERU_API_TOKEN is required. MinerU's precision API uses a Bearer token.");
      await parseWithMinerU(pending, mineruBaseUrl, token);
    } else {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) throw new Error("MISTRAL_API_KEY is required for Mistral OCR.");
      await parseWithMistral(pending, mistralBaseUrl, apiKey);
    }
  }
  const context = await buildContext(values.course, inputs, courseDir);
  await proposeRoute(context, courseDir, values["agent-dir"], values.model);
  if (context.confirmedAt) {
    await deliverLecture(context, courseDir, values["agent-dir"], values.model);
  }
}

async function deliverLecture(context: Context, courseDir: string, agentDir: string | undefined, model: string | undefined) {
  const source = await generateLecture(context, courseDir, agentDir, model);
  const output = await exportLecture(courseDir, source);
  await rm(path.dirname(source), { recursive: true, force: true }).catch(() => {
    console.warn(`Export succeeded; generation draft remains at ${source}`);
  });
  console.log(`Lecture exported: ${output} (content.md, typst/document.typ, document.pdf, media/)`);
}

try {
  await main();
} catch (error) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = await redactedMessage(raw, agentDirForDiagnostics);
  console.error(`tutor: ${message}`);
  process.exitCode = 1;
}

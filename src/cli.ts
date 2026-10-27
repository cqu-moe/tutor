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
import { createTerminalInput, proposeRoute } from "./model.ts";
import { createTutorSession } from "./runtime.ts";
import { promptWithMemory } from "./memory.ts";
import { reviseLecture } from "./revision.ts";
import { readDraft, readPublishedLecture, saveDraft, type Lecture } from "./lecture-state.ts";
import type { ChapterSelection, Context, Input } from "./types.ts";

const execute = promisify(execFile);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

type PdfChapter = { title: string; page: number; level: number };

function normalizedText(value: string) {
  return value.trim().normalize("NFC");
}

function pageNumber(value: string) {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parsePages(value: string | undefined, pageCount: number): number[] {
  if (!value) throw new Error("--pages is required for a PDF (for example: 21-24 or 21,23-24)");
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !part)) throw new Error("--pages must contain positive one-based page numbers");

  const ranges: Array<[number, number]> = [];
  for (const part of parts) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (!range) {
      const page = pageNumber(part);
      if (!page) throw new Error("--pages must contain positive one-based page numbers");
      ranges.push([page, page]);
      continue;
    }
    const start = pageNumber(range[1]!);
    const end = pageNumber(range[2]!);
    if (!start || !end || start > end) throw new Error("--pages must contain positive one-based page numbers");
    ranges.push([start, end]);
  }
  if (ranges.some(([, end]) => end > pageCount)) {
    throw new Error(`--pages selects beyond the PDF, which has ${pageCount} pages`);
  }

  const pages = ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, index) => start + index));
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

async function pdfPageCount(pdf: string) {
  const info = (await command("pdfinfo", [pdf])).stdout;
  const pages = Number(info.match(/^Pages:\s+(\d+)$/m)?.[1]);
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error("pdfinfo did not report a valid PDF page count");
  return pages;
}

async function selectChapter(value: string | undefined, pdf: string, pageCount: number) {
  if (!value?.trim()) throw new Error("--chapter requires a bookmark title; use --pages for an explicit range");
  const helper = path.resolve(import.meta.dirname, "../scripts/pdf_chapters.py");
  const chapters: PdfChapter[] = JSON.parse((await command(process.env.TUTOR_PYTHON ?? "python3", [helper, pdf])).stdout);
  if (!chapters.length) throw new Error("This PDF has no bookmarks; use --pages instead");
  if (chapters.some((chapter) => !Number.isSafeInteger(chapter.page) || chapter.page < 1 || chapter.page > pageCount || !Number.isSafeInteger(chapter.level) || chapter.level < 1)) {
    throw new Error("PDF contains an invalid bookmark; use --pages instead");
  }
  const requested = normalizedText(value);
  const matches = chapters.filter((chapter) => normalizedText(chapter.title) === requested);
  if (!matches.length) throw new Error(`No PDF bookmark exactly matches ${JSON.stringify(value.trim())}; use --pages or an exact bookmark title`);
  if (matches.length > 1) {
    const locations = matches.map((chapter) => `"${chapter.title}" on page ${chapter.page}`).join(", ");
    throw new Error(`PDF bookmark title is ambiguous: ${locations}; use --pages instead`);
  }
  const selected = matches[0]!;
  const next = chapters.slice(chapters.indexOf(selected) + 1).find((chapter) => chapter.level <= selected.level);
  const endPage = next?.page ?? pageCount;
  if (endPage < selected.page) throw new Error("PDF bookmark order is invalid; use --pages instead");
  const selection: ChapterSelection = {
    type: "chapter",
    title: selected.title,
    startHeading: selected.title,
    startPage: selected.page,
    endHeading: next?.title ?? null,
    endPage,
  };
  return { selection, pages: Array.from({ length: endPage - selected.page + 1 }, (_, index) => selected.page + index) };
}

async function courseDirectory(course: string, dataDir: string) {
  const slug = course.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("--course must contain a course name");
  return path.resolve(dataDir, slug);
}

async function claimCourseDirectory(course: string, courseDir: string) {
  const marker = path.join(courseDir, ".course-name");
  const rejectCollision = (owner: string) => {
    throw new Error(`Course directory "${path.basename(courseDir)}" already belongs to ${JSON.stringify(owner)}; use the existing course name or a different --data-dir`);
  };
  try {
    const saved = await readFile(marker, "utf8");
    if (normalizedText(saved) !== course) rejectCollision(saved.trim());
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let existed = true;
  try {
    await access(courseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
  }
  await mkdir(courseDir, { recursive: true });
  let owner: string | undefined;
  try {
    let context: Context;
    try {
      context = JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8")).context;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      context = JSON.parse(await readFile(path.join(courseDir, "context.json"), "utf8"));
    }
    owner = normalizedText(context.course ?? "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (owner && owner !== course) rejectCollision(owner);
  if (!owner && existed) {
    throw new Error(
      `Cannot determine the course name for directory "${path.basename(courseDir)}"; move it aside, create .course-name containing the exact original course name, or use a different --data-dir`,
    );
  }
  try {
    await writeFile(marker, `${course}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = await readFile(marker, "utf8");
    if (normalizedText(saved) !== course) rejectCollision(saved.trim());
  }
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

async function buildContext(course: string, inputs: Input[], courseDir: string, selection?: Context["selection"]): Promise<Context> {
  const context: Context = { course, selection, pages: [], screenshots: [], confirmedAt: null };
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
      chapter: { type: "string" },
      screenshots: { type: "string", multiple: true },
      "data-dir": { type: "string", default: ".tutor" },
      "agent-dir": { type: "string" },
      model: { type: "string" },
      memory: { type: "string" },
      generate: { type: "boolean" },
      revise: { type: "string" },
      ocr: { type: "string", default: "mineru" },
      "mineru-base-url": { type: "string", default: "https://mineru.net" },
      "mistral-base-url": { type: "string", default: "https://api.mistral.ai" },
    },
  });
  agentDirForDiagnostics = values["agent-dir"] ?? getAgentDir();
  if (!values.course) throw new Error("--course is required");
  const course = normalizedText(values.course);
  const courseDir = await courseDirectory(course, values["data-dir"]!);
  if (values.revise) {
    if (values.generate || values.memory !== undefined || values.pdf || values.pages || values.chapter || values.screenshots) {
      throw new Error("--revise uses the saved confirmed lecture; omit import, --generate, and --memory options");
    }
    await claimCourseDirectory(course, courseDir);
    await deliverRevision(courseDir, values["agent-dir"], values.model, values.revise);
    return;
  }
  if (values.memory !== undefined) {
    if (!values.memory.trim()) throw new Error("--memory requires a learner-memory request");
    await claimCourseDirectory(course, courseDir);
    const session = await createTutorSession(courseDir, values["agent-dir"], values.model, { tools: [] });
    try {
      console.log(await promptWithMemory(session, `Course: ${course}\nLearner memory request: ${values.memory}`));
    } finally {
      session.dispose();
    }
    return;
  }
  if (values.generate) {
    if (values.pdf || values.pages || values.chapter || values.screenshots) throw new Error("--generate uses the saved confirmed materials; omit new input options");
    await claimCourseDirectory(course, courseDir);
    await deliverLecture(await readDraft(courseDir), courseDir, values["agent-dir"], values.model);
    return;
  }
  if (!values.pdf) throw new Error("--pdf is required");
  if (values.pages && values.chapter) throw new Error("--pages and --chapter are mutually exclusive");
  if (!values.pages && !values.chapter) throw new Error("--pages or --chapter is required");
  const provider = values.ocr as OcrProvider;
  if (provider !== "mineru" && provider !== "mistral") throw new Error("--ocr must be mineru or mistral");

  const pdf = path.resolve(values.pdf);
  const screenshots = (values.screenshots ?? []).map((file) => path.resolve(file));
  if (!pdf.toLowerCase().endsWith(".pdf")) throw new Error("--pdf must point to a PDF file");
  for (const screenshot of screenshots) {
    if (!imageExtensions.has(path.extname(screenshot).toLowerCase())) throw new Error(`Unsupported screenshot type: ${path.basename(screenshot)}`);
  }
  const pageCount = await pdfPageCount(pdf);
  const chapter = values.chapter ? await selectChapter(values.chapter, pdf, pageCount) : undefined;
  const pages = chapter ? chapter.pages : parsePages(values.pages, pageCount);
  await claimCourseDirectory(course, courseDir);
  await readPublishedLecture(courseDir);
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
  const context = await buildContext(course, inputs, courseDir, chapter?.selection);
  const lecture: Lecture = { context, route: "" };
  await saveDraft(courseDir, lecture);
  const input = createTerminalInput();
  try {
    await proposeRoute(lecture, courseDir, values["agent-dir"], values.model, input);
    if (!context.confirmedAt) return;
    await deliverLecture(lecture, courseDir, values["agent-dir"], values.model);
    process.stdout.write("\nType revision feedback, or type 'done' to finish.\n> ");
    for (;;) {
      const line = await input.nextLine();
      if (line === undefined || line.trim().toLowerCase() === "done") break;
      if (!line.trim()) continue;
      await deliverRevision(courseDir, values["agent-dir"], values.model, line);
      process.stdout.write("\nType revision feedback, or type 'done' to finish.\n> ");
    }
  } finally {
    input.close();
  }
}

async function deliverLecture(lecture: Lecture, courseDir: string, agentDir: string | undefined, model: string | undefined) {
  const source = await generateLecture(lecture, courseDir, agentDir, model);
  const output = await exportLecture(courseDir, source, lecture);
  await rm(path.dirname(source), { recursive: true, force: true }).catch(() => {
    console.warn(`Export succeeded; generation draft remains at ${source}`);
  });
  console.log(`Lecture exported: ${output} (content.md, typst/document.typ, document.pdf, media/)`);
}

async function deliverRevision(courseDir: string, agentDir: string | undefined, model: string | undefined, feedback: string) {
  const lecture = await readPublishedLecture(courseDir);
  if (!lecture) throw new Error("Generate and export a lecture before revising it");
  const source = await reviseLecture(lecture, courseDir, agentDir, model, feedback);
  const output = await exportLecture(courseDir, source, lecture);
  await rm(path.dirname(source), { recursive: true, force: true }).catch(() => {
    console.warn(`Revision exported; draft remains at ${source}`);
  });
  console.log(`Lecture revised: ${output} (content.md, typst/document.typ, document.pdf, media/)`);
}

try {
  await main();
} catch (error) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = await redactedMessage(raw, agentDirForDiagnostics);
  console.error(`tutor: ${message}`);
  process.exitCode = 1;
}

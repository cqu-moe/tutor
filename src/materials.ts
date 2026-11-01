import { ownedCommand as execute } from "./owned-process.ts";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { hashFile, readOcrResult } from "./ocr.ts";
import type { CourseChapter, CourseChapterSource } from "./course-state.ts";
import type { ChapterSelection, Context, Input } from "./types.ts";
import pdfChapters from "../scripts/pdf_chapters.py" with { type: "text" };

type PdfChapter = { title: string; page: number; level: number };
export function normalizedText(value: string) {
  return value.trim().normalize("NFC");
}

function pageNumber(value: string) {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function parsePages(value: string | undefined, pageCount: number): number[] {
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

export async function pdfPageCount(pdf: string) {
  const info = (await command("pdfinfo", [pdf])).stdout;
  const pages = Number(info.match(/^Pages:\s+(\d+)$/m)?.[1]);
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error("pdfinfo did not report a valid PDF page count");
  return pages;
}

export async function selectChapter(value: string | undefined, pdf: string, pageCount: number) {
  if (!value?.trim()) throw new Error("--chapter requires a bookmark title; use --pages for an explicit range");
  const chapters: PdfChapter[] = JSON.parse((await command(process.env.TUTOR_PYTHON ?? "python3", ["-c", pdfChapters, pdf])).stdout);
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

function chapterFromBookmark(bookmark: PdfChapter, next: PdfChapter | undefined, pageCount: number, materialId: string, materialVersion: string, needsConfirmation: boolean): Omit<CourseChapter, "version" | "status" | "order" | "progressUpdatedAt" | "lecture"> {
  const endPage = next?.page ?? pageCount;
  const source: CourseChapterSource = {
    materialId,
    materialVersion,
    startPage: bookmark.page,
    endPage,
    startHeading: bookmark.title,
    endHeading: next?.title ?? null,
  };
  return { id: randomUUID(), title: bookmark.title, order: 0, source, needsConfirmation };
}

export async function chapterAdmissions(pdf: string, pageCount: number, pages: number[], materialVersion: string, selection?: ChapterSelection) {
  const materialId = randomUUID();
  if (selection) {
    return [{
      id: randomUUID(),
      title: selection.title,
      order: 0,
      source: {
        materialId,
        materialVersion,
        startPage: selection.startPage,
        endPage: selection.endPage,
        startHeading: selection.startHeading,
        endHeading: selection.endHeading,
      },
      needsConfirmation: false,
    }];
  }

  const chapters: PdfChapter[] = JSON.parse((await command(process.env.TUTOR_PYTHON ?? "python3", ["-c", pdfChapters, pdf])).stdout);
  const selectedPages = new Set(pages);
  const matches = chapters.filter((chapter) => selectedPages.has(chapter.page));
  if (!matches.length) {
    return [{
      id: randomUUID(),
      title: "未命名资料",
      order: 0,
      source: {
        materialId,
        materialVersion,
        startPage: pages[0],
        endPage: pages.at(-1),
        startHeading: undefined,
        endHeading: null,
      },
      needsConfirmation: true,
    }];
  }
  const titleCounts = new Map<string, number>();
  for (const chapter of matches) {
    const title = normalizedText(chapter.title);
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return matches.map((chapter) => {
    const next = chapters.slice(chapters.indexOf(chapter) + 1).find((entry) => entry.level <= chapter.level);
    return chapterFromBookmark(
      chapter,
      next,
      pageCount,
      materialId,
      materialVersion,
      (titleCounts.get(normalizedText(chapter.title)) ?? 1) > 1,
    );
  });
}

export async function prepareMaterials(pdf: string, pages: number[], screenshots: string[], courseDir: string) {
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

export async function buildContext(course: string, inputs: Input[], courseDir: string, selection?: Context["selection"]): Promise<Context> {
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

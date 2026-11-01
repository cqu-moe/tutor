import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NeedsAttention } from "./teaching.ts";
import { teachingPrompt, type TeachingModel } from "./teaching-model.ts";
import { selectionScope } from "./selection.ts";
import { imageContent } from "./runtime.ts";
import type { Lecture } from "./lecture-state.ts";

async function validateLegacyPointer(courseDir: string) {
  try {
    const state = JSON.parse(await readFile(path.join(courseDir, "revision-session.json"), "utf8"));
    if (typeof state.sessionFile !== "string" || !state.sessionFile || path.isAbsolute(state.sessionFile)) throw new Error("sessionFile must be a relative path inside .sessions");
    const relative = path.relative(path.join(courseDir, ".sessions"), path.resolve(courseDir, ".sessions", state.sessionFile));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("sessionFile must stay inside .sessions");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Retain valid legacy files, but never reopen their unscoped tool transcript.
}

function occurrences(value: string, pattern: RegExp) {
  const counts = new Map<string, number>();
  for (const match of value.matchAll(pattern)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  return counts;
}

function headingSequence(value: string) {
  return [...value.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((match) => match[1]);
}

function preservesOriginal(original: string, revised: string) {
  const checks: Array<[name: string, pattern: RegExp]> = [
    ["section headings", /^#{1,6}\s+(.+?)\s*#*$/gm],
    ["media references", /!\[[^\]]*\]\((media\/[^)\s]+)\)/g],
    ["source citations", /((?:PDF page|Screenshot)[^\n.!;]*|PDF\s*第\s*\d+(?:\s*[-–—,，、]+\s*\d+)*\s*页)/gi],
  ];
  if (JSON.stringify(headingSequence(original)) !== JSON.stringify(headingSequence(revised))) {
    return "revision would change teaching route order; confirm a new teaching route first";
  }
  for (const [name, pattern] of checks) {
    const expected = occurrences(original, pattern);
    const actual = occurrences(revised, pattern);
    for (const [value, count] of expected) {
      if ((actual.get(value) ?? 0) < count) {
        return `revision would remove ${name}: ${value}`;
      }
    }
  }
  return undefined;
}

export async function reviseLecture(
  { context, route }: Lecture,
  courseDir: string,
  agentDir: string | undefined,
  model: string | undefined,
  feedback: string,
  job: TeachingModel,
  outputDirectory = "output",
) {
  if (!feedback.trim()) throw new Error("--revise requires learning feedback");
  if (!context.confirmedAt || !Number.isFinite(Date.parse(context.confirmedAt))) {
    throw new Error("Confirm the teaching route before revising the lecture");
  }
  const output = path.join(courseDir, outputDirectory, "content.md");
  let original: string;
  try {
    original = await readFile(job.original!, "utf8");
  } catch {
    throw new Error("Generate and export a lecture before revising it");
  }
  if (!original.trim()) throw new Error("The existing lecture is empty; regenerate it before revising");

  await validateLegacyPointer(courseDir);
  const stage = job.stage;
  await mkdir(stage, { recursive: true });
  const source = path.join(stage, "content.md");
  try {
    const images = await Promise.all([
      ...context.pages.map((page) => imageContent(page.originalPageImage)),
      ...context.screenshots.map((screenshot) => imageContent(screenshot.source)),
    ]);
    const relativeSource = path.relative(courseDir, source).split(path.sep).join("/");
    const sources = [
      ...context.pages.map((page) => `PDF page ${page.sourcePage}\n${page.markdown}`),
      ...context.screenshots.map((screenshot) => `Screenshot ${screenshot.name}\n${screenshot.markdown}`),
    ].join("\n\n");
    console.log("Revising lecture with targeted edits...");
    await teachingPrompt({ courseDir, agentDir, model, stage, key: job.requestId, retryBlocked: job.retryBlocked, signal: job.signal, feedback, systemPrompt: "Revise an existing lecture with the smallest precise edit. Do not rewrite untouched sections, headings, media references, citations, or formula conditions. Never infer learning progress from a revision.", toolNames: ["edit"], prompt: `Edit exactly ${relativeSource} with the edit tool. Keep every unchanged section byte-for-byte where practical. Return only a brief completion statement; do not print the lecture.\n${selectionScope(context.selection)}\nConfirmed route:\n${route}\n\nReusable parsed sources:\n${sources}\n\nLearner feedback: ${feedback}\n\nThe attached original pages/screenshots are for verification only.`, images });
    const revised = await readFile(source, "utf8");
    if (revised === original) {
      throw new Error("the model did not change the staged lecture");
    }
    const preserved = preservesOriginal(original, revised);
    if (preserved) throw new Error(preserved);
    return source;
  } catch (error) {
    const message = `Lecture revision failed; draft/assets retained in ${stage}: ${error instanceof Error ? error.message : String(error)}`;
    throw error instanceof NeedsAttention ? new NeedsAttention(message, error.unsafe) : new Error(message);
  }
}

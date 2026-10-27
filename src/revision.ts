import { copyFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { promptWithMemory } from "./memory.ts";
import { selectionScope } from "./selection.ts";
import { createTutorSession, imageContent } from "./runtime.ts";
import type { Lecture } from "./lecture-state.ts";

async function persistedSession(courseDir: string) {
  const sessionDir = path.join(courseDir, ".sessions");
  const pointer = path.join(courseDir, "revision-session.json");
  try {
    const state = JSON.parse(await readFile(pointer, "utf8")) as { sessionFile?: unknown };
    if (typeof state.sessionFile !== "string") throw new Error("sessionFile must be a string");
    if (!state.sessionFile || path.isAbsolute(state.sessionFile)) throw new Error("sessionFile must be a relative path inside .sessions");
    const file = path.resolve(sessionDir, state.sessionFile);
    const relative = path.relative(sessionDir, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("sessionFile must stay inside .sessions");
    return SessionManager.open(file, sessionDir, courseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const manager = SessionManager.create(courseDir, sessionDir);
    const file = manager.getSessionFile();
    if (!file) throw new Error("Pi did not create a persistent revision session");
    await writeFile(pointer, `${JSON.stringify({ sessionFile: path.relative(sessionDir, file) }, null, 2)}\n`);
    return manager;
  }
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
) {
  if (!feedback.trim()) throw new Error("--revise requires learning feedback");
  if (!context.confirmedAt || !Number.isFinite(Date.parse(context.confirmedAt))) {
    throw new Error("Confirm the teaching route before revising the lecture");
  }
  const output = path.join(courseDir, "output", "content.md");
  let original: string;
  try {
    original = await readFile(output, "utf8");
  } catch {
    throw new Error("Generate and export a lecture before revising it");
  }
  if (!original.trim()) throw new Error("The existing lecture is empty; regenerate it before revising");

  const stage = await mkdtemp(path.join(courseDir, ".revision-"));
  const source = path.join(stage, "content.md");
  let session;
  try {
    await copyFile(output, source);
    await cp(path.join(courseDir, "output", "media"), path.join(stage, "media"), { recursive: true });
    await cp(path.join(courseDir, "output", "figures"), path.join(stage, "figures"), { recursive: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    session = await createTutorSession(courseDir, agentDir, model, {
      sessionManager: await persistedSession(courseDir),
      systemPrompt: "Revise an existing lecture with the smallest precise edit. Do not rewrite untouched sections, headings, media references, citations, or formula conditions. Never infer learning progress from a revision.",
      tools: ["read", "edit", "grep", "find"],
      writeRoot: stage,
    });
    let toolFailed = false;
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && ["read", "edit", "grep", "find"].includes(event.toolName)
        && (event.isError || event.result?.isError)) toolFailed = true;
    });
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
    await promptWithMemory(session, `Edit exactly ${relativeSource} with the edit tool. Keep every unchanged section byte-for-byte where practical. Return only a brief completion statement; do not print the lecture.\n${selectionScope(context.selection)}\nConfirmed route:\n${route}\n\nReusable parsed sources:\n${sources}\n\nLearner feedback: ${feedback}\n\nThe attached original pages/screenshots are for verification only.`, { images });
    const revised = await readFile(source, "utf8");
    if (toolFailed || revised === original) {
      throw new Error(toolFailed ? "the revision tool failed" : "the model did not change the staged lecture");
    }
    const preserved = preservesOriginal(original, revised);
    if (preserved) throw new Error(preserved);
    return source;
  } catch (error) {
    throw new Error(`Lecture revision failed; draft/assets retained in ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    session?.dispose();
  }
}

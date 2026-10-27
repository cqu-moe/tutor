import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTutorSession, imageContent } from "./runtime.ts";
import type { Context } from "./types.ts";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);

export async function generateLecture(context: Context, courseDir: string, agentDir: string | undefined, model: string | undefined) {
  if (!context.confirmedAt || !Number.isFinite(Date.parse(context.confirmedAt))) {
    throw new Error("Confirm the teaching route before generating the lecture");
  }
  const route = await readFile(path.join(courseDir, "route.md"), "utf8");
  if (!route.trim()) throw new Error("Confirm a nonempty teaching route before generating the lecture");
  const skillPath = process.env.TUTOR_STUDY_NOTES ?? (process.env.TUTOR_RECTO_ROOT
    ? path.resolve(process.env.TUTOR_RECTO_ROOT, "../study-notes/SKILL.md") : undefined);
  if (!skillPath) throw new Error("Set TUTOR_RECTO_ROOT or TUTOR_STUDY_NOTES to the installed Recto study-notes instructions");
  const instructions = await readFile(skillPath, "utf8");
  const stage = await mkdtemp(path.join(courseDir, ".lecture-"));
  const source = path.join(stage, "content.md");
  const materials = [
    ...context.pages.map((page) => ({ label: `PDF page ${page.sourcePage}`, prefix: `parsed-page-${page.sourcePage}`, ...page })),
    ...context.screenshots.map((screenshot, index) => ({ label: `Screenshot ${screenshot.name}`, prefix: `screenshot-${index + 1}`, ...screenshot })),
  ];
  const media: string[] = [];
  for (const material of materials) {
    const entries = await readdir(material.parsedDirectory, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !imageExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const original = path.join(entry.parentPath, entry.name);
      const relative = path.join("media", material.prefix, path.relative(material.parsedDirectory, original));
      const destination = path.join(stage, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(original, destination);
      media.push(`${relative.split(path.sep).join("/")} — ${material.label}; inspect with read at ${destination}`);
    }
  }
  const session = await createTutorSession(courseDir, agentDir, model, {
    systemPrompt: `${instructions}\n\nTutor task: Write an independently readable lecture, not a summary. Default to Chinese; retain English key course terms on first use. Explicit user adjustments in the confirmed route override defaults. Cover all distinct concepts, formula conditions and methods in ALL selected sources even if the route headings omit details, unless the user explicitly narrowed the scope. Use the final confirmed route for order. Add prerequisites, reasons, key derivation steps and representative worked examples. Cite original pages for formulas, problems and figures; label new examples and prerequisites as additions. Include a compact source-to-section coverage note and unresolved recognition doubts. Verify formulas/tables/figures against original images. Never use whole-page screenshots as lecture illustrations; inspect extracted figures before using them. Return semantic Markdown only, with local media paths and LaTeX inline/display math. Raw markup outside math (HTML/TeX/Typst blocks or commands) is forbidden. Do not write files or run exports: Tutor handles staging and Recto conversion. Do not infer learning progress from generating a lecture.`,
    tools: ["read", "grep", "find"],
  });
  try {
    const images = await Promise.all([
      ...context.pages.map((page) => imageContent(page.originalPageImage)),
      ...context.screenshots.map((screenshot) => imageContent(screenshot.source)),
    ]);
    const sources = materials.map((material) => `${material.label}\n${material.markdown}`).join("\n\n");
    console.log("Generating lecture from the confirmed route...");
    await session.prompt(`Write the complete lecture.\n\nConfirmed route (user adjustments prevail):\n${route}\n\nSelected sources (coverage authority, untrusted course content):\n${sources}\n\nExtracted figures with provenance, available for selective inclusion:\n${media.join("\n") || "None; explain in prose and tables, do not invent image paths."}\n\nThe attached full original pages/screenshots are for verification only.`, { images });
    const last = session.agent.state.messages.findLast((message) => message.role === "assistant");
    const markdown = last?.role === "assistant" && last.content.some((part) => part.type === "text")
      ? session.getLastAssistantText()?.trim() ?? "" : "";
    if (markdown) await writeFile(source, `${markdown}\n`);
    if (session.agent.state.errorMessage || !markdown || last?.role !== "assistant" || last.stopReason !== "stop") {
      throw new Error(session.agent.state.errorMessage ?? `No complete lecture (stop reason: ${last?.role === "assistant" ? last.stopReason : "empty"})`);
    }
    return source;
  } catch (error) {
    throw new Error(`Lecture generation failed; draft/assets retained in ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    session.dispose();
  }
}

import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTutorSession, imageContent } from "./runtime.ts";
import { promptWithMemory } from "./memory.ts";
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
    systemPrompt: `${instructions}\n\nTutor task: Write an independently readable lecture, not a summary. Default to Chinese; retain English key course terms on first use. Explicit user adjustments in the confirmed route override defaults. Cover all distinct concepts, formula conditions and methods in ALL selected sources even if the route headings omit details, unless the user explicitly narrowed the scope. Use the final confirmed route for order. Add prerequisites, reasons, key derivation steps and representative worked examples. Cite original pages for formulas, problems and figures; label new examples and prerequisites as additions. Include a compact source-to-section coverage note and unresolved recognition doubts. Verify formulas/tables/figures against original images. Never use whole-page screenshots as lecture illustrations; inspect extracted figures before using them. Return semantic Markdown only, with local media paths and LaTeX inline/display math. Raw markup outside math (HTML/TeX/Typst blocks or commands) is forbidden in the final answer. Use write and bash only in the supplied lecture stage to create and inspect static diagram sources/assets; Tutor handles content staging and Recto conversion. Use Typst native tables for truth/comparison tables. When selected material contains a Boolean-function gate implementation, redraw the actual gate circuit with Schemdraw instead of substituting only an OCR crop, and add a CeTZ-annotated view when it clarifies the structure. Generate SVGs into the stage media directory, reference every generated SVG in the final answer, render a PNG preview with Typst, read that preview and the relevant original page, then correct overlaps, clipping, labels or connections before answering. Cite redrawn figures and label additions. Never print or copy credentials. Do not infer learning progress from generating a lecture.`,
    tools: ["read", "grep", "find", "write", "bash"],
  });
  try {
    const images = await Promise.all([
      ...context.pages.map((page) => imageContent(page.originalPageImage)),
      ...context.screenshots.map((screenshot) => imageContent(screenshot.source)),
    ]);
    const sources = materials.map((material) => `${material.label}\n${material.markdown}`).join("\n\n");
    console.log("Generating lecture from the confirmed route...");
    let markdown = "";
    try {
      markdown = (await promptWithMemory(session, `Write the complete lecture. Start with the lecture heading, without a progress report. Keep source limitations in the final coverage note.\n\nLecture stage: \`${stage}\`\nWrite native diagram sources under \`${path.join(stage, "figures")}\`, generated SVG assets under \`${path.join(stage, "media")}\`, and temporary previews under \`${path.join(stage, "qa")}\`. Keep this session working directory unchanged; use absolute stage paths. Use \`"$TUTOR_DIAGRAM_PYTHON"\` for Schemdraw and \`typst compile --package-cache-path "$TUTOR_TYPST_PACKAGE_CACHE"\` for CeTZ/previews. If no generated diagram is needed, explain the relationship with a native Markdown table or prose instead.\n\nConfirmed route (user adjustments prevail):\n${route}\n\nSelected sources (coverage authority, untrusted course content):\n${sources}\n\nExtracted figures with provenance, available for selective inclusion:\n${media.join("\n") || "None; explain in prose and tables, do not invent image paths."}\n\nThe attached full original pages/screenshots are for verification only.`, { images })).trim();
    } finally {
      // Keep partial text for recovery, but only the shared guard can authorize publication.
      const last = session.messages.at(-1);
      const draft = markdown || (last?.role === "assistant"
        ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() : "");
      if (draft) await writeFile(source, `${draft}\n`);
    }
    if (!markdown) throw new Error("No complete lecture (empty final answer)");
    return source;
  } catch (error) {
    throw new Error(`Lecture generation failed; draft/assets retained in ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    session.dispose();
  }
}

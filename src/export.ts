import { ownedCommand as execute } from "./owned-process.ts";
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Lecture } from "./lecture-state.ts";

import { createHash } from "node:crypto";

export type Publication = { candidate: string; previous: string; output: string; expected: string; old: string | null };
async function manifest(directory: string): Promise<string | null> {
  try {
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error("Publication root must be a real directory");
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files: Array<[string, string]> = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Publication contains links or special files");
      if (entry.isFile()) { const file = path.join(entry.parentPath, entry.name); files.push([path.relative(directory, file), createHash("sha256").update(await readFile(file)).digest("hex")]); }
    }
    files.sort(([a], [b]) => a.localeCompare(b));
    return createHash("sha256").update(JSON.stringify(files)).digest("hex");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

// Every rename is reconciled from the validated trees, even if its following
// Pi commit never happened. This manifest describes one publication, not backups.
export async function publishLecture(publication: Publication, checkpoint: () => Promise<void>) {
  const { output, candidate, previous, expected, old } = publication;
  let actual = await manifest(output);
  if (actual === expected) { await checkpoint(); return output; }
  const next = await manifest(candidate), saved = await manifest(previous);
  if (next !== expected) {
    if (actual === null && saved === old && old !== null) await rename(previous, output);
    throw new Error('Publication candidate is incomplete; previous output retained. Inspect source and retry export, without regenerating.');
  }
  if (actual !== null) {
    if (actual !== old || saved !== null) throw new Error('Published output changed outside this task; inspect retained publication before continuing');
    await rename(output, previous);
    try { await checkpoint(); }
    catch (error) { if (await manifest(output) === null && await manifest(previous) === old) await rename(previous, output); throw error; }
    actual = null;
  }
  if (actual === null && old !== null && await manifest(previous) !== old) throw new Error('Previous publication does not match; manual inspection required');
  await rename(candidate, output);
  await checkpoint();
  if (await manifest(output) !== expected) throw new Error('Publication verification failed; inspect retained previous output');
  return output;
}

export async function exportLecture(courseDir: string, source: string, lecture: Lecture, outputDirectory: string | undefined, recovery: { stage: string; publication?: Publication; ready: (publication: Publication) => Promise<void>; checkpoint: () => Promise<void> }) {
  const rectoRoot = process.env.TUTOR_RECTO_ROOT;
  if (!rectoRoot) throw new Error(`Set TUTOR_RECTO_ROOT to the installed Recto skill directory; source retained at ${source}`);
  if (recovery.publication) return publishLecture(recovery.publication, recovery.checkpoint);
  const stage = recovery.stage;
  // No publication record means preparation was never admitted as complete.
  // Rebuild this candidate from the persisted source, never from a new model run.
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const next = path.join(stage, "output");
  const previous = path.join(stage, "previous-output");
  const output = outputDirectory ? path.resolve(courseDir, outputDirectory) : path.join(courseDir, "output");

  try {
    const python = process.env.TUTOR_PYTHON ?? "python3";
    await execute(python, [path.join(rectoRoot, "scripts/doctor.py"), "--style", "reference"]);
    const normalized = path.join(stage, "content.md");
    // Normalize standard math delimiters through Pandoc, preserving semantic content.
    await execute("pandoc", [source, "-f", "markdown+tex_math_single_backslash", "-t", "markdown",
      "--standalone", "--wrap=none", "-o", normalized]);
    await cp(path.join(path.dirname(source), "media"), path.join(stage, "media"), { recursive: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await cp(path.join(path.dirname(source), "figures"), path.join(next, "figures"), { recursive: true, force: false }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    // Inspect the host-owned copies so model processes cannot race this check.
    for (const directory of [path.join(stage, "media"), path.join(next, "figures")]) {
      const entry = await lstat(directory).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (!entry) continue;
      if (entry.isSymbolicLink() || (entry.isDirectory()
        && (await readdir(directory, { recursive: true, withFileTypes: true })).some((file) => file.isSymbolicLink()))) {
        throw new Error("Lecture assets must not contain symbolic links");
      }
    }
    await execute(python, [path.join(rectoRoot, "scripts/export.py"), normalized,
      "--style", "reference", "--formats", "typ,pdf", "--output", next], { maxBuffer: 32 * 1024 * 1024 });
    for (const file of ["content.md", "document.pdf", "typst/document.typ"]) await access(path.join(next, file));
    await mkdir(path.join(next, "media"), { recursive: true });
    await execute("typst", ["compile", "--root", ".", "--font-path", "typst/fonts",
      "typst/document.typ", "document.pdf"], { cwd: next, maxBuffer: 32 * 1024 * 1024 });
    await writeFile(path.join(next, "lecture.json"), `${JSON.stringify(lecture, null, 2)}\n`);
    await mkdir(path.dirname(output), { recursive: true });
    const publication: Publication = { candidate: next, previous, output, expected: (await manifest(next))!, old: await manifest(output) };
    await recovery.ready(publication);
    return await publishLecture(publication, recovery.checkpoint);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Recto export failed; source retained at ${source}; partial export in ${stage}: ${detail}`);
  }
}

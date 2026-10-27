import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Lecture } from "./lecture-state.ts";

const execute = promisify(execFile);

export async function exportLecture(courseDir: string, source: string, lecture: Lecture) {
  const rectoRoot = process.env.TUTOR_RECTO_ROOT;
  if (!rectoRoot) throw new Error(`Set TUTOR_RECTO_ROOT to the installed Recto skill directory; source retained at ${source}`);
  const stage = await mkdtemp(path.join(courseDir, ".export-"));
  const next = path.join(stage, "output");
  const previous = path.join(stage, "previous-output");
  const output = path.join(courseDir, "output");
  let backedUp = false;
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
    try {
      await rename(output, previous);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(next, output);
    } catch (error) {
      if (backedUp) await rename(previous, output);
      throw error;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Recto export failed; source retained at ${source}; partial export in ${stage}: ${detail}`);
  }
  await rm(stage, { recursive: true, force: true }).catch(() => {
    console.warn(`Export succeeded; temporary files remain at ${stage}`);
  });
  return output;
}

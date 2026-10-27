import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "./types.ts";

export type Lecture = { context: Context; route: string };

export async function readDraft(courseDir: string): Promise<Lecture> {
  try {
    return JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Existing courses used separate context and route files; leave them intact.
  const context: Context = JSON.parse(await readFile(path.join(courseDir, "context.json"), "utf8"));
  const route = context.confirmedAt ? await readFile(path.join(courseDir, "route.md"), "utf8") : "";
  return { context, route };
}

export async function saveDraft(courseDir: string, lecture: Lecture) {
  const temporary = path.join(courseDir, `.draft-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(lecture, null, 2)}\n`);
  await rename(temporary, path.join(courseDir, "draft.json"));
}

export async function readPublishedLecture(courseDir: string): Promise<Lecture | undefined> {
  const manifest = path.join(courseDir, "output", "lecture.json");
  try {
    return JSON.parse(await readFile(manifest, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await access(path.join(courseDir, "output", "content.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
  // Bind a legacy output before a new candidate can replace its source metadata.
  const lecture = await readDraft(courseDir);
  if (!lecture.context.confirmedAt || !lecture.route.trim()) {
    throw new Error("Existing lecture has no confirmed source metadata; restore its context and route before importing new materials");
  }
  await writeFile(manifest, `${JSON.stringify(lecture, null, 2)}\n`, { flag: "wx" });
  return lecture;
}

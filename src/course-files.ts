import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createFindToolDefinition, createGrepToolDefinition, createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { memoryDirectory } from "./memory-store.ts";

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};

export async function courseReadPath(courseDir: string, candidate: string) {
  const root = await realpath(courseDir);
  const file = await realpath(path.resolve(courseDir, candidate));
  const relative = path.relative(root, file);
  if (!inside(root, file) || relative.split(path.sep).some((part) => [".sessions", ".durable", ".memory"].includes(part))
    || path.basename(file) === "revision-session.json" || inside(await realpath(memoryDirectory(courseDir)), file)) {
    throw new Error("Read boundary: only current course content is accessible; raw memory/history is not a file tool");
  }
  return file;
}

export async function courseReadTools(courseDir: string, selected: string[], stage?: string): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  if (selected.includes("read")) {
    const read = createReadToolDefinition(courseDir);
    const confined: typeof read = { ...read, execute: async (id, args, signal, update, context) =>
      read.execute(id, { ...args, path: await courseReadPath(courseDir, args.path) }, signal, update, context) };
    tools.push(confined);
  }
  // Recursive search starts in an explicit content subdirectory, so it cannot
  // traverse the course's retained legacy session archive.
  const searchPath = async (candidate?: string) => {
    const target = await courseReadPath(courseDir, candidate ?? stage ?? ".");
    if ((await stat(target)).isDirectory() && target === await realpath(courseDir)) throw new Error("Search an explicit course content subdirectory");
    return target;
  };
  if (selected.includes("grep")) {
    const grep = createGrepToolDefinition(courseDir);
    const confined: typeof grep = { ...grep, execute: async (id, args, signal, update, context) =>
      grep.execute(id, { ...args, path: await searchPath(args.path) }, signal, update, context) };
    tools.push(confined);
  }
  if (selected.includes("find")) {
    const find = createFindToolDefinition(courseDir);
    const confined: typeof find = { ...find, execute: async (id, args, signal, update, context) =>
      find.execute(id, { ...args, path: await searchPath(args.path) }, signal, update, context) };
    tools.push(confined);
  }
  return tools;
}

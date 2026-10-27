import { execFile } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sandboxOptions } from "./assets.ts";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createBashToolDefinition, createLocalBashOperations, createEditToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function stageTools(courseDir: string, stage: string): Promise<ToolDefinition[]> {
  const root = await realpath(stage);
  const temporary = path.join(root, ".tmp");
  await mkdir(temporary);
  const environment = { ...process.env, TMPDIR: temporary, CLAUDE_CODE_TMPDIR: temporary,
    XDG_CACHE_HOME: temporary, MPLCONFIGDIR: temporary, PYTHONDONTWRITEBYTECODE: "1" };
  async function sandbox<T>(command: string, execute: (wrapped: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!["darwin", "linux"].includes(process.platform)) throw new Error("Tutor stage sandbox requires macOS or Linux");
    const oldTemporary = process.env.CLAUDE_CODE_TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = temporary;
    try {
      await SandboxManager.initialize({
        ...await sandboxOptions(),
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          denyRead: [], allowWrite: [{ path: root, literal: true }],
          denyWrite: ["/tmp/claude", "/private/tmp/claude", path.join(homedir(), ".npm/_logs"), path.join(homedir(), ".claude/debug")]
            .map((directory) => ({ path: directory, literal: true })),
        },
      });
      let wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", undefined, signal);
      if (process.platform === "darwin") {
        // shortcut: pinned runtime has no extra Seatbelt rules API; replace when one exists.
        const profile = "/usr/bin/sandbox-exec -p '(version 1)";
        if (!wrapped.includes(profile)) throw new Error("Unsupported sandbox profile; refusing to run without hard-link protection");
        wrapped = wrapped.replace(profile, `${profile}\n(deny file-link)`);
      }
      return await execute(wrapped);
    } finally {
      if (oldTemporary === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = oldTemporary;
      await SandboxManager.reset();
    }
  }
  async function mutate(file: string, content?: string) {
    const target = await writable(file);
    const code = content === undefined
      ? "require('node:fs').mkdirSync(process.argv[1], {recursive:true})"
      : "require('node:fs').writeFileSync(process.argv[1], require('node:fs').readFileSync(0))";
    await sandbox(`BUN_BE_BUN=1 ${quote(process.execPath)} --no-env-file -e ${quote(code)} ${quote(target)}`, (wrapped) => new Promise<void>((resolve, reject) => {
      const child = execFile("/bin/bash", ["-c", wrapped], { cwd: courseDir, env: environment, timeout: 30_000 }, (error, _stdout, stderr) => error
        ? reject(new Error(`Tutor stage write failed: ${stderr.slice(-1000) || error.code}`)) : resolve());
      child.stdin!.on("error", () => {});
      child.stdin!.end(content);
    }));
  }
  async function writable(file: string) {
    let existing = file;
    for (;;) {
      try {
        const info = await lstat(existing);
        if (info.isFile() && info.nlink > 1) throw new Error("Tutor write boundary: shared hard links are not writable");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    const resolved = path.resolve(await realpath(existing), path.relative(existing, file));
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Tutor write boundary: target must stay inside the current lecture stage");
    }
    return resolved;
  }

  const tools: ToolDefinition[] = [
    createEditToolDefinition(courseDir, { operations: {
      readFile,
      access: async (file) => access(await writable(file)),
      writeFile: (file, content) => mutate(file, content),
    } }),
    createWriteToolDefinition(courseDir, { operations: {
      mkdir: (directory) => mutate(directory),
      writeFile: (file, content) => mutate(file, content),
    } }),
    createBashToolDefinition(courseDir, { exposeSessionEnvironment: false, operations: {
      exec: (command, cwd, options) => sandbox(command, (wrapped) => createLocalBashOperations({ shellPath: "/bin/bash" })
        .exec(wrapped, cwd, { ...options, env: { ...options.env, ...environment } }), options.signal),
    } }),
  ];
  // Keep model mutations serial so one tool cannot replace another's checked path.
  let pending = Promise.resolve();
  return tools.map((tool) => ({ ...tool, execute: (...args) => {
    const result = pending.then(() => tool.execute(...args));
    pending = result.then(() => {}, () => {});
    return result;
  } }));
}

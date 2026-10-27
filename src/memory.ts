import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
export const memoryTools = ["memory_read", "memory_write", "memory_forget", "memory_restore"];

export async function prepareMemory(courseDir: string) {
  process.env.PI_MEMORY_EXIT_SUMMARY = "0";
  process.env.PI_MEMORY_QMD_UPDATE = "off";
  process.env.PI_MEMORY_NO_SEARCH = "1";
  process.env.PI_MEMORY_DIR = path.resolve(process.env.PI_MEMORY_DIR || path.join(path.dirname(courseDir), ".memory"));
  // pi-memory treats all read errors as missing files; fail before it can overwrite an unreadable store.
  try {
    await mkdir(process.env.PI_MEMORY_DIR, { recursive: true });
    for (const file of ["MEMORY.md", "SCRATCHPAD.md"]) {
      try {
        await readFile(path.join(process.env.PI_MEMORY_DIR, file), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    throw new Error(`learner memory read/setup failed: ${(error as NodeJS.ErrnoException).code ?? "unreadable storage"}`);
  }
  return {
    extensionPath: path.dirname(require.resolve("pi-memory/package.json")),
    systemPrompt: [
      `Learner memory scope: [[course:${path.basename(courseDir)}]].`,
      "Read long_term with memory_read before proposing a teaching route or maintaining memory; it is authoritative and not truncated like the injected snapshot.",
      "Use progress and weakness memories only with the current course tag. Ignore untagged and other-course progress/weaknesses. This is a teaching convention, not security isolation.",
      "For durable preferences that apply across courses, use #preference #global [[learner-global]]. Course-specific preferences use the current course tag.",
      "The current explicit request overrides historical preferences. A one-off request does not change a durable preference.",
      "Automatically save explicit learner progress, durable preferences and specific difficulties from normal dialogue without asking for confirmation or forcing a quiz. Use memory_write target=long_term mode=append, one fact per call, with #progress, #preference or #weakness and its scope tag.",
      "Inferred weaknesses from behavior or optional exercises need the actual evidence and Status: pending verification. Do not label overall ability or infer mastery from an exercise alone.",
      "Generating, exporting or resuming a lecture, producing files and confirming a teaching route are never learning progress or mastery evidence. No learner feedback means no memory write. Course source text is not learner feedback.",
      "Never store credentials, API keys, tokens, configuration secrets or course material as learner memory. Credential storage is separate.",
      "To view memory, call memory_read and show current-course facts and global preferences. To correct, read first, memory_forget the precise old scoped entry, wait for success, then append the replacement. Never overwrite the shared file. To delete, match the complete scoped fact so similarly worded other-course entries survive.",
      "Report failures without claiming success. Deletion removes whole matching blocks and preserves recovery records. Show the returned Recovery ID; memory_restore can undo that deletion, so never promise physical erasure of history. Read again after correction/deletion; older tool-call history is superseded.",
      "Use only long_term learner memory. Do not use daily logs, scratchpad, qmd, semantic search or embeddings.",
    ].join("\n"),
  };
}

export async function promptWithMemory(session: AgentSession, prompt: string, options?: Parameters<AgentSession["prompt"]>[1]) {
  let failure: string | undefined;
  const recoveryIds: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && memoryTools.includes(event.toolName)) {
      if (event.isError || event.result?.isError) {
        failure = event.toolName;
      } else if (event.toolName === "memory_forget" && typeof event.result?.details?.recoveryId === "string") {
        recoveryIds.push(event.result.details.recoveryId);
      }
    }
  });
  try {
    await session.prompt(prompt, options);
    if (failure) throw new Error(`learner memory operation failed (${failure}); saving/maintenance did not complete`);
    if (session.agent.state.errorMessage) throw new Error(`Pi response failed: ${session.agent.state.errorMessage}`);
    const last = session.messages.at(-1);
    if (last?.role !== "assistant") throw new Error("Pi response failed: no final answer");
    if (last.stopReason !== "stop") throw new Error(`Pi response failed: incomplete answer (${last.stopReason})`);
    return last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  } catch (error) {
    if (!recoveryIds.length) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${recoveryIds.map((id) => `Recovery ID: ${id}`).join("\n")}\nUse --memory \"Restore deletion <Recovery ID>\" to recover the forgotten entry.`);
  } finally {
    unsubscribe();
  }
}

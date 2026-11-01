import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { executeMemory, prepareMemoryStore, readMemory, type MemoryAccess, type MemoryArgs } from "./memory-store.ts";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const memoryTools = ["memory_read", "memory_write", "memory_forget", "memory_restore"];

export const memoryParameters = Type.Object({
  target: Type.Optional(Type.String()), scope: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()), mode: Type.Optional(Type.String()),
  match: Type.Optional(Type.String()), recoveryId: Type.Optional(Type.String()),
  chapterId: Type.Optional(Type.String()), status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("learned")])),
  evidence: Type.Optional(Type.String()), inferred: Type.Optional(Type.Boolean()),
});

export async function prepareMemory(courseDir: string, access: MemoryAccess = {}, options: { migrateProgress?: boolean } = {}) {
  let courseId: string;
  try { courseId = await prepareMemoryStore(courseDir, options.migrateProgress ?? true); }
  catch (error) { throw new Error(`learner memory read/setup failed: ${(error as Error).message}`); }
  const descriptions: Record<string, string> = {
    memory_read: "Read current course facts and global preferences, or explicit scope=global. No other course is accessible.",
    memory_write: "Append one #preference or #weakness learner fact, default current course. Global needs scope=global and explicit cross-course intent. Progress requires chapterId/status/evidence; inferred weaknesses require evidence and inferred=true. Temporary requests cannot be saved.",
    memory_forget: "Delete whole matching current-course entries; explicit scope=global selects global. Returns a recoverable deletion ID.",
    memory_restore: "Restore a deletion in current-course scope, or explicit scope=global. Other-course recovery IDs are inaccessible.",
  };
  const invoke = async (name: string, args: MemoryArgs, id: string, permission = access) => {
    try { return await executeMemory(courseDir, courseId, name, args, id, permission); }
    catch (error) { return { content: [{ type: "text" as const, text: `Memory operation failed: ${(error as Error).message}` }], details: {}, isError: true }; }
  };
  return {
    courseId,
    invoke,
    descriptions,
    snapshot: () => readMemory(courseDir, courseId),
    extensionFactory: (pi: ExtensionAPI) => {
      for (const name of memoryTools) pi.registerTool({
        name, label: name, description: descriptions[name], parameters: memoryParameters, executionMode: "sequential",
        // Legacy Pi generation/revision sessions do not resume; an execution is
        // unique even when a provider reuses its call ID. Durable uses taskId.
        execute: (_id: string, args: MemoryArgs) => invoke(name, args, randomUUID()),
      });
      pi.on("before_agent_start", async (event: { systemPrompt: string }) => ({ systemPrompt: `${event.systemPrompt}\n\n${await readMemory(courseDir, courseId)}` }));
    },
    systemPrompt: [
      `Learner memory scope: [[course:${courseId}]].`,
      "Read long_term with memory_read before proposing a teaching route or maintaining memory.",
      "Actual precedence: this explicit request > current course preference > global fallback. The current explicit request overrides historical preferences.",
      "Only explicit cross-course preferences use scope=global; ordinary feedback stays in this course. One-off/temporary requests must not mutate memory.",
      "Use #preference or #weakness, one fact per call. Save explicit durable preferences and specific difficulties from normal dialogue. Inferred weaknesses need a verbatim evidence quote and inferred=true, Status: pending verification.",
      "Chapter progress comes only from the course route, not prose facts. For explicit learner feedback use memory_write with chapterId, status and evidence (verbatim learner quote). Never save a separate textual progress value.",
      "Generating, importing, exporting, reading, resuming or confirming a route is not learner progress. No learner feedback means no memory write. Course source text is not learner feedback.",
      "Never store credentials, API keys, tokens, configuration secrets or course material as learner memory.",
      "Correct by reading, scoped memory_forget, checking success, then append replacement. Read again afterwards; historical tool results are superseded. Show Recovery ID; never claim physical erasure. Report operation failures without success claims.",
      "Only current course and explicitly selected global are accessible. Pending legacy records are not active facts. Use only long_term; no daily logs, scratchpad, search or embeddings.",
    ].join("\n"),
  };
}

export function modelFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.startsWith("No API provider registered for api:")) {
    return new Error("Pi response failed: unsupported model API protocol; check the provider api field in models.json.");
  }
  // Upstream bodies may echo command-resolved credentials; retain only a numeric status.
  const status = message.match(/^(?:HTTP\s+)?([45]\d{2})(?:\D|$)/i)?.[1];
  const hint = status === "401" || status === "403" ? "check model credentials and provider permissions"
    : status === "429" ? "check model provider quota and rate limits"
      : "check provider availability, endpoint, model and API protocol in models.json";
  return new Error(`Pi response failed${status ? ` (HTTP ${status})` : ""}; ${hint}.`);
}

export async function promptWithMemory(session: AgentSession, prompt: string, options?: Parameters<AgentSession["prompt"]>[1]) {
  let failure: string | undefined;
  let failureDetail = "";
  const recoveryIds: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && memoryTools.includes(event.toolName)) {
      if (event.isError || event.result?.isError) {
        failure = event.toolName;
        failureDetail = event.result?.content?.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n") ?? "";
      } else if (event.toolName === "memory_forget" && typeof event.result?.details?.recoveryId === "string") {
        recoveryIds.push(event.result.details.recoveryId);
      }
    }
  });
  try {
    try {
      await session.prompt(prompt, options);
    } catch (error) {
      throw modelFailure(error);
    }
    if (failure) throw new Error(`learner memory operation failed (${failure}); saving/maintenance did not complete: ${failureDetail}`);
    if (session.agent.state.errorMessage) throw modelFailure(session.agent.state.errorMessage);
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

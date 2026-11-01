import path from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ToolResultEntry,
  Harness,
  createRegistry,
  defineDoc,
  defineExtension,
  section,
} from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration, Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ExecutionError, FileError, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { ModelRuntime, getAgentDir, resolveCliModel } from "@earendil-works/pi-coding-agent";
import {
  createModels,
  createProvider,
  AssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type Model,
  type ProviderStreams,
} from "pi-ai-1-4";
import { AI_TELEMETRY_SCHEMA } from "pi-ai-1-4/models";
import { anthropicMessagesApi } from "pi-ai-1-4/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "pi-ai-1-4/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "pi-ai-1-4/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "pi-ai-1-4/api/google-generative-ai.lazy";
import { googleVertexApi } from "pi-ai-1-4/api/google-vertex.lazy";
import { mistralConversationsApi } from "pi-ai-1-4/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "pi-ai-1-4/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "pi-ai-1-4/api/openai-completions.lazy";
import { openAIResponsesApi } from "pi-ai-1-4/api/openai-responses.lazy";
import { piMessagesApi } from "pi-ai-1-4/api/pi-messages.lazy";
import { defaultModel, imageContent } from "./runtime.ts";
import { courseReadPath } from "./course-files.ts";
import type { MemoryArgs } from "./memory-store.ts";
import { memoryTools as memoryToolNames, modelFailure, prepareMemory, memoryParameters } from "./memory.ts";

export type DurablePromptPart = Awaited<ReturnType<typeof imageContent>> | { type: "text"; text: string };

export type DurableSubmissionReceipt = {
  conversationId: string;
  submissionId: string;
};

export type DurableAnswer = DurableSubmissionReceipt & {
  text: string;
};

const durableApis: Record<string, () => ProviderStreams> = {
  "anthropic-messages": anthropicMessagesApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "bedrock-converse-stream": bedrockConverseStreamApi,
  "google-generative-ai": googleGenerativeAIApi,
  "google-vertex": googleVertexApi,
  "mistral-conversations": mistralConversationsApi,
  "openai-codex-responses": openAICodexResponsesApi,
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "pi-messages": piMessagesApi,
};

const durablePiAiTelemetrySchemaVersion = 1;

const MemoryConversationDoc = defineDoc({
  kind: "tutor.memory-conversation", version: 1, scope: "session",
  initial: () => ({ id: "" }), checkpointWhen: () => false,
});

// Select the latest request for a saved draft; Pi owns submission lookup/admission.
const TeachingConversationDoc = defineDoc({
  kind: "tutor.teaching-conversations", version: 1, scope: "session",
  initial: () => ({ ids: {} as Record<string, string> }), checkpointWhen: () => false,
});

const RouteRequestDoc = defineDoc({
  kind: "tutor.route-request", version: 1, scope: "conversation",
  history: "latest", fork: "initial",
  initial: () => ({ resumeKey: "", requestId: "" }),
  checkpointWhen: () => false,
});

// The Harness persists both streamed partials and the terminal result. Never
// pass a provider error body through: it may echo even command-resolved auth.
// Retain only classifications needed by Pi's bounded retry/compaction policies.
function safeModelMessage(message: AssistantMessage): AssistantMessage {
  if (!message.errorMessage && message.stopReason !== "error" && message.stopReason !== "aborted") {
    return structuredClone(message);
  }
  const status = message.errorMessage?.match(/^(?:HTTP\s+)?([45]\d{2})(?:\D|$)/i)?.[1];
  const category = isContextOverflow(message) ? "context_length_exceeded"
    : isRetryableAssistantError(message) ? "network error"
      : "non-retryable provider error (quota exceeded or configuration failure)";
  return {
    role: "assistant", content: [], api: message.api, provider: message.provider,
    model: message.model, usage: structuredClone(message.usage),
    timestamp: message.timestamp, durationMs: message.durationMs,
    stopReason: message.stopReason,
    errorMessage: `${status ? `${status} ` : ""}${category}`,
  };
}

function safeModelStream(model: Model<Api>, start: () => AssistantMessageEventStream) {
  const output = new AssistantMessageEventStream();
  void (async () => {
    try {
      const source = start();
      for await (const event of source) {
        if (event.type === "error") output.push({ ...event, error: safeModelMessage(event.error) });
        else if (event.type === "done") output.push({ ...event, message: safeModelMessage(event.message) });
        else output.push({ ...event, partial: safeModelMessage(event.partial) });
      }
      output.end(safeModelMessage(await source.result()));
    } catch (error) {
      // Also cover synchronous setup and rejected iterators/results, which have
      // no provider message but otherwise become persisted task failure text.
      output.push({ type: "error", reason: "error", error: safeModelMessage({
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }) });
      output.end();
    }
  })();
  return output;
}

function safeProviderStreams(streams: ProviderStreams): ProviderStreams {
  function reconciled(context: { messages: readonly any[] }) {
    if (context.messages.some(message => message.role === "toolResult" && ["write","edit","bash"].includes(message.toolName) && message.isError && message.content.some((part: any) => part.type === "text" && /was interrupted/.test(part.text)))) {
      throw new Error("Interrupted stage tool outcome requires inspection before another model request");
    }
  }
  return {
    stream: (model, context, options) => safeModelStream(model, () => { reconciled(context); return streams.stream(model, context, options); }),
    streamSimple: (model, context, options) => safeModelStream(model, () => { reconciled(context); return streams.streamSimple(model, context, options); }),
    ...(streams.fetchDeferred ? {
      fetchDeferred: (model, handle, options) => safeModelStream(model, () => streams.fetchDeferred!(model, handle, options)),
    } satisfies Pick<ProviderStreams, "fetchDeferred"> : {}),
    ...(streams.cancelDeferred ? {
      cancelDeferred: async (model, handle, options) => {
        try { await streams.cancelDeferred!(model, handle, options); }
        catch (error) { throw modelFailure(error); }
      },
    } satisfies Pick<ProviderStreams, "cancelDeferred"> : {}),
  };
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function confinedExecutionEnv(options: { courseDir: string; cwd: string; agentDir: string }): Promise<ExecutionEnv> {
  const target = new NodeExecutionEnv({ cwd: options.cwd });
  const lexicalRoot = path.resolve(options.courseDir);
  return realpath(options.courseDir).then(async (canonicalRoot) => {
    const credentialRoots = await Promise.all([options.agentDir, getAgentDir()].map(directory => realpath(directory).catch(() => path.resolve(directory))));
    const readMethods = new Set([
      "readTextFile",
      "openTextLineReader",
      "readTextLines",
      "readBinaryFile",
      "openBinaryReader",
      "fileInfo",
      "listDir",
      "listFiles",
      "openDirReader",
      "canonicalPath",
      "exists",
    ]);
    const deniedFileMethods = new Set([
      "writeFile",
      "appendFile",
      "truncateFile",
      "flushFile",
      "renameFile",
      "createDir",
      "remove",
      "createTempDir",
      "createTempFile",
    ]);
    return new Proxy(target, {
      get(current, property, receiver) {
        const value = Reflect.get(current, property, receiver) as unknown;
        if (typeof property !== "string" || typeof value !== "function") return value;
        if (property === "exec") {
          return async () => ({
            ok: false as const,
            error: new ExecutionError("spawn_error", "Durable course tools cannot execute shell commands"),
          });
        }
        if (deniedFileMethods.has(property)) {
          return async () => ({
            ok: false as const,
            error: new FileError("permission_denied", "Durable course tools cannot mutate files"),
          });
        }
        if (property === "watch") {
          return async (targets: Array<{ path: string }>, onChange: never, context: unknown) => {
            const allowed = await Promise.all(targets.map(async ({ path: targetPath }) => {
              const absolute = await target.absolutePath(targetPath, context as never);
              return absolute.ok
                && (inside(lexicalRoot, absolute.value) || inside(canonicalRoot, absolute.value));
            }));
            if (!allowed.every(Boolean)) {
              return {
                ok: false as const,
                error: new FileError("permission_denied", "Watching paths outside the current course is not allowed"),
              };
            }
            return current.watch(targets as never, onChange, context as never);
          };
        }
        if (!readMethods.has(property)) return (value as (...args: unknown[]) => unknown).bind(current);
        return async (requestPath: string, ...args: unknown[]) => {
          const absolute = await target.absolutePath(requestPath, args.at(-1) as never);
          if (!absolute.ok) return absolute;
          if (!inside(lexicalRoot, absolute.value) && !inside(canonicalRoot, absolute.value)) {
            return {
              ok: false as const,
              error: new FileError(
                "permission_denied",
                "Reading paths outside the current course is not allowed",
                absolute.value,
              ),
            };
          }
          if (property === "exists") {
            const existing = await target.exists(requestPath, args.at(-1) as never);
            if (!existing.ok || !existing.value) return existing;
          }
          const canonical = await target.canonicalPath(absolute.value, args.at(-1) as never);
          if (!canonical.ok) return canonical;
          if (!inside(canonicalRoot, canonical.value) || credentialRoots.some(root => inside(root, canonical.value))) {
            return {
              ok: false as const,
              error: new FileError(
                "permission_denied",
                "Reading a link outside the current course is not allowed",
                absolute.value,
              ),
            };
          }
          try { await courseReadPath(options.courseDir, canonical.value); }
          catch { return { ok: false as const, error: new FileError("permission_denied", "Raw memory and legacy session history are not course content") }; }
          if (property === "openBinaryReader") {
            const readOptions = args[0] as { noFollow?: boolean } | undefined;
            return current.openBinaryReader(canonical.value, { ...readOptions, noFollow: true }, args.at(-1) as never);
          }
          return (value as (...callArgs: unknown[]) => unknown)(canonical.value, ...args);
        };
      },
    }) as ExecutionEnv;
  });
}

export async function openTutorDurableSession(options: {
  courseDir: string;
  agentDir?: string;
  model?: string;
  systemPrompt?: string;
  tools?: ToolRegistration[];
  extensions?: Extension[];
  channel?: "route" | "memory";
  conversationKey?: string;
}) {
  // Keep this observable read. Bun 1.4.4 honors Pi AI 1.4's incomplete
  // sideEffects metadata and can elide telemetry module initialization; without
  // this import, the same fixture fails at instrumentCache.get in both an
  // unminified bundle and an unminified compiled executable. A no-schema build
  // passed only with ignoreDCEAnnotations, proving this is DCE rather than
  // minification or the compile container.
  if (AI_TELEMETRY_SCHEMA.version !== durablePiAiTelemetrySchemaVersion) {
    throw new Error(`Pi response failed: unsupported Pi AI telemetry schema (${AI_TELEMETRY_SCHEMA.version}); use @earendil-works/pi-ai@1.4.0.`);
  }
  const memory = await prepareMemory(options.courseDir, {}, { migrateProgress: options.channel === "memory" });
  const effectiveAgentDir = options.agentDir ?? getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(effectiveAgentDir, "auth.json"),
    modelsPath: path.join(effectiveAgentDir, "models.json"),
  });
  const requested = resolveCliModel({
    cliModel: options.model ?? defaultModel,
    modelRuntime,
  });
  if (requested.error) throw new Error(`Pi model is unavailable: ${requested.error}`);
  if (!requested.model?.input.includes("image")) {
    throw new Error(`Pi model ${requested.model?.provider}/${requested.model?.id} cannot read course images`);
  }
  const durableApi = durableApis[requested.model.api];
  if (!durableApi) {
    throw new Error(`Pi response failed: unsupported model API protocol (${requested.model.api}); check the provider api field in models.json.`);
  }
  const durableModel = JSON.parse(JSON.stringify(requested.model)) as Model<Api>;
  const durableModels = createModels();
  durableModels.setProvider(createProvider({
    id: durableModel.provider,
    name: durableModel.provider,
    baseUrl: durableModel.baseUrl,
    headers: durableModel.headers,
    auth: {
      apiKey: {
        name: `${durableModel.provider} credentials`,
        resolve: async ({ signal }) => {
          signal.throwIfAborted();
          try { return await modelRuntime.getAuth(durableModel, { signal }); }
          catch { throw new Error("Model credential resolution failed; check local model configuration"); }
        },
      },
    },
    models: [durableModel],
    api: safeProviderStreams(durableApi()),
  }));

  const scopedMemoryTools = memoryToolNames.map((name) => ({
    name, description: memory.descriptions[name], parameters: memoryParameters,
    replay: "safe" as const,
    executionMode: "sequential" as const,
    callers: ["model"] as const,
    execute: async (args: MemoryArgs, api: import("@earendil-works/pi-durable").ToolExecutionApi, context: import("@earendil-works/chord").Context) => {
      const learnerFeedback = await api.commit(async (tx) => {
        let task = await tx.task(api.taskId);
        while (task && (task.input as { kind?: string }).kind === "nested") task = await tx.task((task.input as { parent: never }).parent);
        const assistant = (task?.input as { assistant?: never })?.assistant;
        if (!assistant) return "";
        let cursor;
        do {
          const page = await tx.scanEntries({ conversationId: api.conversationId, maxEntryId: assistant, order: "descending" }, 100, cursor);
          for (const entry of page.items) {
            if (entry.kind === "tutor.request") return (entry.data as { learnerFeedback?: string })?.learnerFeedback ?? "";
            if (entry.kind === "pi.reset") return "";
          }
          cursor = page.next;
        } while (cursor);
        return "";
      }, context);
      const result = await memory.invoke(name, args, `${memory.courseId}:${api.taskId}`, { learnerFeedback });
      return { output: result.content, details: result.details, isError: "isError" in result ? result.isError : false };
    },
  }));

  const safeRead = { ...createReadTool(), replay: "safe" as const };
  const tools = [safeRead, ...scopedMemoryTools, ...(options.tools ?? [])];
  const registry = createRegistry();
  registry.install(defineExtension({
    name: "tutor-durable",
    sections: [section("preamble", async () => {
      const base = [
        options.systemPrompt ?? "You are a careful course tutor.",
        memory.systemPrompt,
      ].filter(Boolean).join("\n\n");
      return `${base}\n\n${await memory.snapshot()}`;
    }, { tag: false })],
    tools,
  }));
  for (const extension of options.extensions ?? []) registry.install(extension);

  const storageDir = path.join(options.courseDir, ".durable");
  await mkdir(storageDir, { recursive: true });
  const storage = await openNodeSqliteStorage(path.join(storageDir, "session.sqlite"));
  const executionEnv = await confinedExecutionEnv({ courseDir: options.courseDir, cwd: options.courseDir, agentDir: effectiveAgentDir });
  const harness = await Harness.open(storage, {
    models: durableModels,
    registry,
    env: () => executionEnv,
  }, BACKGROUND_CONTEXT);
  let conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: requested.model.provider, modelId: requested.model.id },
      cwd: options.courseDir,
      tools,
    },
  });
  if (options.conversationKey) {
    const id = await harness.commit(async (tx) => {
      const pointers = await tx.doc(TeachingConversationDoc);
      if (!pointers.ids[options.conversationKey!]) pointers.ids[options.conversationKey!] = String((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
      return pointers.ids[options.conversationKey!];
    }, BACKGROUND_CONTEXT);
    const selected = await harness.conversation(Number(id) as never, BACKGROUND_CONTEXT);
    if (!selected) throw new Error("Teaching conversation is missing");
    conversation = selected;
  } else if (options.channel === "memory") {
    const id = await harness.commit(async (tx) => {
      const pointer = await tx.doc(MemoryConversationDoc);
      if (!pointer.id) pointer.id = String((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
      return pointer.id;
    }, BACKGROUND_CONTEXT);
    const selected = await harness.conversation(Number(id) as never, BACKGROUND_CONTEXT);
    if (!selected) throw new Error("Memory conversation is missing");
    conversation = selected;
  }
  await conversation.configure({
    model: { provider: requested.model.provider, modelId: requested.model.id },
    cwd: options.courseDir,
    tools,
  }, BACKGROUND_CONTEXT);
  harness.resume();

  return {
    conversationId: String(conversation.id),
    async reset(handoff?: string): Promise<void> {
      await conversation.reset(handoff, BACKGROUND_CONTEXT);
    },
    async commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T> {
      return conversation.commit(change, BACKGROUND_CONTEXT);
    },
    async submit(input: { content: DurablePromptPart[]; requestId: string; resumeKey?: string; learnerFeedback?: string }): Promise<DurableSubmissionReceipt> {
      if (input.resumeKey) {
        // Write selection before admission: a crash after submit cannot leave an
        // admitted adjustment hidden behind the previous route's pointer. If
        // killed before admission, no new work is accepted or replayed.
        await conversation.commit(async (tx) => {
          const selection = await tx.doc(RouteRequestDoc, conversation.id);
          selection.resumeKey = input.resumeKey!;
          selection.requestId = input.requestId;
        }, BACKGROUND_CONTEXT);
      }
      const submission = await conversation.submit({
        type: "input",
        entry: { kind: "tutor.request", data: { learnerFeedback: input.learnerFeedback ?? "" } },
        content: input.content as never,
        requestId: input.requestId,
      }, BACKGROUND_CONTEXT);
      return { conversationId: String(conversation.id), submissionId: String(submission.id) };
    },
    async resumeSubmission(requestId: string, resumeKey?: string): Promise<DurableAnswer | undefined> {
      const selection = resumeKey
        ? await harness.snapshot(RouteRequestDoc, conversation.id, BACKGROUND_CONTEXT) : undefined;
      const selectedRequest = selection && selection.resumeKey === resumeKey ? selection.requestId : requestId;
      const submission = await conversation.commit(
        (tx) => tx.submissionByRequest(conversation.id, selectedRequest), BACKGROUND_CONTEXT,
      );
      return submission ? this.wait(String(submission.id)) : undefined;
    },
    async wait(submissionId: string): Promise<DurableAnswer> {
      const submission = await harness.submission(submissionId as never, BACKGROUND_CONTEXT);
      if (!submission) throw new Error(`Durable submission ${submissionId} is not in this course`);
      let watching = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const parked = new Promise<never>((_resolve, reject) => {
        timer = setInterval(async () => {
          if (watching) return; watching = true;
          try {
            const inspection = await harness.inspect(BACKGROUND_CONTEXT);
            if (inspection.tasks.some(item => item.record.conversationId === conversation.id && item.state.kind === "blocked")) reject(new Error("Official Pi model task reached its bounded restart limit; inspect the task and explicitly retry or cancel"));
          } catch (error) { reject(error); }
          finally { watching = false; }
        }, 500);
      });
      let settled;
      try { settled = await Promise.race([submission.wait(BACKGROUND_CONTEXT), parked]); }
      finally { if (timer) clearInterval(timer); }
      let memoryFailure: string | undefined;
      let memoryFailureDetail = "";
      const recoveryIds: string[] = [];
      let cursor: unknown;
      do {
        const history = await conversation.entries({
          minEntryId: settled.entry,
          maxEntryId: settled.status === "done" ? settled.answer : undefined,
          order: "ascending",
        }, 1000, cursor as never, BACKGROUND_CONTEXT);
        cursor = history.next;
        for (const record of history.items) {
          if (!ToolResultEntry.is(record)) continue;
          const result = record.model[0];
          if (result?.role !== "toolResult") continue;
          if (result.isError && ["edit", "write", "bash"].includes(result.toolName)) {
            throw new Error(`the ${result.toolName === "edit" ? "revision" : result.toolName} tool failed or its interrupted result is unknown; inspect the retained stage before continuing: ${result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")}`);
          }
          if (!memoryToolNames.includes(result.toolName)) continue;
          if (result.isError) {
            memoryFailure ??= result.toolName;
            memoryFailureDetail = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
          }
          for (const part of result.content) {
            if (part.type !== "text") continue;
            const recoveryId = part.text.match(/Recovery ID: ([0-9a-f-]+)/i)?.[1];
            if (recoveryId) recoveryIds.push(recoveryId);
          }
        }
      } while (cursor);
      const recoveryHelp = recoveryIds.length
        ? `\n${recoveryIds.map((id) => `Recovery ID: ${id}`).join("\n")}\nUse --memory "Restore deletion <Recovery ID>" to recover the forgotten entry.`
        : "";
      if (settled.status !== "done" || settled.type !== "input") {
        if (settled.status === "unanswered" && settled.reason === "model_error") {
          const failure = modelFailure(settled.detail);
          throw recoveryIds.length ? new Error(`${failure.message}${recoveryHelp}`) : failure;
        }
        throw new Error(`Durable submission did not finish: ${JSON.stringify(settled)}`);
      }
      if (memoryFailure) {
        throw new Error(`learner memory operation failed (${memoryFailure}); saving/maintenance did not complete: ${memoryFailureDetail}${recoveryHelp}`);
      }
      const entry = await conversation.commit(async (tx) => {
        const record = await tx.entry(AssistantEntry, settled.answer);
        if (!record) throw new Error("Durable answer was lost after completion");
        return record;
      }, BACKGROUND_CONTEXT);
      const message = entry.model?.[0];
      if (message?.role !== "assistant" || message.stopReason !== "stop") {
        throw new Error(`Durable response failed: incomplete answer (${message?.stopReason ?? "no answer"})`);
      }
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (!text.trim()) throw new Error("Durable response failed: no final answer");
      return {
        conversationId: String(conversation.id),
        submissionId,
        text,
      };
    },
    async retryBlocked() {
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      for (const item of inspection.tasks) if (item.record.conversationId === conversation.id && item.state.kind === "blocked" && item.state.reason === "restart_limit") await harness.retryTask(item.record.id, BACKGROUND_CONTEXT);
    },
    async lastAnswerText() {
      const page = await conversation.entries({ order: "descending" }, 100, undefined, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        if (!AssistantEntry.is(entry)) continue;
        const message = entry.model?.[0];
        if (message?.role === "assistant") return message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      }
      return "";
    },
    async close() {
      await harness.close(BACKGROUND_CONTEXT);
    },
  };
}

export type TutorDurableSession = Awaited<ReturnType<typeof openTutorDurableSession>>;

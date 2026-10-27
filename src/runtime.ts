import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { memoryTools, prepareMemory } from "./memory.ts";
import { stageTools } from "./stage-tools.ts";

const defaultModel = "magpie/codex/gpt-6.1-sol";

export async function imageContent(file: string) {
  const extension = path.extname(file).slice(1).toLowerCase();
  const mimeType = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`;
  const bytes = await readFile(file);
  return { type: "image" as const, data: bytes.toString("base64"), mimeType };
}

export async function createTutorSession(
  courseDir: string,
  agentDir: string | undefined,
  model: string | undefined,
  options?: { systemPrompt?: string; tools?: string[]; sessionManager?: SessionManager; writeRoot?: string },
): Promise<AgentSession> {
  const tools = options?.tools ?? ["read"];
  if (tools.some((tool) => ["write", "edit", "bash"].includes(tool)) && !options?.writeRoot) {
    throw new Error("Writable Tutor tools require a lecture stage");
  }
  const effectiveAgentDir = agentDir ?? getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(effectiveAgentDir, "auth.json"),
    modelsPath: path.join(effectiveAgentDir, "models.json"),
  });
  const requested = resolveCliModel({ cliModel: model ?? defaultModel, modelRuntime });
  if (requested.error) throw new Error(`Pi model is unavailable: ${requested.error}`);
  if (!requested.model?.input.includes("image")) {
    throw new Error(`Pi model ${requested.model?.provider}/${requested.model?.id} cannot read course images`);
  }

  const memory = await prepareMemory(courseDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: courseDir,
    agentDir: effectiveAgentDir,
    additionalExtensionPaths: [memory.extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: [options?.systemPrompt, memory.systemPrompt].filter(Boolean).join("\n\n"),
  });
  await resourceLoader.reload();
  const extensionFailure = resourceLoader.getExtensions().errors[0];
  if (extensionFailure) throw new Error(`learner memory extension failed to load: ${extensionFailure.error}`);
  const { session } = await createAgentSession({
    cwd: courseDir,
    agentDir: effectiveAgentDir,
    modelRuntime,
    model: requested.model,
    tools: [...tools, ...memoryTools],
    customTools: options?.writeRoot ? await stageTools(courseDir, options.writeRoot) : [],
    resourceLoader,
    sessionManager: options?.sessionManager ?? SessionManager.inMemory(),
  });
  return session;
}

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
  options?: { systemPrompt?: string; tools?: string[] },
): Promise<AgentSession> {
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

  const resourceLoader = new DefaultResourceLoader({
    cwd: courseDir,
    agentDir: effectiveAgentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options?.systemPrompt,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: courseDir,
    agentDir: effectiveAgentDir,
    modelRuntime,
    model: requested.model,
    tools: options?.tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
  });
  return session;
}

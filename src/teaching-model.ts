import { constants } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NeedsAttention } from "./teaching.ts";
import { openTutorDurableSession, type DurablePromptPart } from './durable.ts';
import { stageTools } from './stage-tools.ts';
import type { ToolRegistration } from '@earendil-works/pi-durable';

export type TeachingModel = { stage: string; requestId: string; original?: string; retryBlocked?: boolean; signal: AbortSignal };
export async function teachingPrompt(options: {
  courseDir: string; agentDir?: string; model?: string; key: string; systemPrompt: string;
  prompt: string; images?: DurablePromptPart[]; feedback?: string; stage?: string; toolNames?: string[]; signal?: AbortSignal; retryBlocked?: boolean;
}) {
  const tools: ToolRegistration[] = options.stage ? (await stageTools(options.courseDir, options.stage, options.agentDir))
    .filter(tool => options.toolNames?.includes(tool.name))
    .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
      replay: 'unsafe', executionMode: 'sequential', callers: ['model'],
      async execute(args, api) {
        const result = await tool.execute(String(api.taskId), args as never, options.signal);
        return { output: result.content as never, details: result.details as never, isError: result.isError };
      },
    })) : [];
  const session = await openTutorDurableSession({ courseDir: options.courseDir, agentDir: options.agentDir, model: options.model,
    channel: options.key.endsWith(":memory") ? "memory" : "route", conversationKey: options.key, systemPrompt: options.systemPrompt, tools });
  const abort = () => { void session.close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    if (options.retryBlocked) await session.retryBlocked();
    const previous = await session.resumeSubmission(options.key);
    if (previous) return previous.text;
    const receipt = await session.submit({ requestId: options.key,
      content: [{ type: 'text', text: options.prompt }, ...options.images ?? []], learnerFeedback: options.feedback });
    return (await session.wait(receipt.submissionId)).text;
  } catch (error) {
    if (options.stage && options.toolNames?.includes("write") && !options.signal?.aborted) {
      const partial = await session.lastAnswerText();
      if (partial) await writeFile(path.join(options.stage, "content.md"), partial, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW });
    }
    if (error instanceof Error && !/restart limit/i.test(error.message) && /Pi response failed|Durable response failed|Durable submission did not finish|learner memory operation failed/.test(error.message)) throw new NeedsAttention(`${error.message}. The original model submission ended; inspect the result, cancel and explicitly submit new work if needed.`, true);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await session.close();
  }
}

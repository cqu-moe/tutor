import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { createTutorSession, imageContent } from "./runtime.ts";
import type { Context } from "./types.ts";

export async function proposeRoute(context: Context, courseDir: string, agentDir: string | undefined, model: string | undefined) {
  const session = await createTutorSession(courseDir, agentDir, model, {
    systemPrompt: "You are a careful course tutor. Ground claims in supplied course material and cite original pages.",
    tools: ["read"],
  });

  const originalImages = [
    ...context.pages.map((page) => page.originalPageImage),
    ...context.screenshots.map((screenshot) => screenshot.source),
  ];
  const images = await Promise.all(originalImages.map(imageContent));
  const sources = [
    ...context.pages.map((page) => `PDF page ${page.sourcePage}\n${page.markdown}`),
    ...context.screenshots.map((screenshot) => `Screenshot ${screenshot.name}\n${screenshot.markdown}`),
  ].join("\n\n");
  const ask = `Course: ${context.course}\n\n${sources}\n\nCompare the parsed formulas, tables, and figures with the attached original pages. Propose a teaching route for this exact range. Return only Markdown with: Scope, Prerequisites, Teaching order, and Material doubts. Include page citations.`;
  let output = "";
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const queuedLines: string[] = [];
  const lineWaiters: Array<(line: string | undefined) => void> = [];
  let inputClosed = false;
  lines.on("line", (line) => {
    const resolve = lineWaiters.shift();
    if (resolve) resolve(line);
    else queuedLines.push(line);
  });
  lines.on("close", () => {
    inputClosed = true;
    for (const resolve of lineWaiters.splice(0)) resolve(undefined);
  });
  const nextLine = () => queuedLines.length
    ? Promise.resolve(queuedLines.shift()!)
    : Promise.resolve(inputClosed ? undefined : new Promise<string | undefined>((resolve) => lineWaiters.push(resolve)));
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
      output += event.assistantMessageEvent.delta;
    }
  });
  await session.prompt(ask, { images });
  if (!output.trim()) {
    const failure = session.agent.state.errorMessage ?? "the model returned no route";
    session.dispose();
    throw new Error(`Pi route generation failed: ${failure}`);
  }

  process.stdout.write("\n\nType an adjustment, or type 'confirm' to confirm the route.\n> ");
  for (;;) {
    const line = await nextLine();
    if (line === undefined) {
      lines.close();
      await writeFile(path.join(courseDir, "route-draft.md"), `${output.trim()}\n`);
      process.stdout.write("\nRoute was not confirmed; the proposed route remains saved locally.\n");
      session.dispose();
      return;
    }
    if (line.trim().toLowerCase() === "confirm") {
      context.confirmedAt = new Date().toISOString();
      lines.close();
      await writeFile(path.join(courseDir, "context.json"), JSON.stringify(context, null, 2));
      await writeFile(path.join(courseDir, "route.md"), `${output.trim()}\n`);
      process.stdout.write("Teaching route confirmed.\n");
      session.dispose();
      return;
    }
    if (!line.trim()) continue;
    process.stdout.write("\n");
    const current = output;
    output = "";
    await session.prompt(`Adjust this teaching route. Return the complete revised route only.\n\nCurrent route:\n${current}\n\nUser adjustment: ${line}`);
    if (!output.trim()) {
      const failure = session.agent.state.errorMessage ?? "the model returned no revised route";
      lines.close();
      session.dispose();
      throw new Error(`Pi route adjustment failed: ${failure}`);
    }
    process.stdout.write("\n\nType an adjustment, or type 'confirm' to confirm the route.\n> ");
  }
}

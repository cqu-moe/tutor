import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { imageContent } from "./runtime.ts";
import { openTutorDurableSession, type DurablePromptPart, type TutorDurableSession } from "./durable.ts";
import { selectionScope } from "./selection.ts";
import { saveDraft, type Lecture } from "./lecture-state.ts";
import { readCourse } from "./course-state.ts";

export function createTerminalInput() {
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
  return {
    nextLine: () => queuedLines.length
      ? Promise.resolve(queuedLines.shift()!)
      : Promise.resolve(inputClosed ? undefined : new Promise<string | undefined>((resolve) => lineWaiters.push(resolve))),
    close: () => lines.close(),
  };
}

export async function proposeRoute(
  lecture: Lecture,
  courseDir: string,
  agentDir: string | undefined,
  model: string | undefined,
  input = createTerminalInput(),
  resume = false,
) {
  const { context } = lecture;
  // Prose changes during adjustments; explicit chapter-title corrections instead
  // establish new authority and must not be replaced by an older model answer.
  const course = await readCourse(courseDir, context.course);
  const chapters = course.chapters.map(({ id, title }) => ({ id, title }));
  const resumeKey = createHash("sha256").update(JSON.stringify({ context, chapters })).digest("hex");
  const session = await openTutorDurableSession({
    courseDir,
    agentDir,
    model,
    systemPrompt: "You are a careful course tutor. Ground claims in supplied course material and cite original pages.",
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
  const ask = `Course: ${context.course}${selectionScope(context.selection)}\n\nDurable course chapter order (title authority; keep every title, omit nothing, and add no numbered chapter):\n${lecture.route}\n\n${sources}\n\nCompare the parsed formulas, tables, and figures with the attached original pages. Propose a teaching route for this accumulated material. Return only Markdown with: Scope, Prerequisites, Teaching order, and Material doubts. The numbered Teaching order must contain exactly the durable courseware chapter titles. Include page citations.`;
  let output = "";
  let confirmed = false;
  try {
    if (!resume) await session.reset();
    output = resume
      ? await resumeDurable(session, ask, images, lecture.route, resumeKey)
      : await askDurable(session, ask, images, resumeKey);
    process.stdout.write(output);
    if (!output.trim()) {
      throw new Error("Pi route generation failed: the model returned no route");
    }
    lecture.route = output.trim();
    await saveDraft(courseDir, lecture);

    process.stdout.write("\n\nType an adjustment, or type 'confirm' to confirm the route.\n> ");
    process.send?.({ type: "route", route: lecture.route });
    for (;;) {
      const line = await input.nextLine();
      if (line === undefined) {
        process.stdout.write("\nRoute was not confirmed; the proposed route remains saved locally.\n");
        return;
      }
      if (line.trim().toLowerCase() === "confirm") {
        context.confirmedAt = new Date().toISOString();
        confirmed = true;
        await saveDraft(courseDir, lecture);
        process.stdout.write("Teaching route confirmed.\n");
        return;
      }
      if (!line.trim()) continue;
      process.stdout.write("\n");
      const current = output;
      output = "";
      output = await askDurable(session, `Adjust this teaching route. Record any explicit learner feedback before responding. Return the complete revised route.\n\nCurrent route:\n${current}\n\nUser adjustment: ${line}`, [], resumeKey, line);
      process.stdout.write(output);
      if (!output.trim()) {
        throw new Error("Pi route adjustment failed: the model returned no revised route");
      }
      lecture.route = output.trim();
      await saveDraft(courseDir, lecture);
      process.stdout.write("\n\nType an adjustment, or type 'confirm' to confirm the route.\n> ");
      process.send?.({ type: "route", route: lecture.route });
    }
  } finally {
    if (!confirmed) input.close();
    await session.close();
  }
}

async function askDurable(session: TutorDurableSession, prompt: string, images: DurablePromptPart[] = [], resumeKey?: string, learnerFeedback?: string) {
  const content = [{ type: "text" as const, text: prompt }, ...images];
  const requestId = randomUUID();
  const receipt = await session.submit({ content, requestId, resumeKey, learnerFeedback });
  const answer = await session.wait(receipt.submissionId);
  return answer.text;
}

async function resumeDurable(
  session: TutorDurableSession,
  prompt: string,
  images: DurablePromptPart[],
  savedRoute: string,
  resumeKey: string,
) {
  const content = [{ type: "text" as const, text: prompt }, ...images];
  const requestId = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const answer = await session.resumeSubmission(requestId, resumeKey);
  return answer?.text ?? savedRoute;
}

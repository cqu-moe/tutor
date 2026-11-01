#!/usr/bin/env bun
import "./assets.ts";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createTerminalInput } from "./model.ts";
import { claimCourseDirectory, courseDirectory, ensureCourse, chapterLine, resolveChapterTitle, updateChapterProgress, type ChapterProgress } from "./course-state.ts";
import { normalizedText } from "./materials.ts";
import { ownDataDirectory } from "./ownership.ts";
import { openTeachingCenter, teachingConfig, type TeachingView } from "./teaching.ts";
import pkg from "../package.json";

let owner: Awaited<ReturnType<typeof ownDataDirectory>> | undefined;
let agentDirForDiagnostics: string | undefined;

function addConfiguredSecret(secrets: string[], value: unknown) {
  if (typeof value !== "string" || !value || value.startsWith("$!") || value.startsWith("$$")) return;
  if (value.startsWith("$")) {
    for (const [, braced, plain] of value.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const secret = process.env[braced ?? plain];
      if (secret) secrets.push(secret);
    }
    return;
  }
  secrets.push(value);
}

function collectSecrets(value: unknown, secrets: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, secrets);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (["apiKey", "key", "token", "access", "refresh", "accessToken", "refreshToken", "authorization"].includes(key)) {
      addConfiguredSecret(secrets, item);
    }
    if (key === "headers" && typeof item === "object" && item !== null) {
      for (const header of Object.values(item)) addConfiguredSecret(secrets, header);
    }
    if (key === "env" && typeof item === "object" && item !== null) {
      for (const secret of Object.values(item)) if (typeof secret === "string") secrets.push(secret);
    }
    collectSecrets(item, secrets);
  }
}

async function redactedMessage(raw: string, agentDir: string | undefined) {
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(name) && value)
    .map(([, value]) => value!);
  for (const file of ["models.json", "auth.json"]) {
    try {
      collectSecrets(JSON.parse(await readFile(path.join(agentDir ?? "", file), "utf8")), secrets);
    } catch {
      // Missing or invalid model configuration must not hide the original error.
    }
  }
  return secrets.reduce((message, secret) => message.split(secret).join("[redacted]"), raw);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      "task-id": { type: "string" },
      cancel: { type: "boolean" },
      confirm: { type: "boolean" },
      retry: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      "env-file": { type: "string" },
      course: { type: "string" },
      pdf: { type: "string" },
      pages: { type: "string" },
      chapter: { type: "string" },
      "chapter-id": { type: "string" },
      chapters: { type: "boolean" },
      "confirm-chapter": { type: "boolean" },
      title: { type: "string" },
      progress: { type: "string" },
      screenshots: { type: "string", multiple: true },
      "data-dir": { type: "string", default: ".tutor" },
      "agent-dir": { type: "string" },
      model: { type: "string" },
      memory: { type: "string" },
      generate: { type: "boolean" },
      resume: { type: "boolean" },
      port: { type: "string", default: "4318" },
      "no-open": { type: "boolean" },
      revise: { type: "string" },
      ocr: { type: "string", default: "mineru" },
      "mineru-base-url": { type: "string", default: "https://mineru.net" },
      "mistral-base-url": { type: "string", default: "https://api.mistral.ai" },
    },
  });
  if (values["env-file"] !== undefined) {
    try { loadEnvFile(values["env-file"]); }
    catch { throw new Error("Cannot read --env-file; check its path and permissions"); }
  }
  agentDirForDiagnostics = values["agent-dir"] ?? getAgentDir();
  if (values.version) { console.log(`tutor ${pkg.version}`); return; }
  if (values.help) {
    console.log(`Tutor — generate and revise course lectures\n\nUsage:\n  tutor [--env-file FILE] gui [--port 4318] [--no-open]\n  tutor [--env-file FILE] doctor [--ocr mineru|mistral] [--agent-dir DIR] [--model PROVIDER/MODEL]\n  tutor [--env-file FILE] --course NAME --pdf FILE (--pages RANGE | --chapter TITLE)\n  tutor [--env-file FILE] --course NAME --generate\n  tutor [--env-file FILE] --course NAME --revise FEEDBACK\n  tutor [--env-file FILE] --course NAME --memory REQUEST\n\nOptions:\n  tasks --json         List durable tasks and preserved unadmitted work\n  --task-id ID --resume Resume the original teaching task\n  --task-id ID --confirm Persist route confirmation and continue\n  --task-id ID --cancel Terminal explicit cancellation\n  --task-id ID --retry  Retry a diagnosed local failure\n  --resume             Resume the latest admitted task in this course\n  --data-dir DIR       Course storage (default: .tutor)\n  --agent-dir DIR      Pi models.json and auth.json directory\n  --model ID           Vision-capable provider/model\n  --ocr PROVIDER       mineru (default) or mistral\n  --screenshots FILE   Additional image; repeat for multiple images\n  --env-file FILE      Explicit environment file; existing environment wins\n  --help, --version\n\nInstall external dependencies: docs/install.md\nNo .env file is loaded automatically. Doctor makes no model/OCR requests.`);
    return;
  }
  if (positionals.length) {
    if (positionals.length === 1 && positionals[0] === "gui") {
      const { startGui } = await import("./gui.ts");
      await startGui({
        dataDir: values["data-dir"]!, agentDir: values["agent-dir"], model: values.model,
        ocr: values.ocr!, port: Number(values.port), open: !values["no-open"],
        mineruBaseUrl: values["mineru-base-url"]!, mistralBaseUrl: values["mistral-base-url"]!,
      });
      return;
    }
    if (positionals.length === 1 && positionals[0] === "tasks") {
      owner = await ownDataDirectory(values["data-dir"]!);
      const center = await openTeachingCenter(owner.root);
      try {
        const state = { tasks: await center.list(), pending: await center.pending() };
        console.log(values.json ? JSON.stringify(state) : [...state.tasks.map(task => `${task.id} · ${task.course} · ${task.status} · ${task.stage}\n${task.log}\n${task.continuation ?? ""}`), ...state.pending.map(item => `${item.path}: ${item.reason}`)].join("\n"));
      } finally { await center.close(); }
      return;
    }
    if (positionals.length !== 1 || positionals[0] !== "doctor") throw new Error("Unknown command; run tutor --help");
    const { doctor } = await import("./doctor.ts");
    process.exitCode = await doctor({ ocr: values.ocr, agentDir: values["agent-dir"], model: values.model });
    return;
  }
  owner = await ownDataDirectory(values["data-dir"]!);
  if (values["task-id"]) {
    const center = await openTeachingCenter(owner.root);
    try {
      const id = values["task-id"];
      let task = await center.view(id);
      if (values.cancel) task = await center.decide(id, { cancel: true });
      else if (values.confirm) task = await center.decide(id, { confirm: true, route: task.route });
      else if (values.retry) task = await center.decide(id, { retry: true });
      if (values.json && !values.resume && !values.confirm && !values.retry) console.log(JSON.stringify(task));
      else await followTeaching(center, id, Boolean(values.resume || values.confirm || values.retry));
    } finally { await center.close(); }
    return;
  }
  if (!values.course) throw new Error("--course is required");
  const course = normalizedText(values.course);
  const courseDir = await courseDirectory(course, values["data-dir"]!);
  if (values["confirm-chapter"]) {
    if (values.chapters || values.generate || values.resume || values.memory !== undefined || values.revise || values.pdf || values.pages || values.chapter || values.screenshots || values.progress !== undefined) {
      throw new Error("--confirm-chapter only resolves one chapter title; omit the other action options");
    }
    if (!values["chapter-id"]) throw new Error("--confirm-chapter requires --chapter-id");
    if (!values.title?.trim()) throw new Error("--confirm-chapter requires --title");
    await claimCourseDirectory(course, courseDir);
    await ensureCourse(courseDir, course);
    await resolveChapterTitle(courseDir, values["chapter-id"], values.title);
    return;
  }
  if (values.progress !== undefined) {
    if (values.chapters || values.generate || values.resume || values.memory !== undefined || values.revise || values.pdf || values.pages || values.chapter || values.screenshots) {
      throw new Error("--progress only updates one chapter; omit the other action options");
    }
    if (!values["chapter-id"]) throw new Error("--progress requires --chapter-id");
    if (values.progress !== "pending" && values.progress !== "in_progress" && values.progress !== "learned") {
      throw new Error("--progress must be pending, in_progress, or learned");
    }
    await claimCourseDirectory(course, courseDir);
    await ensureCourse(courseDir, course);
    await updateChapterProgress(courseDir, values["chapter-id"], values.progress as ChapterProgress);
    return;
  }
  if (values.chapters) {
    if (values.generate || values.resume || values.memory !== undefined || values.revise || values.pdf || values.pages || values.chapter || values.screenshots) {
      throw new Error("--chapters only displays the course route; omit the action options");
    }
    await claimCourseDirectory(course, courseDir);
    const record = await ensureCourse(courseDir, course);
    console.log(`Course ${record.name} · course ${record.id}`);
    if (!record.chapters.length) console.log("No chapters yet; import courseware or record course memory first.");
    for (const chapter of [...record.chapters].sort((a, b) => a.order - b.order)) {
      console.log(chapterLine(chapter, record.materials.find((material) => material.id === chapter.source.materialId)));
    }
    return;
  }
  const center = await openTeachingCenter(owner.root);
  try {
    let task: TeachingView;
    if (values.resume) {
      if (values.pdf || values.pages || values.chapter || values.screenshots) throw new Error("--resume uses the original admitted inputs; omit new input options");
      const tasks = (await center.list()).filter(task => task.course === course && (values.memory !== undefined ? task.action === "memory" : task.action !== "memory"));
      const latest = tasks.findLast(task => task.status === "awaiting-route") ?? tasks.at(-1);
      if (!latest) {
        if (values.memory !== undefined) throw new Error("No admitted memory request to resume");
        task = await center.admit({ action: "import", course, resumeSaved: true, config: await teachingConfig({ agentDir: values["agent-dir"], model: values.model, ocr: values.ocr, mineruBaseUrl: values["mineru-base-url"], mistralBaseUrl: values["mistral-base-url"] }) });
        console.log(`Saved route explicitly admitted: ${task.id}; legacy sessions remain pending.`);
      } else task = latest;
    } else {
      if (values.generate && (values.pdf || values.pages || values.chapter || values.screenshots)) throw new Error("--generate uses the saved confirmed materials; omit new input options");
      if (values.revise && (values.generate || values.pdf || values.pages || values.chapter || values.screenshots)) throw new Error("--revise uses the saved confirmed lecture; omit import and --generate options");
      const action = values.memory !== undefined ? "memory" : values.revise ? "revise" : values.generate ? "generate" : "import";
      if (action === "memory" && !values.memory?.trim()) throw new Error("--memory requires a learner-memory request");
      if (action === "import") {
        if (!values.pdf) throw new Error("--pdf is required");
        if (values.pages && values.chapter) throw new Error("--pages and --chapter are mutually exclusive");
        if (!values.pages && !values.chapter) throw new Error("--pages or --chapter is required");
        if (!values.pdf.toLowerCase().endsWith(".pdf")) throw new Error("--pdf must point to a PDF file");
        for (const file of values.screenshots ?? []) if (!/\.(png|jpe?g|webp)$/i.test(file)) throw new Error(`Unsupported screenshot type: ${path.basename(file)}`);
      }
      task = await center.admit({ action, course, config: await teachingConfig({ agentDir: values["agent-dir"], model: values.model, ocr: values.ocr, mineruBaseUrl: values["mineru-base-url"], mistralBaseUrl: values["mistral-base-url"] }),
        pdf: values.pdf, pages: values.pages, chapter: values.chapter, screenshots: values.screenshots, chapterId: values["chapter-id"], feedback: values.memory ?? values.revise });
      (task.action === "memory" ? console.error : console.log)(`Teaching task admitted: ${task.id}`);
      process.send?.({ type: "admitted", task });
    }
    await followTeaching(center, task.id, true);
  } finally { await center.close(); }
}

async function followTeaching(center: Awaited<ReturnType<typeof openTeachingCenter>>, id: string, resume: boolean) {
  const input = createTerminalInput();
  if (resume) center.resume();
  let shown = "";
  try {
    for (;;) {
      const task = await center.view(id);
      if (task.status === "succeeded" || task.status === "cancelled") {
        if (task.action !== "memory") console.log(`Task ${id}: ${task.status}`);
        if (task.status === "cancelled" || task.action === "memory" || task.output === "") return;
        const line = await input.nextLine();
        if (line === undefined || line.trim().toLowerCase() === "done") return;
        if (!line.trim()) continue;
        const next = await center.admitRevision(id, line); id = next.id; center.resume(); continue;
      }
      if (task.status === "needs-attention" || task.status === "failed") throw new Error(`Task ${id} needs attention: ${task.log}\nContinue: ${task.continuation}; use --retry for a diagnosed local failure or --cancel to stop.`);
      if (!resume) { console.log(JSON.stringify(task)); return; }
      if (task.status === "awaiting-route") {
        if (shown !== task.route) {
          console.log(`${task.route}\n\nType an adjustment, or type 'confirm' to confirm the route.\n> `);
          process.send?.({ type: "route", route: task.route, taskId: id }); shown = task.route!;
        }
        const line = await input.nextLine();
        if (line === undefined) { console.log("Route was not confirmed; the proposed route remains saved locally."); return; }
        if (!line.trim()) continue;
        await center.decide(id, line.trim().toLowerCase() === "confirm" ? { confirm: true, route: task.route } : { feedback: line });
        // The document is committed before its task observes it.
        await new Promise(resolve => setTimeout(resolve, 25));
      } else await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { input.close(); }
}

try {
  await main();
} catch (error) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = await redactedMessage(raw, agentDirForDiagnostics);
  console.error(`tutor: ${message}`);
  process.exitCode = 1;
} finally {
  owner?.close();
  process.disconnect?.();
}

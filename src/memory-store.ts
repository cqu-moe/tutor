import { createHash, randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ensureCourse, readCourse, updateChapterProgress, type ChapterProgress, type CourseRecord } from "./course-state.ts";

type Fact = { id: string; scope: string; content: string };
type Progress = { chapterId: string; status: ChapterProgress };
type Recovery = { id: string; scope: string; facts: Fact[]; progress: Progress[]; restoredAt: string | null };
type Receipt = { courseId: string; signature: string; text: string; progress: Progress[]; done: boolean };
type MemoryState = {
  facts: Fact[]; recovery: Recovery[]; pending: { id: string; content: string; source: string }[];
  legacy: { captured: boolean; files: Record<string, string> };
  imported: string[]; receipts: Record<string, Receipt>;
};
const MemoryDoc = defineDoc<MemoryState>({
  kind: "tutor.learner-memory", version: 1, scope: "session",
  initial: () => ({ facts: [], recovery: [], pending: [], legacy: { captured: false, files: {} }, imported: [], receipts: {} }),
  checkpointWhen: () => true,
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const memoryDirectory = (courseDir: string) => path.resolve(process.env.PI_MEMORY_DIR || path.join(path.dirname(courseDir), ".memory"));
const temporary = (feedback: string) => /(?:only (?:for )?this (?:time|reply|route|response|answer)|only for now|this (?:time|reply|route) only|just (?:this (?:time|reply|route)|for now)|仅(?:这次|本次)|只(?:在|对)?(?:这次|本次)|临时)/i.test(feedback);
function explicitGlobal(feedback: string) {
  // Mentioning a scope while excluding it does not grant access to that scope.
  const courseOnly = /(?:\b(?:only|just)(?: for)? (?:this|the current) course\b|\b(?:this|the current) course only\b|(?:仅|只)(?:对|在|修改|删除|恢复)?(?:本|这门|当前)课)/i;
  const excludedGlobal = /(?:\b(?:not|never|except|excluding|don't|do not)\b[^.;:，。；\n]*\b(?:global(?:ly)?|across courses|all (?:(?:my|future|other) )*courses)\b|(?:不|别|勿)[^，。；\n]*(?:全局|跨课|所有课|全部课|以后都这样))/i;
  return !courseOnly.test(feedback) && !excludedGlobal.test(feedback)
    && /(?:\b(?:across courses|all (?:(?:my|future|other) )*courses|globally|global (?:[a-z-]+ )*(?:preferences?|memory|scope))\b|所有课|全部课|全局|跨课|以后都这样)/i.test(feedback);
}

function readOnlyRequest(feedback: string) {
  const query = /^\s*(?:(?:(?:please|can you|could you|would you)\s+)*(?:show|list|read|display|view|tell me|what|which|how|do you|have you)\b|(?:请|帮我|能否|可以)?(?:查看|查询|显示|列出|读取|展示|看看)|请问)/i;
  return query.test(feedback) && /(?:\b(?:memory|memories|preferences?|progress|chapters?|remember|saved|stored|learned)\b|记忆|偏好|进度|章节|记录|学完)/i.test(feedback);
}

// pi-memory's generated timestamp owns the whole entry, including blank lines.
function legacyBlocks(content: string) {
  const meta = /^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
  const blocks: string[] = [];
  let lines: string[] = []; let stamped = false;
  const flush = () => {
    const value = lines.join("\n").trim();
    if (value) blocks.push(...(stamped ? [value] : value.split(/\n{2,}/).filter(Boolean)));
  };
  for (const line of content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "").split("\n")) {
    if (meta.test(line)) { flush(); lines = [line]; stamped = true; }
    else lines.push(line);
  }
  flush(); return blocks;
}

async function optionalFile(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function aliases(courseDir: string) {
  const candidates = new Map<string, Set<string>>();
  for (const entry of await readdir(path.dirname(courseDir), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(path.dirname(courseDir), entry.name);
    // Other courses are read only for identity mapping. Missing/unreadable
    // identities remain pending until that course can be explicitly established.
    let course: CourseRecord;
    try {
      const raw = await optionalFile(path.join(dir, "course.json"));
      if (!raw) continue;
      course = JSON.parse(raw);
      if (typeof course.id !== "string" || typeof course.name !== "string") continue;
    } catch { continue; }
    for (const alias of [entry.name, course.name, course.id]) {
      const key = alias.normalize("NFC").toLowerCase();
      const ids = candidates.get(key) ?? new Set<string>(); ids.add(course.id); candidates.set(key, ids);
    }
  }
  return new Map([...candidates].filter(([, ids]) => ids.size === 1).map(([alias, ids]) => [alias, [...ids][0]]));
}
function legacyScope(content: string, names: Map<string, string>): string | undefined {
  const tags = [...content.matchAll(/\[\[course:([^\]]+)\]\]/g)].map((m) => names.get(m[1].normalize("NFC").toLowerCase()));
  const global = /\[\[learner-global\]\]|#global\b/.test(content);
  if (global && !tags.length && /#preference\b/.test(content) && !/#(?:progress|weakness)\b/.test(content)) return "global";
  if (!global && tags.length && tags.every((tag) => tag && tag === tags[0])) return tags[0];
}

function activeLegacyFact(content: string) {
  const preference = /#preference\b/.test(content), weakness = /#weakness\b/.test(content);
  if (/#progress\b/.test(content) || preference === weakness) return false;
  return preference || /Evidence:\s*\S/i.test(content) && /Status:\s*pending verification/i.test(content);
}

function progressClaim(evidence: string): ChapterProgress | undefined {
  if (/^\s*(?:(?:please\s+)?(?:show|list|read|display|what|which)\b|请?(?:查看|查询|显示|列出|读取))|[?？]|\b(?:maybe|might|guess|whether)\b|可能|推测/i.test(evidence)) return;
  const pending = /(?:(?:not|haven['’]t|have not|never|didn['’]t)(?: yet)? (?:learned|mastered|completed|studied|finished|started)|not (?:currently )?(?:learning|studying|in_progress)|尚未学习|还没学|还没有学|没学会|没学完|未掌握|未完成|未学|未开始|\bpending\b)/i;
  const active = /(?:in_progress|currently (?:learning|studying)|正在学|在学)/i;
  const learned = /(?:already learned|have learned|已学完|已经学完|学完了|学会了|已掌握|已完成|\b(?:learned|completed|mastered)\b)/i;
  const claims = [pending.test(evidence), active.test(evidence), learned.test(evidence.replace(new RegExp(pending.source, "gi"), ""))];
  if (claims.filter(Boolean).length !== 1) return;
  return claims[0] ? "pending" : claims[1] ? "in_progress" : "learned";
}

function legacyProgress(content: string, course: CourseRecord): Progress | undefined {
  const matches = course.chapters.filter((chapter) => content.includes(chapter.id) || new RegExp(`${chapter.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：]`, "i").test(content));
  if (matches.length !== 1 || matches[0].needsConfirmation) return;
  const status = progressClaim(content);
  return status ? { chapterId: matches[0].id, status } : undefined;
}

async function migrate(state: MemoryState, directory: string, names: Map<string, string>, course: CourseRecord, migrateProgress: boolean) {
  // Originals are immutable migration inputs, never the active writer after upgrade.
  if (!state.legacy.captured) {
    const files: Record<string, string> = {};
    for (const file of ["MEMORY.md", "SCRATCHPAD.md"]) {
      const content = await optionalFile(path.join(directory, file));
      if (content !== undefined) files[file] = content;
    }
    for (const subdirectory of ["daily", "recovery"]) {
      try {
        for (const file of await readdir(path.join(directory, subdirectory))) {
          files[`${subdirectory}/${file}`] = await readFile(path.join(directory, subdirectory, file), "utf8");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    state.legacy.files = files;
    state.legacy.captured = true;
  }
  const inputs = Object.entries(state.legacy.files).filter(([source]) => !source.startsWith("recovery/"))
    .map(([source, content]) => ({ source, content, active: source === "MEMORY.md" }));
  for (const { source, content, active } of inputs) {
    for (const [index, block] of legacyBlocks(content).entries()) {
      const id = `legacy:${hash(`${source}:${index}:${block}`)}`;
      if (state.imported.includes(id)) continue;
      const scope = active ? legacyScope(block, names) : undefined;
      const progress = migrateProgress && scope === course.id && /#progress\b/.test(block) ? legacyProgress(block, course) : undefined;
      const chapter = progress && course.chapters.find((chapter) => chapter.id === progress.chapterId);
      if (progress && chapter && (!chapter.progressUpdatedAt || chapter.status === progress.status)) {
        state.receipts[id] = { courseId: course.id, signature: hash(block), text: "Migrated legacy progress", progress: [progress], done: false };
        state.imported.push(id); state.pending = state.pending.filter((entry) => entry.id !== id);
      } else if (scope && activeLegacyFact(block)) {
        state.facts.push({ id, scope, content: block }); state.imported.push(id);
        state.pending = state.pending.filter((entry) => entry.id !== id);
      } else if (!state.pending.some((entry) => entry.id === id)) state.pending.push({ id, content: block, source });
    }
  }
  for (const [source, raw] of Object.entries(state.legacy.files).filter(([source]) => source.startsWith("recovery/") && source.endsWith(".json"))) {
    const file = path.basename(source);
    const id = `recovery:${file}`;
    if (state.imported.includes(id)) continue;
    const record = JSON.parse(raw);
    if (record.version !== 1 || typeof record.id !== "string" || !Array.isArray(record.removedContent)
      || !record.removedContent.every((value: unknown) => typeof value === "string")) throw new Error(`Invalid legacy memory recovery: ${file}`);
    const scopes = record.removedContent.map((block: string) => legacyScope(block, names));
    const scope = scopes[0];
    const progressBlocks = record.removedContent.filter((block: string) => /#progress\b/.test(block));
    const mappedProgress = migrateProgress && scope === course.id ? progressBlocks.map((block: string) => legacyProgress(block, course)) : [];
    if (record.target === "long_term" && scope && scopes.every((value: string) => value === scope)
      && mappedProgress.length === progressBlocks.length && mappedProgress.every(Boolean)
      && record.removedContent.filter((block: string) => !/#progress\b/.test(block)).every(activeLegacyFact)) {
      state.recovery.push({ id: record.id, scope,
        facts: record.removedContent.filter((block: string) => !/#progress\b/.test(block)).map((content: string, i: number) => ({ id: `${id}:${i}`, scope, content })),
        progress: mappedProgress, restoredAt: record.restoredAt ?? null });
      state.imported.push(id); state.pending = state.pending.filter((entry) => entry.id !== id);
    } else if (!state.pending.some((entry) => entry.id === id)) state.pending.push({ id, content: raw, source: `recovery/${file}` });
  }
}

// Only official Pi document transactions persist memory. This kernel has no tasks,
// submissions or model history; the existing course Harness owns all execution.
async function withStore<T>(courseDir: string, change: (state: MemoryState) => Promise<T>) {
  const directory = memoryDirectory(courseDir);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "memory.sqlite");
  try { await access(file, constants.R_OK | constants.W_OK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const session = createSession(await openNodeSqliteStorage(file));
  try {
    return await session.commit(async (tx) => change(await tx.doc(MemoryDoc)), BACKGROUND_CONTEXT);
  } finally { await session.close(BACKGROUND_CONTEXT); }
}

export async function prepareMemoryStore(courseDir: string, migrateProgress = true) {
  const name = (await readFile(path.join(courseDir, ".course-name"), "utf8")).trim();
  const course = await ensureCourse(courseDir, name);
  const names = await aliases(courseDir);
  const unfinished = await withStore(courseDir, async (state) => {
    await migrate(state, memoryDirectory(courseDir), names, course, migrateProgress);
    return Object.entries(state.receipts).filter(([, receipt]) => receipt.courseId === course.id && !receipt.done)
      .map(([id, receipt]) => ({ id, progress: receipt.progress.map((item) => ({ chapterId: item.chapterId, status: item.status })) }));
  });
  for (const receipt of migrateProgress ? unfinished : []) await applyProgress(courseDir, receipt.id, receipt.progress);
  return course.id;
}

export type MemoryAccess = { learnerFeedback?: string };
export type MemoryArgs = {
  target?: string; scope?: string; content?: string; mode?: string; match?: string; recoveryId?: string;
  chapterId?: string; status?: ChapterProgress; evidence?: string; inferred?: boolean;
};
const text = (content: string) => ({ content: [{ type: "text" as const, text: content }],
  details: { recoveryId: content.match(/Recovery ID: ([0-9a-f-]+)/i)?.[1] ?? null } });

export async function readMemory(courseDir: string, courseId: string, scope?: string) {
  if (scope && scope !== "global" && scope !== "course" && scope !== courseId) throw new Error("Memory scope must be the current course or explicit global");
  const course = await readCourse(courseDir);
  if (course.id !== courseId) throw new Error("Memory identity must match the current persisted course");
  return withStore(courseDir, async (state) => {
    const visible = state.facts.filter((fact) => scope === "global" ? fact.scope === "global" : fact.scope === courseId || fact.scope === "global");
    const lines = ["Global preferences (fallback):", ...visible.filter((fact) => fact.scope === "global").map((fact) => fact.content),
      "Current course facts (override global):", ...visible.filter((fact) => fact.scope === courseId).map((fact) => fact.content)];
    if (scope !== "global") lines.push("Chapter progress (course route authority):", ...course.chapters.map((chapter) =>
      `#progress [[course:${courseId}]] chapterId=${chapter.id} ${chapter.title}: ${chapter.status}`));
    if (!visible.length && !course.chapters.length) lines.push("Learner memory is empty or does not exist.");
    const recoveries = state.recovery.filter((record) => record.scope === (scope === "global" ? "global" : courseId));
    lines.push(...recoveries.filter((record) => !record.restoredAt).map((record) => `Recovery ID: ${record.id}`));
    // Pending input is not model context. Only its count is safe to disclose.
    lines.push(`Unassigned legacy records pending: ${state.pending.length}. Originals preserved; no pending content is injected.`);
    return lines.join("\n");
  });
}

export async function executeMemory(courseDir: string, courseId: string, name: string, args: MemoryArgs, invocationId: string, access: MemoryAccess) {
  if (args.target && args.target !== "long_term") throw new Error("Only long_term learner memory is supported");
  if (name === "memory_read") return text(await readMemory(courseDir, courseId, args.scope));
  if (!access.learnerFeedback?.trim()) throw new Error("Memory mutation requires explicit learner feedback, not generation/import/export");
  if (temporary(access.learnerFeedback)) throw new Error("A temporary request cannot change durable memory");
  const signature = hash(JSON.stringify({ name, args, courseId }));
  const receipt = await withStore(courseDir, async (state) => {
    if (state.receipts[invocationId]) {
      if (state.receipts[invocationId].signature !== signature) throw new Error("Memory invocation identity was reused with different arguments");
      return JSON.parse(JSON.stringify(state.receipts[invocationId])) as Receipt;
    }
    const content = args.content?.trim() ?? "";
    const tags = [...content.matchAll(/\[\[course:([^\]]+)\]\]/g)].map((match) => match[1]);
    const course = await readCourse(courseDir);
    if (course.id !== courseId) throw new Error("Memory identity must match the current persisted course");
    const allowedTags = [courseId, course.name, path.basename(courseDir)];
    if (tags.some((tag) => !allowedTags.includes(tag))) throw new Error("Cannot write another course's memory");
    const global = args.scope === "global" || /\[\[learner-global\]\]|#global\b/.test(content);
    if (args.scope && !["course", "global", courseId].includes(args.scope)) throw new Error("Memory scope must be the current course or explicit global");
    if (global && (tags.length || args.scope && args.scope !== "global")) throw new Error("Mixed memory scopes are not allowed");
    const scope = global ? "global" : courseId;
    if (readOnlyRequest(access.learnerFeedback!)) throw new Error("A read-only request cannot change learner memory");
    if (global && !explicitGlobal(access.learnerFeedback!)) throw new Error("Global mutations require explicit cross-course learner intent");
    let result: Receipt = { courseId, signature, text: "", progress: [], done: true };
    if (name === "memory_write") {
      if (!content) throw new Error("Memory content is required");
      if (args.mode && args.mode !== "append") throw new Error("Only append is supported; correct with scoped forget then write");
      const kinds = [/#progress\b/.test(content), /#preference\b/.test(content), /#weakness\b/.test(content) || Boolean(args.inferred)];
      if (kinds.filter(Boolean).length !== 1 && !args.chapterId) throw new Error("Use one fact kind: #preference, #weakness or structured #progress");
      const progress = Boolean(args.chapterId || args.status || /#progress\b/.test(content));
      if (progress) {
        if (global || !args.chapterId || !["pending", "in_progress", "learned"].includes(args.status ?? "")) throw new Error("Progress requires current chapterId and status; unbound prose is not progress authority");
        if (!course.chapters.some((chapter) => chapter.id === args.chapterId)) throw new Error("Unknown current-course chapter");
        if (!args.evidence || !access.learnerFeedback!.includes(args.evidence)) throw new Error("Progress requires a verbatim learner-feedback evidence quote");
        if (progressClaim(args.evidence) !== args.status) throw new Error("Progress evidence must explicitly state the requested learning status");
        result.progress = [{ chapterId: args.chapterId, status: args.status! }]; result.done = false;
      } else {
        if (global && /#weakness\b/.test(content)) throw new Error("Weaknesses belong to the current course");
        if (/#weakness\b/.test(content) || args.inferred) {
          const evidence = args.evidence ?? content.match(/Evidence:\s*(.+?)(?:\s*Status:|$)/i)?.[1]?.trim().replace(/\.$/, "");
          if (!evidence || !access.learnerFeedback!.toLowerCase().includes(evidence.toLowerCase())) throw new Error("Weakness needs actual learner-feedback evidence");
          const fact = args.inferred || /pending verification/i.test(content) ? `${content}\nStatus: pending verification.` : content;
          state.facts.push({ id: invocationId, scope, content: fact });
        } else state.facts.push({ id: invocationId, scope, content });
      }
      result.text = "Learner memory saved.";
    } else if (name === "memory_forget") {
      if (!args.match?.trim()) throw new Error("A non-empty scoped match is required");
      const needle = args.match.toLowerCase();
      const facts = state.facts.filter((fact) => fact.scope === scope && fact.content.toLowerCase().includes(needle));
      const chapters = scope === courseId ? course.chapters.filter((chapter) =>
        (`#progress [[course:${courseId}]] chapterId=${chapter.id} ${chapter.title}: ${chapter.status}`).toLowerCase().includes(needle)) : [];
      if (!facts.length && !chapters.length) throw new Error("No matching memory in the selected scope");
      const id = randomUUID();
      state.recovery.push({ id, scope, facts, progress: chapters.map((chapter) => ({ chapterId: chapter.id, status: chapter.status })), restoredAt: null });
      state.facts = state.facts.filter((fact) => !facts.some((removed) => removed.id === fact.id));
      result.progress = chapters.map((chapter) => ({ chapterId: chapter.id, status: "pending" })); result.done = !chapters.length;
      result.text = `Forgot ${facts.length + chapters.length} entries. Recovery ID: ${id}`;
    } else if (name === "memory_restore") {
      const recovery = state.recovery.find((record) => record.id === args.recoveryId && record.scope === scope);
      if (!recovery) throw new Error("Recovery ID is unavailable in the selected scope");
      if (!recovery.restoredAt) {
        for (const fact of recovery.facts) if (!state.facts.some((entry) => entry.id === fact.id || entry.scope === fact.scope && entry.content === fact.content)) state.facts.push(fact);
        result.progress = recovery.progress.map((item) => ({ chapterId: item.chapterId, status: item.status })); result.done = !result.progress.length;
        recovery.restoredAt = new Date().toISOString();
      }
      result.text = `Restored. Recovery ID: ${recovery.id}`;
    } else throw new Error("Unknown memory tool");
    state.receipts[invocationId] = result;
    return structuredClone(result);
  });
  if (!receipt.done) {
    try { await applyProgress(courseDir, invocationId, receipt.progress); }
    catch (error) { throw new Error(`${(error as Error).message}\n${receipt.text.match(/Recovery ID: [0-9a-f-]+/i)?.[0] ?? "Progress intent retained; retry the admitted request"}`); }
  }
  return text(receipt.text);
}

async function applyProgress(courseDir: string, invocationId: string, progress: Progress[]) {
  // Intent/recovery precedes the external course-file update. A replayed setter
  // compares authority first; it never increments a chapter twice for one effect.
  for (const update of progress) {
    const course = await readCourse(courseDir);
    if (course.chapters.find((chapter) => chapter.id === update.chapterId)?.status !== update.status) await updateChapterProgress(courseDir, update.chapterId, update.status);
  }
  await withStore(courseDir, async (state) => { state.receipts[invocationId].done = true; });
}

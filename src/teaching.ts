import path from 'node:path';
import { copyFile, cp, mkdir, readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc, defineTask, defineExtension, type RunningTask, type TaskRuntime, type TaskDefinition, type TaskRecord, type Cursor } from '@earendil-works/pi-durable';
import { createModels } from 'pi-ai-1-4';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { defaultModel } from './runtime.ts';
import { claimCourseDirectory, courseDirectory, ensureCourse, readCourse, chapterLecture, lectureFromCourse } from './course-state.ts';
import { readDraft, readPublishedLecture, type Lecture } from './lecture-state.ts';
import { hashFile, type OcrProvider, safeReason } from './ocr.ts';
import { runTeachingStep } from './teaching-steps.ts';
import type { Input } from './types.ts';
import type { Publication } from './export.ts';

export type TeachingConfig = {
  agentDir: string; model: string; ocr: OcrProvider; mineruBaseUrl: string; mistralBaseUrl: string;
  memoryRoot: string | null;
};
export type TeachingInput = {
  requestId: string; action: 'import' | 'generate' | 'revise' | 'memory';
  course: string; courseSlug: string; courseId: string; courseVersion: number;
  chapterId?: string; chapterVersion?: number; chapterSource?: string; lecture?: Lecture; feedback?: string;
  legacy?: boolean; chapterIds?: string[]; chapterTitles?: string[]; work: string; stage: string; pdf?: string; pages?: string; chapter?: string; screenshots: string[];
  files: Array<{ path: string; sha256: string; bytes: number }>;
  config: TeachingConfig; admittedAt: string;
};
export type TeachingCheckpoint = {
  phase: 'prepare' | 'ocr' | 'material' | 'route' | 'awaiting' | 'generate' | 'export' | 'memory' | 'attention';
  inputs?: Input[]; pages?: number[]; pageCount?: number; selection?: import('./types.ts').ChapterSelection;
  chapterIds?: string[]; chapterTitles?: string[];
  admissions?: Awaited<ReturnType<typeof import('./materials.ts').chapterAdmissions>>;
  lecture?: Lecture; routeAttempt?: number; adjustment?: string;
  previous?: { course: string | null; draft: string | null };
  ocr?: { started?: boolean; batchId?: string; batchIndices?: number[]; uploaded?: number[]; uploading?: number; received?: number[] };
  source?: string; sourceHash?: string; publication?: Publication;
  reason?: string; retryPhase?: TeachingCheckpoint['phase']; unsafe?: boolean; retryAuthorized?: boolean;
};
const Decisions = defineDoc({
  kind: 'tutor.teaching-decisions', version: 1, scope: 'task',
  initial: () => ({ confirmedAt: '', route: '', routeHash: '', adjustment: '', revision: 0, retry: 0 }),
  checkpointWhen: () => false,
});
const Requests = defineDoc({
  kind: 'tutor.teaching-requests', version: 1, scope: 'session',
  initial: () => ({ ids: {} as Record<string, string> }), checkpointWhen: () => false,
});
export const routeHash = (route: string) => createHash('sha256').update(route).digest('hex');
export class NeedsAttention extends Error { constructor(message: string, public unsafe = false) { super(message); } }
export type TeachingView = {
  id: string; course: string; courseId: string; courseSlug: string; action: TeachingInput['action']; chapterId?: string;
  status: 'running' | 'awaiting-route' | 'succeeded' | 'cancelled' | 'needs-attention' | 'failed';
  stage: string; log: string; canRetry?: boolean; route?: string; routeHash?: string; continuation?: string; output?: string;
};
export async function teachingConfig(options: { agentDir?: string; model?: string; ocr?: string; mineruBaseUrl?: string; mistralBaseUrl?: string }): Promise<TeachingConfig> {
  function endpoint(value: string) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error('OCR configuration must use a credential-free endpoint');
    return url.href.replace(/\/$/, '');
  }
  if (options.ocr && !['mineru','mistral'].includes(options.ocr)) throw new Error('--ocr must be mineru or mistral');
  return {
    agentDir: path.resolve(options.agentDir ?? getAgentDir()), model: options.model ?? defaultModel,
    ocr: (options.ocr ?? 'mineru') as OcrProvider,
    mineruBaseUrl: endpoint(options.mineruBaseUrl ?? 'https://mineru.net'), mistralBaseUrl: endpoint(options.mistralBaseUrl ?? 'https://api.mistral.ai'),
    memoryRoot: process.env.PI_MEMORY_DIR ? path.resolve(process.env.PI_MEMORY_DIR) : null,
  };
}

// One concrete business task, using Pi's lifecycle and transactions. Model runs
// retain their existing per-course Harness; no duplicate model/task log lives here.
export async function openTeachingCenter(dataDirectory: string, onChange: (view: TeachingView) => void = () => {}) {
  const dataDir = await realpath(dataDirectory);
  let serial = Promise.resolve();
  const exclusive = async (run: () => Promise<void>) => {
    const next = serial.then(run); serial = next.catch(() => {}); return next;
  };
  const task = defineTask<TeachingInput, TeachingCheckpoint, { output: string }, {}>({
    name: 'tutor.teaching', version: 1,
    initial: input => ({ phase: input.legacy ? 'awaiting' : input.action === 'import' ? 'prepare' : input.action === 'memory' ? 'memory' : 'generate', lecture: input.lecture, chapterIds: input.chapterIds, chapterTitles: input.chapterTitles }),
    phases: Object.fromEntries(['prepare','ocr','material','route','awaiting','generate','export','memory','attention'].map(phase => [phase,
      async (record: RunningTask<TeachingInput, TeachingCheckpoint, { output: string }>, runtime: TaskRuntime<TeachingInput, TeachingCheckpoint, { output: string }, {}>, context: Context) => {
        const state = structuredClone(record.state.checkpoint) as TeachingCheckpoint;
        const input = record.input as TeachingInput;
        const persist = async (next: TeachingCheckpoint) => {
          await runtime.commit(() => ({ status: 'running', checkpoint: next }), context);
          Object.assign(state, next);
          onChange(await view(String(record.id)));
        };
        try {
          if (phase === 'awaiting' || phase === 'attention') {
            const watch = await runtime.watchDoc(Decisions, record.id, context);
            if (!watch) throw new Error('Missing persisted teaching decision');
            const changed = (decision: Readonly<{confirmedAt: string; revision: number; retry: number}> | null) => phase === 'awaiting'
              ? decision?.confirmedAt || decision?.revision > (state.routeAttempt ?? 0)
              : decision?.retry > 0;
            let decision = watch.value;
            if (!changed(decision)) decision = await new Promise<typeof watch.value>((resolve, reject) => {
              watch.start(async (value) => { if (changed(value)) resolve(value); });
              runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), { once: true });
            });
            await watch.stop();
            if (phase === 'attention') {
              await runtime.commit(async (tx) => { (await tx.doc(Decisions, record.id)).retry = 0; return { status: 'running', checkpoint: { ...state, phase: state.retryPhase!, reason: undefined, retryAuthorized: true } }; }, context);
            } else if (decision!.confirmedAt) {
              const lecture = structuredClone(state.lecture!);
              lecture.route = decision!.route;
              lecture.context.confirmedAt = decision!.confirmedAt;
              // Confirmation was durably authorized before any generation work.
              await persist({ ...state, phase: 'generate', lecture });
            } else {
              await persist({ ...state, phase: 'route', routeAttempt: decision!.revision, adjustment: decision!.adjustment });
            }
            return;
          }
          await exclusive(async () => {
            runtime.signal.throwIfAborted();
            const result = await runTeachingStep({ input, state, dataDir, taskId: String(record.id), persist, signal: runtime.signal });
            if (result) {
              await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { output: result.output } } }), context);
              onChange(await view(String(record.id)));
            }
          });
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          const sanitized = safeReason((error instanceof Error ? error.message : String(error)).replaceAll(dataDir, "<data>"), 16000);
          const reason = sanitized.length > 3000 ? sanitized.slice(0, 1400) + " … " + sanitized.slice(-1400) : sanitized;
          await persist({ ...state, phase: 'attention', retryPhase: state.phase, reason, unsafe: (error instanceof NeedsAttention && error.unsafe) || /interrupted result is unknown|outcome requires inspection/.test(reason) });
        }
      }])) as TaskDefinition<TeachingInput, TeachingCheckpoint, { output: string }, {}>["phases"],
    async abort(_record, runtime, context) {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Explicit learner cancellation; retained inputs and stages' } }), context);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'tutor-teaching', tasks: [task] }));
  await mkdir(path.join(dataDir, '.teaching'), { recursive: true });
  const storage = await openNodeSqliteStorage(path.join(dataDir, '.teaching', 'tasks.sqlite'));
  const harness = await Harness.open(storage, { models: createModels(), registry, settings: { restartLimit: 5 } }, ctx);
  const conversation = await harness.root(ctx);
  async function records() {
    const found: TaskRecord<JsonValue, JsonValue, JsonValue>[] = []; let cursor: Cursor | undefined;
    do { const page = await harness.commit(tx => tx.scanTasks({ kind: 'tutor.teaching' }, 1000, cursor), ctx); found.push(...page.items); cursor = page.next; } while (cursor);
    return found;
  }
  async function view(id: string): Promise<TeachingView> {
    const record = await harness.getTask(Number(id) as never, ctx);
    if (!record || record.kind !== 'tutor.teaching') throw new Error('Teaching task not found');
    const input = record.input as unknown as TeachingInput;
    const cp = record.state.checkpoint as unknown as TeachingCheckpoint | undefined;
    const outcome = record.state.outcome;
    const inspection = await harness.inspect(ctx);
    const scheduling = inspection.tasks.find(item => String(item.record.id) === id)?.state;
    const blocked = scheduling?.kind === "blocked" ? scheduling.reason : undefined;
    let shownLecture = cp?.lecture;
    if (cp?.phase === 'awaiting' && cp.chapterIds) {
      const current = await readCourse(path.join(dataDir, input.courseSlug));
      if (JSON.stringify(current.route.chapterIds) === JSON.stringify(cp.chapterIds) && JSON.stringify(current.chapters.map(c => c.title)) !== JSON.stringify(cp.chapterTitles)) shownLecture = { ...cp.lecture!, route: current.route.markdown };
    }
    const decision = cp && ['awaiting','attention'].includes(cp.phase) ? await harness.snapshot(Decisions, Number(id) as never, ctx) : undefined;
    const decided = cp?.phase === 'attention' ? Boolean(decision?.retry) : Boolean(decision?.confirmedAt || (decision?.revision ?? 0) > (cp?.routeAttempt ?? 0));
    const status = outcome ? outcome.status === 'completed' ? 'succeeded' : outcome.status === 'aborted' ? 'cancelled' : 'failed'
      : decided ? 'running' : blocked || cp?.phase === 'attention' ? 'needs-attention' : cp?.phase === 'awaiting' ? 'awaiting-route' : 'running';
    return { id, course: input.course, courseId: input.courseId, courseSlug: input.courseSlug, action: input.action, chapterId: input.chapterId,
      status, canRetry: blocked === 'restart_limit' || (status === 'needs-attention' && !cp?.unsafe), stage: blocked === 'restart_limit' ? 'restart-limit' : cp?.phase ?? outcome?.status ?? 'unknown', log: (blocked ? `Official Pi task paused: ${blocked}. Use --retry for the bounded restart limit, or inspect and cancel.` : undefined) ?? (status === 'awaiting-route' ? shownLecture?.route : undefined) ?? cp?.reason ?? (outcome?.status === 'completed' && input.action === 'memory' ? outcome.result.output : undefined) ?? (outcome && 'error' in outcome ? outcome.error?.message : '') ?? '',
      ...(shownLecture && { route: shownLecture.route, routeHash: routeHash(shownLecture.route) }),
      ...(outcome?.status === 'completed' && { output: (outcome.result as { output: string }).output }),
      continuation: status === 'cancelled' || status === 'succeeded' ? undefined : `tutor --data-dir ${JSON.stringify(dataDir)} --task-id ${id} --resume`,
    };
  }
  return {
    async admit(request: { action: TeachingInput['action']; course: string; config: TeachingConfig; pdf?: string; pages?: string; chapter?: string; screenshots?: string[]; chapterId?: string; feedback?: string; requestId?: string; resumeSaved?: boolean }) {
      const requestId = request.requestId ?? randomUUID();
      const existing = (await harness.snapshot(Requests, ctx))?.ids[requestId];
      if (existing) return view(existing);
      if ((await this.list()).some(task => task.status === 'running')) throw new Error('A teaching task is already running; resume or cancel it before admitting another task');
      const courseDir = await courseDirectory(request.course, dataDir);
      await claimCourseDirectory(request.course, courseDir);
      const course = await ensureCourse(courseDir, request.course);
      let lecture: Lecture | undefined;
      if (request.resumeSaved) { lecture = structuredClone(await readDraft(courseDir)); lecture.context.confirmedAt = null; }
      if (request.action === 'generate') lecture = request.chapterId ? chapterLecture(course, request.chapterId) : await readDraft(courseDir).catch(error => { if (error.code === "ENOENT") return lectureFromCourse(course); throw error; });
      if (request.action === 'generate' && (!lecture?.context.confirmedAt || !lecture.route.trim())) throw new Error('Confirm the teaching route before generating the lecture');
      if (request.action === 'revise') {
        lecture = request.chapterId ? JSON.parse(await readFile(path.join(courseDir, 'chapters', request.chapterId, 'output', 'lecture.json'), 'utf8')) : await readPublishedLecture(courseDir);
        if (!lecture) throw new Error('Generate and export a lecture before revising it');
      }
      const work = path.join('.teaching', 'inputs', randomUUID());
      const directory = path.join(dataDir, work);
      await mkdir(directory, { recursive: true });
      const files: TeachingInput['files'] = [];
      async function owned(file: string, name: string) {
        const destination = path.join(directory, name);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(file, destination);
        const info = await lstat(destination);
        files.push({ path: path.relative(dataDir, destination), sha256: await hashFile(destination), bytes: info.size });
        return path.relative(dataDir, destination);
      }
      const stage = path.join(path.basename(courseDir), `.${request.action === 'revise' ? 'revision' : 'lecture'}-${requestId}`);
      const stageRoot = path.join(dataDir, stage);
      await mkdir(stageRoot, { recursive: true });
      if (request.action === 'revise') {
        const output = path.join(courseDir, request.chapterId ? path.join('chapters', request.chapterId, 'output') : 'output');
        await copyFile(path.join(output, 'content.md'), path.join(stageRoot, 'content.md'));
        for (const name of ['media','figures']) await cp(path.join(output, name), path.join(stageRoot, name), { recursive: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await owned(path.join(output, 'content.md'), 'original.md');
      }
      if (request.resumeSaved && lecture) {
        for (const [index, page] of lecture.context.pages.entries()) {
          page.pagePdf = path.join(dataDir, await owned(page.pagePdf, `legacy-page-${index}.pdf`));
          page.originalPageImage = path.join(dataDir, await owned(page.originalPageImage, `legacy-page-${index}${path.extname(page.originalPageImage)}`));
          const parsed = path.join(directory, `legacy-parsed-page-${index}`);
          await cp(page.parsedDirectory, parsed, { recursive: true }); page.parsedDirectory = parsed;
        }
        for (const [index, screenshot] of lecture.context.screenshots.entries()) {
          screenshot.source = path.join(dataDir, await owned(screenshot.source, `legacy-screenshot-${index}${path.extname(screenshot.source)}`));
          const parsed = path.join(directory, `legacy-parsed-screenshot-${index}`);
          await cp(screenshot.parsedDirectory, parsed, { recursive: true }); screenshot.parsedDirectory = parsed;
        }
        if (!lecture.route.trim()) throw new Error('Saved teaching route is empty; inspect the preserved legacy work');
      }
      const pdf = request.pdf ? await owned(request.pdf, path.basename(request.pdf)) : undefined;
      const screenshots = [];
      for (const [index, file] of (request.screenshots ?? []).entries()) screenshots.push(await owned(file, `screenshot-${index}/${path.basename(file)}`));
      const input: TeachingInput = { requestId, action: request.action, course: request.course, courseId: course.id, courseSlug: path.basename(courseDir), courseVersion: course.version,
        chapterId: request.chapterId, chapterSource: request.chapterId ? JSON.stringify(course.chapters.find(c => c.id === request.chapterId)?.source) : undefined, chapterVersion: course.chapters.find(c => c.id === request.chapterId)?.version,
        lecture, legacy: request.resumeSaved, chapterIds: request.resumeSaved ? course.route.chapterIds : undefined, chapterTitles: request.resumeSaved ? course.chapters.map(c => c.title) : undefined, work, stage, pdf, pages: request.pages, chapter: request.chapter, screenshots, files, config: request.config, feedback: request.feedback, admittedAt: new Date().toISOString() };
      // Task creation and the only request index commit together, after copies.
      const id = await conversation.commit(async tx => {
        const index = await tx.doc(Requests);
        if (index.ids[requestId]) return index.ids[requestId];
        const id = await tx.createTask(task, input, { ownership: { kind: 'conversation' } });
        await tx.doc(Decisions, id); index.ids[requestId] = String(id); return String(id);
      }, ctx);
      return view(id);
    },
    view,
    async admitRevision(id: string, feedback: string) {
      const record = await harness.getTask(Number(id) as never, ctx);
      if (record?.state.outcome?.status !== 'completed') throw new Error('Complete the original lecture before revising');
      const original = record.input as unknown as TeachingInput;
      return this.admit({ action: 'revise', course: original.course, chapterId: original.chapterId, config: original.config, feedback });
    },
    async list() { return Promise.all((await records()).map(record => view(String(record.id)))); },
    async pending() {
      const saved = await records();
      const admitted = new Set(saved.map(record => (record.input as TeachingInput).work));
      const teachingCourses = new Set(saved.filter(record => (record.input as TeachingInput).action !== 'memory').map(record => (record.input as TeachingInput).courseSlug));
      const stages = new Set(saved.flatMap(record => [(record.input as TeachingInput).stage, path.join((record.input as TeachingInput).courseSlug, `.export-${record.id}`)]));
      const pending: Array<{ path: string; reason: string }> = [];
      for (const directory of [dataDir, ...await readdir(dataDir, { withFileTypes: true }).then(entries => entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(dataDir, e.name))), path.join(dataDir, '.teaching', 'inputs')]) {
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const relative = path.relative(dataDir, path.join(directory, entry.name));
          if ((directory.endsWith(path.join('.teaching','inputs')) && !admitted.has(relative)) || (/^\.(upload|lecture|revision|export)-/.test(entry.name) && !stages.has(relative)) || entry.name === 'revision-session.json' || entry.name === '.sessions' || (!teachingCourses.has(path.basename(directory)) && ['draft.json','context.json','route.md','source','parsed','original-pages'].includes(entry.name))) pending.push({ path: relative, reason: 'No durable admission; inspect preserved legacy work. It will not be executed or deleted automatically.' });
        }
      }
      return pending;
    },
    async decide(id: string, decision: { confirm?: boolean; route?: string; feedback?: string; retry?: boolean; cancel?: boolean }) {
      const before = await view(id);
      if (['succeeded','cancelled','failed'].includes(before.status)) throw new Error(`Task is terminal (${before.status})`);
      if (decision.retry && before.stage === 'restart-limit') { await harness.retryTask(Number(id) as never, ctx); return view(id); }
      if (decision.cancel) { await harness.abortTask(Number(id) as never, ctx); await harness.waitForTask(Number(id) as never, ctx); return view(id); }
      await harness.commit(async tx => {
        const record = await tx.task(Number(id) as never);
        const cp = record?.state.checkpoint as unknown as TeachingCheckpoint;
        const doc = await tx.doc(Decisions, Number(id) as never);
        if (decision.retry) {
          if (cp?.phase !== 'attention' || cp.unsafe) throw new Error('Unknown external/tool outcome cannot be retried automatically. Inspect retained work, cancel this task, and explicitly admit new work if needed.');
          doc.retry++;
        } else {
          if (cp?.phase !== 'awaiting') throw new Error('Teaching route is not awaiting confirmation');
          if (decision.confirm) {
            if (decision.route !== before.route) throw new Error('Teaching route has changed; reload before confirming');
            const current = await readCourse(path.join(dataDir, (record!.input as unknown as TeachingInput).courseSlug));
            if (current.chapters.some(c => c.needsConfirmation)) throw new Error(`${current.chapters.filter(c => c.needsConfirmation).length} chapter titles need confirmation before the route can be confirmed`);
            if (JSON.stringify(current.route.chapterIds) !== JSON.stringify(cp.chapterIds)) throw new Error('Course chapters changed; inspect this older task before confirming');
            doc.route = decision.route!; doc.routeHash = routeHash(decision.route!); doc.confirmedAt = new Date().toISOString();
          } else {
            if (!decision.feedback?.trim()) throw new Error('Route adjustment is required');
            doc.adjustment = decision.feedback; doc.revision = (cp.routeAttempt ?? 0) + 1;
          }
        }
      }, ctx);
      harness.resume(); return view(id);
    },
    resume() { harness.resume(); },
    async close() { await harness.close(ctx); },
  };
}
export type TeachingCenter = Awaited<ReturnType<typeof openTeachingCenter>>;

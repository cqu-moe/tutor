import path from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { prepareMaterials, pdfPageCount, selectChapter, parsePages, buildContext, chapterAdmissions } from './materials.ts';
import { bindCourseLecture, addCourseMaterial, courseMaterialSignature, hasCourseMaterial, lectureFromCourse, readCourse, recordChapterLecture, recordCourseDraft } from './course-state.ts';
import { readPublishedLecture, saveDraft } from './lecture-state.ts';
import { prepareMemoryStore } from './memory-store.ts';
import { hashFile, uncachedInputs } from './ocr.ts';
import { parseWithMistral } from './mistral.ts';
import { parseWithMinerU } from './mineru.ts';
import { imageContent } from './runtime.ts';
import { selectionScope } from './selection.ts';
import { teachingPrompt } from './teaching-model.ts';
import { generateLecture } from './lecture.ts';
import { reviseLecture } from './revision.ts';
import { exportLecture } from './export.ts';
import { NeedsAttention, type TeachingInput, type TeachingCheckpoint } from './teaching.ts';

export async function runTeachingStep(options: {
  input: TeachingInput; state: TeachingCheckpoint; dataDir: string; taskId: string;
  persist: (next: TeachingCheckpoint) => Promise<void>; signal: AbortSignal;
}): Promise<{ output: string } | void> {
  const { input, state, dataDir, taskId, persist, signal } = options;
  const courseDir = path.join(dataDir, input.courseSlug);
  const config = input.config;
  const course = await readCourse(courseDir);
  if (course.id !== input.courseId) throw new NeedsAttention('Original course identity changed; inspect retained task inputs', true);
  if ((process.env.PI_MEMORY_DIR ? path.resolve(process.env.PI_MEMORY_DIR) : null) !== config.memoryRoot) throw new NeedsAttention('Original memory directory configuration changed; reopen with the admitted PI_MEMORY_DIR', true);
  if (input.chapterId && !course.chapters.some(c => c.id === input.chapterId && JSON.stringify(c.source) === input.chapterSource)) throw new NeedsAttention('Selected chapter revision changed; inspect the original task before resuming', true);
  const model = { agentDir: config.agentDir, model: config.model, retryBlocked: state.retryAuthorized };
  const outputDirectory = input.chapterId ? path.join('chapters', input.chapterId, 'output') : 'output';
  const stage = path.join(dataDir, input.stage);
  if (state.phase === 'prepare') {
    for (const file of input.files) if (await hashFile(path.join(dataDir, file.path)) !== file.sha256) throw new NeedsAttention(`Accepted input changed: ${file.path}`, true);
    await prepareMemoryStore(courseDir);
    await readPublishedLecture(courseDir);
    const pdf = path.join(dataDir, input.pdf!);
    const pageCount = await pdfPageCount(pdf);
    const selection = input.chapter ? await selectChapter(input.chapter, pdf, pageCount) : undefined;
    const pages = selection?.pages ?? parsePages(input.pages, pageCount);
    const inputs = await prepareMaterials(pdf, pages, input.screenshots.map(file => path.join(dataDir, file)), courseDir);
    const importedScreenshots = inputs.filter(i => i.kind === 'screenshot').map(i => ({ name: i.name, source: i.uploadPath, parsedDirectory: '', markdown: '' }));
    if (hasCourseMaterial(course, inputs[0].contentHash, pages, importedScreenshots)) {
      console.log(`No new material: ${path.basename(pdf)} is already part of this course.`);
      return { output: '' };
    }
    const admissions = await chapterAdmissions(pdf, pageCount, pages, inputs[0].contentHash, selection?.selection);
    await persist({ ...state, phase: 'ocr', inputs, pages, pageCount, selection: selection?.selection, admissions });
  } else if (state.phase === 'ocr') {
    const endpoint = config.ocr === 'mineru' ? config.mineruBaseUrl : config.mistralBaseUrl;
    const pending = await uncachedInputs(state.inputs!, courseDir, config.ocr, config.ocr === 'mineru' ? 'vlm' : 'mistral-ocr-latest', endpoint);
    // The original full input order/data_id remains stable across partial caches.
    if (pending.length) {
      const ocr = state.ocr ?? {};
      const save = async (change: NonNullable<TeachingCheckpoint['ocr']>) => { state.ocr = change; await persist({ ...state }); };
      if (config.ocr === 'mistral') {
        if (ocr.started && !await Bun.file(`${pending[0].parsedDirectory}.received.json`).exists()) throw new NeedsAttention('Mistral OCR response is unknown after interruption. No query identity exists; inspect retained results, cancel and explicitly reimport if necessary.', true);
        const key = process.env.MISTRAL_API_KEY ?? "";
        // One request at a time. A complete saved response can be reused even if
        // its cache commit was interrupted; see the OCR client's receipt boundary.
        for (const item of pending) {
          if (!key && !await Bun.file(`${item.parsedDirectory}.received.json`).exists()) throw new Error("MISTRAL_API_KEY is required for Mistral OCR.");
          await save({ started: true });
          await parseWithMistral([item], endpoint, key, { signal });
          await save({ started: false });
        }
      } else {
        const token = process.env.MINERU_API_TOKEN ?? "";
        await parseWithMinerU(state.inputs!, endpoint, token, { state: ocr, save, signal, pending: pending.map(input => input.parsedDirectory!) });
      }
    }
    await persist({ ...state, phase: 'material' });
  } else if (state.phase === 'material') {
    const context = await buildContext(input.course, state.inputs!, courseDir, state.selection);
    if (!state.previous) {
      const optional = (name: string) => readFile(path.join(courseDir, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      await persist({ ...state, previous: { course: await optional('course.json'), draft: await optional('draft.json') } });
    }
    const added = await addCourseMaterial(courseDir, { name: path.basename(input.pdf!), sourceHash: state.inputs![0].contentHash, sourcePages: state.pages!, pages: context.pages, screenshots: context.screenshots, chapters: state.admissions! }, input.course);
    const signature = courseMaterialSignature(state.inputs![0].contentHash, state.pages!, context.screenshots);
    const material = added.course.materials.find(m => courseMaterialSignature(m.sourceHash, m.sourcePages, m.screenshots) === signature);
    if (!material) throw new Error('Accepted material identity is missing from the course record');
    const lecture = lectureFromCourse(added.course, state.selection || material?.chapterIds.length === 1 ? material?.id : undefined);
    await persist({ ...state, phase: 'route', lecture, chapterIds: added.course.route.chapterIds, chapterTitles: added.course.chapters.map(c => c.title) });
  } else if (state.phase === 'route') {
    const lecture = structuredClone(state.lecture!);
    const context = lecture.context;
    const sources = [...context.pages.map(p => `PDF page ${p.sourcePage}\n${p.markdown}`), ...context.screenshots.map(s => `Screenshot ${s.name}\n${s.markdown}`)].join('\n\n');
    const prompt = state.adjustment
      ? `Adjust this teaching route. Record any explicit learner feedback before responding. Return the complete revised route.\n\nCurrent route:\n${lecture.route}\n\nUser adjustment: ${state.adjustment}`
      : `Course: ${context.course}${selectionScope(context.selection)}\n\nDurable course chapter order (title authority; keep every title, omit nothing, and add no numbered chapter):\n${lecture.route}\n\n${sources}\n\nCompare the parsed formulas, tables, and figures with the attached original pages. Propose a teaching route for this accumulated material. Return only Markdown with: Scope, Prerequisites, Teaching order, and Material doubts. The numbered Teaching order must contain exactly the durable courseware chapter titles. Include page citations.`;
    const images = state.adjustment ? [] : await Promise.all([...context.pages.map(p => imageContent(p.originalPageImage)), ...context.screenshots.map(s => imageContent(s.source))]);
    try {
      lecture.route = (await teachingPrompt({ courseDir, ...model, key: `${taskId}:route:${state.routeAttempt ?? 0}`, systemPrompt: 'You are a careful course tutor. Ground claims in supplied course material and cite original pages.', prompt, images, feedback: state.adjustment, signal })).trim();
      const current = await readCourse(courseDir);
      if (current.route.markdown !== lecture.route || current.route.confirmedAt !== lecture.context.confirmedAt) await recordCourseDraft(courseDir, lecture);
      await saveDraft(courseDir, lecture);
      await persist({ ...state, phase: 'awaiting', lecture, previous: undefined });
    } catch (error) {
      if (signal.aborted) throw error;
      if (state.previous) {
        for (const name of ['course','draft'] as const) {
          const file = path.join(courseDir, `${name}.json`), previous = state.previous[name];
          if (previous === null) await rm(file, { force: true }); else await writeFile(file, previous);
        }
      }
      throw error;
    }
  } else if (state.phase === 'generate') {
    const lecture = state.lecture!;
    if (input.action === 'import') {
      const current = await readCourse(courseDir);
      if (current.route.confirmedAt !== lecture.context.confirmedAt || current.route.markdown !== lecture.route) await recordCourseDraft(courseDir, lecture);
      await saveDraft(courseDir, lecture);
    }
    await mkdir(stage, { recursive: true });
    const job = { stage, retryBlocked: state.retryAuthorized, original: path.join(dataDir, input.work, 'original.md'), requestId: `${taskId}:${input.action === 'revise' ? 'revision' : 'lecture'}`, signal };
    const source = input.action === 'revise'
      ? await reviseLecture(lecture, courseDir, config.agentDir, config.model, input.feedback!, job, outputDirectory)
      : await generateLecture(lecture, courseDir, config.agentDir, config.model, job);
    await persist({ ...state, phase: 'export', source, sourceHash: await hashFile(source) });
  } else if (state.phase === 'export') {
    if (await hashFile(state.source!) !== state.sourceHash) throw new NeedsAttention('Validated generated source changed; inspect retained source before exporting', true);
    const checkpoint = async () => { await persist({ ...state, publication: state.publication, reason: `Reconciling publication ${Date.now()}` }); };
    const output = await exportLecture(courseDir, state.source!, state.lecture!, outputDirectory, {
      stage: path.join(courseDir, `.export-${taskId}`), publication: state.publication,
      ready: async publication => { state.publication = publication; await persist({ ...state }); },
      checkpoint,
    });
    if (input.chapterId && course.chapters.find(c => c.id === input.chapterId)?.lecture.operationId !== taskId) await recordChapterLecture(courseDir, input.chapterId, 'published', output, taskId);
    if (!input.chapterId) await bindCourseLecture(courseDir, course, state.lecture!, state.publication!, taskId, path.join(courseDir, `.export-${taskId}`), checkpoint);
    console.log(`Lecture ${input.action === 'revise' ? 'revised' : 'exported'}: ${output} (content.md, typst/document.typ, document.pdf, media/)`);
    return { output };
  } else if (state.phase === 'memory') {
    const text = await teachingPrompt({ courseDir, ...model, key: `${taskId}:memory`, systemPrompt: 'You are a careful course tutor.', prompt: `Course: ${input.course}\nLearner memory request: ${input.feedback}`, feedback: input.feedback, signal });
    console.log(text); return { output: text };
  }
}

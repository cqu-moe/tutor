import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readDraft, saveDraft } from "./lecture-state.ts";
import type { Context } from "./types.ts";

export type ChapterProgress = "pending" | "in_progress" | "learned";

export type CourseChapterSource = {
  materialId: string;
  materialVersion: string;
  startPage?: number;
  endPage?: number;
  startHeading?: string;
  endHeading?: string | null;
};

export type CourseChapterLecture = {
  status: "none" | "generating" | "published" | "failed";
  output?: string;
  courseVersion: number;
};

export type CourseChapter = {
  id: string;
  version: number;
  title: string;
  status: ChapterProgress;
  order: number;
  source: CourseChapterSource;
  needsConfirmation: boolean;
  progressUpdatedAt: string | null;
  lecture: CourseChapterLecture;
};

export type CourseMaterial = {
  id: string;
  signature: string;
  version: string;
  name: string;
  sourceHash: string;
  importedAt: string;
  sourcePages: number[];
  pages: Context["pages"];
  screenshots: Context["screenshots"];
  chapterIds: string[];
};

export type CourseMaterialAdmission = {
  name: string;
  sourceHash: string;
  sourcePages: number[];
  pages: Context["pages"];
  screenshots: Context["screenshots"];
  chapters: Array<Omit<CourseChapter, "version" | "status" | "order" | "progressUpdatedAt" | "lecture">>;
};

export type CourseRoute = {
  version: number;
  markdown: string;
  confirmedAt: string | null;
  chapterIds: string[];
};

export type CourseRecord = {
  schemaVersion: 1;
  id: string;
  version: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  materials: CourseMaterial[];
  chapters: CourseChapter[];
  route: CourseRoute;
};

const courseFile = (courseDir: string) => path.join(courseDir, "course.json");

function normalizedText(value: string) {
  return value.trim().normalize("NFC");
}

function emptyCourse(name: string): CourseRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    version: 0,
    name,
    createdAt: now,
    updatedAt: now,
    materials: [],
    chapters: [],
    route: { version: 1, markdown: "", confirmedAt: null, chapterIds: [] },
  };
}

export class CourseStateError extends Error {}

function nextVersion(course: CourseRecord) {
  course.version += 1;
  course.updatedAt = new Date().toISOString();
}

export async function readCourse(courseDir: string, courseName?: string): Promise<CourseRecord> {
  try {
    const course = JSON.parse(await readFile(courseFile(courseDir), "utf8")) as CourseRecord;
    if (course.schemaVersion !== 1 || course.id !== course.id.trim() || !Array.isArray(course.chapters)) {
      throw new Error("Course record is invalid; move it aside or restore a backup before continuing");
    }
    return course;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const migrated = await migrateLegacyCourse(courseDir);
    await saveCourse(courseDir, migrated);
    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !courseName) throw error;
  }
  return emptyCourse(normalizedText(courseName));
}

export async function ensureCourse(courseDir: string, courseName: string): Promise<CourseRecord> {
  try {
    await access(courseFile(courseDir));
    const course = await readCourse(courseDir);
    if (course.name !== normalizedText(courseName)) {
      throw new CourseStateError(`Course directory belongs to ${JSON.stringify(course.name)}`);
    }
    return course;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const migrated = await migrateLegacyCourse(courseDir);
    await saveCourse(courseDir, migrated);
    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const course = emptyCourse(normalizedText(courseName));
  await saveCourse(courseDir, course);
  return course;
 }

export function courseDirectory(course: string, dataDir: string) {
  const slug = course.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new CourseStateError("--course must contain a course name");
  return path.resolve(dataDir, slug);
}

export async function claimCourseDirectory(course: string, courseDir: string) {
  const marker = path.join(courseDir, ".course-name");
  const rejectCollision = (owner: string) => {
    throw new CourseStateError(`Course directory "${path.basename(courseDir)}" already belongs to ${JSON.stringify(owner)}; use the existing course name or a different --data-dir`);
  };
  try {
    const saved = await readFile(marker, "utf8");
    if (normalizedText(saved) !== course) rejectCollision(saved.trim());
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let existed = true;
  try {
    await access(courseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
  }
  await mkdir(courseDir, { recursive: true });
  let owner: string | undefined;
  try {
    let context: Context;
    try {
      context = JSON.parse(await readFile(path.join(courseDir, "draft.json"), "utf8")).context;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      context = JSON.parse(await readFile(path.join(courseDir, "context.json"), "utf8"));
    }
    owner = normalizedText(context.course ?? "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (owner && owner !== course) rejectCollision(owner);
  if (!owner && existed) {
    throw new CourseStateError(
      `Cannot determine the course name for directory "${path.basename(courseDir)}"; move it aside, create .course-name containing the exact original course name, or use a different --data-dir`,
    );
  }
  try {
    await writeFile(marker, `${course}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = await readFile(marker, "utf8");
    if (normalizedText(saved) !== course) rejectCollision(saved.trim());
  }
}

export async function createCourse(dataDir: string, courseName: string) {
  const course = normalizedText(courseName);
  const directory = courseDirectory(course, dataDir);
  await claimCourseDirectory(course, directory);
  const record = await ensureCourse(directory, course);
  return { directory, record };
 }

export async function saveCourse(courseDir: string, course: CourseRecord) {
  nextVersion(course);
  const temporary = path.join(courseDir, `.course-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(course, null, 2)}\n`);
  await rename(temporary, courseFile(courseDir));
}

async function migrateLegacyCourse(courseDir: string): Promise<CourseRecord> {
  const lecture = await readDraft(courseDir);
  const now = new Date().toISOString();
  const materialId = randomUUID();
  const chapterId = randomUUID();
  const pages = lecture.context.pages;
  const sourcePages = pages.map((page) => page.sourcePage);
  const sourceHash = lecture.context.pages[0]?.pagePdf
    ? path.basename(lecture.context.pages[0].pagePdf).split("-").at(-1)?.replace(/\.pdf$/, "") ?? randomUUID()
    : randomUUID();
  const signature = createHash("sha256").update(JSON.stringify({
    name: lecture.context.course,
    pages: lecture.context.pages.map((page) => page.sourcePage),
    screenshots: lecture.context.screenshots.map((screenshot) => screenshot.source),
    sourceHash,
  })).digest("hex");
  const routeTitle = routeChapterTitles(lecture.route)[0];
  const title = lecture.context.selection?.title ?? routeTitle ?? "未命名资料";
  const course: CourseRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    version: 0,
    name: lecture.context.course,
    createdAt: now,
    updatedAt: now,
    materials: [{
      id: materialId,
      signature,
      version: sourceHash,
      name: lecture.context.pages[0]?.pagePdf ? path.basename(lecture.context.pages[0].pagePdf) : "legacy materials",
      sourceHash,
      importedAt: now,
      sourcePages,
      pages,
      screenshots: lecture.context.screenshots,
      chapterIds: [chapterId],
    }],
    chapters: [{
      id: chapterId,
      version: 1,
      title,
      status: "pending",
      order: 1,
      source: {
        materialId,
        materialVersion: sourceHash,
        startPage: lecture.context.selection?.startPage ?? sourcePages[0],
        endPage: lecture.context.selection?.endPage ?? sourcePages.at(-1),
        startHeading: lecture.context.selection?.startHeading,
        endHeading: lecture.context.selection?.endHeading ?? null,
      },
      needsConfirmation: !lecture.context.selection && !routeTitle,
      progressUpdatedAt: null,
      lecture: { status: "none", courseVersion: 1 },
    }],
    route: {
      version: 1,
      markdown: lecture.route,
      confirmedAt: lecture.context.confirmedAt,
      chapterIds: [chapterId],
    },
  };
  return course;
}

export function lectureFromCourse(course: CourseRecord, selectedMaterialId?: string) {
  const selectedMaterial = selectedMaterialId
    ? course.materials.find((material) => material.id === selectedMaterialId)
    : undefined;
  if (selectedMaterial && selectedMaterial.chapterIds.length !== 1) {
    throw new CourseStateError("A selected material must contain exactly one chapter");
  }
  const selectedChapter = selectedMaterial
    ? course.chapters.find((chapter) => chapter.id === selectedMaterial.chapterIds[0])
    : undefined;
  const pages = selectedMaterial?.pages ?? course.materials.flatMap((material) => material.pages);
  const screenshots = selectedMaterial?.screenshots ?? course.materials.flatMap((material) => material.screenshots);
  return {
    context: {
      course: course.name,
      selection: selectedChapter ? {
        type: "chapter" as const,
        title: selectedChapter.title,
        startHeading: selectedChapter.source.startHeading ?? selectedChapter.title,
        startPage: selectedChapter.source.startPage ?? pages[0]?.sourcePage ?? 1,
        endHeading: selectedChapter.source.endHeading ?? null,
        endPage: selectedChapter.source.endPage ?? pages.at(-1)?.sourcePage ?? selectedChapter.source.startPage ?? 1,
      } : undefined,
      pages,
      screenshots,
      confirmedAt: course.route.confirmedAt,
    },
    route: course.route.markdown,
  };
}

export function chapterLecture(course: CourseRecord, chapterId: string): import("./lecture-state.ts").Lecture {
  const chapter = course.chapters.find((entry) => entry.id === chapterId);
  if (!chapter) throw new Error(`Unknown chapter: ${chapterId}`);
  if (chapter.needsConfirmation) throw new Error(`Resolve the chapter title before generating its lecture`);
  if (!course.route.confirmedAt) throw new Error("Confirm the teaching route before generating a chapter lecture");
  const material = course.materials.find((entry) => entry.id === chapter.source.materialId);
  if (!material) throw new Error(`Source material is missing for chapter "${chapter.title}"`);
  const start = chapter.source.startPage ?? 1;
  const end = chapter.source.endPage ?? start;
  return {
    context: {
      course: course.name,
      selection: {
        type: "chapter",
        title: chapter.title,
        startHeading: chapter.source.startHeading ?? chapter.title,
        startPage: start,
        endHeading: chapter.source.endHeading ?? null,
        endPage: end,
      },
      pages: material.pages.filter((page) => page.sourcePage >= start && page.sourcePage <= end),
      screenshots: material.screenshots,
      confirmedAt: course.route.confirmedAt,
    },
    route: course.route.markdown,
  };
}

function routeChapterTitles(markdown: string) {
  return markdown.split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+[.)]\s+(.+?)\s*$/)?.[1])
    .filter((title): title is string => Boolean(title))
    .map(normalizedTitle);
}

function normalizedTitle(value: string) {
  return value.trim().normalize("NFC").replace(/[.。]+$/, "");
}

export async function recordCourseDraft(courseDir: string, lecture: import("./lecture-state.ts").Lecture) {
  const course = await readCourse(courseDir);
  const unresolved = course.chapters.filter((chapter) => chapter.needsConfirmation);
  const ordered = [...course.chapters].sort((a, b) => a.order - b.order);
  const titles = routeChapterTitles(lecture.route);
  const expectedTitles = ordered.map((chapter) => normalizedTitle(chapter.title));
  const expectedCounts = new Map(expectedTitles.map((title) => [title, expectedTitles.filter((value) => value === title).length]));
  const routeCounts = new Map(titles.map((title) => [title, titles.filter((value) => value === title).length]));
  if (titles.length !== ordered.length || [...expectedCounts].some(([title, count]) => routeCounts.get(title) !== count)) {
    throw new Error("Teaching route does not match the course chapters exactly; restore every courseware chapter and remove extra chapters");
  }
  const queues = new Map<string, CourseChapter[]>();
  for (const chapter of ordered) {
    const title = normalizedTitle(chapter.title);
    queues.set(title, [...queues.get(title) ?? [], chapter]);
  }
  const routeIds = titles.map((title, index) => {
    const chapter = queues.get(title)!.shift()!;
    if ((chapter.status === "in_progress" || chapter.status === "learned") && chapter.order !== index + 1) {
      throw new Error(`Teaching route would move protected chapter "${chapter.title}"`);
    }
    return chapter.id;
  });
  if (unresolved.length && lecture.context.confirmedAt) {
    throw new Error(`${unresolved.length} chapter titles need confirmation before the route can be confirmed`);
  }
  // The bug check below is intentional: no route update may replace a protected chapter's source or lecture binding.
  const protectedBefore = new Map(ordered
    .filter((chapter) => chapter.status === "in_progress" || chapter.status === "learned")
    .map((chapter) => [chapter.id, { source: chapter.source, lecture: chapter.lecture }]));
  for (const [index, id] of routeIds.entries()) {
    const chapter = course.chapters.find((entry) => entry.id === id)!;
    chapter.order = index + 1;
  }
  for (const [id, before] of protectedBefore) {
    const chapter = course.chapters.find((entry) => entry.id === id)!;
    if (JSON.stringify(chapter.source) !== JSON.stringify(before.source)
      || JSON.stringify(chapter.lecture) !== JSON.stringify(before.lecture)) {
      throw new Error(`Teaching route would replace the source or lecture for protected chapter "${chapter.title}"`);
    }
  }
  course.route = {
    version: course.route.version + 1,
    markdown: lecture.route,
    confirmedAt: lecture.context.confirmedAt,
    chapterIds: routeIds,
  };
  await saveCourse(courseDir, course);
}

export function courseRouteMarkdown(course: CourseRecord) {
  const chapters = [...course.chapters].sort((a, b) => a.order - b.order);
  return `## Teaching order\n${chapters.map((chapter, index) => `${index + 1}. ${chapter.title}`).join("\n")}\n`;
}

export function courseMaterialSignature(
  sourceHash: string,
  sourcePages: number[],
  screenshots: CourseMaterial["screenshots"],
) {
  return createHash("sha256").update(JSON.stringify({
    sourceHash,
    sourcePages,
    screenshots: screenshots.map((screenshot) => `${screenshot.name}:${screenshot.source}`),
  })).digest("hex");
}

export function hasCourseMaterial(
  course: CourseRecord,
  sourceHash: string,
  sourcePages: number[],
  screenshots: CourseMaterial["screenshots"],
) {
  const signature = courseMaterialSignature(sourceHash, sourcePages, screenshots);
  return course.materials.some((material) => material.signature === signature);
}

export async function addCourseMaterial(courseDir: string, admission: CourseMaterialAdmission, courseName?: string) {
  const course = await readCourse(courseDir, courseName);
  if (hasCourseMaterial(course, admission.sourceHash, admission.sourcePages, admission.screenshots)) {
    return { course, added: false };
  }

  const signature = courseMaterialSignature(admission.sourceHash, admission.sourcePages, admission.screenshots);
  const materialId = admission.chapters[0]?.source.materialId ?? randomUUID();
  const material: CourseMaterial = {
    id: materialId,
    signature,
    version: admission.sourceHash,
    name: admission.name,
    sourceHash: admission.sourceHash,
    importedAt: new Date().toISOString(),
    sourcePages: admission.sourcePages,
    pages: admission.pages,
    screenshots: admission.screenshots,
    chapterIds: admission.chapters.map((chapter) => chapter.id),
  };
  const nextOrder = Math.max(0, ...course.chapters.map((chapter) => chapter.order));
  const now = new Date().toISOString();
  const existingTitles = new Set(course.chapters.map((chapter) => normalizedTitle(chapter.title)));
  const chapters = admission.chapters.map((chapter, index) => ({
    ...chapter,
    needsConfirmation: chapter.needsConfirmation
      || existingTitles.has(normalizedTitle(chapter.title))
      || admission.chapters.some((other) => other !== chapter && normalizedTitle(other.title) === normalizedTitle(chapter.title)),
    version: 1,
    status: "pending" as const,
    order: nextOrder + index + 1,
    progressUpdatedAt: null,
    lecture: { status: "none" as const, courseVersion: course.version + 1 },
  }));

  course.materials.push(material);
  course.chapters.push(...chapters);
  course.route = {
    version: course.route.version + 1,
    markdown: courseRouteMarkdown(course),
    confirmedAt: null,
    chapterIds: course.chapters.map((chapter) => chapter.id),
  };
  course.updatedAt = now;
  await saveCourse(courseDir, course);
  return { course, added: true };
}

export async function resolveChapterTitle(courseDir: string, chapterId: string, title: string) {
  const course = await readCourse(courseDir);
  const chapter = course.chapters.find((entry) => entry.id === chapterId);
  if (!chapter) throw new Error(`Unknown chapter: ${chapterId}`);
  if (!chapter.needsConfirmation) throw new Error("This chapter title is already confirmed");
  const normalized = normalizedTitle(title);
  if (!normalized || normalized.length > 300) throw new Error("Chapter title cannot be empty or longer than 300 characters");
  if (course.chapters.some((entry) => entry !== chapter && normalizedTitle(entry.title) === normalized)) {
    throw new CourseStateError("Chapter title conflicts with another chapter");
  }
  chapter.title = normalized;
  chapter.needsConfirmation = false;
  chapter.version += 1;
  course.route.version += 1;
  course.route.markdown = courseRouteMarkdown(course);
  course.route.chapterIds = [...course.chapters].sort((a, b) => a.order - b.order).map((entry) => entry.id);
  await saveCourse(courseDir, course);
  await saveDraft(courseDir, lectureFromCourse(course));
  return course;
}

export async function updateChapterProgress(
  courseDir: string,
  chapterId: string,
  status: ChapterProgress,
): Promise<CourseRecord> {
  const course = await readCourse(courseDir);
  const chapter = course.chapters.find((entry) => entry.id === chapterId);
  if (!chapter) throw new Error(`Unknown chapter: ${chapterId}`);
  chapter.status = status;
  chapter.version += 1;
  chapter.progressUpdatedAt = new Date().toISOString();
  await saveCourse(courseDir, course);
  return course;
}

export async function recordChapterLecture(
  courseDir: string,
  chapterId: string,
  status: CourseChapterLecture["status"],
  output?: string,
) {
  const course = await readCourse(courseDir);
  const chapter = course.chapters.find((entry) => entry.id === chapterId);
  if (!chapter) throw new Error(`Unknown chapter: ${chapterId}`);
  chapter.version += 1;
  chapter.lecture = {
    status: status === "published" ? "published" : chapter.lecture.status === "published" ? "published" : status,
    output: status === "published" ? output ?? chapter.lecture.output : chapter.lecture.output,
    courseVersion: course.version + 1,
  };
  await saveCourse(courseDir, course);
}

export function chapterLine(chapter: CourseChapter, material?: CourseMaterial) {
  const source = material ? ` · ${material.name} ${material.version.slice(0, 12)}` : "";
  const pages = chapter.source.startPage
    ? ` · pages ${chapter.source.startPage}-${chapter.source.endPage ?? chapter.source.startPage}`
    : "";
  const confirmation = chapter.needsConfirmation
    ? " · title needs confirmation · resolve with --confirm-chapter --chapter-id <id> --title <courseware title>"
    : "";
  const lecture = chapter.lecture.status === "published" ? " · lecture published" : "";
  return `[${chapter.status}] ${chapter.order}. ${chapter.title}${source}${pages} · chapter ${chapter.id}${confirmation}${lecture}`;
}

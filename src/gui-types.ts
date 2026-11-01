export type GuiAction = "import" | "resume" | "generate" | "revise" | "memory" | "doctor";
export type GuiJob = {
  id: string;
  course: string | null;
  action: GuiAction;
  status: "running" | "awaiting-route" | "succeeded" | "failed" | "cancelled" | "needs-attention";
  canRetry?: boolean;
  courseId?: string; courseSlug?: string; chapterId?: string; route?: string; routeHash?: string; continuation?: string; output?: string;
  stage: string;
  log: string;
};
export type GuiCourse = {
  id: string;
  courseId: string;
  name: string;
  pages: number[];
  screenshots: number;
  confirmed: boolean;
  hasRoute: boolean;
  published: boolean;
  materials: number;
  chapters: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "learned";
    order: number;
    needsConfirmation: boolean;
    lecturePublished: boolean;
  }>;
  updatedAt: string;
  error?: string;
};
export type GuiState = {
  courses: GuiCourse[];
  job: GuiJob | null;
  tasks: GuiJob[];
  pending: Array<{ path: string; reason: string }>;
  config: { model: string; ocr: string; dataDir: string };
};
export type GuiChapterDetail = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "learned";
  order: number;
  materialName: string;
  materialVersion: string;
  needsConfirmation: boolean;
  lecture: {
    status: "none" | "generating" | "published" | "failed";
    content: string;
    files: string[];
  };
};

export type GuiDetail = {
  courseId: string;
  route: string;
  content: string;
  files: string[];
  chapters: GuiChapterDetail[];
};

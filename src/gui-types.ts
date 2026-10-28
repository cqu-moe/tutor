export type GuiAction = "import" | "resume" | "generate" | "revise" | "memory" | "doctor";
export type GuiJob = {
  id: string;
  course: string | null;
  action: GuiAction;
  status: "running" | "awaiting-route" | "succeeded" | "failed";
  stage: string;
  log: string;
};
export type GuiCourse = {
  id: string;
  name: string;
  pages: number[];
  screenshots: number;
  confirmed: boolean;
  hasRoute: boolean;
  published: boolean;
  updatedAt: string;
  error?: string;
};
export type GuiState = {
  courses: GuiCourse[];
  job: GuiJob | null;
  config: { model: string; ocr: string; dataDir: string };
};
export type GuiDetail = { route: string; content: string; files: string[] };

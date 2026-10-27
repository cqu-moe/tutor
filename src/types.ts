export type Input = {
  name: string;
  uploadPath: string;
  kind: "pdf-page" | "screenshot";
  sourcePage?: number;
  image?: string;
  contentHash: string;
  parsedDirectory?: string;
};

export type Context = {
  course: string;
  pages: Array<{ sourcePage: number; pagePdf: string; originalPageImage: string; parsedDirectory: string; markdown: string }>;
  screenshots: Array<{ name: string; source: string; parsedDirectory: string; markdown: string }>;
  confirmedAt: string | null;
};

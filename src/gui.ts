import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { readDraft } from "./lecture-state.ts";
import { defaultModel } from "./runtime.ts";
import type { GuiAction, GuiCourse, GuiJob } from "./gui-types.ts";

type Options = {
  dataDir: string; agentDir?: string; model?: string; ocr: string; port: number; open: boolean;
  mineruBaseUrl: string; mistralBaseUrl: string;
};
const busy = (job: GuiJob | null) => job?.status === "running" || job?.status === "awaiting-route";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const fileTypes = new Set([".md", ".pdf", ".typ", ".json", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".csv", ".py", ".ttf", ".otf", ".woff", ".woff2"]);

class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function startGui(options: Options) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("--port must be between 0 and 65535");
  if (!["mineru", "mistral"].includes(options.ocr)) throw new Error("--ocr must be mineru or mistral");
  const dataDir = path.resolve(options.dataDir);
  const publicDir = Bun.isStandaloneExecutable ? path.join(import.meta.dirname, "resources/gui") : path.resolve(import.meta.dirname, "../gui/dist");
  const template = await readFile(path.join(publicDir, "index.html"), "utf8").catch(() => {
    throw new Error("GUI assets are missing. Run pnpm install && pnpm build from gui/ first.");
  });
  const token = crypto.randomUUID();
  const html = template.replace("__TUTOR_SESSION__", token);
  let job: GuiJob | null = null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let starting = false;
  let stopping = false;
  let pendingRoute = "";
  let completion: Promise<void> | undefined;
  let submission = Promise.resolve();
  let submissionFinished: (() => void) | undefined;

  async function courseDirectory(id: string) {
    if (!id || id.startsWith(".") || /[/\\\0]/.test(id)) throw new RequestError("课程不存在。", 404);
    const directory = path.join(dataDir, id);
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new RequestError("课程不存在。", 404);
    return directory;
  }

  async function courses(): Promise<GuiCourse[]> {
    const entries = await readdir(dataDir, { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error; });
    const result: GuiCourse[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(dataDir, entry.name);
      let name: string;
      try { name = (await readFile(path.join(directory, ".course-name"), "utf8")).trim(); }
      catch (error) { if (missing(error)) continue; throw error; }
      const base = { id: entry.name, name, pages: [], screenshots: 0, confirmed: false, hasRoute: false, published: false, updatedAt: (await stat(directory)).mtime.toISOString() };
      try {
        const draft = await readDraft(directory);
        result.push({ ...base, pages: draft.context.pages.map((page) => page.sourcePage), screenshots: draft.context.screenshots.length,
          confirmed: Boolean(draft.context.confirmedAt), hasRoute: Boolean(draft.route.trim()),
          published: await Bun.file(path.join(directory, "output/content.md")).exists(),
          updatedAt: (await stat(path.join(directory, "draft.json")).catch(() => stat(directory))).mtime.toISOString(),
        });
      } catch (error) {
        result.push({ ...base, error: missing(error) ? "资料尚未导入完成，可重新导入。" : "课程记录无法读取，请检查本地文件后重试。" });
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function outputFile(directory: string, file: string) {
    if (path.isAbsolute(file) || file.split(/[/\\]/).some((part) => !part || part.startsWith(".")) || !fileTypes.has(path.extname(file))) {
      throw new RequestError("文件不存在。", 404);
    }
    const root = await realpath(path.join(directory, "output"));
    if (root !== path.join(await realpath(directory), "output")) throw new RequestError("文件不存在。", 404);
    const target = await realpath(path.join(root, file));
    if (!target.startsWith(root + path.sep) || !(await stat(target)).isFile()) throw new RequestError("文件不存在。", 404);
    return target;
  }

  async function outputFiles(directory: string, prefix = ""): Promise<string[]> {
    if (!prefix && (await lstat(path.join(directory, "output")).catch(() => null))?.isSymbolicLink()) return [];
    const entries = await readdir(path.join(directory, "output", prefix), { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error; });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) files.push(...await outputFiles(directory, name + "/"));
      else if (entry.isFile() && fileTypes.has(path.extname(entry.name))) files.push(name);
    }
    return files.sort();
  }

  const string = (value: unknown, label: string, limit = 4000) => {
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new RequestError(`${label}不能为空，且不能超过 ${limit} 个字符。`);
    return value.trim();
  };
  function launch(action: GuiAction, course: string | null, args: string[], cleanup?: string) {
    if (stopping) throw new RequestError("工作台正在关闭。", 503);
    const current: GuiJob = { id: crypto.randomUUID(), action, course, status: "running", stage: action, log: "" };
    job = current;
    const command = Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, "--no-env-file", path.join(import.meta.dirname, "cli.ts")];
    const settings = ["--data-dir", dataDir, "--ocr", options.ocr, "--mineru-base-url", options.mineruBaseUrl, "--mistral-base-url", options.mistralBaseUrl];
    if (options.agentDir) settings.push("--agent-dir", options.agentDir);
    if (options.model) settings.push("--model", options.model);
    const processChild = Bun.spawn([...command, ...settings, ...args], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      ipc(message) {
        if (current.status !== "running") return;
        if (message?.type === "route" && typeof message.route === "string") {
          pendingRoute = message.route;
          current.status = "awaiting-route";
          current.stage = "route";
        }
        if (message?.type === "stage" && typeof message.stage === "string") current.stage = message.stage;
      },
    });
    child = processChild;
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) current.log = (current.log + decoder.decode(chunk, { stream: true })).slice(-32_000);
      current.log += decoder.decode();
    };
    completion = (async () => {
      try {
        const [code] = await Promise.all([processChild.exited, consume(processChild.stdout), consume(processChild.stderr)]);
        current.status = code === 0 ? "succeeded" : "failed";
      } catch { current.status = "failed"; current.log += "\n任务进程异常退出，可检查配置后重试。"; }
      finally {
        if (child === processChild) child = null;
        if (cleanup) await rm(cleanup, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return current;
  }

  async function api(request: Request, url: URL) {
    if (request.headers.get("x-tutor-session") !== token) throw new RequestError("会话已失效，请刷新页面。", 403);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "GET" && url.pathname === "/api/state") {
      return Response.json({ courses: await courses(), job, config: { model: options.model ?? defaultModel, ocr: options.ocr, dataDir } });
    }
    if (request.method === "GET" && segments[1] === "courses" && segments[2]) {
      const directory = await courseDirectory(segments[2]);
      if (segments[3] === "files" && segments.length > 4) {
        const target = await outputFile(directory, segments.slice(4).join("/"));
        return new Response(Bun.file(target), { headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}` } });
      }
      if (segments.length !== 3) throw new RequestError("页面不存在。", 404);
      const draft = await readDraft(directory);
      const files = await outputFiles(directory);
      const content = files.includes("content.md") ? await readFile(await outputFile(directory, "content.md"), "utf8") : "";
      return Response.json({ route: draft.route, content, files });
    }
    if (request.method !== "POST") throw new RequestError("页面不存在。", 404);
    if (stopping) throw new RequestError("工作台正在关闭。", 503);
    if (url.pathname === "/api/jobs/input") {
      const body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("请求格式无效。");
      if (!job || !child || job.id !== body.id || job.status !== "awaiting-route") throw new RequestError("路线状态已变化，请刷新后重试。", 409);
      if (body.confirm === true && body.route !== pendingRoute) throw new RequestError("教学路线已更新，请重新读取后确认。", 409);
      if (body.defer === true) {
        job.status = "running";
        job.stage = "saved";
        await (child.stdin as import("bun").FileSink).end();
        return Response.json(job);
      }
      const input = body.confirm === true ? "confirm" : string(body.feedback, "调整意见");
      if (body.confirm !== true && input.toLowerCase() === "confirm") throw new RequestError("请使用「确认并生成」按钮确认路线。");
      job.status = "running";
      job.stage = body.confirm === true ? "generating" : "route";
      const sink = child.stdin as import("bun").FileSink;
      sink.write(input.replace(/[\r\n]+/g, " ") + "\n");
      await sink.flush();
      return Response.json(job);
    }
    if (url.pathname !== "/api/jobs") throw new RequestError("页面不存在。", 404);
    if (starting || busy(job)) throw new RequestError("另一个任务正在进行，请先完成教学路线或等待任务结束。", 409);
    starting = true;
    submission = new Promise<void>((resolve) => { submissionFinished = resolve; });
    let upload: string | undefined;
    try {
      if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
        const form = await request.formData();
        const course = string(form.get("course"), "课程名称", 160).normalize("NFC");
        const selection = string(form.get("selection"), "讲解范围", 300);
        const mode = form.get("selectionMode");
        if (mode !== "pages" && mode !== "chapter") throw new RequestError("请选择页码或章节范围。");
        if (mode === "pages" && !/^\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*$/.test(selection)) throw new RequestError("页码格式应为 1-4 或 1,3-5。");
        const pdf = form.get("pdf");
        const screenshots = form.getAll("screenshots").filter((file) => file instanceof File && file.size > 0) as File[];
        if (!(pdf instanceof File) || !pdf.size || !pdf.name.toLowerCase().endsWith(".pdf") || !(await pdf.slice(0, 1024).text()).includes("%PDF-")) throw new RequestError("请选择有效的 PDF 文件。");
        if (pdf.size + screenshots.reduce((total, file) => total + file.size, 0) > 120 * 1024 * 1024) throw new RequestError("本次文件合计不能超过 120 MB。", 413);
        if (screenshots.length > 12 || screenshots.some((file) => !/\.(png|jpe?g|webp)$/i.test(file.name))) throw new RequestError("补充截图仅支持 PNG、JPEG、WebP，最多 12 张。");
        if (screenshots.some((file) => /[/\\\0]/.test(file.name))) throw new RequestError("截图文件名不能包含路径或空字符。");
        await mkdir(dataDir, { recursive: true });
        upload = await mkdtemp(path.join(dataDir, ".upload-"));
        const pdfPath = path.join(upload, "material.pdf");
        await Bun.write(pdfPath, pdf);
        const args = ["--course", course, "--pdf", pdfPath, mode === "pages" ? "--pages" : "--chapter", selection];
        for (const [index, file] of screenshots.entries()) {
          const directory = path.join(upload, `screenshot-${index + 1}`);
          await mkdir(directory);
          const target = path.join(directory, file.name);
          await Bun.write(target, file);
          args.push("--screenshots", target);
        }
        return Response.json(launch("import", course, args, upload), { status: 202 });
      }
      const body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("请求格式无效。");
      const action = body.action as GuiAction;
      if (!["doctor", "resume", "generate", "revise", "memory"].includes(action)) throw new RequestError("不支持的操作。");
      if (action === "doctor") return Response.json(launch(action, null, ["doctor"]), { status: 202 });
      const directory = await courseDirectory(string(body.courseId, "课程"));
      const course = (await readFile(path.join(directory, ".course-name"), "utf8")).trim();
      const args = ["--course", course, `--${action}`];
      if (action === "revise" || action === "memory") args.push(string(body.feedback, "反馈"));
      return Response.json(launch(action, course, args), { status: 202 });
    } catch (error) {
      if (upload) await rm(upload, { recursive: true, force: true });
      throw error;
    } finally { starting = false; submissionFinished?.(); }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port, maxRequestBodySize: 128 * 1024 * 1024,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const expected = `127.0.0.1:${server.port}`;
        if (url.host !== expected || request.headers.get("host") !== expected ||
          (request.headers.has("origin") && request.headers.get("origin") !== `http://${expected}`) ||
          request.headers.get("sec-fetch-site") === "cross-site") throw new RequestError("只允许本机工作台访问。", 403);
        let response: Response;
        if (url.pathname.startsWith("/api/")) response = await api(request, url);
        else if (request.method === "GET" && (url.pathname === "/" || !path.extname(url.pathname))) response = new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        else if (request.method === "GET" && /^\/assets\/[\w.-]+$/.test(url.pathname)) {
          const file = Bun.file(path.join(publicDir, url.pathname));
          if (!await file.exists()) throw new RequestError("文件不存在。", 404);
          response = new Response(file);
        } else throw new RequestError("页面不存在。", 404);
        response.headers.set("cache-control", "no-store");
        response.headers.set("x-content-type-options", "nosniff");
        response.headers.set("referrer-policy", "no-referrer");
        response.headers.set("x-frame-options", "DENY");
        return response;
      } catch (error) {
        const status = error instanceof RequestError ? error.status : missing(error) ? 404 : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
        return Response.json({ error: error instanceof RequestError ? error.message : status === 404 ? "文件不存在。" : status === 400 ? "请求格式无效。" : "无法完成请求，请检查本地文件与配置后重试。" }, { status });
      }
    },
  });
  const address = `http://127.0.0.1:${server.port}`;
  console.log(`Tutor GUI: ${address}`);
  console.log(`Course storage: ${dataDir}\nPress Ctrl+C to stop.`);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await submission;
    child?.kill("SIGTERM");
    await completion;
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (options.open) execFile(process.platform === "darwin" ? "open" : "xdg-open", [address], (error) => {
    if (error) console.log(`Open ${address} in your browser.`);
  });
  return server;
}

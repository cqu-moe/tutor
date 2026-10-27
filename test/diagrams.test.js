import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cli = path.join(import.meta.dirname, "..", "bin", "tutor.js");

function runCli(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out\n${stdout}\n${stderr}`));
    }, 120_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

async function body(request) {
  let data = "";
  for await (const chunk of request) data += chunk;
  return JSON.parse(data);
}

function sse(response, delta, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "1", object: "chat.completion.chunk", created: 1, model: "diagram-model" };
  response.end([
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta } }] })}`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`,
    "data: [DONE]", "",
  ].join("\n\n"));
}

function call(name, args) {
  return { tool_calls: [{ index: 0, id: `${name}-${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

function deliveredMedia(markdown, basename) {
  return markdown.match(new RegExp(`\\((media/[^)]*${basename}\\.svg)\\)`))?.[1];
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("confirmed CLI lecture generates, inspects, exports, and preserves static diagrams", { timeout: 180_000 }, async (t) => {
  for (const name of ["TUTOR_RECTO_ROOT", "TUTOR_DIAGRAM_PYTHON", "TUTOR_TYPST_PACKAGE_CACHE"]) {
    assert.ok(process.env[name], `Set ${name} for the real static-diagram export test`);
  }
  const root = await mkdtemp(path.join(tmpdir(), "tutor-diagrams-"));
  const courseDir = path.join(root, "data", "digital-design");
  const originalPage = path.join(courseDir, "original-pages", "page-21.png");
  const pagePdf = path.join(root, "source.pdf");
  const sourceTyp = path.join(root, "source.typ");
  await mkdir(path.dirname(originalPage), { recursive: true });
  await writeFile(sourceTyp, "#set page(width: 12cm, height: 5cm)\nF4 = xy' + x'z\n");
  await run("typst", ["compile", sourceTyp, pagePdf]);
  await run("pdftoppm", ["-png", "-r", "150", "-singlefile", pagePdf, path.join(root, "page")]);
  await copyFile(path.join(root, "page.png"), originalPage);
  const parsed = path.join(courseDir, "parsed", "page-21");
  await mkdir(parsed, { recursive: true });
  await writeFile(path.join(parsed, "full.md"), "Boolean Functions: F4 = xy' + x'z. Source page 21 also shows the truth table and gate implementation.\n");

  let mode = "success";
  let stage;
  const modelRequests = [];
  const model = createServer(async (request, response) => {
    const payload = await body(request);
    const messages = payload.messages;
    modelRequests.push(payload);
    if (!JSON.stringify(messages).includes("Write the complete lecture")) return sse(response, { content: "## Route\nBoolean functions" });
    stage ??= JSON.stringify(messages).match(/Lecture stage: `([^`]+)`/)?.[1];
    if (!stage) return response.writeHead(500).end(JSON.stringify({ error: { message: "lecture prompt did not disclose the stage" } }));
    const completed = messages.filter((message) => message.role === "tool").length;
    if (mode.startsWith("outside-")) {
      if (completed && mode === "outside-final-write") return sse(response, { content: "# Overwritten published lecture\n\n<div>Force export failure</div>" });
      if (completed) return response.writeHead(401).end(JSON.stringify({ error: { message: "fixture stops after the attempted write" } }));
      const target = path.join(courseDir, "output", "content.md");
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const alias = path.join(stage, "outside-link");
      let command = `printf overwritten > ${quote(target)}`;
      if (mode === "outside-hardlink" || mode === "outside-symlink") {
        command = `ln ${mode === "outside-symlink" ? "-s " : ""}${quote(target)} ${quote(alias)} && printf overwritten > ${quote(alias)}`;
      }
      if (mode === "outside-final-write") command = `ln -s ${quote(target)} ${quote(path.join(stage, "content.md"))}`;
      const escape = mode === "outside-write"
        ? call("write", { path: target, content: "overwritten outside the stage" })
        : call("bash", { command });
      return sse(response, escape, "tool_calls");
    }
    if (mode === "late-error" && completed === 5) return response.writeHead(401).end(JSON.stringify({ error: { message: "fixture model unavailable after diagrams" } }));
    if (completed === 0) {
      return sse(response, call("write", { path: path.join(stage, "figures", "f4.py"), content: [
        "import sys",
        "import schemdraw",
        "from schemdraw.parsing import logicparse",
        "schemdraw.use('svg')",
        "schemdraw.svgconfig.text = 'text'",
        "d = logicparse(\"(x and not y) or (not x and z)\", gateH=1.5, outlabel='F4')",
        "d.draw(show=False)",
        "d.save(sys.argv[1])",
      ].join("\n") }), "tool_calls");
    }
    if (completed === 1) {
      return sse(response, call("write", { path: path.join(stage, "figures", "f4-view.typ"), content: [
        '#import "@preview/cetz:0.5.3"',
        '#set page(width: auto, height: auto, margin: 4pt)',
        '#cetz.canvas({',
        '  import cetz.draw: *',
        '  rect((0, 0), (4, 1.6), name: "mux")',
        '  content("mux.center", [2:1 MUX])',
        '  line((-1, 1.2), (0, 1.2), mark: (end: ">"))',
        '  content((-1.1, 1.2), $z$, anchor: "east")',
        '  content((0.2, 1.2), [0], anchor: "west")',
        '  line((-1, 0.4), (0, 0.4), mark: (end: ">"))',
        '  content((-1.1, 0.4), $overline(y)$, anchor: "east")',
        '  content((0.2, 0.4), [1], anchor: "west")',
        '  line((2, -0.8), "mux.south", mark: (end: ">"))',
        '  content((2, -1), $x$)',
        '  line("mux.east", (5, 0.8), mark: (end: ">"))',
        '  content((5.1, 0.8), $F_4$, anchor: "west")',
        '  content((2, 2.1), [Select $x$: 0 uses $z$, 1 uses $overline(y)$])',
        '})',
      ].join("\n") }), "tool_calls");
    }
    if (completed === 2) {
      const command = [
        `mkdir -p ${JSON.stringify(path.join(stage, "media"))} ${JSON.stringify(path.join(stage, "qa"))}`,
        `pwd > ${JSON.stringify(path.join(stage, "figures", "observed-session-cwd"))}`,
        `"${process.env.TUTOR_DIAGRAM_PYTHON}" ${JSON.stringify(path.join(stage, "figures", "f4.py"))} ${JSON.stringify(path.join(stage, "media", "f4.svg"))}`,
        `typst compile --package-cache-path "${process.env.TUTOR_TYPST_PACKAGE_CACHE}" --font-path "${path.join(process.env.TUTOR_RECTO_ROOT, "assets/fonts")}" ${JSON.stringify(path.join(stage, "figures", "f4-view.typ"))} ${JSON.stringify(path.join(stage, "media", "f4-view.svg"))}`,
        `cat > ${JSON.stringify(path.join(stage, "qa", "preview.typ"))} <<'PREVIEW'\n#set page(width: auto, height: auto, margin: 4pt)\n#grid(columns: 1, image("media/f4.svg", width: 12cm), image("media/f4-view.svg", width: 12cm))\nPREVIEW`,
        `cd ${JSON.stringify(stage)} && typst compile --root . --ppi 180 qa/preview.typ qa/diagram-preview.png`,
      ].join("\n");
      return sse(response, call("bash", { command, timeout: 60 }), "tool_calls");
    }
    if (completed === 3) return sse(response, call("read", { path: originalPage }), "tool_calls");
    if (completed === 4) return sse(response, call("read", { path: path.join(stage, "qa", "diagram-preview.png") }), "tool_calls");
    return sse(response, { content: [
      "# Boolean Functions 与 F4", "",
      "课程资料第 21 页给出 $F_4 = x\\bar{y}+\\bar{x}z$。", "",
      "| x | y | z | F4 |", "|---|---|---|---|", "| 0 | 0 | 0 | 0 |", "| 0 | 0 | 1 | 1 |", "| 0 | 1 | 0 | 0 |", "| 0 | 1 | 1 | 1 |", "| 1 | 0 | 0 | 1 |", "| 1 | 0 | 1 | 1 |", "| 1 | 1 | 0 | 0 |", "| 1 | 1 | 1 | 0 |", "",
      "![F4 逻辑门电路（重绘，依据课程资料第 21 页）](media/f4.svg)", "",
      "![F4 的 MUX 视角（新增视角，依据同一公式重绘）](media/f4-view.svg)", "",
      "图表说明：上方电路重绘课程第 21 页的 F4 门级实现；MUX 图为新增等价视角。已渲染并检查预览。", "",
    ].join("\n") });
  });
  const modelUrl = await listen(model);
  t.after(() => new Promise((resolve) => model.close(resolve)));

  const agentDir = path.join(root, "pi");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { tutorTest: {
    baseUrl: `${modelUrl}/v1`, api: "openai-completions", apiKey: "test-only",
    compat: { supportsUsageInStreaming: false }, models: [{ id: "diagram-model", input: ["text", "image"] }],
  } } }));
  const dataDir = path.join(root, "data");
  await mkdir(courseDir, { recursive: true });
  await writeFile(path.join(courseDir, "route.md"), "## Route\n1. Boolean Functions and F4\n");
  await writeFile(path.join(courseDir, "context.json"), JSON.stringify({
    course: "Digital Design",
    pages: [{ sourcePage: 21, pagePdf, originalPageImage: originalPage, parsedDirectory: parsed, markdown: await readFile(path.join(parsed, "full.md"), "utf8") }],
    screenshots: [],
    confirmedAt: "2026-10-27T00:00:00.000Z",
  }, null, 2));
  const common = ["--course", "Digital Design", "--data-dir", dataDir, "--agent-dir", agentDir, "--model", "tutorTest/diagram-model", "--generate"];
  const env = { ...process.env, NO_COLOR: "1" };
  const generated = await runCli(common, "", env);
  assert.equal(generated.code, 0, `${generated.stderr}\n${JSON.stringify(modelRequests.at(-1)?.messages.filter((message) => message.role === "tool" && typeof message.content === "string"))}`);
  assert.match(generated.stdout, /Lecture exported/);
  assert.equal(await readFile(path.join(courseDir, "output", "figures", "observed-session-cwd"), "utf8"), `${await realpath(courseDir)}\n`);
  const output = path.join(courseDir, "output");
  const markdown = await readFile(path.join(output, "content.md"), "utf8");
  assert.match(markdown, /media\/[^" ]+f4\.svg/);
  assert.match(markdown, /media\/[^" ]+f4-view\.svg/);
  const truthTable = markdown.split("\n")
    .filter((line) => /^\s*[01](?:\s+[01]){3}\s*$/.test(line))
    .map((line) => line.trim().split(/\s+/));
  assert.deepEqual(truthTable, [
    ["0", "0", "0", "0"], ["0", "0", "1", "1"], ["0", "1", "0", "0"], ["0", "1", "1", "1"],
    ["1", "0", "0", "1"], ["1", "0", "1", "1"], ["1", "1", "0", "0"], ["1", "1", "1", "0"],
  ]);
  const gateSvgPath = deliveredMedia(markdown, "f4");
  const muxSvgPath = deliveredMedia(markdown, "f4-view");
  assert.ok(gateSvgPath && muxSvgPath);
  const gateSvg = await readFile(path.join(output, gateSvgPath), "utf8");
  const muxSource = await readFile(path.join(output, "figures", "f4-view.typ"), "utf8");
  assert.match(gateSvg, /F4/);
  assert.match(muxSource, /2:1 MUX/);
  assert.match(muxSource, /Select/);
  await readFile(path.join(output, "figures", "f4.py"));
  assert.match(JSON.stringify(modelRequests), /diagram-preview\.png/);
  const { stdout: pdfText } = await run("pdftotext", [path.join(output, "document.pdf"), "-"]);
  assert.match(pdfText, /Boolean Functions/);
  await run("typst", ["compile", "--root", ".", "--font-path", "typst/fonts", "typst/document.typ", path.join(root, "rebuilt.pdf")], { cwd: output });

  const goodFiles = (await readdir(output, { recursive: true })).filter((file) => /\.(md|pdf|typ|svg|py|json)$/.test(file));
  const goodBytes = await Promise.all(goodFiles.map((file) => readFile(path.join(output, file))));
  for (const attempt of ["outside-write", "outside-bash", "outside-symlink", "outside-hardlink", "outside-final-write"]) {
    mode = attempt;
    stage = undefined;
    const rejected = await runCli(common, "", env);
    assert.equal(rejected.code, 1);
    for (const [index, file] of goodFiles.entries()) assert.ok((await readFile(path.join(output, file))).equals(goodBytes[index]), `${attempt} changed ${file}`);
  }
  mode = "late-error";
  stage = undefined;
  const failed = await runCli(common, "", env);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /generation failed/);
  assert.deepEqual(await Promise.all(goodFiles.map((file) => readFile(path.join(output, file)))), goodBytes);
  assert.match(failed.stderr, /\.lecture-/);
});

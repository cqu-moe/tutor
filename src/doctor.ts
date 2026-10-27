import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { InMemoryCredentialStore, InMemoryModelsStore, type Credential, type ModelsStoreEntry } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { sandboxOptions } from "./assets.ts";
import { defaultModel } from "./runtime.ts";

const execute = promisify(execFile);
const run = (file: string, args: string[]) => execute(file, args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function doctor(options: { ocr?: string; agentDir?: string; model?: string } = {}): Promise<number> {
  let failures = 0;
  const report = (ok: boolean, name: string, fix: string) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${fix}`}`);
    if (!ok) failures++;
  };
  const check = async (name: string, fix: string, action: () => Promise<unknown>) => {
    try { await action(); report(true, name, fix); return true; }
    catch { report(false, name, fix); return false; }
  };
  console.log("Tutor doctor — local checks only; credential validity is not tested");
  report(["darwin", "linux"].includes(process.platform), "platform", "Use macOS or Linux (glibc); see docs/install.md");
  for (const tool of ["pdfinfo", "pdfseparate", "pdftoppm", "pdftohtml"]) {
    await check(tool, "Install Poppler: brew install poppler / sudo apt install poppler-utils", () => run(tool, ["-v"]));
  }
  if ((options.ocr ?? "mineru") === "mineru") {
    await check("unzip", "Install unzip: sudo apt install unzip", () => run("/usr/bin/unzip", ["-v"]));
  }
  for (const [tool, minimum] of [["pandoc", "3.9.0.2"], ["typst", "0.15.1"]]) {
    await check(`${tool} >=${minimum}`, `Install the versioned ${tool} release in docs/install.md`, async () => {
      const { stdout } = await run(tool, ["--version"]);
      const version = stdout.match(/\b\d+(?:\.\d+)+\b/)?.[0];
      if (!version) throw new Error("missing version");
      const actual = version.split(".").map(Number);
      const required = minimum.split(".").map(Number);
      const difference = required.map((part, i) => (actual[i] ?? 0) - part).find((n) => n !== 0) ?? 0;
      if (difference < 0) throw new Error("old version");
    });
  }
  const python = process.env.TUTOR_PYTHON ?? "python3";
  await check("Python >=3.10", "Set TUTOR_PYTHON to a Python 3.10+ interpreter", () => run(python, ["-c", "import sys; assert sys.version_info >= (3,10)"]));
  const recto = process.env.TUTOR_RECTO_ROOT;
  await check("Recto and fonts", "Install Recto 0.3.1, set TUTOR_RECTO_ROOT and install its requirements with TUTOR_PYTHON; see docs/install.md", async () => {
    if (!recto) throw new Error("unset");
    await access(path.join(recto, "scripts/export.py"));
    await run(python, [path.join(recto, "scripts/doctor.py"), "--style", "reference"]);
  });
  await check("study-notes", "Set TUTOR_STUDY_NOTES or install the sibling Recto study-notes skill", async () => {
    const file = process.env.TUTOR_STUDY_NOTES ?? (recto && path.resolve(recto, "../study-notes/SKILL.md"));
    if (!file || !(await readFile(file, "utf8")).trim()) throw new Error("missing");
  });
  await check("Schemdraw 0.23 / pyparsing 3.3.3", 'Set TUTOR_DIAGRAM_PYTHON; run "$TUTOR_DIAGRAM_PYTHON" -m pip install schemdraw==0.23 pyparsing==3.3.3', async () => {
    if (!process.env.TUTOR_DIAGRAM_PYTHON) throw new Error("unset");
    await run(process.env.TUTOR_DIAGRAM_PYTHON, ["-c", "import schemdraw,pyparsing; assert schemdraw.__version__ == '0.23'; assert pyparsing.__version__ == '3.3.3'"]);
  });
  if (process.platform === "linux") {
    for (const [tool, args] of [["bwrap", ["--version"]], ["socat", ["-V"]], ["rg", ["--version"]]] as const) {
      await check(tool, "sudo apt install bubblewrap socat ripgrep", () => run(tool, [...args]));
    }
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "tutor-doctor-"));
  try {
    const sandboxReady = await check("sandbox", "Check sandbox permissions; on Linux enable unprivileged user namespaces and install bubblewrap/socat/ripgrep", async () => {
      await SandboxManager.initialize({
        ...await sandboxOptions(),
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: [temporary], denyWrite: [] },
      });
      await run("/bin/bash", ["-c", await SandboxManager.wrapWithSandbox("true", "/bin/bash")]);
    });
    await check("CeTZ 0.5.3 (offline compile)", "Set TUTOR_TYPST_PACKAGE_CACHE and precompile CeTZ plus its dependencies using docs/install.md", async () => {
      if (!sandboxReady || !process.env.TUTOR_TYPST_PACKAGE_CACHE) throw new Error("unavailable");
      const cache = path.resolve(process.env.TUTOR_TYPST_PACKAGE_CACHE);
      await access(path.join(cache, "preview/cetz/0.5.3/typst.toml"));
      const source = path.join(temporary, "check.typ");
      await writeFile(source, '#import "@preview/cetz:0.5.3"\n#cetz.canvas({ import cetz.draw: *; line((0,0), (1,1)) })\n');
      const command = `typst compile --package-path ${quote(temporary)} --package-cache-path ${quote(cache)} ${quote(source)} ${quote(path.join(temporary, "check.pdf"))}`;
      await run("/bin/bash", ["-c", await SandboxManager.wrapWithSandbox(command, "/bin/bash")]);
    });
  } finally {
    await SandboxManager.reset();
    await rm(temporary, { recursive: true, force: true });
  }

  const ocr = options.ocr ?? "mineru";
  report(ocr === "mineru" || ocr === "mistral", "OCR provider", "Choose --ocr mineru or --ocr mistral");
  if (ocr === "mineru" || ocr === "mistral") {
    const variable = ocr === "mineru" ? "MINERU_API_TOKEN" : "MISTRAL_API_KEY";
    report(Boolean(process.env[variable]?.trim()), `OCR ${variable}`, `Set ${variable} in the environment or an explicit --env-file`);
  }
  await check("model configuration and image support", "Check --agent-dir/models.json and --model; the selected model must accept images", async () => {
    const directory = options.agentDir ?? getAgentDir();
    const readJson = async (name: string) => {
      try {
        // Pi can resolve command credentials even during an offline catalog refresh.
        return JSON.parse(await readFile(path.join(directory, name), "utf8"), (_key, value) =>
          typeof value === "string" && value.startsWith("!") ? "doctor-command-configured" : value);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    };
    const credentials = new InMemoryCredentialStore();
    for (const [provider, credential] of Object.entries(await readJson("auth.json"))) {
      await credentials.modify(provider, async () => credential as Credential);
    }
    const modelsStore = new InMemoryModelsStore();
    for (const [provider, entry] of Object.entries(await readJson("models-store.json"))) {
      await modelsStore.write(provider, entry as ModelsStoreEntry);
    }
    const inspection = await mkdtemp(path.join(tmpdir(), "tutor-doctor-model-"));
    try {
      const modelsPath = path.join(inspection, "models.json");
      await writeFile(modelsPath, JSON.stringify(await readJson("models.json")), { mode: 0o600 });
      const runtime = await ModelRuntime.create({ credentials, modelsStore, modelsPath, allowModelNetwork: false });
      if (runtime.getError()) throw new Error("invalid configuration");
      const selected = resolveCliModel({ cliModel: options.model ?? defaultModel, modelRuntime: runtime });
      if (!selected.model?.input.includes("image")) throw new Error("no image model");
      report(runtime.hasConfiguredAuth(selected.model.provider), "model credentials", "Configure the selected provider's environment variables or auth.json; see docs/models.md");
    } finally {
      await rm(inspection, { recursive: true, force: true });
    }
  });
  console.log(failures ? `${failures} check(s) failed. See docs/install.md.` : "All local checks passed. Model/OCR service access remains unverified.");
  return failures ? 1 : 0;
}

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

const resources = path.join(import.meta.dirname, "resources");
if (Bun.isStandaloneExecutable) {
  process.env.PI_PACKAGE_DIR = path.join(resources, "pi");
  registerBunOAuthFlows();
  setBedrockProviderModule(bedrockProviderModule);
}

let seccompPath: Promise<string> | undefined;

export async function sandboxOptions() {
  if (process.platform !== "linux" || !Bun.isStandaloneExecutable) return {};
  seccompPath ??= (async () => {
    // Linux execve needs a real file; keep the embedded helper in a private per-process directory.
    const directory = await mkdtemp(path.join(tmpdir(), "tutor-seccomp-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    const helper = path.join(directory, "apply-seccomp");
    await writeFile(helper, await readFile(path.join(resources, "seccomp", process.arch, "apply-seccomp")), { mode: 0o700, flag: "wx" });
    return helper;
  })();
  return { seccomp: { applyPath: await seccompPath } };
}

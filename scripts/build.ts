import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const requested = process.argv.slice(2);
const selected = requested.length ? requested : [`${process.platform}-${process.arch}`];
if (selected.some((target) => !targets.includes(target))) {
  throw new Error(`Build targets: ${targets.join(", ")}`);
}
const root = path.resolve(import.meta.dirname, "..");
process.chdir(root);
const guiBuild = Bun.spawn(
  [process.execPath, "--no-env-file", "run", "--filter", "@cqu-moe/tutor-gui", "build"],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (await guiBuild.exited !== 0) throw new Error("GUI build failed; run bun install --frozen-lockfile at the repository root");
const pi = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const resources = ".build/resources";
await rm(resources, { recursive: true, force: true });
await mkdir(`${resources}/pi`, { recursive: true });
await cp("gui/dist", `${resources}/gui`, { recursive: true });
const durableRequire = createRequire(import.meta.resolve("@earendil-works/pi-durable"));
await cp(durableRequire.resolve("@silvia-odwyer/photon/photon_rs_bg.wasm"), `${resources}/photon_rs_bg.wasm`);
await cp(path.join(pi, "../package.json"), `${resources}/pi/package.json`);
await cp(path.join(pi, "modes/interactive/theme"), `${resources}/pi/theme`, { recursive: true, filter: (file) => !path.extname(file) || file.endsWith(".json") });
for (const arch of ["arm64", "x64"]) {
  await mkdir(`${resources}/seccomp/${arch}`, { recursive: true });
  await cp(`node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/${arch}/apply-seccomp`, `${resources}/seccomp/${arch}/apply-seccomp`);
}

for (const target of selected) {
  const outfile = `dist/tutor-${target}`;
  const result = await Bun.build({
    entrypoints: ["src/cli.ts"],
    minify: true,
    compile: {
      target: `bun-${target}${target === "linux-x64" ? "-baseline" : ""}`,
      outfile,
      assets: [resources],
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    plugins: [{
      name: "embed-photon-wasm",
      setup(build) {
        build.onLoad({ filter: /photon-node\/photon_rs\.js$/ }, async ({ path: file }) => {
          const source = await readFile(file, "utf8");
          const lookup = "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');";
          if (!source.includes(lookup)) throw new Error("Photon WASM loader changed; review its standalone asset handling");
          // Photon otherwise bakes the build machine's node_modules path into the executable.
          return { contents: `import wasmPath from "./photon_rs_bg.wasm" with { type: "file" };\n${source.replace(lookup, "const path = wasmPath;")}`, loader: "js" };
        });
      },
    }],
  });
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${target}`);
  console.log(`${outfile} (${(Bun.file(outfile).size / 1024 / 1024).toFixed(1)} MiB)`);
}

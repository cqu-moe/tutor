#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`tutor: cannot start CLI: ${error.message}`);
  process.exit(1);
});
child.on("close", (code) => process.exit(code ?? 1));

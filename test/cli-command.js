import path from "node:path";

export const cliCommand = process.env.TUTOR_TEST_BINARY
  ? [path.resolve(process.env.TUTOR_TEST_BINARY)]
  : [process.execPath, "--no-env-file", path.resolve(import.meta.dirname, "../src/cli.ts")];

import { createInterface } from "node:readline";

export function createTerminalInput() {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const queuedLines: string[] = [];
  const lineWaiters: Array<(line: string | undefined) => void> = [];
  let inputClosed = false;
  lines.on("line", (line) => {
    const resolve = lineWaiters.shift();
    if (resolve) resolve(line);
    else queuedLines.push(line);
  });
  lines.on("close", () => {
    inputClosed = true;
    for (const resolve of lineWaiters.splice(0)) resolve(undefined);
  });
  return {
    nextLine: () => queuedLines.length
      ? Promise.resolve(queuedLines.shift()!)
      : Promise.resolve(inputClosed ? undefined : new Promise<string | undefined>((resolve) => lineWaiters.push(resolve))),
    close: () => lines.close(),
  };
}

import { spawn } from 'node:child_process';
import { ownerDescriptor } from './ownership.ts';

// A subprocess-local supervisor holds the SAME flock open description. If the
// Tutor owner dies, it kills the command's process group before dropping that
// descriptor. Only the trusted supervisor inherits it; model commands cannot
// unlock the owner through a shared descriptor. Descendants need no lease code.
const supervisor = `
const {spawn}=require('node:child_process');
const [owner,command,...args]=process.argv.slice(1);
const child=spawn(command,args,{detached:true,stdio:['pipe','pipe','pipe'],env:process.env});
const kill=()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}};
process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
process.on('SIGTERM',kill);
const timer=setInterval(()=>{try{process.kill(Number(owner),0)}catch{kill()}},50);
child.on('error',error=>{console.error(error.message);clearInterval(timer);process.exitCode=1});
child.on('exit',code=>{kill();clearInterval(timer);process.exitCode=code??1});
`;
export async function ownedCommand(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number;
  input?: string; signal?: AbortSignal; onData?: (data: Buffer) => void;
} = {}) {
  const fd = ownerDescriptor();
  const child = fd === undefined ? spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe','pipe','pipe'] })
    : spawn(process.execPath, ['--no-env-file','-e',supervisor,String(process.pid),command,...args], {
      cwd: options.cwd, env: { ...options.env ?? process.env, BUN_BE_BUN: '1' }, detached: true, stdio: ['pipe','pipe','pipe',fd],
    });
  const chunks: Buffer[] = [], errors: Buffer[] = [];
  let size = 0, failure = '';
  const stop = (reason: string) => { failure = reason; try { if (fd === undefined) process.kill(-child.pid!, 'SIGKILL'); else child.kill('SIGTERM'); } catch {} };
  const timer = options.timeout ? setTimeout(() => stop('command timed out'), options.timeout) : undefined;
  const abort = () => stop('command aborted');
  options.signal?.addEventListener('abort', abort, { once: true });
  const consume = (target: Buffer[]) => (data: Buffer) => {
    size += data.length;
    if (size > (options.maxBuffer ?? 32 * 1024 * 1024)) { stop('command output limit exceeded'); return; }
    target.push(data); options.onData?.(data);
  };
  child.stdout!.on('data', consume(chunks)); child.stderr!.on('data', consume(errors));
  child.stdin!.on('error', () => {}); child.stdin!.end(options.input);
  try {
    if (options.signal?.aborted) abort();
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const stdout = Buffer.concat(chunks).toString(), stderr = Buffer.concat(errors).toString();
    if (failure || exitCode !== 0) throw new Error(`${command} failed: ${failure || stderr || `exit ${exitCode}`}`);
    return { stdout, stderr, exitCode };
  } finally { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

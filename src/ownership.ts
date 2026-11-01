import { closeSync, openSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';

let descriptor: number | undefined;
export const ownerDescriptor = () => descriptor;

// The inode is permanent. The OS releases flock on exit, including SIGKILL.
export async function ownDataDirectory(directory: string) {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Data directory single-writer ownership requires macOS or Linux');
  const native = dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const fd = openSync(path.join(root, '.owner.lock'), 'a+');
  if (native.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd); native.close();
    throw new Error(`Data directory is already owned by another Tutor process (single-writer): ${root}. Close that executor before reopening.`);
  }
  descriptor = fd;
  let closed = false;
  return { root, close() { if (!closed) { closed = true; descriptor = undefined; closeSync(fd); native.close(); } } };
}

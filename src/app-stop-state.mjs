import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';

// A stopped application must not keep writing wake events through installed hooks.
export async function readAppStopState(root) {
  const path = join(root, 'app-stop.json');
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1
      || (before.mode & 0o077) || before.size > 4096) throw new Error('Unverified application stop state.');
    const value = JSON.parse(await file.readFile('utf8'));
    const after = await file.stat(), named = await lstat(path);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])
      || after.ino !== named.ino || after.dev !== named.dev || named.isSymbolicLink())
      throw new Error('Application stop state changed during inspection.');
    if (value?.version !== 1 || typeof value.stopped !== 'boolean'
      || (value.resuming !== undefined && typeof value.resuming !== 'boolean')) throw new Error('Invalid application stop state.');
    return value;
  } finally { await file.close(); }
}

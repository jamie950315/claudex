import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Read-only ownership check. Desktop adoption is not a disposable CLI copy. */
export async function desktopOwnsSession(root, nativeId) {
  if (!root) return false;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(nativeId)) throw new Error('Invalid desktop session identity.');
  async function visit(path, depth) {
    let entries;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Symlinked desktop session storage cannot be checked safely.');
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Symlinked desktop session storage cannot be checked safely.');
      if (entry.name === `local_${nativeId}.json` && entry.isFile()) return true;
      // Native layout: account / organization / local_<CLI UUID>.json.
      if (depth < 2 && entry.isDirectory() && await visit(join(path, entry.name), depth + 1)) return true;
    }
    return false;
  }
  return visit(root, 0);
}

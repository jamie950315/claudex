import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LOCAL_RECORD = /^local_([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.json$/i;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function readRecord(path, expected) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || !sameFile(before, expected) || before.nlink !== 1
        || before.uid !== process.getuid() || before.size > MAX_RECORD_BYTES)
      throw new Error('Desktop session registry is not a bounded owned regular file.');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== before.size || !sameFile(before, await file.stat()) || !sameFile(before, await lstat(path)))
      throw new Error('Desktop session registry changed while being read.');
    let record;
    try { record = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw new Error('Malformed Desktop session registry; ownership cannot be established safely.'); }
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error('Malformed Desktop session registry; ownership cannot be established safely.');
    return record;
  } finally { await file.close(); }
}

/** Read-only ownership check. Desktop adoption is not a disposable CLI copy. */
export async function desktopOwnsSession(root, nativeId) {
  if (!root) return false;
  if (typeof nativeId !== 'string' || !UUID.test(nativeId)) throw new Error('Invalid desktop session identity.');
  let scanned = 0;
  async function visit(path, depth) {
    let entries, before;
    try {
      before = await lstat(path);
      if (before.isSymbolicLink()) throw new Error('Symlinked desktop session storage cannot be checked safely.');
      if (!before.isDirectory()) throw new Error('Desktop session storage is not a directory.');
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT' && depth === 0 && !before) return false; throw error; }
    scanned += entries.length;
    if (scanned > 16_384) throw new Error('Desktop session registry scan exceeded its safety bound.');
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Symlinked desktop session storage cannot be checked safely.');
      const match = LOCAL_RECORD.exec(entry.name);
      if (!match && entry.name.startsWith('local_') && entry.name.endsWith('.json'))
        throw new Error('Ambiguous Desktop session registry filename; ownership cannot be established safely.');
      if (match) {
        const target = join(path, entry.name);
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid())
          throw new Error('Desktop session registry is not an owned regular file.');
        // Adopted records historically used the CLI UUID in the filename. A
        // matching filename remains enough to protect that session without
        // interpreting private registry content, including archived records.
        if (match[1].toLowerCase() === nativeId.toLowerCase()) return true;
        const record = await readRecord(target, info);
        // New Desktop sessions have independent UI and CLI identities. Do not
        // mistake the local_<UI UUID> filename for the transcript UUID.
        if (record.sessionId !== `local_${match[1]}` || typeof record.cliSessionId !== 'string' || !UUID.test(record.cliSessionId))
          throw new Error('Ambiguous Desktop session registry identity; ownership cannot be established safely.');
        if (record.cliSessionId.toLowerCase() === nativeId.toLowerCase()) return true;
      }
      // Native layout: account / organization / local_<Desktop UUID>.json.
      if (depth < 2 && entry.isDirectory() && await visit(join(path, entry.name), depth + 1)) return true;
    }
    if (!sameFile(before, await lstat(path))) throw new Error('Desktop session storage changed during ownership lookup.');
    return false;
  }
  return visit(root, 0);
}

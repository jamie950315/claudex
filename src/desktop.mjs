import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LOCAL_RECORD = /^local_([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.json$/i;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const IDENTITY = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'];
const sameFile = (a, b) => IDENTITY.every(key => a[key] === b[key]);
// Preserve the legacy Stats millisecond representation; guards use exact ns.
const milliseconds = ns => Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1e6;

async function readRecord(path, expected) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || !sameFile(before, expected) || before.nlink !== 1n
        || before.uid !== BigInt(process.getuid()) || (before.mode & 0o022n) || before.size > BigInt(MAX_RECORD_BYTES))
      throw new Error('Desktop session registry is not a bounded owned regular file.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (BigInt(length) !== before.size || !sameFile(before, await file.stat({ bigint: true }))
      || !sameFile(before, await lstat(path, { bigint: true })))
      throw new Error('Desktop session registry changed while being read.');
    let record;
    try { record = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw new Error('Malformed Desktop session registry; ownership cannot be established safely.'); }
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error('Malformed Desktop session registry; ownership cannot be established safely.');
    return record;
  } finally { await file.close(); }
}

// Desktop writes a record before its CLI session exists (for example a Remote
// Control spawn that never ran). With the exact filename identity and no CLI
// identity at all, it maps to no native transcript. A present but invalid CLI
// identity is still ambiguous.
const unstarted = (record, uiId) => record.sessionId === `local_${uiId}`
  && (record.cliSessionId === undefined || record.cliSessionId === null);

/** Read-only ownership check. Desktop adoption is not a disposable CLI copy. */
export async function desktopOwnsSession(root, nativeId) {
  if (!root) return false;
  if (typeof nativeId !== 'string' || !UUID.test(nativeId)) throw new Error('Invalid desktop session identity.');
  let scanned = 0;
  async function visit(path, depth) {
    let entries, before;
    try {
      before = await lstat(path, { bigint: true });
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
        const info = await lstat(target, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.uid !== BigInt(process.getuid()))
          throw new Error('Desktop session registry is not an owned regular file.');
        // Adopted records historically used the CLI UUID in the filename. A
        // matching filename remains enough to protect that session without
        // interpreting private registry content, including archived records.
        if (match[1].toLowerCase() === nativeId.toLowerCase()) return true;
        const record = await readRecord(target, info);
        // New Desktop sessions have independent UI and CLI identities. Do not
        // mistake the local_<UI UUID> filename for the transcript UUID.
        if (unstarted(record, match[1])) continue;
        if (record.sessionId !== `local_${match[1]}` || typeof record.cliSessionId !== 'string' || !UUID.test(record.cliSessionId))
          throw new Error('Ambiguous Desktop session registry identity; ownership cannot be established safely.');
        if (record.cliSessionId.toLowerCase() === nativeId.toLowerCase()) return true;
      }
      // Native layout: account / organization / local_<Desktop UUID>.json.
      if (depth < 2 && entry.isDirectory() && await visit(join(path, entry.name), depth + 1)) return true;
    }
    if (!sameFile(before, await lstat(path, { bigint: true }))) throw new Error('Desktop session storage changed during ownership lookup.');
    return false;
  }
  return visit(root, 0);
}

/** Resolve exact native-to-Desktop identities without granting write ownership.
 * Unlike the conservative ownership denylist above, an action intent requires
 * an unambiguous parsed record; filename identity alone is never sufficient.
 */
export async function readDesktopSessionMappings(root, nativeIds) {
  return readMappings(root, nativeIds, false);
}

/** Title presentation alone may report invalid metadata for an exact known
 * identity. Such error entries contain no action/ownership mapping fields.
 * Unsafe storage, malformed records and ambiguous identities still fail closed.
 */
export async function readDesktopTitleMappings(root, nativeIds) {
  return readMappings(root, nativeIds, true);
}

async function readMappings(root, nativeIds, metadataErrors) {
  if (!Array.isArray(nativeIds) || nativeIds.length > 4096 || nativeIds.some(id => typeof id !== 'string' || !UUID.test(id)))
    throw new Error('Invalid Desktop session mapping identities.');
  const wanted = new Set(nativeIds.map(id => id.toLowerCase())), result = new Map();
  if (!root || !wanted.size) return result;
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error('Desktop registry root must be canonical.');
  let scanned = 0;
  async function visit(path, depth) {
    let before;
    try { before = await lstat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT' && depth === 0) return; throw error; }
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid())
      || await realpath(path) !== path) throw new Error('Desktop session storage is not a canonical owned directory.');
    const entries = await readdir(path, { withFileTypes: true });
    scanned += entries.length;
    if (scanned > 16_384) throw new Error('Desktop session registry scan exceeded its safety bound.');
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Symlinked desktop session storage cannot be checked safely.');
      const match = LOCAL_RECORD.exec(entry.name);
      if (!match && entry.name.startsWith('local_') && entry.name.endsWith('.json'))
        throw new Error('Ambiguous Desktop session registry filename.');
      const target = join(path, entry.name);
      if (match) {
        const info = await lstat(target, { bigint: true }), record = await readRecord(target, info);
        if (unstarted(record, match[1])) continue;
        if (record.sessionId !== `local_${match[1]}` || typeof record.cliSessionId !== 'string' || !UUID.test(record.cliSessionId))
          throw new Error('Ambiguous Desktop session registry identity.');
        const id = record.cliSessionId.toLowerCase();
        if (!wanted.has(id)) continue;
        if (result.has(id)) throw new Error('Multiple Desktop records map to the same native session.');
        const invalid = typeof record.cwd !== 'string' || !isAbsolute(record.cwd) || resolve(record.cwd) !== record.cwd
          || typeof record.title !== 'string' || !record.title.trim() || record.title.length > 4096
          || /[\x00-\x1f\x7f]/.test(record.title) || typeof record.isArchived !== 'boolean'
          || !Number.isSafeInteger(record.lastActivityAt) || record.lastActivityAt < 0;
        if (invalid) {
          const error = 'Desktop session mapping lacks exact cwd, title, activity or archive metadata.';
          if (!metadataErrors) throw new Error(error);
          result.set(id, { error }); continue;
        }
        result.set(id, { sessionId: record.sessionId, nativeId: record.cliSessionId, cwd: record.cwd,
          title: record.title, lastActivityAt: record.lastActivityAt, isArchived: record.isArchived,
          registryPath: target, registryIdentity: {
            ...Object.fromEntries(['dev', 'ino', 'size', 'uid', 'nlink'].map(key => [key, Number(info[key])])),
            mtimeMs: milliseconds(info.mtimeNs), ctimeMs: milliseconds(info.ctimeNs),
            mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
          } });
      } else if (entry.isDirectory() && depth < 2) await visit(target, depth + 1);
    }
    if (!sameFile(before, await lstat(path, { bigint: true }))) throw new Error('Desktop session storage changed during mapping lookup.');
  }
  await visit(root, 0);
  return result;
}

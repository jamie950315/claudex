import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

// Codex compresses a rollout left unchanged for seven days to <name>.jsonl.zst
// and restores the plain file before its next append. Native APIs and saved
// records keep naming the plain .jsonl path, so it stays the logical identity;
// readers open whichever single representation is present. The plain file
// wins when both exist, as it does in Codex.
const COMPRESSED_SUFFIX = '.zst';

export const isCompressedRollout = path => typeof path === 'string' && path.endsWith(`.jsonl${COMPRESSED_SUFFIX}`);

export const plainRolloutPath = path => isCompressedRollout(path) ? path.slice(0, -COMPRESSED_SUFFIX.length) : path;

/** A rollout file name in either representation. */
export const isRolloutFileName = name => name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith(`.jsonl${COMPRESSED_SUFFIX}`));

/** The physical file for a logical rollout path. A missing rollout reports the
 * plain path's own ENOENT, so callers keep their existing absence handling. */
export async function physicalRolloutPath(path, stat = lstat) {
  return (await statRollout(path, stat)).path;
}

/** The physical file for a logical rollout path together with its status. */
export async function statRollout(path, stat = lstat) {
  try { return { path, info: await stat(path) }; }
  catch (error) {
    if (error.code !== 'ENOENT' || typeof path !== 'string' || !path.endsWith('.jsonl')) throw error;
    const compressed = `${path}${COMPRESSED_SUFFIX}`;
    try { return { path: compressed, info: await stat(compressed) }; }
    catch (compressedError) { if (compressedError.code === 'ENOENT') throw error; throw compressedError; }
  }
}

/** The working-directory strings in rollout headers and turn contexts that
 * name the same directory as cwd. Codex records the path it was started
 * with, which can be an alias (symlink) of that directory, while its API may
 * report either form; the proof compares the directory, not the spelling. */
export async function recordedDirectories(rows, cwd) {
  const accepted = new Set([cwd]), directory = await realpath(cwd).catch(() => null);
  const recorded = new Set(rows.filter(row => row?.type === 'session_meta' || row?.type === 'turn_context')
    .map(row => row.payload?.cwd));
  for (const value of recorded)
    if (typeof value === 'string' && value !== cwd && isAbsolute(value) && resolve(value) === value
      && directory !== null && await realpath(value).catch(() => null) === directory) accepted.add(value);
  return accepted;
}

/** Whether neither representation of a logical rollout path exists. */
export async function rolloutAbsent(path, stat = lstat) {
  try { await physicalRolloutPath(path, stat); return false; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return true; throw error; }
}

/** Prove absence for one exact thread in the native rollout layout. Inspect
 * names only, including compressed files and rollover segments. An alias or
 * unreadable directory cannot establish absence. This never adopts a path. */
export async function codexThreadRolloutAbsent(codexHome, nativeId) {
  const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
  if (!isAbsolute(codexHome ?? '') || typeof nativeId !== 'string' || !new RegExp(`^${uuid}$`, 'i').test(nativeId))
    throw new Error('Exact Codex home and native thread identity are required for rollout absence.');
  const name = new RegExp(`^(?:rollout-(?:.*-)?)?${nativeId}(?:_${uuid})?\\.jsonl(?:\\.zst)?$`, 'i');
  const visit = async (directory, depth) => {
    let info;
    try { info = await lstat(directory, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory)
      throw new Error('Unsafe Codex rollout directory; absence is unverified.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (name.test(entry.name)) return false; // Even an unsafe matching entry is not absent.
      if (depth > 0 && /^\d+$/.test(entry.name) && !entry.isFile())
        if (!await visit(join(directory, entry.name), depth - 1)) return false;
    }
    const after = await lstat(directory, { bigint: true });
    if (['dev', 'ino', 'mtimeNs', 'ctimeNs', 'mode', 'uid'].some(key => info[key] !== after[key]))
      throw new Error('Codex rollout directory changed; absence is unverified.');
    return true;
  };
  return await visit(join(codexHome, 'sessions'), 3)
    && await visit(join(codexHome, 'archived_sessions'), 0);
}

/** Decompress the complete bytes of a compressed rollout within a byte limit. */
export function decompressRollout(bytes, maxBytes = Number.MAX_SAFE_INTEGER) {
  const limit = Math.min(maxBytes + 1, 2 ** 31 - 1);
  try { return zstdDecompressSync(bytes, { maxOutputLength: limit }); }
  catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError)
      throw Object.assign(new Error('Compressed Codex rollout exceeds its byte limit.'), { cause: error });
    throw Object.assign(new Error('Compressed Codex rollout is not a complete zstd stream.'), { cause: error });
  }
}

/** Read and decompress a compressed rollout through a no-follow descriptor
 * whose identity matches the named file before and after the read. A
 * compressed rollout is never appended; Codex restores a new plain file. */
export async function readCompressedRollout(path, named, maxBytes, openFile = open) {
  const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
    const before = await file.stat();
    if (!before.isFile() || !same(named, before)) throw new Error('Transcript changed while being read: compressed Codex rollout was replaced.');
    const stored = await file.readFile();
    if (stored.length !== before.size || !same(before, await file.stat()))
      throw new Error('Transcript changed while being read: compressed Codex rollout was replaced.');
    return decompressRollout(stored, maxBytes);
  } finally { await file.close(); }
}

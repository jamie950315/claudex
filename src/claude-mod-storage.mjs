import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { insist, absolute } from './claude-mod-protocol.mjs';
const identityFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'];
const same = (a, b) => identityFields.every(key => a[key] === b[key]);
function ownedFile(stat, maxBytes) {
  insist(stat.isFile() && stat.uid === BigInt(process.getuid()) && stat.nlink === 1n
    && (stat.mode & 0o777n) === 0o600n && stat.size <= BigInt(maxBytes),
  'UNSAFE_FILE', 'Companion storage must be an owner-private regular file with one link.');
}
export async function privateDir(path, create = false) {
  absolute(path);
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await lstat(path);
  insist(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o700 && await realpath(path) === path,
  'UNSAFE_ROOT', 'Use an existing canonical, owner-private 0700 directory.');
  return path;
}
/** Bounded reads also reject FIFOs, symlinks, hardlinks and concurrent replacement. */
export async function privateRead(path, { maxBytes = 1024 * 1024, optional = false } = {}) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const before = await handle.stat({ bigint: true }); ownedFile(before, maxBytes);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    ownedFile(after, maxBytes); ownedFile(named, maxBytes);
    insist(offset === Number(before.size) && same(before, after) && same(after, named),
      'FILE_CHANGED', 'Storage changed during inspection; preserve it and inspect again.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await handle.close(); }
}
export async function privateJSON(path, options) {
  const raw = await privateRead(path, options);
  return raw === null ? null : JSON.parse(raw);
}
export async function syncDir(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Atomic publication keeps action receipts durable across process termination. */
export async function writeReceipt(path, value, { exclusive = false } = {}) {
  await privateDir(dirname(path));
  const data = `${JSON.stringify(value)}\n`;
  insist(Buffer.byteLength(data) <= 2 * 1024 * 1024, 'RECEIPT_BOUND', 'Receipt exceeds its storage bound.');
  if (exclusive) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await syncDir(dirname(path)); return;
  }
  // Verify the old receipt before replacing its name. A suspect file stays intact.
  await privateRead(path, { maxBytes: 2 * 1024 * 1024 });
  const temporary = join(dirname(path), `.write-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); await syncDir(dirname(path)); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function exclusiveAction(path, operation) {
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') return { state: 'locked', outcome: 'inspect-receipt', automaticReplay: false }; throw error; }
  const before = await handle.stat({ bigint: true });
  try { await handle.writeFile('action-lock\n'); await handle.sync(); return await operation(); }
  finally {
    await handle.close();
    const named = await lstat(path, { bigint: true }).catch(() => null);
    if (named?.dev === before.dev && named?.ino === before.ino && named.isFile() && named.nlink === 1n) await unlink(path);
  }
}

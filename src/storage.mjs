import { mkdir, open, readFile, rename, chmod, stat, unlink, link, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export async function privateDirectory(path) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Private directory must not be a symlink.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Private directory must not be a symlink.');
  return realpath(path);
}

async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writeTemporary(path, value) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}

export async function readJSON(path, fallback) {
  try {
    const text = await readFile(path, 'utf8');
    try { return JSON.parse(text); } catch { throw new Error('Malformed JSON state; inspect the local file before continuing.'); }
  }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next`;
  await writeTemporary(temporary, value);
  await rename(temporary, path);
  await chmod(path, 0o600);
  await syncDirectory(dirname(path));
}

/** Publish a complete native file without ever replacing an existing session. */
export async function publishExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.claudex-next`;
  await writeTemporary(temporary, value);
  try { await link(temporary, path); await syncDirectory(dirname(path)); }
  finally { await unlink(temporary); }
}

export const writeJSON = (path, value) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);

/** Disposable status diagnostics only: readers still observe either the old or
 * the new complete file through the atomic rename, but the frequent heartbeat
 * does not force a full device flush. A crash may leave the previous or an
 * unreadable diagnostic until the next heartbeat; never use this for journals,
 * checkpoints, ownership or any state that authorizes work.
 */
export async function writeDiagnosticJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await file.close(); }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

async function reclaimDeadLock(path) {
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()
      || (directory.mode & 0o077) !== 0) throw new Error('Lock directory is not private and owned; stale lock was preserved.');
  let original;
  try { original = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!original.isFile() || original.isSymbolicLink() || original.uid !== process.getuid()
      || (original.mode & 0o777) !== 0o600 || original.nlink !== 1)
    throw new Error('Lock is not a private owned regular file; stale lock was preserved.');
  // The prior owner can finish after our exclusive-create attempt. Absence
  // before a reclaim claim only means the caller should retry exclusive create.
  let contents;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (contents === '') {
    // Exclusive creation precedes the owner's async write. A fresh, unchanged
    // empty file is contention, never evidence that it is safe to reclaim.
    let confirmedContents, confirmed;
    try { confirmedContents = await readFile(path, 'utf8'); confirmed = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!sameFile(original, confirmed)) throw new Error('Lock identity changed; stale lock was preserved.');
    if (original.size !== 0 || confirmedContents !== ''
        || ['size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'nlink'].some(key => original[key] !== confirmed[key]))
      throw new Error('Lock state changed during owner publication; stale lock was preserved.');
    const ageMs = Date.now() - Math.floor(original.mtimeMs);
    if (ageMs >= 0 && ageMs <= 1000)
      throw new Error('Another bridge operation holds the lock; lock owner publication is pending. Inspect status before retrying.');
    throw new Error('Malformed lock owner; stale lock was preserved.');
  }
  let owner;
  try { owner = JSON.parse(contents); }
  catch { throw new Error('Malformed lock owner; stale lock was preserved.'); }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.started !== 'string'
      || !Number.isFinite(Date.parse(owner.started))) throw new Error('Malformed lock owner; stale lock was preserved.');
  let current;
  try { current = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!sameFile(original, current)) throw new Error('Lock identity changed; stale lock was preserved.');
  if (alive(owner.pid)) throw new Error('Another bridge operation holds the lock. Inspect status before retrying.');
  const claim = `${path}.reclaim`;
  try { await link(path, claim); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    if (error.code === 'EEXIST') throw new Error('Another stale-lock recovery is in progress; lock was preserved.');
    throw error;
  }
  try {
    const claimed = await lstat(claim);
    const current = await lstat(path);
    if (!sameFile(original, claimed) || !sameFile(original, current) || claimed.nlink !== 2
        || current.nlink !== 2 || (await readFile(claim, 'utf8')) !== contents || alive(owner.pid))
      throw new Error('Lock changed during stale recovery; lock was preserved.');
    await unlink(path);
  } finally {
    if (sameFile(original, await lstat(claim))) await unlink(claim);
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export async function withLock(path, fn, { recoverDead = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') {
      if (!recoverDead) throw new Error('Another bridge operation holds the lock. Inspect status before retrying.');
      await reclaimDeadLock(path);
      try { file = await open(path, 'wx', 0o600); }
      catch (retryError) {
        if (retryError.code === 'EEXIST') throw new Error('Another bridge operation holds the lock. Inspect status before retrying.');
        throw retryError;
      }
    } else throw error;
  }
  try { await file.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); return await fn(); }
  finally { await file.close(); await unlink(path); }
}

export async function snapshot(path) {
  const before = await stat(path);
  const text = await readFile(path, 'utf8');
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Transcript changed while being read.');
  if (text && !text.endsWith('\n')) throw new Error('Transcript has an incomplete final line.');
  const rows = text.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Malformed transcript record at line ${index + 1}; source left unchanged.`); }
  });
  return { text, rows, hash: hash(text), bytes: after.size, mtimeMs: after.mtimeMs };
}

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

export async function withLock(path, fn) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another bridge operation holds the lock. Inspect status before retrying.');
    throw error;
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

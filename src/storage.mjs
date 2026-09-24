import { mkdir, open, readFile, rename, chmod, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  await chmod(path, 0o600);
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
  const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { text, rows, hash: hash(text), bytes: after.size, mtimeMs: after.mtimeMs };
}

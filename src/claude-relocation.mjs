import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { readDesktopSessionMappings } from './desktop.mjs';
import { sessionPath } from './claude.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const identityKeys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'];
const identity = value => Object.fromEntries(identityKeys.map(key => [key, String(value[key])]));
const same = (a, b) => identityKeys.every(key => a[key] === b[key]);
const canonical = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
const beneath = (value, root) => value === root || value.startsWith(`${root}${sep}`);
const fail = message => {
  const error = new Error(`Claude project relocation blocked: ${message}`);
  error.code = 'CLAUDE_RELOCATION_BLOCKED';
  throw error;
};
const waitForBoundary = cause => {
  throw new Error('Source history changed between complete reads; relocation waits for a stable boundary.', { cause });
};

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || await realpath(path) !== path)
    fail('project storage or working directory is not a canonical owned directory.');
}

async function readTranscript(path, maxBytes) {
  const expected = await lstat(path, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n
    || expected.uid !== BigInt(process.getuid()) || expected.size < 0n || expected.size > BigInt(maxBytes)
    || await realpath(path) !== path)
    fail('relocated transcript is not a bounded canonical owned regular file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!same(before, expected)) waitForBoundary();
    const size = Number(before.size);
    const bytes = Buffer.alloc(size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== size || !same(before, await file.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true })))
      waitForBoundary();
    const text = bytes.subarray(0, length).toString('utf8');
    if (!text || !text.endsWith('\n')) waitForBoundary();
    let rows;
    try { rows = text.split('\n').filter(Boolean).map(JSON.parse); }
    catch { fail('relocated transcript contains a malformed record.'); }
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('relocated transcript contains a malformed record.');
    return { text, rows, hash: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'), bytes: length,
      mtimeMs: Number(before.mtimeNs) / 1e6, identity: identity(before) };
  } finally { await file.close(); }
}

/** Read-only native relocation evidence. This never authorizes a transcript
 * writer or advances a checkpoint. The caller must still decode full history
 * and authenticate the exact saved canonical prefix before changing its ledger.
 */
export async function inspectClaudeProjectRelocation({ claudeHome, desktopRegistryRoot, record,
  historicalCwds = [], maxBytes = 512 * 1024 * 1024 }) {
  if (record?.side !== 'claude' || record.managed !== false || record.kind !== 'original'
    || !UUID.test(record.nativeId) || !canonical(record.cwd) || !canonical(claudeHome)
    || record.path !== sessionPath(claudeHome, record.cwd, record.nativeId)
    || !Array.isArray(historicalCwds) || historicalCwds.length > 16 || historicalCwds.some(value => !canonical(value))
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024)
    fail('saved original identity or resource bound is invalid.');
  const lookup = async () => {
    try { return await readDesktopSessionMappings(desktopRegistryRoot, [record.nativeId]); }
    catch (error) {
      if (/^Desktop session (?:registry changed while being read|storage changed during mapping lookup)\.$/.test(error.message))
        waitForBoundary(error);
      throw error;
    }
  };
  const mapping = (await lookup()).get(record.nativeId.toLowerCase());
  if (!mapping || mapping.cwd === record.cwd) return null;
  const path = sessionPath(claudeHome, mapping.cwd, record.nativeId);
  if (path === record.path) fail('distinct project directories encode to the same native transcript path.');
  if (!await absent(record.path)) fail('saved transcript still exists; relocation is ambiguous.');
  await directory(claudeHome);
  await directory(resolve(claudeHome, 'projects'));
  await directory(dirname(path));
  await directory(mapping.cwd);
  const data = await readTranscript(path, maxBytes);
  const historyRoots = [record.cwd, ...historicalCwds, mapping.cwd];
  let latestCwd, enteredTarget = false;
  for (const row of data.rows) {
    if (row.sessionId != null && row.sessionId !== record.nativeId) fail('transcript native session identity differs from the saved original.');
    if (row.cwd != null && (!canonical(row.cwd) || !historyRoots.some(root => beneath(row.cwd, root))))
      fail('transcript working directory is outside the verified native project transition.');
    if (!row.isSidechain && (row.type === 'user' || row.type === 'assistant')) {
      if (!canonical(row.cwd) || row.sessionId !== record.nativeId) fail('authored transcript record lacks exact native session or working directory.');
      if (enteredTarget && row.cwd !== mapping.cwd && !beneath(row.cwd, mapping.cwd))
        fail('authored transcript returned to the previous project after relocation.');
      if (row.cwd === mapping.cwd) enteredTarget = true;
      latestCwd = row.cwd;
    }
  }
  if (!enteredTarget || latestCwd !== mapping.cwd) fail('latest authored working directory does not match the native registry.');
  const second = (await lookup()).get(record.nativeId.toLowerCase());
  if (JSON.stringify(second) !== JSON.stringify(mapping)
    || !same(data.identity, identity(await lstat(path, { bigint: true }))) || !await absent(record.path))
    waitForBoundary();
  return { nativeId: record.nativeId, previousCwd: record.cwd, cwd: mapping.cwd,
    previousPath: record.path, path, mapping, snapshot: data };
}

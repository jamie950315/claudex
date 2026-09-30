import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './storage.mjs';

const MAX_ENTRIES = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const REMOTE_ID = /^cse_[A-Za-z0-9_-]{1,200}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Claude folder map: ${message}`); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameSnapshot = (a, b) => sameFile(a, b)
  && ['size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].every(key => a[key] === b[key]);
const own = info => info.uid === BigInt(process.getuid());

function canonicalCwd(value) {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value)
    && !/[\x00-\x1f\x7f]/.test(value) && resolve(value) === value;
}

function assertFile(info) {
  if (!info.isFile() || !own(info) || (info.mode & 0o7777n) !== 0o600n || info.nlink !== 1n)
    fail('metadata must be a private owned regular file.');
  if (info.size > BigInt(MAX_BYTES)) fail('metadata exceeds the 2 MiB byte limit.');
}

async function privateDirectory(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || !own(info) || (info.mode & 0o7777n) !== 0o700n || await realpath(path) !== path)
    fail('metadata directory must be canonical, private and owned.');
  return info;
}

async function recheckDirectory(path, expected) {
  const current = await privateDirectory(path);
  if (!sameFile(expected, current)) fail('metadata directory changed during publication.');
}

/** Read at most the initially verified size plus one byte, never an unbounded
 * readFile on a file that a concurrent writer could keep growing.
 */
async function readMetadata(path, { optional = false } = {}) {
  let expected;
  try { expected = await lstat(path, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  assertFile(expected);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    assertFile(before);
    if (!sameSnapshot(expected, before)) fail('metadata changed before its read.');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    assertFile(after); assertFile(current);
    if (length !== Number(before.size) || !sameSnapshot(before, after) || !sameSnapshot(after, current))
      fail('metadata changed while being read.');
    let text, data;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); data = JSON.parse(text); }
    catch { fail('metadata contains malformed JSON.'); }
    return { path, identity: after, text, data };
  } finally { await file.close(); }
}

function validateExistingMap(value) {
  if (!object(value) || value.version !== 1 || Object.keys(value).sort().join(',') !== 'entries,version'
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) fail('existing map schema is invalid.');
  const ids = new Set();
  for (const entry of value.entries) {
    if (!object(entry) || Object.keys(entry).sort().join(',') !== 'canonicalCwd,remoteId,verified'
      || !REMOTE_ID.test(entry.remoteId) || !canonicalCwd(entry.canonicalCwd) || entry.verified !== true
      || ids.has(entry.remoteId)) fail('existing map entry is invalid or duplicated.');
    ids.add(entry.remoteId);
  }
}

async function unchangedFile(snapshot) {
  const current = await lstat(snapshot.path, { bigint: true });
  assertFile(current);
  if (!sameSnapshot(snapshot.identity, current)) fail('metadata changed before publication.');
}

/** Publish presentation-only verified owner identities. The caller supplies a
 * DesktopBridge snapshot under its existing coordinator ownership; this helper
 * never reads transcripts, starts an SDK worker, or changes native sessions.
 */
export async function publishClaudeFolderMap({ root, state } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
    || !object(state) || state.version !== 2 || !object(state.conversations) || !Array.isArray(state.records))
    fail('a canonical private root and Desktop ledger snapshot are required.');
  if (state.pending != null) {
    if (!object(state.pending)) fail('pending ledger state is invalid.');
    return { changed: false, entries: null, deferred: 'pending' };
  }

  const rootIdentity = await privateDirectory(root);
  const candidates = state.records.filter(record => object(record) && record.side === 'claude'
    && record.managed === true && record.verified === true && record.kind === 'owner' && record.status === 'current');
  if (candidates.length > MAX_ENTRIES) fail('owner count exceeds the 4096-entry limit.');
  const conversationIds = new Set();
  const selected = candidates.map(record => {
    const conversation = state.conversations[record.conversationId];
    if (!UUID.test(record.conversationId) || !UUID.test(record.nativeId) || !object(conversation)
      || conversation.id !== record.conversationId || !canonicalCwd(record.cwd) || conversation.cwd !== record.cwd
      || conversationIds.has(record.conversationId)) fail('current owner ledger identity is invalid or duplicated.');
    conversationIds.add(record.conversationId);
    return { conversationId: record.conversationId, nativeId: record.nativeId, cwd: record.cwd };
  });

  const ownersPath = join(root, 'owners');
  const ownersIdentity = selected.length ? await privateDirectory(ownersPath) : null;
  const snapshots = [], entries = [], remoteIds = new Set(), checkedCwds = new Set();
  for (const record of selected) {
    const snapshot = await readMetadata(join(ownersPath, `${hash(record.conversationId)}.json`));
    const owner = snapshot.data;
    if (!object(owner) || owner.version !== 1 || owner.conversationId !== record.conversationId
      || owner.sessionId !== record.nativeId || owner.cwd !== record.cwd || !REMOTE_ID.test(owner.remoteId)
      || owner.registration !== 'registered' || owner.blocked || remoteIds.has(owner.remoteId))
      fail('saved owner identity or Remote Control registration does not match its ledger.');
    if (owner.pending != null || owner.reset != null) return { changed: false, entries: null, deferred: 'owner_transition' };
    if (!checkedCwds.has(record.cwd)) {
      let canonical;
      try { canonical = await realpath(record.cwd); }
      catch (error) {
        // A removed project directory (for example a deleted worktree) only
        // loses its own folder override; it does not invalidate other rows.
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
        throw error;
      }
      if (canonical !== record.cwd || !(await lstat(record.cwd)).isDirectory()) fail('source cwd is not an existing canonical directory.');
      checkedCwds.add(record.cwd);
    }
    snapshots.push(snapshot);
    remoteIds.add(owner.remoteId);
    entries.push({ remoteId: owner.remoteId, canonicalCwd: record.cwd, verified: true });
  }
  entries.sort((a, b) => a.remoteId < b.remoteId ? -1 : a.remoteId > b.remoteId ? 1 : 0);
  const text = `${JSON.stringify({ version: 1, entries })}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) fail('generated map exceeds the 2 MiB byte limit.');
  const path = join(root, 'folder-map.json');
  const previous = await readMetadata(path, { optional: true });
  if (previous) validateExistingMap(previous.data);

  const recheck = async () => {
    await recheckDirectory(root, rootIdentity);
    if (ownersIdentity) await recheckDirectory(ownersPath, ownersIdentity);
    for (const snapshot of snapshots) await unchangedFile(snapshot);
    if (previous) await unchangedFile(previous);
    else {
      try { await lstat(path); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      fail('another publisher created the map during publication.');
    }
  };
  await recheck();
  if (previous?.text === text) return { changed: false, entries: entries.length, deferred: null };

  const temporary = join(root, `.folder-map.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let temporaryIdentity, published = false;
  try {
    temporaryIdentity = await file.stat({ bigint: true });
    await file.writeFile(text); await file.sync();
    await recheck();
    const currentTemporary = await lstat(temporary, { bigint: true });
    assertFile(currentTemporary);
    if (!sameFile(temporaryIdentity, currentTemporary)) fail('temporary publication identity changed.');
    await rename(temporary, path); published = true;
    const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return { changed: true, entries: entries.length, deferred: null };
  } finally {
    await file.close();
    if (!published) {
      const current = await lstat(temporary);
      if (BigInt(current.dev) === temporaryIdentity?.dev && BigInt(current.ino) === temporaryIdentity?.ino) await unlink(temporary);
    }
  }
}

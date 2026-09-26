import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { hash } from './storage.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const kinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const archived = path => path.includes(`${sep}archived_sessions${sep}`);
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'nlink'].every(key => a[key] === b[key]);
export function originalArchiveGuard(message) {
  return Object.assign(new Error(message), { code: 'CLAUDEX_ORIGINAL_ARCHIVE_BLOCKED' });
}
const fail = message => { throw originalArchiveGuard(`Preserved original archive: ${message}`); };

async function inventory(client, parentId) {
  const ids = new Set();
  // Native general inventories omit spawned rows on the pinned build even
  // with their source kinds selected. The ancestor inventory is independent.
  for (const mode of [{ loaded: true }, { archived: false }, { archived: true },
    { archived: false, ancestorThreadId: parentId }, { archived: true, ancestorThreadId: parentId }]) {
    let cursor; const cursors = new Set();
    do {
      if (cursors.size >= 100) fail('dependency inventory exceeds its page limit.');
      const result = await client.request(mode.loaded ? 'thread/loaded/list' : 'thread/list', {
        limit: 100, ...(mode.loaded ? {} : { ...mode, sourceKinds: kinds }), ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result.data)) fail('dependency inventory is malformed.');
      for (const value of result.data) {
        const id = mode.loaded ? value : value.id;
        if (!UUID.test(id)) fail('dependency identity is malformed.');
        ids.add(id);
      }
      if (ids.size > 10000) fail('dependency inventory exceeds its identity limit.');
      cursor = result.nextCursor;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) fail('dependency pagination repeated.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  const threads = [];
  for (const id of [...ids].sort()) {
    const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id) fail('dependency native identity changed.');
    threads.push(thread);
  }
  return threads;
}

async function fileProof(path, nativeId, budget) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1) fail('transcript is not an owned regular file.');
    budget.bytes += before.size;
    if (before.size > 512 * 1024 * 1024 || budget.bytes > 512 * 1024 * 1024) fail('tree exceeds its byte limit.');
    const digest = createHash('sha256'), headerChunks = [];
    let length = 0, headerLength = 0, endedHeader = false, lastByte = null;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > before.size) fail('transcript grew during verification.');
      digest.update(chunk); lastByte = chunk.at(-1);
      if (!endedHeader) {
        const newline = chunk.indexOf(10), part = newline < 0 ? chunk : chunk.subarray(0, newline);
        headerLength += part.length;
        if (headerLength > 64 * 1024 * 1024) fail('transcript header exceeds its byte limit.');
        headerChunks.push(part); endedHeader = newline >= 0;
      }
    }
    const after = await file.stat(), current = await lstat(path);
    if (!sameStat(before, after) || !sameStat(after, current) || length !== before.size || lastByte !== 10)
      fail('transcript changed during verification.');
    let header;
    try { header = JSON.parse(Buffer.concat(headerChunks).toString('utf8')); } catch { fail('transcript header is malformed.'); }
    if (header.type !== 'session_meta' || header.payload?.id !== nativeId) fail('transcript identity changed.');
    return { hash: digest.digest('hex'), bytes: before.size };
  } finally { await file.close(); }
}

// This is a native preservation proof, not portable-history conversion. A
// spawned agent can legitimately begin with an assistant-side delegation.
async function historyProof(client, nativeId, budget, { completedAgents = true } = {}) {
  let cursor; const cursors = new Set(), ids = new Set(), digests = [];
  let count = 0;
  do {
    if (cursors.size >= 256) fail('native history exceeds its page limit.');
    const page = await client.request('thread/turns/list', { threadId: nativeId, itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) fail('native full history is unavailable.');
    budget.apiBytes += Buffer.byteLength(JSON.stringify(page));
    if (budget.apiBytes > 64 * 1024 * 1024) fail('native tree history exceeds its byte limit.');
    for (const turn of page.data) {
      if (!turn.id || ids.has(turn.id) || !['completed', 'interrupted', 'failed'].includes(turn.status)
          || completedAgents && (turn.status !== 'completed' || turn.error != null) || turn.itemsView !== 'full'
          || !Array.isArray(turn.items) || !turn.items.length || turn.items.some(item => item.status === 'inProgress'))
        fail('dependent history is incomplete or changed.');
      const answer = turn.items.findLast(item => item.type === 'agentMessage');
      if (completedAgents && (!answer || answer.phase !== 'final_answer' || typeof answer.text !== 'string' || !answer.text.trim()))
        fail('dependent history lacks a completed final response.');
      ids.add(turn.id); count++; digests.push(hash(turn));
      if (count > 25000) fail('native history exceeds its turn limit.');
    }
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || !page.data.length)) fail('native history pagination repeated.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (!count) fail('dependent history is empty.');
  return { historyDigest: hash(digests), turnCount: count };
}

/** A narrowly supported, non-deleting native archive of a completed parent and
 * direct spawned agents. Ordinary forks are read-only witnesses whose path,
 * archive flag, bytes and full native history must not change. Native archive
 * cascades only to spawned descendants, so every affected child is explicit.
 */
export async function snapshotOriginalArchiveTree({ client, codexHome, parentId, cwd, safePath }) {
  const all = await inventory(client, parentId), parent = all.find(thread => thread.id === parentId);
  if (!parent) fail('original is absent from the native inventory.');
  const children = all.filter(thread => thread.source?.subAgent?.thread_spawn?.parent_thread_id === parentId);
  if (children.length > 64) fail('spawned tree exceeds its identity limit.');
  for (const child of children) for (const state of [false, true]) {
    const descendants = await client.request('thread/list', { ancestorThreadId: child.id, archived: state, sourceKinds: kinds, limit: 1 });
    if (!Array.isArray(descendants.data)) fail('nested dependency inventory is malformed.');
    if (descendants.data.length) fail('nested spawned dependencies require separate verification.');
  }
  const affected = new Set([parentId, ...children.map(thread => thread.id)]), protectedForks = [];
  for (const thread of all) {
    const spawn = thread.source?.subAgent?.thread_spawn;
    if (thread.id !== parentId && affected.has(spawn?.parent_thread_id) && spawn.parent_thread_id !== parentId)
      fail('nested spawned dependencies require separate verification.');
    if (affected.has(thread.forkedFromId) && !(spawn?.parent_thread_id === parentId && thread.forkedFromId === parentId)) {
      if (!['cli', 'vscode', 'exec', 'appServer'].includes(thread.source)) fail('a dependent fork has unknown native ancestry.');
      protectedForks.push(thread);
    }
  }
  if (protectedForks.length > 64) fail('protected fork inventory exceeds its identity limit.');
  const preserved = new Set(protectedForks.map(thread => thread.id));
  const budget = { bytes: 0, apiBytes: 0 }, members = [];
  for (const thread of [parent, ...children.sort((a, b) => a.id.localeCompare(b.id)), ...protectedForks.sort((a, b) => a.id.localeCompare(b.id))]) {
    const keep = preserved.has(thread.id);
    if (thread.status?.type !== 'notLoaded') fail('the original and every spawned child must be unloaded.');
    if (!keep && thread.cwd !== cwd) fail('a dependent working directory differs from its original.');
    const spawn = thread.source?.subAgent?.thread_spawn;
    if (!keep && thread.id !== parentId && (spawn?.parent_thread_id !== parentId || spawn.depth !== 1
      || !spawn.agent_path?.startsWith('/root/') || thread.forkedFromId !== parentId))
      fail('an affected task is not a verified direct spawned child.');
    if (!keep) {
      try { await lstat(join(codexHome, 'sessions', thread.id)); fail('auxiliary native data requires separate verification.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const path = await safePath(thread.path), raw = await fileProof(path, thread.id, budget);
    const history = thread.id === parentId ? {} : await historyProof(client, thread.id, budget, { completedAgents: !keep });
    const latest = (await client.request('thread/read', { threadId: thread.id, includeTurns: false })).thread;
    if (hash(latest) !== hash(thread)) fail('native metadata changed during verification.');
    if (hash(await fileProof(path, thread.id, { bytes: 0 })) !== hash(raw)) fail('native bytes changed during verification.');
    members.push({ id: thread.id, disposition: keep ? 'preserve' : 'archive', path, cwd: thread.cwd, title: thread.name ?? null, source: thread.source, forkedFromId: thread.forkedFromId ?? null,
      archived: archived(path), ...raw, ...history });
  }
  return { version: 1, parentId, members };
}

export function compareOriginalArchiveTree(before, after, { archivedOutcome = false } = {}) {
  if (before?.version !== 1 || after?.version !== 1 || before.parentId !== after.parentId
      || !Array.isArray(before.members) || before.members.length !== after.members.length)
    fail('the exact planned tree changed.');
  for (let i = 0; i < before.members.length; i++) {
    const old = before.members[i], current = after.members[i];
    if (hash({ ...old, path: null, archived: null }) !== hash({ ...current, path: null, archived: null }))
      fail('an original or descendant changed; evidence was preserved.');
    if (archivedOutcome && old.disposition === 'archive' ? !current.archived : current.path !== old.path || current.archived !== old.archived)
      fail(archivedOutcome ? 'native archival is incomplete; do not resend automatically.' : 'a native path changed before archival.');
  }
}

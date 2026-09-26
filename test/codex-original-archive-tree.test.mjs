import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotOriginalArchiveTree, compareOriginalArchiveTree } from '../src/codex-original-archive-tree.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-archive-tree-')));
  const cwd = join(root, 'project'); await mkdir(cwd); await mkdir(join(root, 'sessions'));
  const parentId = randomUUID(), childId = randomUUID();
  const threads = [parentId, childId].map((id, i) => ({ id, path: join(root, `rollout-${id}.jsonl`), cwd,
    status: { type: 'notLoaded' }, name: i ? 'Internal agent' : 'Original', forkedFromId: i ? parentId : null,
    source: i ? { subAgent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: '/root/test' } } } : 'vscode' }));
  for (const thread of threads) await writeFile(thread.path, JSON.stringify({ type: 'session_meta', payload: { id: thread.id, cwd } }) + '\n', { mode: 0o600 });
  const turns = [{ id: 'turn', status: 'completed', error: null, itemsView: 'full',
    items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Synthetic completed work.' }] }];
  const client = { async request(method, params) {
    if (method === 'thread/loaded/list') return { data: [], nextCursor: null };
    if (method === 'thread/list') return { data: params.archived ? [] : threads.filter(value => params.ancestorThreadId
      ? value.source?.subAgent?.thread_spawn?.parent_thread_id === params.ancestorThreadId
      : !value.source?.subAgent).map(value => ({ id: value.id })), nextCursor: null };
    if (method === 'thread/read') return { thread: structuredClone(threads.find(value => value.id === params.threadId)) };
    if (method === 'thread/turns/list') return { data: structuredClone(turns), nextCursor: null };
    throw new Error(`Unexpected method ${method}`);
  } };
  const options = { client, codexHome: root, parentId, cwd, safePath: async path => path };
  return { root, parentId, childId, threads, turns, options, snapshot: () => snapshotOriginalArchiveTree(options) };
}

test('preserved archive records exact native IDs, hashes and full spawned history without mutation', async () => {
  const f = await fixture();
  const before = await f.snapshot();
  assert.equal(before.members.length, 2);
  assert.equal(before.members[1].id, f.childId);
  assert.match(before.members[1].historyDigest, /^[a-f0-9]{64}$/);
  assert.equal(before.members[1].turnCount, 1);
  compareOriginalArchiveTree(before, await f.snapshot());
  const archived = structuredClone(before);
  for (const member of archived.members) { member.path = join(f.root, 'archived_sessions', member.id); member.archived = true; }
  compareOriginalArchiveTree(before, archived, { archivedOutcome: true });
  assert.throws(() => compareOriginalArchiveTree(before, archived), /path changed/);
  archived.members[1].hash = 'a'.repeat(64);
  assert.throws(() => compareOriginalArchiveTree(before, archived, { archivedOutcome: true }), /descendant changed/);
});

test('active or merely loaded originals and descendants cannot be cascade-archived', async () => {
  const f = await fixture();
  for (const thread of f.threads) for (const type of ['idle', 'active', 'unknown']) {
    thread.status.type = type;
    await assert.rejects(f.snapshot(), /must be unloaded/);
    thread.status.type = 'notLoaded';
  }
});

test('ordinary forks are preserved witnesses while unknown, nested or foreign spawned ancestry stays protected', async () => {
  const f = await fixture(), child = f.threads[1], saved = structuredClone(child);
  delete child.source;
  await assert.rejects(f.snapshot(), /unknown native ancestry/);
  child.source = 'vscode';
  const protectedProof = await f.snapshot();
  assert.equal(protectedProof.members[1].disposition, 'preserve');
  const changedFork = structuredClone(protectedProof);
  changedFork.members[0].archived = true; changedFork.members[0].path = join(f.root, 'archived_sessions', f.parentId);
  compareOriginalArchiveTree(protectedProof, changedFork, { archivedOutcome: true });
  changedFork.members[1].archived = true;
  assert.throws(() => compareOriginalArchiveTree(protectedProof, changedFork, { archivedOutcome: true }), /archival is incomplete/);
  Object.assign(child, structuredClone(saved));
  f.threads.push({ id: randomUUID(), source: { subAgent: { thread_spawn: { parent_thread_id: child.id } } } });
  await assert.rejects(f.snapshot(), /nested spawned dependencies/);
  f.threads.pop(); child.cwd = f.root;
  await assert.rejects(f.snapshot(), /working directory differs/);
  Object.assign(child, structuredClone(saved)); child.source.subAgent.thread_spawn.agent_path = '/unrelated';
  await assert.rejects(f.snapshot(), /verified direct spawned child/);
  Object.assign(child, structuredClone(saved));
  await mkdir(join(f.root, 'sessions', child.id));
  await assert.rejects(f.snapshot(), /auxiliary native data/);
});

test('incomplete native histories, changed bytes and missing descendants cannot satisfy the saved archive proof', async () => {
  const f = await fixture(), before = await f.snapshot();
  f.turns[0].status = 'inProgress';
  await assert.rejects(f.snapshot(), /history is incomplete/);
  f.turns[0].status = 'completed'; f.turns[0].items[0].phase = 'commentary';
  await assert.rejects(f.snapshot(), /completed final response/);
  f.turns[0].items[0].phase = 'final_answer';
  await appendFile(f.threads[1].path, JSON.stringify({ type: 'event_msg', payload: {} }) + '\n');
  assert.throws(() => compareOriginalArchiveTree(before, { ...before, members: before.members.slice(0, 1) }), /planned tree changed/);
  assert.throws(() => compareOriginalArchiveTree(before, { ...before, members: [...before.members, before.members[0]] }), /planned tree changed/);
  const after = await f.snapshot();
  assert.throws(() => compareOriginalArchiveTree(before, after), /descendant changed/);
  assert.throws(() => compareOriginalArchiveTree(before, before, { archivedOutcome: true }), /archival is incomplete/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { CodexClient } from '../src/codex.mjs';
import { createCodexProjection } from '../src/codex-projection.mjs';
import { fingerprint } from '../src/history.mjs';

const messages = [
  { role: 'user', content: [{ type: 'text', text: 'Synthetic original question' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Synthetic original response' }] },
];

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-original-archive-')));
  const cwd = join(root, 'project'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path)));
  const nativeId = randomUUID(), path = join(codexHome, 'sessions', `rollout-${nativeId}.jsonl`);
  const common = { meta: { id: nativeId, cwd }, messages };
  await mkdir(join(codexHome, 'sessions'));
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd } }) + '\n');
  const record = { nativeId, side: 'codex', kind: 'original', managed: false, verified: true, status: 'original', cwd, path,
    checkpoint: { count: messages.length, digest: fingerprint(common) } };
  const thread = { id: nativeId, path, cwd, status: { type: 'idle' } };
  const data = { nativeId, path, common, digest: fingerprint(common), incompleteTail: false };
  const state = { thread, data, calls: [], descendants: false, fork: null, loaded: [], listHook: null, afterArchive: null };
  const client = {
    async initialize() { return { codexHome }; },
    async close() {},
    async request(method, params) {
      state.calls.push({ method, params });
      if (method === 'thread/read') return { thread: structuredClone(params.threadId === nativeId ? thread : state.fork) };
      if (method === 'thread/loaded/list') return { data: state.loaded, nextCursor: null };
      if (method === 'thread/list') {
        await state.listHook?.(params);
        if (params.ancestorThreadId) return { data: state.descendants ? [{ id: 'descendant' }] : [] };
        return { data: state.fork && params.archived === state.fork.archived ? [{ id: state.fork.id }] : [], nextCursor: null };
      }
      if (method === 'thread/archive') {
        const target = join(codexHome, 'archived_sessions', `rollout-${nativeId}.jsonl`);
        await mkdir(join(codexHome, 'archived_sessions'), { recursive: true });
        await rename(thread.path, target); thread.path = target; data.path = target;
        await state.afterArchive?.();
        return {};
      }
      throw new Error(`Unexpected native request: ${method}`);
    },
  };
  const runtime = await new DesktopRuntime({ root: join(root, 'state'), cwd, codexHome, claudeHome,
    clientFactory: async () => client }).initialize();
  runtime.inspect = async () => structuredClone(data);
  t.after(() => runtime.close());
  return { runtime, record, state, root, codexHome, original: await readFile(path, 'utf8') };
}

test('original archival preserves bytes and unmanaged identity and is idempotent', async t => {
  const { runtime, record, state, original } = await fixture(t);
  const before = structuredClone(record);
  const archived = await runtime.adapters.codex.archiveOriginal(record);
  assert.match(archived.path, /\/archived_sessions\//);
  assert.equal(await readFile(archived.path, 'utf8'), original);
  assert.deepEqual(record, before);
  assert.deepEqual(await runtime.adapters.codex.archiveOriginal(record), archived);
  assert.equal(state.calls.filter(call => call.method === 'thread/archive').length, 1);
  assert.equal(state.calls.filter(call => call.method === 'thread/delete').length, 0);
  await assert.rejects(runtime.remove(record), /Only verified owned Codex snapshots/);
});

test('only a verified unmanaged original with a saved checkpoint can be archived', async t => {
  const { runtime, record, state } = await fixture(t);
  for (const invalid of [
    { side: 'claude' }, { kind: 'snapshot' }, { managed: true }, { managed: undefined },
    { verified: false }, { status: 'previous' }, { nativeId: 'wrong' }, { checkpoint: null },
    { checkpoint: { count: 0, digest: record.checkpoint.digest } },
  ]) await assert.rejects(runtime.adapters.codex.archiveOriginal({ ...record, ...invalid }), /Only verified unmanaged/);
  assert.equal(state.calls.length, 0);
});

test('original archive requires exact native identity, working directory and idle state', async t => {
  const { runtime, record, state, root } = await fixture(t);
  for (const [field, invalid, expression] of [
    ['id', randomUUID(), /identity/], ['cwd', root, /working directory/],
    ['status', { type: 'active' }, /idle state/], ['status', { type: 'unknown' }, /idle state/],
  ]) {
    const saved = state.thread[field]; state.thread[field] = invalid;
    await assert.rejects(runtime.adapters.codex.archiveOriginal(record), expression);
    state.thread[field] = saved;
  }
  state.thread.status.type = 'notLoaded';
  await runtime.adapters.codex.assertCanArchiveOriginal(record);
  assert.equal(state.calls.filter(call => call.method === 'thread/archive').length, 0);
});

test('changed checkpoints and unfinished original tails are never archived', async t => {
  const { runtime, record, state } = await fixture(t);
  for (const invalid of [{ incompleteTail: true }, { digest: 'a'.repeat(64) },
    { common: { ...state.data.common, messages: [...messages, ...messages] } }]) {
    const saved = structuredClone(state.data); Object.assign(state.data, invalid);
    await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /history changed or has an unfinished turn/);
    Object.assign(state.data, saved);
  }
  assert.equal(state.calls.filter(call => call.method === 'thread/archive').length, 0);
});

test('original dependency guards retain auxiliary data, descendants and ordinary forks', async t => {
  const { runtime, record, state, codexHome } = await fixture(t);
  state.descendants = true;
  await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /dependent threads/);
  state.descendants = false;
  for (const archived of [false, true]) {
    state.fork = { id: randomUUID(), forkedFromId: record.nativeId, archived };
    await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /dependent fork/);
  }
  state.fork = { id: randomUUID(), forkedFromId: record.nativeId };
  state.loaded = [state.fork.id];
  await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /dependent fork/);
  state.fork = { id: randomUUID(), source: { subAgent: { thread_spawn: { parent_thread_id: record.nativeId } } } };
  state.loaded = [state.fork.id];
  await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /dependent threads/);
  state.loaded = [];
  state.fork = null;
  await mkdir(join(codexHome, 'sessions', record.nativeId));
  await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /auxiliary data/);
  assert.equal(state.calls.filter(call => call.method === 'thread/archive').length, 0);
});

test('archive preflight detects raw changes and activation during dependency scanning', async t => {
  const { runtime, record, state } = await fixture(t);
  let changed = false;
  state.listHook = async () => {
    if (changed) return; changed = true;
    await appendFile(state.thread.path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  };
  await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /changed during dependency verification/);
  state.listHook = async () => { state.thread.status.type = 'active'; };
  await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /idle state/);
  assert.equal(state.calls.filter(call => call.method === 'thread/archive').length, 0);
});

test('an archive outcome with concurrent content remains uncommitted and is never deleted', async t => {
  const { runtime, record, state } = await fixture(t);
  state.afterArchive = async () => { await appendFile(state.thread.path, JSON.stringify({ type: 'event_msg' }) + '\n'); };
  await assert.rejects(runtime.adapters.codex.archiveOriginal(record), /archive outcome changed/);
  assert.match(state.thread.path, /\/archived_sessions\//);
  assert.match(await readFile(state.thread.path, 'utf8'), /event_msg/);
  assert.equal(state.calls.filter(call => call.method === 'thread/delete').length, 0);
});

test('native original archival preserves exact history beside an independent same-name successor and refuses a fork',
  { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 60000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-original-archive-native-')));
    const cwd = join(root, 'project'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
    await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path)));
    const runtime = await new DesktopRuntime({ root: join(root, 'state'), codexHome, claudeHome,
      clientFactory: async () => new CodexClient({ binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd, env: { HOME: root } }) }).initialize();
    t.after(() => runtime.close());
    const client = await runtime.codex(), nativeId = randomUUID(), title = 'Synthetic same-name archive acceptance';
    const common = { meta: { id: nativeId, cwd, timestamp: new Date().toISOString() }, messages };
    const original = await createCodexProjection({ client, codexHome, common, id: nativeId, title, historyMode: 'paginated' });
    const successor = await createCodexProjection({ client, codexHome, common, id: randomUUID(), title, historyMode: 'paginated' });
    const data = await runtime.inspect({ side: 'codex', nativeId, managed: false });
    const record = { nativeId, cwd: data.common.meta.cwd, path: data.path, side: 'codex', managed: false, verified: true,
      kind: 'original', status: 'original', checkpoint: { count: data.common.messages.length, digest: data.digest } };
    const originalBytes = await readFile(original.path, 'utf8');
    const archived = await runtime.adapters.codex.archiveOriginal(record);
    assert.equal(await readFile(archived.path, 'utf8'), originalBytes);
    assert.equal((await runtime.inspect(record)).digest, data.digest);
    assert.deepEqual(await runtime.adapters.codex.archiveOriginal(record), archived);
    const active = await client.request('thread/list', { archived: false, limit: 100 });
    assert.ok(!active.data.some(thread => thread.id === nativeId));
    assert.ok(active.data.some(thread => thread.id === successor.id && thread.name === title));
    const kept = await client.request('thread/list', { archived: true, limit: 100 });
    assert.ok(kept.data.some(thread => thread.id === nativeId));
    const next = await runtime.inspect({ side: 'codex', nativeId: successor.id, managed: false });
    const dependentOriginal = { ...record, nativeId: successor.id, path: next.path,
      checkpoint: { count: next.common.messages.length, digest: next.digest } };
    const fork = await client.request('thread/fork', { threadId: successor.id, cwd });
    assert.equal(fork.thread.forkedFromId, successor.id);
    await assert.rejects(runtime.adapters.codex.archiveOriginal(dependentOriginal), /dependent fork|dependent threads|auxiliary data/);
    assert.ok((await client.request('thread/list', { archived: false, limit: 100 })).data.some(thread => thread.id === successor.id));
    t.diagnostic(`Native original archival evidence: ${root}`);
  });

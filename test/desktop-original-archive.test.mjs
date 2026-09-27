import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { CodexClient } from '../src/codex.mjs';
import { createCodexProjection, encodeCodexProjection, codexProjectionPath, registerCodexProjection } from '../src/codex-projection.mjs';
import { fingerprint } from '../src/history.mjs';
import { writeJSON } from '../src/storage.mjs';
import { originalArchiveGuard } from '../src/codex-original-archive-tree.mjs';

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

test('read-only archive preflight remains retriable but an unknown dispatched request cannot be resent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-archive-unknown-'))), conversationId = randomUUID();
  const common = { meta: { cwd: root }, messages }, canonical = { count: messages.length, digest: fingerprint(common) };
  const original = { id: randomUUID(), nativeId: randomUUID(), side: 'codex', conversationId, cwd: root,
    managed: false, verified: true, kind: 'original', status: 'original', checkpoint: canonical };
  const replacement = { ...original, id: randomUUID(), nativeId: randomUUID(), managed: true, kind: 'snapshot', status: 'current' };
  const calls = [];
  let preflightFailure = true;
  const adapters = { codex: {
    inspect: async record => ({ common, nativeId: record.nativeId, digest: canonical.digest, incompleteTail: false }),
    assertArchiveReplacement: async () => {},
    prepareOriginalArchiveTree: async () => ({ version: 1, parentId: original.nativeId, members: [{ id: original.nativeId, disposition: 'archive' }] }),
    archiveOriginalTree: async (_record, _proof, { allowWrite, beforeDispatch }) => {
      calls.push(allowWrite);
      if (preflightFailure) { preflightFailure = false; throw originalArchiveGuard('Synthetic preflight still busy'); }
      if (allowWrite) { await beforeDispatch(); throw new Error('Native request outcome unknown'); }
      throw originalArchiveGuard('Original archive request outcome is unknown; no native request was repeated.');
    },
  } };
  const bridge = new DesktopBridge({ root, adapters });
  await writeJSON(join(root, 'desktop-state.json'), { version: 2, conversations: { [conversationId]: { id: conversationId, title: 'Same title', cwd: root, canonical } },
    records: [original, replacement], pending: null, audit: [] });
  await assert.rejects(bridge.reconcileOriginalArchive(conversationId, original.nativeId), /Synthetic preflight still busy/);
  assert.equal((await bridge.status()).pending.phase, 'prepared');
  await assert.rejects(bridge.recover(), /Native request outcome unknown/);
  const saved = await bridge.status();
  assert.equal(saved.pending.kind, 'original-archive');
  assert.equal(saved.pending.phase, 'requested');
  await assert.rejects(bridge.recover(), error => error.code === 'CLAUDEX_ORIGINAL_ARCHIVE_BLOCKED' && /no native request was repeated/.test(error.message));
  assert.deepEqual(calls, [true, true, false]);
  assert.deepEqual((await bridge.status()).pending, saved.pending);
  assert.equal((await bridge.status()).records.length, 2);
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

test('native archive preserves history while cascading to spawned children but not ordinary forks',
  { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 60000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-dependent-archive-native-')));
    const cwd = join(root, 'project'), codexHome = join(root, 'codex');
    await Promise.all([cwd, codexHome].map(path => mkdir(path)));
    const connect = async () => { const client = new CodexClient({ binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd, env: { HOME: root } }); await client.initialize(); return client; };
    let client = await connect();
    t.after(() => client.close());
    const id = randomUUID(), childId = randomUUID();
    const common = { meta: { id, cwd, timestamp: new Date().toISOString() }, messages };
    const original = await createCodexProjection({ client, codexHome, common, id, title: 'Preserved parent', historyMode: 'paginated' });
    const rows = encodeCodexProjection(common, childId, { historyMode: 'paginated' }).trim().split('\n').map(JSON.parse);
    Object.assign(rows[0].payload, { forked_from_id: id, parent_thread_id: id,
      source: { subagent: { thread_spawn: { parent_thread_id: id, depth: 1, agent_path: '/root/synthetic', agent_nickname: 'Synthetic', agent_role: null } } } });
    const childPath = codexProjectionPath(codexHome, common, childId);
    await writeFile(childPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await registerCodexProjection({ client, path: childPath, id: childId, cwd, title: 'Preserved child' });
    const fork = await client.request('thread/fork', { threadId: id, cwd });
    const forkId = fork.thread.id;
    await client.close(); client = await connect();
    const read = async threadId => {
      const { thread } = await client.request('thread/read', { threadId, includeTurns: true });
      return { id: thread.id, path: thread.path, turns: thread.turns, source: thread.source, forkedFromId: thread.forkedFromId,
        bytes: await readFile(thread.path, 'utf8'), status: thread.status.type };
    };
    const before = await Promise.all([id, childId, forkId].map(read));
    assert.ok(before.every(value => value.status === 'notLoaded'));
    assert.equal(before[1].source.subAgent.thread_spawn.parent_thread_id, id);
    assert.equal(before[2].forkedFromId, id);
    await client.request('thread/archive', { threadId: id });
    const after = await Promise.all([id, childId, forkId].map(read));
    assert.match(after[0].path, /\/archived_sessions\//);
    assert.equal(after[0].bytes, before[0].bytes);
    assert.deepEqual(after[0].turns, before[0].turns);
    assert.match(after[1].path, /\/archived_sessions\//);
    assert.deepEqual({ ...after[1], path: before[1].path }, before[1]);
    assert.deepEqual(after[2], before[2]);
    await client.close(); client = await connect();
    for (let i = 0; i < after.length; i++) assert.deepEqual(await read(after[i].id), after[i]);
    const liveFork = await client.resumeThread(forkId, { cwd });
    assert.deepEqual(liveFork.thread.turns, before[2].turns);
    await client.close(); client = await connect();
    await client.request('thread/unarchive', { threadId: id });
    assert.equal((await read(id)).bytes, before[0].bytes);
    assert.equal((await read(id)).path, original.path);
    const restoredChild = await read(childId);
    assert.equal(restoredChild.bytes, before[1].bytes);
    if (restoredChild.path.includes('/archived_sessions/')) await client.request('thread/unarchive', { threadId: childId });
    for (const dependent of after.slice(1)) {
      const resumed = await client.resumeThread(dependent.id, { cwd });
      assert.equal(resumed.thread.id, dependent.id);
      assert.deepEqual(resumed.thread.turns, dependent.turns);
    }
    t.diagnostic(`Native dependent archival proof (spawned child cascades, ordinary fork does not), no inference: ${root}`);
  });

test('explicit native original-tree reconciliation journals a lost receipt and recovers without resending',
  { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 60000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-archive-recovery-native-')));
    const cwd = join(root, 'project'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude'), stateRoot = join(root, 'state');
    await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path)));
    const options = { root: stateRoot, codexHome, claudeHome,
      clientFactory: async () => new CodexClient({ binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd, env: { HOME: root } }) };
    let runtime = await new DesktopRuntime(options).initialize();
    t.after(() => runtime.close());
    let bridge = new DesktopBridge({ root: stateRoot, adapters: runtime.adapters });
    const client = await runtime.codex(), originalId = randomUUID(), childId = randomUUID(), title = 'Same-title legacy original';
    const common = { meta: { id: originalId, cwd, timestamp: new Date().toISOString() }, messages };
    const original = await createCodexProjection({ client, codexHome, common, id: originalId, title, historyMode: 'paginated' });
    const { conversationId } = await bridge.track({ side: 'codex', nativeId: originalId, title });
    const canonical = (await runtime.inspect({ side: 'codex', nativeId: originalId, managed: false })).common;
    canonical.meta.timestamp = common.meta.timestamp;
    const childRows = encodeCodexProjection(common, childId, { historyMode: 'paginated' }).trim().split('\n').map(JSON.parse);
    Object.assign(childRows[0].payload, { forked_from_id: originalId, parent_thread_id: originalId,
      source: { subagent: { thread_spawn: { parent_thread_id: originalId, depth: 1, agent_path: '/root/synthetic', agent_nickname: 'Synthetic', agent_role: null } } } });
    const childPath = codexProjectionPath(codexHome, common, childId);
    await writeFile(childPath, childRows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await registerCodexProjection({ client, path: childPath, id: childId, cwd, title: 'Completed internal agent' });
    const record = { ...await runtime.plan('codex', { conversationId, nativeId: randomUUID(), common: canonical, title }),
      id: randomUUID(), conversationId, side: 'codex', cwd, managed: true, verified: true, status: 'current', checkpoint: { count: canonical.messages.length, digest: fingerprint(canonical) } };
    await runtime.apply(record, canonical, { operationId: randomUUID() });
    const protectedFork = (await client.request('thread/fork', { threadId: originalId, cwd })).thread;
    const archivedFork = (await client.request('thread/fork', { threadId: originalId, cwd })).thread;
    await client.request('thread/archive', { threadId: archivedFork.id });
    const forkProofs = [];
    for (const fork of [protectedFork, archivedFork]) {
      const { thread } = await client.request('thread/read', { threadId: fork.id, includeTurns: true });
      forkProofs.push({ id: thread.id, path: thread.path, turns: thread.turns, bytes: await readFile(thread.path, 'utf8') });
    }
    const state = await bridge.status();
    state.records[0].status = 'original'; state.records.push(record);
    await writeJSON(join(stateRoot, 'desktop-state.json'), state);
    const originalBytes = await readFile(original.path, 'utf8'), childBytes = await readFile(childPath, 'utf8');
    await runtime.close(); runtime = await new DesktopRuntime(options).initialize();
    bridge = new DesktopBridge({ root: stateRoot, adapters: runtime.adapters });
    const c = await runtime.codex(), nativeRequest = c.request.bind(c); let writes = 0;
    c.request = async (method, params) => {
      const result = await nativeRequest(method, params);
      if (method === 'thread/archive') { writes++; throw new Error('Synthetic lost archive receipt'); }
      return result;
    };
    await assert.rejects(bridge.reconcileOriginalArchive(conversationId, originalId), /Synthetic lost archive receipt/);
    assert.equal((await bridge.status()).pending.phase, 'requested');
    assert.equal(writes, 1);
    await runtime.close(); runtime = await new DesktopRuntime(options).initialize();
    bridge = new DesktopBridge({ root: stateRoot, adapters: runtime.adapters });
    const recoveredClient = await runtime.codex(), readOnlyRecovery = recoveredClient.request.bind(recoveredClient);
    recoveredClient.request = async (method, params) => { assert.notEqual(method, 'thread/archive'); assert.notEqual(method, 'thread/delete'); return readOnlyRecovery(method, params); };
    const result = await bridge.recover();
    assert.equal(result.preservedDescendants, 1);
    const final = await bridge.status(), kept = final.records.find(value => value.nativeId === originalId);
    assert.equal(final.pending, null);
    assert.equal(kept.managed, false);
    assert.ok(kept.archivedAt);
    for (const proof of forkProofs) {
      const { thread } = await recoveredClient.request('thread/read', { threadId: proof.id, includeTurns: true });
      assert.deepEqual({ id: thread.id, path: thread.path, turns: thread.turns, bytes: await readFile(thread.path, 'utf8') }, proof);
    }
    assert.equal(await readFile(kept.path, 'utf8'), originalBytes);
    assert.equal(await readFile(kept.archivedTree.members.find(value => value.id === childId).path, 'utf8'), childBytes);
    assert.equal((await bridge.reconcileOriginalArchive(conversationId, originalId)).changed, false);
    assert.equal((await runtime.inspect(record)).digest, record.checkpoint.digest);
    t.diagnostic(`Journaled native archival and restart evidence: ${root}`);
  });

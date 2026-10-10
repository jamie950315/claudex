import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, appendFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { fingerprint } from '../src/history.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-dependency-anchor-')));
  const cwd = join(root, 'project'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path)));
  const nativeId = randomUUID(), childId = randomUUID(), path = join(codexHome, `rollout-${nativeId}.jsonl`);
  const common = { meta: { cwd }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Synthetic question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }] },
  ] };
  const raw = JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd } }) + '\n';
  await writeFile(path, raw);
  const record = { nativeId, side: 'codex', kind: 'snapshot', managed: true, verified: true,
    status: 'current', conversationId: randomUUID(), cwd, path,
    checkpoint: { count: common.messages.length, digest: fingerprint(common) } };
  const parent = { id: nativeId, path, cwd, status: { type: 'idle' }, source: 'cli', forkedFromId: null };
  const child = { id: childId, source: { subAgent: { thread_spawn: { parent_thread_id: nativeId } } }, forkedFromId: null };
  const state = { parent, child, calls: [], dependencies: true, hook: null,
    data: { nativeId, path, common, digest: fingerprint(common), incompleteTail: false, bytes: Buffer.byteLength(raw) + 20 } };
  const client = {
    async initialize() { return { codexHome }; }, async close() {},
    async resumeThread() { throw new Error('Mutation is forbidden in anchor validation.'); },
    async request(method, params) {
      state.calls.push({ method, params });
      await state.hook?.(method, params);
      if (method === 'thread/read') return { thread: structuredClone(params.threadId === nativeId ? state.parent : state.child) };
      if (method === 'thread/loaded/list') return { data: [], nextCursor: null };
      if (method === 'thread/list') return { data: state.dependencies && !params.archived ? [{ id: childId }] : [], nextCursor: null };
      throw new Error(`Forbidden request: ${method}`);
    },
  };
  const runtime = await new DesktopRuntime({ root: join(root, 'state'), codexHome, claudeHome,
    clientFactory: async () => client }).initialize();
  runtime.inspect = async () => structuredClone(state.data);
  t.after(() => runtime.close());
  return { runtime, record, state, root, raw };
}

const blocked = error => error.code === 'CLAUDEX_DEPENDENCY_ANCHOR_BLOCKED' && /^Dependency anchor /.test(error.message);

test('dependency anchor saves exact parent proof with no native writes or record mutation', async t => {
  const { runtime, record, state } = await fixture(t), before = structuredClone(record);
  const proof = await runtime.adapters.codex.prepareDependencyAnchor(record);
  assert.deepEqual(proof.dependencyIds, [state.child.id]);
  assert.deepEqual(proof.dependencyAnchor.dependencies, [{ id: state.child.id, parentId: record.nativeId, kind: 'spawn' }]);
  assert.equal(proof.dependencyAnchor.raw.path, record.path);
  assert.match(proof.dependencyAnchor.raw.hash, /^[a-f0-9]{64}$/);
  assert.equal(proof.bytes, state.data.bytes);
  assert.deepEqual(record, before);
  const saved = { ...record, ...proof, status: 'dependency-anchor' };
  assert.deepEqual(await runtime.adapters.codex.assertDependencyAnchor(saved), { bytes: state.data.bytes });
  assert.ok(state.calls.every(call => ['thread/read', 'thread/list', 'thread/loaded/list'].includes(call.method)));
  state.dependencies = false;
  await runtime.adapters.codex.assertDependencyAnchor(saved);
  assert.equal(saved.status, 'dependency-anchor');
});

test('independent snapshots return null and retain standard retirement eligibility', async t => {
  const { runtime, record, state } = await fixture(t);
  state.dependencies = false;
  assert.equal(await runtime.adapters.codex.prepareDependencyAnchor(record), null);
  assert.equal(record.status, 'current');
});

test('collection batch uses one fresh global inventory for independent candidates', async t => {
  const { runtime, record, state } = await fixture(t);
  state.dependencies = false;
  const first = { ...record, id: randomUUID() }, second = { ...record, id: randomUUID(), nativeId: randomUUID() };
  assert.deepEqual(await runtime.adapters.codex.prepareDependencyAnchors([first, second]),
    new Map([[first.id, null], [second.id, null]]));
  assert.equal(state.calls.filter(call => call.method === 'thread/loaded/list').length, 1);
  assert.equal(state.calls.filter(call => call.method === 'thread/list' && !call.params.ancestorThreadId).length, 2);
  assert.equal(state.calls.filter(call => call.method === 'thread/list' && call.params.ancestorThreadId).length, 4);
});

test('batch dependent candidate retains fresh second inventory and raw parent proofs', async t => {
  const { runtime, record, state } = await fixture(t);
  const candidate = { ...record, id: randomUUID() };
  const proof = (await runtime.adapters.codex.prepareDependencyAnchors([candidate])).get(candidate.id);
  assert.deepEqual(proof.dependencyIds, [state.child.id]);
  assert.equal(state.calls.filter(call => call.method === 'thread/loaded/list').length, 2);
  let lists = 0;
  state.hook = async method => { if (method === 'thread/loaded/list' && ++lists === 2) state.dependencies = false; };
  await assert.rejects(runtime.adapters.codex.prepareDependencyAnchors([candidate]), blocked);
});

test('parent source identity, idle state, checkpoint and completed history must match', async t => {
  const { runtime, record, state, root } = await fixture(t);
  for (const patch of [{ id: randomUUID() }, { cwd: root }, { status: { type: 'active' } }, { status: { type: 'unknown' } }]) {
    const before = structuredClone(state.parent); Object.assign(state.parent, patch);
    await assert.rejects(runtime.adapters.codex.prepareDependencyAnchor(record), blocked);
    state.parent = before;
  }
  for (const patch of [{ incompleteTail: true }, { digest: 'a'.repeat(64) }, { nativeId: randomUUID() }, { bytes: 0 }]) {
    const before = structuredClone(state.data); Object.assign(state.data, patch);
    await assert.rejects(runtime.adapters.codex.prepareDependencyAnchor(record), blocked);
    state.data = before;
  }
  await assert.rejects(runtime.adapters.codex.prepareDependencyAnchor({ ...record, managed: false }), blocked);
  state.parent.status.type = 'notLoaded';
  assert.ok(await runtime.adapters.codex.prepareDependencyAnchor(record));
});

test('saved raw bytes, immutable path and proof shape are validated', async t => {
  const { runtime, record, state } = await fixture(t);
  const saved = { ...record, ...await runtime.adapters.codex.prepareDependencyAnchor(record), status: 'dependency-anchor' };
  for (const patch of [{ nativeId: randomUUID() }, { dependencyIds: [] }, { dependencyAnchor: null },
    { checkpoint: { count: 1, digest: record.checkpoint.digest } }])
    await assert.rejects(runtime.adapters.codex.assertDependencyAnchor({ ...saved, ...patch }), blocked);
  await appendFile(record.path, JSON.stringify({ type: 'changed' }) + '\n');
  state.data.bytes += 100;
  await assert.rejects(runtime.adapters.codex.assertDependencyAnchor(saved), blocked);
});

test('extra retained rollout storage cannot silently escape the saved anchor quota', async t => {
  const { runtime, record, state } = await fixture(t);
  const saved = { ...record, ...await runtime.adapters.codex.prepareDependencyAnchor(record), status: 'dependency-anchor' };
  state.data.bytes += 100;
  await assert.rejects(runtime.adapters.codex.assertDependencyAnchor(saved), /aggregate storage changed/);
});

test('sorted projection header keys require the exact original whole-file hash', async t => {
  const { runtime, record, state } = await fixture(t);
  const payload = { base_instructions: null, cwd: record.cwd, id: record.nativeId,
    originator: 'claudex', history_mode: 'paginated' };
  const header = { timestamp: '2026-09-27T00:00:00Z', type: 'session_meta', payload, ordinal: 0 };
  const tail = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n';
  const original = JSON.stringify(header) + '\n' + tail;
  await writeFile(record.path, original); state.data.bytes = Buffer.byteLength(original);
  const saved = { ...record, ...await runtime.adapters.codex.prepareDependencyAnchor(record), status: 'dependency-anchor' };
  const sort = value => value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  const rewritten = JSON.stringify(sort(header)) + '\n' + tail;
  await writeFile(record.path, rewritten);
  await runtime.adapters.codex.assertDependencyAnchor(saved);
  assert.equal(await readFile(record.path, 'utf8'), rewritten);
  assert.notEqual((await runtime.dependencyAnchorRawProof(record.path, saved)).hash, saved.dependencyAnchor.raw.hash);
  // Same-size header values and body edits remain conflicts despite unchanged API history.
  for (const changed of [rewritten.replace('2026-09-27', '2026-09-28'), rewritten.replace('task_complete', 'task_inactive')]) {
    await writeFile(record.path, changed);
    await assert.rejects(runtime.adapters.codex.assertDependencyAnchor(saved), /saved transcript bytes changed/);
  }
});

test('a provider label rewritten in the header is not a changed anchor', async t => {
  const { runtime, record, state } = await fixture(t);
  const header = provider => JSON.stringify({ ordinal: 0, payload: { cwd: record.cwd, id: record.nativeId, model_provider: provider,
    originator: 'claudex' }, timestamp: '2026-09-27T00:00:00Z', type: 'session_meta' });
  const tail = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n';
  const write = async text => { await writeFile(record.path, text); state.data.bytes = Buffer.byteLength(text) + 20; };
  await write(header('openai') + '\n' + tail);
  const saved = { ...record, ...await runtime.adapters.codex.prepareDependencyAnchor(record), status: 'dependency-anchor' };
  assert.match(saved.dependencyAnchor.raw.labelFree.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await runtime.adapters.codex.assertDependencyAnchor(saved), { bytes: saved.bytes });
  await write(header('codex_local_access') + '\n' + tail);
  assert.deepEqual(await runtime.adapters.codex.assertDependencyAnchor(saved), { bytes: saved.bytes + 12 });
  // Storage beyond the label, any other header value, the body and a hidden
  // duplicate key are still changes.
  state.data.bytes += 1;
  await assert.rejects(runtime.adapters.codex.assertDependencyAnchor(saved), /aggregate storage changed/);
  for (const changed of [header('codex_local_access').replace('2026-09-27', '2026-09-28') + '\n' + tail,
    header('codex_local_access') + '\n' + tail.replace('task_complete', 'task_inactive'),
    header('codex_local_access').replace('"originator"', `"id":"${record.nativeId}","originator"`) + '\n' + tail]) {
    await write(changed);
    await assert.rejects(runtime.adapters.codex.assertDependencyAnchor(saved), /saved transcript bytes changed/);
  }
  // An anchor saved before this identity existed keeps its exact proof and is
  // offered the identity only while those exact bytes are still there.
  const legacy = structuredClone(saved); delete legacy.dependencyAnchor.raw.labelFree;
  await write(header('codex_local_access') + '\n' + tail);
  await assert.rejects(runtime.adapters.codex.assertDependencyAnchor(legacy), /saved transcript bytes changed/);
  await write(header('openai') + '\n' + tail);
  assert.deepEqual(await runtime.adapters.codex.assertDependencyAnchor(legacy),
    { bytes: saved.bytes, labelFree: saved.dependencyAnchor.raw.labelFree });
  await assert.rejects(runtime.adapters.codex.assertDependencyAnchor({ ...saved, dependencyAnchor: { ...saved.dependencyAnchor,
    raw: { ...saved.dependencyAnchor.raw, labelFree: { hash: 'x', bytes: 1 } } } }), /saved proof is malformed/);
});

test('a dependency or parent change during preflight blocks anchoring', async t => {
  const { runtime, record, state } = await fixture(t);
  let lists = 0;
  state.hook = async method => { if (method === 'thread/loaded/list' && ++lists === 2) state.dependencies = false; };
  await assert.rejects(runtime.adapters.codex.prepareDependencyAnchor(record), blocked);
  state.dependencies = true; lists = 0;
  state.hook = async method => {
    if (method === 'thread/loaded/list' && ++lists === 2) await appendFile(record.path, '{"changed":true}\n');
  };
  await assert.rejects(runtime.adapters.codex.prepareDependencyAnchor(record), blocked);
});

test('raw header identity mismatches and symlink transcripts fail safely', async t => {
  const { runtime, record, root } = await fixture(t);
  await writeFile(record.path, JSON.stringify({ type: 'session_meta', payload: { id: randomUUID(), cwd: record.cwd } }) + '\n');
  await assert.rejects(runtime.adapters.codex.prepareDependencyAnchor(record), blocked);
  const linked = join(root, 'linked.jsonl'); await symlink(record.path, linked);
  await assert.rejects(runtime.dependencyAnchorRawProof(linked, record), { code: 'ELOOP' });
});

test('protected anchors reject hide, remove and ordinary retirement before native loading', async t => {
  const { runtime, record, state } = await fixture(t);
  const anchor = { ...record, status: 'dependency-anchor' };
  for (const method of ['hide', 'remove', 'assertOwnedSnapshot']) await assert.rejects(runtime[method](anchor), blocked);
  assert.deepEqual(state.calls, []);
});

test('unknown transport failures keep their original identity', async t => {
  const { runtime, record, state } = await fixture(t);
  const failure = Object.assign(new Error('Transport disconnected'), { code: 'ECONNRESET' });
  state.hook = async () => { throw failure; };
  await assert.rejects(runtime.adapters.codex.prepareDependencyAnchor(record), error => error === failure);
});

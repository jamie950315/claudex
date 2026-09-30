import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { fingerprint } from '../src/history.mjs';
import { writeJSON } from '../src/storage.mjs';
import { discoverSources } from '../src/discovery.mjs';
import { activeDesktopState } from '../src/desktop-enrollment.mjs';
import { runDesktopWatch } from '../src/desktop-watch.mjs';

async function fixture(policy = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-enrollment-')));
  const id = randomUUID(), cwd = join(root, 'removed-worktree');
  const common = { meta: { cwd, id: randomUUID(), timestamp: new Date(0).toISOString() }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Synthetic request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Synthetic reply' }] },
  ] };
  const checkpoint = { count: common.messages.length, digest: fingerprint(common) };
  const state = { version: 2, conversations: { [id]: { id, cwd, title: 'Synthetic retained history', canonical: checkpoint } },
    records: [], pending: null, audit: [] };
  const native = new Map();
  for (const [side, status, kind, managed] of [['claude', 'current', 'original', false],
    ['codex', 'current', 'snapshot', true], ['codex', 'previous', 'snapshot', true]]) {
    const record = { id: randomUUID(), conversationId: id, nativeId: randomUUID(), side, cwd,
      path: join(root, `${side}-${status}.jsonl`), status, kind, managed, verified: true,
      checkpoint, bytes: 47, createdAt: 0 };
    state.records.push(record); native.set(record.nativeId, structuredClone(common));
    await writeFile(record.path, `Retained ${side} ${status} bytes\n`, { mode: 0o600 });
  }
  await writeJSON(join(root, 'desktop-state.json'), state);
  const asset = join(root, 'history-assets', 'retained-asset');
  await mkdir(join(root, 'history-assets'), { mode: 0o700 });
  await writeFile(asset, 'Retained authoritative asset\n', { mode: 0o600 });
  const calls = [];
  const adapters = Object.fromEntries(['codex', 'claude'].map(side => [side, {
    async inspect(record) {
      calls.push(['inspect', record.nativeId]);
      return { nativeId: record.nativeId, path: record.path, common: structuredClone(native.get(record.nativeId)),
        bytes: record.bytes, incompleteTail: false };
    },
    async assertIdle(record) { calls.push(['idle', record.nativeId]); },
    async exists(record) { calls.push(['exists', record.nativeId]); return true; },
    async remove() { throw new Error('No retained history may be removed'); },
  }]));
  return { root, id, cwd, state, native, asset, calls, adapters,
    bridge: new DesktopBridge({ root, adapters, policy, now: () => 1000 }),
    async bytes() { return Promise.all([...state.records.map(record => record.path), asset].map(path => readFile(path))); },
  };
}

test('explicit stop preserves missing-cwd histories, checkpoints, assets and discovery identities', async () => {
  const f = await fixture(), before = await f.bridge.status(), bytes = await f.bytes();
  await writeJSON(join(f.root, 'desktop-handoff.json'), { version: 1, kind: 'claude-local-archive',
    actions: [{ conversationId: f.id }], anchors: [{ conversationId: f.id }] });
  assert.deepEqual(await f.bridge.untrack(f.id), { changed: true, conversationId: f.id, tracking: 'stopped', historyPreserved: true });
  const stopped = await f.bridge.status();
  assert.deepEqual(stopped.records, before.records);
  assert.deepEqual(stopped.conversations[f.id], { ...before.conversations[f.id], tracking: { status: 'stopped', stoppedAt: 1000 } });
  assert.deepEqual(await f.bytes(), bytes);
  assert.deepEqual(f.calls, []);
  const manifest = JSON.parse(await readFile(join(f.root, 'desktop-handoff.json')));
  assert.deepEqual(manifest.actions, []); assert.deepEqual(manifest.anchors, []);
  assert.equal(manifest.generatedAt, null); assert.equal(manifest.expiresAt, null);
  assert.deepEqual(await f.bridge.sync(f.id), { changed: false, conversationId: f.id, tracking: 'stopped' });
  for (const address of [{ nativeId: f.state.records[0].nativeId }, { path: f.state.records[0].path }]) {
    assert.deepEqual(await f.bridge.track({ side: 'claude', ...address }), { conversationId: f.id, existing: true, tracking: 'stopped' });
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.bridge.untrack(f.id)).changed, false);
  assert.deepEqual(await f.bridge.status(), stopped);
  assert.deepEqual(activeDesktopState(stopped).conversations, {});
  assert.deepEqual(activeDesktopState(stopped).records, []);

  const codexHome = join(f.root, 'codex'), claudeHome = join(f.root, 'claude');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const claudeProject = join(claudeHome, 'projects', '-synthetic-project');
  await mkdir(claudeProject, { recursive: true });
  const codexRecord = stopped.records.find(record => record.side === 'codex');
  await writeFile(join(codexHome, 'sessions', 'rollout-synthetic.jsonl'), `${JSON.stringify({ type: 'session_meta',
    payload: { id: codexRecord.nativeId, cwd: f.cwd, originator: 'codex_cli_rs' } })}\n`);
  await writeFile(join(claudeProject, `${stopped.records[0].nativeId}.jsonl`), `${JSON.stringify({ type: 'user', cwd: f.cwd })}\n`);
  const known = new Set(stopped.records.map(record => `${record.side}:${record.nativeId}`));
  assert.deepEqual(await discoverSources({ codexHome, claudeHome, allProjects: true, since: 0 }, known), []);
});

test('stopped snapshots remain frozen and counted even after their cwd becomes available', async () => {
  const f = await fixture(); await f.bridge.untrack(f.id); await mkdir(f.cwd);
  const stopped = await f.bridge.status(), before = await f.bytes();
  assert.deepEqual(await f.bridge.collect(), { removed: 0, backupBytes: 47, frozen: [f.id] });
  assert.deepEqual(f.calls, []); assert.deepEqual(await f.bytes(), before);
  assert.deepEqual((await f.bridge.status()).records, stopped.records);
  const limited = new DesktopBridge({ root: f.root, adapters: f.adapters, policy: { maxBackupBytes: 0 } });
  await assert.rejects(limited.collect(), /Snapshot retention cannot be satisfied safely/);
  assert.deepEqual(f.calls, []); assert.deepEqual(await f.bytes(), before);
});

test('pending transactions and unsafe archival manifests refuse tracking changes', async () => {
  const f = await fixture();
  const pending = { phase: 'prepared', record: { conversationId: f.id }, operationId: randomUUID() };
  await f.bridge.save({ ...f.state, pending });
  const before = await readFile(join(f.root, 'desktop-state.json'));
  await assert.rejects(f.bridge.untrack(f.id), /Recover the pending desktop handoff/);
  assert.deepEqual(await readFile(join(f.root, 'desktop-state.json')), before);
  await f.bridge.save(f.state);
  await writeJSON(join(f.root, 'desktop-handoff.json'), { version: 1, kind: 'claude-local-archive', actions: [] });
  await chmod(join(f.root, 'desktop-handoff.json'), 0o644);
  const active = await readFile(join(f.root, 'desktop-state.json'));
  await assert.rejects(f.bridge.untrack(f.id), /private|owned|permission/i);
  assert.deepEqual(await readFile(join(f.root, 'desktop-state.json')), active);
  assert.deepEqual(f.calls, []);
});

test('resumption verifies saved histories and retains the stopped marker on divergence', async () => {
  const f = await fixture(); await f.bridge.untrack(f.id);
  f.native.get(f.state.records[0].nativeId).messages[0].content[0].text = 'Changed prefix';
  const before = await f.bridge.status();
  await assert.rejects(f.bridge.resumeTracking(f.id), /synchronized prefix/);
  assert.deepEqual(await f.bridge.status(), before);
  f.native.set(f.state.records[0].nativeId, structuredClone(f.native.get(f.state.records[1].nativeId)));
  const bytes = await f.bytes();
  assert.deepEqual(await f.bridge.resumeTracking(f.id), { changed: true, conversationId: f.id, tracking: 'active' });
  const resumed = await f.bridge.status();
  assert.equal(resumed.conversations[f.id].tracking, undefined);
  assert.deepEqual(resumed.records, before.records); assert.deepEqual(await f.bytes(), bytes);
  assert.equal((await f.bridge.resumeTracking(f.id)).changed, false);
});

test('resumption refuses independently advanced current branches and rechecks stopped original and anchor guards', async () => {
  const f = await fixture(); await f.bridge.untrack(f.id);
  for (const record of f.state.records.filter(record => record.status === 'current'))
    f.native.get(record.nativeId).messages.push(
      { role: 'user', content: [{ type: 'text', text: `New ${record.side} request` }] },
      { role: 'assistant', content: [{ type: 'text', text: `New ${record.side} reply` }] });
  await assert.rejects(f.bridge.resumeTracking(f.id), /Both stopped sides changed/);
  assert.equal((await f.bridge.status()).conversations[f.id].tracking.status, 'stopped');
  for (const record of f.state.records.filter(record => record.status === 'current'))
    f.native.get(record.nativeId).messages.splice(2);
  const stopped = await f.bridge.status(), original = { ...stopped.records[0], id: randomUUID(),
    nativeId: randomUUID(), status: 'original', path: join(f.root, 'superseded.jsonl') };
  stopped.records.push(original);
  f.native.set(original.nativeId, structuredClone(f.native.get(stopped.records[0].nativeId)));
  f.native.get(original.nativeId).messages[0].content[0].text = 'Changed superseded prefix';
  await f.bridge.save(stopped);
  await assert.rejects(f.bridge.resumeTracking(f.id), /Superseded original .*changed/);
  assert.equal((await f.bridge.status()).conversations[f.id].tracking.status, 'stopped');
  stopped.records.pop();
  const anchor = stopped.records.find(record => record.status === 'previous');
  anchor.status = 'dependency-anchor'; anchor.dependencyIds = ['synthetic-child'];
  anchor.dependencyAnchor = { version: 1, digest: anchor.checkpoint.digest };
  await f.bridge.save(stopped);
  f.adapters.codex.assertDependencyAnchor = async record => {
    assert.equal(record.nativeId, anchor.nativeId); throw new Error('Observed anchor changed');
  };
  await assert.rejects(f.bridge.resumeTracking(f.id), /Observed anchor changed/);
  assert.equal((await f.bridge.status()).conversations[f.id].tracking.status, 'stopped');
});

test('malformed saved enrollment fails explicitly instead of silently disabling synchronization', async () => {
  const f = await fixture();
  for (const tracking of [{ status: 'unknown', stoppedAt: 0 }, { status: 'stopped', stoppedAt: '0' },
    { status: 'stopped', stoppedAt: 0, silentlyDeleted: true }]) {
    await writeJSON(join(f.root, 'desktop-state.json'), { ...f.state,
      conversations: { [f.id]: { ...f.state.conversations[f.id], tracking } } });
    await assert.rejects(f.bridge.status(), /Invalid Desktop conversation enrollment/);
  }
});

test('global original collection guards identify the failing conversation rather than a caller', async () => {
  const f = await fixture(), foreignId = randomUUID(), state = await f.bridge.status();
  const original = { ...state.records[0], id: randomUUID(), nativeId: randomUUID(),
    conversationId: foreignId, status: 'original', path: join(f.root, 'foreign-original.jsonl') };
  state.conversations[foreignId] = { ...state.conversations[f.id], id: foreignId };
  state.records.push(original);
  f.native.set(original.nativeId, structuredClone(f.native.get(state.records[0].nativeId)));
  f.native.get(original.nativeId).messages[0].content[0].text = 'Observed changed original';
  await f.bridge.save(state);
  await assert.rejects(f.bridge.collect(), error => {
    assert.match(error.message, /Superseded original .*changed/);
    assert.equal(error.conversationId, foreignId); return true;
  });
  assert.deepEqual((await f.bridge.status()).records, state.records);
});

test('CLI stop is metadata-only and refuses a live watcher lock', async () => {
  const f = await fixture();
  await writeJSON(join(f.root, 'config.json'), { version: 1, mode: 'desktop',
    codexHome: '/missing/synthetic-codex-home', claudeHome: '/missing/synthetic-claude-home' });
  const cli = resolve('bin/claudex.mjs'), args = [cli, 'untrack', f.id, '--root', f.root];
  await writeJSON(join(f.root, 'watch.lock'), { pid: process.pid, started: new Date().toISOString() });
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /Another bridge operation|another bridge operation/i);
  assert.equal((await f.bridge.status()).conversations[f.id].tracking, undefined);
  const { unlink } = await import('node:fs/promises'); await unlink(join(f.root, 'watch.lock'));
  const bytes = await f.bytes();
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  assert.equal(result.historyPreserved, true); assert.equal(result.tracking, 'stopped');
  assert.deepEqual(await f.bytes(), bytes);
  assert.deepEqual((await f.bridge.status()).records, f.state.records);
});

test('watcher excludes stopped groups from native sync and event observation while retaining discovery exclusions', async () => {
  const f = await fixture(); await f.bridge.untrack(f.id);
  const state = await f.bridge.status(), calls = [], observations = [], writes = [];
  const nativeId = state.records[0].nativeId;
  const bridge = { status: async () => structuredClone(state), sync: async id => { calls.push(id); }, collect: async () => {} };
  const runtime = { codex: async () => ({}), ownedNativeIds: async () => new Set() };
  const events = { metrics: {}, wait: async () => [{ side: 'claude', nativeId, kind: 'completed' }],
    observe: async (_batch, snapshot) => observations.push(snapshot), acknowledge: async () => {} };
  await runDesktopWatch({ root: f.root, bridge, runtime, config: {}, events, maxPasses: 2, now: () => 0,
    pollMs: 0, writeStatus: async (_path, value) => writes.push(structuredClone(value)),
    discover: async (_config, known) => {
      for (const record of state.records) assert.ok(known.has(`${record.side}:${record.nativeId}`));
      return [];
    } });
  assert.deepEqual(calls, []);
  assert.ok(observations.length > 0);
  for (const observed of observations) { assert.deepEqual(observed.records, []); assert.deepEqual(observed.conversations, {}); }
  assert.ok(writes.some(write => write.running === true && write.checkingConversationCount === 0));
  assert.equal(writes.at(-1).blockedConversationCount, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, symlink, unlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistentColdNativeIdentity } from '../src/desktop-watch-hints.mjs';
import { runDesktopWatch } from '../src/desktop-watch.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-cold-watch-')));
  const state = { pending: null, conversations: {
    cold: { id: 'cold', discoveryMode: 'cold-import', canonical: { count: 2, digest: 'canonical' } },
    ordinary: { id: 'ordinary' },
  }, records: [] };
  for (const [side, status, suffix] of [['codex', 'current', 'source'], ['claude', 'current', 'local'],
    ['codex', 'original', 'superseded']]) {
    const path = join(root, `${suffix}.jsonl`);
    await writeFile(path, 'original history\n');
    state.records.push({ id: suffix, nativeId: suffix, conversationId: 'cold', path, side, status,
      managed: false, kind: 'original', checkpoint: { count: 2, digest: 'canonical' } });
  }
  const calls = { sync: [], metadata: [], recover: 0, collect: 0 };
  let clock = 0;
  const f = { root, state, calls, nativeStatus: 'notLoaded',
    tick(ms) { clock += ms; },
    record(id) { return state.records.find(record => record.id === id); },
  };
  const codex = { async request(method, params) {
    assert.equal(method, 'thread/read');
    assert.equal(params.includeTurns, false);
    calls.metadata.push(params.threadId);
    return { thread: { id: params.threadId, status: { type: f.nativeStatus } } };
  } };
  const bridge = {
    async status() { return structuredClone(state); },
    async recover() { calls.recover++; state.pending = null; },
    async sync(id) { calls.sync.push(id); return id === 'cold' ? { changed: false, incompleteTail: false } : { changed: false }; },
    async collect() { calls.collect++; },
  };
  const runtime = { async codex() { return codex; }, async ownedNativeIds() { return new Set(); } };
  f.bridge = bridge;
  f.run = options => runDesktopWatch({ root, bridge, runtime, config: {},
    discover: async () => [], pollMs: 0, sleep: async () => {}, now: () => clock, ...options });
  return f;
}

test('stable cold imports skip repeated full sync without changing transcripts or checkpoints', async () => {
  const f = await fixture();
  const originalState = structuredClone(f.state);
  await f.run({ maxPasses: 4 });
  assert.deepEqual(f.calls.sync, ['ordinary', 'cold', 'ordinary', 'ordinary', 'ordinary']);
  assert.deepEqual(f.calls.metadata, ['source', 'superseded']);
  assert.deepEqual(f.state, originalState);
  for (const record of f.state.records) assert.equal(await readFile(record.path, 'utf8'), 'original history\n');
  // Hints are process-local and never substitute for the first verification.
  await f.run({ maxPasses: 1 });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 2);
});

test('cold hints have an absolute periodic validation deadline, not an idle sliding timeout', async () => {
  const f = await fixture();
  await f.run({ maxPasses: 5, coldValidationMs: 60, sleep: async () => f.tick(20) });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 2);
  assert.equal(f.calls.sync.filter(id => id === 'ordinary').length, 5);
});

for (const target of ['source', 'local', 'superseded']) {
  test(`an append to ${target} invalidates a previously verified cold hint`, async () => {
    const f = await fixture();
    let changed = false;
    await f.run({ maxPasses: 3, sleep: async () => {
      if (!changed) { changed = true; await writeFile(f.record(target).path, 'original history\nnew turn\n'); }
    } });
    assert.equal(f.calls.sync.filter(id => id === 'cold').length, 2);
  });
}

test('same-content native file replacement invalidates the inode identity hint', async () => {
  const f = await fixture();
  await f.run({ maxPasses: 2, sleep: async () => {
    const replacement = join(f.root, 'replacement');
    await writeFile(replacement, 'original history\n');
    await rename(replacement, f.record('source').path);
  } });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 2);
});

test('missing paths never cache success and missing-path sync failures remain visible', async () => {
  const f = await fixture();
  await unlink(f.record('source').path);
  await f.run({ maxPasses: 3 });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 3);
  f.bridge.sync = async () => { throw new Error('Missing native source history.'); };
  await assert.rejects(f.run({ maxPasses: 1 }), /Missing native source history/);
});

test('symlinked source files cannot establish cold hints', async () => {
  const f = await fixture();
  const source = f.record('source');
  const target = join(f.root, 'target.jsonl');
  await rename(source.path, target);
  await symlink(target, source.path);
  await f.run({ maxPasses: 3 });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 3);
});

test('failed full verification invalidates its old cold hint even after paths stabilize', async () => {
  const f = await fixture();
  const sync = f.bridge.sync;
  let coldCalls = 0;
  f.bridge.sync = async id => {
    const result = await sync(id);
    if (id === 'cold' && ++coldCalls === 2) throw new Error('Source history changed between complete reads.');
    return result;
  };
  let changed = false;
  await f.run({ maxPasses: 4, sleep: async () => {
    if (!changed) { changed = true; await writeFile(f.record('source').path, 'changed\n'); }
  } });
  assert.equal(coldCalls, 3);
});

test('an append racing a successful full sync is not cached until another stable verification', async () => {
  const f = await fixture();
  const sync = f.bridge.sync;
  let changed = false;
  f.bridge.sync = async id => {
    const result = await sync(id);
    if (id === 'cold' && !changed) { changed = true; await writeFile(f.record('local').path, 'racing new turn\n'); }
    return result;
  };
  await f.run({ maxPasses: 3 });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 2);
});

test('conversation checkpoints and record lifecycle transitions invalidate hints', async () => {
  const f = await fixture();
  let pass = 0;
  await f.run({ maxPasses: 4, sleep: async () => {
    if (++pass === 1) f.state.conversations.cold.canonical.digest = 'new canonical';
    if (pass === 2) f.record('superseded').archivedAt = 100;
  } });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 3);
});

test('pending native work recovers normally and invalidates all scheduling hints', async () => {
  const f = await fixture();
  let pending = false;
  await f.run({ maxPasses: 3, sleep: async () => {
    if (!pending) { pending = true; f.state.pending = { phase: 'prepared' }; }
  } });
  assert.equal(f.calls.recover, 1);
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 2);
});

test('current managed Claude owners always receive full lifecycle inspection', async () => {
  const f = await fixture();
  Object.assign(f.record('local'), { managed: true, kind: 'owner' });
  await f.run({ maxPasses: 3 });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 3);
  assert.deepEqual(f.calls.metadata, []);
});

test('a cold import transitioning to a live managed owner immediately stops hint skipping', async () => {
  const f = await fixture();
  await f.run({ maxPasses: 3, sleep: async () => {
    Object.assign(f.record('local'), { managed: true, kind: 'owner' });
  } });
  assert.equal(f.calls.sync.filter(id => id === 'cold').length, 3);
});

for (const result of [{ changed: true }, { changed: false }, { changed: false, incompleteTail: true }]) {
  test(`only explicit complete no-change results establish a cold hint: ${JSON.stringify(result)}`, async () => {
    const f = await fixture();
    f.bridge.sync = async id => { f.calls.sync.push(id); return result; };
    await f.run({ maxPasses: 3 });
    assert.equal(f.calls.sync.filter(id => id === 'cold').length, 3);
  });
}

test('native active or unknown lifecycle states cannot establish a cold hint', async () => {
  for (const status of ['active', 'unknown']) {
    const f = await fixture();
    f.nativeStatus = status;
    await f.run({ maxPasses: 3 });
    assert.equal(f.calls.sync.filter(id => id === 'cold').length, 3);
  }
});

test('missing cold-cache native paths miss reuse and leave full inspection responsible for diagnostics', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-cold-hints-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'rollout.jsonl'); await writeFile(path, '{}\n');
  const canonical = { count: 2, digest: 'a'.repeat(64) };
  const state = { conversations: { c: { discoveryMode: 'cold-import', canonical } }, records:
    ['codex', 'claude'].map(side => ({ conversationId: 'c', side, nativeId: side, path, cwd: root,
      status: 'current', managed: false, kind: 'original', verified: true, checkpoint: canonical,
      ...(side === 'claude' ? { importPacket: true, packetVersion: 2 } : {}) })) };
  let thread = { id: 'codex', path, cwd: root, status: { type: 'idle' } };
  const codex = { request: async () => ({ thread }) };
  assert.ok(await persistentColdNativeIdentity(state, 'c', codex));
  thread = { ...thread, cwd: join(root, 'removed-project') };
  assert.equal(await persistentColdNativeIdentity(state, 'c', codex), null);
  thread = { ...thread, cwd: root, path: join(root, 'removed-rollout') };
  assert.equal(await persistentColdNativeIdentity(state, 'c', codex), null);
  thread = { ...thread, path, cwd: join(path, 'not-a-directory') };
  assert.equal(await persistentColdNativeIdentity(state, 'c', codex), null);
  const error = new Error('Transport failed');
  await assert.rejects(persistentColdNativeIdentity(state, 'c', { request: async () => { throw error; } }), e => e === error);
});

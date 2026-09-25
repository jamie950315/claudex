import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDesktopWatch } from '../src/desktop-watch.mjs';
import { discoverSources } from '../src/discovery.mjs';

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-watch-'));
  const calls = { codex: 0, recover: 0, track: [], sync: [], collect: 0 };
  const state = { records: [], conversations: {}, pending: null };
  const runtime = {
    async codex() { calls.codex++; return { async request(_method, { threadId }) { return { thread: { id: threadId, source: 'vscode' } }; } }; },
    async ownedNativeIds() { return new Set(['claude:owned']); },
    ...overrides.runtime,
  };
  const bridge = {
    async status() { return structuredClone(state); },
    async recover() { calls.recover++; state.pending = null; },
    async track(source) {
      calls.track.push(source.path);
      state.records.push({ side: source.side, nativeId: source.id });
      state.conversations[source.id] = { id: source.id };
    },
    async sync(id) { calls.sync.push(id); },
    async collect() { calls.collect++; },
    ...overrides.bridge,
  };
  const discover = overrides.discover ?? (async (_config, known) =>
    [{ side: 'codex', id: 'new', path: '/new' }, { side: 'claude', id: 'owned', path: '/owned' }]
      .filter(source => !known.has(`${source.side}:${source.id}`)));
  const run = options => runDesktopWatch({ root, bridge, runtime, discover,
    config: { codexHome: '/codex', claudeHome: '/claude', since: 0 }, pollMs: 0,
    sleep: async () => {}, ...options });
  const status = async () => JSON.parse(await readFile(join(root, 'watcher-status.json'), 'utf8'));
  return { root, calls, state, runtime, bridge, discover, run, status };
}

test('restart recovers a pending native operation before discovery or allocation', async () => {
  const f = await fixture();
  f.state.pending = { phase: 'prepared' };
  await f.run({ maxPasses: 1, discover: async (config, known) => {
    assert.equal(f.calls.recover, 1);
    assert.equal(f.state.pending, null);
    assert.equal(config.allProjects, true);
    assert.equal(config.excludeSubagents, false);
    assert.ok(known.has('claude:owned'));
    return [{ side: 'codex', id: 'new', path: '/new' }];
  } });
  assert.deepEqual(f.calls.track, ['/new']);
  assert.equal(f.calls.sync.length, 1);
  assert.equal((await f.status()).running, false);
});

test('absent shared transport waits without enrolling sources and later resumes', async () => {
  let available = false;
  const f = await fixture({ runtime: { async codex() {
    if (!available) { available = true; throw new Error('Shared Codex Desktop backend is not ready.'); }
    return { async request(_method, { threadId }) { return { thread: { id: threadId, source: 'vscode' } }; } };
  } } });
  let first;
  await f.run({ maxPasses: 2, sleep: async () => {
    first = await f.status();
    assert.deepEqual(f.calls.track, []);
  } });
  assert.match(first.waiting, /backend is not ready/);
  assert.deepEqual(f.calls.track, ['/new']);
});

test('a restarted Desktop watcher reclaims its previous exited-process lock', async () => {
  const f = await fixture();
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  await writeFile(join(f.root, 'watch.lock'), JSON.stringify({ pid: child.pid, started: new Date().toISOString() }), { mode: 0o600 });
  await f.run({ maxPasses: 1 });
  assert.deepEqual(f.calls.track, ['/new']);
});

test('an observed shared transport disconnect waits for a fresh connected pass', async () => {
  let connected = false;
  const f = await fixture({ runtime: { async codex() {
    if (!connected) { connected = true; throw new Error('Could not connect to the shared Codex transport'); }
    return { async request(_method, { threadId }) { return { thread: { id: threadId, source: 'vscode' } }; } };
  } } });
  let first;
  await f.run({ maxPasses: 2, sleep: async () => { first = await f.status(); } });
  assert.match(first.waiting, /Could not connect/);
  assert.deepEqual(f.calls.track, ['/new']);
});

test('tracked and owned identities are not enrolled again on later passes', async () => {
  const f = await fixture();
  await f.run({ maxPasses: 3 });
  assert.deepEqual(f.calls.track, ['/new']);
  assert.equal(f.calls.codex, 3);
});

test('a busy destination waits and retries after it becomes idle', async () => {
  let busy = true;
  const f = await fixture({ bridge: { async sync(id) {
    f.calls.sync.push(id);
    if (busy) throw new Error('Claude turn is still running.');
  } } });
  let first;
  await f.run({ maxPasses: 2, sleep: async () => {
    first = await f.status();
    busy = false;
  } });
  assert.match(first.waiting, /still running/);
  assert.deepEqual(f.calls.track, ['/new']);
  assert.equal(f.calls.sync.length, 2);
});

test('an ambiguous native write is recovered from its durable intent before another sync', async () => {
  let first = true;
  const f = await fixture({ bridge: { async sync(id) {
    f.calls.sync.push(id);
    if (first) {
      first = false;
      f.state.pending = { phase: 'prepared' };
      throw new Error('Native response lost after apply.');
    }
  } } });
  await f.run({ maxPasses: 1 });
  assert.equal(f.calls.recover, 1);
  assert.equal(f.calls.sync.length, 1);
  assert.equal(f.state.pending, null);
});

test('unsupported new histories have a bounded warning count and do not stop other sources', async () => {
  const f = await fixture({ bridge: { async track(source) {
    if (source.id !== 'good') throw new Error('Referenced Codex history is unavailable.');
    f.calls.track.push(source.path);
    f.state.records.push({ side: source.side, nativeId: source.id });
  } } });
  const candidates = Array.from({ length: 25 }, (_, i) => ({ side: 'codex', id: `bad${i}`, path: `/bad${i}` }));
  candidates.push({ side: 'codex', id: 'good', path: '/good' });
  let pass;
  await f.run({ maxPasses: 2, discover: async (_config, known) => candidates.filter(source => !known.has(`${source.side}:${source.id}`)),
    sleep: async () => { pass = await f.status(); } });
  assert.deepEqual(f.calls.track, ['/good']);
  assert.equal(pass.blockedSourceCount, 25);
  assert.equal(pass.blockedSources.length, 20);
  assert.equal((await f.status()).error, null);
});

test('conflicting tracked histories stop the watcher without choosing a branch', async () => {
  const f = await fixture({ bridge: { async sync() { throw new Error('Both sides changed; no history was replaced.'); } } });
  await assert.rejects(f.run({ maxPasses: 1 }), /Both sides changed/);
  assert.match((await f.status()).error, /Both sides changed/);
  assert.equal(f.state.pending, null);
});

const boundedNativeDiscoveryErrors = [
  'Native Codex local image recovery: current rollout lacks complete unambiguous image provenance; referenced histories were not searched.',
  'Native Codex local image recovery: image response provenance does not match its native turn.',
  'Native Codex history export: unsupported user input or external asset; nothing was silently omitted.',
  'Native Codex history export: byte limit exceeded; no partial export is returned.',
  'Native Codex history export: converted byte limit exceeded; no partial export is returned.',
  'Native Codex history export: a completed turn lacks its final assistant response.',
  'Native Codex history export: a completed turn has no persisted items.',
];

test('unenrolled native image, provenance, size and incomplete stored histories produce bounded diagnostics without blocking discovery', async () => {
  const f = await fixture();
  const track = f.bridge.track;
  f.bridge.track = async source => {
    if (source.id !== 'good') throw new Error(boundedNativeDiscoveryErrors[Number(source.id.slice(3)) % boundedNativeDiscoveryErrors.length]);
    return track(source);
  };
  const sources = Array.from({ length: 28 }, (_, i) => ({ side: 'codex', id: `bad${i}`, path: `/bad${i}` }));
  sources.push({ side: 'codex', id: 'good', path: '/good' });
  let pass;
  await f.run({ maxPasses: 2, discover: async (_config, known) => sources.filter(source => !known.has(`${source.side}:${source.id}`)),
    sleep: async () => { pass = await f.status(); } });
  assert.deepEqual(f.calls.track, ['/good']);
  assert.equal(pass.waiting, null);
  assert.equal(pass.blockedSourceCount, 28);
  assert.equal(pass.blockedSources.length, 20);
  assert.deepEqual(pass.blockedSources.slice(0, 7).map(source => source.reason), boundedNativeDiscoveryErrors);
  assert.equal((await f.status()).error, null);
});

for (const message of boundedNativeDiscoveryErrors) {
  test(`tracked history still stops on ${message}`, async () => {
    const f = await fixture({ bridge: { async sync() { throw new Error(message); } } });
    await assert.rejects(f.run({ maxPasses: 1 }), error => error.message === message);
    assert.equal((await f.status()).error, message);
    assert.equal(f.state.pending, null);
  });
}

for (const message of ['Native Codex history export: malformed pagination response.',
  'Native Codex history export: malformed native item.',
  'Native Codex history export: invalid export limit.']) {
  test(`unrecognized native metadata failures remain fatal during discovery: ${message}`, async () => {
    const f = await fixture({ bridge: { async track() { throw new Error(message); } } });
    await assert.rejects(f.run({ maxPasses: 1 }), error => error.message === message);
    assert.equal((await f.status()).error, message);
  });
}

test('native transport failures remain waiting conditions rather than unsupported discovery diagnostics', async () => {
  const message = 'Native Codex history export: native transport unavailable; no export was produced.';
  const f = await fixture({ bridge: { async track() { throw new Error(message); } } });
  let pass;
  await f.run({ maxPasses: 2, sleep: async () => { pass = await f.status(); } });
  assert.equal(pass.waiting, message);
  assert.equal(pass.blockedSourceCount, 0);
  assert.deepEqual(f.calls.track, []);
});

test('subagent discovery is excluded only when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-discover-subagent-'));
  const codexHome = join(root, 'codex');
  const claudeHome = join(root, 'claude');
  const { mkdir } = await import('node:fs/promises');
  const sessions = join(codexHome, 'sessions');
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, 'rollout-child.jsonl'), JSON.stringify({ type: 'session_meta',
    payload: { id: 'child', cwd: root, source: { subAgent: { thread_spawn: {} } } } }) + '\n');
  const options = { codexHome, claudeHome, allProjects: true, since: 0 };
  assert.equal((await discoverSources(options)).length, 1);
  assert.deepEqual(await discoverSources({ ...options, excludeSubagents: true }), []);
});

test('native source metadata excludes subagents and retains ordinary forks when headers disagree', async () => {
  const read = [];
  const f = await fixture({ runtime: { async codex() { return { async request(method, params) {
    assert.equal(method, 'thread/read');
    assert.equal(params.includeTurns, false);
    read.push(params.threadId);
    return { thread: { id: params.threadId, source: params.threadId === 'child'
      ? { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } } : 'vscode',
      forkedFromId: params.threadId === 'fork' ? 'parent' : null } };
  } }; } } });
  const codexHome = join(f.root, 'codex');
  const sessions = join(codexHome, 'sessions');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(sessions, { recursive: true });
  for (const [id, source] of [['child', 'vscode'], ['fork', { subAgent: { thread_spawn: {} } }]]) {
    await writeFile(join(sessions, `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.root, source } }) + '\n');
  }
  await f.run({ maxPasses: 1, discover: discoverSources,
    config: { codexHome, claudeHome: join(f.root, 'claude'), since: 0 },
  });
  assert.deepEqual(read, ['child', 'fork']);
  assert.deepEqual(f.calls.track, [join(sessions, 'rollout-fork.jsonl')]);
  assert.equal((await f.status()).error, null);
});

test('an unavailable new native thread is reported while another source enrolls', async () => {
  const f = await fixture({ runtime: { async codex() { return { async request(_method, { threadId }) {
    if (threadId === 'missing') throw new Error('Thread not found');
    return { thread: { id: threadId, source: 'vscode' } };
  } }; } } });
  let pass;
  await f.run({ maxPasses: 2, discover: async (_config, known) => [
    { side: 'codex', id: 'missing', path: '/missing' }, { side: 'codex', id: 'good', path: '/good' },
  ].filter(source => !known.has(`${source.side}:${source.id}`)), sleep: async () => { pass = await f.status(); } });
  assert.deepEqual(f.calls.track, ['/good']);
  assert.equal(pass.blockedSourceCount, 1);
  assert.match(pass.blockedSources[0].reason, /Referenced Codex history/);
  assert.equal((await f.status()).error, null);
});

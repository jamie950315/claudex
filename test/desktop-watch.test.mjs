import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDesktopWatch } from '../src/desktop-watch.mjs';
import { discoverSources } from '../src/discovery.mjs';
import { inspectCodexSocket } from '../src/codex-websocket.mjs';

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
    sleep: async () => {}, now: () => 0, ...options });
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

test('an absent native socket keeps owners and pending work alive until the next verified connection', async () => {
  const f = await fixture(); let closeCount = 0, attempts = 0;
  const owner = { close() { closeCount++; } };
  f.runtime.owners = new Map([['existing', { owner }]]);
  const pending = { phase: 'prepared', operationId: 'unchanged-operation' };
  f.state.pending = structuredClone(pending);
  f.runtime.codex = async () => {
    if (attempts++ === 0) await inspectCodexSocket(join(f.root, 'missing-native-endpoint'));
    return { async request(_method, { threadId }) { return { thread: { id: threadId, source: 'vscode' } }; } };
  };
  await f.run({ maxPasses: 2, sleep: async () => {
    const status = await f.status();
    assert.equal(status.running, true);
    assert.match(status.waiting, /Shared Codex transport unavailable/);
    assert.deepEqual(f.state.pending, pending);
    assert.equal(f.calls.recover, 0);
    assert.deepEqual(f.calls.track, []);
    assert.equal(f.runtime.owners.get('existing').owner, owner);
    assert.equal(closeCount, 0);
  } });
  assert.equal(f.calls.recover, 1);
  assert.deepEqual(f.calls.track, ['/new']);
  assert.equal(closeCount, 0);
});

test('tracked and owned identities are not enrolled again on later passes', async () => {
  const f = await fixture();
  await f.run({ maxPasses: 3 });
  assert.deepEqual(f.calls.track, ['/new']);
  assert.equal(f.calls.codex, 3);
});

test('an unenrolled conversation without a complete first turn does not make healthy synchronization globally wait', async () => {
  const f = await fixture(); const track = f.bridge.track;
  f.bridge.track = async source => {
    if (source.id === 'unfinished') throw new Error('Wait for a complete assistant turn or verified synchronized checkpoint.');
    return track(source);
  };
  let during;
  await f.run({ maxPasses: 2,
    discover: async (_config, known) => [{ side: 'claude', id: 'unfinished', path: '/unfinished' },
      { side: 'codex', id: 'new', path: '/new' }].filter(source => !known.has(`${source.side}:${source.id}`)),
    sleep: async () => { during = await f.status(); } });
  assert.equal(during.running, true);
  assert.equal(during.waiting, null);
  assert.equal(during.synchronization, 'ready');
  assert.equal(during.blockedSourceCount, 0);
  assert.deepEqual(f.calls.sync, ['new', 'new']);
  assert.equal(f.state.conversations.unfinished, undefined);
  assert.equal(f.state.pending, null);
});

test('opt-in folder maps update during discovery refreshes without adding native writers', async () => {
  const f = await fixture(), maps = [], resources = [];
  let pass;
  await f.run({ maxPasses: 2, config: { folderProjection: { enabled: true, cachePath: '/synthetic-cache' } },
    publishFolders: async ({ state }) => { maps.push(Object.keys(state.conversations)); return { changed: true, entries: 1, deferred: null }; },
    maintainFolders: async options => { resources.push(options.cachePath); return { changed: false }; },
    sleep: async () => { pass = await f.status(); } });
  assert.ok(maps.some(ids => ids.includes('new')));
  assert.deepEqual(resources, ['/synthetic-cache']);
  assert.equal(pass.folderProjection.state, 'ready');
  assert.equal(pass.folderProjection.entries, 1);
  assert.deepEqual(f.calls.track, ['/new']);
});

test('folder presentation errors are exposed without allocating replacement owners or interrupting sync', async () => {
  const f = await fixture(); let pass;
  await f.run({ maxPasses: 2, config: { folderProjection: { enabled: true } },
    publishFolders: async () => { throw new Error('Folder map identity mismatch'); },
    maintainFolders: async () => { throw new Error('Must not run after failed map publication'); },
    sleep: async () => { pass = await f.status(); } });
  assert.equal(pass.folderProjection.state, 'error');
  assert.match(pass.folderProjection.error, /identity mismatch/);
  assert.deepEqual(f.calls.track, ['/new']);
  assert.equal(f.calls.sync.length, 2);
});

test('an unsupported folder resource stays visibly failed until maintenance succeeds', async () => {
  const f = await fixture(); let pass, attempts = 0;
  await f.run({ maxPasses: 2, config: { folderProjection: { enabled: true } },
    publishFolders: async () => ({ changed: false, entries: 1, deferred: null }),
    maintainFolders: async () => { attempts++; throw new Error('Unvalidated frontend source'); },
    sleep: async () => { pass = await f.status(); } });
  assert.equal(attempts, 1);
  assert.equal(pass.folderProjection.state, 'error');
  assert.match(pass.folderProjection.error, /Unvalidated frontend/);
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

test('conflicting tracked histories stay blocked without stopping owners or choosing a branch', async () => {
  const f = await fixture({ bridge: { async sync() { throw new Error('Both sides changed; no history was replaced.'); } } });
  let pass;
  await f.run({ maxPasses: 2, sleep: async () => { pass = await f.status(); } });
  assert.equal(pass.running, true);
  assert.equal(pass.synchronization, 'degraded');
  assert.match(pass.blockedConversations[0].reason, /Both sides changed/);
  assert.equal(pass.blockedConversations[0].conversationId, 'new');
  assert.equal(f.state.pending, null);
});

const prefixMismatch = 'Owned Claude history does not match the synchronized prefix; no branch was selected.';

test('dependent threads hold a promoted pending snapshot without restarting or retiring it', async () => {
  const f = await fixture();
  let clock = 0, discoverCount = 0, closeCount = 0;
  const owner = { close() { closeCount++; } };
  f.runtime.owners = new Map([['unrelated', { owner }]]);
  const pending = { phase: 'promoted', operationId: 'protected-retirement',
    targetId: 'dependent-snapshot', record: { conversationId: 'protected', side: 'codex' } };
  f.state.pending = structuredClone(pending);
  f.bridge.recover = async () => { f.calls.recover++; throw new Error('Owned projection has dependent threads.'); };
  const snapshots = [];
  await f.run({ maxPasses: 3, now: () => clock, discover: async () => { discoverCount++; return []; },
    sleep: async ms => {
      snapshots.push(await f.status());
      clock += ms;
      assert.deepEqual(f.state.pending, pending);
    } });
  assert.equal(f.calls.recover, 3);
  assert.equal(discoverCount, 0);
  assert.deepEqual(f.calls.track, []);
  assert.deepEqual(f.calls.sync, []);
  assert.equal(f.calls.collect, 0);
  assert.equal(closeCount, 0);
  assert.deepEqual(f.state.pending, pending);
  assert.deepEqual(snapshots.map(status => [status.running, status.synchronization, status.blocked.scope]),
    [[true, 'blocked', 'pending'], [true, 'blocked', 'pending']]);
  assert.equal(snapshots[0].blocked.phase, 'promoted');
  assert.equal(snapshots[0].blocked.operationId, 'protected-retirement');
  assert.equal(snapshots[0].blocked.reason, 'Owned projection has dependent threads.');
  assert.equal(snapshots[1].blocked.attempts, 2);
});

test('an observed pending prefix mismatch keeps the watcher alive and preserves the sole native intent', async () => {
  const f = await fixture();
  let clock = 0, discoverCount = 0, closeCount = 0;
  const owner = { remoteId: 'same-remote-control-session', close() { closeCount++; } };
  f.runtime.owners = new Map([['unrelated', { owner }]]);
  const pending = { phase: 'prepared', operationId: 'same-operation', record: { conversationId: 'new' },
    common: { messages: ['complete checkpoint'] } };
  f.bridge.sync = async id => {
    f.calls.sync.push(id);
    f.state.pending = structuredClone(pending);
    throw new Error(prefixMismatch);
  };
  f.bridge.recover = async () => { f.calls.recover++; throw new Error(prefixMismatch); };
  const snapshots = [], pauses = [];
  await f.run({ maxPasses: 3, now: () => clock, discover: async (...args) => { discoverCount++; return f.discover(...args); },
    sleep: async ms => {
      snapshots.push(await f.status()); pauses.push(ms); clock += ms;
      assert.deepEqual(f.state.pending, pending);
      assert.equal(f.runtime.owners.get('unrelated').owner, owner);
      assert.equal(closeCount, 0);
    } });
  assert.deepEqual(pauses, [30_000, 30_000]);
  assert.equal(discoverCount, 1);
  assert.deepEqual(f.calls.sync, ['new']);
  assert.equal(f.calls.recover, 3);
  assert.equal(f.calls.collect, 0);
  assert.deepEqual(f.state.pending, pending);
  assert.deepEqual(snapshots.map(status => [status.running, status.synchronization, status.blocked.scope]),
    [[true, 'blocked', 'pending'], [true, 'blocked', 'pending']]);
  assert.equal(snapshots[0].blocked.operationId, 'same-operation');
  assert.equal(snapshots[0].blocked.reason, prefixMismatch);
  assert.equal(snapshots[1].blocked.attempts, 2);
});

test('a blocked startup recovery performs no discovery or allocation before verified recovery succeeds', async () => {
  const f = await fixture();
  let clock = 0;
  const pending = { phase: 'prepared', operationId: 'saved-operation', record: { conversationId: 'saved' } };
  f.state.pending = structuredClone(pending);
  f.bridge.recover = async () => {
    f.calls.recover++;
    if (f.calls.recover === 1) throw new Error(prefixMismatch);
    assert.deepEqual(f.state.pending, pending);
    f.state.pending = null;
  };
  await f.run({ maxPasses: 2, now: () => clock, sleep: async ms => {
    const status = await f.status();
    assert.equal(status.running, true);
    assert.equal(status.blocked.phase, 'prepared');
    assert.deepEqual(f.calls.track, []);
    assert.deepEqual(f.calls.sync, []);
    clock += ms;
  } });
  assert.equal(f.calls.recover, 2);
  assert.equal(f.state.pending, null);
  assert.deepEqual(f.calls.track, ['/new']);
  assert.deepEqual(f.calls.sync, ['new']);
  assert.equal((await f.status()).blocked, null);
});

test('pending recovery cannot hot-loop when a wakeup occurs before its revalidation deadline', async () => {
  const f = await fixture();
  f.state.pending = { phase: 'prepared' };
  f.bridge.recover = async () => { f.calls.recover++; throw new Error(prefixMismatch); };
  await f.run({ maxPasses: 4, sleep: async () => {} });
  assert.equal(f.calls.recover, 1);
  assert.deepEqual(f.calls.track, []);
  assert.deepEqual(f.calls.sync, []);
  assert.equal((await f.status()).blocked.attempts, 1);
});

test('nonpending guards isolate bounded conversation diagnostics and revalidate on a fixed cadence', async () => {
  const f = await fixture();
  let clock = 0, pass;
  f.bridge.sync = async id => {
    f.calls.sync.push(id);
    if (id !== 'good') throw new Error(prefixMismatch);
  };
  const sources = Array.from({ length: 25 }, (_, index) => ({ side: 'claude', id: `bad-${index}`, path: `/bad-${index}` }));
  sources.push({ side: 'claude', id: 'good', path: '/good' });
  await f.run({ maxPasses: 4, now: () => clock, blockedRetryMs: 30,
    discover: async (_config, known) => sources.filter(source => !known.has(`${source.side}:${source.id}`)),
    sleep: async () => { pass = await f.status(); clock += 10; } });
  assert.equal(pass.running, true);
  assert.equal(pass.synchronization, 'degraded');
  assert.equal(pass.blocked, null);
  assert.equal(pass.blockedSourceCount, 0);
  assert.equal(pass.blockedConversationCount, 25);
  assert.equal(pass.blockedConversations.length, 20);
  assert.equal(f.calls.sync.filter(id => id === 'good').length, 4);
  for (let index = 0; index < 25; index++) assert.equal(f.calls.sync.filter(id => id === `bad-${index}`).length, 2);
  assert.equal(f.state.pending, null);
});

test('a conversation leaves the blocked set only after a successful full sync', async () => {
  const f = await fixture();
  let clock = 0;
  f.bridge.sync = async id => {
    f.calls.sync.push(id);
    if (f.calls.sync.length === 1) throw new Error(prefixMismatch);
    return { changed: false, incompleteTail: false };
  };
  await f.run({ maxPasses: 2, now: () => clock, sleep: async () => { clock = 30_000; } });
  assert.deepEqual(f.calls.sync, ['new', 'new']);
  assert.equal((await f.status()).blockedConversationCount, 0);
});

test('blocked recovery remains abortable without clearing its pending transaction', async () => {
  const f = await fixture(), controller = new AbortController();
  const pending = { phase: 'prepared' };
  f.state.pending = pending;
  f.bridge.recover = async () => { f.calls.recover++; throw new Error(prefixMismatch); };
  await f.run({ signal: controller.signal, sleep: async (_ms, { signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  } });
  assert.equal(f.state.pending, pending);
  assert.equal(f.calls.recover, 1);
  assert.equal((await f.status()).running, false);
});

test('unclassified native sync and recovery failures are not silently retried', async () => {
  for (const pending of [null, { phase: 'prepared' }]) {
    const f = await fixture();
    f.state.pending = pending;
    const fail = async () => { throw new Error('Unexpected native lifecycle schema.'); };
    f.bridge.sync = fail;
    f.bridge.recover = fail;
    await assert.rejects(f.run({ maxPasses: 2 }), /Unexpected native lifecycle schema/);
    assert.equal((await f.status()).error, 'Unexpected native lifecycle schema.');
  }
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
  test(`tracked history remains explicitly blocked on ${message}`, async () => {
    const f = await fixture({ bridge: { async sync() { throw new Error(message); } } });
    await f.run({ maxPasses: 1 });
    assert.equal((await f.status()).blockedConversations[0].reason, message);
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

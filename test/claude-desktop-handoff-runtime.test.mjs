import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeDesktopHandoffRuntime } from '../crates/claudex-app/host/renderer/claude-desktop-handoff-runtime.mjs';
import { normalizeClaudeLocalFolderAnchor } from '../crates/claudex-app/host/renderer/claude-folder-anchor.mjs';
import { claudeFolderProjectKey } from '../crates/claudex-app/host/renderer/claude-folder-projection.mjs';
import { createClaudeFolderRuntime } from '../crates/claudex-app/host/renderer/claude-folder-runtime.mjs';

function fixture(options = {}) {
  let clock = 10000, tasks = [], errors = [], archives = [], statuses = [];
  const action = { operationId: '11111111-1111-4111-8111-111111111111', conversationId: '22222222-2222-4222-8222-222222222222',
    localSessionId: 'local_33333333-3333-4333-8333-333333333333', nativeId: '44444444-4444-4444-8444-444444444444',
    remoteId: 'cse_test', cwd: '/project', title: 'Same title', expectedLastActivityAt: 4000,
    registryProof: { path: '/native/claude-code-sessions/local_33333333-3333-4333-8333-333333333333.json' },
    originalProof: { sha256: 'a'.repeat(64), bytes: 100 } };
  let manifest = { version: 1, kind: 'claude-local-archive', generatedAt: clock, expiresAt: clock + 15000, actions: [action], anchors: [] };
  let session = { sessionId: action.localSessionId, cwd: action.cwd, title: action.title, lastActivityAt: 4000,
    isArchived: false, isRunning: false, turnRunning: false, pendingToolPermissions: [], loops: [] };
  const f = { action, errors, archives, statuses, reads: 0, nativeReads: 0, draft: false, children: [],
    mutateManifest(fn) { manifest = fn(manifest); }, mutateSession(fn) { session = fn(session); },
    tick(ms) { clock += ms; }, beforeManifest: null, beforeNative: null };
  const runtime = createClaudeDesktopHandoffRuntime({ now: () => clock, registryRoot: '/native/claude-code-sessions',
    readManifest: async () => { f.beforeManifest?.(++f.reads); return { contents: JSON.stringify(manifest) }; },
    native: { async getSession() { await f.beforeNative?.(++f.nativeReads); return structuredClone(session); },
      async getSessionList() { return { sessions: [session, ...f.children] }; }, async getGitInfo() { return null; },
      async getBusyShellPtyKeys() { return f.terminals ?? { probed: true, busy: [], unknown: [] }; },
      async readFileAtCwd() { return { contents: JSON.stringify({ ...session, cliSessionId: f.transcriptId ?? action.nativeId }) }; },
      async archive(id, options) { archives.push({ id, options }); session.isArchived = true; } },
    hasDraft: () => f.draft, setTimer(fn) { tasks.push(fn); return fn; }, clearTimer() {}, onError(error) { errors.push(error); },
    onStatus(code) { statuses.push(code); }, ...options });
  runtime.setRows([{ type: 'bridge', id: 'session_test', title: action.title }]);
  f.runtime = runtime;
  f.run = async () => { runtime.start(); for (let i = 0; i < 12 && !tasks.length; i++) await new Promise(resolve => setImmediate(resolve)); runtime.stop(); };
  return f;
}

test('only an exact verified replacement archives its idle Local predecessor through the native reversible action', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.archives, [{ id: f.action.localSessionId, options: { cleanupWorktree: false, forceWorktreeCleanup: false } }]);
  assert.equal(f.errors.length, 0);
  await f.runtime.poll(); assert.equal(f.archives.length, 1);
});

test('a fresh Code context supplies its unfiltered replacement even when presentation hides the entire group', async () => {
  const f = fixture(), raw = [{ type: 'bridge', id: 'session_test', title: f.action.title, isArchived: false }];
  const folder = createClaudeFolderRuntime({ createHandoff: () => f.runtime });
  folder.setModeRows(raw, claudeFolderProjectKey); // Read from the existing native rawCodeSessions context.
  folder.setRows([], claudeFolderProjectKey); // Status/age/environment and Project presentation hide it.
  const stop = folder.subscribeModes(() => {});
  await new Promise(resolve => setImmediate(resolve)); stop();
  assert.equal(f.archives.length, 1); assert.ok(f.statuses.includes('archive verified'));
  assert.equal(raw[0].isArchived, false);
});

test('replacement guard diagnostics distinguish absent IDs, changed titles and archived rows without native reads', async () => {
  for (const [rows, reason] of [[[], 'missing-id'], [[{ type: 'bridge', id: 'session_test', title: 'Different' }], 'title-changed'],
    [[{ type: 'bridge', id: 'session_test', title: 'Same title', isArchived: true }], 'archived']]) {
    const f = fixture(); f.runtime.setRows(rows); await f.run();
    assert.ok(f.statuses.includes(`replacement guard ${reason}`));
    assert.equal(f.nativeReads, 0); assert.equal(f.archives.length, 0);
  }
});

for (const field of ['isRunning', 'turnRunning', 'hasBackgroundWork', 'hasBackgroundActivity', 'starting', 'cliBootPending', 'isStarred'])
  test(`native ${field} defers archival without stopping user work`, async () => {
    const f = fixture(); f.mutateSession(session => ({ ...session, [field]: true })); await f.run();
    assert.equal(f.archives.length, 0); assert.match(f.errors[0], /active|unverified/);
    if (field === 'isStarred') assert.ok(f.statuses.includes('original guard starred'));
  });

test('queued input, pending permissions, loops, live descendants and unsent drafts block archival', async () => {
  for (const change of [f => f.draft = true, f => f.children.push({ spawnedFrom: { sessionId: f.action.localSessionId } }),
    f => f.mutateSession(s => ({ ...s, heldInput: { uuids: ['new'] } })),
    f => f.mutateSession(s => ({ ...s, pendingToolPermissions: [{}] })), f => f.mutateSession(s => ({ ...s, loops: [{}] }))]) {
    const f = fixture(); change(f); await f.run(); assert.equal(f.archives.length, 0);
  }
});

test('activity racing the dependency read is noticed before native archive', async () => {
  const f = fixture(); f.beforeNative = read => { if (read === 2) f.mutateSession(s => ({ ...s, isRunning: true, lastActivityAt: 5000 })); };
  await f.run(); assert.equal(f.archives.length, 0);
});

test('revoked and expired intents never execute and title mismatches cannot select another conversation', async () => {
  for (const change of [f => f.tick(16000), f => f.runtime.setRows([{ type: 'bridge', id: 'session_test', title: 'Another title' }]),
    f => f.beforeManifest = read => { if (read === 2) f.mutateManifest(m => ({ ...m, actions: [] })); }]) {
    const f = fixture(); change(f); await f.run(); assert.equal(f.archives.length, 0);
  }
});

test('an already archived exact Local identity is not archived again', async () => {
  const f = fixture(); f.mutateSession(s => ({ ...s, isArchived: true })); await f.run();
  assert.equal(f.archives.length, 0); assert.equal(f.errors.length, 0);
});

test('the observed absent native cron and permission maps mean no pending work', async () => {
  const f = fixture(); f.mutateSession(s => { delete s.loops; delete s.pendingToolPermissions; return s; }); await f.run();
  assert.equal(f.archives.length, 1);
});

test('empty revoked manifests do not produce recurring error noise', async () => {
  const f = fixture(); f.mutateManifest(m => ({ ...m, generatedAt: null, expiresAt: null, actions: [] })); await f.run();
  assert.equal(f.archives.length, 0); assert.equal(f.errors.length, 0);
});

test('a cold renderer restores the exact archived Local folder anchor without displaying or unarchiving it', async () => {
  const f = fixture({ normalizeAnchor: normalizeClaudeLocalFolderAnchor });
  f.mutateSession(s => ({ ...s, isArchived: true }));
  f.mutateManifest(m => ({ ...m, generatedAt: null, expiresAt: null, actions: [], anchors: [{
    conversationId: f.action.conversationId, localSessionId: f.action.localSessionId, nativeId: f.action.nativeId,
    replacementNativeId: '55555555-5555-4555-8555-555555555555', remoteId: f.action.remoteId, cwd: '/project', title: f.action.title }] }));
  f.runtime.setRows([{ type: 'bridge', id: 'session_test', title: f.action.title }], claudeFolderProjectKey);
  await f.run();
  assert.equal(f.runtime.projectionRows().length, 1);
  assert.equal(claudeFolderProjectKey(f.runtime.projectionRows()[0]), '/project');
  assert.equal(f.runtime.projectionRows()[0].isArchived, true);
  assert.equal(f.archives.length, 0);
});

test('archiving cannot accidentally retire the same Remote Control identity as the replacement', async () => {
  const f = fixture(); f.mutateSession(s => ({ ...s, bridgeSessionIds: ['session_test'] }));
  await f.run(); assert.equal(f.archives.length, 0); assert.match(f.errors[0], /shares the replacement/);
});

test('a reused Local UI identity cannot archive a different native CLI generation', async () => {
  const f = fixture(); f.transcriptId = '66666666-6666-4666-8666-666666666666'; await f.run();
  assert.equal(f.archives.length, 0); assert.match(f.errors[0], /CLI session identity/);
});

test('native terminal activity and incomplete terminal probes defer archival', async () => {
  for (const terminals of [{ probed: false, busy: [], unknown: [] }, { probed: true, busy: ['pty'], unknown: [] },
    { probed: true, busy: [], unknown: ['pty'] }]) {
    const f = fixture(); f.terminals = terminals; await f.run();
    assert.equal(f.archives.length, 0); assert.match(f.errors[0], /terminal work/);
  }
});

test('handoff diagnostics identify silent replacement waits and successful native consumption without identities', async () => {
  const waiting = fixture();
  waiting.runtime.setRows([{ type: 'bridge', id: 'session_other', title: 'Another replacement' }]);
  await waiting.run();
  assert.ok(waiting.statuses.includes('started'));
  assert.ok(waiting.statuses.includes('poll started'));
  assert.ok(waiting.statuses.includes('rows received bridge-present'));
  assert.ok(waiting.statuses.includes('manifest actions available'));
  assert.ok(waiting.statuses.includes('anchors hydrate completed'));
  assert.ok(waiting.statuses.includes('action deferred replacement-unavailable'));
  assert.equal(waiting.nativeReads, 0);
  assert.equal(waiting.archives.length, 0);
  const accepted = fixture(); await accepted.run();
  assert.ok(accepted.statuses.includes('archive dispatched'));
  assert.ok(accepted.statuses.includes('archive verified'));
  for (const f of [waiting, accepted]) {
    assert.doesNotMatch(f.statuses.join('\n'), /Same title|Another|cse_|session_|local_|\/project|11111111/);
  }
});

test('diagnostics show a pending anchor read and contain observer failures without changing native work', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const states = [];
  const slow = fixture({ normalizeAnchor: normalizeClaudeLocalFolderAnchor,
    onStatus(code) { states.push(code); } });
  slow.mutateManifest(m => ({ ...m, anchors: [{
    localSessionId: slow.action.localSessionId, nativeId: slow.action.nativeId,
    replacementNativeId: '55555555-5555-4555-8555-555555555555', remoteId: slow.action.remoteId, cwd: '/project' }] }));
  slow.runtime.setRows([{ type: 'bridge', id: 'session_test', title: slow.action.title }], claudeFolderProjectKey);
  slow.beforeNative = read => read === 1 ? pending : undefined;
  slow.runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1), 'anchor session read');
  assert.equal(slow.archives.length, 0);
  release();
  await slow.run();
  assert.ok(states.indexOf('anchor session read') > states.indexOf('anchors hydrate started'));
  assert.ok(states.indexOf('anchors hydrate completed') > states.indexOf('anchor git read'));
  const throwing = fixture({ onStatus() { throw new Error('Observer failure'); } });
  await throwing.run(); assert.equal(throwing.archives.length, 1);
});

test('repeated row observations are rate-bounded and contain no row metadata', () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) f.runtime.setRows([{ type: 'bridge', id: `private-${i}` }]);
  assert.deepEqual(f.statuses, ['rows received bridge-present']);
  f.tick(1000); f.runtime.setRows([]);
  assert.deepEqual(f.statuses, ['rows received bridge-present', 'rows received no-bridge']);
});

function exactReader(f, mutate = () => {}) {
  let reads = 0;
  const fetch = () => { throw new Error('Only the native reader may use authenticated fetch'); };
  const source = { fetch, orgUuid: 'organization-test', allowed: true,
    async read(actualFetch, org, id) {
      assert.equal(actualFetch, fetch); assert.equal(org, source.orgUuid); assert.equal(id, f.action.remoteId);
      const value = { type: 'session', id: 'session_test', title: f.action.title, session_status: 'idle', environment_kind: 'bridge' };
      return await mutate(value, ++reads) ?? value;
    }, normalize: value => value, isBridge: value => value.environment_kind === 'bridge' };
  f.runtime.setReplacementSource(source);
  return { source, reads: () => reads };
}

test('a fresh profile verifies only the intent exact ID twice without requiring a loaded sidebar page', async () => {
  const f = fixture(); f.runtime.setRows([]);
  const reader = exactReader(f);
  await f.run();
  assert.equal(reader.reads(), 2); assert.equal(f.archives.length, 1);
  assert.ok(f.statuses.includes('replacement metadata read completed'));
});

test('configured native metadata never falls back to a matching visible row', async () => {
  for (const [change, reason] of [
    [value => { value.id = 'session_other'; }, 'identity-changed'],
    [value => { value.title = 'Other title'; }, 'title-changed'],
    [value => { value.environment_kind = 'remote'; }, 'type-unverified'],
    [value => { value.session_status = 'archived'; }, 'archived'],
    [() => { throw new Error('private response details'); }, 'native-read-failed'],
  ]) {
    const f = fixture(); exactReader(f, change); await f.run();
    assert.equal(f.archives.length, 0); assert.equal(f.nativeReads, 0);
    assert.ok(f.statuses.includes(`replacement guard ${reason}`));
    assert.doesNotMatch(f.statuses.join('\n'), /private response|Other title|session_/);
  }
  const f = fixture(), reader = exactReader(f);
  f.runtime.setReplacementSource({ ...reader.source, allowed: false });
  await f.run(); assert.equal(reader.reads(), 0); assert.equal(f.archives.length, 0);
  assert.ok(f.statuses.includes('replacement guard native-reader-unavailable'));
});

test('metadata completion cannot outlive its source, intent, or fresh unarchived proof', async () => {
  for (const change of [
    (f, value, count) => { if (count === 2) value.session_status = 'archived'; },
    (f, value, count) => { if (count === 2) f.tick(16000); },
    (f, value, count) => { if (count === 2) f.mutateManifest(m => ({ ...m, actions: [] })); },
    (f, value, count) => { if (count === 1) f.runtime.setReplacementSource({}); },
  ]) {
    const f = fixture(); exactReader(f, (value, count) => change(f, value, count));
    await f.run(); assert.equal(f.archives.length, 0);
  }
});

test('same source render supplies do not invalidate an in-flight native metadata read', async () => {
  const f = fixture(); let reader;
  reader = exactReader(f, () => { f.runtime.setReplacementSource({ ...reader.source }); });
  await f.run(); assert.equal(reader.reads(), 2); assert.equal(f.archives.length, 1);
});

test('an absent exact native session never substitutes a visible same-title row', async () => {
  const f = fixture(), reader = exactReader(f);
  f.runtime.setReplacementSource({ ...reader.source, read: async () => null });
  await f.run(); assert.equal(f.archives.length, 0); assert.equal(f.nativeReads, 0);
  assert.ok(f.statuses.includes('replacement guard native-session-absent'));
});

test('an uncertain native archive is not replayed after exact-ID metadata reads', async () => {
  let calls = 0, task;
  const f = fixture({ setTimer(fn) { task = fn; return fn; },
    native: { async getSession() { return { sessionId: f.action.localSessionId, cwd: f.action.cwd,
      title: f.action.title, lastActivityAt: 4000, isArchived: false, isRunning: false, turnRunning: false }; },
      async getSessionList() { return { sessions: [] }; },
      async getBusyShellPtyKeys() { return { probed: true, busy: [], unknown: [] }; },
      async readFileAtCwd() { return { contents: JSON.stringify({ sessionId: f.action.localSessionId,
        cliSessionId: f.action.nativeId, cwd: f.action.cwd, title: f.action.title, lastActivityAt: 4000, isArchived: false }) }; },
      async archive() { calls++; throw new Error('uncertain archive response'); } } });
  exactReader(f); f.runtime.start();
  for (let i = 0; i < 12 && !task; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); await task(); assert.equal(calls, 1); f.runtime.stop();
});

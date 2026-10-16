import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeDesktopHandoffRuntime } from '../src/claude-desktop-handoff-runtime.mjs';
import { normalizeClaudeLocalFolderAnchor } from '../src/claude-folder-anchor.mjs';
import { claudeFolderProjectKey } from '../src/claude-folder-projection.mjs';
import { createClaudeFolderRuntime } from '../src/claude-folder-runtime.mjs';

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

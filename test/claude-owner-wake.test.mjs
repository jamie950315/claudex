import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, readFile, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { hash } from '../src/storage.mjs';
import { sessionPath } from '../src/claude.mjs';
import { inspectClaudeOwnerWake, publishClaudeFolderMap } from '../src/claude-folder-map.mjs';
import { createClaudeOwnerWakePublisher, handleClaudeOwnerWake, validateClaudeOwnerWakeRequest } from '../src/claude-owner-wake.mjs';
import { SyncEventInbox } from '../src/sync-events.mjs';
import { runDesktopWatch } from '../src/desktop-watch.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-owner-wake-')));
  for (const name of ['project', 'codex', 'claude', 'desktop', 'owners']) await mkdir(join(root, name), { mode: 0o700 });
  const cwd = join(root, 'project'), conversationId = randomUUID(), nativeId = randomUUID(), remoteId = 'cse_synthetic';
  const record = { id: randomUUID(), conversationId, nativeId, side: 'claude', cwd,
    path: sessionPath(join(root, 'claude'), cwd, nativeId), managed: true, verified: true, kind: 'owner', status: 'current' };
  await mkdir(join(record.path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(record.path, 'Synthetic native bytes. Never executed or decoded.', { mode: 0o600 });
  const codexRecord = { id: randomUUID(), conversationId, nativeId: randomUUID(), side: 'codex', cwd,
    path: join(root, 'codex', 'synthetic.jsonl'), managed: true, verified: true, kind: 'snapshot', status: 'current' };
  await writeFile(codexRecord.path, 'Synthetic Codex bytes. Never executed or decoded.', { mode: 0o600 });
  const state = { version: 2, pending: null, conversations: { [conversationId]: { id: conversationId, cwd, title: 'Synthetic owner' } },
    records: [record, codexRecord], audit: [] };
  const saved = { version: 1, conversationId, sessionId: nativeId, remoteId, cwd, claudeHome: join(root, 'claude'),
    registration: 'registered', pending: null, reset: null };
  const ownerPath = join(root, 'owners', `${hash(conversationId)}.json`);
  const save = async () => {
    await writeFile(join(root, 'desktop-state.json'), JSON.stringify(state), { mode: 0o600 });
    await writeFile(ownerPath, JSON.stringify(saved), { mode: 0o600 });
  };
  await writeFile(join(root, 'packet-key'), 'a'.repeat(64) + '\n', { mode: 0o600 });
  await save(); await publishClaudeFolderMap({ root, state });
  const calls = { codex: 0, start: 0, connect: 0, rename: 0, close: 0, settings: [] };
  let clock = 0;
  const runtime = await new DesktopRuntime({ root, codexHome: join(root, 'codex'), claudeHome: join(root, 'claude'),
    desktopHome: join(root, 'desktop'), contextMode: 'archive', claudeOwnerIdleSeconds: 60, now: () => clock,
    clientFactory() { calls.codex++; throw new Error('Shared Codex Desktop backend is not ready.'); },
    ownerFactory(settings) {
      calls.settings.push(settings);
      let closed = false;
      return { async start() { calls.start++; }, async connect() { calls.connect++; },
        async reconcileDisplayTitle() { calls.rename++; }, async close() { calls.close++; closed = true; },
        status: () => ({ sessionId: nativeId, remoteId, nativeState: 'idle', pending: null, reset: null,
          backgroundTasks: [], blocked: null, closed }) };
    } }).initialize();
  const bridge = new DesktopBridge({ root, adapters: runtime.adapters });
  const event = { side: 'claude', nativeId, kind: 'owner-wake', remoteId };
  const handle = extra => handleClaudeOwnerWake({ root, bridge, runtime, event, ...extra });
  return { root, cwd, record, state, saved, ownerPath, save, runtime, bridge, event, handle, calls,
    advance: ms => { clock += ms; } };
}

test('identity-only publisher validates input, authenticates ownership, bounds requests and preserves completion receipts', async () => {
  const f = await fixture(), inbox = await new SyncEventInbox({ root: f.root }).initialize();
  const publish = createClaudeOwnerWakePublisher({ root: f.root, inbox });
  for (const value of [{}, { remoteId: 'session_synthetic' }, { remoteId: 'cse_synthetic', message: 'not permitted' }, { remoteId: 'cse_' + 'x'.repeat(201) }])
    assert.throws(() => validateClaudeOwnerWakeRequest(value), /identity/);
  assert.deepEqual(await publish({ remoteId: 'cse_foreign' }), { accepted: false, reason: 'unpublished Remote Control identity' });
  const completion = await inbox.publish({ side: 'claude', nativeId: f.record.nativeId, kind: 'completed' });
  assert.deepEqual(await publish({ remoteId: f.saved.remoteId }), { accepted: true });
  assert.deepEqual(await publish({ remoteId: f.saved.remoteId }), { accepted: false, reason: 'rate limited' });
  const batch = await inbox.list();
  assert.equal(batch.length, 2); assert.equal(batch.find(event => event.kind === 'completed').revision, completion.revision);
  await inbox.acknowledge(batch.filter(event => event.kind === 'owner-wake'));
  assert.deepEqual(await inbox.list(), [completion]);
  assert.equal(f.calls.start, 0); assert.equal(f.calls.codex, 0);
});

test('a wake requested during another delivery is published and handled once that delivery is over', async () => {
  const f = await fixture(), inbox = await new SyncEventInbox({ root: f.root }).initialize();
  const publish = createClaudeOwnerWakePublisher({ root: f.root, inbox });
  f.state.pending = { operationId: 'synthetic' }; await f.save();
  assert.deepEqual(await publish({ remoteId: f.saved.remoteId }), { accepted: true });
  assert.deepEqual((await inbox.list()).map(event => event.kind), ['owner-wake']);
  // A transaction that is still pending under the coordinator lock is refused.
  assert.equal((await f.handle()).ignored, 'pending transaction'); assert.equal(f.calls.start, 0);
  f.state.pending = null; await f.save();
  assert.deepEqual(await f.handle(), { woken: true, conversationId: f.record.conversationId });
  assert.equal(f.calls.start, 1); assert.equal(f.calls.codex, 0);
});

test('activation starts the same normal owner with no Codex, sync, rename or transcript mutation and refreshes eviction', async () => {
  const f = await fixture(), before = await readFile(f.record.path);
  assert.deepEqual(await f.handle(), { woken: true, conversationId: f.record.conversationId });
  assert.equal(f.calls.start, 1); assert.equal(f.calls.codex, 0); assert.equal(f.calls.rename, 0);
  assert.equal(f.calls.settings[0].deferRemoteConnection, false);
  assert.equal(f.runtime.nextOwnerIdleAt(), 60_000);
  f.advance(45_000); await f.handle();
  assert.equal(f.calls.start, 1); assert.equal(f.runtime.nextOwnerIdleAt(), 105_000);
  f.advance(61_000); assert.deepEqual(await f.runtime.closeIdleOwners(), [f.record.conversationId]);
  assert.deepEqual(await readFile(f.record.path), before);
  assert.deepEqual(await f.bridge.status(), f.state);
});

for (const [name, mutate] of [
  ['pending transaction', f => { f.state.pending = { operationId: 'synthetic' }; }],
  ['stopped tracking', f => { f.state.conversations[f.record.conversationId].tracking = { status: 'stopped', stoppedAt: 1 }; }],
  ['owner block', f => { f.saved.blocked = 'Synthetic native block'; }],
  ['pending append', f => { f.saved.pending = { operationId: 'synthetic' }; }],
  ['pending reset', f => { f.saved.reset = { phase: 'prepared' }; }],
  ['pending title migration', f => { f.saved.displayTitleMigration = { phase: 'sent' }; }],
  ['retired owner', f => { f.record.status = 'retired-owner'; f.record.retiredOwner = true; }],
  ['changed native identity', f => { f.saved.sessionId = randomUUID(); }],
  ['relocation', f => { f.state.conversations[f.record.conversationId].cwd = join(f.root, 'new-project'); }],
  ['missing counterpart', f => { f.state.records.pop(); }],
]) test(`owner activation preserves the ${name} guard`, async () => {
  const f = await fixture(); mutate(f); await f.save();
  assert.ok((await f.handle()).ignored);
  assert.equal(f.calls.start, 0); assert.equal(f.calls.codex, 0);
});

test('owner preflight fences replaced native paths without reading their contents', async () => {
  const f = await fixture();
  const target = await inspectClaudeOwnerWake({ root: f.root, state: f.state, remoteId: f.saved.remoteId });
  await rename(f.record.path, f.record.path + '.preserved');
  await writeFile(f.record.path, 'Different synthetic inode.', { mode: 0o600 });
  await assert.rejects(target.recheck(), /native path changed/);
  assert.equal(f.calls.start, 0);
});

test('owner activation refuses vanished/aliased projects, stale event identities and known watcher blocks', async () => {
  const f = await fixture();
  assert.ok((await f.handle({ event: { ...f.event, nativeId: randomUUID() } })).ignored);
  assert.ok((await f.handle({ blocked: { reason: 'Synthetic coordinator guard' } })).ignored);
  assert.ok((await f.handle({ blockedConversations: new Map([[f.record.conversationId, { reason: 'Synthetic conflict' }]]) })).ignored);
  await rename(f.cwd, join(f.root, 'moved-project'));
  assert.ok((await f.handle()).ignored);
  await symlink(join(f.root, 'moved-project'), f.cwd);
  assert.ok((await f.handle()).ignored);
  assert.equal(f.calls.start, 0);
});

test('app-stop hold refuses both event publication and already queued activation', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'app-stop.json'), JSON.stringify({ version: 1, stopped: true }), { mode: 0o600 });
  const publish = createClaudeOwnerWakePublisher({ root: f.root });
  assert.deepEqual(await publish({ remoteId: f.saved.remoteId }), { accepted: false, reason: 'application stopped' });
  assert.deepEqual(await f.handle(), { ignored: 'application stopped' });
  assert.equal(f.calls.start, 0);
});

test('watcher handles a wake before its unavailable Codex prerequisite without sync or recovery', async () => {
  const f = await fixture(), statuses = [], acknowledged = [];
  f.bridge.sync = f.bridge.recover = f.bridge.collect = () => { throw new Error('Wake must never sync, recover or collect.'); };
  let waits = 0;
  const stop = new AbortController();
  await runDesktopWatch({ root: f.root, bridge: f.bridge, runtime: f.runtime, config: {}, signal: stop.signal,
    discover() { throw new Error('No discovery while Codex is unavailable.'); },
    writeStatus: async (_path, value) => statuses.push(structuredClone(value)),
    events: { metrics: {}, observe: async () => {}, acknowledge: async batch => acknowledged.push(batch),
      wait: async () => { if (waits++ === 0) return [f.event]; stop.abort(); return []; } } });
  assert.equal(f.calls.codex, 1); assert.equal(f.calls.start, 1);
  assert.deepEqual(acknowledged, [[f.event]]);
  const active = statuses.filter(value => value.running).at(-1);
  assert.equal(active.ownerWake.woken, 1); assert.equal(active.eventSyncCount, 0);
  assert.match(active.waiting, /Codex Desktop backend is not ready/);
});

test('broker accepts owner hints only through the Claude controller and rejects content and workers', async t => {
  const f = await fixture();
  const hub = await new CollaborationHub({ root: join(f.root, 'collaboration'), claudeOwnerWake: createClaudeOwnerWakePublisher({ root: f.root }),
    run: () => { throw new Error('No inference in synthetic tests.'); } }).initialize();
  t.after(() => hub.close());
  const request = (params, peer = 'claude', token = hub.controllerToken) => hub.dispatch({ peer, token, method: 'desktop_owner_wake', params });
  await assert.rejects(request({ remoteId: f.saved.remoteId }, 'codex'), /unavailable/);
  await assert.rejects(request({ remoteId: f.saved.remoteId, message: 'forbidden' }), /identity/);
  const token = 'b'.repeat(64);
  await hub.mutate(state => { state.tasks.synthetic = { id: 'synthetic', owner: 'claude', status: 'running',
    active: { generation: 1, tokenHash: createHash('sha256').update(token).digest('hex') } }; });
  await assert.rejects(request({ remoteId: f.saved.remoteId }, 'claude', token), /unavailable/);
  assert.deepEqual(await request({ remoteId: f.saved.remoteId }), { accepted: true });
  assert.equal(f.calls.start, 0);
});

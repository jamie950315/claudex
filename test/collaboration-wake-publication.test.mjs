import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { ChatMailbox } from '../src/chat-mailbox.mjs';
import { createClaudeChatWakeManifest } from '../src/claude-chat-wake-manifest.mjs';
import { writeJSON } from '../src/storage.mjs';

async function fixture(t, { ttl = 1000, manifest } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'cwp-'))); await chmod(parent, 0o700);
  const root = join(parent, 'collaboration');
  const mailbox = new ChatMailbox({ root: join(root, 'chat-mailbox') });
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: parent, event: 'SessionStart' });
  await mailbox.send({ fromProvider: 'codex', targetProvider: 'claude', targetSessionId: 'target',
    message: 'Synthetic peer note', requestId: 'fixture', wakeRequested: true, wakeRoute: 'renderer', expiresInMs: ttl });
  const publisher = manifest ?? createClaudeChatWakeManifest({ root, mappings: async () => new Map([['target',
    { sessionId: 'local_target', cwd: parent, title: 'Synthetic target', registryPath: join(parent, 'mapping.json') }]]) });
  const hub = await new CollaborationHub({ root, claudeWakeManifest: publisher,
    run: async () => assert.fail('No inference') }).initialize(); hub.schedule = () => {};
  t.after(async () => { await hub.close(); await rm(parent, { recursive: true, force: true }); });
  return { root, parent, hub };
}
async function settle(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(done => setImmediate(done)); }
  assert.fail('Metadata publication did not settle');
}

test('startup republishes queued renderer work and its expiry republishes an empty manifest', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await fixture(t);
  assert.equal(f.hub.claudeWakePublication.total, 1);
  assert.equal(f.hub.claudeWakePublication.count, 1);
  t.mock.timers.tick(1001);
  await f.hub.claudeWakePublishing;
  assert.equal(f.hub.claudeWakePublication.total, 0);
  assert.equal(f.hub.claudeWakePublication.nextPublicationAt, null);
  const list = await f.hub.dispatch({ peer: 'codex', token: f.hub.controllerToken, method: 'list', params: {} });
  assert.equal(list.rendererWakeManifest.total, 0);
  assert.equal(f.hub.running.size, 0);
});

test('bounded rotation timer republishes metadata once per interval and close clears it', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let calls = 0;
  const f = await fixture(t, { manifest: { publish: async (_mailbox, { beforePublish }) => {
    await beforePublish(); calls++;
    return { count: 64, total: 65, omitted: 1, nextPublicationAt: Date.now() + 5000 };
  } } });
  assert.equal(calls, 1); t.mock.timers.tick(5000);
  await settle(() => calls === 2);
  await f.hub.claudeWakePublishing;
  await f.hub.close(); t.mock.timers.tick(10000);
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 2); assert.equal(f.hub.claudeWakeTimer, null);
});

test('app-stop fences a metadata publication already awaiting native mapping', async t => {
  let release, calls = 0, writes = 0;
  const f = await fixture(t, { manifest: { publish: async (_mailbox, { beforePublish }) => {
    calls++;
    if (calls > 1) await new Promise(done => { release = done; });
    await beforePublish(); writes++;
    return { count: 1, total: 1, omitted: 0, nextPublicationAt: null };
  } } });
  const publishing = f.hub.refreshClaudeWakeManifest();
  await settle(() => Boolean(release));
  await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: true, at: Date.now() });
  release(); await publishing;
  assert.equal(writes, 1);
  assert.equal(f.hub.claudeWakePublication.state, 'held');
  assert.equal(f.hub.claudeWakeTimer, null);
});

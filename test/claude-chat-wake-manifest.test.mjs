import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatMailbox } from '../src/chat-mailbox.mjs';
import { createClaudeChatWakeManifest } from '../src/claude-chat-wake-manifest.mjs';

const syntheticMailbox = pending => ({ pendingWakes: async () => [...pending()],
  transaction: async (_create, operation) => operation({ messages: pending().map(message => ({ ...message,
    state: 'queued', targetProvider: 'claude', wakeRequested: true })) }) });

test('manifest exposes exact native metadata only for explicit queued Claude wake requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-wake-manifest-'));
  const mailbox = new ChatMailbox({ root: join(root, 'chat-mailbox') });
  const native = new Map();
  for (const sessionId of ['ready', 'archived', 'no-wake', 'legacy', 'offered', 'missing']) {
    await mailbox.register({ provider: 'claude', sessionId, cwd: root, event: 'SessionStart' });
    if (sessionId !== 'missing') native.set(sessionId, { sessionId: `local_${sessionId}`, cwd: root, title: `Title ${sessionId}`,
      registryPath: join(root, `${sessionId}.json`), isArchived: sessionId === 'archived' });
  }
  const sent = {};
  for (const sessionId of native.keys()) sent[sessionId] = await mailbox.send({ fromProvider: 'codex', targetProvider: 'claude',
    targetSessionId: sessionId, message: 'PRIVATE PEER MESSAGE NOT FOR MANIFEST', requestId: sessionId,
    ...(sessionId === 'legacy' ? {} : { wakeRequested: sessionId !== 'no-wake' }) });
  await mailbox.send({ fromProvider: 'codex', targetProvider: 'claude', targetSessionId: 'missing', message: 'missing target metadata', requestId: 'missing', wakeRequested: true });
  await mailbox.claimWake(sent.offered.messageId);
  await mailbox.register({ provider: 'codex', sessionId: 'codex-target', cwd: root, event: 'SessionStart' });
  await mailbox.send({ fromProvider: 'claude', targetProvider: 'codex', targetSessionId: 'codex-target', message: 'Codex excluded', requestId: 'codex', wakeRequested: true });
  const manifest = createClaudeChatWakeManifest({ root, mappings: async () => native });
  const published = await manifest.publish(mailbox);
  assert.equal(published.count, 1);
  assert.equal(published.total, 3); assert.equal(published.eligible, 1);
  assert.equal(published.omitted, 2); assert.equal(published.unavailable, 2);
  const path = join(root, 'chat-mailbox', 'wake-manifest.json');
  const bytes = await readFile(path, 'utf8');
  assert.equal(bytes.includes('PRIVATE PEER'), false);
  assert.deepEqual(JSON.parse(bytes).messages, [{ messageId: sent.ready.messageId, sessionId: 'ready',
    expiresAt: sent.ready.expiresAt, localSessionId: 'local_ready', cwd: root, title: 'Title ready', registryPath: join(root, 'ready.json') }]);
  assert.equal(published.bytes, Buffer.byteLength(bytes));
  assert.deepEqual(manifest.diagnostics(), published);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await manifest.verify('ready')).localSessionId, 'local_ready');
  await assert.rejects(manifest.verify('missing'), /unavailable/);
  await assert.rejects(manifest.verify('archived'), /archived/);
});

test('manifest bounds published identities and removes claimed candidates on republish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-wake-bounds-'));
  const pending = Array.from({ length: 70 }, (_, index) => ({ messageId: `m${index}`, targetSessionId: `s${index}`, expiresAt: 9000 }));
  const mappings = new Map(pending.map(message => [message.targetSessionId, { sessionId: `local_${message.targetSessionId}`, cwd: root,
    title: message.targetSessionId, registryPath: join(root, `${message.targetSessionId}.json`) }]));
  const manifest = createClaudeChatWakeManifest({ root, mappings: async () => mappings, now: () => 1000 });
  const first = await manifest.publish(syntheticMailbox(() => pending));
  assert.equal(first.count, 64); assert.equal(first.total, 70); assert.equal(first.omitted, 6);
  assert.equal(first.nextPublicationAt, 6000);
  const path = join(root, 'chat-mailbox', 'wake-manifest.json');
  const firstIds = JSON.parse(await readFile(path, 'utf8')).messages.map(message => message.messageId);
  await manifest.publish(syntheticMailbox(() => pending));
  const secondIds = JSON.parse(await readFile(path, 'utf8')).messages.map(message => message.messageId);
  assert.equal(secondIds[0], 'm64');
  assert.equal(new Set([...firstIds, ...secondIds]).size, 70);
  assert.equal((await manifest.publish(syntheticMailbox(() => []))).count, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'chat-mailbox', 'wake-manifest.json'), 'utf8')).messages, []);
});

test('overlapping publication cannot replace newly queued wake messages with an older snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-wake-concurrent-'));
  const first = { messageId: 'first-message', targetSessionId: 'first', expiresAt: 9000 };
  const second = { messageId: 'second-message', targetSessionId: 'second', expiresAt: 9000 };
  let pending = [first], release, inspected;
  const gate = new Promise(resolve => { release = resolve; });
  const inspecting = new Promise(resolve => { inspected = resolve; });
  let calls = 0;
  const manifest = createClaudeChatWakeManifest({ root, now: () => 1000, mappings: async () => {
    if (++calls === 1) { inspected(); await gate; }
    return new Map([first, second].map(message => [message.targetSessionId, {
      sessionId: `local_${message.targetSessionId}`, cwd: root, title: message.targetSessionId,
      registryPath: join(root, `${message.targetSessionId}.json`), isArchived: false,
    }]));
  } });
  const mailbox = syntheticMailbox(() => pending);
  const old = manifest.publish(mailbox);
  await inspecting;
  pending = [first, second];
  const fresh = manifest.publish(mailbox);
  // Allow a competing publication to finish first if publication is not serialized.
  await Promise.race([fresh, new Promise(resolve => setTimeout(resolve, 50))]);
  release();
  await Promise.all([old, fresh]);
  const saved = JSON.parse(await readFile(join(root, 'chat-mailbox', 'wake-manifest.json'), 'utf8'));
  assert.deepEqual(saved.messages.map(message => message.messageId).sort(), [first.messageId, second.messageId].sort());
});

test('an awaited metadata snapshot cannot republish a recipient after its message was acknowledged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-wake-retire-'));
  const mailbox = new ChatMailbox({ root: join(root, 'chat-mailbox') });
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: root, event: 'SessionStart' });
  const sent = await mailbox.send({ fromProvider: 'codex', targetProvider: 'claude', targetSessionId: 'target',
    message: 'Synthetic wake', requestId: 'wake', wakeRequested: true });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  const manifest = createClaudeChatWakeManifest({ root, mappings: async () => {
    entered(); await gate;
    return new Map([['target', { sessionId: 'local_target', cwd: root, title: 'Synthetic target', registryPath: join(root, 'target.json') }]]);
  } });
  const publishing = manifest.publish(mailbox); await reading;
  await mailbox.consume({ provider: 'claude', sessionId: 'target', event: 'Stop' });
  await mailbox.consume({ provider: 'claude', sessionId: 'target', event: 'Stop', stopHookActive: true,
    lastAssistantMessage: `CLAUDEX_ACK:${sent.messageId}` });
  release(); assert.equal((await publishing).count, 0);
  assert.deepEqual(JSON.parse(await readFile(join(mailbox.root, 'wake-manifest.json'), 'utf8')).messages, []);
});

test('actual serialized byte bounds rotate large escaped metadata without starving later entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-wake-byte-bounds-'));
  const pending = Array.from({ length: 70 }, (_, index) => ({ messageId: `m${index}`, targetSessionId: `s${index}`, expiresAt: 9000 }));
  const mappings = new Map(pending.map(message => [message.targetSessionId, { sessionId: `local_${message.targetSessionId}`, cwd: root,
    title: message.targetSessionId === 's69' ? 'small later candidate' : '"'.repeat(4096),
    registryPath: join(root, `${message.targetSessionId}.json`) }]));
  const manifest = createClaudeChatWakeManifest({ root, mappings: async () => mappings, now: () => 1000 });
  const seen = new Set();
  for (let page = 0; page < 3; page++) {
    const result = await manifest.publish(syntheticMailbox(() => pending));
    const bytes = await readFile(join(root, 'chat-mailbox', 'wake-manifest.json'), 'utf8');
    const saved = JSON.parse(bytes);
    assert.ok(result.count < 64); assert.equal(result.count, saved.messages.length);
    assert.equal(result.omitted, 70 - result.count); assert.equal(saved.omitted, result.omitted);
    assert.equal(result.bytes, Buffer.byteLength(bytes)); assert.ok(result.bytes <= 240 * 1024);
    assert.equal(result.byteLimit, 240 * 1024);
    saved.messages.forEach(message => seen.add(message.messageId));
  }
  assert.equal(seen.size, 70);
});

test('expiry after a metadata await removes the stale page and reports the next expiry even without overflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-wake-expiry-'));
  let at = 1000;
  const pending = [{ messageId: 'expiring', targetSessionId: 'target', expiresAt: 1500 }];
  const entry = new Map([['target', { sessionId: 'local_target', cwd: root, title: 'Target', registryPath: join(root, 'target.json') }]]);
  const manifest = createClaudeChatWakeManifest({ root, now: () => at, mappings: async () => entry });
  assert.equal((await manifest.publish(syntheticMailbox(() => pending))).nextPublicationAt, 1500);
  at = 1500;
  const result = await manifest.publish(syntheticMailbox(() => pending));
  assert.equal(result.count, 0); assert.equal(result.total, 0); assert.equal(result.nextPublicationAt, null);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'chat-mailbox', 'wake-manifest.json'), 'utf8')).messages, []);
});

test('publication lifecycle fence runs after metadata reads without advancing the fair page on refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-wake-fence-'));
  const pending = Array.from({ length: 70 }, (_, index) => ({ messageId: `m${index}`, targetSessionId: `s${index}`, expiresAt: 9000 }));
  const mappings = new Map(pending.map(message => [message.targetSessionId, { sessionId: `local_${message.targetSessionId}`, cwd: root,
    title: message.targetSessionId, registryPath: join(root, `${message.targetSessionId}.json`) }]));
  const manifest = createClaudeChatWakeManifest({ root, mappings: async () => mappings, now: () => 1000 });
  const mailbox = syntheticMailbox(() => pending);
  await manifest.publish(mailbox);
  const path = join(root, 'chat-mailbox', 'wake-manifest.json'), before = await readFile(path, 'utf8');
  await assert.rejects(manifest.publish(mailbox, { beforePublish: () => { throw new Error('Stopped'); } }), /Stopped/);
  assert.equal(await readFile(path, 'utf8'), before);
  await manifest.publish(mailbox);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).messages[0].messageId, 'm64');
});

test('captured Mod routes stay out of renderer publication and absent legacy routes retain renderer semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-wake-captured-route-'));
  const pending = [undefined, 'renderer', 'mod', 'mod-self'].map((wakeRoute, index) => ({
    messageId: `m${index}`, targetSessionId: `s${index}`, expiresAt: 9000, ...(wakeRoute ? { wakeRoute } : {}),
  }));
  const mappings = new Map(pending.map(message => [message.targetSessionId, { sessionId: `local_${message.targetSessionId}`, cwd: root,
    title: message.targetSessionId, registryPath: join(root, `${message.targetSessionId}.json`) }]));
  const manifest = createClaudeChatWakeManifest({ root, mappings: async () => mappings, now: () => 1000 });
  assert.equal((await manifest.publish(syntheticMailbox(() => pending))).total, 2);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'chat-mailbox', 'wake-manifest.json'), 'utf8')).messages.map(message => message.messageId), ['m0', 'm1']);
});

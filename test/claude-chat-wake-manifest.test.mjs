import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatMailbox } from '../src/chat-mailbox.mjs';
import { createClaudeChatWakeManifest } from '../src/claude-chat-wake-manifest.mjs';

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
  assert.deepEqual(await manifest.publish(mailbox), { count: 1 });
  const path = join(root, 'chat-mailbox', 'wake-manifest.json');
  const bytes = await readFile(path, 'utf8');
  assert.equal(bytes.includes('PRIVATE PEER'), false);
  assert.deepEqual(JSON.parse(bytes), { version: 1, messages: [{ messageId: sent.ready.messageId, sessionId: 'ready',
    expiresAt: sent.ready.expiresAt, localSessionId: 'local_ready', cwd: root, title: 'Title ready', registryPath: join(root, 'ready.json') }] });
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
  const manifest = createClaudeChatWakeManifest({ root, mappings: async () => mappings });
  assert.equal((await manifest.publish({ pendingWakes: async () => pending })).count, 64);
  assert.equal((await manifest.publish({ pendingWakes: async () => [] })).count, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'chat-mailbox', 'wake-manifest.json'), 'utf8')).messages, []);
});

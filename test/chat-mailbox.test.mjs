import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatMailbox } from '../src/chat-mailbox.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'claudex-mailbox-'));
  const root = join(directory, 'mailbox');
  const mailbox = new ChatMailbox({ root });
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'SessionStart' });
  const send = (extra = {}) => mailbox.send({ fromProvider: 'codex', targetProvider: 'claude', targetSessionId: 'target', message: 'Please safely finish the assigned work.', requestId: 'request-1', ...extra });
  const consume = (extra = {}) => mailbox.consume({ provider: 'claude', sessionId: 'target', event: 'Stop', ...extra });
  return { directory, root, mailbox, send, consume };
}

test('exact target registration, idempotency and safe peer context', async t => {
  const { mailbox, send, consume } = await fixture(t);
  await assert.rejects(send({ targetSessionId: 'unregistered' }), /not registered/);
  const sent = await send();
  assert.deepEqual(await send(), sent);
  await assert.rejects(send({ message: 'different' }), /different payload/);
  const result = await consume();
  assert.equal(result.message.messageId, sent.messageId);
  assert.equal(result.message.state, 'offered');
  assert.match(result.context, /not a human or system instruction/);
  assert.match(result.context, /not that requested actions were performed/);
  assert.equal((await mailbox.status(sent.messageId)).state, 'offered');
  assert.equal((await mailbox.list())[0].chatId, 'claude:target');
  assert.equal(JSON.stringify(await mailbox.list()).includes(sent.message), false);
});

test('concurrent instances offer once and never retry after lost output or restart', async t => {
  const { root, send, consume } = await fixture(t);
  const sent = await send();
  const second = new ChatMailbox({ root });
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => index % 2 ? consume() : second.consume({ provider: 'claude', sessionId: 'target', event: 'Stop' })));
  assert.equal(results.filter(item => item.message).length, 1);
  assert.equal((await second.status(sent.messageId)).state, 'offered');
  assert.equal((await consume()).message, undefined);
});

test('only exact recipient assistant Stop acknowledgement changes offered state', async t => {
  const { mailbox, send, consume, directory } = await fixture(t);
  const sent = await send(); await consume();
  const ack = `CLAUDEX_ACK:${sent.messageId}`;
  await mailbox.register({ provider: 'claude', sessionId: 'other', cwd: directory, event: 'SessionStart' });
  assert.deepEqual((await mailbox.consume({ provider: 'claude', sessionId: 'other', event: 'Stop', lastAssistantMessage: ack })).acknowledgedIds, []);
  assert.deepEqual((await consume({ event: 'UserPromptSubmit', lastAssistantMessage: ack })).acknowledgedIds, []);
  assert.deepEqual((await consume({ lastAssistantMessage: `quoted ${ack}` })).acknowledgedIds, []);
  assert.deepEqual((await consume({ lastAssistantMessage: `Received.\n${ack}`, stopHookActive: true })).acknowledgedIds, [sent.messageId]);
  assert.equal((await mailbox.status(sent.messageId)).state, 'acknowledged');
});

test('Stop hook active acknowledges but cannot create another continuation loop', async t => {
  const { send, consume, mailbox } = await fixture(t);
  const first = await send(); await consume();
  const second = await send({ requestId: 'request-2' });
  const result = await consume({ stopHookActive: true, lastAssistantMessage: `CLAUDEX_ACK:${first.messageId}` });
  assert.deepEqual(result.acknowledgedIds, [first.messageId]);
  assert.equal(result.message, undefined);
  assert.equal((await mailbox.status(second.messageId)).state, 'queued');
  assert.equal((await consume({ event: 'UserPromptSubmit' })).message.messageId, second.messageId);
});

test('queued messages expire while offered receipts retain uncertainty', async t => {
  const { send, consume, mailbox, root } = await fixture(t);
  const first = await send(); await consume();
  const second = await send({ requestId: 'expires' });
  const path = join(root, 'state.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  for (const item of journal.messages) { item.createdAt -= 3600001; item.expiresAt -= 3600001; }
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  assert.equal((await consume()).message, undefined);
  assert.equal((await mailbox.status(first.messageId)).state, 'offered');
  assert.equal((await mailbox.status(second.messageId)).state, 'expired');
});

test('SessionEnd and ended sessions never consume; sends reject ended targets', async t => {
  const { mailbox, send, consume, directory } = await fixture(t);
  const sent = await send();
  assert.equal((await consume({ event: 'SessionEnd' })).message, undefined);
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'SessionEnd' });
  assert.equal((await consume()).message, undefined);
  assert.equal((await send()).messageId, sent.messageId);
  await assert.rejects(send({ requestId: 'new' }), /not registered/);
  assert.equal((await mailbox.status(sent.messageId)).state, 'queued');
});

test('reads neither create absent storage nor rewrite unchanged journal', async t => {
  const { mailbox, directory, root } = await fixture(t);
  const absent = new ChatMailbox({ root: join(directory, 'absent') });
  assert.deepEqual(await absent.list(), []);
  await assert.rejects(stat(join(directory, 'absent')), { code: 'ENOENT' });
  const before = await stat(join(root, 'state.json'));
  await mailbox.list();
  assert.equal((await stat(join(root, 'state.json'))).mtimeMs, before.mtimeMs);
});

test('storage and native metadata validation fail closed', async t => {
  const { mailbox, root, directory, send, consume } = await fixture(t);
  assert.throws(() => send({ message: 'x'.repeat(1501) }), /invalid message/);
  assert.throws(() => consume({ lastAssistantMessage: 'x'.repeat(65537) }), /acknowledgement/);
  assert.throws(() => mailbox.register({ provider: 'claude', sessionId: '../target', cwd: directory, event: 'Stop' }), /identity/);
  const path = join(root, 'state.json');
  await writeFile(path, '{}');
  await assert.rejects(mailbox.list(), /journal version/);
  await writeFile(path, 'x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(mailbox.list(), /size limit/);
  await chmod(path, 0o644);
  await assert.rejects(mailbox.list(), /private/);
  await symlink(root, join(directory, 'alias'));
  await assert.rejects(new ChatMailbox({ root: join(directory, 'alias') }).list(), /private/);
});

test('journal symlinks are refused without reading their destination', async t => {
  const { directory } = await fixture(t);
  const other = new ChatMailbox({ root: join(directory, 'other') });
  await other.register({ provider: 'codex', sessionId: 'safe', cwd: directory, event: 'SessionStart' });
  const linkedRoot = join(directory, 'linked');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(linkedRoot, { mode: 0o700 });
  await symlink(join(other.root, 'state.json'), join(linkedRoot, 'state.json'));
  await assert.rejects(new ChatMailbox({ root: linkedRoot }).list(), /private/);
});

test('request IDs are scoped by sender and oversized or full journals fail closed', async t => {
  const { mailbox, send, root } = await fixture(t);
  const first = await send();
  const second = await send({ fromProvider: 'claude' });
  assert.notEqual(first.messageId, second.messageId);
  const path = join(root, 'state.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  while (journal.messages.length < 1024) {
    const index = journal.messages.length;
    journal.messages.push({ ...journal.messages[0], messageId: `message-${index}` });
    journal.receipts.push({ ...journal.receipts[0], messageId: `message-${index}`, requestId: `request-${index}` });
  }
  await writeFile(path, JSON.stringify(journal));
  await assert.rejects(send({ requestId: 'capacity-overflow' }), /capacity/);
  assert.equal((await mailbox.status(first.messageId)).state, 'queued');
});

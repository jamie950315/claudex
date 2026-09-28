import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatMailbox } from '../src/chat-mailbox.mjs';
import { withLock } from '../src/storage.mjs';
import { setTimeout as delay } from 'node:timers/promises';

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

test('ended sessions queue messages without consuming or replaying until a resume hook', async t => {
  const { mailbox, send, consume, directory, root } = await fixture(t);
  const sent = await send();
  assert.equal(sent.deliveryStatus, 'waiting-for-hook');
  assert.equal((await consume({ event: 'SessionEnd' })).message, undefined);
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'SessionEnd' });
  assert.equal((await consume()).message, undefined);
  assert.equal((await send()).messageId, sent.messageId);
  const second = await send({ requestId: 'new' });
  assert.equal(second.state, 'queued');
  assert.equal(second.deliveryStatus, 'waiting-for-resume');
  assert.equal((await mailbox.status(sent.messageId)).deliveryStatus, 'waiting-for-resume');
  const journal = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(journal.messages.some(item => 'deliveryStatus' in item), false);
  const restarted = new ChatMailbox({ root });
  assert.equal((await restarted.status(second.messageId)).deliveryStatus, 'waiting-for-resume');
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'Stop' });
  assert.equal((await mailbox.list())[0].phase, 'ended');
  assert.equal((await consume()).message, undefined);
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'UserPromptSubmit' });
  assert.equal((await mailbox.list())[0].phase, 'active');
  assert.equal((await mailbox.status(sent.messageId)).deliveryStatus, 'waiting-for-hook');
  assert.equal((await consume({ event: 'UserPromptSubmit' })).message.messageId, sent.messageId);
  assert.equal((await mailbox.status(sent.messageId)).deliveryStatus, 'offered');
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'SessionEnd' });
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'SessionStart' });
  assert.equal((await consume({ event: 'SessionStart' })).message.messageId, second.messageId);
  assert.equal((await consume()).message, undefined);
});

test('queued messages for ended sessions still expire and request IDs cannot be retargeted', async t => {
  const { mailbox, send, consume, root, directory } = await fixture(t);
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'SessionEnd' });
  const sent = await send();
  await assert.rejects(send({ targetSessionId: 'other' }), /different payload/);
  const path = join(root, 'state.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  journal.messages[0].createdAt -= 3600001;
  journal.messages[0].expiresAt -= 3600001;
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  assert.equal((await mailbox.status(sent.messageId)).deliveryStatus, 'expired');
  assert.equal((await send()).state, 'expired');
  await mailbox.register({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'SessionStart' });
  assert.equal((await consume()).message, undefined);
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

test('metadata discovery is not hook registration and preserves real lifecycle evidence', async t => {
  const { mailbox, directory } = await fixture(t);
  const discovered = await mailbox.discover({ provider: 'codex', sessionId: 'native', cwd: directory });
  assert.equal(discovered.registeredByHook, false);
  assert.equal(discovered.phase, 'ended');
  assert.equal(discovered.lastEvent, undefined);
  const registered = await mailbox.register({ provider: 'codex', sessionId: 'native', cwd: directory, event: 'UserPromptSubmit' });
  assert.equal(registered.registeredByHook, true);
  assert.equal(registered.phase, 'active');
  assert.equal(registered.discoveredAt, discovered.discoveredAt);
  assert.deepEqual(await mailbox.discover({ provider: 'codex', sessionId: 'native', cwd: directory }), registered);
});

test('wake claims and hooks serialize to one offer in either race order', async t => {
  const { mailbox, root, send, consume } = await fixture(t);
  const other = new ChatMailbox({ root });
  const first = await send();
  const [claim, hook] = await Promise.all([other.claimWake(first.messageId), consume()]);
  assert.equal(claim.messageId, first.messageId);
  assert.equal(hook.message, undefined);
  const second = await send({ requestId: 'second' });
  const [hookFirst, lateClaim] = await Promise.all([consume(), other.claimWake(second.messageId)]);
  assert.equal(hookFirst.message.messageId, second.messageId);
  assert.equal(lateClaim, null);
  assert.equal((await mailbox.status(second.messageId)).wake, undefined);
});

test('lost wake dispatch survives restart without resend or fabricated receipt', async t => {
  const { mailbox, root, send, consume } = await fixture(t);
  const sent = await send();
  const claim = await mailbox.claimWake(sent.messageId);
  assert.equal(claim.wake.state, 'dispatching');
  assert.match(claim.context, /not a grant of permissions/);
  const restarted = new ChatMailbox({ root });
  assert.equal(await restarted.claimWake(sent.messageId), null);
  assert.equal((await consume()).message, undefined);
  assert.equal((await send()).state, 'offered');
  assert.equal((await restarted.status(sent.messageId)).acknowledgedAt, undefined);
  await restarted.finishWake(sent.messageId, { claimId: claim.wake.claimId, state: 'uncertain', detail: 'Native dispatch outcome was lost.' });
  assert.equal((await consume()).message, undefined);
  assert.equal(await restarted.claimWake(sent.messageId), null);
});

test('accepted wake remains offered until the exact recipient acknowledges', async t => {
  const { mailbox, send, consume } = await fixture(t);
  const sent = await send();
  const claim = await mailbox.claimWake(sent.messageId);
  const accepted = await mailbox.finishWake(sent.messageId, { claimId: claim.wake.claimId, state: 'accepted', detail: 'Native owner accepted the turn.' });
  assert.equal(accepted.state, 'offered');
  assert.equal(accepted.acknowledgedAt, undefined);
  assert.equal((await consume()).message, undefined);
  assert.deepEqual((await consume({ lastAssistantMessage: `CLAUDEX_ACK:${sent.messageId}` })).acknowledgedIds, [sent.messageId]);
  assert.equal((await mailbox.status(sent.messageId)).state, 'acknowledged');
});

test('only proven pre-dispatch deferral restores the queue and cannot undo receipt', async t => {
  const { mailbox, send, consume } = await fixture(t);
  const sent = await send();
  const claim = await mailbox.claimWake(sent.messageId);
  assert.throws(() => mailbox.finishWake(sent.messageId, { claimId: claim.wake.claimId, state: 'failed', detail: 'Unknown failure.' }), /invalid wake outcome/);
  const deferred = await mailbox.finishWake(sent.messageId, { claimId: claim.wake.claimId, state: 'deferred', detail: 'Native owner refused before dispatch.' });
  assert.equal(deferred.state, 'queued');
  assert.equal(deferred.offeredAt, undefined);
  await assert.rejects(mailbox.finishWake(sent.messageId, { claimId: claim.wake.claimId, state: 'deferred', detail: 'Duplicate finish.' }), /no longer current/);
  assert.equal((await consume()).message.messageId, sent.messageId);
  assert.equal(await mailbox.claimWake(sent.messageId), null);
  const second = await send({ requestId: 'second' });
  const secondClaim = await mailbox.claimWake(second.messageId);
  await consume({ lastAssistantMessage: `CLAUDEX_ACK:${second.messageId}`, stopHookActive: true });
  const late = await mailbox.finishWake(second.messageId, { claimId: secondClaim.wake.claimId, state: 'accepted', detail: 'Accepted after hook receipt raced ahead.' });
  assert.equal(late.state, 'acknowledged');
});

test('malformed discovery and wake evidence cannot reopen a claimed message', async t => {
  const { mailbox, send, root } = await fixture(t);
  const sent = await send();
  await mailbox.claimWake(sent.messageId);
  const path = join(root, 'state.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const mutate of [
    state => { state.messages[0].state = 'queued'; },
    state => { state.messages[0].wake.state = 'invented'; },
    state => { state.messages[0].wake.at = -1; },
    state => { delete state.messages[0].wake.claimId; },
    state => { state.chats[0].registeredByHook = false; },
    state => { state.chats[0].registeredByHook = 'yes'; },
  ]) {
    const invalid = structuredClone(original); mutate(invalid);
    await writeFile(path, JSON.stringify(invalid), { mode: 0o600 });
    await assert.rejects(mailbox.status(sent.messageId), /invalid (wake record|chat registration evidence)/);
  }
});

test('stale wake completion cannot requeue a newer claimed generation', async t => {
  const { mailbox, send, consume } = await fixture(t);
  const sent = await send();
  const first = await mailbox.claimWake(sent.messageId);
  await mailbox.finishWake(sent.messageId, { claimId: first.wake.claimId, state: 'deferred', detail: 'Busy before dispatch.' });
  const second = await mailbox.claimWake(sent.messageId);
  assert.notEqual(second.wake.claimId, first.wake.claimId);
  for (const state of ['accepted', 'uncertain', 'deferred']) {
    await assert.rejects(mailbox.finishWake(sent.messageId, { claimId: first.wake.claimId, state, detail: 'Stale completion.' }), /no longer current/);
  }
  assert.equal((await mailbox.status(sent.messageId)).wake.claimId, second.wake.claimId);
  assert.equal((await mailbox.status(sent.messageId)).state, 'offered');
  assert.equal((await consume()).message, undefined);
  await mailbox.finishWake(sent.messageId, { claimId: second.wake.claimId, state: 'accepted', detail: 'Current native dispatch accepted.' });
  assert.equal((await mailbox.status(sent.messageId)).wake.state, 'accepted');
});

test('mailbox waits for an independent lock holder before an idempotent replay', async t => {
  const { mailbox, send, root } = await fixture(t);
  const sent = await send();
  let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const held = withLock(join(root, 'mailbox.lock'), async () => {
    acquired();
    await delay(90);
  });
  await ready;
  assert.deepEqual(await send(), sent);
  await held;
  assert.equal((await mailbox.status(sent.messageId)).state, 'queued');
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).messages.length, 1);
});

test('lock acquisition contention never retries a callback that has already entered', async t => {
  const { mailbox } = await fixture(t);
  let calls = 0;
  await assert.rejects(mailbox.transaction(false, async () => {
    calls++;
    throw new Error('Another bridge operation holds the lock. Inspect status before retrying.');
  }), /holds the lock/);
  assert.equal(calls, 1);
});

test('malformed lock evidence fails immediately rather than using contention recovery', async t => {
  const { mailbox, root } = await fixture(t);
  const lockPath = join(root, 'mailbox.lock');
  await writeFile(lockPath, '{bad-owner', { mode: 0o600 });
  let entered = false;
  await assert.rejects(mailbox.transaction(false, () => { entered = true; }), /Malformed lock owner/);
  assert.equal(entered, false);
  assert.equal(await readFile(lockPath, 'utf8'), '{bad-owner');
});

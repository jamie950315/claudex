import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatMailbox } from '../src/chat-mailbox.mjs';
import { withLock } from '../src/storage.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const DAY = 86400000;
const claimId = '11111111-1111-4111-8111-111111111111';
const chatRecord = (nativeId, directory, phase = 'ended', lastSeenAt = 0) => ({
  chatId: `claude:${nativeId}`, provider: 'claude', nativeId, cwd: directory, phase, lastSeenAt,
});
function addMessage(state, targetSessionId, index, extra = {}) {
  const now = Date.now();
  const message = { messageId: `message-${index}`, fromProvider: 'codex', targetProvider: 'claude', targetSessionId,
    message: 'Synthetic peer message', state: 'queued', createdAt: now, expiresAt: now + 3600000, ...extra };
  state.messages.push(message);
  state.receipts.push({ fromProvider: 'codex', requestId: `request-${index}`, messageId: message.messageId,
    payload: JSON.stringify(['claude', targetSessionId, message.message, 3600000]) });
  return message;
}
async function saveJournal(root, state) {
  await writeFile(join(root, 'state.json'), JSON.stringify(state), { mode: 0o600 });
  await chmod(join(root, 'state.json'), 0o600);
}

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

test('a full legacy journal retires only the oldest safe ended chat and preserves every live reference', async t => {
  const { root, mailbox, directory } = await fixture(t), now = Date.now();
  const state = { version: 1, chats: [], messages: [], receipts: [] };
  for (let i = 0; i < 1024; i++) state.chats.push(chatRecord(`chat-${i}`, directory, 'active', now));
  for (let i = 0; i < 10; i++) Object.assign(state.chats[i], { phase: 'ended', lastSeenAt: i });
  state.chats[10].lastSeenAt = now - 31 * DAY;
  addMessage(state, 'chat-0', 0);
  addMessage(state, 'chat-1', 1, { state: 'offered', offeredAt: now });
  addMessage(state, 'chat-2', 2, { state: 'acknowledged', offeredAt: now, acknowledgedAt: now,
    wakeRoute: 'mod', wakeRequested: true, wake: { state: 'uncertain', claimId, at: now, detail: 'Unknown native outcome',
      source: { sessionId: 'chat-3', cwd: directory } } });
  // wakeRequested participates in the exact receipt payload.
  state.receipts[2].payload = JSON.stringify(['claude', 'chat-2', 'Synthetic peer message', 3600000, true]);
  await saveJournal(root, state);
  await writeFile(join(directory, 'work.json'), JSON.stringify({ version: 1, tasks: {
    pending: { status: 'running', notification: { policy: { mode: 'wake' }, origin: { provider: 'claude', sessionId: 'chat-4' }, deliveries: [] } },
    terminal: { status: 'completed', revision: 2, updatedAt: now, notification: { policy: { mode: 'queue', expiresInMs: 600000 },
      origin: { provider: 'claude', sessionId: 'chat-5' }, deliveries: [] } },
    hinted: { status: 'running', notification: { policy: { mode: 'wake' }, challengeExpiresAt: now + 600000,
      originHint: { provider: 'claude', sessionId: 'chat-6' }, deliveries: [] } },
  } }), { mode: 0o600 });
  await chmod(join(directory, 'work.json'), 0o600);
  await writeFile(join(root, 'wake-manifest.json'), JSON.stringify({ version: 1,
    messages: [{ messageId: 'manifest-message', sessionId: 'chat-7', expiresAt: now + 600000 }] }), { mode: 0o600 });
  await chmod(join(root, 'wake-manifest.json'), 0o600);
  await mailbox.hook({ provider: 'codex', sessionId: 'new', cwd: directory, event: 'SessionStart' });
  const chats = await mailbox.list();
  assert.equal(chats.length, 1024);
  assert.equal(chats.some(chat => chat.nativeId === 'chat-8'), false);
  for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10]) assert.ok(chats.some(chat => chat.nativeId === `chat-${id}`));
  assert.equal((await mailbox.status('message-2')).wake.state, 'uncertain');
});

test('discovery retires stale non-ended metadata after 30 days, with deterministic identity ties', async t => {
  const { root, mailbox, directory } = await fixture(t), now = Date.now();
  const state = { version: 1, chats: [], messages: [], receipts: [] };
  for (let i = 0; i < 1024; i++) state.chats.push(chatRecord(`chat-${i}`, directory, 'idle', now));
  for (const i of [2, 1]) Object.assign(state.chats[i], { phase: 'active', lastSeenAt: now - 31 * DAY });
  await saveJournal(root, state);
  await mailbox.discover({ provider: 'codex', sessionId: 'new', cwd: directory });
  const chats = await mailbox.list();
  assert.equal(chats.length, 1024);
  assert.equal(chats.some(chat => chat.nativeId === 'chat-1'), false);
  assert.equal(chats.some(chat => chat.nativeId === 'chat-2'), true);
  assert.equal(chats.find(chat => chat.nativeId === 'new').registeredByHook, false);
});

test('fully referenced capacity fails visibly and recovers through a normal ACK and registration after restart', async t => {
  const { root, mailbox, directory } = await fixture(t), now = Date.now();
  const state = { version: 1, chats: [], messages: [], receipts: [] };
  for (let i = 0; i < 1024; i++) {
    state.chats.push(chatRecord(`chat-${i}`, directory));
    addMessage(state, `chat-${i}`, i, { state: 'offered', offeredAt: now });
  }
  await saveJournal(root, state);
  const input = { provider: 'claude', sessionId: 'new', cwd: directory, event: 'SessionStart' };
  await assert.rejects(mailbox.hook(input), { code: 'MAILBOX_CAPACITY_EXHAUSTED', resource: 'chat' });
  const diagnosis = await mailbox.diagnostics();
  assert.equal(diagnosis.reason, 'mailbox-capacity-exhausted');
  assert.equal(diagnosis.messageCapacityExhausted, true);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')), state);
  await mailbox.hook({ ...input, sessionId: 'chat-0' });
  await mailbox.hook({ ...input, sessionId: 'chat-0', event: 'Stop', stopHookActive: true,
    lastAssistantMessage: 'CLAUDEX_ACK:message-0' });
  await mailbox.hook({ ...input, sessionId: 'chat-0', event: 'SessionEnd' });
  const restarted = new ChatMailbox({ root });
  await restarted.hook(input);
  assert.equal((await restarted.list()).length, 1024);
  assert.equal((await restarted.list()).some(chat => chat.nativeId === 'chat-0'), false);
  assert.equal((await restarted.status('message-0')).state, 'acknowledged');
  const replay = { fromProvider: 'codex', targetProvider: 'claude', targetSessionId: 'chat-0',
    requestId: 'request-0', message: 'Synthetic peer message', expiresInMs: 3600000 };
  assert.equal((await restarted.send(replay)).messageId, 'message-0');
  await assert.rejects(restarted.send({ ...replay, message: 'changed' }), /different payload/);
  assert.equal((await restarted.diagnostics()).chatCapacityExhausted, true);
});

test('message capacity archives resolved pairs while preserving claims, exact receipts and status after restart', async t => {
  const { root, mailbox, directory } = await fixture(t), now = Date.now();
  const state = { version: 1, chats: [chatRecord('target', directory, 'active', now)], messages: [], receipts: [] };
  for (let i = 0; i < 1024; i++) addMessage(state, 'target', i, { state: 'offered', offeredAt: now });
  Object.assign(state.messages[0], { state: 'acknowledged', acknowledgedAt: now - 2 });
  state.messages[0].wake = { state: 'accepted', claimId, at: now - 2, detail: 'Synthetic accepted wake' };
  Object.assign(state.messages[1], { state: 'expired', createdAt: now - 3600001, expiresAt: now - 1 });
  delete state.messages[1].offeredAt;
  state.messages[2].wake = { state: 'dispatching', claimId, at: now };
  await saveJournal(root, state);
  const args = { fromProvider: 'codex', targetProvider: 'claude', targetSessionId: 'target', message: 'new', requestId: 'new' };
  await mailbox.send(args);
  const active = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(active.messages.length, 1024); assert.equal(active.receipts.length, 1024);
  assert.equal(active.messages.some(message => message.messageId === 'message-0'), false);
  assert.equal(active.messages.find(message => message.messageId === 'message-2').wake.state, 'dispatching');
  const restarted = new ChatMailbox({ root });
  assert.equal((await restarted.status('message-0')).state, 'acknowledged');
  assert.equal((await restarted.finishWake('message-0', { claimId, state: 'accepted', detail: 'Synthetic accepted wake' })).state, 'acknowledged');
  assert.equal((await restarted.send({ ...args, message: 'Synthetic peer message', requestId: 'request-0', expiresInMs: 3600000 })).messageId, 'message-0');
  await restarted.send({ ...args, requestId: 'newer' });
  assert.equal((await restarted.status('message-1')).state, 'expired');
  await assert.rejects(restarted.send({ ...args, requestId: 'overflow' }), { code: 'MAILBOX_CAPACITY_EXHAUSTED', resource: 'message' });
  assert.equal((await restarted.diagnostics()).reason, 'mailbox-message-capacity-exhausted');
});

test('interrupted archival preserves its active pair and finishes without replay on the next capacity request', async t => {
  const { root, mailbox, directory } = await fixture(t), now = Date.now();
  const state = { version: 1, chats: [chatRecord('target', directory, 'active', now)], messages: [], receipts: [] };
  for (let i = 0; i < 1024; i++) addMessage(state, 'target', i);
  Object.assign(state.messages[0], { state: 'acknowledged', offeredAt: now, acknowledgedAt: now });
  await saveJournal(root, state);
  const request = mailbox.archivedRequest.bind(mailbox);
  mailbox.archivedRequest = async (side, requestId) => {
    if (requestId === 'request-0') throw new Error('Synthetic crash before receipt index publication');
    return request(side, requestId);
  };
  const args = { fromProvider: 'codex', targetProvider: 'claude', targetSessionId: 'target', message: 'new', requestId: 'new' };
  await assert.rejects(mailbox.send(args), /Synthetic crash/);
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).messages.length, 1024);
  const restarted = new ChatMailbox({ root });
  await restarted.hook({ provider: 'claude', sessionId: 'target', cwd: directory, event: 'Stop', stopHookActive: true });
  await restarted.send(args);
  assert.equal((await restarted.status('message-0')).state, 'acknowledged');
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).messages.length, 1024);
});

test('unsafe archive storage blocks capacity recovery without changing evidence', async t => {
  const { mailbox, root, directory, send } = await fixture(t);
  const sent = await send();
  const before = await readFile(join(root, 'state.json'), 'utf8');
  await symlink(directory, join(root, 'archive'));
  await assert.rejects(send({ requestId: 'another' }), /private, owned and regular/);
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), before);
  assert.equal((await mailbox.status(sent.messageId)).state, 'queued');
});

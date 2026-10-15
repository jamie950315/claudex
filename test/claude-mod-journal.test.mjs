import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, mkdir, writeFile, readFile, readdir, rm, symlink, cp, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createModBridge } from '../src/claude-mod-bridge.mjs';
import { createWakeOutbox } from '../src/claude-mod-wake-outbox.mjs';
import { createModJournal, inspectModJournals, MOD_JOURNAL_LIMIT } from '../src/claude-mod-journal.mjs';

const ctx = { sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/fixture/project' };
const id = number => `${number.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const make = (op, more = {}) => ({ version: 1, op, context: ctx, ...more });
const receiptRequest = (number, status = 'submitted') => make('wake-receipt', {
  target: ctx, route: 'mod-self', claimId: id(number), messageId: id(number + 10000), status,
  reason: status === 'submitted' ? 'inbox_written' : 'native_exception',
});
const write = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cm-journal-'))); await chmod(root, 0o700);
  await mkdir(join(root, 'collaboration'), { mode: 0o700 });
  await writeFile(join(root, 'collaboration/controller-key'), 'a'.repeat(64) + '\n', { mode: 0o600 });
  let calls = 0;
  const bridge = createModBridge({ root, now: () => 1000, rpc: async () => { calls++; return { done: true }; }, ...options });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, bridge, calls: () => calls };
}
async function fill(directory, factory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let offset = 0; offset < MOD_JOURNAL_LIMIT; offset += 64)
    await Promise.all(Array.from({ length: Math.min(64, MOD_JOURNAL_LIMIT - offset) }, (_, index) => {
      const [name, value] = factory(offset + index + 1);
      return write(join(directory, name), value);
    }));
}

test('action capacity archives completed receipts and preserves exact commit lookup after restart', async t => {
  const f = await fixture(t);
  const prepared = await f.bridge(make('prepare', { method: 'cancel', params: { taskId: 'first' } }));
  const completed = await f.bridge(make('commit', { id: prepared.id }));
  const directory = join(f.root, 'mod-companion');
  const template = JSON.parse(await readFile(join(directory, `${prepared.id}.json`)));
  // Keep one real completed action and fill the remaining slots with valid
  // protected evidence; requestId is the only per-receipt payload difference.
  await fill(directory, number => [`${id(number)}.json`, { ...template, id: id(number),
    params: { ...template.params, requestId: `mod:${id(number)}` }, state: 'uncertain' }]);
  await rm(join(directory, `${id(1)}.json`));
  const next = await f.bridge(make('prepare', { method: 'cancel', params: { taskId: 'second' } }));
  assert.equal(next.state, 'prepared');
  assert.equal(JSON.parse(await readFile(join(directory, 'archive', `${prepared.id}.json`))).state, 'completed');
  assert.equal((await readdir(directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).length, 2048);
  const restarted = createModBridge({ root: f.root, now: () => 1001, rpc: () => assert.fail('Archived commit replayed') });
  assert.deepEqual(await restarted(make('commit', { id: prepared.id })), completed);
  assert.deepEqual(await restarted(make('receipt', { id: prepared.id })), completed);
  await assert.rejects(restarted(make('receipt', { id: prepared.id, context: { ...ctx, cwd: '/other' } })), { code: 'CONTEXT_CHANGED' });
  assert.equal(f.calls(), 1);
});

test('expired previews retire safely while unexpired, dispatching and uncertain actions stay active', async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now });
  const prepared = await f.bridge(make('prepare', { method: 'cancel', params: { taskId: 'expired' } }));
  const directory = join(f.root, 'mod-companion');
  const template = JSON.parse(await readFile(join(directory, `${prepared.id}.json`)));
  await rm(join(directory, `${prepared.id}.json`));
  await fill(directory, number => [`${id(number)}.json`, { ...template, id: id(number),
    params: { ...template.params, requestId: `mod:${id(number)}` }, state: number === 1 ? 'prepared' : number % 2 ? 'dispatching' : 'uncertain' }]);
  now = template.expiresAt;
  await f.bridge(make('prepare', { method: 'cancel', params: { taskId: 'new' } }));
  const old = await f.bridge(make('receipt', { id: id(1) }));
  assert.equal(old.state, 'prepared');
  await assert.rejects(f.bridge(make('commit', { id: id(1) })), { code: 'PREVIEW_EXPIRED' });
  assert.equal((await readdir(join(directory, 'archive'))).filter(name => name.endsWith('.json')).length, 1);
  await assert.rejects(f.bridge(make('prepare', { method: 'cancel', params: { taskId: 'full' } })), { code: 'JOURNAL_CAPACITY_EXHAUSTED' });
  const diagnostics = (await f.bridge(make('doctor'))).journals.actions;
  assert.deepEqual({ state: diagnostics.state, active: diagnostics.active, protected: diagnostics.protected },
    { state: 'capacity-exhausted', active: 2048, protected: 2048 });
  assert.equal(f.calls(), 0);
});

test('archived done outbox receipts preserve exact idempotency and conflicting outcomes refuse', async t => {
  const f = await fixture(t), directory = join(f.root, 'mod-wake-receipts');
  await fill(directory, number => [`${id(number)}.done.json`, { version: 1, request: receiptRequest(number) }]);
  let published = 0;
  const outbox = createWakeOutbox(f.root, async request => {
    published++;
    return { state: 'offered', targetProvider: 'claude', targetSessionId: ctx.sessionId, messageId: request.messageId,
      wakeRoute: 'mod-self', wake: { state: request.status, claimId: request.claimId, source: ctx } };
  });
  await outbox.record(receiptRequest(3000));
  assert.equal(published, 1);
  assert.deepEqual(await outbox.record(receiptRequest(1)), { recorded: true });
  assert.equal(published, 1, 'exact archived outcome does not republish');
  await assert.rejects(outbox.record(receiptRequest(1, 'uncertain')), { code: 'INVALID_RECEIPT' });
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 2048);
  assert.equal((await inspectModJournals(f.root)).wakeOutbox.state, 'retention-available');
});

test('pending and uncertain done outbox receipts never retire', async t => {
  const f = await fixture(t), directory = join(f.root, 'mod-wake-receipts');
  await fill(directory, number => [`${id(number)}.${number % 2 ? 'pending' : 'done'}.json`,
    { version: 1, request: receiptRequest(number, 'uncertain') }]);
  const outbox = createWakeOutbox(f.root, () => assert.fail('Capacity refusal cannot publish'));
  await assert.rejects(outbox.record(receiptRequest(3000)), { code: 'JOURNAL_CAPACITY_EXHAUSTED' });
  assert.equal((await inspectModJournals(f.root)).wakeOutbox.protected, 2048);
  await assert.rejects(readFile(join(directory, 'archive', `${id(1)}.pending.json`)), { code: 'ENOENT' });
});

test('self dispatch retires only settled outcomes; archived dispatch never sends again', async t => {
  let sends = 0;
  const f = await fixture(t, { allowNativeWake: true, allowSelfWake: true,
    submitInbox: async () => { sends++; return { state: 'submitted', reason: 'socket-written', automaticReplay: false }; } });
  const directory = join(f.root, 'mod-self-dispatch');
  await fill(directory, number => [`${id(number)}.json`, { version: 1,
    identity: { context: ctx, target: ctx, messageId: id(number + 10000), claimId: id(number), route: 'mod-self' },
    ...(number === 1 ? { outcome: { state: 'rejected', reason: 'before-write-refused', automaticReplay: false } }
      : number === 2 ? { outcome: { state: 'submitted', reason: 'socket-written', automaticReplay: false } }
        : number % 2 ? {} : { outcome: { state: 'uncertain', reason: 'socket-error', automaticReplay: false } }) }]);
  const request = number => make('wake-self-send', { target: ctx, route: 'mod-self', claimId: id(number), messageId: id(number + 10000) });
  await f.bridge(request(3000));
  assert.equal(sends, 1);
  assert.equal((await f.bridge(request(1))).state, 'rejected');
  assert.equal(sends, 1);
  // submitted without its confirmed receipt is still protected.
  await assert.rejects(f.bridge(request(3001)), { code: 'JOURNAL_CAPACITY_EXHAUSTED' });
  const outbox = join(f.root, 'mod-wake-receipts'); await mkdir(outbox, { mode: 0o700 });
  await write(join(outbox, `${id(2)}.done.json`), { version: 1, request: receiptRequest(2) });
  await f.bridge(request(3001));
  assert.equal(sends, 2);
  assert.equal((await f.bridge(request(2))).state, 'submitted');
  assert.equal(sends, 2);
});

test('interrupted archive duplicate recovers without changing original evidence and unsafe archives refuse', async t => {
  const f = await fixture(t), directory = join(f.root, 'mod-wake-receipts');
  await fill(directory, number => [`${id(number)}.done.json`, { version: 1, request: receiptRequest(number) }]);
  const archive = join(directory, 'archive'); await mkdir(archive, { mode: 0o700 });
  await cp(join(directory, `${id(1)}.done.json`), join(archive, `${id(1)}.done.json`));
  const journal = createModJournal(f.root, 'wakeOutbox');
  await journal.transaction(() => journal.reserve());
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 2047);
  assert.equal((await journal.read(`${id(1)}.done.json`)).request.claimId, id(1));
  const other = join(f.root, 'foreign'); await mkdir(other, { mode: 0o700 });
  await rm(archive, { recursive: true }); await symlink(other, archive);
  await assert.rejects(journal.read(`${id(1)}.done.json`), { code: 'UNSAFE_ROOT' });
});

test('journal capacity is serialized and a proven-dead storage lock recovers after restart', async t => {
  const f = await fixture(t), journal = createModJournal(f.root, 'wakeOutbox');
  await mkdir(journal.directory, { mode: 0o700 });
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  await write(join(journal.directory, '.journal.lock'), { version: 1, pid: Number(child.stdout) });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const first = journal.transaction(async () => { entered(); await pending; return 'finished'; });
  await started;
  await assert.rejects(journal.transaction(() => assert.fail('Concurrent storage writer')), { code: 'JOURNAL_BUSY' });
  release(); assert.equal(await first, 'finished');
  assert.equal(await journal.transaction(async () => 'reopened'), 'reopened');
});


test('legacy root intent pointers retain their uncertainty fence after the new index is introduced', async t => {
  const f = await fixture(t, { rpc: async () => { throw new Error('Synthetic response loss'); } });
  const request = make('prepare', { method: 'cancel', params: { taskId: 'legacy-uncertain' } });
  const prepared = await f.bridge(request);
  assert.equal((await f.bridge(make('commit', { id: prepared.id }))).state, 'uncertain');
  const directory = join(f.root, 'mod-companion');
  const [pointer] = await readdir(join(directory, 'intents'));
  await rename(join(directory, 'intents', pointer), join(directory, pointer));
  const restarted = createModBridge({ root: f.root, now: () => 2000, rpc: () => assert.fail('Legacy action replayed') });
  await assert.rejects(restarted(request), { code: 'UNCERTAIN_ACTION' });
  assert.equal((await restarted(make('receipt', { id: prepared.id }))).state, 'uncertain');
});

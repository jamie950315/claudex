import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBridge } from '../src/desktop-bridge.mjs';

const turn = n => [
  { role: 'user', content: [{ type: 'text', text: `Question ${n}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${n}` }] },
];
const copy = value => structuredClone(value);

async function fixture(policy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-bridge-'));
  const files = new Map();
  const calls = { plan: [], apply: [], hide: [], remove: [] };
  const fail = { afterApply: false, afterHide: false };
  let serial = 0;
  const adapters = {};
  for (const side of ['codex', 'claude']) adapters[side] = {
    async inspect(record) {
      const file = files.get(record.path);
      if (!file) throw new Error(`Missing native history: ${record.path}`);
      return { nativeId: file.nativeId, path: record.path, common: copy(file.common), bytes: JSON.stringify(file.common).length };
    },
    async plan({ nativeId, target, operationId, title }) {
      calls.plan.push({ side, operationId, title });
      if (side === 'claude' && target?.managed && target.kind === 'owner') {
        return { nativeId: target.nativeId, path: target.path, kind: 'owner' };
      }
      const id = `${side}-${++serial}-${nativeId}`;
      return { nativeId: id, path: `/native/${id}`, kind: side === 'claude' ? 'owner' : 'snapshot' };
    },
    async operationApplied(record, pending) {
      return files.get(record.path)?.operations.has(pending.operationId) ?? false;
    },
    async apply(record, common, pending) {
      calls.apply.push(pending.operationId);
      const prior = files.get(record.path);
      if (prior && prior.nativeId !== record.nativeId) throw new Error('Native identity collision');
      if (prior && record.kind === 'owner') {
        assert.deepEqual(prior.common.messages, common.messages.slice(0, pending.previous.count));
      } else if (prior) throw new Error('Snapshot already exists');
      files.set(record.path, { nativeId: record.nativeId, common: copy(common),
        operations: new Set([...(prior?.operations ?? []), pending.operationId]), busy: prior?.busy ?? false,
        hidden: false });
      if (fail.afterApply) {
        fail.afterApply = false;
        throw new Error('Crash after durable native apply');
      }
    },
    async assertIdle(record) {
      if (files.get(record.path)?.busy) throw new Error('Native target is busy');
    },
    async hide(record) {
      calls.hide.push(record.nativeId);
      if (fail.afterHide) {
        fail.afterHide = false;
        throw new Error('Crash during snapshot retirement');
      }
      files.get(record.path).hidden = true;
      return { hidden: true };
    },
    async exists(record) { return files.has(record.path); },
    async remove(record) {
      assert.equal(record.managed, true);
      calls.remove.push(record.nativeId);
      files.delete(record.path);
    },
  };
  files.set('/original', { nativeId: 'original', common: {
    meta: { id: 'original', cwd: '/tmp/desktop-project', timestamp: new Date(0).toISOString() }, messages: turn(0),
  }, operations: new Set(), busy: false, hidden: false });
  const bridge = new DesktopBridge({ root, adapters, policy });
  const { conversationId } = await bridge.track({ side: 'claude', path: '/original' });
  const current = async side => (await bridge.status()).records.find(record => record.conversationId === conversationId && record.side === side && record.status === 'current');
  return { bridge, conversationId, files, calls, fail, current,
    async advance(side, n) {
      const record = await current(side);
      files.get(record.path).common.messages.push(...turn(n));
      return record;
    },
  };
}

test('alternating native turns keep one Claude owner, bounded Codex snapshots, and canonical prefixes', async () => {
  const f = await fixture({ maxAuditEntries: 8 });
  const original = copy(f.files.get('/original').common);
  let claudeOwnerId;
  for (let n = 0; n < 8; n++) {
    const side = n % 2 ? 'codex' : 'claude';
    if (n) await f.advance(side, n);
    const result = await f.bridge.sync(f.conversationId);
    assert.equal(result.changed, true);
    const state = await f.bridge.status();
    const expected = turn(0).concat(...Array.from({ length: n }, (_, index) => turn(index + 1)));
    assert.deepEqual(f.files.get((await f.current('codex')).path).common.messages, expected);
    assert.deepEqual(f.files.get((await f.current('claude')).path).common.messages, expected);
    assert.equal(state.conversations[f.conversationId].canonical.count, expected.length);
    assert.equal(state.pending, null);
    assert.ok(state.audit.length <= 8);
    assert.ok(state.records.filter(record => record.managed && record.kind === 'snapshot').length <= 2);
    const owners = state.records.filter(record => record.managed && record.kind === 'owner');
    assert.ok(owners.length <= 1);
    if (owners.length) {
      claudeOwnerId ??= owners[0].nativeId;
      assert.equal(owners[0].nativeId, claudeOwnerId);
    }
    const planned = f.calls.plan.length;
    assert.equal((await f.bridge.sync(f.conversationId)).changed, false);
    assert.equal(f.calls.plan.length, planned);
  }
  assert.deepEqual(f.files.get('/original').common, original);
  assert.equal(f.files.get('/original').hidden, false);
  assert.ok(f.files.has('/original'));
  assert.ok(f.calls.plan.filter(call => call.side === 'codex').every(call => call.title.startsWith('[Claudex] ')));
});

test('resumed originals reject no-op sync, new allocation, and collection without selecting a branch', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId);
  await f.advance('codex', 1);
  await f.bridge.sync(f.conversationId);
  assert.equal((await f.bridge.status()).records.find(record => record.path === '/original').status, 'original');
  f.files.get('/original').common.messages.push(...turn('resumed-original'));
  const before = await f.bridge.status(), calls = copy(f.calls);
  await assert.rejects(f.bridge.sync(f.conversationId), /Superseded original.*changed/);
  await f.advance('claude', 2);
  await assert.rejects(f.bridge.sync(f.conversationId), /Superseded original.*changed/);
  await assert.rejects(f.bridge.collect(), /Superseded original.*changed/);
  assert.deepEqual(await f.bridge.status(), before);
  assert.deepEqual(f.calls, calls);
  assert.deepEqual(f.files.get('/original').common.messages, [...turn(0), ...turn('resumed-original')]);
  assert.equal(f.files.get('/original').hidden, false);
});

test('recovery preserves the pending handoff when an inactive original changes', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId);
  await f.advance('codex', 1);
  await f.bridge.sync(f.conversationId);
  await f.advance('claude', 2);
  f.fail.afterApply = true;
  await assert.rejects(f.bridge.sync(f.conversationId), /Crash after durable native apply/);
  f.files.get('/original').common.messages[0].content[0].text = 'Rewritten original';
  const before = await f.bridge.status(), calls = copy(f.calls);
  await assert.rejects(f.bridge.recover(), /Superseded original.*changed/);
  assert.deepEqual(await f.bridge.status(), before);
  assert.deepEqual(f.calls, calls);
});

test('recovery rechecks the old destination even after a new projection was durably applied', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId);
  await f.advance('codex', 1);
  f.fail.afterApply = true;
  await assert.rejects(f.bridge.sync(f.conversationId), /Crash after durable native apply/);
  f.files.get('/original').common.messages.push(...turn('concurrent-original'));
  const before = await f.bridge.status(), calls = copy(f.calls);
  await assert.rejects(f.bridge.recover(), /Destination changed during handoff/);
  assert.deepEqual(await f.bridge.status(), before);
  assert.deepEqual(f.calls, calls);
});

test('recovery detects a durable Claude apply and does not append the copied turn twice', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId);
  await f.advance('codex', 1);
  f.fail.afterApply = true;
  await assert.rejects(f.bridge.sync(f.conversationId), /Crash after durable native apply/);
  const pending = (await f.bridge.status()).pending;
  assert.equal(pending.phase, 'prepared');
  assert.equal(pending.record.kind, 'owner');
  const before = f.calls.apply.length;
  await f.bridge.recover();
  assert.equal(f.calls.apply.length, before);
  assert.deepEqual(f.files.get((await f.current('claude')).path).common.messages, [...turn(0), ...turn(1)]);
  assert.equal((await f.bridge.status()).pending, null);
});

test('recovery completes promoted snapshot retirement without creating another snapshot', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId);
  await f.advance('codex', 1);
  await f.bridge.sync(f.conversationId);
  await f.advance('claude', 2);
  f.fail.afterHide = true;
  await assert.rejects(f.bridge.sync(f.conversationId), /Crash during snapshot retirement/);
  const state = await f.bridge.status();
  assert.equal(state.pending.phase, 'promoted');
  const planned = f.calls.plan.length;
  const prior = state.records.find(record => record.id === state.pending.targetId);
  assert.equal(prior.status, 'previous');
  assert.equal(f.files.get(prior.path).hidden, false);
  await f.bridge.recover();
  assert.equal(f.calls.plan.length, planned);
  assert.equal(f.files.get(prior.path).hidden, true);
  assert.equal((await f.bridge.status()).pending, null);
});

test('both-side changes and edited common prefixes reject before native allocation', async () => {
  const both = await fixture();
  await both.bridge.sync(both.conversationId);
  await both.advance('codex', 1);
  await both.advance('claude', 2);
  const planned = both.calls.plan.length;
  await assert.rejects(both.bridge.sync(both.conversationId), /Both sides changed/);
  assert.equal(both.calls.plan.length, planned);
  assert.equal((await both.bridge.status()).pending, null);

  const prefix = await fixture();
  prefix.files.get('/original').common.messages[0].content[0].text = 'Rewritten question';
  await assert.rejects(prefix.bridge.sync(prefix.conversationId), /diverged before the common checkpoint/);
  assert.equal(prefix.calls.plan.length, 0);
  assert.equal((await prefix.bridge.status()).pending, null);
});

test('edited old snapshots and known busy targets preserve data without new allocation', async () => {
  const edited = await fixture();
  await edited.bridge.sync(edited.conversationId);
  await edited.advance('codex', 1);
  await edited.bridge.sync(edited.conversationId);
  await edited.advance('claude', 2);
  await edited.bridge.sync(edited.conversationId);
  const old = (await edited.bridge.status()).records.find(record => record.kind === 'snapshot' && record.status === 'previous');
  edited.files.get(old.path).common.messages[0].content[0].text = 'Locally edited snapshot';
  await edited.advance('claude', 3);
  const count = edited.calls.plan.length;
  await assert.rejects(edited.bridge.sync(edited.conversationId), /retained snapshot was edited/);
  assert.equal(edited.calls.plan.length, count);
  assert.ok(edited.files.has(old.path));

  const busy = await fixture();
  await busy.bridge.sync(busy.conversationId);
  await busy.advance('codex', 1);
  await busy.bridge.sync(busy.conversationId);
  const target = await busy.current('codex');
  const original = copy(busy.files.get(target.path).common);
  busy.files.get(target.path).busy = true;
  await busy.advance('claude', 2);
  const beforeBusy = busy.calls.plan.length;
  await assert.rejects(busy.bridge.sync(busy.conversationId), /Native target is busy/);
  assert.deepEqual(busy.files.get(target.path).common, original);
  assert.equal((await busy.bridge.status()).pending, null);
  assert.equal(busy.calls.plan.length, beforeBusy);
  busy.files.get(target.path).busy = false;
  assert.equal((await busy.bridge.sync(busy.conversationId)).changed, true);
});

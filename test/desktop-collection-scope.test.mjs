import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { fingerprint } from '../src/history.mjs';

const common = {
  meta: { cwd: '/synthetic/project' },
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
  ],
};
const checkpoint = { count: 2, digest: fingerprint(common) };

async function fixture(policy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claudex-collection-scope-'));
  const calls = { inspect: [], idle: [], remove: [] }, files = new Map();
  const adapters = {};
  for (const side of ['codex', 'claude']) adapters[side] = {
    async inspect(record) {
      calls.inspect.push(record.nativeId);
      const file = files.get(record.nativeId);
      if (!file) throw new Error(`Missing native history: ${record.nativeId}`);
      return { nativeId: record.nativeId, path: record.path,
        common: structuredClone(file.common), bytes: file.bytes, incompleteTail: file.incompleteTail };
    },
    async assertIdle(record) {
      calls.idle.push(record.nativeId);
      if (files.get(record.nativeId)?.busy) throw new Error('Native target is busy');
    },
    async exists(record) { return files.has(record.nativeId); },
    async remove(record) {
      calls.remove.push(record.nativeId);
      files.delete(record.nativeId);
    },
  };
  const bridge = new DesktopBridge({ root, adapters, policy, now: () => 1_000 });
  const state = { version: 2, conversations: {}, records: [], audit: [], pending: null };
  function add(conversationId, suffix, side, kind, managed, status = 'current', withFile = true) {
    const id = `${conversationId}-${suffix}`;
    state.conversations[conversationId] ??= { id: conversationId,
      discoveryMode: conversationId.startsWith('cold-') ? 'cold-import' : undefined,
      canonical: { ...checkpoint } };
    const record = { id, nativeId: id, conversationId, side, kind, managed, status,
      cwd: common.meta.cwd, path: `/native/${id}`, verified: true,
      checkpoint: { ...checkpoint }, bytes: 90, createdAt: 100, ...(status === 'previous' ? { retiredAt: 200 } : {}) };
    state.records.push(record);
    if (withFile) files.set(id, { common: structuredClone(common), bytes: 90, busy: false });
    return record;
  }
  function coldPairs(count = 150) {
    for (let n = 0; n < count; n++) {
      // These histories deliberately have no readable fixture. Any accidental
      // cold full export or owner inspection makes collection fail.
      add(`cold-${n}`, 'codex', 'codex', 'original', false, 'current', false);
      add(`cold-${n}`, 'claude', 'claude', 'original', false, 'current', false);
    }
  }
  function owned(conversationId = 'active') {
    const current = add(conversationId, 'current', 'codex', 'snapshot', true);
    const paired = add(conversationId, 'owner', 'claude', 'owner', true);
    const previous = add(conversationId, 'previous', 'codex', 'snapshot', true, 'previous');
    return { current, paired, previous };
  }
  return { bridge, state, calls, files, add, coldPairs, owned,
    async collect() { await bridge.save(state); return bridge.collect(); } };
}

test('collection skips 150 cold pairs without snapshots but validates both current sides before retirement', async () => {
  const f = await fixture({ previousPerSide: 0 });
  f.coldPairs();
  const { current, paired, previous } = f.owned();
  const result = await f.collect();
  assert.equal(result.removed, 1);
  assert.deepEqual(f.calls.remove, [previous.id]);
  assert.ok(f.calls.inspect.includes(current.id));
  assert.ok(f.calls.inspect.includes(paired.id));
  assert.ok(f.calls.inspect.every(id => !id.startsWith('cold-')));
  assert.equal((await f.bridge.status()).records.filter(record => record.conversationId.startsWith('cold-')).length, 300);
  // Reuse the first verified read for bytes, then independently recheck before removal.
  assert.equal(f.calls.inspect.filter(id => id === previous.id).length, 2);
  assert.deepEqual(f.calls.idle, [previous.id, previous.id]);
});

test('both current sides remain required when their conversation has a retained snapshot', async () => {
  for (const side of ['current', 'paired']) {
    for (const failure of ['missing', 'diverged']) {
      const f = await fixture({ previousPerSide: 0 });
      f.coldPairs();
      const records = f.owned();
      if (failure === 'missing') f.files.delete(records[side].id);
      else f.files.get(records[side].id).common.messages[0].content[0].text = 'Changed prefix';
      await assert.rejects(f.collect(), failure === 'missing' ? /Missing native history/ : /Current history changed/);
      assert.deepEqual(f.calls.remove, []);
      assert.ok(f.files.has(records.previous.id));
    }
  }
});

test('superseded originals still block global collection even when their own conversation has no snapshots', async () => {
  const f = await fixture({ previousPerSide: 0 });
  f.coldPairs();
  const { previous } = f.owned();
  const original = f.add('cold-0', 'superseded', 'claude', 'original', false, 'original');
  f.files.get(original.id).common.messages[0].content[0].text = 'Conflicting original';
  await assert.rejects(f.collect(), /Superseded original.*changed/);
  assert.deepEqual(f.calls.inspect, [original.id]);
  assert.deepEqual(f.calls.remove, []);
  assert.ok(f.files.has(previous.id));
});

test('snapshot-free collection still validates superseded-original incomplete tails', async () => {
  const f = await fixture();
  f.coldPairs();
  const original = f.add('cold-0', 'superseded', 'claude', 'original', false, 'original');
  f.files.get(original.id).incompleteTail = true;
  await assert.rejects(f.collect(), /superseded original has an in-progress turn/i);
  assert.deepEqual(f.calls.remove, []);
});

test('backup quota remains global across every snapshot conversation and uses inspected previous bytes', async () => {
  const f = await fixture({ maxBackupBytes: 150 });
  f.coldPairs();
  const first = f.owned('first'), second = f.owned('second');
  // The journal's stale byte estimate must not evade the global quota.
  for (const records of [first, second]) records.previous.bytes = 1;
  const result = await f.collect();
  assert.equal(result.removed, 1);
  assert.equal(result.backupBytes, 90);
  assert.deepEqual(f.calls.remove, [first.previous.id]);
  const retained = (await f.bridge.status()).records.filter(record => record.managed && record.kind === 'snapshot');
  assert.equal(retained.length, 3);
  assert.equal(retained.find(record => record.id === second.previous.id).bytes, 90);
  for (const record of [first.current, first.paired, second.current, second.paired])
    assert.ok(f.calls.inspect.includes(record.id));
});

test('a conversation whose working directory was deleted is frozen instead of blocking global collection', async () => {
  const f = await fixture({ previousPerSide: 0 });
  const active = f.owned('active');
  const gone = f.owned('gone');
  const original = f.add('gone', 'superseded', 'codex', 'original', false, 'original', false);
  for (const record of [gone.current, gone.paired, gone.previous, original]) record.cwd = '/deleted/worktree';
  // Unreadable frozen histories must not even be inspected.
  for (const record of [gone.current, gone.paired, gone.previous]) f.files.delete(record.id);
  const probed = [];
  for (const side of ['codex', 'claude'])
    f.bridge.adapters[side].workingDirectoryAbsent = async cwd => { probed.push(cwd); return cwd === '/deleted/worktree'; };
  const result = await f.collect();
  assert.deepEqual(result.frozen, ['gone']);
  assert.deepEqual(f.calls.remove, [active.previous.id]);
  assert.ok(f.calls.inspect.every(id => !id.startsWith('gone-')));
  const retained = (await f.bridge.status()).records.filter(record => record.conversationId === 'gone');
  assert.equal(retained.length, 4);
  assert.equal(new Set(probed).size, probed.length);

  // The frozen conversation's own sync still verifies its originals and fails explicitly.
  const state = await f.bridge.status();
  await assert.rejects(f.bridge.assertOriginalsUnchanged(state, 'gone'), /Missing native history: gone-superseded/);
});

test('frozen snapshots still count toward the global backup quota', async () => {
  const f = await fixture({ maxBackupBytes: 50 });
  f.owned('active');
  const gone = f.owned('gone');
  for (const record of [gone.current, gone.paired, gone.previous]) record.cwd = '/deleted/worktree';
  for (const side of ['codex', 'claude'])
    f.bridge.adapters[side].workingDirectoryAbsent = async cwd => cwd === '/deleted/worktree';
  await assert.rejects(f.collect(), /Snapshot retention cannot be satisfied safely/);
  assert.deepEqual(f.calls.remove, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { fingerprint } from '../src/history.mjs';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

const pair = index => [{ role: 'user', content: [{ type: 'text', text: `Question ${index}` }] }, { role: 'assistant', content: [{ type: 'text', text: `Answer ${index}` }] }];
async function fixture(policy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claudex-controller-test-'));
  const files = new Map();
  const fail = {};
  let created = 0;
  const drivers = {};
  for (const side of ['codex', 'claude']) drivers[side] = {
    async inspect(record) {
      const file = files.get(record.path);
      if (!file) throw new Error('Missing file');
      const raw = Buffer.from(file.raw ?? JSON.stringify(file.common));
      return { nativeId: file.nativeId, common: structuredClone(file.common), bytes: raw.length, digest: fingerprint(file.common),
        rawHash: hash(raw), prefixUnchanged: !!record.rawHash && hash(raw.subarray(0, record.bytes)) === record.rawHash,
        compactionId: file.compactionId, compactionOffset: file.compactionOffset };
    },
    async exists(record) { return files.has(record.path); },
    async assertIdle(record) { if (files.get(record.path)?.busy) throw new Error('Native writer is active'); },
    async plan({ nativeId }) { return { path: `/native/${side}/${nativeId}` }; },
    async materialize(record, common) {
      if (!files.has(record.path)) { files.set(record.path, { nativeId: record.nativeId, common: structuredClone(common) }); created++; }
      if (fail.create) { fail.create = false; throw new Error('Crash after durable create'); }
    },
    async verify(record, common) {
      if (fail.verify) { fail.verify = false; throw new Error('Projection verification failed'); }
      const data = await this.inspect(record);
      assert.equal(data.digest, fingerprint(common));
      return data;
    },
    async hide(record) {
      if (fail.hide) { fail.hide = false; throw new Error('Crash after promotion'); }
      files.get(record.path).hidden = true;
      return {};
    },
    async remove(record) {
      assert.equal(record.managed, true);
      if (fail.remove) { fail.remove = false; throw new Error('Remove refused'); }
      files.delete(record.path);
    },
  };
  const common = { meta: { id: 'source', cwd: '/tmp/project', timestamp: new Date().toISOString() }, messages: pair(0) };
  files.set('/source', { nativeId: 'source', common });
  const bridge = new Bridge({ root, drivers, policy });
  const { conversationId } = await bridge.track({ side: 'claude', path: '/source' });
  return { root, files, fail, drivers, bridge, conversationId, created: () => created,
    async advance(side, number) {
      const current = (await bridge.status()).records.find(record => record.conversationId === conversationId && record.side === side && record.status === 'current');
      files.get(current.path).common.messages.push(...pair(number));
      return current;
    },
  };
}

test('twelve roundtrips retain two current and at most two previous, preserve original, bound audit, deduplicate unchanged turns', async () => {
  const f = await fixture({ maxAuditEntries: 10 });
  for (let round = 0; round < 12; round++) {
    const side = round % 2 ? 'codex' : 'claude';
    if (round) await f.advance(side, round);
    assert.equal((await f.bridge.sync(f.conversationId, side)).changed, true);
    const before = f.created();
    assert.equal((await f.bridge.sync(f.conversationId, side)).changed, false);
    assert.equal(f.created(), before);
    const state = await f.bridge.status();
    assert.ok(state.records.filter(record => record.managed).length <= 4);
    assert.ok(state.records.filter(record => record.status === 'previous' && record.managed).length <= 2);
    assert.ok(state.audit.length <= 10);
    assert.equal(state.pending, null);
  }
  assert.ok(f.files.has('/source'));
  for (const record of (await f.bridge.status()).records.filter(record => record.status === 'current')) {
    assert.ok(f.files.get(record.path).common.messages.length >= 22);
  }
});

async function compactSource(f, { id = 'compact-1', editPrefix = false, offset } = {}) {
  const file = f.files.get('/source');
  const old = file.raw ?? JSON.stringify(file.common);
  file.compactionId = id;
  file.compactionOffset = offset ?? Buffer.byteLength(old);
  file.common.messages = [...pair('summary'), ...pair('after compaction')];
  file.raw = (editPrefix ? `X${old.slice(1)}` : old) + '\n' + JSON.stringify(file.common);
}

test('verified append-only compaction syncs summary and recent turns and advances baseline only on promotion', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId, 'claude');
  const before = (await f.bridge.status()).records.find(record => record.path === '/source');
  await compactSource(f);
  await f.bridge.collect();
  assert.deepEqual((await f.bridge.status()).records.find(record => record.path === '/source'), before);
  f.fail.verify = true;
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /verification/);
  assert.equal((await f.bridge.status()).records.find(record => record.path === '/source').checkpoint, before.checkpoint);
  await f.bridge.recover();
  const state = await f.bridge.status();
  const source = state.records.find(record => record.path === '/source');
  const target = state.records.find(record => record.side === 'codex' && record.status === 'current');
  assert.equal(source.compactionId, 'compact-1');
  assert.notEqual(source.rawHash, before.rawHash);
  assert.ok(source.bytes > before.bytes);
  assert.equal(source.checkpoint, target.checkpoint);
  assert.equal(typeof target.rawHash, 'string');
  assert.equal((await f.bridge.sync(f.conversationId, 'claude')).changed, false);
});

test('compaction never legitimizes edits to the previously observed native prefix', async () => {
  const f = await fixture();
  await compactSource(f, { editPrefix: true });
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /before its checkpoint/);
  assert.equal(f.created(), 0);
});

test('old compaction boundary and missing native proof do not reset a checkpoint', async () => {
  for (const kind of ['old-offset', 'old-id', 'missing-hash']) {
    const f = await fixture();
    await compactSource(f, { offset: kind === 'old-offset' ? 0 : undefined });
    await f.bridge.locked(async state => {
      if (kind === 'old-id') state.records[0].compactionId = 'compact-1';
      if (kind === 'missing-hash') delete state.records[0].rawHash;
      await f.bridge.save(state);
    });
    await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /before its checkpoint/);
    assert.equal(f.created(), 0);
  }
});

test('verified source compaction does not overwrite unsynchronized destination changes', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId, 'claude');
  await compactSource(f);
  await f.advance('codex', 'conflict');
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /Both sides/);
  assert.equal(f.created(), 1);
  assert.equal((await f.bridge.status()).pending, null);
});

test('another compaction during a pending handoff still rejects source divergence', async () => {
  const f = await fixture();
  await compactSource(f);
  f.fail.create = true;
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /durable create/);
  await compactSource(f, { id: 'compact-2' });
  f.files.get('/source').common.messages.push(...pair('new turn'));
  await assert.rejects(f.bridge.recover(), /Source changed/);
});

test('recovery resumes durable creation without making another generation', async () => {
  const f = await fixture();
  f.fail.create = true;
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /durable create/);
  const reopened = new Bridge({ root: f.root, drivers: f.drivers });
  assert.equal((await reopened.recover()).changed, true);
  assert.equal(f.created(), 1);
  assert.equal((await reopened.status()).pending, null);
});

test('failed verification does not retire original and blocks new transactions until recovery', async () => {
  const f = await fixture();
  f.fail.verify = true;
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /verification/);
  assert.ok(f.files.has('/source'));
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /unfinished transaction/);
  await f.bridge.recover();
  assert.equal(f.created(), 1);
});

test('both-side edits fail without new allocations', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId, 'claude');
  await f.advance('claude', 1);
  await f.advance('codex', 2);
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /Both sides/);
  assert.equal(f.created(), 1);
});

test('edited pre-checkpoint source cannot silently replace history', async () => {
  const f = await fixture();
  f.files.get('/source').common.messages[0].content[0].text = 'Rewritten';
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /before its checkpoint/);
  assert.equal(f.created(), 0);
});

test('recovery of promotion retires old generation exactly once', async () => {
  const f = await fixture();
  await f.bridge.sync(f.conversationId, 'claude');
  await f.advance('codex', 1);
  await f.bridge.sync(f.conversationId, 'codex');
  await f.advance('claude', 2);
  f.fail.hide = true;
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /after promotion/);
  assert.equal((await f.bridge.status()).pending.phase, 'promoted');
  await assert.rejects(f.bridge.abort(), /must be recovered/);
  await f.bridge.recover();
  assert.equal(f.created(), 3);
  assert.equal((await f.bridge.status()).records.filter(record => record.side === 'codex' && record.status === 'current').length, 1);
});

test('abort discards only an unpublished verified projection', async () => {
  const f = await fixture();
  f.fail.create = true;
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'));
  await f.advance('claude', 1);
  await assert.rejects(f.bridge.recover(), /Source changed/);
  assert.equal((await f.bridge.abort()).aborted, true);
  assert.equal(f.files.size, 1);
  assert.ok(f.files.has('/source'));
});

test('zero rollback policy removes previous generated versions but never originals', async () => {
  const f = await fixture({ previousPerSide: 0 });
  for (let round = 0; round < 5; round++) {
    const side = round % 2 ? 'codex' : 'claude';
    if (round) await f.advance(side, round);
    await f.bridge.sync(f.conversationId, side);
  }
  assert.equal((await f.bridge.status()).records.filter(record => record.managed).length, 2);
  assert.ok(f.files.has('/source'));
});

test('zero audit retention keeps no audit entries', async () => {
  const f = await fixture({ maxAuditEntries: 0 });
  await f.bridge.sync(f.conversationId, 'claude');
  assert.deepEqual((await f.bridge.status()).audit, []);
});

test('lossy canonical conversion is rejected before allocating a projection', async () => {
  const f = await fixture();
  f.drivers.codex.expected = common => ({ ...common, messages: common.messages.slice(1) });
  await assert.rejects(f.bridge.sync(f.conversationId, 'claude'), /changes canonical history/);
  assert.equal(f.created(), 0);
  assert.equal((await f.bridge.status()).pending, null);
});

test('missing current version preserves all previous backups', async () => {
  const f = await fixture();
  for (let round = 0; round < 4; round++) {
    const side = round % 2 ? 'codex' : 'claude';
    if (round) await f.advance(side, round);
    await f.bridge.sync(f.conversationId, side);
  }
  const state = await f.bridge.status();
  f.files.delete(state.records.find(record => record.managed && record.status === 'current').path);
  await assert.rejects(f.bridge.collect(), /Missing file/);
  for (const previous of state.records.filter(record => record.status === 'previous')) assert.ok(f.files.has(previous.path));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopBridge } from '../src/desktop-bridge.mjs';

const copy = value => structuredClone(value);
const turn = n => [{ role: 'user', content: [{ type: 'text', text: `Question ${n}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${n}` }] }];

async function fixture({ cold = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claudex-codex-relocation-'));
  const codexId = cold ? randomUUID() : 'codex-original';
  const files = new Map([['/codex/original.jsonl', { nativeId: codexId,
    common: { meta: { cwd: '/old/project' }, messages: turn(0) } }]]);
  const calls = { writes: 0, retired: [], relocations: 0, applyFailures: 0 };
  const adapters = {};
  for (const side of ['claude', 'codex']) adapters[side] = {
    async inspect(record) {
      const file = files.get(record.path);
      if (!file) throw new Error('Missing native source history');
      // A live owner is read through its process; a retired one only from disk.
      if (side === 'claude' && record.kind === 'owner' && !record.retiredOwner && calls.retired.includes(record.nativeId))
        throw new Error('A retired owner must not be restarted.');
      return { ...copy(file), path: record.path, bytes: JSON.stringify(file.common).length };
    },
    async assertIdle(record) { if (files.get(record.path)?.busy) throw new Error('Destination busy'); },
    async plan({ nativeId, target, relocation, common }) {
      if (side === 'codex') return { nativeId, path: `/snapshot/${nativeId}`, kind: 'snapshot' };
      if (relocation) {
        assert.notEqual(target.cwd, common.meta.cwd);
        calls.retired.push(target.nativeId);
      } else if (target?.managed) return { nativeId: target.nativeId, path: target.path, kind: 'owner' };
      const id = randomUUID();
      return { nativeId: id, path: `/owner/${id}`, kind: 'owner' };
    },
    async operationApplied(record) { return files.has(record.path); },
    async apply(record, common) {
      if (calls.applyFailures-- > 0) throw new Error('Synthetic native interruption');
      calls.writes++;
      files.set(record.path, { nativeId: record.nativeId, common: copy(common) });
    },
    async hide() { return { hidden: true }; },
    async exists(record) { return files.has(record.path); },
    async remove(record) { files.delete(record.path); },
  };
  let moved = null;
  adapters.codex.reconcileRelocation = async record => {
    const file = files.get(record.path);
    if (!moved || file.common.meta.cwd === record.cwd) return null;
    calls.relocations++;
    return { ...copy(file), path: record.path, bytes: JSON.stringify(file.common).length,
      relocationProof: { cwd: file.common.meta.cwd },
      record: { ...record, cwd: file.common.meta.cwd, relocation: { version: 1, kind: 'codex-project-move',
        originCwd: record.relocation?.originCwd ?? record.cwd, previousCwd: record.cwd } } };
  };
  const bridge = new DesktopBridge({ root, adapters });
  let conversationId;
  if (cold) {
    // A cold-imported pair: two unmanaged originals with equal histories.
    conversationId = randomUUID();
    const importId = randomUUID();
    files.set('/claude/import.jsonl', { ...copy(files.get('/codex/original.jsonl')), nativeId: importId });
    await bridge.trackImportedPair({ conversationId,
      source: { side: 'codex', nativeId: codexId, path: '/codex/original.jsonl', managed: false, kind: 'original' },
      target: { side: 'claude', nativeId: importId, path: '/claude/import.jsonl', managed: false, kind: 'original',
        importPacket: true, packetVersion: 2, conversationId } });
  } else {
    ({ conversationId } = await bridge.track({ side: 'codex', path: '/codex/original.jsonl' }));
    await bridge.sync(conversationId);
  }
  const current = async side => bridge.current(await bridge.status(), conversationId, side);
  return { bridge, files, calls, conversationId, current,
    move(cwd = '/new/project', extra = true) {
      moved = cwd;
      const file = files.get('/codex/original.jsonl');
      file.common = { meta: { cwd }, messages: [...file.common.messages, ...(extra ? turn(1) : [])] };
    } };
}

test('a Codex project move retires the old Claude owner and creates one in the new project', async () => {
  const f = await fixture();
  const oldOwner = await f.current('claude'), oldFile = copy(f.files.get(oldOwner.path));
  assert.equal(oldOwner.cwd, '/old/project');
  f.move();
  assert.equal((await f.bridge.sync(f.conversationId)).changed, true);
  const state = await f.bridge.status(), source = await f.current('codex'), owner = await f.current('claude');
  assert.equal(state.conversations[f.conversationId].cwd, '/new/project');
  assert.equal(source.nativeId, 'codex-original');
  assert.equal(source.cwd, '/new/project');
  assert.equal(source.relocation.originCwd, '/old/project');
  assert.equal(owner.cwd, '/new/project');
  assert.notEqual(owner.nativeId, oldOwner.nativeId);
  assert.equal(owner.checkpoint.count, 4);
  const retired = state.records.find(record => record.id === oldOwner.id);
  assert.equal(retired.status, 'retired-owner');
  assert.equal(retired.cwd, '/old/project');
  assert.deepEqual(f.files.get(oldOwner.path), oldFile);
  assert.deepEqual(f.calls.retired, [oldOwner.nativeId]);
  assert.equal((await f.bridge.sync(f.conversationId)).changed, false);
  await f.bridge.collect();
  assert.equal((await f.bridge.status()).records.find(record => record.id === oldOwner.id).status, 'retired-owner');
  assert.ok(f.files.has(oldOwner.path));
});

test('a Codex move of a cold-imported pair preserves the Claude original and creates an owner in the new project', async () => {
  const f = await fixture({ cold: true });
  const original = await f.current('claude'), originalFile = copy(f.files.get(original.path));
  assert.equal(original.kind, 'original');
  f.move();
  assert.equal((await f.bridge.sync(f.conversationId)).changed, true);
  const state = await f.bridge.status(), owner = await f.current('claude');
  assert.equal(state.conversations[f.conversationId].cwd, '/new/project');
  assert.equal((await f.current('codex')).cwd, '/new/project');
  assert.equal(owner.managed, true);
  assert.equal(owner.kind, 'owner');
  assert.equal(owner.cwd, '/new/project');
  assert.equal(owner.checkpoint.count, 4);
  const preserved = state.records.find(record => record.id === original.id);
  assert.equal(preserved.managed, false);
  assert.equal(preserved.kind, 'original');
  assert.notEqual(preserved.status, 'current');
  assert.equal(preserved.cwd, '/old/project');
  assert.deepEqual(f.files.get(original.path), originalFile);
  assert.deepEqual(f.calls.retired, []);
  assert.equal((await f.bridge.sync(f.conversationId)).changed, false);
});

test('an interrupted owner replacement recovers without restarting the retired owner', async () => {
  const f = await fixture();
  const oldOwner = await f.current('claude');
  f.move();
  f.calls.applyFailures = 1;
  await assert.rejects(f.bridge.sync(f.conversationId), /Synthetic native interruption/);
  assert.equal((await f.bridge.status()).pending.relocation, true);
  assert.equal((await f.bridge.recover()).changed, true);
  const state = await f.bridge.status();
  assert.equal(state.pending, null);
  assert.equal(state.records.find(record => record.id === oldOwner.id).status, 'retired-owner');
  assert.equal((await f.current('claude')).cwd, '/new/project');
});

test('a changed, busy or incomplete Claude owner keeps the move on hold with the exact ledger', async () => {
  for (const mode of ['changed', 'busy', 'incomplete']) {
    const f = await fixture();
    const owner = await f.current('claude');
    if (mode === 'changed') f.files.get(owner.path).common.messages.push(...turn('other'));
    if (mode === 'busy') f.files.get(owner.path).busy = true;
    if (mode === 'incomplete') f.files.get(owner.path).incompleteTail = true;
    const before = await f.bridge.status();
    f.move();
    await assert.rejects(f.bridge.sync(f.conversationId), /Claude changed|Destination busy/);
    assert.deepEqual(await f.bridge.status(), before);
    assert.deepEqual(f.calls.retired, []);
  }
});

test('a directory change without an adapter-proven move stays an explicit hold', async () => {
  const f = await fixture();
  const before = await f.bridge.status();
  const file = f.files.get('/codex/original.jsonl');
  file.common = { meta: { cwd: '/other/project' }, messages: [...file.common.messages, ...turn(1)] };
  await assert.rejects(f.bridge.sync(f.conversationId), /Source working directory changed/);
  assert.deepEqual(await f.bridge.status(), before);
  assert.deepEqual(f.calls.retired, []);
});

test('new enrollments fix the display screenshot policy for every Codex record they create', async () => {
  const f = await fixture();
  const state = await f.bridge.status();
  assert.equal(state.conversations[f.conversationId].displayScreenshots, 'omitted');
  assert.equal((await f.current('codex')).displayScreenshots, 'omitted');
  assert.equal((await f.current('claude')).displayScreenshots, undefined);
  // A Claude-origin conversation's Codex snapshot keeps the same policy.
  f.files.set('/claude/local.jsonl', { nativeId: 'claude-local', common: { meta: { cwd: '/old/project' }, messages: turn('local') } });
  const { conversationId } = await f.bridge.track({ side: 'claude', path: '/claude/local.jsonl' });
  await f.bridge.sync(conversationId);
  const after = await f.bridge.status(), snapshot = f.bridge.current(after, conversationId, 'codex');
  assert.equal(after.conversations[conversationId].displayScreenshots, 'omitted');
  assert.equal(snapshot.kind, 'snapshot');
  assert.equal(snapshot.displayScreenshots, 'omitted');
});

test('a move whose saved directory still exists is followed only through a thorough proof after the mismatch', async () => {
  const f = await fixture();
  const oldOwner = await f.current('claude');
  // The cheap check sees an existing saved directory and reports no move.
  const reconcile = f.bridge.adapters.codex.reconcileRelocation, thorough = [];
  f.bridge.adapters.codex.reconcileRelocation = async (record, options) => {
    thorough.push(options?.thorough === true);
    return options?.thorough ? reconcile(record) : null;
  };
  f.move();
  assert.equal((await f.bridge.sync(f.conversationId)).changed, true);
  assert.ok(thorough.includes(false) && thorough.includes(true));
  assert.equal((await f.current('codex')).cwd, '/new/project');
  assert.notEqual((await f.current('claude')).nativeId, oldOwner.nativeId);
  // Without any proof the working-directory hold remains.
  const g = await fixture();
  g.bridge.adapters.codex.reconcileRelocation = async () => null;
  g.move();
  await assert.rejects(g.bridge.sync(g.conversationId), /Source working directory changed; synchronization paused/);
  assert.equal((await g.current('codex')).cwd, '/old/project');
});

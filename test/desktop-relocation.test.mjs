import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBridge } from '../src/desktop-bridge.mjs';

const copy = value => structuredClone(value);
const turn = n => [{ role: 'user', content: [{ type: 'text', text: `Question ${n}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${n}` }] }];

async function fixture({ paired = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claudex-relocation-'));
  const files = new Map([['/old/source.jsonl', { nativeId: 'original',
    common: { meta: { cwd: '/old/project' }, messages: turn(0) } }]]);
  const calls = { writes: 0, relocations: 0, hides: 0 };
  const adapters = {};
  for (const side of ['claude', 'codex']) adapters[side] = {
    async inspect(record) {
      const file = files.get(record.path);
      if (!file) throw new Error('Missing native source history');
      return { ...copy(file), path: record.path, bytes: JSON.stringify(file.common).length };
    },
    async assertIdle(record) { if (files.get(record.path)?.busy) throw new Error('Destination busy'); },
    async plan({ nativeId }) { return { nativeId, path: `/snapshot/${nativeId}`, kind: 'snapshot' }; },
    async operationApplied(record) { return files.has(record.path); },
    async apply(record, common) { calls.writes++; files.set(record.path, { nativeId: record.nativeId, common: copy(common) }); },
    async hide(record) { calls.hides++; return { hidden: true }; },
    async exists(record) { return files.has(record.path); },
    async remove(record) { files.delete(record.path); },
  };
  let movedPath;
  adapters.claude.reconcileRelocation = async record => {
    if (!movedPath || record.path === movedPath) return null;
    calls.relocations++;
    const data = await adapters.claude.inspect({ ...record, path: movedPath });
    return { ...data, relocationProof: { hash: JSON.stringify(data.common), bytes: data.bytes },
      record: { ...record, path: movedPath, cwd: data.common.meta.cwd,
        relocation: record.relocation ?? { version: 1, originPath: record.path, originCwd: record.cwd } } };
  };
  const bridge = new DesktopBridge({ root, adapters });
  const { conversationId } = await bridge.track({ side: 'claude', path: '/old/source.jsonl' });
  const current = async side => bridge.current(await bridge.status(), conversationId, side);
  if (paired) await bridge.sync(conversationId);
  return { bridge, files, calls, conversationId, current,
    async move(path = '/new/source.jsonl', cwd = '/new/project', extra = false) {
      const record = await current('claude'), file = files.get(record.path);
      movedPath = path;
      files.set(path, { ...copy(file), common: { ...copy(file.common), meta: { cwd },
        messages: [...copy(file.common.messages), ...(extra ? turn(1) : [])] } });
      files.delete(record.path);
    } };
}

test('checkpoint-only relocation adopts metadata and creates a new-project snapshot without rewriting the original', async () => {
  const f = await fixture(), before = await f.bridge.status(), old = await f.current('codex');
  const oldFile = copy(f.files.get(old.path));
  await f.move();
  const sourceFile = copy(f.files.get('/new/source.jsonl'));
  assert.equal((await f.bridge.sync(f.conversationId)).changed, true);
  const after = await f.bridge.status(), source = await f.current('claude'), target = await f.current('codex');
  assert.deepEqual(after.conversations[f.conversationId].canonical, before.conversations[f.conversationId].canonical);
  assert.equal(after.conversations[f.conversationId].cwd, '/new/project');
  assert.equal(source.nativeId, 'original');
  assert.equal(source.managed, false);
  assert.equal(target.cwd, '/new/project');
  assert.notEqual(target.nativeId, old.nativeId);
  assert.equal(after.records.find(r => r.id === old.id).cwd, '/old/project');
  assert.equal(after.records.find(r => r.id === old.id).status, 'previous');
  assert.deepEqual(f.files.get(old.path), oldFile);
  assert.deepEqual(f.files.get(source.path), sourceFile);
  assert.equal((await f.bridge.sync(f.conversationId)).changed, false);
  assert.equal(f.calls.writes, 2);
});

test('global collection adopts a moved source before validating current histories; next sync copies its complete tail', async () => {
  const f = await fixture(), old = await f.current('codex');
  await f.move('/new/source.jsonl', '/new/project', true);
  await f.bridge.collect();
  assert.equal((await f.current('claude')).cwd, '/new/project');
  assert.equal((await f.current('codex')).nativeId, old.nativeId);
  assert.equal((await f.bridge.status()).conversations[f.conversationId].canonical.count, 2);
  assert.equal(f.calls.writes, 1);
  await f.bridge.sync(f.conversationId);
  assert.equal((await f.current('codex')).checkpoint.count, 4);
  assert.equal((await f.current('codex')).cwd, '/new/project');
});

test('unpaired originals and repeated relocations keep one bounded origin record', async () => {
  const f = await fixture({ paired: false });
  await f.move(); await f.bridge.sync(f.conversationId);
  const origin = copy((await f.current('claude')).relocation);
  await f.move('/third/source.jsonl', '/third/project');
  await f.bridge.sync(f.conversationId);
  assert.deepEqual((await f.current('claude')).relocation, origin);
  assert.equal((await f.current('codex')).cwd, '/third/project');
});

test('destination changes, incomplete turns and unmanaged destinations refuse metadata adoption', async () => {
  for (const mode of ['changed', 'incomplete', 'unmanaged', 'busy']) {
    const f = await fixture();
    const target = await f.current('codex');
    if (mode === 'changed') f.files.get(target.path).common.messages.push(...turn('other'));
    if (mode === 'incomplete') f.files.get(target.path).incompleteTail = true;
    if (mode === 'busy') f.files.get(target.path).busy = true;
    if (mode === 'unmanaged') await f.bridge.locked(async state => {
      f.bridge.current(state, f.conversationId, 'codex').managed = false; await f.bridge.save(state);
    });
    const before = await f.bridge.status();
    await f.move();
    await assert.rejects(f.bridge.sync(f.conversationId), /Codex changed|managed Codex snapshot|Destination busy/);
    assert.deepEqual(await f.bridge.status(), before);
    assert.equal(f.calls.writes, 1);
  }
});

test('changed source prefix, identity fields and ambiguous adapter proofs preserve the exact ledger', async () => {
  for (const mode of ['prefix', 'identity', 'ambiguous']) {
    const f = await fixture(), before = await f.bridge.status();
    await f.move();
    const reconcile = f.bridge.adapters.claude.reconcileRelocation;
    f.bridge.adapters.claude.reconcileRelocation = async record => {
      if (mode === 'ambiguous') throw new Error('Claude relocation candidate is ambiguous');
      const proof = await reconcile(record);
      if (mode === 'prefix') proof.common.messages[0].content[0].text = 'Different original';
      else proof.record.nativeId = 'different-native-id';
      return proof;
    };
    await assert.rejects(f.bridge.sync(f.conversationId), /history prefix|protected identity|ambiguous/);
    assert.deepEqual(await f.bridge.status(), before);
    assert.equal(f.calls.writes, 1);
  }
});

test('second relocation proof must preserve raw evidence and waits when the native source advances', async () => {
  const f = await fixture(), before = await f.bridge.status();
  await f.move();
  const reconcile = f.bridge.adapters.claude.reconcileRelocation;
  f.bridge.adapters.claude.reconcileRelocation = async record => {
    const proof = await reconcile(record);
    if (f.calls.relocations === 2) proof.relocationProof.hash = 'changed-native-bytes';
    return proof;
  };
  await assert.rejects(f.bridge.sync(f.conversationId), /relocation waits for a stable boundary/);
  assert.deepEqual(await f.bridge.status(), before);
  assert.equal(f.calls.writes, 1);
});

test('global relocation failures identify the affected conversation and incomplete source turns wait unchanged', async () => {
  const f = await fixture(), before = await f.bridge.status();
  await f.move();
  f.files.get('/new/source.jsonl').incompleteTail = true;
  await assert.rejects(f.bridge.collect(), error => {
    assert.equal(error.conversationId, f.conversationId);
    assert.match(error.message, /in-progress turn/);
    return true;
  });
  assert.deepEqual(await f.bridge.status(), before);
  f.files.get('/new/source.jsonl').incompleteTail = false;
  f.files.get((await f.current('codex')).path).common.messages.push(...turn('conflict'));
  await assert.rejects(f.bridge.collect(), error => {
    assert.equal(error.conversationId, f.conversationId);
    assert.equal(error.code, 'CLAUDEX_CLAUDE_RELOCATION_BLOCKED');
    return true;
  });
  assert.deepEqual(await f.bridge.status(), before);
});

test('superseded relocated originals remain guarded against later authored changes', async () => {
  const f = await fixture();
  await f.move(); await f.bridge.sync(f.conversationId);
  const source = await f.current('claude');
  await f.bridge.locked(async state => {
    f.bridge.current(state, f.conversationId, 'claude').status = 'original';
    await f.bridge.save(state);
  });
  f.files.get(source.path).common.messages.push(...turn('late-original'));
  const before = await f.bridge.status(), writes = f.calls.writes;
  await assert.rejects(f.bridge.collect(), /Superseded original .* changed/);
  assert.deepEqual(await f.bridge.status(), before);
  assert.equal(f.calls.writes, writes);
});

test('pending handoffs never discover a new source path or alter preserved pending evidence', async () => {
  const f = await fixture();
  const source = await f.current('claude');
  f.files.get(source.path).common.messages.push(...turn(1));
  f.bridge.adapters.codex.apply = async () => { throw new Error('Interrupted handoff'); };
  await assert.rejects(f.bridge.sync(f.conversationId), /Interrupted handoff/);
  const before = await f.bridge.status();
  await f.move();
  await assert.rejects(f.bridge.sync(f.conversationId), /unfinished desktop handoff/);
  await assert.rejects(f.bridge.collect(), /pending desktop handoff/);
  await assert.rejects(f.bridge.recover(), /Missing native source history/);
  assert.deepEqual(await f.bridge.status(), before);
  assert.equal(f.calls.relocations, 0);
});

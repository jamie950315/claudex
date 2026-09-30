import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { splitDesktopOriginal } from '../src/desktop-original-split.mjs';
import { fingerprint } from '../src/history.mjs';

const copy = value => structuredClone(value);
const turn = text => [
  { role: 'user', content: [{ type: 'text', text }] },
  { role: 'assistant', content: [{ type: 'text', text: `Reply to ${text}` }] },
];
const checkpoint = common => ({ count: common.messages.length, digest: fingerprint(common) });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claudex-original-split-'));
  const conversationId = randomUUID(), files = new Map(), reads = [];
  const common = messages => ({ meta: { cwd: root, timestamp: '2026-01-01T00:00:00.000Z' }, messages });
  const shared = common(turn('Shared request'));
  const canonical = common([...shared.messages, ...turn('Current pair branch')]);
  const resumed = common([...shared.messages, ...turn('Resumed original branch')]);
  const records = [];
  for (const [side, status, managed, history] of [
    ['claude', 'original', false, resumed], ['codex', 'current', true, canonical], ['claude', 'current', true, canonical],
  ]) {
    const nativeId = randomUUID(), path = join(root, `${nativeId}.jsonl`);
    const record = { id: randomUUID(), conversationId, side, status, managed, verified: true, nativeId, path, cwd: root,
      kind: managed ? side === 'codex' ? 'snapshot' : 'owner' : 'original',
      checkpoint: checkpoint(managed ? canonical : shared), bytes: 0, createdAt: 1,
      ...(managed ? {} : { retiredAt: 2 }) };
    records.push(record); files.set(path, { common: copy(history), record, busy: false, incompleteTail: false });
    await writeFile(path, JSON.stringify({ id: nativeId, history }) + '\n', { mode: 0o600 });
  }
  const adapters = Object.fromEntries(['codex', 'claude'].map(side => [side, {
    async inspect(record) {
      reads.push(record.nativeId);
      const file = files.get(record.path);
      await file.beforeRead?.(record);
      return { common: copy(file.common), nativeId: record.nativeId, path: record.path,
        bytes: (await readFile(record.path)).length, incompleteTail: file.incompleteTail };
    },
    async assertIdle(record) { if (files.get(record.path).busy) throw new Error('Native branch is busy.'); },
    async plan({ nativeId }) {
      return { nativeId, path: join(root, `${nativeId}.jsonl`), kind: side === 'codex' ? 'snapshot' : 'owner' };
    },
    async operationApplied(record, pending) { return files.get(record.path)?.operationId === pending.operationId; },
    async apply(record, history, pending) {
      files.set(record.path, { record, common: copy(history), busy: false, incompleteTail: false, operationId: pending.operationId });
      await writeFile(record.path, JSON.stringify({ id: record.nativeId, history }) + '\n');
    },
    async exists(record) { return files.has(record.path); },
  }]));
  const bridge = new DesktopBridge({ root, adapters, now: () => 123 });
  const state = { version: 2, conversations: { [conversationId]: {
    id: conversationId, cwd: root, title: 'Original branch test', canonical: checkpoint(canonical),
  } }, records, pending: null, audit: [] };
  await bridge.save(state);
  const original = records[0];
  const input = { bridge, conversationId, originalNativeId: original.nativeId,
    originalRecordId: original.id, expectedCheckpoint: checkpoint(resumed) };
  return { bridge, root, records, original, files, reads, input, canonical, shared, resumed,
    async setState(fn) { const state = await bridge.status(); fn(state); await bridge.save(state); },
    async replace(record, history) {
      files.get(record.path).common = copy(history);
      await writeFile(record.path, JSON.stringify({ id: record.nativeId, history }) + '\n');
    },
    async unchangedBy(fn, error) {
      const before = await bridge.status(); await assert.rejects(fn, error); assert.deepEqual(await bridge.status(), before);
    },
  };
}

test('explicit original splitting preserves both histories and exact discovery addressing', async () => {
  const f = await fixture();
  const before = await f.bridge.status();
  const bytes = await Promise.all(f.records.map(record => readFile(record.path)));
  const split = await splitDesktopOriginal(f.input), state = await f.bridge.status();
  assert.equal(split.changed, true); assert.notEqual(split.conversationId, f.input.conversationId);
  assert.deepEqual(state.conversations[f.input.conversationId], before.conversations[f.input.conversationId]);
  assert.deepEqual(state.records.slice(1), before.records.slice(1));
  const branch = state.conversations[split.conversationId];
  assert.equal(branch.title, before.conversations[f.input.conversationId].title);
  assert.deepEqual(branch.canonical, f.input.expectedCheckpoint);
  assert.deepEqual(branch.originalSplit.previousCheckpoint, checkpoint(f.shared));
  const moved = state.records.find(record => record.id === f.original.id);
  assert.equal(moved.conversationId, split.conversationId); assert.equal(moved.status, 'current');
  assert.equal(moved.managed, false); assert.equal(moved.retiredAt, undefined);
  assert.deepEqual(moved.checkpoint, f.input.expectedCheckpoint);
  assert.deepEqual(await Promise.all(f.records.map(record => readFile(record.path))), bytes);
  assert.deepEqual(await f.bridge.track({ side: 'claude', nativeId: f.original.nativeId, path: f.original.path }),
    { conversationId: split.conversationId, existing: true });
  assert.equal((await f.bridge.status()).records.filter(record => record.nativeId === f.original.nativeId).length, 1);
  assert.equal(f.bridge.current(state, f.input.conversationId, 'claude').nativeId, f.records[2].nativeId);
  assert.equal(f.bridge.current(state, split.conversationId, 'claude').nativeId, f.original.nativeId);
  await f.bridge.assertOriginalsUnchanged(state);
  assert.deepEqual(await f.bridge.sync(f.input.conversationId), { changed: false });
  assert.equal((await f.bridge.sync(split.conversationId)).changed, true);
  const synced = await f.bridge.status();
  assert.deepEqual(synced.conversations[f.input.conversationId].canonical, checkpoint(f.canonical));
  assert.deepEqual(synced.conversations[split.conversationId].canonical, f.input.expectedCheckpoint);
  assert.deepEqual(f.files.get(f.bridge.current(synced, split.conversationId, 'codex').path).common.messages,
    f.resumed.messages);
  assert.deepEqual(await Promise.all(f.records.map(record => readFile(record.path))), bytes);
});

test('a durable original split receipt makes the exact repeated request a no-op', async () => {
  const f = await fixture(); const split = await splitDesktopOriginal(f.input);
  const state = await f.bridge.status(), reads = f.reads.length;
  assert.deepEqual(await splitDesktopOriginal(f.input), { ...split, changed: false });
  assert.deepEqual(await f.bridge.status(), state); assert.equal(f.reads.length, reads);
  await f.unchangedBy(() => splitDesktopOriginal({ ...f.input, expectedCheckpoint: checkpoint(f.canonical) }), /receipt/);
});

test('original splitting refuses unknown identities, malformed checkpoints, imported or stopped enrollment', async () => {
  for (const mutation of [
    input => { input.originalRecordId = randomUUID(); },
    input => { input.originalNativeId = randomUUID(); },
    input => { input.expectedCheckpoint = { count: 0, digest: 'invalid' }; },
  ]) {
    const f = await fixture(); const input = { ...f.input }; mutation(input);
    await f.unchangedBy(() => splitDesktopOriginal(input), /exact|inspected/);
  }
  for (const mutateState of [
    state => { state.records[0].importPacket = true; },
    state => { state.records[0].verified = false; },
    state => { state.records[0].cwd = join(state.records[0].cwd, 'another-project'); },
    state => { state.conversations[state.records[0].conversationId].tracking = { status: 'stopped', stoppedAt: 1 }; },
    state => { state.records.push(copy(state.records[0])); },
  ]) {
    const f = await fixture(); await f.setState(mutateState);
    await f.unchangedBy(() => splitDesktopOriginal(f.input), /exact tracked/);
  }
});

test('pending, busy and incomplete branches remain unchanged instead of being split', async () => {
  const pending = await fixture(); await pending.setState(state => { state.pending = { phase: 'prepared' }; });
  await pending.unchangedBy(() => splitDesktopOriginal(pending.input), /pending Desktop handoff/);
  for (const index of [0, 1, 2]) {
    const f = await fixture(); f.files.get(f.records[index].path).busy = true;
    await f.unchangedBy(() => splitDesktopOriginal(f.input), /busy/);
    f.files.get(f.records[index].path).busy = false; f.files.get(f.records[index].path).incompleteTail = true;
    await f.unchangedBy(() => splitDesktopOriginal(f.input), /unfinished turn/);
  }
});

test('a rewritten saved prefix or changed current pair cannot create a split receipt', async () => {
  const source = await fixture();
  await source.replace(source.original, { ...source.resumed, messages: turn('Different prefix') });
  await source.unchangedBy(() => splitDesktopOriginal(source.input), /saved prefix/);
  for (const index of [1, 2]) {
    const f = await fixture();
    await f.replace(f.records[index], { ...f.canonical, messages: [...f.canonical.messages, ...turn('New current work')] });
    await f.unchangedBy(() => splitDesktopOriginal(f.input), /current pair changed/);
  }
});

test('metadata-only changes during either verification pass retain both enrollments', async () => {
  for (const index of [0, 1, 2]) {
    const f = await fixture(), record = f.records[index]; let reads = 0;
    f.files.get(record.path).beforeRead = async () => {
      if (++reads === 2) await writeFile(record.path,
        JSON.stringify({ id: record.nativeId, metadata: 'changed without a logical history change' }) + '\n');
    };
    await f.unchangedBy(() => splitDesktopOriginal(f.input), /Native history changed|between verification reads/);
  }
});

test('linear continuation is not classified as an independent branch', async () => {
  const f = await fixture();
  const continued = { ...f.canonical, messages: [...f.canonical.messages, ...turn('Linear continuation')] };
  await f.replace(f.original, continued);
  await f.unchangedBy(() => splitDesktopOriginal({ ...f.input, expectedCheckpoint: checkpoint(continued) }), /not independent branches/);
});

test('other superseded originals keep their history guards during explicit separation', async () => {
  const f = await fixture();
  const changed = { ...f.records[0], id: randomUUID(), nativeId: randomUUID(), side: 'codex' };
  await f.setState(state => { state.records.push(changed); });
  await f.unchangedBy(() => splitDesktopOriginal(f.input), /Superseded original/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDesktopWatch } from '../src/desktop-watch.mjs';
import { SyncEventInbox } from '../src/sync-events.mjs';
import { createSyncEventSource } from '../src/sync-event-source.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwsb-')));
  const state = { version: 2, pending: null, conversations: {}, records: [] };
  const f = { root, state, calls: [], statuses: [], discoveries: [], acknowledgements: [], clock: 0 };
  f.add = async (id, cold = false) => {
    state.conversations[id] = { id, title: id, ...(cold ? { discoveryMode: 'cold-import' } : {}) };
    const record = { id: randomUUID(), nativeId: randomUUID(), side: 'claude', conversationId: id,
      path: join(root, `${id}.jsonl`), status: 'current', verified: true, managed: false, kind: 'original' };
    await writeFile(record.path, 'Synthetic original history\n', { mode: 0o600 });
    state.records.push(record);
    return record;
  };
  f.runtime = { async codex() { return { async request() { throw new Error('Unexpected native metadata read.'); } }; },
    async ownedNativeIds() { return new Set(); } };
  f.inbox = new SyncEventInbox({ root });
  f.events = await createSyncEventSource({ root, runtime: f.runtime, inbox: f.inbox, settleMs: 60_000 });
  const acknowledge = f.events.acknowledge;
  f.events.acknowledge = async batch => { f.acknowledgements.push(structuredClone(batch)); return acknowledge(batch); };
  f.publish = (record, kind = 'completed') => f.inbox.publish({ side: record.side, nativeId: record.nativeId, kind });
  f.bridge = { async status() { return structuredClone(state); },
    async recover() { throw new Error('Unexpected recovery.'); }, async collect() {},
    async sync(id) {
      f.calls.push(id); f.clock += 2100;
      return await f.onSync?.(id) ?? { changed: true, incompleteTail: false };
    } };
  f.run = (options = {}) => runDesktopWatch({ root, bridge: f.bridge, runtime: f.runtime, config: {},
    events: f.events, now: () => f.clock, maxPasses: 1,
    discover: async options => { f.discoveries.push(options.onlyKeys ? [...options.onlyKeys] : null); return []; },
    writeStatus: async (_path, value) => { f.statuses.push(structuredClone(value)); },
    sleep: async () => { throw new Error('Completion-event mode must not poll.'); }, ...options });
  return f;
}

test('completion-event startup does not repeatedly inspect a streaming conversation between cold histories', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwsb-')));
  const state = { version: 2, pending: null, conversations: {}, records: [] };
  const calls = [], statuses = [];
  let clock = 0, discovering = 0;
  const add = async (id, cold = false) => {
    state.conversations[id] = { id, title: id, ...(cold ? { discoveryMode: 'cold-import' } : {}) };
    const record = { id: randomUUID(), nativeId: randomUUID(), side: 'claude', conversationId: id,
      path: join(root, `${id}.jsonl`), status: 'current', verified: true, managed: false, kind: 'original' };
    await writeFile(record.path, 'Synthetic original history\n', { mode: 0o600 });
    state.records.push(record);
    return record;
  };
  const streaming = await add('streaming');
  for (let index = 0; index < 4; index++) await add(`cold-${index}`, true);
  const runtime = { async codex() { return { async request() { throw new Error('Unexpected native metadata read.'); } }; },
    async ownedNativeIds() { return new Set(); } };
  const inbox = new SyncEventInbox({ root });
  const events = await createSyncEventSource({ root, runtime, inbox });
  const bridge = { async status() { return structuredClone(state); },
    async recover() { throw new Error('Unexpected recovery.'); }, async collect() {},
    async sync(id) {
      calls.push(id); clock += 2100;
      await writeFile(streaming.path, `Synthetic streaming fragment ${calls.length}\n`);
      await inbox.publish({ side: streaming.side, nativeId: streaming.nativeId, kind: 'started' });
      if (id === 'streaming') throw new Error('Unfinished tool call; handoff paused.');
      return { changed: false, incompleteTail: false };
    } };
  try {
    await runDesktopWatch({ root, bridge, runtime, config: {}, events, now: () => clock, maxPasses: 2,
      discover: async () => { discovering++; return []; },
      writeStatus: async (_path, value) => { statuses.push(structuredClone(value)); },
      sleep: async () => { throw new Error('Completion-event mode must not poll.'); } });
    assert.equal(calls.filter(id => id === 'streaming').length, 1,
      'streaming bytes and started events must not cause repeated full verification during startup');
    for (let index = 0; index < 4; index++) assert.equal(calls.filter(id => id === `cold-${index}`).length, 1);
    assert.equal(discovering, 1, 'the startup sweep must not repeatedly discover all native histories');
    const last = statuses.filter(status => status.running).at(-1);
    assert.equal(last.checkedConversationCount, 4);
    assert.notEqual(last.initialSweepCompletedAt, null);
    assert.match(last.waiting, /Unfinished tool call/);
    assert.equal(last.activePrioritySyncs, 0);
  } finally { await events.close(); await rm(root, { recursive: true, force: true }); }
});

test('startup services at most one completed conversation between cold histories without starving other recipients', async () => {
  const f = await fixture();
  const first = await f.add('first'), second = await f.add('second');
  for (let index = 0; index < 4; index++) await f.add(`cold-${index}`, true);
  f.onSync = async id => {
    if (id === 'cold-0') { await f.publish(first); await f.publish(second); }
    // A new genuine completion on the first target must survive the old ACK,
    // but the already pending second target gets the next boundary.
    if (id === 'first' && f.calls.filter(value => value === id).length === 2) await f.publish(first);
  };
  try {
    await f.run();
    assert.deepEqual(f.calls, ['first', 'second', 'cold-0', 'first', 'cold-1', 'second', 'cold-2', 'first', 'cold-3']);
    assert.deepEqual(f.discoveries, [null]);
    assert.equal(f.acknowledgements.length, 3);
    assert.equal((await f.inbox.list()).length, 0);
    assert.equal(f.statuses.filter(value => value.running).at(-1).eventSyncCount, 3);
  } finally { await f.events.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const phase of ['started', 'completed']) {
  test(`startup acknowledgement preserves a newer ${phase} revision published during its selected sync`, async () => {
    const f = await fixture(), active = await f.add('active');
    for (let index = 0; index < 3; index++) await f.add(`cold-${index}`, true);
    let original, newer, remainingAfterAck;
    f.onSync = async id => {
      if (id === 'cold-0') original = await f.publish(active);
      if (id === 'active' && f.calls.filter(value => value === id).length === 2) newer = await f.publish(active, phase);
      if (id === 'cold-1') remainingAfterAck = await f.inbox.list();
    };
    try {
      await f.run();
      assert.equal(remainingAfterAck.length, 1);
      assert.equal(remainingAfterAck[0].revision, newer.revision);
      assert.equal(remainingAfterAck[0].kind, phase);
      assert.equal(f.acknowledgements[0][0].revision, original.revision);
      assert.equal(f.calls.filter(id => id === 'active').length, phase === 'started' ? 2 : 3);
      assert.deepEqual(f.discoveries, [null]);
      if (phase === 'started') assert.equal((await f.inbox.list())[0].revision, newer.revision);
    } finally { await f.events.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}

test('startup leaves control events pending and discovers an unmapped completion revision only once', async () => {
  const f = await fixture();
  for (let index = 0; index < 4; index++) await f.add(`cold-${index}`, true);
  const unknown = { side: 'claude', nativeId: randomUUID() };
  const controls = ['started', 'configuration', 'reconnect', 'owner-wake'].map(kind => ({ side: 'claude', nativeId: randomUUID(), kind,
    ...(kind === 'owner-wake' ? { remoteId: 'cse_synthetic' } : {}) }));
  f.onSync = async id => {
    if (id !== 'cold-0') return;
    await f.publish(unknown);
    for (const event of controls) await f.inbox.publish(event);
  };
  try {
    await f.run();
    assert.deepEqual(f.calls, ['cold-0', 'cold-1', 'cold-2', 'cold-3']);
    assert.deepEqual(f.discoveries, [null, [`claude:${unknown.nativeId}`]]);
    assert.equal(f.acknowledgements.length, 0);
    assert.equal((await f.inbox.list()).length, 5);
  } finally { await f.events.close(); await rm(f.root, { recursive: true, force: true }); }
});

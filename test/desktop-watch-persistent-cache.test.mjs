import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDesktopWatch } from '../src/desktop-watch.mjs';
import { loadContextArchive, persistContextArchive } from '../src/context-archive.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-watch-persistent-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID(), codexId = randomUUID(), claudeId = randomUUID();
  const { archive } = await persistContextArchive({ root, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Synthetic request.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Synthetic response.' }] },
  ] });
  const checkpoint = { count: archive.messageCount, digest: archive.digest };
  const records = [];
  for (const [side, nativeId] of [['codex', codexId], ['claude', claudeId]]) {
    const path = join(root, `${nativeId}.jsonl`);
    await writeFile(path, 'Synthetic original history.\n', { mode: 0o600 });
    records.push({ id: randomUUID(), conversationId: id, nativeId, side, path, cwd: root,
      status: 'current', managed: false, kind: 'original', verified: true,
      checkpoint: { ...checkpoint }, ...(side === 'claude' ? { importPacket: true, packetVersion: 2 } : {}) });
  }
  const state = { pending: null, conversations: {
    [id]: { id, cwd: root, title: 'Synthetic cold conversation', discoveryMode: 'cold-import', canonical: checkpoint },
  }, records };
  const thread = { id: codexId, path: records[0].path, cwd: root, status: { type: 'notLoaded' } };
  const events = [], statuses = [];
  let clock = 1000;
  const f = { root, id, archive, state, records, thread, events, statuses,
    context: { version: 1, codexVersion: 'synthetic', claudeVersion: 'synthetic', root },
    advance(ms) { clock += ms; },
    clear() { events.length = 0; statuses.length = 0; },
  };
  const bridge = {
    async status() { return structuredClone(state); },
    async sync(conversationId) {
      assert.equal(conversationId, id);
      assert.equal(state.pending, null);
      events.push('sync');
      if (f.failSync) throw new Error('Native Codex history export: converted byte limit exceeded; no partial export is returned.');
      // Use actual authenticated archive reads, so the watcher observes all
      // manifest, page and chunk files rather than synthetic cache fixtures.
      await loadContextArchive({ root, archive });
      return { changed: false, incompleteTail: f.incompleteTail === true };
    },
    async recover() { events.push('recover'); state.pending = null; },
    async collect() { events.push('collect'); },
  };
  const codex = { async request(method, params) {
    assert.equal(method, 'thread/read');
    assert.equal(params.threadId, codexId);
    assert.equal(params.includeTurns, false);
    events.push('metadata');
    return { thread: structuredClone(thread) };
  } };
  f.run = () => runDesktopWatch({ root, bridge,
    runtime: { key: Buffer.alloc(32, 9), verificationCacheContext: async () => structuredClone(f.context),
      codex: async () => codex, ownedNativeIds: async () => new Set() },
    config: {}, discover: async () => { events.push('discover'); return []; },
    now: () => clock, pollMs: 10, maxPasses: 1,
    writeStatus: async (_path, status) => statuses.push(structuredClone(status)),
  });
  return f;
}

test('a new watcher reuses signed unchanged cold verification beyond the former validation deadline', async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.events.filter(event => event === 'sync').length, 1);
  const envelope = JSON.parse(await readFile(join(f.root, 'cold-verification', `${f.id}.json`), 'utf8'));
  assert.equal(envelope.payload.files.length, 4);
  assert.ok(envelope.payload.files.every(file => file.path.startsWith(join(f.root, 'history-assets') + '/')));
  f.clear(); f.advance(120_000);
  await f.run();
  assert.equal(f.events.includes('sync'), false);
  assert.equal(f.events.includes('metadata'), true);
  const progress = f.statuses.findLast(status => status.running);
  assert.equal(progress.checkedConversationCount, 1);
  assert.notEqual(progress.initialSweepCompletedAt, null);
});

test('an inactive unchanged unfinished native tail stays withheld without decoding its full prefix again', async t => {
  const f = await fixture(t);
  f.incompleteTail = true;
  const before = structuredClone(f.state);
  await f.run();
  f.clear(); f.advance(120_000);
  await f.run();
  assert.equal(f.events.includes('sync'), false);
  assert.deepEqual(f.state, before);
  await appendFile(f.records[0].path, 'The native tail changed.\n');
  f.clear(); await f.run();
  assert.equal(f.events.filter(event => event === 'sync').length, 1);
  assert.deepEqual(f.state, before);
});

for (const change of ['transcript', 'archive', 'ledger', 'native-path', 'native-cwd', 'context']) {
  test(`${change} changes invalidate persisted cold verification on restart`, async t => {
    const f = await fixture(t);
    await f.run();
    f.clear(); f.advance(1000);
    if (change === 'transcript') await appendFile(f.records[1].path, 'Changed native bytes.\n');
    if (change === 'archive') {
      // Keep authenticated bytes valid while proving identity changes force
      // semantic verification, including referenced assets outside JSONL.
      const path = join(f.root, 'history-assets', f.archive.hash);
      await utimes(path, new Date(100_000), new Date(100_000));
    }
    if (change === 'ledger') f.state.conversations[f.id].title = 'Changed logical title';
    if (change === 'native-path') {
      f.thread.path = join(f.root, 'different-native.jsonl');
      await writeFile(f.thread.path, 'Different native path.\n');
    }
    if (change === 'native-cwd') {
      f.thread.cwd = join(f.root, 'different-project');
      await mkdir(f.thread.cwd);
    }
    if (change === 'context') f.context.codexVersion = 'new-synthetic-version';
    await f.run();
    assert.equal(f.events.filter(event => event === 'sync').length, 1);
  });
}

test('a busy native thread cannot reuse persisted cold verification', async t => {
  const f = await fixture(t);
  await f.run(); f.clear();
  f.thread.status.type = 'active';
  await f.run();
  assert.equal(f.events.filter(event => event === 'sync').length, 1);
});

test('a cold conversation promoted to a managed owner still performs full lifecycle verification', async t => {
  const f = await fixture(t);
  await f.run(); f.clear();
  Object.assign(f.records[1], { managed: true, kind: 'owner' });
  await f.run();
  assert.equal(f.events.filter(event => event === 'sync').length, 1);
});

test('pending recovery completes before persisted proof reuse or discovery', async t => {
  const f = await fixture(t);
  await f.run(); f.clear();
  f.state.pending = { operationId: randomUUID(), record: f.records[1] };
  await f.run();
  assert.equal(f.events[0], 'recover');
  assert.equal(f.events.includes('sync'), false);
  assert.ok(f.events.indexOf('metadata') > f.events.indexOf('recover'));
  assert.ok(f.events.indexOf('discover') > f.events.indexOf('recover'));
});

test('a failed full read durably revokes the old proof even when its prior context is restored', async t => {
  const f = await fixture(t);
  await f.run();
  f.clear();
  f.context.codexVersion = 'changed-synthetic-version';
  f.failSync = true;
  await f.run();
  const envelope = JSON.parse(await readFile(join(f.root, 'cold-verification', `${f.id}.json`), 'utf8'));
  assert.equal(envelope.payload.invalidated, true);
  f.clear(); f.failSync = false;
  f.context.codexVersion = 'synthetic';
  await f.run();
  assert.equal(f.events.filter(event => event === 'sync').length, 1);
  const replacement = JSON.parse(await readFile(join(f.root, 'cold-verification', `${f.id}.json`), 'utf8'));
  assert.notEqual(replacement.payload.invalidated, true);
});

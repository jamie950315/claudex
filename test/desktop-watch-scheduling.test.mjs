import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDesktopWatch } from '../src/desktop-watch.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-watch-scheduling-')));
  const state = { pending: null, conversations: {}, records: [] };
  const events = [];
  let clock = 0;
  const f = { root, state, events,
    tick(ms) { clock += ms; },
    count(type, id) { return events.filter(event => event.type === type && (id === undefined || event.id === id)).length; },
    record(id, suffix) { return state.records.find(record => record.id === `${id}-${suffix}`); },
    async status() { return JSON.parse(await readFile(join(root, 'watcher-status.json'), 'utf8')); },
    addOrdinary(id) {
      state.conversations[id] = { id };
      state.records.push({ id, nativeId: id, conversationId: id, side: 'claude', managed: false, status: 'current' });
    },
    async addCold(id, { superseded = false } = {}) {
      state.conversations[id] = { id, discoveryMode: 'cold-import', canonical: { count: 2, digest: `${id}-digest` } };
      const records = [['codex', 'current', 'source'], ['claude', 'current', 'local']];
      if (superseded) records.push(['codex', 'original', 'superseded']);
      for (const [side, status, suffix] of records) {
        const nativeId = `${id}-${suffix}`;
        const path = join(root, `${nativeId}.jsonl`);
        await writeFile(path, 'original history\n');
        state.records.push({ id: nativeId, nativeId, conversationId: id, path, side, status,
          managed: false, kind: 'original', checkpoint: { count: 2, digest: `${id}-digest` } });
      }
    },
  };
  const codex = { async request(method, { threadId, includeTurns }) {
    assert.equal(method, 'thread/read');
    assert.equal(includeTurns, false);
    events.push({ type: 'metadata', id: threadId, at: clock });
    return { thread: { id: threadId, source: 'vscode', status: { type: 'notLoaded' } } };
  } };
  const bridge = {
    async status() { return structuredClone(state); },
    async recover() {
      events.push({ type: 'recover', at: clock });
      await f.onRecover?.();
      state.pending = null;
    },
    async track(source) {
      events.push({ type: 'track', id: source.id, at: clock });
      await f.onTrack?.(source);
      f.addOrdinary(source.id);
      return { conversationId: source.id, existing: false };
    },
    async sync(id) {
      events.push({ type: 'sync', id, at: clock });
      return await f.onSync?.(id) ?? { changed: false, incompleteTail: false };
    },
    async collect() { events.push({ type: 'collect', at: clock }); },
  };
  const discover = async (_config, known) => {
    events.push({ type: 'discover', at: clock });
    return (await f.onDiscover?.(known) ?? []).filter(source => !known.has(`${source.side}:${source.id}`));
  };
  f.run = options => runDesktopWatch({ root, bridge,
    runtime: { async codex() { return codex; }, async ownedNativeIds() { return new Set(); } },
    config: {}, discover, now: () => clock, pollMs: 10, maxPasses: 1,
    sleep: async ms => f.tick(ms), ...options });
  return f;
}

test('fresh and active conversations precede a backlog of 300 cold imports', async () => {
  const f = await fixture();
  for (let index = 0; index < 300; index++) await f.addCold(`cold-${index}`);
  f.addOrdinary('active');
  f.onDiscover = () => [{ side: 'claude', id: 'fresh', path: '/synthetic-fresh' }];
  await f.run();
  const synced = f.events.filter(event => event.type === 'sync').map(event => event.id);
  assert.deepEqual(synced.slice(0, 3), ['fresh', 'active', 'cold-0']);
  assert.equal(synced.length, 302);
  assert.equal(new Set(synced).size, 302);
});

test('a conversation created during a slow cold sweep is discovered and delivered before the next cold item', async () => {
  const f = await fixture();
  for (let index = 0; index < 4; index++) await f.addCold(`cold-${index}`);
  f.onSync = id => { if (id.startsWith('cold-')) f.tick(11); };
  f.onDiscover = () => f.count('sync', 'cold-0')
    ? [{ side: 'claude', id: 'fresh', path: '/synthetic-fresh' }] : [];
  await f.run();
  const synced = f.events.filter(event => event.type === 'sync');
  assert.deepEqual(synced.slice(0, 3).map(event => event.id), ['cold-0', 'fresh', 'cold-1']);
  assert.equal(synced.find(event => event.id === 'fresh').at, 11);
  assert.equal(f.count('track', 'fresh'), 1);
});

test('a superseded original changed after its cold item was visited is rechecked in the same sweep', async () => {
  const f = await fixture();
  await f.addCold('first', { superseded: true });
  await f.addCold('second');
  await f.addCold('third');
  f.onSync = async id => {
    f.tick(11);
    if (id === 'second') await writeFile(f.record('first', 'superseded').path, 'original history\ncompeting turn\n');
    if (id === 'first' && f.count('sync', 'first') === 2) {
      throw new Error('Superseded original first-superseded changed; no branch was selected.');
    }
  };
  await assert.rejects(f.run(), /Superseded original first-superseded changed/);
  assert.deepEqual(f.events.filter(event => event.type === 'sync').map(event => event.id), ['first', 'second', 'first']);
  assert.match((await f.status()).error, /Superseded original/);
});

for (const outcome of ['waiting', 'incomplete', 'racing-append']) {
  test(`dirty cold work stays in the foreground after ${outcome} until stable verification`, async () => {
    const f = await fixture();
    for (const id of ['first', 'second', 'third', 'fourth']) await f.addCold(id);
    f.onSync = async id => {
      f.tick(11);
      if (id === 'second') await writeFile(f.record('first', 'local').path, 'original history\nnew turn\n');
      if (id === 'first' && f.count('sync', 'first') === 2) {
        if (outcome === 'waiting') throw new Error('Claude turn is still running.');
        if (outcome === 'incomplete') return { changed: false, incompleteTail: true };
        await writeFile(f.record('first', 'local').path, 'original history\nnew turn\nracing append\n');
      }
    };
    await f.run();
    assert.deepEqual(f.events.filter(event => event.type === 'sync').map(event => event.id),
      ['first', 'second', 'first', 'third', 'first', 'fourth']);
    assert.equal((await f.status()).error, null);
  });
}

test('a cold item becoming a managed Claude owner receives every remaining foreground lifecycle check', async () => {
  const f = await fixture();
  for (const id of ['first', 'second', 'third', 'fourth']) await f.addCold(id);
  f.onSync = id => {
    f.tick(11);
    if (id === 'second') Object.assign(f.record('first', 'local'), { managed: true, kind: 'owner' });
  };
  await f.run();
  assert.deepEqual(f.events.filter(event => event.type === 'sync').map(event => event.id),
    ['first', 'second', 'first', 'third', 'first', 'fourth']);
  assert.equal(f.count('metadata', 'first-source'), 1);
});

test('foreground heartbeats neither starve a complete cold sweep nor renew absolute verification deadlines', async () => {
  const f = await fixture();
  for (const id of ['first', 'second', 'third', 'fourth']) await f.addCold(id);
  f.addOrdinary('active');
  f.onSync = id => { if (id !== 'active') f.tick(11); };
  await f.run({ maxPasses: 2, coldValidationMs: 30, sleep: async () => {} });
  const coldCalls = f.events.filter(event => event.type === 'sync' && event.id !== 'active');
  assert.deepEqual(coldCalls.map(event => event.id),
    ['first', 'second', 'third', 'fourth', 'first', 'second', 'third', 'fourth']);
  assert.equal(coldCalls[4].at, 44);
  assert.equal(f.count('sync', 'active'), 8);
  // Each sweep also refreshes discovery at its final operation boundary.
  assert.equal(f.count('discover'), 10);
});

test('waiting pending recovery stops the sweep and succeeds before any subsequent discovery or sync', async () => {
  const f = await fixture();
  await f.addCold('first');
  await f.addCold('second');
  f.onSync = id => {
    if (id === 'first' && f.count('sync', 'first') === 1) {
      f.state.pending = { phase: 'prepared' };
      throw new Error('Native response lost after apply.');
    }
  };
  f.onRecover = () => {
    if (f.count('recover') === 1) throw new Error('Destination is active.');
  };
  await f.run({ maxPasses: 2, sleep: async () => {
    assert.deepEqual(f.state.pending, { phase: 'prepared' });
    assert.deepEqual(f.events.filter(event => event.type !== 'metadata').map(event => event.type),
      ['discover', 'sync', 'recover']);
    assert.match((await f.status()).waiting, /Destination is active/);
  } });
  const lifecycle = f.events.filter(event => ['discover', 'sync', 'recover'].includes(event.type));
  assert.deepEqual(lifecycle.slice(0, 6).map(event => event.type), ['discover', 'sync', 'recover', 'recover', 'discover', 'sync']);
  assert.equal(f.state.pending, null);
  assert.equal(f.count('sync', 'second'), 1);
});

test('repeated interleaved discovery keeps unsupported diagnostics bounded to one discovery snapshot', async () => {
  const f = await fixture();
  for (let index = 0; index < 4; index++) await f.addCold(`cold-${index}`);
  f.onSync = () => { f.tick(11); };
  f.onDiscover = () => Array.from({ length: 25 }, (_, index) => ({ side: 'claude', id: `bad-${index}`, path: `/bad-${index}` }));
  f.onTrack = () => { throw new Error('Referenced Codex history is unavailable.'); };
  let status;
  await f.run({ maxPasses: 2, sleep: async () => { status = await f.status(); } });
  assert.equal(status.blockedSourceCount, 25);
  assert.equal(status.blockedSources.length, 20);
  assert.ok(f.count('discover') >= 4);
  assert.equal((await f.status()).error, null);
});

test('new discovery and delivery run between slow managed-owner inspections without skipping any lifecycle check', async () => {
  const f = await fixture();
  for (let index = 0; index < 8; index++) {
    const id = `owner-${index}`;
    await f.addCold(id);
    Object.assign(f.record(id, 'local'), { managed: true, kind: 'owner' });
  }
  f.onSync = id => { if (id.startsWith('owner-')) f.tick(11); };
  f.onDiscover = () => f.count('sync', 'owner-0')
    ? [{ side: 'claude', id: 'fresh', path: '/synthetic-fresh' }] : [];
  await f.run();
  const synced = f.events.filter(event => event.type === 'sync').map(event => event.id);
  assert.deepEqual(synced.slice(0, 3), ['owner-0', 'fresh', 'owner-1']);
  for (let index = 0; index < 8; index++) assert.equal(f.count('sync', `owner-${index}`), 1);
  assert.equal(f.count('sync', 'fresh'), 1);
  assert.equal(f.count('metadata'), 0);
});

test('discovery triggered by a slow fresh delivery resumes the existing sweep without recursive starvation', async () => {
  const f = await fixture();
  for (const id of ['first', 'second', 'third']) f.addOrdinary(id);
  f.onSync = () => { f.tick(11); };
  f.onDiscover = () => [
    ...(f.count('sync', 'first') ? [{ side: 'claude', id: 'fresh-a', path: '/synthetic-fresh-a' }] : []),
    ...(f.count('sync', 'fresh-a') ? [{ side: 'claude', id: 'fresh-b', path: '/synthetic-fresh-b' }] : []),
  ];
  await f.run();
  assert.deepEqual(f.events.filter(event => event.type === 'sync').map(event => event.id),
    ['first', 'fresh-a', 'second', 'fresh-b', 'third']);
  assert.equal(f.count('track', 'fresh-a'), 1);
  assert.equal(f.count('track', 'fresh-b'), 1);
});

test('an unsupported error after a newly discovered source is tracked remains a fatal sync failure', async () => {
  const f = await fixture();
  for (const id of ['first', 'second']) f.addOrdinary(id);
  const message = 'Native Codex history export: converted byte limit exceeded; no partial export is returned.';
  f.onSync = id => {
    f.tick(11);
    if (id === 'fresh') throw new Error(message);
  };
  f.onDiscover = () => f.count('sync', 'first')
    ? [{ side: 'claude', id: 'fresh', path: '/synthetic-fresh' }] : [];
  await assert.rejects(f.run(), error => error.message === message);
  assert.equal(f.count('track', 'fresh'), 1);
  assert.equal(f.count('sync', 'second'), 0);
  assert.equal((await f.status()).error, message);
});

test('a pending fresh delivery blocks further discovery and owner inspections until recovery succeeds', async () => {
  const f = await fixture();
  for (const id of ['first', 'second']) {
    await f.addCold(id);
    Object.assign(f.record(id, 'local'), { managed: true, kind: 'owner' });
  }
  f.onSync = id => {
    f.tick(11);
    if (id === 'fresh' && f.count('sync', 'fresh') === 1) {
      f.state.pending = { phase: 'prepared' };
      throw new Error('Native response lost after apply.');
    }
  };
  f.onDiscover = () => f.count('sync', 'first')
    ? [{ side: 'claude', id: 'fresh', path: '/synthetic-fresh' }] : [];
  f.onRecover = () => {
    if (f.count('recover') === 1) throw new Error('Destination is active.');
  };
  await f.run({ maxPasses: 2, sleep: async () => {
    assert.deepEqual(f.state.pending, { phase: 'prepared' });
    assert.equal(f.count('sync', 'second'), 0);
    assert.deepEqual(f.events.map(event => event.type),
      ['discover', 'sync', 'discover', 'track', 'sync', 'recover']);
    assert.match((await f.status()).waiting, /Destination is active/);
  } });
  const secondRecovery = f.events.findIndex((event, index) => event.type === 'recover'
    && f.events.slice(0, index).some(previous => previous.type === 'recover'));
  assert.ok(secondRecovery > 0);
  assert.equal(f.events[secondRecovery + 1].type, 'discover');
  assert.ok(f.events.findIndex(event => event.type === 'sync' && event.id === 'second') > secondRecovery);
  assert.equal(f.count('recover'), 2);
  assert.equal(f.state.pending, null);
});

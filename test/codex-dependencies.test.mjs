import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexDependencies, readCodexDependenciesForParents } from '../src/codex-dependencies.mjs';

const parent = '00000000-0000-4000-8000-000000000001';
const child = '00000000-0000-4000-8000-000000000002';
const nested = '00000000-0000-4000-8000-000000000003';
const unrelated = '00000000-0000-4000-8000-000000000004';
const spawn = (id, parentId) => ({ id, forkedFromId: null, source: { subAgent: { thread_spawn: { parent_thread_id: parentId, agent_path: null } } } });

function clientFor({ loaded = [], general = [], archived = [], ancestor = [], archivedAncestor = [], threads = {}, pageHook } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false);
        return { thread: threads[params.threadId] ?? { id: params.threadId } };
      }
      assert.ok(['thread/list', 'thread/loaded/list'].includes(method));
      if (pageHook) { const override = pageHook(method, params); if (override) return override; }
      const data = method === 'thread/loaded/list' ? loaded
        : params.ancestorThreadId ? params.archived ? archivedAncestor : ancestor
          : params.archived ? archived : general;
      return { data, nextCursor: null };
    },
  };
}

test('reads a freshly loaded fork absent from stored lists without loading it', async () => {
  const client = clientFor({ loaded: [child], threads: { [child]: { id: child, forkedFromId: parent } } });
  assert.deepEqual(await readCodexDependencies(client, parent), [{ id: child, parentId: parent, kind: 'fork' }]);
  assert.equal(client.calls.filter(call => call.method === 'thread/list').length, 4);
});

test('uses authoritative fork ancestry when native lists expose null', async () => {
  const client = clientFor({ general: [{ id: child, forkedFromId: null }],
    threads: { [child]: { id: child, forkedFromId: parent } } });
  assert.deepEqual(await readCodexDependencies(client, parent), [{ id: child, parentId: parent, kind: 'fork' }]);
});

test('finds hidden spawned agents and archived dependencies using ancestor inventories', async () => {
  const client = clientFor({ ancestor: [{ id: child }], archivedAncestor: [{ id: nested }],
    threads: { [child]: spawn(child, parent), [nested]: { id: nested, forkedFromId: parent } } });
  assert.deepEqual(await readCodexDependencies(client, parent), [
    { id: child, parentId: parent, kind: 'spawn' }, { id: nested, parentId: parent, kind: 'fork' },
  ]);
});

test('validates nested ancestor chains and returns only direct edges', async () => {
  const client = clientFor({ ancestor: [{ id: nested }], threads: { [nested]: spawn(nested, child), [child]: spawn(child, parent) } });
  assert.deepEqual(await readCodexDependencies(client, parent), [{ id: child, parentId: parent, kind: 'spawn' }]);
});

test('returns an empty inventory for unrelated general rows', async () => {
  const client = clientFor({ general: [{ id: unrelated }], archived: [{ id: child }], threads: { [child]: spawn(child, unrelated) } });
  assert.deepEqual(await readCodexDependencies(client, parent), []);
});

test('batch inventory shares global reads while authenticating each parent ancestry', async () => {
  const client = clientFor({ loaded: [child], general: [{ id: child }, { id: nested }],
    threads: { [child]: { id: child, forkedFromId: parent }, [nested]: spawn(nested, unrelated) },
    pageHook(method, params) {
      if (method === 'thread/list' && params.ancestorThreadId && !params.archived)
        return { data: [{ id: params.ancestorThreadId === parent ? child : nested }], nextCursor: null };
    },
  });
  const result = await readCodexDependenciesForParents(client, [parent, unrelated]);
  assert.deepEqual(result.get(parent), [{ id: child, parentId: parent, kind: 'fork' }]);
  assert.deepEqual(result.get(unrelated), [{ id: nested, parentId: unrelated, kind: 'spawn' }]);
  assert.equal(client.calls.filter(call => call.method === 'thread/loaded/list').length, 1);
  assert.equal(client.calls.filter(call => call.method === 'thread/list' && !call.params.ancestorThreadId).length, 2);
  assert.equal(client.calls.filter(call => call.method === 'thread/list' && call.params.ancestorThreadId).length, 4);
  assert.equal(client.calls.filter(call => call.method === 'thread/read').length, 2);
  client.calls.length = 0;
  await readCodexDependenciesForParents(client, [parent, unrelated]);
  assert.equal(client.calls.filter(call => call.method === 'thread/read').length, 2);
});

test('batch rejects an ancestor result belonging to another requested parent', async () => {
  const client = clientFor({ ancestor: [{ id: child }], threads: { [child]: spawn(child, parent) } });
  await assert.rejects(readCodexDependenciesForParents(client, [parent, unrelated]), /unrelated native identity/);
});

test('reads paginated archived rows and deduplicates identities', async () => {
  const client = clientFor({ loaded: [child], threads: { [child]: spawn(child, parent) }, pageHook(method, params) {
    if (method !== 'thread/list' || params.ancestorThreadId || !params.archived) return;
    return params.cursor ? { data: [{ id: child }], nextCursor: null } : { data: [], nextCursor: 'page-2' };
  } });
  assert.deepEqual(await readCodexDependencies(client, parent), [{ id: child, parentId: parent, kind: 'spawn' }]);
  assert.equal(client.calls.filter(call => call.method === 'thread/read').length, 1);
});

test('rejects repeated and malformed pagination cursors and oversized pages', async () => {
  for (const page of [{ data: [], nextCursor: 'same' }, { data: [], nextCursor: 1 },
    { data: [], nextCursor: '' }, { data: Array(101).fill(child), nextCursor: null }, { data: null }]) {
    await assert.rejects(readCodexDependencies(clientFor({ pageHook: () => page }), parent), /pagination|page is malformed/);
  }
});

test('enforces a finite page bound even with unique cursors', async () => {
  let count = 0;
  const client = clientFor({ pageHook: () => ({ data: [], nextCursor: `page-${++count}` }) });
  await assert.rejects(readCodexDependencies(client, parent), /page limit/);
  assert.equal(count, 100);
});

test('enforces the aggregate identity bound across independent inventories', async () => {
  let page = 0;
  const client = clientFor({ pageHook(method) {
    if (method === 'thread/loaded/list') {
      const first = page++ * 100;
      return { data: Array.from({ length: 100 }, (_, offset) =>
        `10000000-0000-4000-8000-${String(first + offset).padStart(12, '0')}`),
      nextCursor: page === 100 ? null : `page-${page}` };
    }
    return { data: [{ id: child }], nextCursor: null };
  } });
  await assert.rejects(readCodexDependencies(client, parent), /identity limit/);
  assert.equal(client.calls.some(call => call.method === 'thread/read'), false);
});

test('rejects malformed identities, changed reads and conflicting list metadata', async () => {
  await assert.rejects(readCodexDependencies(clientFor(), 'bad'), {
    code: 'CLAUDEX_DEPENDENCY_ANCHOR_BLOCKED', message: /parent identity/,
  });
  await assert.rejects(readCodexDependencies(clientFor({ loaded: ['bad'] }), parent), /native identity is malformed/);
  await assert.rejects(readCodexDependencies(clientFor({ loaded: [child], threads: { [child]: { id: nested } } }), parent), /native identity changed/);
  await assert.rejects(readCodexDependencies(clientFor({ general: [{ id: child, forkedFromId: unrelated }],
    threads: { [child]: { id: child, forkedFromId: parent } } }), parent), /listed fork identity changed/);
  await assert.rejects(readCodexDependencies(clientFor({ general: [spawn(child, unrelated)],
    threads: { [child]: spawn(child, parent) } }), parent), /listed spawn identity changed/);
});

test('rejects ambiguous or malformed native relationships', async () => {
  for (const thread of [{ ...spawn(child, parent), forkedFromId: unrelated },
    { id: child, forkedFromId: '' }, spawn(child, 'bad')]) {
    await assert.rejects(readCodexDependencies(clientFor({ loaded: [child], threads: { [child]: thread } }), parent), /identity is ambiguous|identity is malformed/);
  }
});

test('rejects unrelated ancestor results and cyclic ancestry', async () => {
  await assert.rejects(readCodexDependencies(clientFor({ ancestor: [{ id: child }] }), parent), /unrelated native identity/);
  await assert.rejects(readCodexDependencies(clientFor({ ancestor: [{ id: child }],
    threads: { [child]: spawn(child, nested), [nested]: spawn(nested, child) } }), parent), /ancestry cycle/);
});

test('propagates native read failures without retry or alternate operations', async () => {
  const client = clientFor({ loaded: [child] });
  const original = client.request;
  const nativeError = Object.assign(new Error('native read unavailable'), { code: 'NATIVE_TRANSPORT_ERROR' });
  client.request = async (method, params) => {
    if (method === 'thread/read') throw nativeError;
    return original(method, params);
  };
  await assert.rejects(readCodexDependencies(client, parent), error => error === nativeError);
});

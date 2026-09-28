import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCodexChats } from '../src/native-chat-catalog.mjs';

test('catalog uses metadata only and proves exact targets remain in unarchived inventory', async () => {
  const calls = []; let closed = false;
  const row = { id: 'original', name: 'Original title', cwd: '/project' };
  const client = { initialize: async () => {}, close: async () => { closed = true; },
    request: async (method, params) => { calls.push([method, params]); return method === 'thread/read' ? { thread: row } : { data: [row] }; } };
  const result = await discoverCodexChats({ sessionId: 'original' }, { clientFactory: () => client });
  assert.equal(result[0].registeredByHook, false);
  assert.equal(closed, true);
  assert.deepEqual(calls.map(c => c[0]), ['thread/read', 'thread/list']);
  assert.equal(calls[0][1].includeTurns, false);
  assert.equal(calls[1][1].archived, false);
  client.request = async method => method === 'thread/read' ? { thread: row } : { data: [] };
  assert.deepEqual(await discoverCodexChats({ sessionId: 'original' }, { clientFactory: () => client }), []);
});

test('incomplete discovery cannot select a supposedly unique title', async () => {
  const client = { initialize: async () => {}, close: async () => {}, request: async () => ({ data: [], nextCursor: 'more' }) };
  await assert.rejects(discoverCodexChats({ query: 'Title' }, { clientFactory: () => client }), /incomplete/);
});

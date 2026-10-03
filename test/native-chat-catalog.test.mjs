import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexChatSocket, discoverCodexChats } from '../src/native-chat-catalog.mjs';

test('configured Desktop discovery selects its shared listener without probing another backend', async () => {
  const syncRoot = await mkdtemp(join(tmpdir(), 'claudex-chat-socket-'));
  const codexHome = join(syncRoot, 'codex');
  assert.equal(await codexChatSocket({ syncRoot, codexHome }), join(codexHome, 'app-server-control', 'app-server-control.sock'));
  const launcher = { version: 1, shim: join(syncRoot, 'codex-launcher'), shimHash: 'a'.repeat(64) };
  await writeFile(join(syncRoot, 'desktop-launcher.json'), JSON.stringify(launcher), { mode: 0o600 });
  assert.equal(await codexChatSocket({ syncRoot, codexHome }), join(syncRoot, 'codex-shared', 'app.sock'));
  await assert.rejects(discoverCodexChats({ query: 'Synthetic title' }, { syncRoot, codexHome }), /native socket is not present/);
  await writeFile(join(syncRoot, 'desktop-launcher.json'), JSON.stringify({ ...launcher, pendingRuntime: {} }));
  await assert.rejects(codexChatSocket({ syncRoot, codexHome }), /incomplete/);
});

test('native chat endpoint selection rejects aliased or invalid launcher configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-chat-socket-guards-'));
  const source = join(root, 'source.json');
  await writeFile(source, '{}', { mode: 0o600 });
  for (const [name, create] of [['symlink', symlink], ['hardlink', link]]) {
    const syncRoot = join(root, name); await mkdir(syncRoot);
    await create(source, join(syncRoot, 'desktop-launcher.json'));
    await assert.rejects(codexChatSocket({ syncRoot, codexHome: root }));
  }
  const syncRoot = join(root, 'invalid'); await mkdir(syncRoot);
  await writeFile(join(syncRoot, 'desktop-launcher.json'), '{broken', { mode: 0o600 });
  await assert.rejects(codexChatSocket({ syncRoot, codexHome: root }), SyntaxError);
  await assert.rejects(codexChatSocket({ syncRoot: 'relative', codexHome: root }), /absolute/);
});

test('catalog uses metadata only and proves exact targets remain in unarchived inventory', async () => {
  const calls = []; let closed = false;
  const row = { id: 'original', name: 'Original title', cwd: '/project', source: 'vscode' };
  const client = { initialize: async () => {}, close: async () => { closed = true; },
    request: async (method, params) => { calls.push([method, params]); return method === 'thread/read' ? { thread: row } : { data: [row] }; } };
  const result = await discoverCodexChats({ sessionId: 'original' }, { clientFactory: () => client });
  assert.equal(result[0].registeredByHook, false);
  assert.equal(closed, true);
  assert.deepEqual(calls.map(c => c[0]), ['thread/read', 'thread/list']);
  assert.equal(calls[0][1].includeTurns, false);
  assert.equal(calls[1][1].archived, false);
  assert.deepEqual(calls[1][1].sourceKinds, ['cli', 'vscode', 'exec']);
  client.request = async method => method === 'thread/read' ? { thread: row } : { data: [] };
  assert.deepEqual(await discoverCodexChats({ sessionId: 'original' }, { clientFactory: () => client }), []);
});

test('catalog explicitly includes persistent exec origins hidden by native default source filtering', async () => {
  const row = { id: 'exec-original', name: 'Exec title', cwd: '/project', source: 'exec' };
  const calls = [];
  const client = { initialize: async () => {}, close: async () => {}, request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { thread: row };
    assert.equal(method, 'thread/list');
    return { data: params.sourceKinds?.includes('exec') ? [row] : [], nextCursor: null };
  } };
  const result = await discoverCodexChats({ sessionId: row.id }, { clientFactory: () => client });
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, row.id);
  assert.equal(result[0].title, row.name);
  assert.equal(result[0].cwd, row.cwd);
  assert.deepEqual(calls[1], ['thread/list', { limit: 100, archived: false, useStateDbOnly: true,
    sourceKinds: ['cli', 'vscode', 'exec'], searchTerm: row.name }]);
});

test('catalog rejects auxiliary and unknown sources while retaining exact-target and archive guards', async () => {
  const row = { id: 'exec-original', name: 'Exec title', cwd: '/project', source: 'exec' };
  let target = row, listed = [row];
  const client = { initialize: async () => {}, close: async () => {}, request: async method =>
    method === 'thread/read' ? { thread: target } : { data: listed, nextCursor: null } };
  const discover = () => discoverCodexChats({ sessionId: row.id }, { clientFactory: () => client });
  for (const source of ['unknown', { subAgent: {} }, undefined]) {
    target = { ...row, source };
    assert.deepEqual(await discover(), []);
    target = row;
    listed = [{ ...row, source }];
    assert.deepEqual(await discover(), []);
  }
  for (const change of [{ archived: true }, { id: 'different' }, { cwd: 'relative' }, { name: '' }]) {
    listed = [{ ...row, ...change }];
    assert.deepEqual(await discover(), []);
  }
});

test('incomplete discovery cannot select a supposedly unique title', async () => {
  const client = { initialize: async () => {}, close: async () => {}, request: async () => ({ data: [], nextCursor: 'more' }) };
  await assert.rejects(discoverCodexChats({ query: 'Title' }, { clientFactory: () => client }), /incomplete/);
});

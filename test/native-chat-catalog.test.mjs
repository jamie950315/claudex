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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { CodexWebSocketClient, connectCodexSocket } from '../src/codex-websocket.mjs';

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), 'cldx-ws-'));
  await chmod(root, 0o700);
  const socketPath = join(root, 's');
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/rpc' });
  const messages = [];
  wss.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(data);
      messages.push(message);
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'synthetic' } }));
      else handler?.(message, socket);
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  t.after(async () => { for (const client of wss.clients) client.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { socketPath, messages, wss };
}

test('public Unix WebSocket client initializes exactly and shares a backend without owning it', async t => {
  const { socketPath, messages, wss } = await fixture(t, (message, socket) => {
    if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: { method: message.method, params: message.params } }));
  });
  const a = new CodexWebSocketClient({ socketPath });
  const b = new CodexWebSocketClient({ socketPath });
  t.after(() => Promise.all([a.close(), b.close()]));
  assert.deepEqual(await a.initialize(), { userAgent: 'synthetic' });
  await b.initialize();
  assert.deepEqual(messages[0], { id: 1, method: 'initialize', params: { clientInfo: { name: 'claudex', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  assert.deepEqual(await a.readThread('one'), { method: 'thread/read', params: { threadId: 'one', includeTurns: true } });
  await a.close();
  assert.equal(wss.clients.size, 1);
  assert.deepEqual(await b.resumeThread('one', { cwd: '/tmp' }), { method: 'thread/resume', params: { cwd: '/tmp', threadId: 'one' } });
  assert.equal(messages.filter(message => message.method === 'initialized').length, 2);
});

test('write timeouts are explicit and never retried; closing rejects pending requests', async t => {
  const { socketPath, messages } = await fixture(t);
  const client = new CodexWebSocketClient({ socketPath, timeoutMs: 40 });
  t.after(() => client.close());
  await client.initialize();
  await assert.rejects(client.request('thread/inject_items'), /completion is unknown, do not retry writes automatically/);
  assert.equal(messages.filter(message => message.method === 'thread/inject_items').length, 1);
  const pending = assert.rejects(client.request('thread/archive'), /client closed/);
  await client.close();
  await pending;
  assert.equal(client.pending.size, 0);
});

test('notifications and interactive requests stay separate from RPC responses', async t => {
  let reply;
  const { socketPath, wss } = await fixture(t, message => { if (message.id === 'approval') reply = message; });
  const client = new CodexWebSocketClient({ socketPath });
  t.after(() => client.close());
  await client.initialize();
  const notification = once(client, 'notification');
  const socket = [...wss.clients][0];
  socket.send(JSON.stringify({ method: 'thread/updated', params: { threadId: 'one' } }));
  assert.equal((await notification)[0].method, 'thread/updated');
  socket.send(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval' }));
  for (let attempt = 0; attempt < 100 && !reply; attempt++) await delay(5);
  assert.ok(reply, 'The interactive request receives an explicit rejection');
  assert.equal(reply.error.code, -32601);
});

test('private directory and socket permissions are mandatory', async t => {
  const { socketPath } = await fixture(t);
  await chmod(socketPath, 0o666);
  await assert.rejects(connectCodexSocket(socketPath), /owner-only/);
});

test('an arbitrary socket alias is rejected even if its target is private', async t => {
  const { socketPath } = await fixture(t);
  const link = `${socketPath}-link`;
  await symlink(socketPath, link);
  await assert.rejects(connectCodexSocket(link), /Unexpected native Codex socket alias/);
});

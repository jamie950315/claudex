import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { serveCollaborationSocket, callCollaboration, runCollaborationMcp } from '../src/collaboration-transport.mjs';

async function fixture(t, dispatch = async value => value) {
  const root = await mkdtemp(join(tmpdir(), 'cldx-collab-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await serveCollaborationSocket({ root, dispatch });
  t.after(() => server.close());
  return { root, server };
}

test('private socket forwards one request and one response', async t => {
  const seen = [];
  const { root, server } = await fixture(t, async request => { seen.push(request); return { revision: 2 }; });
  assert.equal((await lstat(join(root, 'rpc.sock'))).mode & 0o777, 0o600);
  assert.deepEqual(await callCollaboration({ root, peer: 'claude', token: 'cap', method: 'status', params: { taskId: 'a' } }), { revision: 2 });
  assert.deepEqual(seen, [{ peer: 'claude', token: 'cap', method: 'status', params: { taskId: 'a' } }]);
  await assert.rejects(serveCollaborationSocket({ root, dispatch: () => null }), /already exists/);
  await server.close();
  await assert.rejects(lstat(join(root, 'rpc.sock')), { code: 'ENOENT' });
});

test('dispatcher failure remains an error and is not retried', async t => {
  let calls = 0;
  const { root } = await fixture(t, async () => { calls++; throw Object.assign(new Error('blocked'), { code: 'CONFLICT' }); });
  await assert.rejects(callCollaboration({ root, peer: 'codex', method: 'handoff', params: {} }), error => error.message === 'blocked' && error.code === 'CONFLICT');
  assert.equal(calls, 1);
});

test('operator resolution passes through the private transport without becoming an MCP tool', async t => {
  const { root } = await fixture(t);
  const params = { taskId: 'inspected-task', revision: 3, requestId: 'resolve-1', outcome: 'failed', reason: 'Inspected exited read-only work.' };
  const result = await callCollaboration({ root, peer: 'codex', token: 'controller', method: 'resolve', params });
  assert.equal(result.method, 'resolve');
  assert.deepEqual(result.params, params);
});

test('client rejects public directories and socket aliases', async t => {
  const { root, server } = await fixture(t);
  await chmod(root, 0o755);
  await assert.rejects(callCollaboration({ root, peer: 'codex', method: 'list' }), /owner-private/);
  await chmod(root, 0o700);
  await server.close();
  await symlink(join(root, 'missing'), join(root, 'rpc.sock'));
  await assert.rejects(callCollaboration({ root, peer: 'codex', method: 'list' }), /owner-private|symlink/);
});

test('MCP initialize, discovery, tool invocation and tool errors use JSON-RPC lines', async t => {
  const seen = [];
  const { root } = await fixture(t, async request => { seen.push(request); return { taskId: 'task-1', revision: 1 }; });
  const input = new PassThrough();
  const output = new PassThrough();
  let content = '';
  output.on('data', chunk => { content += chunk; });
  const running = runCollaborationMcp({ root, peer: 'codex', token: 'child-cap', input, output });
  const request = (id, method, params = {}) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  request(1, 'initialize', { protocolVersion: '2025-06-18' });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  request(2, 'tools/list');
  request(3, 'tools/call', { name: 'claudex_start', arguments: { provider: 'claude', cwd: '/tmp', prompt: 'work', requestId: 'once' } });
  request(4, 'tools/call', { name: 'claudex_wait', arguments: { taskId: 'task-1', timeoutMs: 30001 } });
  request(5, 'ping');
  input.end();
  await running;
  const rows = content.trim().split('\n').map(JSON.parse);
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.equal(byId.get(1).result.protocolVersion, '2025-06-18');
  assert.equal(byId.get(2).result.tools.length, 7);
  assert.deepEqual(JSON.parse(byId.get(3).result.content[0].text), { taskId: 'task-1', revision: 1 });
  assert.equal(byId.get(4).result.isError, true);
  assert.deepEqual(byId.get(5).result, {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].token, 'child-cap');
  assert.equal(seen[0].method, 'start');
  assert.equal(rows.length, 5);
});

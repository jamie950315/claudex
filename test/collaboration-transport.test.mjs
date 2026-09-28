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

test('model defaults use controller transport without exposing a settings MCP tool', async t => {
  const { root } = await fixture(t);
  const params = { defaultModels: { codex: 'test-codex', claude: null } };
  const result = await callCollaboration({ root, peer: 'codex', token: 'controller', method: 'models', params });
  assert.equal(result.method, 'models');
  assert.deepEqual(result.params, params);
});

test('MCP handoff forwards an explicit model or null and refuses malformed overrides', async t => {
  const seen = [];
  const { root } = await fixture(t, async request => { seen.push(request); return {}; });
  const input = new PassThrough(), output = new PassThrough();
  let content = '';
  output.on('data', chunk => { content += chunk; });
  const running = runCollaborationMcp({ root, peer: 'codex', token: 'worker', input, output });
  const values = ['destination-model', null, '', 'bad\nmodel', '界'.repeat(67), 23];
  values.forEach((model, index) => input.write(JSON.stringify({ jsonrpc: '2.0', id: index, method: 'tools/call', params: {
    name: 'claudex_handoff', arguments: { taskId: 'task', provider: 'claude', model, message: 'continue', requestId: `handoff-${index}`, revision: 1 },
  } }) + '\n'));
  input.end();
  await running;
  assert.deepEqual(seen.map(request => request.params.model), ['destination-model', null]);
  const rows = content.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.result.isError).length, 4);
});

test('MCP start and handoff advertise and enforce provider effort values including null', async t => {
  const seen = [];
  const { root } = await fixture(t, async request => { seen.push(request); return {}; });
  const input = new PassThrough(), output = new PassThrough();
  let content = '';
  output.on('data', chunk => { content += chunk; });
  const running = runCollaborationMcp({ root, peer: 'codex', token: 'worker', input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }) + '\n');
  for (const name of ['claudex_start', 'claudex_handoff']) {
    for (const [i, effort] of ['high', null, 'ultra', 'HIGH', 23].entries()) {
      const args = name === 'claudex_start' ? { cwd: root, prompt: 'test' } : { taskId: 'task', message: 'test', revision: 1 };
      input.write(JSON.stringify({ jsonrpc: '2.0', id: `${name}-${i}`, method: 'tools/call', params: {
        name, arguments: { ...args, provider: 'claude', effort, requestId: `${name}-${i}` },
      } }) + '\n');
    }
  }
  input.end();
  await running;
  // Concurrent MCP requests may reach independent sockets in either order.
  assert.deepEqual(Object.fromEntries(seen.map(request => [request.params.requestId, request.params.effort])), {
    'claudex_start-0': 'high', 'claudex_start-1': null,
    'claudex_handoff-0': 'high', 'claudex_handoff-1': null,
  });
  const rows = content.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.result.isError).length, 6);
  for (const definition of rows.find(row => row.id === 'list').result.tools.filter(item => ['claudex_start', 'claudex_handoff'].includes(item.name)))
    assert.ok(definition.inputSchema.properties.effort.enum.includes(null));
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

test('MCP forwards opt-in summary views and rejects unsupported views', async t => {
  const seen = [];
  const { root } = await fixture(t, async request => { seen.push(request); return { revision: 3 }; });
  const input = new PassThrough(), output = new PassThrough();
  let content = '';
  output.on('data', chunk => { content += chunk; });
  const running = runCollaborationMcp({ root, peer: 'codex', token: 'controller', input, output });
  for (const [id, name, args] of [[1, 'claudex_status', { taskId: 't', view: 'summary' }],
    [2, 'claudex_wait', { taskId: 't', view: 'summary', afterRevision: 3, timeoutMs: 0 }],
    [3, 'claudex_wait', { taskId: 't', view: 'unknown' }]]) {
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  }
  input.end();
  await running;
  assert.equal(seen.length, 2);
  assert.ok(seen.every(request => request.params.view === 'summary'));
  assert.equal(JSON.parse(content.trim().split('\n').find(line => JSON.parse(line).id === 3)).result.isError, true);
});

test('MCP directory grants are explicit bounded absolute paths on start only', async t => {
  const seen = [];
  const { root } = await fixture(t, async request => { seen.push(request); return {}; });
  const input = new PassThrough(), output = new PassThrough();
  let content = '';
  output.on('data', chunk => { content += chunk; });
  const running = runCollaborationMcp({ root, peer: 'codex', token: 'controller', input, output });
  const base = { provider: 'claude', cwd: root, prompt: 'work', requestId: 'scope' };
  const cases = [{ projectRoot: root, readOnlyDirs: ['/reference'], writableDirs: ['/extra'] },
    { projectRoot: 'relative' }, { readOnlyDirs: ['relative'] }, { writableDirs: Array(17).fill('/extra') }, { readOnlyDirs: null }];
  cases.forEach((params, id) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'claudex_start', arguments: { ...base, ...params } } }) + '\n'));
  input.end(); await running;
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].params.readOnlyDirs, ['/reference']);
  assert.deepEqual(seen[0].params.writableDirs, ['/extra']);
  assert.equal(content.trim().split('\n').map(JSON.parse).filter(row => row.result.isError).length, 4);
});

test('MCP native chat tools forward exact session targets without a resume or archive request', async t => {
  const seen = [];
  const { root } = await fixture(t, async request => { seen.push(request); return { state: 'queued' }; });
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const running = runCollaborationMcp({ root, peer: 'codex', token: 'controller', input, output });
  const calls = [ ['claudex_chat_list', { query: 'Project review', provider: 'claude', match: 'exact' }], ['claudex_chat_send', { provider: 'claude', sessionId: 'exact-session', expectedTitle: 'Project review', message: 'Pause new work.', requestId: 'note-1' }],
    ['claudex_chat_status', { messageId: 'message-1' }] ];
  calls.forEach(([name, args], id) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'));
  input.end(); await running;
  assert.deepEqual(seen.map(request => request.method).sort(), ['chat_list', 'chat_send', 'chat_status']);
  assert.equal(seen.find(request => request.method === 'chat_send').params.sessionId, 'exact-session');
  assert.equal(seen.find(request => request.method === 'chat_send').params.expectedTitle, 'Project review');
  assert.equal(seen.find(request => request.method === 'chat_list').params.query, 'Project review');
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
  assert.equal(byId.get(2).result.tools.length, 10);
  const tools = byId.get(2).result.tools;
  assert.match(tools.find(tool => tool.name === 'claudex_start').description, /deferredUntilParentExit.*CLAUDEX_YIELD/);
  assert.match(tools.find(tool => tool.name === 'claudex_handoff').description, /CLAUDEX_HANDOFF: no further tools or summary/);
  assert.deepEqual(JSON.parse(byId.get(3).result.content[0].text), { taskId: 'task-1', revision: 1 });
  assert.equal(byId.get(4).result.isError, true);
  assert.deepEqual(byId.get(5).result, {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].token, 'child-cap');
  assert.equal(seen[0].method, 'start');
  assert.equal(rows.length, 5);
});

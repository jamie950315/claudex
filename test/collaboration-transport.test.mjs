import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
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

test('a disconnected wait client releases its broker listener without cancelling queued work', async t => {
  let hub;
  const { root } = await fixture(t, envelope => hub.dispatch(envelope));
  hub = await new CollaborationHub({ root, run: async () => { throw new Error('No native inference in this test.'); } }).initialize();
  t.after(() => hub.close());
  hub.schedule = () => {};
  const task = await hub.dispatch({ peer: 'codex', token: hub.controllerToken, method: 'start', params: {
    provider: 'codex', cwd: root, prompt: 'Queued work', requestId: 'disconnected-wait',
  } });
  for (const selection of [{ taskId: task.taskId }, { targets: [{ taskId: task.taskId }] }]) {
    const waiting = callCollaboration({ root, peer: 'codex', token: hub.controllerToken,
      method: 'wait', params: { ...selection, timeoutMs: 300000 }, timeoutMs: 50 });
    const rejected = assert.rejects(waiting, /timed out/);
    for (let attempt = 0; hub.listenerCount('change') === 0 && attempt < 100; attempt++)
      await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(hub.listenerCount('change'), 1);
    await rejected;
    for (let attempt = 0; hub.listenerCount('change') !== 0 && attempt < 100; attempt++)
      await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(hub.listenerCount('change'), 0, 'a disconnected wait must release its listener and deadline timer');
  }
  assert.equal(hub.state.tasks[task.taskId].status, 'ready');
  assert.equal(hub.state.tasks[task.taskId].cancelRequested, false);
});

test('long single and multi waits return on revisions and clean up without launching work', async t => {
  let hub, invocations = 0;
  const { root } = await fixture(t, envelope => hub.dispatch(envelope));
  hub = await new CollaborationHub({ root, run: async () => { invocations++; throw new Error('No native inference in this test.'); } }).initialize();
  t.after(() => hub.close());
  hub.schedule = () => {};
  const task = await hub.dispatch({ peer: 'codex', token: hub.controllerToken, method: 'start', params: {
    provider: 'codex', cwd: root, prompt: 'Queued work', requestId: 'long-wait',
  } });
  for (const selection of [{ taskId: task.taskId }, { targets: [{ taskId: task.taskId }] }]) {
    const waiting = callCollaboration({ root, peer: 'codex', token: hub.controllerToken,
      method: 'wait', params: { ...selection, view: 'summary', timeoutMs: 300000 } });
    for (let attempt = 0; hub.listenerCount('change') === 0 && attempt < 100; attempt++)
      await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(hub.listenerCount('change'), 1);
    await hub.mutate(state => { state.tasks[task.taskId].revision++; });
    const result = await waiting;
    assert.equal(result.timedOut, false);
    assert.equal(result.changed, true);
    assert.equal(hub.listenerCount('change'), 0);
  }
  assert.equal(invocations, 0);
  assert.equal(hub.state.tasks[task.taskId].cancelRequested, false);
});

test('only validated long waits extend both socket deadlines and ordinary RPC stays bounded', async t => {
  const deadlines = [];
  const original = net.Socket.prototype.setTimeout;
  t.mock.method(net.Socket.prototype, 'setTimeout', function (timeout, callback) {
    deadlines.push(timeout);
    return original.call(this, timeout, callback);
  });
  const seen = [];
  const { root } = await fixture(t, async request => { seen.push(request); return {}; });
  await callCollaboration({ root, peer: 'codex', method: 'wait', params: { taskId: 'task', timeoutMs: 300000 } });
  assert.equal(deadlines.filter(value => value === 305000).length, 2, 'client and server must both allow the wait plus response grace');
  for (const request of [
    { method: 'status', params: { taskId: 'task' }, timeoutMs: 65001 },
    { method: 'wait', params: { taskId: 'task', timeoutMs: 0 }, timeoutMs: 305000 },
    { method: 'wait', params: { taskId: 'task', timeoutMs: 300000 }, timeoutMs: 305001 },
    ...[-1, 300001, 1.5, '300000', null].map(timeoutMs => ({ method: 'wait', params: { taskId: 'task', timeoutMs } })),
    { method: 'wait', params: { taskId: 'task', targets: [{ taskId: 'task' }], timeoutMs: 300000 } },
  ]) await assert.rejects(callCollaboration({ root, peer: 'codex', ...request }), /Invalid|Supply taskId/);
  assert.equal(seen.length, 1, 'invalid waits must not reach dispatch or acquire a longer socket');
});

test('MCP advertises five-minute waits, retains the 30-second default and forwards long waits without clamping', async t => {
  const deadlines = [];
  const original = net.Socket.prototype.setTimeout;
  t.mock.method(net.Socket.prototype, 'setTimeout', function (timeout, callback) {
    deadlines.push(timeout);
    return original.call(this, timeout, callback);
  });
  const seen = [];
  const { root } = await fixture(t, async request => { seen.push(request); return { changed: true }; });
  const input = new PassThrough(), output = new PassThrough();
  let content = '';
  output.on('data', chunk => { content += chunk; });
  const running = runCollaborationMcp({ root, peer: 'codex', token: 'controller', input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }) + '\n');
  for (const [id, timeoutMs] of [['default-wait', undefined], ['snapshot', 0]]) {
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'claudex_wait', arguments: { taskId: 'task', ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    } }) + '\n');
  }
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 'wait', method: 'tools/call', params: {
    name: 'claudex_wait', arguments: { targets: [{ taskId: 'task' }], timeoutMs: 300000 },
  } }) + '\n');
  await running;
  const rows = content.trim().split('\n').map(JSON.parse);
  const definition = rows.find(row => row.id === 'list').result.tools.find(tool => tool.name === 'claudex_wait');
  assert.equal(definition.inputSchema.properties.timeoutMs.maximum, 300000);
  assert.equal(definition.inputSchema.properties.timeoutMs.default, 30000);
  assert.equal(seen.find(request => request.params.targets).params.timeoutMs, 300000);
  assert.equal(deadlines.filter(value => value === 305000).length, 2);
  assert.equal(deadlines.filter(value => value === 35000).length, 1, 'the default MCP wait retains its five-second response grace');
  assert.equal(deadlines.filter(value => value === 5000).length, 1, 'a zero-timeout MCP snapshot retains its five-second response grace');
  assert.equal(rows.find(row => row.id === 'wait').result.isError, undefined);
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
  // Independent MCP requests may reach the socket in either order.
  assert.deepEqual(seen.toSorted((a, b) => a.params.requestId.localeCompare(b.params.requestId))
    .map(request => request.params.model), ['destination-model', null]);
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
  request(4, 'tools/call', { name: 'claudex_wait', arguments: { taskId: 'task-1', timeoutMs: 300001 } });
  request(5, 'ping');
  input.end();
  await running;
  const rows = content.trim().split('\n').map(JSON.parse);
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.equal(byId.get(1).result.protocolVersion, '2025-06-18');
  assert.equal(byId.get(2).result.tools.length, 11);
  const tools = byId.get(2).result.tools;
  assert.match(tools.find(tool => tool.name === 'claudex_start').description, /concurrent/i);
  assert.doesNotMatch(tools.find(tool => tool.name === 'claudex_start').description, /deferredUntilParentExit|CLAUDEX_YIELD/);
  assert.match(tools.find(tool => tool.name === 'claudex_handoff').description, /CLAUDEX_HANDOFF: no further tools or summary/);
  assert.deepEqual(JSON.parse(byId.get(3).result.content[0].text), { taskId: 'task-1', revision: 1 });
  assert.equal(byId.get(4).result.isError, true);
  assert.deepEqual(byId.get(5).result, {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].token, 'child-cap');
  assert.equal(seen[0].method, 'start');
  assert.equal(rows.length, 5);
});

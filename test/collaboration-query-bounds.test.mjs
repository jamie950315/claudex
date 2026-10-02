import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { callCollaboration, runCollaborationMcp, serveCollaborationSocket } from '../src/collaboration-transport.mjs';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-query-bounds-')));
  await chmod(root, 0o700);
  const hubs = [], servers = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    for (const hub of hubs) await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const hub = await new CollaborationHub({ root, run: async () => ({ text: 'synthetic result' }), ...options }).initialize();
    hub.schedule = () => {};
    hubs.push(hub);
    return hub;
  };
  const hub = await open();
  const call = (method, params = {}, token = hub.controllerToken, peer = 'codex') => hub.dispatch({ method, params, token, peer });
  const start = (requestId, extra = {}) => call('start', { provider: 'codex', cwd: root, prompt: 'Synthetic work', requestId, ...extra });
  const serve = async () => {
    const server = await serveCollaborationSocket({ root, dispatch: envelope => hub.dispatch(envelope) });
    servers.push(server);
  };
  return { root, hub, open, call, start, serve };
}

async function activeWorker(hub, taskId) {
  const token = 'b'.repeat(64);
  await hub.mutate(state => {
    const task = state.tasks[taskId];
    task.status = 'running'; task.generation = 1;
    task.active = { generation: 1, tokenHash: createHash('sha256').update(token).digest('hex'),
      seenChildren: {}, messageCount: task.messages.length, pid: null };
  });
  return token;
}

async function mcp(root, token, name, args) {
  const input = new PassThrough(), output = new PassThrough();
  let data = '';
  output.on('data', chunk => { data += chunk; });
  const done = runCollaborationMcp({ root, peer: 'codex', token, input, output });
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  await done;
  assert.ok(Buffer.byteLength(data) <= 1024 * 1024);
  return JSON.parse(data);
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error('Synthetic execution did not settle.');
}

test('escaped multi-wait outcomes fit the MCP envelope before any child acknowledgement', async t => {
  const { hub, root, call, start, serve } = await fixture(t);
  const parent = await start('escaped-parent');
  const token = await activeWorker(hub, parent.taskId);
  const children = [];
  for (let index = 0; index < 5; index++) children.push(await call('start', {
    provider: 'claude', cwd: root, prompt: 'Synthetic child', requestId: `escaped-child-${index}`,
  }, token));
  await hub.mutate(state => {
    for (const child of children) {
      const task = state.tasks[child.taskId];
      task.status = 'completed'; task.revision++;
      task.result = { text: '\\'.repeat(60000), generation: task.generation };
    }
  });
  const targets = children.map(child => ({ taskId: child.taskId, afterRevision: 2 }));
  const params = { targets, timeoutMs: 0, view: 'summary' };
  await serve();
  await assert.rejects(callCollaboration({ root, peer: 'codex', token, method: 'wait', params }),
    { code: 'CLAUDEX_RESPONSE_CAPACITY' });
  assert.deepEqual(hub.state.tasks[parent.taskId].active.seenChildren, {});
  const failed = await mcp(root, token, 'claudex_wait', params);
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.error.code, 'CLAUDEX_RESPONSE_CAPACITY');
  assert.deepEqual(hub.state.tasks[parent.taskId].active.seenChildren, {}, 'failed outer delivery must not hide outcomes on a later read');
  const delivered = await mcp(root, token, 'claudex_wait', { ...params, targets: targets.slice(0, 1) });
  assert.equal(delivered.result.isError, undefined);
  const value = JSON.parse(delivered.result.content[0].text);
  assert.equal(value.tasks[0].result.text, '\\'.repeat(60000));
  assert.deepEqual(hub.state.tasks[parent.taskId].active.seenChildren, { [children[0].taskId]: 2 });
});

test('large blocker inventories produce bounded list pages through the actual MCP facade', async t => {
  const { hub, root, start, serve } = await fixture(t, { allowWrite: true });
  const blocked = await start('blocked-template');
  const blocker = await start('blocker-template', { permission: 'workspace-write' });
  const blockers = new Set();
  await hub.mutate(state => {
    const blockedTemplate = structuredClone(state.tasks[blocked.taskId]);
    const blockerTemplate = structuredClone(state.tasks[blocker.taskId]);
    state.tasks[blocker.taskId].status = 'uncertain';
    blockers.add(blocker.taskId);
    for (let index = 1; index < 400; index++) {
      const id = randomUUID(); blockers.add(id);
      state.tasks[id] = { ...structuredClone(blockerTemplate), id, status: 'uncertain' };
    }
    for (let index = 1; index < 101; index++) {
      const id = randomUUID(); state.tasks[id] = { ...structuredClone(blockedTemplate), id };
    }
  });
  await serve();
  const response = await mcp(root, hub.controllerToken, 'claudex_list', { status: 'ready', limit: 100 });
  assert.equal(response.result.isError, undefined);
  const first = JSON.parse(response.result.content[0].text);
  assert.equal(first.tasks.length, 100);
  assert.equal(first.totalCount, 101);
  assert.ok(first.nextCursor);
  for (const task of first.tasks) {
    assert.equal(task.waitReason.kind, 'uncertain-overlap');
    assert.equal(task.waitReason.taskIds.length, 64);
    assert.equal(task.waitReason.totalTaskCount, 400);
    assert.equal(task.waitReason.truncated, true);
    assert.ok(task.waitReason.taskIds.every(id => blockers.has(id)));
  }
  const nextResponse = await mcp(root, hub.controllerToken, 'claudex_list', {
    status: 'ready', limit: 100, cursor: first.nextCursor,
  });
  const next = JSON.parse(nextResponse.result.content[0].text);
  assert.equal(next.tasks.length, 1);
  assert.equal(next.nextCursor, null);
  assert.equal(new Set([...first.tasks, ...next.tasks].map(task => task.id)).size, 101);
});

const report = { outcome: 'partial', summary: 'Synthetic completed portion',
  remaining: ['Synthetic remaining portion'], needs: [{ kind: 'dependency', description: 'Synthetic prerequisite' }],
  artifacts: [{ kind: 'file', reference: 'synthetic-output.txt', description: 'Synthetic artifact reference' }] };

test('a parent worker handoff report identifies its actual author, not a child self-report', async t => {
  const { hub, root, call, start } = await fixture(t);
  const parent = await start('parent-report-author');
  const token = await activeWorker(hub, parent.taskId);
  const child = await call('start', { provider: 'claude', cwd: root, prompt: 'Child work', requestId: 'child-report-author' }, token);
  await call('handoff', { taskId: child.taskId, provider: 'codex', message: 'Synthetic handoff',
    requestId: 'parent-handoff', revision: child.revision, report }, token);
  const saved = hub.state.tasks[child.taskId].messages.find(message => message.kind === 'handoff').report;
  assert.equal(saved.provenance, 'parent-worker-reported');
  assert.equal(saved.reporterTaskId, parent.taskId);
  assert.equal(saved.generation, hub.state.tasks[child.taskId].generation);
  assert.deepEqual(saved.remaining, report.remaining);
});

test('self-reported handoff context reaches the next synthetic invocation only after the outgoing boundary', async t => {
  const invocations = [];
  let finishFirst;
  const { hub, call, start } = await fixture(t, { mcp: async ({ token }) => ({ token }), run: async args => {
    invocations.push(args);
    if (invocations.length === 1) return new Promise(resolve => { finishFirst = resolve; });
    return { text: 'Synthetic successor completed' };
  } });
  const task = await start('handoff-context');
  delete hub.schedule; hub.schedule();
  await until(() => finishFirst);
  const current = await call('status', { taskId: task.taskId });
  const receipt = await call('handoff', { taskId: task.taskId, provider: 'claude', message: 'Continue the synthetic remainder',
    requestId: 'self-handoff-report', revision: current.revision, report }, invocations[0].mcp.token);
  assert.equal(receipt.handoffPending, true);
  assert.equal(invocations.length, 1, 'handoff metadata must not start a second owner');
  finishFirst({ text: 'CLAUDEX_HANDOFF' });
  await until(() => hub.state.tasks[task.taskId].status === 'completed');
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].provider, 'claude');
  const packet = JSON.parse(invocations[1].prompt.slice(invocations[1].prompt.lastIndexOf('\n') + 1));
  const handoff = packet.messages.find(message => message.kind === 'handoff');
  assert.deepEqual(handoff.report, { ...report, provenance: 'worker-self-reported',
    reporterTaskId: task.taskId, generation: 1, provider: 'codex' });
  assert.equal(packet.execution.generation, 2);
});

test('completed structured reports survive broker restart without inference or replay', async t => {
  let invocation, finish, invocationCount = 0;
  const { hub, open, call, start } = await fixture(t, { mcp: async ({ token }) => ({ token }), run: async args => {
    invocationCount++; invocation = args;
    return new Promise(resolve => { finish = resolve; });
  } });
  const task = await start('restart-report');
  delete hub.schedule; hub.schedule();
  await until(() => finish);
  await call('report', { taskId: task.taskId, requestId: 'save-report', report }, invocation.mcp.token);
  finish({ text: 'Synthetic partial result' });
  await until(() => hub.state.tasks[task.taskId].status === 'completed');
  const before = await call('status', { taskId: task.taskId, view: 'summary' });
  await hub.close();
  const reopened = await open();
  const after = await reopened.dispatch({ peer: 'codex', token: reopened.controllerToken, method: 'status',
    params: { taskId: task.taskId, view: 'summary' } });
  assert.deepEqual(after.outcome, before.outcome);
  assert.equal(after.outcome.provenance, 'worker-self-reported');
  assert.equal(after.outcome.outcome, 'partial');
  assert.equal(after.outcome.current, true);
  assert.equal(after.status, 'completed');
  assert.equal(after.resultFinal, true, 'execution completion remains separate from the partial self-report');
  assert.equal(invocationCount, 1);
  await assert.rejects(reopened.dispatch({ peer: 'codex', token: invocation.mcp.token, method: 'report',
    params: { taskId: task.taskId, requestId: 'old-generation', report } }), /expired/);
});

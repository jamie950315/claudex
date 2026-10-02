import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { createNativeActivity } from '../src/collaboration-activity.mjs';
import { validateOutcome } from '../src/collaboration-outcome.mjs';
import { serveCollaborationSocket, callCollaboration, runCollaborationMcp } from '../src/collaboration-transport.mjs';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-ai-first-')));
  await chmod(root, 0o700);
  const hub = await new CollaborationHub({ root, run: async () => ({ text: 'synthetic' }), ...options }).initialize();
  hub.schedule = () => {};
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method, params = {}, token = hub.controllerToken, peer = 'codex') => hub.dispatch({ method, params, token, peer });
  const start = (requestId, extra = {}) => call('start', { requestId, provider: 'codex', cwd: root, prompt: 'synthetic work', ...extra });
  return { hub, root, call, start };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(5); }
  throw new Error('Synthetic state did not settle');
}

test('list filters and query-bound pagination preserve all tasks without acknowledging outcomes', async t => {
  const { hub, call, start, root } = await fixture(t);
  for (let i = 0; i < 5; i++) await start(`list-${i}`);
  const first = await call('list', { limit: 2, parentId: null, project: root });
  const second = await call('list', { limit: 2, parentId: null, project: root, cursor: first.nextCursor });
  const third = await call('list', { limit: 2, parentId: null, project: root, cursor: second.nextCursor });
  assert.equal(new Set([...first.tasks, ...second.tasks, ...third.tasks].map(task => task.id)).size, 5);
  assert.equal(third.nextCursor, null);
  assert.equal(first.totalCount, 5);
  assert.equal(first.tasks[0].waitReason.kind, 'queued');
  await assert.rejects(call('list', { cursor: first.nextCursor, status: 'completed' }), { code: 'CLAUDEX_INVALID_CURSOR' });
  assert.deepEqual((await call('list', { status: 'completed' })).tasks, []);
  assert.equal(hub.running.size, 0);
});

test('uncertain blockers are exact and separate from the legacy global flag and capacity', async t => {
  const { hub, call, start } = await fixture(t, { allowWrite: true, maxWorkers: 1 });
  const first = join(hub.root, 'first'), second = join(hub.root, 'second');
  await mkdir(first); await mkdir(second);
  const uncertain = await start('uncertain', { cwd: first, permission: 'workspace-write' });
  const overlap = await start('overlap', { cwd: first });
  const independent = await start('independent', { cwd: second });
  await hub.mutate(state => { state.tasks[uncertain.taskId].status = 'uncertain'; });
  assert.deepEqual((await call('status', { taskId: overlap.taskId })).waitReason,
    { kind: 'uncertain-overlap', taskIds: [uncertain.taskId] });
  assert.equal((await call('list')).blockedByUncertainWork, true);
  assert.equal((await call('status', { taskId: independent.taskId })).waitReason.kind, 'queued');
  hub.running.set('synthetic-capacity', {});
  assert.deepEqual((await call('status', { taskId: independent.taskId })).waitReason,
    { kind: 'capacity', taskIds: ['synthetic-capacity'] });
  hub.running.clear();
});

test('multi-wait uses one bounded listener, returns all changed targets, and never starts work', async t => {
  const { hub, call, start } = await fixture(t);
  const a = await start('wait-a'), b = await start('wait-b');
  const waiting = call('wait', { targets: [a, b].map(task => ({ taskId: task.taskId, afterRevision: 1 })), timeoutMs: 1000 });
  await until(() => hub.listenerCount('change') === 1);
  await hub.mutate(state => { for (const id of [a.taskId, b.taskId]) state.tasks[id].revision++; });
  const response = await waiting;
  assert.equal(response.tasks.length, 2); assert.equal(response.changed, true); assert.equal(response.timedOut, false);
  assert.equal(hub.listenerCount('change'), 0); assert.equal(hub.running.size, 0);
  await assert.rejects(call('wait', { targets: [{ taskId: a.taskId }, { taskId: a.taskId }] }), { code: 'CLAUDEX_INVALID_WAIT' });
  await assert.rejects(call('wait', { taskId: a.taskId, targets: [{ taskId: b.taskId }] }), { code: 'CLAUDEX_INVALID_WAIT' });
  const timeout = await call('wait', { targets: [{ taskId: a.taskId, afterRevision: 2 }], timeoutMs: 5 });
  assert.equal(timeout.timedOut, true); assert.equal(timeout.tasks[0].changed, false);
});

test('multi-wait atomically acknowledges only returned terminal child outcomes', async t => {
  const { hub, call, start } = await fixture(t);
  const parent = await start('parent');
  const token = 'a'.repeat(64);
  const { createHash } = await import('node:crypto');
  await hub.mutate(state => {
    const task = state.tasks[parent.taskId]; task.status = 'running'; task.generation = 1;
    task.active = { generation: 1, tokenHash: createHash('sha256').update(token).digest('hex'), seenChildren: {}, messageCount: 1 };
  });
  const children = [];
  for (let i = 0; i < 3; i++) children.push(await call('start', { provider: 'claude', cwd: hub.root, prompt: 'child', requestId: `child-${i}` }, token));
  await hub.mutate(state => {
    for (const child of children.slice(0, 2)) {
      const task = state.tasks[child.taskId]; task.status = 'completed'; task.revision++;
      task.result = { text: 'child outcome', generation: 0 };
    }
  });
  const request = { targets: children.map(child => ({ taskId: child.taskId, afterRevision: 2 })), timeoutMs: 0 };
  const response = await call('wait', request, token);
  assert.equal(response.tasks.length, 2);
  assert.ok(response.tasks.every(task => task.result.text === 'child outcome'));
  assert.deepEqual(Object.keys(hub.state.tasks[parent.taskId].active.seenChildren).sort(), children.slice(0, 2).map(child => child.taskId).sort());
  assert.ok((await call('wait', request, token)).tasks.every(task => task.result === undefined));
  const before = structuredClone(hub.state.tasks[parent.taskId].active.seenChildren);
  await hub.mutate(state => {
    for (const child of children.slice(0, 2)) {
      const task = state.tasks[child.taskId]; task.messages.push({ kind: 'result', text: 'x'.repeat(400000) }); task.revision++;
    }
  });
  await assert.rejects(call('wait', { ...request, view: 'full' }, token), { code: 'CLAUDEX_RESPONSE_CAPACITY' });
  assert.deepEqual(hub.state.tasks[parent.taskId].active.seenChildren, before);
});

test('worker reports are generation fenced, self-reported and do not complete a task', async t => {
  let context, finish;
  const { hub, call, start } = await fixture(t, { mcp: async ({ token }) => ({ token }), run: async args => {
    context = args; return new Promise(resolve => { finish = resolve; });
  } });
  const task = await start('report'); delete hub.schedule; hub.schedule();
  await until(() => context);
  const token = context.mcp.token;
  const params = { taskId: task.taskId, requestId: 'report-once', report: { outcome: 'needs-input', summary: 'Need input',
    needs: [{ kind: 'information', description: 'Select a target' }], remaining: ['Apply the selected choice'], artifacts: [] } };
  const receipt = await call('report', params, token);
  assert.equal(receipt.status, 'running');
  assert.equal((await call('report', params, token)).replayed, true);
  await assert.rejects(call('report', { ...params, requestId: 'controller-report' }), { code: 'CLAUDEX_REPORT_OWNER_REQUIRED' });
  finish({ text: 'I need a target' }); await until(() => hub.state.tasks[task.taskId].status === 'completed');
  const final = await call('status', { taskId: task.taskId, view: 'summary' });
  assert.equal(final.resultFinal, true); assert.equal(final.outcome.outcome, 'needs-input');
  assert.equal(final.outcome.provenance, 'worker-self-reported');
  await assert.rejects(call('report', { ...params, requestId: 'stale-report' }, token), /expired/);
  hub.schedule = () => {};
  await call('send', { taskId: task.taskId, requestId: 'reopen', message: 'More input' });
  assert.equal((await call('status', { taskId: task.taskId })).outcome.current, false);
  assert.throws(() => validateOutcome({ ...params.report, arbitrary: true }), { code: 'CLAUDEX_INVALID_OUTCOME' });
});

test('activity diagnostics persist without task revision or child acknowledgement and reject stale callbacks', async t => {
  let context, finish, clock = 100;
  const { hub, call, start } = await fixture(t, { run: async args => { context = args; return new Promise(resolve => { finish = resolve; }); } });
  const task = await start('activity', { provider: 'claude', model: 'requested-model' }); delete hub.schedule; hub.schedule();
  await until(() => context);
  const before = await call('status', { taskId: task.taskId });
  const recorder = createNativeActivity('claude', { now: () => clock++ });
  await context.onActivity(recorder.observe({ type: 'assistant', message: { model: 'actual-model', content: 'SECRET' } }));
  const observed = await call('status', { taskId: task.taskId, view: 'summary' });
  assert.equal(observed.revision, before.revision); assert.equal(observed.model, 'requested-model');
  assert.equal(observed.execution.modelEvidence.main[0].model, 'actual-model');
  assert.equal(JSON.stringify(observed.execution).includes('SECRET'), false);
  await context.onEvent({ type: 'spawn', pid: 123456 });
  assert.equal((await call('status', { taskId: task.taskId, view: 'summary' })).execution.activity.lastNativeEventAt, 100);
  finish({ text: 'done', activity: recorder.snapshot() }); await until(() => hub.state.tasks[task.taskId].status === 'completed');
  const ended = await call('status', { taskId: task.taskId });
  await context.onActivity(recorder.observe({ type: 'assistant', message: { model: 'late-model' } }));
  assert.deepEqual((await call('status', { taskId: task.taskId })).lastExecution.activity, ended.lastExecution.activity);
});

test('structured errors and multi-wait survive actual Unix RPC and MCP facade', async t => {
  const { hub, root, start } = await fixture(t);
  const server = await serveCollaborationSocket({ root, dispatch: envelope => hub.dispatch(envelope) });
  t.after(() => server.close());
  const task = await start('rpc');
  const result = await callCollaboration({ root, peer: 'codex', token: hub.controllerToken, method: 'wait',
    params: { targets: [{ taskId: task.taskId }], timeoutMs: 0 } });
  assert.equal(result.tasks[0].id, task.taskId);
  const input = new PassThrough(), output = new PassThrough(); let data = '';
  output.on('data', chunk => { data += chunk; });
  const running = runCollaborationMcp({ root, peer: 'codex', token: hub.controllerToken, input, output });
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'claudex_status', arguments: { taskId: 'missing' },
  } }) + '\n');
  await running;
  const response = JSON.parse(data);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error.code, 'CLAUDEX_TASK_NOT_FOUND');
  assert.match(response.result.content[0].text, /Unknown task/);
});

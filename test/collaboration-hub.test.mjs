import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { writeJSON } from '../src/storage.mjs';

const pending = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function setup(t, run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cldx-hub-'));
  await chmod(root, 0o700);
  const hub = await new CollaborationHub({ root, run, ...options }).initialize();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, hub };
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw new Error('Timed out waiting for synthetic task state');
}

const request = (peer, method, params, token) => ({ peer, token, method, params });
const controller = (hub, peer, method, params) => request(peer, method, params, hub.controllerToken);
const status = (hub, id) => hub.dispatch(controller(hub, 'codex', 'status', { taskId: id }));

async function uncertainFixture(hub, root, extra = {}) {
  const id = randomUUID();
  const task = { id, parentId: null, returnTo: 'codex', owner: 'codex', cwd: root, permission: 'read-only',
    model: null, depth: 0, generation: 1, status: 'uncertain', revision: 3, createdAt: 1, updatedAt: 2,
    active: null, pendingHandoff: null, cancelRequested: false, error: 'Native process exited with an unknown result.',
    result: null, messages: [{ from: 'codex', kind: 'request', text: 'Inspect connectivity', at: 1 }],
    lastExecution: { generation: 1, pid: 123456, sessionId: null, startedAt: 1 }, ...extra };
  await hub.mutate(state => { state.tasks[id] = task; });
  return task;
}

const resolution = (hub, task, extra = {}) => controller(hub, 'codex', 'resolve', {
  taskId: task.id, revision: task.revision, outcome: 'failed', reason: 'The read-only connectivity invocation exited before returning a result.',
  requestId: 'resolve-inspected-work', ...extra,
});

test('controller resolves exited read-only uncertainty durably without replay or losing evidence', async t => {
  let calls = 0, inspections = 0;
  const { root, hub } = await setup(t, async () => { calls++; return { text: 'unexpected execution' }; }, {
    inspectProcessGroup: pid => { inspections++; return { pid, processAbsent: true, groupAbsent: true, inspectedAt: 123 }; },
  });
  const task = await uncertainFixture(hub, root);
  const request = resolution(hub, task);
  const receipt = await hub.dispatch(request);
  assert.equal(receipt.status, 'failed');
  const done = await status(hub, task.id);
  assert.equal(done.error, task.error);
  assert.deepEqual(done.messages, task.messages);
  assert.deepEqual(done.lastExecution, task.lastExecution);
  assert.equal(done.result, null);
  assert.equal(done.resolution.previousStatus, 'uncertain');
  assert.equal(done.resolution.previousRevision, 3);
  assert.equal(done.resolution.inspectedAt, 123);
  assert.equal((await hub.dispatch(request)).replayed, true);
  assert.equal(inspections, 1);
  assert.equal((await hub.dispatch(controller(hub, 'codex', 'list', {}))).blockedByUncertainWork, false);
  await assert.rejects(hub.dispatch(controller(hub, 'codex', 'send', { taskId: task.id, message: 'retry', requestId: 'no-replay' })), /cannot be implicitly restarted/);
  const persisted = await import('../src/storage.mjs').then(({ readJSON }) => readJSON(join(root, 'work.json')));
  assert.deepEqual(persisted.tasks[task.id].resolution, done.resolution);
  await hub.serial;
  assert.equal(calls, 0);
});

test('uncertain resolution refuses missing identity, live processes, inspection errors and stale revisions', async t => {
  for (const scenario of [
    { name: 'missing pid', extra: { lastExecution: null }, pattern: /identity is missing/ },
    { name: 'newer interrupted generation without pid', extra: { generation: 2, active: { generation: 2, pid: null } }, pattern: /identity is missing/ },
    { name: 'stale execution receipt', extra: { generation: 2 }, pattern: /identity is missing/ },
    { name: 'live leader', proof: { processAbsent: false, groupAbsent: true }, pattern: /both be confirmed absent/ },
    { name: 'live group', proof: { processAbsent: true, groupAbsent: false }, pattern: /both be confirmed absent/ },
    { name: 'permission denied', failure: Object.assign(new Error('permission denied'), { code: 'EPERM' }), pattern: /permission denied/ },
    { name: 'stale revision', params: { revision: 2 }, pattern: /revision changed/ },
    { name: 'success claim', params: { outcome: 'completed' }, pattern: /explicit failed outcome/ },
    { name: 'writable uncertainty', extra: { permission: 'workspace-write' }, pattern: /workspace reconciliation/ },
  ]) await t.test(scenario.name, async t => {
    const { root, hub } = await setup(t, async () => ({ text: 'unused' }), {
      inspectProcessGroup: pid => { if (scenario.failure) throw scenario.failure; return { pid, inspectedAt: 123, processAbsent: true, groupAbsent: true, ...scenario.proof }; },
    });
    const task = await uncertainFixture(hub, root, scenario.extra);
    await assert.rejects(hub.dispatch(resolution(hub, task, scenario.params)), scenario.pattern);
    assert.deepEqual(await status(hub, task.id), task);
  });
});

test('uncertain resolution refuses in-memory workers and unfinished descendants', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'unused' }), {
    inspectProcessGroup: pid => ({ pid, processAbsent: true, groupAbsent: true, inspectedAt: 123 }),
  });
  const task = await uncertainFixture(hub, root);
  hub.running.set(task.id, { controller: new AbortController(), promise: Promise.resolve() });
  await assert.rejects(hub.dispatch(resolution(hub, task)), /in-memory native worker/);
  hub.running.delete(task.id);
  const child = await uncertainFixture(hub, root, { parentId: task.id, depth: 1 });
  await assert.rejects(hub.dispatch(resolution(hub, task)), /descendant work first/);
  assert.equal((await status(hub, child.id)).status, 'uncertain');
});

test('worker cannot resolve its own uncertain descendant', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'unused' }), {
    inspectProcessGroup: pid => ({ pid, processAbsent: true, groupAbsent: true, inspectedAt: 123 }),
  });
  const token = 'a'.repeat(64);
  const parent = await uncertainFixture(hub, root, { status: 'running', active: {
    generation: 1, tokenHash: createHash('sha256').update(token).digest('hex'), messageCount: 1, pid: 123456, seenChildren: {},
  } });
  const child = await uncertainFixture(hub, root, { parentId: parent.id, depth: 1 });
  await assert.rejects(hub.dispatch({ ...resolution(hub, child), token }), /Only the controller/);
  await hub.mutate(state => { state.tasks[parent.id].status = 'failed'; state.tasks[parent.id].active = null; });
});

test('default uncertain resolution probe refuses the current live process', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'unused' }));
  const task = await uncertainFixture(hub, root, { lastExecution: { generation: 1, pid: process.pid } });
  await assert.rejects(hub.dispatch(resolution(hub, task)), /both be confirmed absent/);
});

test('app policy enables task-scoped writes for any project while explicit read-only remains read-only', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'synthetic done' }), { allowWrite: true, defaultPermission: 'workspace-write' });
  const write = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'claude', cwd: root, prompt: 'Write within the task', requestId: 'app-write' }));
  const read = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Inspect only', permission: 'read-only', requestId: 'app-read' }));
  assert.equal((await status(hub, write.taskId)).permission, 'workspace-write');
  assert.equal((await status(hub, read.taskId)).permission, 'read-only');
  const list = await hub.dispatch(controller(hub, 'codex', 'list', {}));
  assert.equal(list.limits.allProjects, true);
  assert.equal(list.limits.defaultPermission, 'workspace-write');
  await until(async () => (await status(hub, write.taskId)).status === 'completed' && (await status(hub, read.taskId)).status === 'completed');
});

test('a read-only parent does not inherit the app default write permission for its child', async t => {
  const gate = pending(); let parentToken;
  const { root, hub } = await setup(t, async ({ provider }) => provider === 'codex' ? gate.promise : { text: 'child done' }, {
    allowWrite: true, defaultPermission: 'workspace-write', mcp: ({ provider, token }) => { if (provider === 'codex') parentToken = token; return {}; },
  });
  const parent = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: root, permission: 'read-only', prompt: 'parent', requestId: 'parent-read' }));
  await until(() => parentToken);
  const child = await hub.dispatch(request('codex', 'start', { provider: 'claude', cwd: root, prompt: 'child', requestId: 'child-inherited' }, parentToken));
  const done = await until(async () => { const value = await status(hub, child.taskId); return value.status === 'completed' && value; });
  assert.equal(done.permission, 'read-only');
  await hub.dispatch(request('codex', 'status', { taskId: child.taskId }, parentToken));
  gate.resolve({ text: 'parent done' });
  await until(async () => (await status(hub, parent.taskId)).status === 'completed');
});

test('a writable default cannot bypass the broker write authorization', () => {
  assert.throws(() => new CollaborationHub({ root: '/tmp', run: async () => {}, defaultPermission: 'workspace-write' }), /authorization/);
});

test('start reaches a durable result without model inference', async t => {
  const { hub } = await setup(t, async ({ provider, prompt }) => {
    assert.equal(provider, 'codex');
    assert.match(prompt, /claudex-work-v1/);
    return { text: 'synthetic result' };
  });
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Inspect', requestId: 'start-1' }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value; });
  assert.equal(done.result.text, 'synthetic result');
  assert.equal(done.permission, 'read-only');
  assert.equal(done.messages.at(-1).kind, 'result');
  assert.equal(done.active, null);
});

test('handoff preserves identity in both directions and waits for old turn to finish', async t => {
  const calls = [];
  const tokens = new Map();
  const gates = [pending(), pending(), pending()];
  const { hub } = await setup(t, async ({ provider }) => {
    const index = calls.length;
    calls.push(provider);
    return gates[index].promise;
  }, { mcp: async ({ provider, token }) => { tokens.set(provider, token); return {}; } });
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Work', requestId: 'start-2' }));
  const first = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'running' && value; });
  const toClaude = await hub.dispatch(request('codex', 'handoff', { taskId: started.taskId, provider: 'claude', message: 'Continue', requestId: 'h1', revision: first.revision }, tokens.get('codex')));
  assert.equal(toClaude.handoffPending, true);
  await assert.rejects(hub.dispatch(request('codex', 'cancel', { taskId: started.taskId, requestId: 'after-handoff' }, tokens.get('codex'))), /relinquished ownership/);
  assert.deepEqual(calls, ['codex']);
  gates[0].resolve({ text: 'Codex turn complete' });
  const second = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'running' && value.owner === 'claude' && value; });
  assert.equal(second.id, started.taskId);
  assert.deepEqual(calls, ['codex', 'claude']);
  const toCodex = await hub.dispatch(request('claude', 'handoff', { taskId: started.taskId, provider: 'codex', message: 'Return', requestId: 'h2', revision: second.revision }, tokens.get('claude')));
  assert.equal(toCodex.handoffPending, true);
  assert.deepEqual(calls, ['codex', 'claude']);
  gates[1].resolve({ text: 'Claude turn complete' });
  await until(async () => { const value = await status(hub, started.taskId); return value.status === 'running' && value.owner === 'codex'; });
  assert.deepEqual(calls, ['codex', 'claude', 'codex']);
  gates[2].resolve({ text: 'Final result' });
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value; });
  assert.equal(done.result.text, 'Final result');
  assert.equal(done.messages.filter(item => item.kind === 'result').length, 3);
});

test('worker can read a child result but not an unrelated task', async t => {
  const parentGate = pending();
  const tokens = new Map();
  const { hub } = await setup(t, async ({ prompt }) => prompt.includes('parent work') ? parentGate.promise : { text: 'child result' }, {
    mcp: async ({ token, provider }) => { tokens.set(provider, token); return {}; },
  });
  const parent = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'parent work', requestId: 'parent' }));
  await until(() => tokens.get('codex'));
  const child = await hub.dispatch(request('codex', 'start', { provider: 'claude', cwd: '/tmp', prompt: 'child work', requestId: 'child' }, tokens.get('codex')));
  const childDone = await until(async () => { const value = await status(hub, child.taskId); return value.status === 'completed' && value; });
  assert.equal((await hub.dispatch(request('codex', 'status', { taskId: child.taskId }, tokens.get('codex')))).result.text, 'child result');
  const other = await hub.dispatch(controller(hub, 'claude', 'start', { provider: 'claude', cwd: '/tmp', prompt: 'other work', requestId: 'other' }));
  await assert.rejects(hub.dispatch(request('codex', 'status', { taskId: other.taskId }, tokens.get('codex'))), /descendants/);
  assert.equal(childDone.parentId, parent.taskId);
  parentGate.resolve({ text: 'parent result' });
  await until(async () => (await status(hub, parent.taskId)).status === 'completed');
});

test('request IDs deduplicate exact input and reject changed input', async t => {
  const { hub } = await setup(t, async () => ({ text: 'done' }));
  const params = { provider: 'codex', cwd: '/tmp', prompt: 'One', requestId: 'idempotent' };
  const first = await hub.dispatch(controller(hub, 'codex', 'start', params));
  const second = await hub.dispatch(controller(hub, 'codex', 'start', params));
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.replayed, true);
  await assert.rejects(hub.dispatch(controller(hub, 'codex', 'start', { ...params, prompt: 'Two' })), /reused with different input/);
});

test('missing and wrong-provider capabilities cannot control work', async t => {
  const gate = pending();
  let workerToken;
  const { hub } = await setup(t, async () => gate.promise, { mcp: async ({ token }) => { workerToken = token; return {}; } });
  await assert.rejects(hub.dispatch(request('codex', 'list', {})), /Invalid worker capability/);
  await assert.rejects(hub.dispatch(request('codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'No token', requestId: 'missing' })), /Invalid worker capability/);
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Authorized', requestId: 'authorized' }));
  await until(() => workerToken);
  await assert.rejects(hub.dispatch(request('claude', 'status', { taskId: started.taskId }, workerToken)), /expired or does not match/);
  gate.resolve({ text: 'done' });
  await until(async () => (await status(hub, started.taskId)).status === 'completed');
});

test('child admission observes worker capacity and cannot escalate write permission', async t => {
  const gate = pending();
  let workerToken;
  const { hub } = await setup(t, async () => gate.promise, {
    maxWorkers: 1, allowWrite: true,
    mcp: async ({ token }) => { workerToken = token; return {}; },
  });
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Parent', requestId: 'capacity-parent' }));
  await until(() => workerToken);
  await assert.rejects(hub.dispatch(request('codex', 'start', { provider: 'claude', cwd: '/tmp', prompt: 'Child', requestId: 'capacity-child' }, workerToken)), /Worker capacity reached/);
  await assert.rejects(hub.dispatch(request('codex', 'start', { provider: 'claude', cwd: '/tmp', prompt: 'Child', permission: 'workspace-write', requestId: 'write-child' }, workerToken)), /Workspace writes are not authorized/);
  gate.resolve({ text: 'done' });
  await until(async () => (await status(hub, started.taskId)).status === 'completed');
});

test('writable child yields the workspace and resumes its parent with a durable result', async t => {
  const order = [];
  const tokens = new Map();
  let hub;
  let parentId;
  let childId;
  const fixture = await setup(t, async ({ provider, permission, prompt }) => {
    order.push(provider);
    if (order.length === 1) {
      assert.equal(provider, 'codex');
      assert.equal(permission, 'workspace-write');
      const started = await hub.dispatch(request('codex', 'start', {
        provider: 'claude', cwd: '/tmp', prompt: 'Implement child work', permission: 'workspace-write', requestId: 'writable-child',
      }, tokens.get('codex')));
      childId = started.taskId;
      assert.equal(started.deferredUntilParentExit, true);
      await assert.rejects(hub.dispatch(request('codex', 'wait', { taskId: childId, timeoutMs: 0 }, tokens.get('codex'))), /deferred|yield/i);
      await delay(15);
      assert.deepEqual(order, ['codex'], 'child must not run before parent releases workspace');
      return { text: 'Yielding for child' };
    }
    if (order.length === 2) {
      assert.equal(provider, 'claude');
      assert.equal(permission, 'workspace-write');
      assert.equal((await status(hub, parentId)).status, 'waiting');
      return { text: 'Child changed the fixture' };
    }
    assert.equal(provider, 'codex');
    assert.match(prompt, /Child changed the fixture/);
    assert.equal((await status(hub, childId)).status, 'completed');
    return { text: 'Parent integrated child result' };
  }, { allowWrite: true, mcp: async ({ provider, token }) => { tokens.set(provider, token); return {}; } });
  hub = fixture.hub;
  const started = await hub.dispatch(controller(hub, 'codex', 'start', {
    provider: 'codex', cwd: '/tmp', prompt: 'Parent work', permission: 'workspace-write', requestId: 'writable-parent',
  }));
  parentId = started.taskId;
  const done = await until(async () => { const value = await status(hub, parentId); return value.status === 'completed' && value; });
  assert.deepEqual(order, ['codex', 'claude', 'codex']);
  assert.equal(done.result.text, 'Parent integrated child result');
  assert.equal((await status(hub, childId)).parentId, parentId);
  assert.equal(done.messages.filter(item => item.kind === 'child-result').length, 1);
});

test('cancelling a queued writable child releases its waiting parent', async t => {
  const order = [];
  let hub;
  let parentId;
  let childId;
  let parentToken;
  const fixture = await setup(t, async ({ provider, prompt }) => {
    order.push(provider);
    if (order.length === 1) {
      const child = await hub.dispatch(request('codex', 'start', {
        provider: 'claude', cwd: '/tmp', prompt: 'Queued child', permission: 'workspace-write', requestId: 'cancel-queued-child',
      }, parentToken));
      childId = child.taskId;
      assert.equal(child.deferredUntilParentExit, true);
      await hub.dispatch(controller(hub, 'codex', 'cancel', { taskId: childId, requestId: 'cancel-queued' }));
      return { text: 'Parent yielded' };
    }
    assert.equal(provider, 'codex');
    assert.match(prompt, /cancelled/);
    return { text: 'Parent handled cancelled child' };
  }, { allowWrite: true, mcp: async ({ provider, token }) => { if (provider === 'codex') parentToken = token; return {}; } });
  hub = fixture.hub;
  const started = await hub.dispatch(controller(hub, 'codex', 'start', {
    provider: 'codex', cwd: '/tmp', prompt: 'Parent', permission: 'workspace-write', requestId: 'cancel-queued-parent',
  }));
  parentId = started.taskId;
  const done = await until(async () => { const value = await status(hub, parentId); return value.status === 'completed' && value; });
  assert.deepEqual(order, ['codex', 'codex']);
  assert.equal((await status(hub, childId)).status, 'cancelled');
  assert.equal(done.result.text, 'Parent handled cancelled child');
});

test('unread fast child completion still resumes its parent', async t => {
  const order = [];
  let hub;
  let parentToken;
  let childId;
  const fixture = await setup(t, async ({ provider, prompt }) => {
    order.push(provider);
    if (provider === 'claude') return { text: 'Quick child result' };
    if (order.length === 1) {
      const child = await hub.dispatch(request('codex', 'start', {
        provider: 'claude', cwd: '/tmp', prompt: 'Quick child', requestId: 'fast-child',
      }, parentToken));
      childId = child.taskId;
      // Wait for the child in the fixture without consuming it through worker status/wait.
      await until(() => hub.state.tasks[childId]?.status === 'completed');
      return { text: 'Parent first result' };
    }
    assert.match(prompt, /Quick child result/);
    return { text: 'Parent saw quick child' };
  }, { mcp: async ({ provider, token }) => { if (provider === 'codex') parentToken = token; return {}; } });
  hub = fixture.hub;
  const started = await hub.dispatch(controller(hub, 'codex', 'start', {
    provider: 'codex', cwd: '/tmp', prompt: 'Parent', requestId: 'fast-parent',
  }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value.messages.filter(item => item.kind === 'result').length === 2 && value; });
  assert.deepEqual(order, ['codex', 'claude', 'codex']);
  assert.equal(done.result.text, 'Parent saw quick child');
});

test('follow-up queued during a turn runs in the next generation', async t => {
  const gate = pending();
  let calls = 0;
  const { hub } = await setup(t, async () => ++calls === 1 ? gate.promise : { text: 'second result' });
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'First', requestId: 'follow-start' }));
  await until(async () => (await status(hub, started.taskId)).status === 'running');
  await hub.dispatch(controller(hub, 'codex', 'send', { taskId: started.taskId, message: 'Second', requestId: 'follow-send' }));
  gate.resolve({ text: 'first result' });
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value.messages.filter(item => item.kind === 'result').length === 2 && value; });
  assert.equal(calls, 2);
  assert.equal(done.result.text, 'second result');
});

test('a requeued task remains tracked by its current native runner', async t => {
  const firstGate = pending();
  const secondGate = pending();
  let calls = 0;
  const { hub } = await setup(t, async () => ++calls === 1 ? firstGate.promise : secondGate.promise, { maxWorkers: 3 });
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'First', requestId: 'track-start' }));
  await until(async () => (await status(hub, started.taskId)).status === 'running');
  await hub.dispatch(controller(hub, 'codex', 'send', { taskId: started.taskId, message: 'Second', requestId: 'track-send' }));
  const listener = () => {
    if (hub.state.tasks[started.taskId]?.status === 'ready') { hub.off('change', listener); hub.schedule(); }
  };
  hub.on('change', listener);
  firstGate.resolve({ text: 'first result' });
  await until(() => calls === 2);
  hub.off('change', listener);
  await delay(10);
  const observed = { status: hub.state.tasks[started.taskId].status, tracked: hub.running.has(started.taskId) };
  secondGate.resolve({ text: 'second result' });
  await until(async () => (await status(hub, started.taskId)).status === 'completed');
  assert.equal(observed.status, 'running');
  assert.equal(observed.tracked, true, 'the second native turn must remain cancellable and visible to close');
});

test('cancellation aborts the runner and records a terminal state', async t => {
  let aborted = false;
  const { hub } = await setup(t, async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('stopped'), { executionUncertain: false })); }, { once: true });
  }));
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Long', requestId: 'cancel-start' }));
  await until(async () => (await status(hub, started.taskId)).status === 'running');
  await hub.dispatch(controller(hub, 'codex', 'cancel', { taskId: started.taskId, requestId: 'cancel' }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'cancelled' && value; });
  assert.equal(aborted, true);
  assert.equal(done.active, null);
});

test('restart marks in-flight work uncertain and never replays it', async t => {
  let calls = 0;
  const gate = pending();
  const root = await mkdtemp(join(tmpdir(), 'cldx-hub-crash-'));
  await chmod(root, 0o700);
  const oldHub = await new CollaborationHub({ root, run: async () => { calls++; return gate.promise; } }).initialize();
  const started = await oldHub.dispatch(controller(oldHub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Crash', requestId: 'crash' }));
  await until(async () => (await status(oldHub, started.taskId)).status === 'running' && calls === 1);
  await until(() => !oldHub.pumping);
  oldHub.closed = true; // Simulate process death without cancelling or completing the native turn.
  await oldHub.serial;
  const recovered = await new CollaborationHub({ root, run: async () => { calls++; return { text: 'replayed' }; } }).initialize();
  t.after(async () => { await recovered.close(); await rm(root, { recursive: true, force: true }); });
  const value = await status(recovered, started.taskId);
  assert.equal(value.status, 'uncertain');
  await delay(20);
  assert.equal(calls, 1);
  // The unresolved old runner represents a process that disappeared before writing completion.
});

test('read-only broker refuses a saved ready writable task before native dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-hub-policy-'));
  await chmod(root, 0o700);
  const id = randomUUID();
  const now = Date.now();
  await writeJSON(join(root, 'work.json'), { version: 1, requests: {}, tasks: {
    [id]: { id, parentId: null, returnTo: 'codex', owner: 'codex', cwd: '/tmp',
      permission: 'workspace-write', model: null, depth: 0, generation: 0,
      status: 'ready', revision: 1, createdAt: now, updatedAt: now, active: null,
      pendingHandoff: null, cancelRequested: false, error: null, result: null,
      messages: [{ from: 'codex', kind: 'request', text: 'Previously authorized work', at: now }],
    },
  } });
  let calls = 0;
  const hub = await new CollaborationHub({ root, allowWrite: false, run: async () => { calls++; return { text: 'must not run' }; } }).initialize();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  hub.schedule();
  const failed = await until(async () => { const value = await status(hub, id); return value.status === 'failed' && value; });
  assert.equal(calls, 0);
  assert.match(failed.error, /no longer authorizes workspace writes/);
  assert.equal(failed.active, null);
});

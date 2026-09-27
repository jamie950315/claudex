import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { readJSON } from '../src/storage.mjs';

const pending = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function setup(t, run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cldx-observe-'));
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
const packet = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
const results = task => task.messages.filter(item => item.kind === 'result').length;

test('a waiting intermediate task that exceeds context capacity reports its failure to its parent', async t => {
  const leafGate = pending();
  let hub, middleId;
  const leafIds = [];
  const fixture = await setup(t, async ({ provider, prompt, mcp }) => {
    const task = packet(prompt);
    if (task.parentId === null) {
      middleId = (await hub.dispatch(request(provider, 'start', {
        provider: 'claude', cwd: hub.root, prompt: 'Collect child results', requestId: 'middle-task',
      }, mcp.token))).taskId;
      return { text: 'Waiting for the intermediate task' };
    }
    if (provider === 'claude') {
      for (let index = 0; index < 3; index++) leafIds.push((await hub.dispatch(request(provider, 'start', {
        provider: 'codex', cwd: hub.root, prompt: 'Return the synthetic result', requestId: `leaf-${index}`,
      }, mcp.token))).taskId);
      return { text: 'Waiting for child results' };
    }
    return leafGate.promise;
  }, { mcp: async ({ token }) => ({ token }) });
  hub = fixture.hub;
  const started = await hub.dispatch(controller(hub, 'codex', 'start', {
    provider: 'codex', cwd: hub.root, prompt: 'Root task', requestId: 'context-root',
  }));
  await until(() => hub.state.tasks[started.taskId]?.status === 'waiting'
    && hub.state.tasks[middleId]?.status === 'waiting' && leafIds.length === 3
    && leafIds.every(id => hub.state.tasks[id]?.status === 'running') && !hub.pumping);
  hub.schedule = () => {};
  leafGate.resolve({ text: 'x'.repeat(65536) });
  await until(() => leafIds.every(id => hub.state.tasks[id].status === 'completed') && hub.running.size === 0);
  const middle = await status(hub, middleId);
  assert.equal(middle.status, 'failed');
  assert.match(middle.error, /Child results exceed task context capacity/);
  assert.equal(middle.messages.filter(message => message.kind === 'child-result').length, 3);
  const parent = await status(hub, started.taskId);
  assert.equal(parent.status, 'ready', 'the root must resume with the failure instead of waiting forever');
  const notifications = parent.messages.filter(message => message.kind === 'child-result' && message.from === middleId);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].sourceRevision, middle.revision);
  assert.equal(JSON.parse(notifications[0].text).status, 'failed');
});

test('cancelling a queued child delivers its final revision once and an observing parent does not rerun', async t => {
  const calls = [];
  let hub, parentToken, childId, cancelReceipt, observed;
  const fixture = await setup(t, async ({ provider }) => {
    calls.push(provider);
    if (calls.length > 1) return { text: 'Unexpected parent rerun' };
    hub.schedule = () => {};
    const child = await hub.dispatch(request('codex', 'start', {
      provider: 'claude', cwd: '/tmp', prompt: 'Queued child', permission: 'workspace-write', requestId: 'queued-child',
    }, parentToken));
    childId = child.taskId;
    assert.notEqual(child.deferredUntilParentExit, true);
    cancelReceipt = await hub.dispatch(controller(hub, 'codex', 'cancel', { taskId: childId, requestId: 'cancel-queued-child' }));
    // The parent reads the cancelled child's final state before ending its turn.
    observed = await hub.dispatch(request('codex', 'status', { taskId: childId }, parentToken));
    delete hub.schedule;
    return { text: 'Parent handled the cancelled child' };
  }, { allowWrite: true, mcp: async ({ provider, token }) => { if (provider === 'codex') parentToken = token; return {}; } });
  hub = fixture.hub;
  const started = await hub.dispatch(controller(hub, 'codex', 'start', {
    provider: 'codex', cwd: '/tmp', prompt: 'Parent', permission: 'workspace-write', requestId: 'cancel-observer-parent',
  }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value; });
  await delay(20);
  assert.deepEqual(calls, ['codex'], 'an observed cancelled child must not trigger another parent generation');
  const child = await status(hub, childId);
  assert.equal(child.status, 'cancelled');
  assert.equal(cancelReceipt.cancelAccepted, true);
  assert.equal(cancelReceipt.cancelPending, false);
  assert.equal(cancelReceipt.terminal, true);
  assert.equal(cancelReceipt.revision, child.revision);
  assert.equal(observed.revision, child.revision);
  const delivered = done.messages.filter(item => item.kind === 'child-result' && item.from === childId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sourceRevision, child.revision, 'delivery must carry the final child revision');
  assert.equal((await status(hub, started.taskId)).revision, done.revision);
  assert.equal(done.resultFinal, true);
  assert.equal(done.resultRole, 'final');
});

test('cancelling terminal work is an idempotent no-op that keeps its revision across restart', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'Finished answer' }));
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Work', requestId: 'terminal-start' }));
  const before = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value; });
  const cancel = controller(hub, 'codex', 'cancel', { taskId: started.taskId, requestId: 'late-cancel' });
  const receipt = await hub.dispatch(cancel);
  assert.equal(receipt.cancelAccepted, false);
  assert.equal(receipt.cancelPending, false);
  assert.equal(receipt.terminal, true);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.revision, before.revision);
  const after = await status(hub, started.taskId);
  assert.equal(after.revision, before.revision);
  assert.equal(after.cancelRequested, false);
  assert.deepEqual(after.result, before.result);
  assert.equal(after.resultFinal, true);
  assert.deepEqual(await hub.dispatch(cancel), { ...receipt, replayed: true });
  const other = await hub.dispatch(controller(hub, 'codex', 'cancel', { taskId: started.taskId, requestId: 'late-cancel-2' }));
  assert.equal(other.cancelAccepted, false);
  assert.equal((await status(hub, started.taskId)).revision, before.revision);
  await hub.close();
  const reopened = await new CollaborationHub({ root, run: async () => ({ text: 'unused' }) }).initialize();
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.dispatch(controller(reopened, 'codex', 'cancel', { taskId: started.taskId, requestId: 'late-cancel' })),
    { ...receipt, replayed: true });
  assert.equal((await status(reopened, started.taskId)).revision, before.revision);
});

test('running cancellation reports cancelling once and late output stays nonfinal', async t => {
  const gate = pending();
  // This synthetic runner ignores abort to hold the cancelling phase observable.
  const { hub } = await setup(t, async () => gate.promise);
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Long', requestId: 'cancelling-start' }));
  await until(async () => (await status(hub, started.taskId)).status === 'running');
  const first = await hub.dispatch(controller(hub, 'codex', 'cancel', { taskId: started.taskId, requestId: 'cancel-once' }));
  assert.equal(first.cancelAccepted, true);
  assert.equal(first.cancelPending, true);
  assert.equal(first.terminal, false);
  const cancelling = await status(hub, started.taskId);
  assert.equal(cancelling.status, 'running');
  assert.equal(cancelling.phase, 'cancelling');
  assert.equal(cancelling.cancelPending, true);
  assert.equal(cancelling.terminal, false);
  const repeated = await hub.dispatch(controller(hub, 'codex', 'cancel', { taskId: started.taskId, requestId: 'cancel-twice' }));
  assert.equal(repeated.cancelAccepted, false, 'an already requested cancellation is not accepted again');
  assert.equal(repeated.cancelPending, true);
  gate.resolve({ text: 'Late output after cancellation' });
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'cancelled' && value; });
  assert.equal(done.phase, 'cancelled');
  assert.equal(done.terminal, true);
  assert.equal(done.cancelPending, false);
  assert.equal(done.result.text, 'Late output after cancellation');
  assert.equal(done.resultFinal, false);
  assert.equal(done.resultRole, 'cancelled');
});

test('a reopened task retains its old result as nonfinal and pending handoff has its own phase', async t => {
  const gate = pending();
  let calls = 0;
  const { hub } = await setup(t, async () => ++calls === 1 ? { text: 'First answer' } : gate.promise);
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Work', requestId: 'reopen-start' }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value; });
  assert.equal(done.phase, 'completed');
  assert.equal(done.terminal, true);
  assert.equal(done.resultFinal, true);
  assert.equal(done.resultRole, 'final');
  assert.equal(done.cancelPending, false);
  await until(() => hub.running.size === 0);
  const schedule = hub.schedule;
  hub.schedule = () => {};
  await hub.dispatch(controller(hub, 'codex', 'send', { taskId: started.taskId, message: 'Follow up', requestId: 'reopen-send' }));
  const queued = await status(hub, started.taskId);
  assert.equal(queued.status, 'ready');
  assert.equal(queued.phase, 'queued');
  assert.equal(queued.terminal, false);
  assert.equal(queued.result.text, 'First answer', 'the previous result remains visible');
  assert.equal(queued.resultFinal, false);
  assert.equal(queued.resultRole, 'superseded');
  hub.schedule = schedule;
  hub.schedule();
  const running = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'running' && value; });
  await hub.dispatch(controller(hub, 'codex', 'handoff', { taskId: started.taskId, provider: 'claude', message: 'Continue', revision: running.revision, requestId: 'reopen-handoff' }));
  const transferring = await status(hub, started.taskId);
  assert.equal(transferring.status, 'running');
  assert.equal(transferring.phase, 'handoff-pending');
  assert.equal(transferring.terminal, false);
  assert.equal(transferring.resultRole, 'superseded', 'old result is not the pending handoff result');
  gate.resolve({ text: 'Second answer' });
  const final = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value.owner === 'claude' && value; });
  assert.equal(final.resultFinal, true);
  assert.equal(final.result.generation, final.generation);
});

test('a waiting parent exposes boundary output and resumes with a persisted child-result input range', async t => {
  const childGate = pending();
  const prompts = [];
  let hub, parentToken, childId, resumed, persisted;
  const fixture = await setup(t, async ({ provider, prompt }) => {
    if (provider === 'claude') return childGate.promise;
    prompts.push(prompt);
    if (prompts.length === 1) {
      childId = (await hub.dispatch(request('codex', 'start', { provider: 'claude', cwd: '/tmp', prompt: 'Child', requestId: 'boundary-child' }, parentToken))).taskId;
      return { text: 'Parent boundary output' };
    }
    const id = packet(prompt).taskId;
    resumed = await status(hub, id);
    persisted = (await readJSON(join(hub.root, 'work.json'))).tasks[id].active.inputs;
    return { text: 'Parent final output' };
  }, { mcp: async ({ provider, token }) => { if (provider === 'codex') parentToken = token; return {}; } });
  hub = fixture.hub;
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Parent', requestId: 'boundary-parent' }));
  const waiting = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'waiting' && value; });
  assert.equal(waiting.phase, 'waiting-for-children');
  assert.equal(waiting.terminal, false);
  assert.equal(waiting.result.text, 'Parent boundary output');
  assert.equal(waiting.resultFinal, false);
  assert.equal(waiting.resultRole, 'boundary');
  await until(() => !hub.pumping);
  const schedule = hub.schedule;
  hub.schedule = () => {};
  childGate.resolve({ text: 'Child answer' });
  const ready = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'ready' && value; });
  assert.equal(ready.resultRole, 'boundary', 'a queued resumed parent keeps its boundary label');
  assert.equal(ready.resultFinal, false);
  hub.schedule = schedule;
  hub.schedule();
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && results(value) === 2 && value; });
  assert.equal(done.resultFinal, true);
  assert.equal(done.resultRole, 'final');
  assert.deepEqual(packet(prompts[0]).execution, { generation: 1, inputs: { from: 0, to: 1, kinds: ['request'] } });
  // Messages at resume: request, boundary result, child-result. The old result is not an input.
  const expected = { from: 1, to: 3, kinds: ['child-result'] };
  assert.deepEqual(packet(prompts[1]).execution, { generation: 2, inputs: expected });
  assert.deepEqual(resumed.active.inputs, expected);
  assert.deepEqual(persisted, expected);
  assert.equal(resumed.active.tokenHash, undefined);
  assert.equal(done.messages[2].from, childId);
});

test('concurrent follow-up and child-result triggers are both preserved in the next execution inputs', async t => {
  const prompts = [];
  let hub, parentToken, childId;
  const fixture = await setup(t, async ({ provider, prompt }) => {
    if (provider === 'claude') return { text: 'Quick child answer' };
    prompts.push(prompt);
    if (prompts.length > 1) return { text: 'Parent handled both inputs' };
    const id = packet(prompt).taskId;
    childId = (await hub.dispatch(request('codex', 'start', { provider: 'claude', cwd: '/tmp', prompt: 'Child', requestId: 'trigger-child' }, parentToken))).taskId;
    // Do not consume the child through worker status/wait; its delivery must still trigger work.
    await until(() => hub.state.tasks[childId]?.status === 'completed');
    await hub.dispatch(controller(hub, 'codex', 'send', { taskId: id, message: 'Concurrent follow-up', requestId: 'trigger-send' }));
    return { text: 'Parent first answer' };
  }, { mcp: async ({ provider, token }) => { if (provider === 'codex') parentToken = token; return {}; } });
  hub = fixture.hub;
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Parent', requestId: 'trigger-parent' }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && results(value) === 2 && value; });
  assert.equal(prompts.length, 2);
  assert.deepEqual(done.messages.slice(0, 4).map(item => item.kind), ['request', 'child-result', 'message', 'result']);
  const { execution } = packet(prompts[1]);
  assert.equal(execution.generation, 2);
  assert.equal(execution.inputs.from, 1);
  assert.equal(execution.inputs.to, 4);
  assert.deepEqual([...execution.inputs.kinds].sort(), ['child-result', 'message']);
});

test('worker summary wait delivers an unseen terminal child outcome once and acknowledges it', async t => {
  const childGate = pending();
  const parentCalls = [];
  let hub, parentToken, childId, first, second, third;
  const fixture = await setup(t, async ({ provider }) => {
    if (provider === 'claude') return childGate.promise;
    parentCalls.push(provider);
    if (parentCalls.length > 1) return { text: 'Unexpected parent rerun' };
    childId = (await hub.dispatch(request('codex', 'start', { provider: 'claude', cwd: '/tmp', prompt: 'Child', requestId: 'summary-child' }, parentToken))).taskId;
    await until(() => hub.state.tasks[childId]?.status === 'running');
    const wait = (afterRevision, timeoutMs = 0) => hub.dispatch(request('codex', 'wait', { taskId: childId, view: 'summary', afterRevision, timeoutMs }, parentToken));
    assert.equal((await wait(hub.state.tasks[childId].revision)).timedOut, false, 'zero timeout is a nonblocking snapshot');
    first = await wait(hub.state.tasks[childId].revision, 5);
    childGate.resolve({ text: 'Child answer' });
    await until(() => hub.state.tasks[childId].status === 'completed');
    // afterRevision is already current, but this worker has not seen the terminal outcome.
    second = await wait(hub.state.tasks[childId].revision);
    third = await wait(hub.state.tasks[childId].revision);
    return { text: 'Parent final' };
  }, { mcp: async ({ provider, token }) => { if (provider === 'codex') parentToken = token; return {}; } });
  hub = fixture.hub;
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Parent', requestId: 'summary-parent' }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value; });
  await delay(20);
  for (const summary of [first, second, third]) {
    assert.equal(Object.hasOwn(summary, 'messages'), false);
    assert.equal(summary.active?.tokenHash, undefined);
    assert.equal(summary.timedOut, summary === first);
  }
  assert.equal(first.changed, false);
  assert.equal(first.terminal, false);
  assert.equal(first.phase, 'running');
  assert.equal(second.terminal, true);
  assert.equal(second.result.text, 'Child answer');
  assert.equal(second.resultFinal, true);
  assert.equal(Object.hasOwn(second, 'error'), true);
  assert.equal(third.terminal, true);
  assert.equal(third.result, undefined, 'a caught-up acknowledged summary omits the repeated result');
  assert.deepEqual(parentCalls, ['codex'], 'an acknowledged child result must not rerun its parent');
  assert.equal(done.messages.filter(item => item.kind === 'child-result').length, 1);
});

test('controller summary wait omits a caught-up terminal result and full view stays default', async t => {
  const { hub } = await setup(t, async () => ({ text: 'Answer' }));
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Work', requestId: 'summary-controller' }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value; });
  const wait = params => hub.dispatch(controller(hub, 'codex', 'wait', { taskId: started.taskId, timeoutMs: 0, ...params }));
  const caughtUp = await wait({ view: 'summary', afterRevision: done.revision });
  assert.equal(caughtUp.terminal, true);
  assert.equal(caughtUp.changed, false);
  assert.equal(caughtUp.timedOut, false);
  assert.equal(caughtUp.result, undefined);
  assert.equal(Object.hasOwn(caughtUp, 'messages'), false);
  const behind = await wait({ view: 'summary', afterRevision: done.revision - 1 });
  assert.equal(behind.changed, true);
  assert.equal(behind.result.text, 'Answer');
  assert.equal(Object.hasOwn(behind, 'error'), true);
  assert.equal(behind.resultFinal, true);
  const full = await wait({ afterRevision: done.revision });
  assert.deepEqual(full.messages, done.messages);
  assert.equal(full.result.text, 'Answer');
  assert.equal(full.phase, 'completed');
});

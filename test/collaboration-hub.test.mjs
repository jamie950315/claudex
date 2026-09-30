import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { readJSON, writeJSON } from '../src/storage.mjs';

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

test('closing while a pump is queued preserves unstarted work and launches no native invocation', async t => {
  let calls = 0;
  const { hub, root } = await setup(t, async () => { calls++; return { text: 'Unexpected invocation' }; });
  hub.schedule = () => {};
  const started = await hub.dispatch(controller(hub, 'codex', 'start', {
    provider: 'codex', cwd: root, prompt: 'Queued work', requestId: 'closing-queued-pump',
  }));
  const gate = pending();
  const holding = hub.mutate(async () => gate.promise);
  const pumping = hub.pump();
  assert.equal(hub.pumping, true);
  const closing = hub.close();
  gate.resolve();
  await Promise.all([holding, pumping, closing]);
  assert.equal(calls, 0);
  assert.equal(hub.running.size, 0);
  const task = await status(hub, started.taskId);
  assert.equal(task.status, 'ready');
  assert.equal(task.active, null);
});

test('closing during launch publication drains the pump without starting native work', async t => {
  let calls = 0, closing;
  const { hub, root } = await setup(t, async () => { calls++; return { text: 'Unexpected invocation' }; });
  hub.schedule = () => {};
  const started = await hub.dispatch(controller(hub, 'codex', 'start', {
    provider: 'codex', cwd: root, prompt: 'Work at the launch boundary', requestId: 'closing-launch-publication',
  }));
  hub.once('change', () => { closing = hub.close(); });
  await hub.pump();
  assert.ok(closing);
  await closing;
  assert.equal(calls, 0);
  assert.equal(hub.running.size, 0);
  const task = await status(hub, started.taskId);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /stopped before native execution/);
  assert.equal(task.active, null);
});

test('provider model defaults persist, validate atomically and leave existing work unchanged', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'unused' }));
  hub.schedule = () => {};
  const settings = params => hub.dispatch(controller(hub, 'codex', 'models', params));
  assert.deepEqual(await settings({}), { defaultModels: { codex: null, claude: null }, defaultEfforts: { codex: null, claude: null } });
  const initial = { defaultModels: { codex: 'codex-default', claude: 'claude-default' } };
  await settings(initial);
  const saved = await lstat(join(root, 'work.json'), { bigint: true });
  await settings({});
  await settings(initial);
  const unchanged = await lstat(join(root, 'work.json'), { bigint: true });
  assert.equal(unchanged.ino, saved.ino);
  assert.equal(unchanged.mtimeNs, saved.mtimeNs);
  const start = { provider: 'codex', cwd: root, prompt: 'test', requestId: 'models-start' };
  const created = await hub.dispatch(controller(hub, 'codex', 'start', start));
  assert.equal((await status(hub, created.taskId)).model, 'codex-default');
  await settings({ defaultModels: { codex: 'changed', claude: null } });
  assert.equal((await status(hub, created.taskId)).model, 'codex-default');
  assert.equal((await hub.dispatch(controller(hub, 'codex', 'start', start))).replayed, true);
  for (const invalid of [null, [], {}, { codex: null }, { codex: null, claude: null, extra: null },
    { codex: '', claude: null }, { codex: 'a\nb', claude: null }, { codex: ' model ', claude: null },
    { codex: '界'.repeat(67), claude: null }, { codex: 42, claude: null }]) {
    await assert.rejects(settings({ defaultModels: invalid }));
    assert.deepEqual((await settings({})).defaultModels, { codex: 'changed', claude: null });
  }
  const explicit = await hub.dispatch(controller(hub, 'codex', 'start', { ...start, model: null, requestId: 'native-default' }));
  assert.equal((await status(hub, explicit.taskId)).model, null);
  const next = await hub.dispatch(controller(hub, 'codex', 'start', { ...start, model: 'explicit', requestId: 'explicit' }));
  assert.equal((await status(hub, next.taskId)).model, 'explicit');
  await hub.close();
  const reopened = await new CollaborationHub({ root, run: async () => ({ text: 'unused' }) }).initialize();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.dispatch(controller(reopened, 'codex', 'models', {}))).defaultModels, { codex: 'changed', claude: null });
  assert.deepEqual((await reopened.dispatch(controller(reopened, 'codex', 'list', {}))).limits.defaultModels, { codex: 'changed', claude: null });
});

test('children use destination defaults and workers cannot read or change model settings', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'unused' }));
  hub.schedule = () => {};
  await hub.dispatch(controller(hub, 'codex', 'models', { defaultModels: { codex: 'codex-default', claude: 'claude-default' }, defaultEfforts: { codex: 'ultra', claude: 'medium' } }));
  const token = 'b'.repeat(64);
  const parent = await uncertainFixture(hub, hub.root, { model: 'parent-override', effort: 'low', status: 'running', active: {
    generation: 1, tokenHash: createHash('sha256').update(token).digest('hex'), messageCount: 1, pid: 123456,
  } });
  for (const params of [{}, { defaultModels: { codex: null, claude: null } }, { defaultEfforts: { codex: null, claude: null } }])
    await assert.rejects(hub.dispatch(request('codex', 'models', params, token)), /Only the controller/);
  const child = await hub.dispatch(request('codex', 'start', { provider: 'claude', cwd: root, prompt: 'child', requestId: 'child-model' }, token));
  assert.equal((await status(hub, child.taskId)).model, 'claude-default');
  assert.equal((await status(hub, child.taskId)).effort, 'medium');
  assert.equal((await status(hub, parent.id)).effort, 'low');
  assert.equal((await status(hub, parent.id)).model, 'parent-override');
});

test('handoff freezes receiver model at request time and explicit null selects native default', async t => {
  const first = pending();
  const invocations = [];
  const { root, hub } = await setup(t, async args => {
    invocations.push(args);
    return invocations.length === 1 ? first.promise : { text: 'done' };
  });
  await hub.dispatch(controller(hub, 'codex', 'models', { defaultModels: { codex: 'c1', claude: 'a1' } }));
  const created = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: root, prompt: 'start', requestId: 'handoff-model' }));
  await until(() => invocations.length === 1);
  const running = await status(hub, created.taskId);
  const transfer = controller(hub, 'codex', 'handoff', { taskId: created.taskId, provider: 'claude', message: 'continue', revision: running.revision, requestId: 'transfer-model' });
  await hub.dispatch(transfer);
  assert.deepEqual((await status(hub, created.taskId)).pendingHandoff, { provider: 'claude', model: 'a1', effort: null });
  await hub.dispatch(controller(hub, 'codex', 'models', { defaultModels: { codex: 'c2', claude: 'a2' } }));
  assert.equal((await hub.dispatch(transfer)).replayed, true);
  first.resolve({ text: 'transferred' });
  await until(async () => (await status(hub, created.taskId)).status === 'completed');
  assert.deepEqual(invocations.map(item => item.model), ['c1', 'a1']);
  let finished = await status(hub, created.taskId);
  await hub.dispatch(controller(hub, 'codex', 'handoff', { taskId: created.taskId, provider: 'codex', model: 'override', message: 'return', revision: finished.revision, requestId: 'return-model' }));
  await until(async () => (await status(hub, created.taskId)).status === 'completed');
  assert.equal(invocations[2].model, 'override');
  finished = await status(hub, created.taskId);
  await hub.dispatch(controller(hub, 'codex', 'handoff', { taskId: created.taskId, provider: 'claude', model: null, message: 'native', revision: finished.revision, requestId: 'native-model' }));
  await until(async () => (await status(hub, created.taskId)).status === 'completed');
  assert.equal(invocations[3].model, undefined);
});

test('legacy ledgers gain native model defaults and malformed persisted settings fail', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'unused' }));
  await hub.close();
  const ledger = await readJSON(join(root, 'work.json'));
  delete ledger.defaultModels;
  await writeJSON(join(root, 'work.json'), ledger);
  const legacy = await new CollaborationHub({ root, run: async () => ({ text: 'unused' }) }).initialize();
  assert.deepEqual(legacy.state.defaultModels, { codex: null, claude: null });
  await legacy.close();
  ledger.defaultModels = { codex: 'bad\nmodel', claude: null };
  await writeJSON(join(root, 'work.json'), ledger);
  await assert.rejects(new CollaborationHub({ root, run: async () => ({ text: 'unused' }) }).initialize(), /control characters/);
});

test('legacy pending handoff without a model retains native default despite new settings', async t => {
  const completion = pending();
  const calls = [];
  const { root, hub } = await setup(t, async args => {
    calls.push(args);
    return calls.length === 1 ? completion.promise : { text: 'done' };
  });
  const start = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: root, prompt: 'start', requestId: 'legacy-pending' }));
  await until(() => calls.length === 1);
  await hub.mutate(state => { state.tasks[start.taskId].pendingHandoff = { provider: 'claude' }; });
  await hub.dispatch(controller(hub, 'codex', 'models', { defaultModels: { codex: null, claude: 'new-default' } }));
  completion.resolve({ text: 'handoff' });
  await until(async () => (await status(hub, start.taskId)).status === 'completed');
  assert.equal(calls[1].model, undefined);
});

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

test('writable uncertainty requires reconciliation and preserves its attestation without replay', async t => {
  let calls = 0;
  const { root, hub } = await setup(t, async () => { calls++; return { text: 'unexpected' }; }, {
    allowWrite: true,
    inspectProcessGroup: pid => ({ pid, processAbsent: true, groupAbsent: true, inspectedAt: 123 }),
  });
  const task = await uncertainFixture(hub, root, { permission: 'workspace-write' });
  await assert.rejects(hub.dispatch(resolution(hub, task, { workspaceReconciled: true })), /reconciliation notes/);
  await assert.rejects(hub.dispatch(resolution(hub, task, { workspaceReconciled: 'true', reconciliationNotes: 'Checked' })), /acknowledgement/);
  const request = resolution(hub, task, { workspaceReconciled: true, reconciliationNotes: 'Validated retained outputs; partial outputs handled by controller.' });
  await hub.dispatch(request);
  const done = await status(hub, task.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.resolution.workspaceReconciled, true);
  assert.equal(done.resolution.workspaceReconciliation.cwd, root);
  assert.match(done.resolution.workspaceReconciliation.notes, /Validated/);
  assert.equal(done.error, task.error);
  assert.deepEqual(done.lastExecution, task.lastExecution);
  assert.equal((await hub.dispatch(request)).replayed, true);
  assert.equal(calls, 0);
});

test('uncertain resolution refuses a recorded separate-group descendant and never replays native work', async t => {
  let calls = 0, childAbsent = false;
  const ownedProcesses = [123456, 123457].map((pid, index) => ({ pid, ppid: index ? 123456 : 1,
    pgid: pid, uid: process.getuid(), startedAt: 'Wed Sep 30 20:00:00 2026' }));
  const { root, hub } = await setup(t, async () => { calls++; return { text: 'Unexpected replay' }; }, {
    inspectProcessGroup: pid => ({ pid, processAbsent: true, groupAbsent: true, inspectedAt: 123 }),
    inspectProcesses: records => ({ inspectedAt: 123, processes: records.map((row, index) => ({ ...row, absent: !index || childAbsent })) }),
  });
  const task = await uncertainFixture(hub, root, { lastExecution: { generation: 1, pid: 123456,
    processInventoryRequired: true, ownedProcesses } });
  await assert.rejects(hub.dispatch(resolution(hub, task)), /descendants must all be confirmed absent/);
  assert.equal((await status(hub, task.id)).status, 'uncertain');
  childAbsent = true;
  const request = resolution(hub, task);
  await hub.dispatch(request);
  assert.equal((await hub.dispatch(request)).replayed, true);
  const done = await status(hub, task.id);
  assert.deepEqual(done.lastExecution.ownedProcesses, ownedProcesses);
  assert.equal(done.resolution.ownedProcessInspection.processes.length, 2);
  assert.equal(calls, 0);
});

test('an incomplete process inventory never becomes resolution proof after the saved prefix exits', async t => {
  const { root, hub } = await setup(t, async () => ({ text: 'Unexpected replay' }), {
    inspectProcessGroup: pid => ({ pid, processAbsent: true, groupAbsent: true, inspectedAt: 123 }),
    inspectProcesses: records => ({ inspectedAt: 123, processes: records.map(row => ({ ...row, absent: true })) }),
  });
  const task = await uncertainFixture(hub, root, { lastExecution: { generation: 1, pid: 123456,
    processInventoryRequired: true, processInventoryError: true, ownedProcesses: [{ pid: 123456, ppid: 1,
      pgid: 123456, uid: process.getuid(), startedAt: 'Wed Sep 30 20:00:00 2026' }] } });
  await assert.rejects(hub.dispatch(resolution(hub, task)), /inventory is incomplete/);
  assert.equal((await status(hub, task.id)).status, 'uncertain');
});

test('known failure without a native spawn clears only its unused inventory requirement', async t => {
  const run = async () => { const error = new Error('Native binary is absent'); error.executionUncertain = false; throw error; };
  run.tracksOwnedProcesses = true;
  const { root, hub } = await setup(t, run);
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: root,
    prompt: 'Never infer', requestId: 'no-binary' }));
  const failed = await until(async () => { const task = await status(hub, started.taskId); return task.status === 'failed' && task; });
  assert.equal(failed.lastExecution.notStarted, true);
  assert.equal(failed.lastExecution.pid, null);
  assert.equal(failed.lastExecution.processInventoryRequired, undefined);
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
    { name: 'reconciled writable live group', extra: { permission: 'workspace-write' },
      params: { workspaceReconciled: true, reconciliationNotes: 'Reviewed output files.' },
      proof: { groupAbsent: false }, pattern: /both be confirmed absent/ },
    { name: 'reconciled writable stale revision', extra: { permission: 'workspace-write' },
      params: { workspaceReconciled: true, reconciliationNotes: 'Reviewed output files.', revision: 2 },
      pattern: /revision changed/ },
  ]) await t.test(scenario.name, async t => {
    const { root, hub } = await setup(t, async () => ({ text: 'unused' }), {
      inspectProcessGroup: pid => { if (scenario.failure) throw scenario.failure; return { pid, inspectedAt: 123, processAbsent: true, groupAbsent: true, ...scenario.proof }; },
    });
    const task = await uncertainFixture(hub, root, scenario.extra);
    const before = await status(hub, task.id);
    await assert.rejects(hub.dispatch(resolution(hub, task, scenario.params)), scenario.pattern);
    assert.deepEqual(await status(hub, task.id), before);
    assert.deepEqual(hub.state.tasks[task.id], task);
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
    assert.match(prompt, /nextAction=end-turn/);
    assert.match(prompt, /overrides the normal final-report format/);
    assert.match(prompt, /Children can run concurrently with their parent/);
    assert.match(prompt, /Work has no execution deadline/);
    assert.match(prompt, /Only when finishing actual user work/);
    return { text: 'synthetic result' };
  });
  const started = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Inspect', requestId: 'start-1' }));
  const done = await until(async () => { const value = await status(hub, started.taskId); return value.status === 'completed' && value; });
  assert.equal(done.result.text, 'synthetic result');
  assert.equal(done.permission, 'read-only');
  assert.equal(done.messages.at(-1).kind, 'result');
  assert.equal(done.active, null);
});

test('native chat coordination is controller-only and never allocates model work', async t => {
  let calls = 0;
  const { hub } = await setup(t, async () => { calls++; return { text: 'unused' }; });
  const sessionId = randomUUID();
  await hub.chatMailbox.register({ provider: 'claude', sessionId, cwd: hub.root, event: 'SessionStart' });
  const inventory = await hub.dispatch(controller(hub, 'codex', 'chat_list', {}));
  assert.equal(inventory.chats[0].sessionId, sessionId);
  assert.equal(inventory.idleWakeSupported, false);
  await hub.chatMailbox.register({ provider: 'codex', sessionId: randomUUID(), cwd: hub.root, event: 'SessionStart' });
  const page = await hub.dispatch(controller(hub, 'codex', 'chat_list', { limit: 1 }));
  assert.equal(page.chats.length, 1);
  assert.equal(page.nextCursor, '1');
  assert.equal((await hub.dispatch(controller(hub, 'codex', 'chat_list', { cursor: page.nextCursor }))).chats.length, 1);
  const queued = await hub.dispatch(controller(hub, 'codex', 'chat_send', { provider: 'claude', sessionId,
    message: 'Please finish your current work before maintenance.', requestId: 'native-note' }));
  assert.equal(queued.state, 'queued');
  assert.equal((await hub.dispatch(controller(hub, 'codex', 'chat_status', { messageId: queued.messageId }))).state, 'queued');
  assert.equal(calls, 0);
  assert.equal(Object.keys(hub.state.tasks).length, 0);
});

test('managed worker capabilities cannot send messages to unrelated native chats', async t => {
  const gate = pending(); let token;
  const { hub } = await setup(t, async () => gate.promise, { mcp: value => { token = value.token; return {}; } });
  const parent = await hub.dispatch(controller(hub, 'codex', 'start', { provider: 'codex', cwd: '/tmp', prompt: 'Wait', requestId: 'chat-worker' }));
  try {
    await until(() => token);
    for (const method of ['chat_list', 'chat_send', 'chat_status'])
      await assert.rejects(hub.dispatch(request('codex', method, {}, token)), /external controller/);
  } finally { gate.resolve({ text: 'done' }); }
  await until(async () => (await status(hub, parent.taskId)).status === 'completed');
});

test('native title search preserves ambiguous candidates and rechecks the chosen title before send', async t => {
  const titles = new Map(); let archived = false;
  const { hub } = await setup(t, async () => ({ text: 'unused' }), {
    chatTitleResolver: async chats => chats.map(chat => ({ ...chat, title: titles.get(chat.sessionId) ?? null,
      titleSource: 'synthetic-native-metadata', archived })),
  });
  const first = randomUUID(), second = randomUUID(), codex = randomUUID();
  for (const [side, id] of [['claude', first], ['claude', second], ['codex', codex]]) {
    await hub.chatMailbox.register({ provider: side, sessionId: id, cwd: hub.root, event: 'SessionStart' });
    titles.set(id, 'Project review');
  }
  const found = await hub.dispatch(controller(hub, 'codex', 'chat_list', { provider: 'claude', query: 'project REVIEW', match: 'exact' }));
  assert.equal(found.totalCount, 2);
  assert.equal(found.exactMatchCount, 2);
  const ambiguous = await hub.dispatch(controller(hub, 'codex', 'chat_send', {
    provider: 'claude', title: 'project REVIEW', message: 'Status please', requestId: 'ambiguous-title',
  }));
  assert.equal(ambiguous.status, 'needs-selection');
  assert.equal(ambiguous.queued, false);
  assert.equal(ambiguous.candidates.length, 2);
  assert.deepEqual(found.chats.map(chat => chat.sessionId), [first, second]);
  assert.equal((await hub.dispatch(controller(hub, 'codex', 'chat_list', { query: 'review' }))).totalCount, 3);
  assert.equal((await hub.dispatch(controller(hub, 'codex', 'chat_list', { query: 'review', match: 'exact' }))).totalCount, 0);
  titles.set(first, 'Renamed review');
  await hub.chatMailbox.register({ provider: 'claude', sessionId: first, cwd: hub.root, event: 'SessionEnd' });
  const byTitle = await hub.dispatch(controller(hub, 'codex', 'chat_send', {
    title: 'renamed REVIEW', message: 'Status please', requestId: 'unique-title',
  }));
  assert.equal(byTitle.targetSessionId, first);
  assert.equal(byTitle.deliveryStatus, 'waiting-for-resume');
  assert.equal((await hub.dispatch(controller(hub, 'codex', 'chat_send', {
    title: 'renamed REVIEW', message: 'Status please', requestId: 'unique-title',
  }))).messageId, byTitle.messageId);
  const missing = await hub.dispatch(controller(hub, 'codex', 'chat_send', {
    title: 'unknown', message: 'Status please', requestId: 'unknown-title',
  }));
  assert.equal(missing.status, 'not-found');
  assert.equal(missing.queued, false);
  const params = { provider: 'claude', sessionId: first, expectedTitle: 'Project review', message: 'Please report status.', requestId: 'named-chat' };
  await assert.rejects(hub.dispatch(controller(hub, 'codex', 'chat_send', params)), /title changed/);
  const queued = await hub.dispatch(controller(hub, 'codex', 'chat_send', { ...params, expectedTitle: 'Renamed review' }));
  assert.equal(queued.targetSessionId, first);
  archived = true;
  await assert.rejects(hub.dispatch(controller(hub, 'codex', 'chat_send', { ...params, expectedTitle: 'Renamed review', requestId: 'archived-chat' })), /could not be verified/);
  assert.equal(Object.keys(hub.state.tasks).length, 0, 'search and send never create managed work');
});

test('native title search preserves capitalization before matching returned metadata', async t => {
  const sessionId = randomUUID(), title = 'Original Chat CHAT-M7K4';
  const descriptor = { provider: 'codex', nativeId: sessionId, sessionId, chatId: `codex:${sessionId}`,
    title, cwd: '/tmp', registeredByHook: false };
  const queries = [];
  const { hub } = await setup(t, async () => { throw new Error('No managed inference'); }, {
    nativeChatDiscovery: async ({ query }) => { queries.push(query); return query === title ? [descriptor] : []; },
  });
  const result = await hub.dispatch(controller(hub, 'claude', 'chat_list', { query: title, match: 'exact', provider: 'codex' }));
  assert.deepEqual(queries, [title]);
  assert.equal(result.exactMatchCount, 1);
  assert.equal(result.chats[0].sessionId, sessionId);
  assert.equal((await hub.chatMailbox.list()).length, 0, 'metadata lookup never fabricates hook registration');
});

test('native title discovery and wake claim never duplicate a native dispatch', async t => {
  const sessionId = randomUUID(); let sends = 0;
  const descriptor = { provider: 'codex', nativeId: sessionId, sessionId, chatId: `codex:${sessionId}`,
    title: 'Idle project', cwd: '/tmp', registeredByHook: false };
  const { hub } = await setup(t, async () => { throw new Error('No managed inference'); }, {
    nativeChatDiscovery: async () => [descriptor],
    chatWake: async () => ({ status: 'ready', close() {}, dispatch: async () => { sends++; return { status: 'accepted', turnId: 'native-turn' }; } }),
  });
  const params = { title: 'Idle project', message: 'Please report status.', requestId: 'wake-exact' };
  const sent = await hub.dispatch(controller(hub, 'claude', 'chat_send', params));
  assert.equal(sent.wakeStatus, 'accepted');
  assert.equal(sent.state, 'offered');
  assert.equal(sent.deliveryMode, 'native-owner');
  assert.equal((await hub.chatMailbox.list())[0].registeredByHook, false);
  await hub.dispatch(controller(hub, 'claude', 'chat_send', params));
  assert.equal(sends, 1);
  assert.equal(Object.keys(hub.state.tasks).length, 0);
});

test('busy native owner defers to hooks while ambiguous dispatch is never replayed', async t => {
  for (const result of ['busy', 'uncertain']) {
    const sessionId = randomUUID();
    const { hub } = await setup(t, async () => ({ text: 'unused' }), {
      chatWake: async () => ({ status: 'ready', close() {}, dispatch: async () => ({ status: result }) }),
    });
    await hub.chatMailbox.register({ provider: 'codex', sessionId, cwd: hub.root, event: 'SessionStart' });
    const sent = await hub.dispatch(controller(hub, 'claude', 'chat_send', {
      provider: 'codex', sessionId, message: 'Hello', requestId: result,
    }));
    assert.equal(sent.state, result === 'busy' ? 'queued' : 'offered');
    assert.equal(sent.wake.state, result === 'busy' ? 'deferred' : 'uncertain');
  }
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
  assert.equal(toClaude.nextAction, 'end-turn');
  assert.equal(toClaude.finalResponse, 'CLAUDEX_HANDOFF');
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

test('writable child runs concurrently with its parent and delivers a durable result', async t => {
  const order = [];
  const childGate = pending();
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
      assert.notEqual(started.deferredUntilParentExit, true);
      assert.notEqual(started.nextAction, 'end-turn');
      assert.equal(started.finalResponse, undefined);
      await hub.dispatch(request('codex', 'wait', { taskId: childId, timeoutMs: 0 }, tokens.get('codex')));
      childGate.resolve();
      await until(() => hub.state.tasks[childId]?.status === 'completed');
      assert.deepEqual(order, ['codex', 'claude'], 'child runs before the parent finishes');
      return { text: 'Parent first result' };
    }
    if (order.length === 2) {
      assert.equal(provider, 'claude');
      assert.equal(permission, 'workspace-write');
      assert.equal((await status(hub, parentId)).status, 'running');
      await childGate.promise;
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
      hub.schedule = () => {};
      const child = await hub.dispatch(request('codex', 'start', {
        provider: 'claude', cwd: '/tmp', prompt: 'Queued child', permission: 'workspace-write', requestId: 'cancel-queued-child',
      }, parentToken));
      childId = child.taskId;
      assert.notEqual(child.deferredUntilParentExit, true);
      await hub.dispatch(controller(hub, 'codex', 'cancel', { taskId: childId, requestId: 'cancel-queued' }));
      delete hub.schedule;
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
  const running = await status(oldHub, started.taskId);
  await oldHub.dispatch(controller(oldHub, 'codex', 'handoff', { taskId: started.taskId, provider: 'claude',
    revision: running.revision, message: 'Pending handoff must not hide uncertainty', requestId: 'crash-handoff' }));
  await until(() => !oldHub.pumping);
  oldHub.closed = true; // Simulate process death without cancelling or completing the native turn.
  await oldHub.serial;
  const recovered = await new CollaborationHub({ root, run: async () => { calls++; return { text: 'replayed' }; } }).initialize();
  t.after(async () => { await recovered.close(); await rm(root, { recursive: true, force: true }); });
  const value = await status(recovered, started.taskId);
  assert.equal(value.status, 'uncertain');
  assert.deepEqual(value.active.inputs, { from: 0, to: 1, kinds: ['request'] });
  assert.equal(value.resultFinal, false);
  assert.equal(value.phase, 'uncertain');
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

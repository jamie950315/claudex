import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { validateCollaborationEffort } from '../src/collaboration-effort.mjs';

async function setup(t, run = async () => ({ text: 'done' })) {
  const root = await mkdtemp(join(tmpdir(), 'cldx-effort-'));
  const hub = await new CollaborationHub({ root, run }).initialize();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method, params = {}) => hub.dispatch({ peer: 'codex', token: hub.controllerToken, method, params });
  return { root, hub, call };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(5); }
  throw new Error('Timed out waiting for synthetic execution');
}

test('effort defaults update atomically, preserve model settings and freeze task selections', async t => {
  const { root, hub, call } = await setup(t);
  hub.schedule = () => {};
  await call('models', { defaultModels: { codex: 'chosen', claude: null }, defaultEfforts: { codex: 'high', claude: 'medium' } });
  const input = { provider: 'codex', cwd: root, prompt: 'test', requestId: 'effort-start' };
  const started = await call('start', input);
  await call('models', { defaultEfforts: { codex: 'low', claude: 'max' } });
  assert.equal((await call('status', { taskId: started.taskId })).effort, 'high');
  assert.equal((await call('status', { taskId: started.taskId, view: 'summary' })).effort, 'high');
  assert.equal((await call('start', input)).replayed, true);
  assert.deepEqual(await call('models'), { defaultModels: { codex: 'chosen', claude: null }, defaultEfforts: { codex: 'low', claude: 'max' } });
  await assert.rejects(call('models', { defaultModels: { codex: 'wrong', claude: null }, defaultEfforts: { codex: 'low', claude: 'ultra' } }), /Unsupported/);
  assert.equal((await call('models')).defaultModels.codex, 'chosen');
  for (const effort of [null, 'xhigh']) {
    const next = await call('start', { ...input, effort, requestId: `override-${effort}` });
    assert.equal((await call('status', { taskId: next.taskId })).effort, effort);
  }
  await assert.rejects(call('start', { ...input, effort: 'high', permission: 'workspace-write', requestId: 'permission' }), /not authorized/);
  assert.deepEqual((await call('list')).limits.defaultEfforts, { codex: 'low', claude: 'max' });
});

test('handoff freezes destination effort, follow-ups retain it, and null omits native override', async t => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const invocations = [];
  const { root, call } = await setup(t, args => {
    invocations.push(args);
    return invocations.length === 1 ? held : { text: 'done' };
  });
  await call('models', { defaultEfforts: { codex: 'ultra', claude: 'medium' } });
  const { taskId } = await call('start', { provider: 'codex', cwd: root, prompt: 'test', requestId: 'first' });
  await until(() => invocations.length === 1);
  const state = () => call('status', { taskId });
  const transfer = { taskId, provider: 'claude', message: 'continue', revision: (await state()).revision, requestId: 'transfer' };
  await call('handoff', transfer);
  await call('models', { defaultEfforts: { codex: 'low', claude: 'max' } });
  assert.equal((await call('handoff', transfer)).replayed, true);
  assert.equal((await state()).pendingHandoff.effort, 'medium');
  finish({ text: 'handoff' });
  await until(async () => (await state()).status === 'completed');
  assert.deepEqual(invocations.map(item => item.effort), ['ultra', 'medium']);
  await call('send', { taskId, message: 'continue again', requestId: 'followup' });
  await until(async () => (await state()).status === 'completed');
  assert.equal(invocations[2].effort, 'medium');
  await call('handoff', { taskId, provider: 'codex', effort: null, message: 'native effort', revision: (await state()).revision, requestId: 'native' });
  await until(async () => (await state()).status === 'completed');
  assert.equal(Object.hasOwn(invocations[3], 'effort'), false);
});

test('legacy effort selections stay native and destination validation rejects unsupported values', async t => {
  const { root, hub, call } = await setup(t);
  hub.schedule = () => {};
  const { taskId } = await call('start', { provider: 'codex', cwd: root, prompt: 'legacy', requestId: 'legacy' });
  await hub.mutate(state => {
    delete state.tasks[taskId].effort;
    state.tasks[taskId].pendingHandoff = { provider: 'claude' };
    state.defaultEfforts = { codex: 'high', claude: 'max' };
  });
  await hub.close();
  const reopened = await new CollaborationHub({ root, run: async () => ({ text: 'unused' }) }).initialize();
  t.after(() => reopened.close());
  assert.equal(reopened.state.tasks[taskId].effort, null);
  assert.equal(reopened.state.tasks[taskId].pendingHandoff.effort, null);
  for (const value of ['', ' HIGH ', 42, {}, 'ultra']) assert.throws(() => validateCollaborationEffort('claude', value), /Unsupported/);
  assert.equal(validateCollaborationEffort('claude', 'xhigh'), 'xhigh');
  assert.equal(validateCollaborationEffort('codex', null), null);
});

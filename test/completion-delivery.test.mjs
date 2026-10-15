import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { writeJSON } from '../src/storage.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'completion-capability-')));
  await chmod(root, 0o700);
  const hub = await new CollaborationHub({ root: join(root, 'collaboration'),
    run: () => assert.fail('Capability inspection cannot invoke models') }).initialize();
  hub.schedule = () => {};
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method, params = {}) => hub.dispatch({ peer: 'codex', token: hub.controllerToken, method, params });
  const hooks = { codex: { configured: true, trusted: true }, claude: { configured: true, enabled: true } };
  const watcher = (origin = hooks, updatedAt = Date.now()) => writeJSON(join(root, 'watcher-status.json'),
    { running: true, updatedAt, hookStatus: { ready: true, notificationOrigin: origin } });
  return { root, hub, call, watcher, hooks };
}

test('list and status distinguish broker availability, origin hook trust, route and exact recipient readiness', async t => {
  const f = await fixture(t);
  let capability = (await f.call('list')).completionDelivery;
  assert.equal(capability.originHooks.state, 'unknown');
  assert.equal(capability.nextStep, 'wait-for-current-hook-inspection');
  assert.deepEqual(capability.selectedRoute, { claude: 'mod-self', codex: 'native-owner' });
  await f.watcher({ ...f.hooks, codex: { configured: true, trusted: false } });
  capability = (await f.call('list')).completionDelivery;
  assert.equal(capability.originHooks.codex.state, 'waiting');
  assert.equal(capability.originHooks.claude.state, 'ready');
  assert.equal(capability.nextStep, 'review-exact-PostToolUse-hook-in-Codex-hooks');
  await f.watcher(); await f.call('native_wake', { route: 'mod-self' });
  capability = (await f.call('list')).completionDelivery;
  assert.equal(capability.originHooks.state, 'ready');
  assert.equal(capability.recipientReadiness.claude.reason, 'no-live-receiver');
  assert.equal(capability.recipientReadiness.claude.nextStep, 'open-recipient-session-and-load-Mod');
  assert.equal(capability.deliveryGuaranteed, false);
  assert.equal(capability.intermediateAlertsDefault, false);
  const task = await f.call('start', { provider: 'claude', cwd: f.root, requestId: 'capability-status', prompt: 'Synthetic work' });
  const status = await f.call('status', { taskId: task.taskId });
  assert.equal(status.completionDelivery.originBinding, 'notifications-off');
  assert.equal(status.completionDelivery.selectedRoute.claude, 'mod-self');
  await f.watcher(f.hooks, Date.now() - 90001);
  assert.equal((await f.call('list')).completionDelivery.originHooks.state, 'unknown');
});

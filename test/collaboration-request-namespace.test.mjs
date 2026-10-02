import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationHub } from '../src/collaboration-hub.mjs';

test('legacy controller request receipts remain provider-scoped across connections and restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-request-namespace-'));
  await chmod(root, 0o700);
  let invocations = 0;
  const open = async () => {
    const hub = await new CollaborationHub({ root, run: async () => {
      invocations++;
      throw new Error('This contract test must not invoke native work.');
    } }).initialize();
    hub.schedule = () => {};
    return hub;
  };
  let hub = await open();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const params = { provider: 'claude', cwd: root, prompt: 'Synthetic work', requestId: 'generic-start' };
  const request = (peer, input = params) => ({ peer, token: hub.controllerToken, method: 'start', params: input });
  const first = await hub.dispatch(request('codex'));

  // Independent controller connections do not carry a proven native session.
  // A second chat using the same request is indistinguishable from a retry.
  const repeated = await hub.dispatch(request('codex'));
  assert.equal(repeated.taskId, first.taskId);
  assert.equal(repeated.replayed, true);
  await assert.rejects(hub.dispatch(request('codex', { ...params, prompt: 'Different chat work' })),
    /requestId was reused with different input/);
  const otherProvider = await hub.dispatch(request('claude'));
  assert.notEqual(otherProvider.taskId, first.taskId);

  // Do not silently move old receipts to session namespaces: an uncertain old
  // caller must still recover its existing receipt without replaying work.
  await hub.close();
  hub = await open();
  const recovered = await hub.dispatch(request('codex'));
  assert.equal(recovered.taskId, first.taskId);
  assert.equal(recovered.replayed, true);
  assert.equal(Object.keys(hub.state.tasks).length, 2);
  assert.equal(invocations, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';

test('runtime shutdown closes idle owners concurrently and still refuses a busy one', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-runtime-close-')));
  for (const name of ['codex', 'claude', 'desktop']) await mkdir(join(root, name));
  const runtime = await new DesktopRuntime({ root: join(root, 'state'), codexHome: join(root, 'codex'),
    claudeHome: join(root, 'claude'), desktopHome: join(root, 'desktop'),
    ownerFactory() { throw new Error('No owner is started.'); }, clientFactory() { throw new Error('No Codex client.'); } }).initialize();
  let active = 0, peak = 0;
  const owner = busy => {
    let closed = false;
    return { status: () => ({ closed }), async close() {
      if (busy) throw new Error('Claude owner is busy; refusing to interrupt user work.');
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 50));
      active--; closed = true;
    } };
  };
  const idle = [owner(false), owner(false), owner(false)];
  idle.forEach((entry, index) => runtime.owners.set(`idle-${index}`, { owner: entry, error: null }));
  runtime.owners.set('busy', { owner: owner(true), error: null });
  await assert.rejects(runtime.close(), /busy/);
  assert.equal(peak, 3);
  assert.ok(idle.every(entry => entry.status().closed));
  runtime.owners.delete('busy');
  await runtime.close();
});

test('idle owners are closed after the configured idle time; busy, recent and blocked owners stay', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-runtime-idle-')));
  for (const name of ['codex', 'claude', 'desktop']) await mkdir(join(root, name));
  let clock = 0;
  assert.throws(() => new DesktopRuntime({ root: join(root, 'bad'), codexHome: join(root, 'codex'), claudeHome: join(root, 'claude'),
    desktopHome: join(root, 'desktop'), claudeOwnerIdleSeconds: 10 }), /claudeOwnerIdleSeconds/);
  const started = [];
  const runtime = await new DesktopRuntime({ root: join(root, 'state'), codexHome: join(root, 'codex'),
    claudeHome: join(root, 'claude'), desktopHome: join(root, 'desktop'), claudeOwnerIdleSeconds: 60, now: () => clock,
    ownerFactory(settings) {
      const state = { closed: false, nativeState: 'idle', blocked: null, refuse: false };
      const owner = { state, settings, async start() {}, async reconcileDisplayTitle() {},
        status: () => ({ closed: state.closed, nativeState: state.nativeState, blocked: state.blocked, pending: null, reset: null, backgroundTasks: [] }),
        async close() { if (state.refuse) throw new Error('Claude owner is busy; refusing to interrupt user work.'); state.closed = true; } };
      started.push(owner); return owner;
    }, clientFactory() { throw new Error('No Codex client.'); } }).initialize();
  for (const id of ['idle', 'busy', 'blocked', 'recent']) await runtime.owner(id, root, id);
  started[1].state.nativeState = 'running';
  started[2].state.blocked = 'Synthetic block';
  assert.equal(runtime.nextOwnerIdleAt(), 60_000);
  clock = 30_000; await runtime.owner('recent', root, 'recent');
  clock = 61_000;
  assert.deepEqual(await runtime.closeIdleOwners(), ['idle']);
  assert.deepEqual([...runtime.owners.keys()].sort(), ['blocked', 'busy', 'recent']);
  assert.equal(runtime.nextOwnerIdleAt(), 90_000);
  // A user turn starting during close keeps the owner and retries later.
  started[3].state.refuse = true;
  clock = 91_000;
  assert.deepEqual(await runtime.closeIdleOwners(), []);
  assert.equal(runtime.nextOwnerIdleAt(), 151_000);
  // The next access starts a fresh owner for a closed conversation.
  await runtime.owner('idle', root, 'idle');
  assert.equal(started.length, 5);
  started[1].state.nativeState = 'idle'; started[2].state.blocked = null; started[3].state.refuse = false;
  await runtime.close();
});

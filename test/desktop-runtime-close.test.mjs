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

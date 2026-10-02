/** Runs in the full repository after patch application. An overlay-only review
 * explicitly skips this case because the original transport is absent. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModBridge } from '../src/claude-mod-bridge.mjs';
const source = new URL('../src/collaboration-transport.mjs', import.meta.url);
test('default companion RPC uses the original private transport and dispatches once', {
  skip: !existsSync(source) ? 'Apply the patch to the full pinned repository to run original-transport integration.' : false,
}, async t => {
  const { serveCollaborationSocket } = await import(source.href);
  // Darwin's sockaddr_un has a 104-byte path limit, including the terminator.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cm-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const collaborationRoot = join(root, 'collaboration');
  await mkdir(collaborationRoot, { mode: 0o700 });
  const token = 'a'.repeat(64);
  await writeFile(join(collaborationRoot, 'controller-key'), `${token}\n`, { mode: 0o600 });
  const seen = [];
  const transport = await serveCollaborationSocket({ root: collaborationRoot, dispatch: async envelope => {
    assert.equal(envelope.peer, 'claude'); assert.equal(envelope.token, token);
    seen.push(envelope);
    if (envelope.method === 'models') return { defaultModels: { claude: null, codex: 'gpt-6-sol' }, defaultEfforts: { claude: null, codex: 'high' } };
    if (envelope.method === 'list') return { tasks: [], limits: {} };
    return { taskId: 'synthetic-only', status: 'ready' };
  } });
  t.after(() => transport.close());
  const context = { sessionId: '11111111-1111-4111-8111-111111111111', cwd: root };
  const req = (op, more = {}) => ({ version: 1, op, context, ...more });
  const handle = createModBridge({ root });
  assert.equal((await handle(req('doctor'))).socketPresent, true);
  const prepared = await handle(req('prepare', { method: 'start', params: { provider: 'codex', cwd: root, prompt: 'Synthetic task; no runner exists.' } }));
  assert.equal(prepared.params.model, 'gpt-6-sol');
  assert.equal((await handle(req('commit', { id: prepared.id }))).state, 'completed');
  await handle(req('commit', { id: prepared.id }));
  assert.equal(seen.filter(item => item.method === 'start').length, 1);
});

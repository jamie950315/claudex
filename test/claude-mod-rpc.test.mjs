/** Runs in the full repository after patch application. An overlay-only review
 * explicitly skips this case because the original transport is absent. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModBridge } from '../src/claude-mod-bridge.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    if (envelope.method === 'artifact_read') throw Object.assign(new Error('Do not expose private native error data'), { code: 'CLAUDEX_ARTIFACT_REFUSED' });
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
  await assert.rejects(handle(req('read', { method: 'artifact_read', params: {
    taskId: '22222222-2222-4222-8222-222222222222', generation: 1, reference: 'test.txt',
  } })), error => error.code === 'CLAUDEX_ARTIFACT_REFUSED' && /64 KiB/.test(error.message)
    && !error.message.includes('private native error'));
});

test('companion CLI exposes only the reviewed broad-query error and preserves unknown-error redaction', async t => {
  const { serveCollaborationSocket } = await import(source.href);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cm-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const collaborationRoot = join(root, 'collaboration'); await mkdir(collaborationRoot, { mode: 0o700 });
  const token = 'a'.repeat(64); await writeFile(join(collaborationRoot, 'controller-key'), token + '\n', { mode: 0o600 });
  const calls = []; let code;
  const transport = await serveCollaborationSocket({ root: collaborationRoot, dispatch: async envelope => {
    calls.push(envelope.method);
    throw Object.assign(new Error('Private native detail /fixture/private'), { code });
  } });
  t.after(() => transport.close());
  const input = { version: 1, op: 'read', context: { sessionId: '11111111-1111-4111-8111-111111111111', cwd: root },
    method: 'chat_list', params: { query: 'Cla', match: 'contains', limit: 12 } };
  const cli = fileURLToPath(new URL('../bin/claudex-mod-bridge.mjs', import.meta.url));
  for (code of ['NATIVE_CHAT_DISCOVERY_INCOMPLETE', 'UNREVIEWED_NATIVE_ERROR']) {
    const child = spawn(process.execPath, [cli, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    child.stdin.end(JSON.stringify(input));
    assert.equal(await exit, 1); const reply = JSON.parse(stdout);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, code === 'UNREVIEWED_NATIVE_ERROR' ? 'COMPANION_UNAVAILABLE' : code);
    if (code === 'NATIVE_CHAT_DISCOVERY_INCOMPLETE') assert.match(reply.error.message, /longer, more specific title query/);
    assert.equal(stdout.includes('Private native detail'), false); assert.equal(stdout.includes(token), false); assert.equal(stderr, '');
  }
  assert.deepEqual(calls, ['chat_list', 'chat_list']);
});

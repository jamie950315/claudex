import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, readdir, readFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModBridge } from '../src/claude-mod-bridge.mjs';
import { privateRead, privateDir } from '../src/claude-mod-storage.mjs';
import { validateRequest, validateParams } from '../src/claude-mod-protocol.mjs';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const CLAIM = '44444444-4444-4444-8444-444444444444';
const KEY = 'a'.repeat(64);
const ctx = { sessionId: SESSION, cwd: '/fixture/project' };
const make = (op, more = {}) => ({ version: 1, context: ctx, op, ...more });
const defaults = { defaultModels: { codex: 'gpt-6-sol', claude: 'claude-opus-4-6' },
  defaultEfforts: { codex: 'high', claude: 'high' } };
async function write(path, value) {
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); await chmod(path, 0o600);
}
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-mod-unit-')));
  await chmod(root, 0o700);
  await mkdir(join(root, 'collaboration'), { mode: 0o700 });
  await write(join(root, 'collaboration', 'controller-key'), KEY + '\n');
  const calls = [];
  const rpc = options.rpc ?? (async envelope => {
    calls.push(envelope);
    if (envelope.method === 'mod_wake_receipt') {
      const p = envelope.params;
      return { state: 'offered', messageId: p.messageId, targetProvider: 'claude', targetSessionId: p.target.sessionId,
        wakeRoute: 'mod', wake: { claimId: p.claimId, state: p.status, source: p.source } };
    }
    return envelope.method === 'models' ? defaults : { ok: true, id: 'synthetic-task' };
  });
  const handle = createModBridge({ root, rpc, now: () => 1000, ...options });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, calls, handle, rpc };
}
const taskParams = { provider: 'codex', cwd: '/fixture/project', prompt: 'Read the fixture only.' };

test('protocol bounds operations and extra fields', () => {
  for (const value of [null, {}, { version: 2, op: 'doctor', context: ctx }, make('execute'), make('doctor', { token: KEY })])
    assert.throws(() => validateRequest(value));
  for (const method of ['handoff', 'resolve', 'shell', '__proto__'])
    assert.throws(() => validateParams(method, {}, true));
});
test('protocol preserves exact model names and narrows permission defaults', () => {
  const params = validateParams('start', { ...taskParams, model: 'gpt-6-sol' }, true);
  assert.equal(params.model, 'gpt-6-sol'); assert.equal(params.permission, 'read-only');
  assert.throws(() => validateParams('start', { ...taskParams, permission: 'full-access' }, true));
  assert.equal(validateParams('start', { ...taskParams, model: null, effort: null }, true).model, null);
});
test('chat writes default queue-only and require exact metadata on ID addressing', () => {
  assert.equal(validateParams('chat_send', { title: 'Release', message: 'Status?' }, true).wake, false);
  assert.throws(() => validateParams('chat_send', { provider: 'claude', sessionId: SESSION, message: 'Status?' }, true));
  assert.throws(() => validateParams('chat_send', { title: 'Release', sessionId: SESSION, message: 'Status?' }, true));
  assert.throws(() => validateParams('chat_send', { title: 'Release', message: '中'.repeat(501) }, true));
});
test('model preference updates require complete pairs and no full-access', () => {
  assert.throws(() => validateParams('models', { defaultModels: { codex: 'x' } }, true));
  assert.throws(() => validateParams('models', { defaultPermission: 'full-access' }, true));
  assert.throws(() => validateParams('models', { defaultModels: defaults.defaultModels }, false));
  assert.deepEqual(validateParams('models', { defaultModels: defaults.defaultModels }, true).defaultModels, defaults.defaultModels);
});
test('unsafe identities, control text, directories and pagination are rejected', () => {
  for (const context of [{ ...ctx, sessionId: '../../root' }, { ...ctx, cwd: 'relative' }, { ...ctx, cwd: '//host/share' }])
    assert.throws(() => validateRequest(make('doctor', { context })));
  assert.throws(() => validateParams('chat_list', { limit: 101 }));
  assert.throws(() => validateParams('chat_list', { cursor: '-1' }));
  assert.throws(() => validateParams('send', { taskId: 'x', message: 'x\u001b[2J' }, true));
  assert.throws(() => validateParams('start', { ...taskParams, readOnlyDirs: Array(17).fill('/reference') }, true));
});
test('doctor and reads do not initialize companion state or invoke models', async t => {
  const f = await fixture(t);
  const before = await readdir(f.root);
  const result = await f.handle(make('doctor'));
  assert.equal(result.socketPresent, false); assert.equal(result.synchronizationPolicy, 'unchanged');
  assert.deepEqual(await readdir(f.root), before); assert.equal(f.calls.length, 0);
  await f.handle(make('read', { method: 'list', params: {} }));
  assert.equal(f.calls[0].method, 'list'); assert.equal(f.calls[0].token, KEY);
  assert.equal(f.calls[0].root, join(f.root, 'collaboration'));
  assert.deepEqual(await readdir(f.root), before);
});
test('managed worker refuses before inspecting roots or capabilities', async () => {
  const handle = createModBridge({ root: '/missing', worker: true, rpc: () => assert.fail('RPC was reached') });
  await assert.rejects(handle(make('doctor')), { code: 'MANAGED_WORKER' });
});
test('root symlink and world access fail closed', async t => {
  const f = await fixture(t), alias = f.root + '-alias';
  await symlink(f.root, alias); t.after(() => rm(alias, { force: true }));
  await assert.rejects(createModBridge({ root: alias })(make('doctor')));
  await chmod(f.root, 0o755);
  await assert.rejects(f.handle(make('doctor')), { code: 'UNSAFE_ROOT' });
});
test('private read rejects symlinks, hardlinks, oversized and public files', async t => {
  const f = await fixture(t), original = join(f.root, 'private.json');
  await write(original, '{}');
  await symlink(original, join(f.root, 'symlink'));
  await assert.rejects(privateRead(join(f.root, 'symlink')));
  await link(original, join(f.root, 'hardlink'));
  await assert.rejects(privateRead(original));
  await rm(join(f.root, 'hardlink'));
  await assert.rejects(privateRead(original, { maxBytes: 1 }));
  await chmod(original, 0o644); await assert.rejects(privateRead(original));
});
test('private read rejects FIFO without blocking', async t => {
  const f = await fixture(t), fifo = join(f.root, 'fifo');
  const made = spawnSync('mkfifo', ['-m', '600', fifo]);
  assert.equal(made.status, 0);
  await assert.rejects(privateRead(fifo), { code: 'UNSAFE_FILE' });
});
test('stop and resuming holds prevent preparation and broker reads', async t => {
  const f = await fixture(t);
  for (const stop of [{ version: 1, stopped: true }, { version: 1, stopped: false, resuming: true }]) {
    await write(join(f.root, 'app-stop.json'), stop);
    await assert.rejects(f.handle(make('prepare', { method: 'start', params: taskParams })), { code: 'APP_STOPPED' });
    await assert.rejects(f.handle(make('read', { method: 'list', params: {} })), { code: 'APP_STOPPED' });
  }
  assert.equal(f.calls.length, 0); assert.equal((await f.handle(make('doctor'))).stopped, true);
});
test('malformed application stop state is preserved', async t => {
  const f = await fixture(t); await write(join(f.root, 'app-stop.json'), { version: 7 });
  await assert.rejects(f.handle(make('doctor')), { code: 'INVALID_STOP_STATE' });
  assert.equal(JSON.parse(await readFile(join(f.root, 'app-stop.json'))).version, 7);
});
test('prepare is non-inference and captures provider defaults at preview time', async t => {
  const f = await fixture(t);
  const prepared = await f.handle(make('prepare', { method: 'start', params: taskParams }));
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.params.permission, 'read-only');
  assert.equal(prepared.params.model, defaults.defaultModels.codex); assert.equal(prepared.params.effort, 'high');
  assert.match(prepared.params.requestId, /^mod:/); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'models');
  assert.equal(JSON.stringify(prepared).includes(KEY), false);
});
test('duplicate preview returns same receipt across controller reload', async t => {
  const f = await fixture(t);
  const first = await f.handle(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  const reloaded = createModBridge({ root: f.root, rpc: f.rpc, now: () => 1001 });
  const second = await reloaded(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  assert.equal(first.id, second.id); assert.equal(f.calls.length, 0);
});
test('intent fingerprints canonicalize property order', async t => {
  const f = await fixture(t);
  const first = await f.handle(make('prepare', { method: 'send', params: { taskId: 'job', message: 'Hi' } }));
  const second = await f.handle(make('prepare', { method: 'send', params: { message: 'Hi', taskId: 'job' } }));
  assert.equal(first.id, second.id);
});
test('equivalent preview in another session is held', async t => {
  const f = await fixture(t);
  await f.handle(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  await assert.rejects(f.handle(make('prepare', { context: { ...ctx, sessionId: OTHER }, method: 'cancel', params: { taskId: 'job' } })), { code: 'PREVIEW_HELD' });
});
test('commit executes once; repeated commits return the saved result', async t => {
  const f = await fixture(t);
  const saved = await f.handle(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  const result = await f.handle(make('commit', { id: saved.id }));
  assert.equal(result.state, 'completed'); assert.equal(f.calls.length, 1);
  const again = await f.handle(make('commit', { id: saved.id }));
  assert.deepEqual(again, result); assert.equal(f.calls.length, 1);
});
test('concurrent commit is fenced by a durable per-action lock', async t => {
  let release, reached;
  const started = new Promise(resolve => { reached = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let count = 0;
  const f = await fixture(t, { rpc: async () => { count++; reached(); await waiting; return { done: true }; } });
  const saved = await f.handle(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  const first = f.handle(make('commit', { id: saved.id }));
  await started;
  const second = await f.handle(make('commit', { id: saved.id }));
  assert.equal(second.state, 'locked'); assert.equal(count, 1);
  release(); assert.equal((await first).state, 'completed');
});
test('RPC uncertainty is durable and blocks equivalent new actions after reload', async t => {
  let count = 0;
  const f = await fixture(t, { rpc: async () => { count++; throw new Error('private-token=' + KEY); } });
  const saved = await f.handle(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  const result = await f.handle(make('commit', { id: saved.id }));
  assert.equal(result.state, 'uncertain'); assert.equal(JSON.stringify(result).includes(KEY), false);
  const reloaded = createModBridge({ root: f.root, rpc: f.rpc, now: () => 2000 });
  assert.equal((await reloaded(make('commit', { id: saved.id }))).state, 'uncertain');
  await assert.rejects(reloaded(make('prepare', { method: 'cancel', params: { taskId: 'job' } })), { code: 'UNCERTAIN_ACTION' });
  assert.equal(count, 1);
});
test('crash-left dispatching receipt is never resent', async t => {
  const f = await fixture(t);
  const saved = await f.handle(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  const path = join(f.root, 'mod-companion', `${saved.id}.json`);
  const raw = JSON.parse(await readFile(path)); raw.state = 'dispatching'; await write(path, raw);
  assert.equal((await f.handle(make('commit', { id: saved.id }))).state, 'dispatching');
  assert.equal(f.calls.length, 0);
});
test('preview expiry and changed context prevent dispatch', async t => {
  let now = 1000; const f = await fixture(t, { now: () => now });
  const saved = await f.handle(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  await assert.rejects(f.handle(make('commit', { id: saved.id, context: { ...ctx, cwd: '/other' } })), { code: 'CONTEXT_CHANGED' });
  now += 600001;
  await assert.rejects(f.handle(make('commit', { id: saved.id })), { code: 'PREVIEW_EXPIRED' });
  assert.equal(f.calls.length, 0);
});
test('action receipts stay readable while stopped and context-restricted', async t => {
  const f = await fixture(t);
  const saved = await f.handle(make('prepare', { method: 'cancel', params: { taskId: 'job' } }));
  await write(join(f.root, 'app-stop.json'), { version: 1, stopped: true });
  assert.equal((await f.handle(make('receipt', { id: saved.id }))).state, 'prepared');
  await assert.rejects(f.handle(make('receipt', { id: saved.id, context: { ...ctx, sessionId: OTHER } })), { code: 'CONTEXT_CHANGED' });
});
test('native receipt is disabled by default', async t => {
  const f = await fixture(t);
  await assert.rejects(f.handle(make('wake-peek')), { code: 'NATIVE_WAKE_DISABLED' });
});
async function manifest(f, messages) {
  await mkdir(join(f.root, 'collaboration', 'chat-mailbox'), { mode: 0o700 });
  await write(join(f.root, 'collaboration', 'chat-mailbox', 'wake-manifest.json'), { version: 1, messages });
}
test('wake peek requests the broker and filters exact recipient context', async t => {
  const target = { sessionId: OTHER, cwd: '/recipient' }, calls = [];
  const wanted = { messageId: MESSAGE, target, expiresAt: 5000 };
  const f = await fixture(t, { allowNativeWake: true, rpc: async e => {
    calls.push(e); return { messages: [wanted, { messageId: CLAIM, target: { ...target, cwd: '/different' }, expiresAt: 5000 }] };
  } });
  const result = await f.handle(make('wake-peek', { target }));
  assert.deepEqual(result.messages, [wanted]);
  assert.deepEqual(calls[0].params, { source: ctx, timeoutMs: 0 });
});
test('wake claims use existing exact-ID broker fencing', async t => {
  const f = await fixture(t, { allowNativeWake: true });
  const target = { sessionId: OTHER, cwd: '/recipient' };
  await f.handle(make('wake-claim', { messageId: MESSAGE, target }));
  assert.equal(f.calls[0].method, 'mod_wake_claim');
  assert.deepEqual(f.calls[0].params, { source: ctx, target, messageId: MESSAGE });
  assert.equal(f.calls.length, 1);
});
test('wake receipt can finish after stop and never forges recipient ACK', async t => {
  const f = await fixture(t, { allowNativeWake: true });
  await write(join(f.root, 'app-stop.json'), { version: 1, stopped: true });
  await f.handle(make('wake-receipt', { messageId: MESSAGE, claimId: CLAIM, status: 'accepted' }));
  assert.equal(f.calls[0].method, 'mod_wake_receipt');
  assert.equal(f.calls[0].params.status, 'accepted');
  assert.equal(f.calls[0].params.reason, 'queued');
  await assert.rejects(f.handle(make('wake-receipt', { messageId: MESSAGE, claimId: CLAIM, status: 'acknowledged' })));
});
test('standalone CLI rejects malformed and oversize input without exposing paths or secrets', async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/claudex-mod-bridge.mjs', import.meta.url));
  for (const input of ['{broken:' + KEY, ' '.repeat(97 * 1024)]) {
    const out = spawnSync(process.execPath, [cli, '--root', f.root], { input, encoding: 'utf8' });
    assert.equal(out.status, 1); assert.equal(JSON.parse(out.stdout).ok, false);
    assert.equal(out.stdout.includes(KEY), false); assert.equal(out.stderr, '');
  }
});
test('CLI worker gate rejects before root validation', () => {
  const cli = fileURLToPath(new URL('../bin/claudex-mod-bridge.mjs', import.meta.url));
  const out = spawnSync(process.execPath, [cli, '--root', '/missing'], {
    input: JSON.stringify(make('doctor')), encoding: 'utf8', env: { ...process.env, CLAUDEX_COLLABORATION_WORKER: '1' },
  });
  assert.equal(out.status, 1); assert.equal(JSON.parse(out.stdout).error.code, 'MANAGED_WORKER');
});

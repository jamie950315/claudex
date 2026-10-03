import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveCollaborationSocket } from '../src/collaboration-transport.mjs';
import { SyncEventInbox } from '../src/sync-events.mjs';
const hookPath = fileURLToPath(new URL('../bin/claudex-sync-hook.mjs', import.meta.url));
const sessionId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const challenge = 'a'.repeat(64);
const receipt = (more = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ taskId, originChallenge: challenge, ...more }) }] });
const payload = (more = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'mcp__claudex-work__claudex_start',
  session_id: sessionId, cwd: '/fixture-project', tool_use_id: 'native-tool-1', turn_id: 'native-turn-1',
  tool_input: { prompt: 'HOOK_PRIVATE_PAYLOAD', notifications: { mode: 'queue' } }, tool_response: receipt(), ...more });
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coh-'))), collaborationRoot = join(root, 'collaboration');
  await mkdir(collaborationRoot, { mode: 0o700 });
  await writeFile(join(collaborationRoot, 'controller-key'), `${'b'.repeat(64)}\n`, { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  let dispatch = async envelope => { seen.push(envelope); return { bound: true }; };
  const server = await serveCollaborationSocket({ root: collaborationRoot, dispatch: envelope => dispatch(envelope) });
  t.after(() => server.close());
  async function hook(input, { provider = 'codex', worker = false } = {}) {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookPath, '--root', root, '--provider', provider], {
        env: { ...process.env, CLAUDEX_COLLABORATION_WORKER: worker ? '1' : '' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
      child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    });
  }
  return { root, collaborationRoot, seen, hook, closeServer: () => server.close(), dispatch: value => { dispatch = value; } };
}
test('PostToolUse forwards exact identity hints once over private RPC without storing prompts or sync hints', async t => {
  const f = await fixture(t);
  for (const provider of ['codex', 'claude']) {
    const input = payload(provider === 'claude' ? { turn_id: undefined, tool_response: receipt().content } : {});
    assert.deepEqual(await f.hook(input, { provider }), { code: 0, stdout: '', stderr: '' });
    const envelope = f.seen.at(-1);
    assert.equal(envelope.method, 'origin_bind'); assert.equal(envelope.peer, provider);
    assert.deepEqual(envelope.params, { taskId, sessionId, cwd: '/fixture-project', toolUseId: 'native-tool-1',
      ...(provider === 'codex' ? { turnId: 'native-turn-1' } : {}) });
    assert.equal(envelope.token, 'b'.repeat(64));
  }
  assert.equal(f.seen.length, 2);
  assert.deepEqual(await readdir(f.root), ['collaboration']);
  assert.deepEqual((await readdir(f.collaborationRoot)).sort(), ['controller-key', 'rpc.sock']);
});
test('worker, child, unrelated, failed, ambiguous and replayed results never request origin binding', async t => {
  const f = await fixture(t);
  for (const patch of [
    { agent_id: 'child' }, { agent_type: 'explore' }, { tool_name: 'mcp__other__claudex_start' },
    { tool_name: 'mcp__claudex-work__claudex_chat_send' }, { tool_response: receipt({ replayed: true }) },
    { tool_response: { ...receipt(), isError: true } }, { tool_response: receipt({ isError: true }) },
    { tool_response: { content: [...receipt().content, ...receipt().content] } },
    { tool_response: receipt({ originChallenge: 'invalid' }) }, { tool_response: { taskId, originChallenge: challenge } },
    { tool_response: receipt({ taskId: '' }) }, { tool_use_id: undefined }, { turn_id: undefined },
  ]) assert.deepEqual(await f.hook(payload(patch)), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await f.hook(payload(), { worker: true }), { code: 0, stdout: '', stderr: '' });
  assert.equal(f.seen.length, 0);
  assert.deepEqual(await readdir(f.root), ['collaboration']);
});
test('serialized MCP response envelopes and narrowly matched underscore names remain only verification hints', async t => {
  const f = await fixture(t);
  await f.hook(payload({ tool_name: 'mcp__claudex_work__claudex_start', tool_response: JSON.stringify(receipt()) }));
  assert.equal(f.seen.length, 1);
  assert.deepEqual(Object.keys(f.seen[0].params).sort(), ['cwd', 'sessionId', 'taskId', 'toolUseId', 'turnId']);
});

test('native Claude MCP content arrays bind only one successful receipt while Codex requires its envelope', async t => {
  const f = await fixture(t);
  for (const tool_response of [receipt().content, JSON.stringify(receipt().content)]) {
    assert.deepEqual(await f.hook(payload({ tool_response, turn_id: undefined }), { provider: 'claude' }), { code: 0, stdout: '', stderr: '' });
    assert.equal(f.seen.at(-1).peer, 'claude');
    assert.deepEqual(f.seen.at(-1).params, { taskId, sessionId, cwd: '/fixture-project', toolUseId: 'native-tool-1' });
    assert.deepEqual(await f.hook(payload({ tool_response })), { code: 0, stdout: '', stderr: '' });
  }
  assert.equal(f.seen.length, 2);
  for (const tool_response of [[], [...receipt().content, ...receipt().content], receipt({ replayed: true }).content,
    receipt({ isError: true }).content, [{ type: 'text', text: 'not-json' }], [{ type: 'image', text: receipt().content[0].text }]]) {
    assert.deepEqual(await f.hook(payload({ tool_response }), { provider: 'claude' }), { code: 0, stdout: '', stderr: '' });
  }
  assert.equal(f.seen.length, 2);
  assert.deepEqual(await readdir(f.root), ['collaboration']);
});
test('stopped and resuming holds suppress PostToolUse RPC without creating any sync state', async t => {
  const f = await fixture(t);
  for (const state of [{ version: 1, stopped: true }, { version: 1, stopped: false, resuming: true }]) {
    await writeFile(join(f.root, 'app-stop.json'), JSON.stringify(state), { mode: 0o600 });
    assert.deepEqual(await f.hook(payload()), { code: 0, stdout: '', stderr: '' });
  }
  assert.equal(f.seen.length, 0);
  assert.deepEqual((await readdir(f.root)).sort(), ['app-stop.json', 'collaboration']);
});
test('unverified native proof remains unbound and typed diagnostics never include the tool payload', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.dispatch(async () => { calls++; const error = new Error('HOOK_PRIVATE_PAYLOAD should not escape'); error.code = 'ORIGIN_UNVERIFIED'; throw error; });
  const result = await f.hook(payload());
  assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(calls, 1);
  assert.match(result.stderr, /ORIGIN_UNVERIFIED/); assert.doesNotMatch(result.stderr, /HOOK_PRIVATE_PAYLOAD/);
  assert.deepEqual(await readdir(f.root), ['collaboration']);
});
test('unsafe controller key is preserved and oversize input cannot cause a broker request', async t => {
  const f = await fixture(t), path = join(f.collaborationRoot, 'controller-key');
  const target = join(f.root, 'foreign-key');
  await writeFile(target, `${'c'.repeat(64)}\n`, { mode: 0o600 });
  await unlink(path); await symlink(target, path);
  const result = await f.hook(payload());
  assert.match(result.stderr, /origin binding was not confirmed/);
  assert.equal(await readFile(target, 'utf8'), `${'c'.repeat(64)}\n`);
  assert.equal((await f.hook(JSON.stringify(payload({ tool_input: { prompt: 'x'.repeat(1024 * 1024) } })))).code, 1);
  assert.equal(f.seen.length, 0);
});

test('native flush rechecks run only on three exact lifecycle events and preserve ordinary sync hints', async t => {
  const f = await fixture(t);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt', 'StopFailure', 'SessionEnd']) {
    const before = f.seen.length;
    assert.deepEqual(await f.hook(payload({ hook_event_name: event, cwd: f.root })), { code: 0, stdout: '', stderr: '' });
    if (['SessionStart', 'UserPromptSubmit', 'Stop'].includes(event)) {
      assert.equal(f.seen.length, before + 1);
      assert.equal(f.seen.at(-1).method, 'origin_recheck');
      assert.deepEqual(f.seen.at(-1).params, { sessionId, cwd: f.root, event });
    } else assert.equal(f.seen.length, before);
  }
  const events = await new SyncEventInbox({ root: f.root }).read();
  assert.equal(Object.values(events.entries).length, 1);
  assert.equal(Object.values(events.entries)[0].nativeId, sessionId);
  assert.doesNotMatch(JSON.stringify(events), /HOOK_PRIVATE_PAYLOAD|originChallenge|native-tool/);
});

test('worker, agent, stop and resuming guards also suppress lifecycle origin rechecks', async t => {
  const f = await fixture(t), input = payload({ hook_event_name: 'Stop', cwd: f.root });
  await f.hook(input, { worker: true });
  await f.hook({ ...input, agent_id: 'child' });
  for (const state of [{ version: 1, stopped: true }, { version: 1, stopped: false, resuming: true }]) {
    await writeFile(join(f.root, 'app-stop.json'), JSON.stringify(state), { mode: 0o600 });
    assert.deepEqual(await f.hook(input), { code: 0, stdout: '', stderr: '' });
  }
  assert.equal(f.seen.length, 0);
  assert.deepEqual((await readdir(f.root)).sort(), ['app-stop.json', 'collaboration']);
});

test('unavailable or refusing origin broker does not suppress normal mailbox registration or sync', async t => {
  const f = await fixture(t);
  f.dispatch(async () => { throw new Error('HOOK_PRIVATE_PAYLOAD'); });
  assert.deepEqual(await f.hook(payload({ hook_event_name: 'SessionStart', cwd: f.root })), { code: 0, stdout: '', stderr: '' });
  await f.closeServer();
  assert.deepEqual(await f.hook(payload({ hook_event_name: 'Stop', cwd: f.root })), { code: 0, stdout: '', stderr: '' });
  const events = await new SyncEventInbox({ root: f.root }).read();
  assert.equal(Object.values(events.entries)[0].kind, 'completed');
  assert.ok((await readdir(f.collaborationRoot)).includes('chat-mailbox'));
});

test('app-stop set during the awaited origin recheck fences later mailbox and sync writes', async t => {
  const f = await fixture(t);
  f.dispatch(async () => { await writeFile(join(f.root, 'app-stop.json'), JSON.stringify({ version: 1, stopped: true }), { mode: 0o600 }); return {}; });
  assert.deepEqual(await f.hook(payload({ hook_event_name: 'SessionStart', cwd: f.root })), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual((await readdir(f.root)).sort(), ['app-stop.json', 'collaboration']);
  assert.deepEqual((await readdir(f.collaborationRoot)).sort(), ['controller-key', 'rpc.sock']);
});

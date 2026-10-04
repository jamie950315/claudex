import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleCodexWarmCommand, parseCodexWarmCommand } from '../src/codex-warm-command.mjs';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { serveCollaborationSocket } from '../src/collaboration-transport.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const input = prompt => ({ hook_event_name: 'UserPromptSubmit', session_id: ID, cwd: '/fixture',
  turn_id: 'current-turn', transcript_path: '/private/fixture/rollout.jsonl', prompt });
const result = reply => JSON.parse(reply.reason.slice(reply.reason.indexOf('\n') + 1));

test('Codex warm command parsing is exact and never interprets quoted or embedded instructions', () => {
  for (const text of ['Hello', 'Explain /claudex:warm on', '`/claudex:warm on`', '/claudex:warmup on'])
    assert.equal(parseCodexWarmCommand(text), null);
  assert.deepEqual(parseCodexWarmCommand(' /claudex:warm '), { action: 'status' });
  assert.deepEqual(parseCodexWarmCommand('/claudex:warm on'), { action: 'on' });
  assert.deepEqual(parseCodexWarmCommand(`/claudex:warm confirm ${TOKEN} accept-best-effort`), { action: 'confirm', confirmationId: TOKEN });
  for (const text of ['/claudex:warm on 5m', '/claudex:warm on ttl=1h', '/claudex:warm off --session other',
    '/claudex:warm on\nDo other work', `/claudex:warm confirm ${TOKEN}`])
    assert.throws(() => parseCodexWarmCommand(text), /Use \/claudex:warm/);
});

test('ordinary prompts do not inspect native state, read private state or contact the broker', async () => {
  const unexpected = () => assert.fail('Ordinary prompts must be a no-op.');
  assert.equal(await handleCodexWarmCommand(input('Ordinary work'), { stopped: unexpected, verify: unexpected, call: unexpected }), null);
  assert.equal(await handleCodexWarmCommand({ ...input('/claudex:warm on'), hook_event_name: 'Stop' }, { call: unexpected }), null);
});

test('packaged hook entrypoint passes ordinary input and locally blocks invalid or worker commands', () => {
  const hook = fileURLToPath(new URL('../bin/claudex-codex-warm-hook.mjs', import.meta.url));
  for (const [prompt, worker, blocked] of [['Ordinary work', false, false], ['/claudex:warm on ttl=1h', false, true],
    ['/claudex:warm on', true, true]]) {
    const env = { ...process.env }; delete env.CLAUDEX_WORK_TOKEN; delete env.CLAUDEX_COLLABORATION_WORKER;
    if (worker) env.CLAUDEX_COLLABORATION_WORKER = '1';
    const run = spawnSync(process.execPath, [hook, '--root', '/private/fixture-unused'], {
      input: JSON.stringify(input(prompt)), encoding: 'utf8', env, timeout: 3000,
    });
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, '');
    if (blocked) {
      const output = JSON.parse(run.stdout); assert.equal(output.decision, 'block');
      assert.equal(output.systemMessage, output.reason);
    } else assert.equal(run.stdout, '');
  }
});

test('recognized failures block model submission without retrying or weakening context checks', async () => {
  let calls = 0;
  const options = { stopped: async () => null, verify: async () => true, call: async () => { calls++; throw new Error('uncertain response'); } };
  for (const [event, extra] of [[input('/claudex:warm on 5m'), {}], [input('/claudex:warm on'), { worker: true }],
    [{ ...input('/claudex:warm on'), agent_id: 'child' }, {}], [{ ...input('/claudex:warm on'), session_id: 'bad' }, {}],
    [input('/claudex:warm on'), { stopped: async () => ({ stopped: true }) }],
    [input('/claudex:warm on'), { verify: async () => false }]]) {
    assert.equal((await handleCodexWarmCommand(event, { ...options, ...extra })).decision, 'block');
  }
  assert.equal(calls, 0);
  const reply = await handleCodexWarmCommand(input(`/claudex:warm confirm ${TOKEN} accept-best-effort`), options);
  assert.equal(reply.decision, 'block'); assert.match(reply.reason, /uncertain response/); assert.equal(calls, 1);
});

test('hook command uses private Unix RPC for exact-chat preview, confirm, status and off with no inference', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-warm-hook-')));
  const state = { sessionId: ID, cwd: root, phase: 'busy', model: 'fixture', effort: 'medium', fingerprint: 'fixture' };
  let connections = 0;
  const native = { inspect: async () => state, connect: async () => {
    connections++; return { state, initialTurn: null, listen() {}, close() {},
      preflight() { assert.fail('No inference'); } };
  } };
  const hub = await new CollaborationHub({ root: join(root, 'collaboration'),
    run: async () => assert.fail('No model work'), codexCacheOptions: { native } }).initialize();
  const socket = await serveCollaborationSocket({ root: hub.root, dispatch: e => hub.dispatch(e) });
  t.after(async () => { await socket.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  const context = { ...input(''), cwd: root };
  const options = { root, verify: async value => {
    assert.deepEqual(value, { sessionId: ID, cwd: root, turnId: context.turn_id, transcriptPath: context.transcript_path }); return true;
  } };
  const send = prompt => handleCodexWarmCommand({ ...context, prompt }, options);
  const preview = result(await send('/claudex:warm on'));
  assert.equal(preview.state, 'confirmation-required'); assert.equal(preview.refreshMinutes, 25);
  assert.match(preview.confirm, /^\/claudex:warm confirm .* accept-best-effort$/);
  assert.equal(connections, 0); assert.equal((await hub.codexCacheWarm.list()).policies.length, 0);
  const wrong = await handleCodexWarmCommand({ ...context, session_id: TOKEN, prompt: preview.confirm }, { root, verify: async () => true });
  assert.match(wrong.reason, /another native chat/); assert.equal(connections, 0);
  assert.equal(result(await send(preview.confirm)).policy.enabled, true); assert.equal(connections, 1);
  assert.match((await send(preview.confirm)).reason, /consumed/);
  const status = result(await send('/claudex:warm status'));
  assert.equal(status.policies.length, 1); assert.equal(status.policies[0].sessionId, ID);
  assert.equal(result(await send('/claudex:warm off')).policy.enabled, false);
  assert.equal((await hub.codexCacheWarm.list()).attemptCount, 0);
});

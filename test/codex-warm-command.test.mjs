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

test('Codex warm command parsing is exact and never interprets quoted or embedded instructions', () => {
  for (const text of ['Hello', 'Explain /claudex:warm on', '`/claudex:warm on`', '/claudex:warmup on'])
    assert.equal(parseCodexWarmCommand(text), null);
  assert.deepEqual(parseCodexWarmCommand(' /claudex:warm '), { action: 'status' });
  assert.deepEqual(parseCodexWarmCommand('/claudex:warm on'), { action: 'on', bounds: { maxMinutes: 240, maxRefreshes: 9 } });
  assert.deepEqual(parseCodexWarmCommand(`/claudex:warm confirm ${TOKEN} accept-best-effort`), { action: 'confirm', confirmationId: TOKEN });
  const noon = new Date(2026, 0, 1, 12, 0).getTime();
  assert.deepEqual(parseCodexWarmCommand('/claudex:warm on rounds=4', noon), { action: 'on', bounds: { maxMinutes: 10080, maxRefreshes: 4 } });
  assert.deepEqual(parseCodexWarmCommand('/claudex:warm on for=2h', noon), { action: 'on', bounds: { maxMinutes: 120, maxRefreshes: 4 } });
  assert.deepEqual(parseCodexWarmCommand('/claudex:warm on until=13:30', noon), { action: 'on', bounds: { maxMinutes: 90, maxRefreshes: 3 } });
  assert.deepEqual(parseCodexWarmCommand('/claudex:warm on until=2:12:00', noon), { action: 'on', bounds: { maxMinutes: 1440, maxRefreshes: 57 } });
  for (const text of ['/claudex:warm on for=10m', '/claudex:warm on rounds=0', '/claudex:warm on for=2h until=15:00', '/claudex:warm on rounds=2 for=2h', '/claudex:warm on rounds=404', '/claudex:warm off rounds=2'])
    assert.throws(() => parseCodexWarmCommand(text, noon));
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

test('one on command enables its exact chat over private Unix RPC without a second confirmation or inference', async t => {
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
  const options = { root, getTranslator: async () => undefined, verify: async value => {
    assert.deepEqual(value, { sessionId: ID, cwd: root, turnId: context.turn_id, transcriptPath: context.transcript_path }); return true;
  } };
  const send = prompt => handleCodexWarmCommand({ ...context, prompt }, options);
  const enabled = await send('/claudex:warm on');
  assert.equal(enabled.reason.split('\n').length, 5);
  assert.doesNotMatch(enabled.reason, /"policy"|"sessionId"|confirmationId|\/fixture/);
  let status = await hub.codexCacheWarm.list();
  assert.equal(status.policies[0].refreshMinutes, 25); assert.equal(status.policies[0].enabled, true); assert.equal(connections, 1);
  assert.equal((await send('/claudex:warm status')).reason.split('\n').length, 5);
  assert.equal(status.policies.length, 1); assert.equal(status.policies[0].sessionId, ID);
  assert.equal((await send('/claudex:warm off')).reason.split('\n').length, 5);
  // The user's own limits reach the broker as its existing bounds.
  assert.match((await send('/claudex:warm on rounds=7')).reason, /Limits: 0\/7 warm requests/);
  status = await hub.codexCacheWarm.list();
  assert.equal(status.policies[0].maxRefreshes, 7); assert.equal(status.policies[0].maxMinutes, 10080);
  await send('/claudex:warm off');
  status = await hub.codexCacheWarm.list(); assert.equal(status.policies[0].enabled, false);
  assert.equal((await hub.codexCacheWarm.list()).attemptCount, 0);
});

test('direct on keeps the context fence and never retries an uncertain internal confirmation', async () => {
  const preview = { confirmationId: TOKEN, sessionId: ID, cwd: '/fixture' };
  for (const scenario of ['context-changed', 'wrong-target', 'uncertain']) {
    const methods = []; let checks = 0;
    const reply = await handleCodexWarmCommand(input('/claudex:warm on'), {
      stopped: async () => null, verify: async () => ++checks === 1 || scenario !== 'context-changed',
      call: async (_root, method, params) => {
        methods.push(method);
        if (method === 'codex_cache_warm_prepare') return { ...preview, ...(scenario === 'wrong-target' ? { sessionId: TOKEN } : {}) };
        assert.equal(method, 'codex_cache_warm_confirm');
        assert.deepEqual(params, { sessionId: ID, cwd: '/fixture', bestEffort: true, confirmationId: TOKEN });
        throw new Error('unknown native response');
      },
    });
    assert.equal(reply.decision, 'block'); assert.match(reply.reason, /Operation not confirmed/);
    assert.deepEqual(methods, scenario === 'uncertain'
      ? ['codex_cache_warm_prepare', 'codex_cache_warm_confirm'] : ['codex_cache_warm_prepare']);
  }
});

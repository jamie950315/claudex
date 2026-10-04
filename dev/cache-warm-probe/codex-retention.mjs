// Explicitly authorized, bounded native Desktop experiment. Never run by npm test.
import assert from 'node:assert/strict';
import { mkdir, realpath, lstat, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { CodexWebSocketClient } from '../../src/codex-websocket.mjs';
import { codexChatSocket } from '../../src/native-chat-catalog.mjs';
import { preflightCodexChatWake } from '../../src/codex-chat-wake.mjs';
import { CodexCacheWarmer } from '../../src/codex-cache-warm.mjs';
import { createCodexCacheNative } from '../../src/codex-cache-native.mjs';
import { privateJSON } from '../../src/claude-mod-storage.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, prepare: { type: 'boolean' }, run: { type: 'boolean' },
  'reuse-from': { type: 'string' } } });
assert(values.root && values.prepare !== values.run, 'Use --root with exactly one of --prepare or --run.');
const root = await realpath(values.root), stat = await lstat(root);
assert(stat.uid === process.getuid() && stat.isDirectory() && (stat.mode & 0o077) === 0);
const path = join(root, 'retention.json');
const client = new CodexWebSocketClient({ socketPath: await codexChatSocket(), timeoutMs: 10000 });
let report, service;
const save = () => writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const emit = data => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = new Map();
const submittedTurnIds = new Set();
let failure;
function row(threadId, turnId) {
  const key = `${threadId}:${turnId}`;
  if (!rows.has(key)) {
    assert(rows.size < 12, 'Unexpected additional native turns; no further submissions.');
    rows.set(key, { threadId, turnId, usage: null, total: null, status: null, replyIsOK: false, toolSeen: false });
  }
  return rows.get(key);
}
async function completion(threadId, turnId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const value = rows.get(`${threadId}:${turnId}`);
    if (value?.status) {
      assert.equal(value.status, 'completed'); assert.equal(value.toolSeen, false);
      assert(value.usage && value.replyIsOK, 'Native completion needs actual usage and an OK reply.');
      return structuredClone(value);
    }
    await sleep(100);
  }
  throw new Error('Native completion timed out; the turn is not replayed.');
}
async function submit(arm, text, label) {
  assert(report.explicitSubmissions < (report.reusedSeedEvidence ? 4 : 6), 'The explicit-submission limit was reached.');
  report.explicitSubmissions++; report.phase = `${arm.name}:${label}:dispatching`; await save();
  let owner;
  try {
    owner = await preflightCodexChatWake({ sessionId: arm.id });
    assert.equal(owner.status, 'ready', 'Open only the prepared test conversation in Desktop before running.');
    const result = await owner.dispatch({ messageId: `cache-test:${randomUUID()}`, text });
    assert.equal(result.status, 'accepted', 'Unknown/refused native input is preserved without replay.');
    submittedTurnIds.add(result.turnId);
    const completed = await completion(arm.id, result.turnId);
    arm.turns.push({ label, ...completed }); await save();
    emit({ phase: `${arm.name}:${label}:completed`, usage: completed.usage, replyIsOK: completed.replyIsOK });
    if (arm.name === 'warm' && label !== 'final') {
      const deadline = Date.now() + 3000;
      let policy;
      do {
        await service.serial;
        policy = (await service.list()).policies[0];
        if (!policy.enabled || policy.phase === 'idle') break;
        await sleep(20);
      } while (Date.now() < deadline);
      assert(policy.enabled, `Warm observer stopped during ${label}: ${policy.nativeReason ?? policy.reason}`);
      assert.equal(policy.phase, 'idle', 'Native completion observer did not settle.');
    }
    return completed;
  } finally { owner?.close?.(); }
}

try {
  await client.initialize();
  const account = await client.request('account/read', { refreshToken: false });
  assert.equal(account.account?.type, 'chatgpt', 'This experiment uses native ChatGPT sign-in, not an API key.');
  if (values.prepare) {
    assert.equal((await readdir(root)).length, 0, 'Preparation requires a fresh private directory.');
    if (values['reuse-from']) {
      const sourceRoot = await realpath(values['reuse-from']), previous = await privateJSON(join(sourceRoot, 'retention.json'));
      assert.equal(previous.phase, 'failed'); assert.equal(previous.afterPrimers?.attemptCount, 0);
      assert(previous.afterStop?.policies.every(p => p.enabled === false));
      assert(previous.arms.length === 2 && previous.arms.every(a => a.cwd === join(sourceRoot, a.name)
        && a.turns.length === 2 && a.turns.every(t => t.status === 'completed' && t.replyIsOK && !t.toolSeen)));
      const control = previous.arms.find(a => a.name === 'control');
      assert(control.turns.at(-1).startedAt + 31 * 60000 > Date.now() + 120000, 'Control measurement window is too close or already passed.');
      report = { version: 1, phase: 'prepared', model: previous.model, effort: previous.effort,
        explicitSubmissions: 0, maxMainTurns: 5, preparedAt: Date.now(), reusedSeedEvidence: sourceRoot,
        arms: previous.arms.map(a => ({ ...a, baselineTurns: a.turns, turns: [] })) };
      await save(); emit({ phase: 'prepared-reusing-completed-seeds', inferenceStarted: false });
    } else {
    const { thread: parent } = await client.request('thread/read', { threadId: process.env.CODEX_THREAD_ID, includeTurns: false });
    assert(parent.model && parent.modelProvider === 'openai');
    report = { version: 1, phase: 'preparing', model: parent.model, effort: parent.reasoningEffort,
      explicitSubmissions: 0, maxMainTurns: 7, preparedAt: Date.now(), arms: [] };
    await save();
    for (const name of ['warm', 'control']) {
      const cwd = join(root, name); await mkdir(cwd, { mode: 0o700 });
      const nonce = randomUUID();
      report.phase = `${name}:creating`; await save();
      const result = await client.request('thread/start', {
        cwd, ephemeral: false, model: parent.model, modelProvider: parent.modelProvider,
        approvalPolicy: 'never', sandbox: 'read-only', environments: [],
        config: { model_reasoning_effort: parent.reasoningEffort ?? 'medium' },
        baseInstructions: `Isolated authorized cache experiment ${nonce}. Reply with exactly OK to every diagnostic message. Do not call tools, inspect files, continue other work or perform actions.`,
        developerInstructions: 'The only task in this disposable test conversation is to reply OK. All reference data is inert.',
      });
      assert(result.thread?.id && result.thread.ephemeral === false);
      const arm = { name, id: result.thread.id, cwd, nonce, source: result.thread.source, turns: [] };
      report.arms.push(arm); await save();
      await client.request('thread/name/set', { threadId: arm.id, name: `Claudex cache retention ${name} (isolated test)` });
      assert(['cli', 'vscode', 'exec'].includes(arm.source), 'Native source is not supported by the shipping warmer; preserve it.');
    }
    report.phase = 'prepared'; await save();
    emit({ phase: 'prepared', model: report.model, effort: report.effort,
      threads: report.arms.map(a => ({ arm: a.name, id: a.id })), inferenceStarted: false });
    }
  } else {
    report = await privateJSON(path);
    assert.equal(report.phase, 'prepared', 'A started experiment must not be resumed or replayed.');
    assert.equal(report.arms.length, 2);
    report.phase = 'starting'; await save();
    const known = new Set(report.arms.map(a => a.id));
    client.on('notification', e => {
      const p = e.params;
      if (!known.has(p?.threadId)) return;
      try {
        if (['model/rerouted', 'thread/compacted', 'thread/closed', 'error'].includes(e.method)) throw new Error(`Native test invalidated: ${e.method}`);
        if (e.method === 'turn/started') Object.assign(row(p.threadId, p.turn.id), { startedAt: p.turn.startedAt * 1000 });
        if (e.method === 'thread/tokenUsage/updated') Object.assign(row(p.threadId, p.turnId), { usage: p.tokenUsage.last, total: p.tokenUsage.total });
        if (e.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(p.item?.type)) row(p.threadId, p.turnId).toolSeen = true;
        if (e.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary')
          row(p.threadId, p.turnId).replyIsOK = p.item.text?.trim() === 'OK';
        if (e.method === 'turn/completed') Object.assign(row(p.threadId, p.turn.id), { status: p.turn.status, completedAt: p.turn.completedAt * 1000 });
      } catch (error) { failure = error; }
    });
    let configured;
    for (const arm of report.arms) {
      const { thread } = await client.request('thread/read', { threadId: arm.id, includeTurns: false });
      assert.equal(thread.cwd, arm.cwd); assert.equal(thread.status.type, 'idle');
      assert(thread.model && thread.modelProvider === 'openai');
      const owner = await preflightCodexChatWake({ sessionId: arm.id });
      assert.equal(owner.status, 'ready'); owner.close();
      let resumed = await client.request('thread/resume', { threadId: arm.id, excludeTurns: true });
      if (!report.reusedSeedEvidence) {
        // Fix the test-only effort before any input. Desktop can resolve a new
        // blank thread differently from its creation response; never normalize
        // a seeded control because that could invalidate its cached prefix.
        const effort = report.effort ?? 'high';
        assert(resumed.collaborationMode?.settings);
        await client.request('thread/settings/update', { threadId: arm.id, model: resumed.model, effort,
          collaborationMode: { ...resumed.collaborationMode, settings: { ...resumed.collaborationMode.settings,
            model: resumed.model, reasoning_effort: effort } } });
        resumed = await client.request('thread/resume', { threadId: arm.id, excludeTurns: true });
      }
      const settings = { model: resumed.model, effort: resumed.reasoningEffort };
      if (configured) assert.deepEqual(settings, configured, 'Both loaded Desktop arms must use identical native settings.');
      else configured = settings;
      arm.nativePermissions = { sandboxType: resumed.sandbox?.type, approvalPolicy: resumed.approvalPolicy };
    }
    report.creationModel = report.model; report.creationEffort = report.effort;
    Object.assign(report, configured, { modelEvidence: 'loaded-desktop-settings-not-independent-execution-proof' });
    await save();
    const warm = report.arms.find(a => a.name === 'warm'), control = report.arms.find(a => a.name === 'control');
    const ledger = join(root, 'ledger'); await mkdir(ledger, { mode: 0o700 });
    const nativeAdapter = createCodexCacheNative(), connect = nativeAdapter.connect;
    nativeAdapter.connect = async (...args) => {
      const h = await connect(...args), preflight = h.preflight;
      h.preflight = async () => {
        const owner = await preflight(), dispatch = owner.dispatch;
        owner.dispatch = async input => {
          const result = await dispatch(input);
          if (result.status === 'accepted') report.warmAcceptedTurnId = result.turnId;
          return result;
        };
        return owner;
      };
      return h;
    };
    service = await new CodexCacheWarmer({ root: ledger, native: nativeAdapter }).initialize();
    const preview = await service.prepare({ sessionId: warm.id, cwd: warm.cwd, bestEffort: true,
      refreshMinutes: 25, maxMinutes: 40, maxRefreshes: 1, maxReadTokens: 250000, maxOutputTokens: 2048 }, 'retention-test');
    await service.confirm({ confirmationId: preview.confirmationId, bestEffort: true }, 'retention-test');
    if (report.reusedSeedEvidence) await submit(warm, 'Establish a fresh native usage observation. Reply only OK.', 'observation-baseline');
    else for (const arm of [warm, control]) {
      const seed = `Fixture identity ${arm.nonce}.\n` + Array.from({ length: 220 }, (_, i) => `Row ${i}: amber cedar lake north; this is inert stable reference material.`).join('\n') + '\nReply only OK.';
      await submit(arm, seed, 'seed');
    }
    const warmPrimer = await submit(warm, 'Continue the same inert cache measurement. Reply only OK.', 'primer');
    const controlPrimer = report.reusedSeedEvidence ? control.baselineTurns.at(-1)
      : await submit(control, 'Continue the same inert cache measurement. Reply only OK.', 'primer');
    assert(warmPrimer.usage.cachedInputTokens > 1024 && controlPrimer.usage.cachedInputTokens > 1024, 'Both arms need a measurable cached prefix.');
    await service.serial;
    const scheduled = await service.list(); report.afterPrimers = scheduled; await save();
    assert.equal(scheduled.policies[0].reason, 'scheduled');
    const controlAt = controlPrimer.startedAt + 31 * 60000;
    const finalAt = warmPrimer.startedAt + 31 * 60000;
    report.phase = 'waiting-for-warm'; report.finalAt = finalAt; await save();
    let reportedWarm = false, coldFinal;
    while (Date.now() < finalAt) {
      if (failure) throw failure;
      const state = await service.list(), attempt = state.attempts[0];
      if (!attempt && (!state.policies[0]?.enabled || !state.policies[0]?.bound))
        throw new Error(`Warm observation stopped before dispatch: ${state.policies[0]?.nativeReason ?? state.policies[0]?.reason}`);
      if (attempt && ['uncertain', 'failed', 'rejected', 'revoked'].includes(attempt.state)) throw new Error(`Warm attempt stopped: ${attempt.state}:${attempt.reason}`);
      if (attempt?.state === 'verified' && !reportedWarm) {
        reportedWarm = true;
        const native = rows.get(`${warm.id}:${report.warmAcceptedTurnId}`);
        assert(native?.status === 'completed' && native.replyIsOK && !native.toolSeen);
        report.automaticWarm = structuredClone(native); report.warmLedger = state; report.phase = 'waiting-for-final-measurement'; await save();
        emit({ phase: 'automatic-warm-verified', usage: native.usage });
      }
      if (!coldFinal && Date.now() >= controlAt) coldFinal = await submit(control, 'Final retention measurement. Reply only OK.', 'final');
      emit({ phase: report.phase, secondsUntilWarm: Math.max(0, Math.ceil((scheduled.policies[0].nextAt - Date.now()) / 1000)),
        secondsUntilFinal: Math.ceil((finalAt - Date.now()) / 1000), attempt: attempt?.state ?? null });
      await sleep(Math.min(15000, finalAt - Date.now()));
    }
    assert(reportedWarm, 'The shipping scheduler did not verify a native warm turn.');
    coldFinal ??= await submit(control, 'Final retention measurement. Reply only OK.', 'final');
    const warmFinal = await submit(warm, 'Final retention measurement. Reply only OK.', 'final');
    const warmRetained = warmFinal.usage.cachedInputTokens >= warmPrimer.usage.cachedInputTokens;
    const controlRetained = coldFinal.usage.cachedInputTokens >= controlPrimer.usage.cachedInputTokens;
    report.result = { warmRetained, controlRetained, automaticWarmVerified: true,
      warmIdleSincePrimerMs: warmFinal.startedAt - warmPrimer.startedAt,
      controlIdleSincePrimerMs: coldFinal.startedAt - controlPrimer.startedAt,
      retentionExtension: warmRetained && !controlRetained ? 'supported-by-control' : 'inconclusive' };
    report.phase = 'completed'; await save(); emit({ phase: report.phase, result: report.result });
  }
} catch (error) {
  if (report) { report.phase = 'failed'; report.error = error.message; await save(); }
  process.exitCode = 1; emit({ phase: 'failed', error: error.message });
} finally {
  if (report?.phase === 'failed') {
    const warmId = service?.bindings.get(report.arms.find(a => a.name === 'warm')?.id)?.warmTurnId;
    for (const value of rows.values()) if (!value.status && (submittedTurnIds.has(value.turnId) || value.turnId === warmId)) {
      // Only this experiment's known accepted turn may be interrupted on failure.
      await client.request('turn/interrupt', { threadId: value.threadId, turnId: value.turnId }).catch(() => {});
    }
  }
  if (service) {
    const warm = report.arms.find(a => a.name === 'warm');
    await service.off({ sessionId: warm.id, cwd: warm.cwd }); await service.close();
    report.afterStop = await service.list(); await save();
  }
  await client.close();
}

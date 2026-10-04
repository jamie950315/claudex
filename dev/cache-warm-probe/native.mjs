// Manual, explicitly authorized native Mod acceptance; never run by npm test.
import assert from 'node:assert/strict';
import { mkdir, realpath, readdir, lstat, writeFile, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { stageClaudeMod } from '../../src/claude-mod-install.mjs';
import { CollaborationHub } from '../../src/collaboration-hub.mjs';
import { serveCollaborationSocket } from '../../src/collaboration-transport.mjs';
import { createTokenLimitEvidence } from './token-limit-evidence.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, claude: { type: 'string' }, run: { type: 'boolean' }, 'ttl-sync': { type: 'boolean' } } });
assert(values.root && values.claude, 'Supply a new private --root and the native --claude executable.');
assert(process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1', 'An explicitly authorized process-only native Mod opt-in is required.');
const root = await realpath(values.root), binary = await realpath(values.claude);
const stat = await lstat(root);
assert(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && (await readdir(root)).length === 0);
const repo = fileURLToPath(new URL('../..', import.meta.url));
assert(relative(repo, root).startsWith('../'), 'Evidence must stay outside the checkout.');
const cwd = join(root, 'project'); await mkdir(cwd, { mode: 0o700 });
const staged = await stageClaudeMod({ output: join(root, 'stage'), stateRoot: root,
  nodeBinary: await realpath(process.execPath) });
const hub = await new CollaborationHub({ root: join(root, 'collaboration'), run: async () => { throw new Error('This acceptance broker cannot start workers.'); } }).initialize();
const transport = await serveCollaborationSocket({ root: hub.root, dispatch: envelope => hub.dispatch(envelope) });
const report = { model: 'claude-sonnet-5-5', effort: 'medium', processOnlyModOptIn: true,
  native: [], commands: [], localOutputs: [], outcome: 'initializing', dispatchedUserMessages: 0 };
const emit = data => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
const evidence = createTokenLimitEvidence(), queue = [];
const sessions = new Set(); let child, active, consume, pending, wake, ended = false, failure;
const env = { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m',
  CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128', CLAUDE_CODE_EFFORT_LEVEL: 'medium' };
for (const key of ['CLAUDEX_COLLABORATION_WORKER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M', 'DISABLE_PROMPT_CACHING']) delete env[key];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function send(text) {
  assert(!pending && !failure, 'Do not overlap or replay an uncertain native submission.');
  let timer;
  const startOutputs = report.localOutputs.length;
  const done = new Promise((resolve, reject) => { pending = { resolve, reject }; });
  report.dispatchedUserMessages++;
  queue.push({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content: text } }); wake?.();
  try {
    const receipt = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native receipt timeout; no replay.')), 45000); })]);
    return { receipt, outputs: report.localOutputs.slice(startOutputs) };
  } finally { clearTimeout(timer); }
}
function jsonReply(reply) {
  const texts = [...reply.outputs.map(item => item.content), reply.receipt.text].filter(value => typeof value === 'string');
  for (const text of texts) {
    try { return JSON.parse(text); } catch {}
    const begin = text.indexOf('{'), end = text.lastIndexOf('}');
    if (begin >= 0 && end > begin) { try { return JSON.parse(text.slice(begin, end + 1)); } catch {} }
  }
  throw new Error('The native local command did not return structured evidence.');
}
try {
  const prompt = { async *[Symbol.asyncIterator]() {
    while (!ended) { if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; }); }
  } };
  active = query({ prompt, options: { cwd, pathToClaudeCodeExecutable: binary,
    model: report.model, effort: report.effort, persistSession: false, settingSources: [],
    strictMcpConfig: true, mcpServers: {}, plugins: [{ type: 'local', path: staged.plugin }], tools: [],
    permissionMode: 'dontAsk', maxTurns: 1, maxBudgetUsd: 0.25, includePartialMessages: true, env,
    extraArgs: { 'debug-file': join(root, 'native-debug.log') },
    settings: { remoteControlAtStartup: false, crossSessionInbound: 'refuse', enabledPlugins: {}, promptCacheTtl: '5m' },
    systemPrompt: `Native cache acceptance ${randomUUID()}. Reply only OK to measurement prompts. Never call tools.`,
    spawnClaudeCodeProcess: options => (child = spawn(options.command, options.args,
      { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] })),
    stderr: text => { if (/hooks modules are turned off/.test(text)) failure = new Error('Native Mod refused to load.'); },
  } });
  consume = (async () => {
    try { for await (const e of active) {
      if (e.session_id) sessions.add(e.session_id);
      evidence.observe(e, pending ? report.dispatchedUserMessages : 'native-autonomous');
      if (e.type === 'system' && e.subtype === 'local_command_output') report.localOutputs.push({ content: e.content });
      if (e.type !== 'result') continue;
      const receipt = { subtype: e.subtype, isError: e.is_error, turns: e.num_turns,
        usage: e.usage, modelUsage: e.modelUsage, cumulativeEstimatedUsd: e.total_cost_usd, text: e.result ?? null };
      report.native.push(receipt);
      emit({ kind: 'native-result', subtype: receipt.subtype, isError: receipt.isError, turns: receipt.turns,
        usage: receipt.usage, replyIsOK: receipt.text?.trim() === 'OK' });
      pending?.resolve(receipt); pending = null;
    } } catch (error) { failure = error; pending?.reject(error); }
  })();
  await active.initializationResult();
  // SDK initialization can publish a cold command catalog before session.start
  // finishes. The actual loaded Mod reports only after command.register returns.
  let loaded;
  for (let i = 0; i < 30; i++) {
    const commands = await active.supportedCommands();
    report.commands = commands.map(item => item.name);
    loaded = await hub.dispatch({ peer: 'claude', token: hub.controllerToken, method: 'mod_wake_status', params: {} });
    if (loaded.liveObserverCount === 1) break;
    assert(!failure, failure?.message);
    await delay(200);
  }
  report.loadedObserver = loaded;
  assert.equal(loaded?.liveObserverCount, 1, 'The actual staged Mod did not finish native startup; no prompt sent.');
  const stagedVersion = JSON.parse(await readFile(join(staged.plugin, '.claude-plugin/plugin.json'), 'utf8')).version;
  assert(loaded.versions.some(item => item.version === stagedVersion && item.observers === 1), 'Loaded Mod version differs from the stage.');
  const status = jsonReply(await send('/claudex warm status'));
  assert.equal(status.local.enabled, false);
  assert.equal(report.native.at(-1).turns, 0, 'Status must not invoke a model.');
  if (!values.run) report.outcome = 'native-status-only';
  else if (values['ttl-sync']) {
    report.ttlSync = [];
    for (const ttl of ['1h', '5m']) {
      const preview = jsonReply(await send(`/claudex warm on ttl=${ttl} maxMinutes=2 maxRefreshes=1 maxOutputTokens=256`));
      assert.equal(preview.state, 'confirmation-required');
      assert.equal(report.native.at(-1).turns, 0);
      const confirmed = jsonReply(await send(preview.confirm));
      assert.equal(confirmed.policy.enabled, true);
      assert.equal(confirmed.nativeCacheSync.value, ttl);
      assert.equal(confirmed.nativeCacheSync.scope, 'current-process');
      assert.equal(report.native.at(-1).turns, 0);
      const prompt = ttl === '1h'
        ? Array.from({ length: 120 }, (_, i) => `Fixture ${i}: amber cedar lake north. Stable inert reference data.`).join('\n') + '\nReply only OK.'
        : 'Measure the newly selected cache lifetime. Reply only OK.';
      const response = await send(prompt);
      assert(!response.receipt.isError && response.receipt.text?.trim() === 'OK');
      const bucket = ttl === '1h' ? 'ephemeral_1h_input_tokens' : 'ephemeral_5m_input_tokens';
      const other = ttl === '1h' ? 'ephemeral_5m_input_tokens' : 'ephemeral_1h_input_tokens';
      assert(response.receipt.usage.cache_creation[bucket] > 0, `Native API did not report ${ttl} cache writes.`);
      assert.equal(response.receipt.usage.cache_creation[other], 0);
      report.ttlSync.push({ requested: ttl, confirmation: confirmed.nativeCacheSync,
        cacheCreation: response.receipt.usage.cache_creation });
      await delay(300); // Drain native completion hooks before a local setting change.
      await send('/claudex warm off');
      const current = jsonReply(await send('/claudex warm status'));
      assert.equal(current.nativeCache.value, ttl, 'Off must not silently revert the native TTL choice.');
    }
    assert.equal((await hub.cacheWarm.list()).attemptCount, 0, 'TTL verification must not dispatch a timer refresh.');
    report.outcome = 'native-ttl-sync-verified';
  }
  else {
    const preview = jsonReply(await send('/claudex warm on ttl=5m maxMinutes=10 maxRefreshes=1 maxOutputTokens=256'));
    assert.equal(preview.state, 'confirmation-required');
    assert.equal(report.native.at(-1).turns, 0);
    const confirmed = jsonReply(await send(preview.confirm));
    assert.equal(confirmed.policy.enabled, true);
    assert.equal(report.native.at(-1).turns, 0);
    const seed = Array.from({ length: 180 }, (_, i) => `Fixture ${i}: amber cedar lake north. This sentence is stable inert reference data.`).join('\n') + '\nReply only OK.';
    const first = await send(seed);
    assert(!first.receipt.isError && first.receipt.text?.trim() === 'OK');
    // Native result frames can precede completion-hook settlement. Await the
    // independent broker evidence rather than racing that asynchronous boundary.
    let before;
    for (let i = 0; i < 50; i++) {
      before = await hub.cacheWarm.list();
      if (before.policies[0]?.reason !== 'busy') break;
      await delay(100);
    }
    report.afterSeed = before;
    const policy = before.policies[0];
    assert.equal(policy.reason, 'scheduled', JSON.stringify(policy));
    assert(Number.isSafeInteger(policy.nextAt));
    const deadline = policy.nextAt + 60000;
    let result;
    while (Date.now() < deadline) {
      assert(!failure, failure?.message);
      await delay(Math.min(15000, Math.max(1, deadline - Date.now())));
      result = await hub.cacheWarm.list();
      const attempt = result.attempts[0];
      emit({ kind: 'waiting', secondsUntilDue: Math.ceil((policy.nextAt - Date.now()) / 1000),
        reason: result.policies[0]?.reason, attemptState: attempt?.state ?? null });
      if (attempt && ['failed', 'uncertain', 'rejected', 'revoked'].includes(attempt.state)) break;
      if (attempt?.state === 'verified' && result.policies[0]?.phase === 'idle') break;
    }
    report.finalBeforeClose = result;
    assert.equal(result?.attempts.length, 1);
    assert.equal(result.attempts[0].state, 'verified', JSON.stringify(result.attempts[0]));
    assert(result.attempts[0].actual.cacheReadTokens >= result.attempts[0].requiredPrefixTokens);
    assert.equal(result.policies[0].reason, 'refresh-limit');
    await send('/claudex warm off');
    report.afterOff = await hub.cacheWarm.list();
    assert.equal(report.afterOff.policies[0].enabled, false);
    report.outcome = 'native-cache-warming-verified';
  }
} catch (error) {
  report.outcome = 'blocked-or-failed'; report.error = error.message; process.exitCode = 1;
  if (report.loadedObserver?.liveObserverCount === 1 && !pending && !failure) {
    try { report.localAfterFailure = jsonReply(await send('/claudex warm status')); } catch {}
  }
}
finally {
  ended = true; wake?.(); active?.close(); await consume;
  if (child && child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  report.nativeProcessExited = !child || child.exitCode !== null || child.signalCode !== null;
  report.nativeSessionCount = sessions.size;
  report.responseEvidence = evidence.summary();
  report.final = await hub.cacheWarm.list();
  await transport.close(); await hub.close();
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  emit({ kind: 'finished', outcome: report.outcome, error: report.error ?? null, report: join(root, 'report.json') });
}

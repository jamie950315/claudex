// Authorized manual experiment, deliberately outside npm test and app payloads.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, realpath, lstat, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { assessEvidence } from './evidence.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, claude: { type: 'string' },
  run: { type: 'boolean', default: false } } });
assert(values.root && values.claude, 'Supply --root (an empty private directory) and --claude.');
const root = await realpath(values.root), binary = await realpath(values.claude);
const rootInfo = await lstat(values.root);
assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && rootInfo.uid === process.getuid()
  && (rootInfo.mode & 0o077) === 0, 'Output root must be an owned private directory, not a symlink.');
assert((await readdir(root)).length === 0, 'Output root must be empty; preserve previous evidence.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inside = relative(repository, root);
assert(inside !== '' && (inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)),
  'Runtime evidence must stay outside the repository.');
const MODEL = 'claude-sonnet-5-5', EFFORT = 'medium';
const clients = [], report = { model: MODEL, effort: EFFORT, mode: values.run ? 'authorized-live' : 'load-only', arms: {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const emit = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

async function client(arm) {
  const cwd = join(root, arm);
  await mkdir(cwd, { mode: 0o700 }); // Refuse reuse: no uncertain work is replayed.
  const plugin = join(cwd, 'plugin');
  await cp(join(dirname(fileURLToPath(import.meta.url)), 'plugin'), plugin, { recursive: true, errorOnExist: true, force: false });
  const env = { ...process.env, CLAUDEX_COLLABORATION_WORKER: '1', CLAUDEX_CACHE_PROBE_AUTHORIZED: '1',
    CLAUDEX_CACHE_PROBE_ARM: arm, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128', CLAUDE_CODE_EFFORT_LEVEL: EFFORT };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M', 'DISABLE_PROMPT_CACHING', 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS']) delete env[key];
  let ended = false, wake, child, pending, failure;
  const queue = [], receipts = [], nativeModels = new Set();
  const prompt = { async *[Symbol.asyncIterator]() {
    while (!ended) { if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; }); }
  } };
  const active = query({ prompt, options: { cwd, pathToClaudeCodeExecutable: binary,
    model: MODEL, effort: EFFORT, persistSession: false, settingSources: [], strictMcpConfig: true,
    mcpServers: {}, plugins: [{ type: 'local', path: plugin }], tools: [], permissionMode: 'dontAsk',
    maxTurns: 1, maxBudgetUsd: 0.5, env,
    settings: { remoteControlAtStartup: false, crossSessionInbound: 'refuse', enabledPlugins: {},
      promptCacheTtl: '5m', subagentPromptCacheTtl: '5m' },
    systemPrompt: `You are a bounded cache measurement fixture. Arm ${arm} ${randomUUID()}. Respond only OK. No tools.`,
    stderr: text => { if (/hooks modules are turned off|hooks module.*failed/i.test(text)) failure = new Error('Native Mod unavailable; no rollout override.'); },
    spawnClaudeCodeProcess: options => (child = spawn(options.command, options.args,
      { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] })),
  } });
  const consumer = (async () => {
    try { for await (const e of active) {
      if (e.type === 'assistant' && e.message?.model) nativeModels.add(e.message.model);
      if (e.type !== 'result') continue;
      const receipt = { subtype: e.subtype, isError: e.is_error, turns: e.num_turns,
        usage: e.usage, modelUsage: e.modelUsage, cumulativeEstimatedUsd: e.total_cost_usd,
        replyIsOK: e.result?.trim() === 'OK' };
      receipts.push(receipt); emit({ arm, kind: 'receipt', ...receipt });
      pending?.resolve(receipt); pending = null;
    } } catch (error) { failure = error; pending?.reject(error); }
  })();
  const api = {
    async inspect() { return JSON.parse(await readFile(join(cwd, 'probe.json'), 'utf8')); },
    async send(text) {
      assert(!failure && !pending, 'Native error or overlapping request.');
      let timer;
      const done = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      queue.push({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null,
        message: { role: 'user', content: text } }); wake?.();
      try { return await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request deadline exceeded; no replay.')), 60000); })]); }
      finally { clearTimeout(timer); }
    },
    async close() { ended = true; wake?.(); active.close(); await consumer;
      if (child && child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      report.arms[arm] = { receipts, nativeModels: [...nativeModels], childExited: !child || child.exitCode !== null || child.signalCode !== null };
      try { report.arms[arm].probe = await api.inspect(); } catch { report.arms[arm].probe = null; }
    },
  };
  clients.push(api);
  await active.initializationResult();
  let proof;
  for (let i = 0; i < 30; i++) {
    try { proof = await api.inspect(); if (proof.rows.some(row => row.kind === 'loaded')) break; } catch {}
    if (failure) throw failure;
    await sleep(200);
  }
  assert(proof?.rows.some(row => row.kind === 'loaded'), 'Mod did not load; no model request sent.');
  emit({ arm, kind: 'loaded', proof });
  return api;
}

try {
  const control = await client('control');
  if (!values.run) { report.outcome = 'load-only'; }
  else {
    const warm = await client('warm');
    const seed = 'Synthetic reference for cache measurement:\n' + Array.from({ length: 180 }, (_, i) =>
      `Record ${i}: the stable reference contains amber, cedar, lake, and north; this is inert test data.`).join('\n') + '\nReply only OK.';
    // Sequential requests avoid account bursts. Both prefixes are different from their first system block.
    for (const [name, c] of [['control', control], ['warm', warm]]) {
      const r = await c.send(seed);
      assert(!r.isError && r.replyIsOK, `${name} seed failed; no retry.`);
      const p = await c.inspect();
      const request = p.rows.find(row => row.kind === 'request' && row.main);
      assert(request?.model === MODEL && request.effort === EFFORT, 'Native requested model/effort mismatch.');
      assert(r.usage?.cache_creation_input_tokens > 1024, 'Seed did not establish a measurable cache prefix.');
    }
    const p = await warm.inspect(), initial = p.rows.find(row => row.kind === 'request' && row.main).at;
    const deadline = initial + 360000;
    while (Date.now() < deadline) {
      await sleep(Math.min(15000, deadline - Date.now()));
      const current = await warm.inspect();
      const result = current.rows.find(row => row.kind === 'fork-result');
      emit({ kind: 'waiting', secondsRemaining: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
        fork: result ?? null });
      if (result) assert(result.isAnswered && result.mainUnchanged && result.usage?.cache_read_input_tokens > 1024,
        'Fork failed cache/non-contamination gate; no retry.');
    }
    assert((await warm.inspect()).rows.filter(row => row.kind === 'fork-result').length === 1, 'Expected exactly one timer-driven fork.');
    for (const c of [control, warm]) { const r = await c.send('End the cache measurement. Reply only OK.'); assert(!r.isError && r.replyIsOK); }
    report.outcome = 'measured';
  }
} catch (error) {
  report.outcome = 'blocked-or-failed'; report.error = error.message; process.exitCode = 1;
} finally {
  for (const c of clients) await c.close();
  report.assessment = assessEvidence(report);
  await save(); emit({ kind: 'finished', outcome: report.outcome, error: report.error ?? null, report: join(root, 'report.json') });
}

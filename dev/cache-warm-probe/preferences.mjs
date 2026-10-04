// Manual native persistence acceptance. Local commands only; never a model prompt.
import assert from 'node:assert/strict';
import { mkdir, realpath, readdir, lstat, writeFile } from 'node:fs/promises';
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
import { modSessionObservation } from '../../src/mod-wake-broker.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, claude: { type: 'string' }, run: { type: 'boolean' }, 'warm-command': { type: 'boolean' } } });
assert(values.run && values.root && values.claude, 'Supply --run, a new private --root and native --claude executable.');
assert.equal(process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1', 'Requires the authorized process-only Mod opt-in.');
const root = await realpath(values.root), binary = await realpath(values.claude);
const stat = await lstat(root);
assert(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && (await readdir(root)).length === 0);
assert(relative(fileURLToPath(new URL('../..', import.meta.url)), root).startsWith('../'));
const cwd = join(root, 'project'), config = join(root, 'native-home');
await mkdir(cwd, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
const staged = await stageClaudeMod({ output: join(root, 'stage'), stateRoot: root, nodeBinary: await realpath(process.execPath) });
const hub = await new CollaborationHub({ root: join(root, 'collaboration'), run: async () => { throw new Error('No model workers allowed.'); } }).initialize();
const observedSources = new Map();
const transport = await serveCollaborationSocket({ root: hub.root, dispatch: async envelope => {
  const result = await hub.dispatch(envelope);
  if (envelope.method === 'mod_wake_observe' && result.observed === true && envelope.params.observation.lifecycle === 'loaded')
    observedSources.set(envelope.params.source.sessionId, envelope.params.source);
  return result;
} });
const report = { outcome: 'running', processes: [], commands: 0, modelTurns: 0 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' };
for (const key of ['CLAUDEX_COLLABORATION_WORKER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'FORCE_PROMPT_CACHING_5M', 'ENABLE_PROMPT_CACHING_1H']) delete env[key];

async function session(work) {
  const previousIds = new Set(observedSources.keys());
  const queue = []; let child, pending, wake, ended = false, fault, nativeId;
  const outputs = [], entry = { exited: false, initial: null, final: null };
  report.processes.push(entry);
  const active = query({ prompt: { async *[Symbol.asyncIterator]() {
    while (!ended) { if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; }); }
  } }, options: { cwd, pathToClaudeCodeExecutable: binary, env, settingSources: [],
    plugins: [{ type: 'local', path: staged.plugin }], persistSession: false,
    model: 'claude-sonnet-5-5', effort: 'medium', tools: [], strictMcpConfig: true, mcpServers: {},
    permissionMode: 'dontAsk', maxTurns: 1, maxBudgetUsd: 0.01,
    settings: { enabledPlugins: {}, crossSessionInbound: 'refuse', remoteControlAtStartup: false },
    spawnClaudeCodeProcess: options => (child = spawn(options.command, options.args,
      { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] })),
  } });
  const consume = (async () => {
    try { for await (const e of active) {
      if (e.type === 'system' && e.subtype === 'init') {
        if (nativeId) assert.equal(e.session_id, nativeId, 'Native command session differs from the loaded observer.');
        nativeId = e.session_id;
      }
      if (e.type === 'system' && e.subtype === 'local_command_output') outputs.push(e.content);
      // Native local commands can use a synthetic assistant envelope. That is
      // not model-response evidence; the zero-turn result remains mandatory.
      if (e.type === 'assistant' && e.message?.model === '<synthetic>') {
        for (const block of e.message.content ?? []) if (block.type === 'text') outputs.push(block.text);
        continue;
      }
      if (e.type === 'assistant' || (e.type === 'stream_event' && e.event?.type === 'message_start')) {
        entry.unexpectedResponse = { type: e.type, model: e.message?.model, usage: e.message?.usage, error: e.error };
        throw new Error('Unexpected model activity; no retry.');
      }
      if (e.type !== 'result') continue;
      report.modelTurns += e.num_turns ?? 0;
      assert.equal(e.num_turns, 0, 'Local command unexpectedly invoked a model.');
      const result = e.result;
      pending?.resolve([...outputs.splice(0), result]); pending = null;
    } } catch (error) { fault = error; pending?.reject(error); active.close(); }
  })();
  async function send(command) {
    assert(/^\/claudex(?: warm|:warm) (?:status|off|on (?:ttl=)?(?:1h|5m)|preference (?:session|(?:remember|default) ttl=(?:1h|5m))|confirm warm-[a-zA-Z0-9-]+)$/.test(command));
    assert(!pending && !fault); report.commands++;
    let timer;
    const done = new Promise((resolve, reject) => { pending = { resolve, reject }; });
    queue.push({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'user', content: command } }); wake?.();
    try {
      const values = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native command timed out; no replay.')), 30000); })]);
      for (const value of values) if (typeof value === 'string') {
        if (command.startsWith('/claudex:warm ')) {
          // SDK wraps local output in a native text envelope. Only the command
          // body is presentation; use the legacy diagnostic status for state.
          const text = value.replace(/<[^>]+>/g, '').trim();
          if (text.split('\n').length === 4 && !/"policy"|"sessionId"/.test(text)) return { summary: text };
        }
        const begin = value.indexOf('{'), end = value.lastIndexOf('}');
        if (begin >= 0 && end > begin) { try { return JSON.parse(value.slice(begin, end + 1)); } catch {} }
      }
      throw new Error('Local command returned no structured result.');
    } finally { clearTimeout(timer); }
  }
  try {
    const initialization = await active.initializationResult();
    if (values['warm-command']) {
      assert(initialization.commands.some(command => command.name === 'claudex:warm'), 'Namespaced warm command missing from the native catalogue.');
      entry.namespacedCommandListed = true;
    }
    let ready = false;
    for (let i = 0; i < 50; i++) {
      const source = [...observedSources.values()].find(source => !previousIds.has(source.sessionId) && source.cwd === cwd);
      if (source && modSessionObservation(hub, source)) { nativeId = source.sessionId; ready = true; break; }
      if (fault) throw fault;
      await delay(100);
    }
    assert(ready, 'Native Mod startup was not observed; no command sent.');
    // The loaded observer precedes completion of TTL restoration within startup.
    await delay(300);
    const summarize = status => ({ enabled: status.local.enabled, restore: status.local.ttlRestore.state,
      preference: status.ttlPreference, nativeTtl: status.nativeCache.value });
    entry.initial = summarize(await send('/claudex warm status'));
    await work(send, entry.initial);
    entry.final = summarize(await send('/claudex warm status'));
    assert.equal(entry.final.enabled, false);
    console.log(JSON.stringify({ process: report.processes.length, ...entry }));
  } finally {
    ended = true; wake?.(); active.close(); await consume;
    if (child && child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    entry.exited = !child || child.exitCode !== null || child.signalCode !== null;
  }
}
async function confirm(send, command) {
  const preview = await send(command); assert.equal(preview.state, 'confirmation-required');
  return send(preview.confirm);
}
try {
  if (values['warm-command']) {
    await session(async send => {
      await confirm(send, '/claudex warm preference remember ttl=1h');
      const enabled = await send('/claudex:warm on 5m');
      assert.equal(enabled.summary.split('\n').length, 4);
      const status = await send('/claudex warm status');
      assert.equal(status.local.enabled, true); assert.equal(status.nativeCache.value, '5m');
      assert.equal(status.ttlPreference.ttl, '1h');
      await send('/claudex:warm off');
      assert.equal((await send('/claudex warm status')).nativeCache.value, '5m');
    });
    await session(async (send, initial) => {
      assert.equal(initial.nativeTtl, '1h'); assert.equal(initial.preference.ttl, '1h');
      assert.equal(initial.enabled, false);
      assert.equal((await send('/claudex:warm on ttl=1h')).summary.split('\n').length, 4);
      await send('/claudex:warm off');
    });
  } else {
    await session(async (send, initial) => {
      assert.equal(initial.nativeTtl, '5m');
      await confirm(send, '/claudex warm preference default ttl=1h');
      await confirm(send, '/claudex warm on ttl=5m'); await send('/claudex warm off');
    });
    await session(async (send, initial) => {
      assert.equal(initial.nativeTtl, '1h'); assert.equal(initial.restore, 'applied');
      await confirm(send, '/claudex warm preference remember ttl=5m');
      await confirm(send, '/claudex warm on ttl=1h'); await send('/claudex warm off');
    });
    await session(async (send, initial) => {
      assert.equal(initial.nativeTtl, '1h'); assert.equal(initial.preference.mode, 'remember');
      await confirm(send, '/claudex warm preference session');
    });
    await session(async (_send, initial) => {
      assert.equal(initial.nativeTtl, '5m'); assert.equal(initial.restore, 'session-only');
    });
  }
  assert.equal(report.modelTurns, 0); assert.equal((await hub.cacheWarm.list()).attemptCount, 0);
  report.outcome = values['warm-command'] ? 'native-namespaced-warm-command-verified' : 'native-preference-restarts-verified';
} catch (error) { report.outcome = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  await transport.close(); await hub.close();
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ outcome: report.outcome, error: report.error, report: join(root, 'report.json') }));
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { prepareCodexChatWake, preflightCodexChatWake } from '../src/codex-chat-wake.mjs';
import { discoverCodexChats } from '../src/native-chat-catalog.mjs';
import { createClaudeChatWakeManifest } from '../src/claude-chat-wake-manifest.mjs';
import { createClaudeOwnerWakePublisher } from '../src/claude-owner-wake.mjs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { createNativeCollaborationRunner } from '../src/collaboration-native.mjs';
import { createOriginVerifier } from '../src/collaboration-origin.mjs';
import { callCollaboration, runCollaborationMcp, serveCollaborationSocket } from '../src/collaboration-transport.mjs';
import { privateDirectory, readJSON, withLock, writeJSON } from '../src/storage.mjs';

const cli = fileURLToPath(import.meta.url);
const help = `Claudex collaboration: one work protocol for delegation and ownership handoff

  claudex collaboration install [--allow-write]   Install independent broker and native MCP connections
  claudex collaboration serve [--allow-write]     Run the broker in the foreground
  claudex collaboration mcp --peer codex|claude   Native stdio MCP endpoint
  claudex collaboration status                   Read the work inventory (no inference)
  claudex collaboration models                   Read provider model defaults (no inference)
  claudex collaboration models --codex-model ID --claude-model ID
                                                Save both defaults; empty ID uses native default
  claudex collaboration models --codex-effort LEVEL --claude-effort LEVEL
                                                Save provider efforts; empty uses native default
  claudex collaboration permissions [--default read-only|workspace-write|full-access]
                                                Read or save the default permission for new root work
  claudex collaboration request METHOD --peer codex|claude
                                                Read JSON parameters from stdin
  claudex collaboration native-wake [--route mod|mod-self|renderer]
                                                Inspect or select Claude delivery for new messages
  claudex collaboration cache-warm [status]
                                                Inspect opt-in native cache warming (no inference)
  claudex collaboration cache-warm off --session ID --cwd PATH [--provider claude]
                                                Revoke one exact conversation's warming policy
  claudex collaboration cache-warm on --provider codex --session ID --cwd PATH --accept-best-effort
                                                Preview bounded warming for a loaded Desktop owner
  claudex collaboration cache-warm confirm TOKEN --provider codex --accept-best-effort
                                                Confirm the exact reviewed Codex preview once
Codex optional bounds: --refresh-minutes 25 --max-minutes 60 --max-refreshes 3
  --max-output-tokens 256. Warm reads are unlimited. Status/off accept --provider codex.
No draft inspection, hard no-tools guarantee or configurable native TTL exists for
Codex. Busy, tool activity, budget exhaustion or uncertainty stop future warming.
Claude enables only inside its loaded conversation with /claudex warm on and confirm.
No conversation is enabled by default; status never connects to a native owner.

--root PATH selects the private collaboration root, not the synchronization root.
--default-permission read-only|workspace-write selects the policy for new root tasks.
--codex-binary PATH and --claude-binary PATH select explicit native executables.
Default: ~/.local/share/claudex/collaboration. Requests may start real model work.
Reads, installation and status do not request new model work. Broker startup can
continue previously authorized queued work, never replay an interrupted invocation.
No API keys are copied.
Writes require broker authorization (--allow-write, --allow-full-access, or a saved
controller default) and a task permission of workspace-write or full-access.
full-access runs native tools without a sandbox or prompts and loads user config.
Use a dedicated checkout for writable work; the protocol does not merge changes.
`;

async function controllerToken(root) {
  const path = join(root, 'controller-key');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== 1
    || (info.mode & 0o777) !== 0o600 || info.size !== 65) throw new Error('Unsafe collaboration controller key.');
  const value = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid collaboration controller key.');
  return value;
}

async function reclaimEndpoint(root) {
  const path = join(root, 'rpc.sock');
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const saved = await readJSON(join(root, 'endpoint.json'), null);
  if (!saved || saved.version !== 1 || saved.dev !== info.dev || saved.ino !== info.ino
    || !info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600
    || !Number.isSafeInteger(saved.pid) || saved.pid <= 0) throw new Error('Existing broker endpoint is not an authenticated stale socket; it was preserved.');
  try { process.kill(saved.pid, 0); throw new Error('Prior broker is still alive.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const current = await lstat(path);
  if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('Broker endpoint changed; it was preserved.');
  await unlink(path);
}

async function serve(root, allowWrite, values) {
  process.umask(0o077);
  root = await privateDirectory(root);
  return withLock(join(root, 'broker.lock'), async () => {
    const hub = new CollaborationHub({ root, allowWrite, allowFullAccess: values['allow-full-access'] === true,
      defaultPermission: values['default-permission'] ?? 'read-only',
      chatWake: prepareCodexChatWake,
      chatWakeProbe: preflightCodexChatWake,
      nativeChatDiscovery: params => discoverCodexChats(params, { syncRoot: dirname(root) }),
      claudeWakeManifest: createClaudeChatWakeManifest({ root }),
      claudeOwnerWake: createClaudeOwnerWakePublisher({ root: dirname(root) }),
      originVerifier: createOriginVerifier({ syncRoot: dirname(root) }),
      run: createNativeCollaborationRunner({ commands: { codex: values['codex-binary'] ?? 'codex', claude: values['claude-binary'] ?? 'claude' } }),
      mcp: ({ provider, token }) => ({ command: process.execPath,
        args: [cli, 'mcp', '--root', root, '--peer', provider], env: { CLAUDEX_WORK_TOKEN: token } }) });
    // Install handlers before initialization can schedule any saved, never-dispatched work.
    let finish;
    const ending = new Promise(resolve => { finish = resolve; });
    const stop = () => finish();
    let fatal;
    hub.on('fatal', error => { fatal = error; finish(); });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    let transport;
    try {
      await hub.initialize();
      await reclaimEndpoint(root);
      transport = await serveCollaborationSocket({ root, dispatch: envelope => hub.dispatch(envelope) });
      const info = await lstat(join(root, 'rpc.sock'));
      await writeJSON(join(root, 'endpoint.json'), { version: 1, pid: process.pid, dev: info.dev, ino: info.ino, startedAt: Date.now() });
      hub.schedule();
      await ending;
    } finally {
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
      await hub.close();
      await transport?.close();
    }
    if (fatal) throw fatal;
  }, { recoverDead: true });
}

export async function collaborationMain(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    root: { type: 'string' }, peer: { type: 'string' }, 'allow-write': { type: 'boolean' }, 'allow-full-access': { type: 'boolean' },
    help: { type: 'boolean' }, default: { type: 'string' }, route: { type: 'string' },
    'default-permission': { type: 'string' }, 'codex-binary': { type: 'string' }, 'claude-binary': { type: 'string' },
    'codex-model': { type: 'string' }, 'claude-model': { type: 'string' },
    'codex-effort': { type: 'string' }, 'claude-effort': { type: 'string' },
    session: { type: 'string' }, cwd: { type: 'string' }, provider: { type: 'string' },
    'accept-best-effort': { type: 'boolean' }, 'refresh-minutes': { type: 'string' },
    'max-minutes': { type: 'string' }, 'max-refreshes': { type: 'string' },
    'max-read-tokens': { type: 'string' }, 'max-output-tokens': { type: 'string' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { console.log(help); return; }
  const root = resolve(values.root ?? join(process.env.CLAUDEX_HOME ?? join(homedir(), '.local', 'share', 'claudex'), 'collaboration'));
  if (command === 'serve') return serve(root, values['allow-write'] === true, values);
  if (command === 'install') {
    const { installCollaboration } = await import('../src/collaboration-install.mjs');
    console.log(JSON.stringify(await installCollaboration({ root, cli, allowWrite: values['allow-write'] === true,
      defaultPermission: values['default-permission'] ?? 'read-only', codexBinary: values['codex-binary'], claudeBinary: values['claude-binary'] }), null, 2));
    return;
  }
  const token = process.env.CLAUDEX_WORK_TOKEN ?? await controllerToken(root);
  const peer = values.peer ?? 'codex';
  if (command === 'cache-warm') {
    if (values['max-read-tokens'] !== undefined) throw new Error('Read-token limits have been removed; omit --max-read-tokens.');
    const action = positionals[1] ?? 'status';
    if (values.provider === 'codex') {
      if (!['status', 'list', 'on', 'confirm', 'off'].includes(action)) throw new Error('Use Codex cache-warm status|on|confirm TOKEN|off.');
      if (action !== 'on' && ['refresh-minutes', 'max-minutes', 'max-refreshes', 'max-output-tokens'].some(flag => values[flag] !== undefined))
        throw new Error('Set bounds on cache-warm on, then review the new preview; confirmation cannot override its bounds.');
      const params = {};
      if (['on', 'off'].includes(action) || values.session || values.cwd) {
        if (!values.session || !values.cwd) throw new Error('Both --session and --cwd are required.');
        Object.assign(params, { sessionId: values.session, cwd: values.cwd });
      }
      if (['on', 'confirm'].includes(action)) {
        if (values['accept-best-effort'] !== true) throw new Error('Read the Codex limitations and explicitly pass --accept-best-effort.');
        params.bestEffort = true;
      }
      if (action === 'on') for (const [flag, key] of Object.entries({ 'refresh-minutes': 'refreshMinutes',
        'max-minutes': 'maxMinutes', 'max-refreshes': 'maxRefreshes', 'max-output-tokens': 'maxOutputTokens' })) {
        if (values[flag] !== undefined) {
          if (!/^[1-9][0-9]*$/.test(values[flag]) || !Number.isSafeInteger(Number(values[flag]))) throw new Error(`Invalid --${flag}.`);
          params[key] = Number(values[flag]);
        }
      }
      if (action === 'confirm') {
        if (!positionals[2] || positionals.length !== 3) throw new Error('Supply the exact confirmation token.');
        params.confirmationId = positionals[2];
      } else if (positionals.length > 2) throw new Error('Unexpected cache-warm arguments.');
      const method = `codex_cache_warm_${action === 'on' ? 'prepare' : ['status', 'list'].includes(action) ? 'list' : action}`;
      const result = await callCollaboration({ root, peer, token, method, params });
      if (action === 'on') {
        const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
        result.confirm = `claudex collaboration cache-warm confirm ${result.confirmationId} --provider codex --accept-best-effort --root ${quote(root)} --peer ${quote(peer)}`;
      }
      console.log(JSON.stringify(result, null, 2)); return;
    }
    if (values.provider !== undefined && values.provider !== 'claude') throw new Error('Unknown cache-warm provider.');
    if (!['status', 'list', 'off'].includes(action)) throw new Error('Use cache-warm status or off. Enable from the intended native conversation.');
    const params = action === 'off' ? { provider: values.provider ?? 'claude', sessionId: values.session,
      cwd: values.cwd, enabled: false, requestId: `cli-cache-warm:${randomUUID()}` } : {};
    if (action === 'off' && (!values.session || !values.cwd)) throw new Error('Both --session and --cwd are required; titles are not dispatch identities.');
    console.log(JSON.stringify(await callCollaboration({ root, peer, token,
      method: action === 'off' ? 'cache_warm_configure' : 'cache_warm_list', params }), null, 2));
    return;
  }
  if (command === 'mcp') return runCollaborationMcp({ root, peer, token,
    workerMode: Boolean(process.env.CLAUDEX_WORK_TOKEN) });
  if (command === 'desktop-wake-mcp') {
    if (peer !== 'claude' || process.env.CLAUDEX_WORK_TOKEN) throw new Error('Desktop wake requires the native Claude controller endpoint.');
    return runCollaborationMcp({ root, peer, token, desktopWakeOnly: true });
  }
  if (command === 'status') { console.log(JSON.stringify(await callCollaboration({ root, peer, token, method: 'list' }), null, 2)); return; }
  if (command === 'native-wake') {
    const params = values.route === undefined ? {} : { route: values.route };
    console.log(JSON.stringify(await callCollaboration({ root, peer, token, method: 'native_wake', params }), null, 2));
    return;
  }
  if (command === 'models') {
    const updating = values['codex-model'] !== undefined || values['claude-model'] !== undefined;
    if (updating && (values['codex-model'] === undefined || values['claude-model'] === undefined))
      throw new Error('Both provider model settings are required.');
    const params = updating ? { defaultModels: {
      codex: values['codex-model'].trim() || null,
      claude: values['claude-model'].trim() || null,
    } } : {};
    const updatingEffort = values['codex-effort'] !== undefined || values['claude-effort'] !== undefined;
    if (updatingEffort && (values['codex-effort'] === undefined || values['claude-effort'] === undefined))
      throw new Error('Both provider effort settings are required.');
    if (updatingEffort) params.defaultEfforts = {
      codex: values['codex-effort'].trim() || null,
      claude: values['claude-effort'].trim() || null,
    };
    console.log(JSON.stringify(await callCollaboration({ root, peer, token, method: 'models', params }), null, 2));
    return;
  }
  if (command === 'permissions') {
    // A saved default is the controller's explicit authorization for that level.
    const params = values.default === undefined ? {} : { defaultPermission: values.default };
    const result = await callCollaboration({ root, peer, token, method: 'models', params });
    console.log(JSON.stringify({ defaultPermission: result.defaultPermission }, null, 2));
    return;
  }
  if (command === 'request') {
    let buffer = '';
    for await (const chunk of process.stdin) {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 256 * 1024) throw new Error('Request exceeds 256 KiB.');
    }
    const params = JSON.parse(buffer || '{}');
    console.log(JSON.stringify(await callCollaboration({ root, peer, token, method: positionals[1], params }), null, 2));
    return;
  }
  throw new Error('Unknown collaboration command. Use collaboration help.');
}

if (process.argv[1] && await realpath(process.argv[1]) === cli) collaborationMain().catch(error => {
  console.error(`Claudex collaboration: ${error.message}`); process.exitCode = 1;
});

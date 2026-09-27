#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { runCollaborationNative } from '../src/collaboration-native.mjs';
import { callCollaboration, runCollaborationMcp, serveCollaborationSocket } from '../src/collaboration-transport.mjs';
import { privateDirectory, readJSON, withLock, writeJSON } from '../src/storage.mjs';

const cli = fileURLToPath(import.meta.url);
const help = `Claudex collaboration: one work protocol for delegation and ownership handoff

  claudex collaboration install [--allow-write]   Install independent broker and native MCP connections
  claudex collaboration serve [--allow-write]     Run the broker in the foreground
  claudex collaboration mcp --peer codex|claude   Native stdio MCP endpoint
  claudex collaboration status                   Read the work inventory (no inference)
  claudex collaboration request METHOD --peer codex|claude
                                                Read JSON parameters from stdin

--root PATH selects the private collaboration root, not the synchronization root.
Default: ~/.local/share/claudex/collaboration. Requests may start real model work.
Reads, startup, installation and status never request inference. No API keys are copied.
Writes require both broker --allow-write and per-task permission: workspace-write.
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

async function serve(root, allowWrite) {
  process.umask(0o077);
  root = await privateDirectory(root);
  return withLock(join(root, 'broker.lock'), async () => {
    const hub = new CollaborationHub({ root, allowWrite, run: runCollaborationNative,
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
    root: { type: 'string' }, peer: { type: 'string' }, 'allow-write': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { console.log(help); return; }
  const root = resolve(values.root ?? join(process.env.CLAUDEX_HOME ?? join(homedir(), '.local', 'share', 'claudex'), 'collaboration'));
  if (command === 'serve') return serve(root, values['allow-write'] === true);
  if (command === 'install') {
    const { installCollaboration } = await import('../src/collaboration-install.mjs');
    console.log(JSON.stringify(await installCollaboration({ root, cli, allowWrite: values['allow-write'] === true }), null, 2));
    return;
  }
  const token = process.env.CLAUDEX_WORK_TOKEN ?? await controllerToken(root);
  const peer = values.peer ?? 'codex';
  if (command === 'mcp') return runCollaborationMcp({ root, peer, token });
  if (command === 'status') { console.log(JSON.stringify(await callCollaboration({ root, peer, token, method: 'list' }), null, 2)); return; }
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

if (process.argv[1] && resolve(process.argv[1]) === cli) collaborationMain().catch(error => {
  console.error(`Claudex collaboration: ${error.message}`); process.exitCode = 1;
});

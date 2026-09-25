#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/bridge.mjs';
import { nativeDrivers } from '../src/native-drivers.mjs';
import { readJSON, writeJSON, privateDirectory, withLock } from '../src/storage.mjs';
import { discoverSources } from '../src/discovery.mjs';
import { CodexClient } from '../src/codex.mjs';
import { installService, controlService } from '../src/service.mjs';
import { fileURLToPath } from 'node:url';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { runDesktopWatch } from '../src/desktop-watch.mjs';
import { installDesktopLauncher, applyDesktopEnvironment, uninstallDesktopLauncher } from '../src/desktop-install.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, from: { type: 'string' }, source: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' },
  'codex-home': { type: 'string' }, 'claude-home': { type: 'string' }, 'codex-binary': { type: 'string' },
  project: { type: 'string', multiple: true }, help: { type: 'boolean' }, watch: { type: 'boolean' },
  'all-projects': { type: 'boolean' },
  'claude-binary': { type: 'string' },
} });
const command = positionals[0] || 'help';
let root = resolve(values.root || process.env.CLAUDEX_HOME || join(homedir(), '.local', 'share', 'claudex'));
const output = value => console.log(JSON.stringify(value, null, 2));
const help = `Claudex: bounded local conversation handoffs (no model calls)

  claudex init [--all-projects | --project /absolute/project] [--codex-home PATH] [--claude-home PATH]
  claudex track --from codex|claude --source PATH [--title TITLE]
  claudex track --from codex --id THREAD_ID
  claudex sync CONVERSATION_ID --from codex|claude
  claudex watch                    Watch tracked conversations and opted-in projects
  claudex status                  Show current native IDs without transcript content
  claudex gc                      Apply owned-backup retention
  claudex recover                 Resume one interrupted transaction
  claudex abort                   Remove one unpublished owned projection
  claudex recover-lock            Clear a dead bridge process lock (never a live one)
  claudex service install|start|stop|status|uninstall    macOS background operation
  claudex doctor                  Check native versions
  claudex desktop install         Enable all-project Desktop mode at the next normal app start
  claudex desktop uninstall       Remove the owned next-start override; preserve conversations

Global: --root PATH (default ~/.local/share/claudex). Service installation is opt-in.
Only generated copies are retired. Original imported sessions are never deleted.
Close the destination session before switching; active writers block handoff.
`;

async function main() {
  if (command === 'help' || values.help) { console.log(help); return; }
  root = await privateDirectory(root);
  const configPath = join(root, 'config.json');
  if (command === 'init') {
    if (values['all-projects'] && values.project?.length) throw new Error('Choose --all-projects or --project, not both.');
    if (await readJSON(configPath, null)) throw new Error('Already initialized; existing configuration was not changed.');
    const config = {
      version: 1, codexHome: await realpath(resolve(values['codex-home'] || join(homedir(), '.codex'))),
      claudeHome: await realpath(resolve(values['claude-home'] || join(homedir(), '.claude'))),
      binary: values['codex-binary'] || 'codex',
      projects: await Promise.all((values.project || []).map(path => realpath(resolve(path)))),
      allProjects: values['all-projects'] === true,
      since: Date.now(),
    };
    await writeJSON(configPath, config);
    output({ initialized: root, projects: config.projects, allProjects: config.allProjects, watching: false });
    return;
  }
  const config = await readJSON(configPath, null);
  if (!config) throw new Error('Run claudex init first.');
  if (config.version !== 1) throw new Error('Unsupported configuration version.');
  if (command === 'doctor') {
    const codex = execFileSync(config.binary, ['--version'], { encoding: 'utf8' }).trim();
    const claude = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
    output({ codex, claude, verifiedCodex: codex === 'codex-cli 0.155.0-alpha.16.3', verifiedClaude: ['2.1.210', '2.1.281'].some(version => claude.startsWith(`${version} `)), note: 'Other native versions require compatibility validation.' });
    return;
  }
  if (command === 'recover-lock') {
    const path = join(root, values.watch ? 'watch.lock' : config.mode === 'desktop' ? 'desktop-operation.lock' : 'operation.lock');
    const lock = await readJSON(path, null);
    if (!lock) { output({ cleared: false }); return; }
    if (!Number.isInteger(lock.pid)) throw new Error('Malformed lock; manual inspection required.');
    try { process.kill(lock.pid, 0); throw new Error('Lock owner is still alive; it was not removed.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    const current = await readJSON(path);
    if (JSON.stringify(current) !== JSON.stringify(lock)) throw new Error('Lock changed; it was not removed.');
    await unlink(path);
    output({ cleared: true, pendingTransactionPreserved: true });
    return;
  }
  if (command === 'service') {
    const options = { root, cli: fileURLToPath(import.meta.url) };
    if (positionals[1] === 'install') {
      const state = await new Bridge({ root, drivers: {} }).status();
      if (!config.allProjects && !config.projects.length && !state.records.length) throw new Error('Select all projects, specific projects, or track a conversation before installing the service.');
      output(await installService(options));
    } else output(await controlService(positionals[1], options));
    return;
  }
  if (command === 'desktop') {
    if (await readJSON(join(root, 'watch.lock'), null) && !(positionals[1] === 'install' && config.mode === 'desktop')) {
      throw new Error('Stop the bridge watcher safely before changing Desktop installation.');
    }
    if (positionals[1] === 'install') {
      const legacy = await new Bridge({ root, drivers: {} }).status();
      if (legacy.pending || legacy.records.length) throw new Error('Legacy conversations require an explicit migration; originals and mappings were preserved.');
      const result = await installDesktopLauncher({ root,
        launcher: fileURLToPath(new URL('./claudex-codex.mjs', import.meta.url)),
        binary: values['codex-binary'] || '/Applications/ChatGPT.app/Contents/Resources/codex' });
      await writeJSON(configPath, { ...config, mode: 'desktop', allProjects: true, projects: [], contextMode: config.contextMode ?? 'archive',
        claudeBinary: values['claude-binary'] || config.claudeBinary || 'claude' });
      output(result);
    } else if (positionals[1] === 'uninstall') {
      output(await uninstallDesktopLauncher({ root }));
      await writeJSON(configPath, { ...config, mode: 'legacy' });
    } else throw new Error('Use desktop install or desktop uninstall.');
    return;
  }
  async function usingBridge(fn) {
    const native = await nativeDrivers({ ...config, root });
    try { return await fn(new Bridge({ root, drivers: native.drivers, policy: config.policy }), native.drivers); }
    finally { await native.close(); }
  }
  if (command === 'status') {
    const state = config.mode === 'desktop'
      ? await new DesktopBridge({ root, adapters: {} }).status()
      : await new Bridge({ root, drivers: {} }).status();
    output({ mode: config.mode || 'legacy', contextMode: config.mode === 'desktop' ? config.contextMode ?? 'inline' : null,
      allProjects: config.allProjects === true, conversations: Object.values(state.conversations), records: state.records,
      pending: state.pending ? { phase: state.pending.phase, nativeId: state.pending.record.nativeId, side: state.pending.record.side } : null,
      audit: state.audit, watcher: await readJSON(join(root, 'watcher-status.json'), null) });
    return;
  }
  if (config.mode === 'desktop') {
    if (!['watch', 'track', 'sync', 'gc', 'recover'].includes(command)) throw new Error('Desktop mode supports watch, track, sync, gc, and recover; owner appends cannot be aborted as disposable files.');
    const runtime = await new DesktopRuntime({ ...config, root }).initialize();
    const bridge = new DesktopBridge({ root, adapters: runtime.adapters, policy: config.policy });
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (command === 'watch') { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
    try {
      if (command === 'watch') {
        await applyDesktopEnvironment({ root });
        await runDesktopWatch({ root, bridge, runtime, config, signal: controller.signal });
      } else await withLock(join(root, 'watch.lock'), async () => {
        if (command === 'track') {
          if (!['codex', 'claude'].includes(values.from)) throw new Error('--from must be codex or claude.');
          if (!values.source && !(values.from === 'codex' && values.id)) throw new Error('A source path or Codex --id is required.');
          output(await bridge.track({ side: values.from, path: values.source && await realpath(resolve(values.source)), nativeId: values.id, title: values.title }));
        } else if (command === 'sync') {
          if (!positionals[1]) throw new Error('Supply a conversation ID.');
          output(await bridge.sync(positionals[1]));
        } else output(await bridge[command === 'gc' ? 'collect' : 'recover']());
      });
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      // close() explicitly refuses to interrupt a real user's active Claude turn.
      // Keep its live handles if shutdown is unsafe; never process.exit().
      try { await runtime.close(); }
      catch (error) { console.error(`Claudex preserved a live native owner: ${error.message}`); }
    }
    return;
  }
  if (command === 'track') {
    if (!['codex', 'claude'].includes(values.from)) throw new Error('--from must be codex or claude.');
    let path = values.source ? await realpath(resolve(values.source)) : null;
    if (!path && values.from === 'codex' && values.id) {
      const client = new CodexClient({ binary: config.binary, codexHome: config.codexHome });
      try { await client.initialize(); path = (await client.readThread(values.id)).thread.path; }
      finally { await client.close(); }
    }
    if (!path) throw new Error('A source transcript path or Codex --id is required.');
    output(await usingBridge(bridge => bridge.track({ side: values.from, path, title: values.title })));
    return;
  }
  if (command === 'sync') {
    if (!positionals[1] || !['codex', 'claude'].includes(values.from)) throw new Error('Supply a conversation ID and --from codex|claude.');
    output(await usingBridge(bridge => bridge.sync(positionals[1], values.from)));
    return;
  }
  if (['gc', 'recover', 'abort'].includes(command)) {
    output(await usingBridge(bridge => bridge[command === 'gc' ? 'collect' : command]()));
    return;
  }
  if (command !== 'watch') throw new Error(`Unknown command: ${command}`);
  let stopped = false;
  let lastNotice = '';
  let lastCollection = 0;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log(`Watching ${config.allProjects ? 'all projects' : 'opted-in projects'} and tracked conversations. Press Ctrl+C to stop.`);
  await withLock(join(root, 'watch.lock'), async () => {
  await writeJSON(join(root, 'watcher-status.json'), { running: true, pid: process.pid, startedAt: Date.now(), error: null });
  while (!stopped) {
    const blockedSources = [];
    let blockedSourceCount = 0;
    try {
      await usingBridge(async (bridge, drivers) => {
        let state = await bridge.status();
        if (state.pending) throw new Error('A pending transaction requires claudex recover or abort; watcher stopped.');
        const known = new Set(state.records.map(record => `${record.side}:${record.nativeId}`));
        for (const source of await discoverSources(config, known)) {
          try { output(await bridge.track(source)); }
          catch (error) {
            if (/still running|complete assistant|Unfinished|incomplete final/i.test(error.message)) continue;
            // Unsupported, not-yet-enrolled histories must not stop unrelated projects.
            // Transaction, storage, version, and ownership failures still stop the watcher.
            if (!/Codex compaction|Compacted Codex history|Referenced Codex history|Claude compaction|Dependent Claude history|Nonlinear Claude history|Missing or dependent Codex history|working directory changed|turn was interrupted|Unsupported message role|Duplicate open tool call|Unpaired tool result|External image references|Artifact handoffs/.test(error.message)) throw error;
            blockedSourceCount++;
            if (blockedSources.length < 20) blockedSources.push({ ...source, reason: error.message });
          }
        }
        state = await bridge.status();
        for (const conversation of Object.values(state.conversations)) {
          const current = state.records.filter(record => record.conversationId === conversation.id && record.status === 'current');
          const changed = [];
          let incomplete = false;
          for (const record of current) {
            try {
              const source = await drivers[record.side].inspect(record);
              if (source.digest !== record.checkpoint || current.length === 1) changed.push(record.side);
            } catch (error) {
              if (!/still running|complete assistant|Unfinished|incomplete final/i.test(error.message)) throw error;
              incomplete = true;
            }
          }
          if (incomplete) continue;
          if (changed.length > 1) throw new Error('Both sides changed; watcher stopped without choosing a branch.');
          if (changed.length === 1) output(await bridge.sync(conversation.id, changed[0]));
        }
        if (Date.now() - lastCollection > 60000) { await bridge.collect(); lastCollection = Date.now(); }
      });
      await writeJSON(join(root, 'watcher-status.json'), { running: true, pid: process.pid, updatedAt: Date.now(), waiting: null, blockedSourceCount, blockedSources });
      lastNotice = '';
    } catch (error) {
      if (/active writer|destination is active|Claude Code is open|still running|Another bridge operation/i.test(error.message)) {
        if (lastNotice !== error.message) console.error(`Waiting: ${error.message}`);
        lastNotice = error.message;
        await writeJSON(join(root, 'watcher-status.json'), { running: true, pid: process.pid, updatedAt: Date.now(), waiting: error.message });
      } else throw error;
    }
    if (!stopped) await delay(2000);
  }
  await writeJSON(join(root, 'watcher-status.json'), { running: false, pid: process.pid, stoppedAt: Date.now(), error: null });
  });
}

main().catch(async error => {
  console.error(`Claudex: ${error.message}`);
  if (command === 'watch' && !/Another bridge operation/.test(error.message)) {
    try { await writeJSON(join(root, 'watcher-status.json'), { running: false, pid: process.pid, stoppedAt: Date.now(), error: error.message }); } catch {}
  }
  process.exitCode = 1;
});

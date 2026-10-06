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
import { SyncEventInbox } from '../src/sync-events.mjs';
import { createSyncEventSource } from '../src/sync-event-source.mjs';
import { installSyncHooks, inspectSyncHooks } from '../src/sync-hook-install.mjs';
import { installDesktopLauncher, applyDesktopEnvironment, uninstallDesktopLauncher } from '../src/desktop-install.mjs';
import { createDesktopRelaunch } from '../src/codex-desktop-relaunch.mjs';
import { isAllowedCodexVersion, isSupportedCodexVersion } from '../src/codex-versions.mjs';
import { normalizeVersionPolicy, runtimeVersionPermitted } from '../src/runtime-version-policy.mjs';
import { closeDesktopSafely } from '../src/desktop-shutdown.mjs';

const collaborationRequested = process.argv[2] === 'collaboration';
const { values, positionals } = parseArgs({ args: collaborationRequested ? ['collaboration'] : process.argv.slice(2), allowPositionals: true, options: {
  root: { type: 'string' }, from: { type: 'string' }, source: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' },
  'codex-home': { type: 'string' }, 'claude-home': { type: 'string' }, 'codex-binary': { type: 'string' },
  project: { type: 'string', multiple: true }, help: { type: 'boolean' }, watch: { type: 'boolean' },
  'all-projects': { type: 'boolean' },
  'claude-binary': { type: 'string' },
  'record-id': { type: 'string' }, 'expected-count': { type: 'string' }, 'expected-digest': { type: 'string' },
} });
const command = positionals[0] || 'help';
let root = resolve(values.root || process.env.CLAUDEX_HOME || join(homedir(), '.local', 'share', 'claudex'));
const output = value => console.log(JSON.stringify(value, null, 2));
const help = `Claudex: bounded conversation synchronization and opt-in model collaboration

  claudex init [--all-projects | --project /absolute/project] [--codex-home PATH] [--claude-home PATH]
  claudex track --from codex|claude --source PATH [--title TITLE]
  claudex track --from codex --id THREAD_ID
  claudex sync CONVERSATION_ID --from codex|claude
  claudex watch                    Watch tracked conversations and opted-in projects
  claudex hooks install|status     Configure or inspect completion hooks (no inference)
  claudex status                  Show current native IDs without transcript content
  claudex gc                      Apply owned-backup retention
  claudex recover                 Resume one interrupted transaction
  claudex archive-original CONVERSATION_ID --id NATIVE_ID    Reconcile one preserved Codex original
  claudex untrack CONVERSATION_ID  Stop Desktop synchronization; preserve all history
  claudex resume-tracking CONVERSATION_ID    Verify and restore the saved Desktop enrollment
  claudex split-original CONVERSATION_ID --id NATIVE_ID --record-id RECORD_ID --expected-count N --expected-digest SHA256
  claudex abort                   Remove one unpublished owned projection
  claudex recover-lock            Clear a dead bridge process lock (never a live one)
  claudex service install|start|stop|status|uninstall    macOS background operation
  claudex status-app install|status    macOS menu bar status and notifications
  claudex doctor                  Check native versions
  claudex version-policy [strict|warn]    Show or change version-only enforcement
  claudex desktop install         Enable all-project Desktop mode at the next normal app start
  claudex desktop uninstall       Remove the owned next-start override; preserve conversations
  claudex desktop folders enable|disable|status    Structurally verified Claude folder presentation
  claudex desktop handoffs enable|disable|status   Archive verified Local predecessors using native Claude
  claudex collaboration help       Cross-model work protocol (explicit model execution)

Global: --root PATH (default ~/.local/share/claudex). Service installation is opt-in.
Only generated copies are retired. Original imported sessions are never deleted.
CLI-only sync: close the destination session before switching; active writers block handoff.
Desktop sync: use the current same-title continuation after verified delivery.
`;

async function main() {
  if (command === 'collaboration') {
    const { collaborationMain } = await import('./claudex-collaboration.mjs');
    return collaborationMain(process.argv.slice(3));
  }
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
  if (command === 'hooks') {
    if (!['install', 'status'].includes(positionals[1])) throw new Error('Use hooks install or hooks status.');
    const settings = { root, codexHome: config.codexHome, claudeHome: config.claudeHome,
      nodePath: process.execPath, hookPath: fileURLToPath(new URL('./claudex-sync-hook.mjs', import.meta.url)) };
    output(await (positionals[1] === 'install' ? installSyncHooks(settings) : inspectSyncHooks(settings)));
    return;
  }
  const versionPolicy = normalizeVersionPolicy(config.versionPolicy);
  if (command === 'version-policy') {
    if (positionals.length > 2) throw new Error('Use version-policy strict or version-policy warn.');
    const selected = normalizeVersionPolicy(positionals[1] ?? versionPolicy);
    if (positionals[1]) await writeJSON(configPath, { ...config, versionPolicy: selected });
    output({ versionPolicy: selected, versionGuardEnabled: selected === 'strict',
      note: 'Applies when the watcher/native owner next starts. A running native-only Desktop requires a normal restart to enable shared transport. Runtime data and safety checks are unchanged.' });
    return;
  }
  if (command === 'doctor') {
    const codex = execFileSync(config.binary, ['--version'], { encoding: 'utf8' }).trim();
    const claude = execFileSync(config.claudeBinary || 'claude', ['--version'], { encoding: 'utf8' }).trim();
    const claudeVersion = claude.split(/\s+/)[0];
    const verifiedClaude = (config.mode === 'desktop' ? ['2.1.281'] : ['2.1.210', '2.1.281']).includes(claudeVersion);
    output({ codex, claude, verifiedCodex: isSupportedCodexVersion(codex), verifiedClaude, versionPolicy,
      synchronizationAllowedByVersionPolicy: isAllowedCodexVersion(codex, versionPolicy)
        && runtimeVersionPermitted(claudeVersion, verifiedClaude ? claudeVersion : null, versionPolicy),
      note: versionPolicy === 'warn' ? 'Version changes alone do not produce warnings. Protocol, ownership and history failures remain explicit.' : 'Other native versions require compatibility validation.' });
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
  if (command === 'status-app') {
    const { installStatusApp, statusStatusApp } = await import('../src/status-app-install.mjs');
    if (positionals[1] === 'status') output(await statusStatusApp({ root }));
    else if (positionals[1] === 'install') output(await installStatusApp({ root, identity: process.env.CLAUDEX_SIGNING_IDENTITY }));
    else throw new Error('Use status-app install or status.');
    return;
  }
  if (command === 'desktop') {
    if (positionals[1] === 'handoffs' && positionals[2] === 'status') {
      output({ enabled: config.desktopLocalHandoff?.enabled === true,
        watcher: (await readJSON(join(root, 'watcher-status.json'), null))?.localHandoff ?? null });
      return;
    }
    if (positionals[1] === 'folders' && positionals[2] === 'status') {
      const { claudeFolderPresentationManifestPath } = await import('../src/claude-folder-presentation-cache.mjs');
      output({ enabled: config.folderProjection?.enabled === true,
        installation: config.folderProjection?.cachePath
          ? await readJSON(claudeFolderPresentationManifestPath(root, config.folderProjection.cachePath), null) : null,
        maintenance: await readJSON(join(root, 'renderer-adapters-status.json'), null),
        watcher: (await readJSON(join(root, 'watcher-status.json'), null))?.folderProjection ?? null });
      return;
    }
    if (await readJSON(join(root, 'watch.lock'), null) && !(positionals[1] === 'install' && config.mode === 'desktop')) {
      throw new Error('Stop the bridge watcher safely before changing Desktop installation.');
    }
    if (positionals[1] === 'handoffs') {
      if (config.mode !== 'desktop' || process.platform !== 'darwin' || !config.folderProjection?.enabled)
        throw new Error('Native Local handoffs require the verified macOS Claude folder adapter.');
      if (!['enable', 'disable'].includes(positionals[2])) throw new Error('Use desktop handoffs enable, disable, or status.');
      const enabled = positionals[2] === 'enable';
      const previous = await readJSON(join(root, 'desktop-handoff.json'), null);
      await writeJSON(join(root, 'desktop-handoff.json'), { version: 1, kind: 'claude-local-archive',
        generatedAt: null, expiresAt: null, anchorsUpdatedAt: Date.now(), actions: [], anchors: previous?.anchors ?? [] });
      await writeJSON(configPath, { ...config, desktopLocalHandoff: { enabled } });
      output({ enabled, note: 'The next watcher verifies complete replacements before publishing expiring native archive intents. Original transcripts and worktrees are retained.' });
    } else if (positionals[1] === 'folders') {
      if (config.mode !== 'desktop' || process.platform !== 'darwin') throw new Error('Claude folder presentation requires macOS Desktop mode.');
      const { claudeFolderPresentationCachePath, ensureClaudeFolderPresentationCache, restoreClaudeFolderPresentationCache } = await import('../src/claude-folder-presentation-cache.mjs');
      const { publishClaudeFolderMap } = await import('../src/claude-folder-map.mjs');
      const cachePath = positionals[2] === 'disable' && config.folderProjection?.cachePath
        ? config.folderProjection.cachePath : claudeFolderPresentationCachePath(homedir(), config.folderProjection?.cachePath);
      if (positionals[2] === 'enable') {
        const state = await new DesktopBridge({ root, adapters: {} }).status();
        const map = await publishClaudeFolderMap({ root, state });
        if (map.deferred) throw new Error('Complete the pending native operation before enabling folder presentation.');
        const resource = await ensureClaudeFolderPresentationCache({ root, cachePath });
        if (resource.status === 'skipped') throw new Error(resource.reason);
        await writeJSON(configPath, { ...config, rendererAdapters: { enabled: true }, folderProjection: { enabled: true, cachePath: resource.cachePath } });
        output({ enabled: true, map, resource, note: 'The watcher follows cached frontend deployments automatically. Restart Claude only when idle to load each newly installed frontend graph; map changes need no reload.' });
      } else if (positionals[2] === 'disable') {
        const previous = await readJSON(join(root, 'desktop-handoff.json'), null);
        await writeJSON(join(root, 'desktop-handoff.json'), { version: 1, kind: 'claude-local-archive', generatedAt: null,
          expiresAt: null, anchorsUpdatedAt: Date.now(), actions: [], anchors: previous?.anchors ?? [] });
        await publishClaudeFolderMap({ root, state: { version: 2, conversations: {}, records: [], pending: null } });
        await writeJSON(configPath, { ...config, folderProjection: { enabled: false, cachePath }, desktopLocalHandoff: { enabled: false } });
        const resource = await restoreClaudeFolderPresentationCache({ root, cachePath });
        output({ enabled: false, resource, note: 'Map cleared and original cache resource restored; restart Claude only when idle to fully unload the presentation adapter.' });
      } else throw new Error('Use desktop folders enable, disable, or status.');
    } else if (positionals[1] === 'install') {
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
    } else throw new Error('Use desktop install, uninstall, or folders.');
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
    output({ mode: config.mode || 'legacy', versionPolicy, contextMode: config.mode === 'desktop' ? config.contextMode ?? 'inline' : null,
      allProjects: config.allProjects === true, conversations: Object.values(state.conversations), records: state.records,
      pending: state.pending ? { phase: state.pending.phase, nativeId: state.pending.record.nativeId, side: state.pending.record.side } : null,
      audit: state.audit, watcher: await readJSON(join(root, 'watcher-status.json'), null),
      service: await readJSON(join(root, 'service-status.json'), null) });
    return;
  }
  if (config.mode === 'desktop') {
    if (!['watch', 'track', 'sync', 'gc', 'recover', 'abort', 'archive-original', 'untrack', 'resume-tracking', 'split-original'].includes(command)) throw new Error('Desktop mode supports watch, track, sync, gc, recover, abort, archive-original, untrack, resume-tracking, and split-original.');
    if (command === 'untrack') {
      if (!positionals[1]) throw new Error('Supply the logical conversation ID.');
      // Stopping enrollment is metadata-only, including when its saved cwd is
      // absent. Refuse a running watcher before acquiring the coordinator lock.
      return withLock(join(root, 'watch.lock'), async () => {
        output(await new DesktopBridge({ root, adapters: {}, policy: config.policy }).untrack(positionals[1]));
      }, { recoverDead: true });
    }
    const runtime = await new DesktopRuntime({ ...config, root }).initialize();
    const bridge = new DesktopBridge({ root, adapters: runtime.adapters, policy: config.policy });
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (command === 'watch') { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
    let events;
    try {
      if (command === 'watch') {
        await applyDesktopEnvironment({ root });
        const inbox = await new SyncEventInbox({ root }).initialize();
        events = await createSyncEventSource({ root, runtime, config, inbox });
        const relaunch = createDesktopRelaunch({ root, codexHome: runtime.codexHome }).run(controller.signal);
        try { await runDesktopWatch({ root, bridge, runtime, config, events, signal: controller.signal }); }
        finally { controller.abort(); await relaunch; }
      } else await withLock(join(root, 'watch.lock'), async () => {
        if (command === 'track') {
          if (!['codex', 'claude'].includes(values.from)) throw new Error('--from must be codex or claude.');
          if (!values.source && !(values.from === 'codex' && values.id)) throw new Error('A source path or Codex --id is required.');
          output(await bridge.track({ side: values.from, path: values.source && await realpath(resolve(values.source)), nativeId: values.id, title: values.title }));
        } else if (command === 'sync') {
          if (!positionals[1]) throw new Error('Supply a conversation ID.');
          output(await bridge.sync(positionals[1]));
        } else if (command === 'archive-original') {
          if (!positionals[1] || !values.id) throw new Error('Supply the logical conversation ID and exact original native ID.');
          output(await bridge.reconcileOriginalArchive(positionals[1], values.id));
        } else if (command === 'resume-tracking') {
          if (!positionals[1]) throw new Error('Supply the logical conversation ID.');
          output(await bridge.resumeTracking(positionals[1]));
        } else if (command === 'split-original') {
          const count = Number(values['expected-count']), digest = values['expected-digest'];
          if (!positionals[1] || !values.id || !values['record-id'] || !values['expected-count']
            || !Number.isSafeInteger(count) || count < 1 || !/^[a-f0-9]{64}$/.test(digest ?? ''))
            throw new Error('Supply the logical conversation ID, exact --id and --record-id, and inspected --expected-count / --expected-digest checkpoint.');
          const { splitDesktopOriginal } = await import('../src/desktop-original-split.mjs');
          output(await splitDesktopOriginal({ bridge, conversationId: positionals[1], originalNativeId: values.id,
            originalRecordId: values['record-id'], expectedCheckpoint: { count, digest } }));
        } else if (command === 'abort') {
          // Only a prepared delivery that wrote nothing natively can be dropped.
          output(await bridge.abandonUnapplied());
        } else output(await bridge[command === 'gc' ? 'collect' : 'recover']());
      });
    } finally {
      // Keep signal handlers until every owner can exit safely. A second stop
      // signal must not become the default immediate termination of user work.
      try { await events?.close(); await closeDesktopSafely(runtime, { onWaiting: async error => {
        const path = join(root, 'watcher-status.json');
        const status = await readJSON(path, null);
        if (status?.pid === process.pid) await writeJSON(path, { ...status, running: false, updatedAt: Date.now(),
          shutdown: { state: 'waiting', reason: error.message } });
      } }); }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
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
  }, { recoverDead: true });
}

main().catch(async error => {
  console.error(`Claudex: ${error.message}`);
  if (command === 'watch' && !/Another bridge operation/.test(error.message)) {
    try { await writeJSON(join(root, 'watcher-status.json'), { running: false, pid: process.pid, stoppedAt: Date.now(), error: error.message }); } catch {}
  }
  process.exitCode = 1;
});

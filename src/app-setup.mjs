import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open } from 'node:fs/promises';
import { homedir, userInfo, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { privateDirectory, withLock, writeJSON } from './storage.mjs';
import { discoverProviders, ensureProviders } from './app-providers.mjs';
import { AppSignatureCache } from './app-signature-cache.mjs';
import { installCollaboration, controlCollaboration } from './collaboration-install.mjs';
import { installClaudeDesktopWake } from './claude-desktop-wake-install.mjs';
import { ensureClaudeChatWakeCache } from './claude-chat-wake-cache.mjs';
import { ensureClaudeOwnerWakeCache } from './claude-owner-wake-cache.mjs';
import { readAppStopState } from './app-stop-state.mjs';
import { callCollaboration } from './collaboration-transport.mjs';
import { installDesktopLauncher } from './desktop-install.mjs';
import { installService, controlService } from './service.mjs';
import { inspectServiceStart } from './service-supervisor.mjs';
import { claudeFolderPresentationCachePath, ensureClaudeFolderPresentationCache } from './claude-folder-presentation-cache.mjs';
import { isAllowedCodexVersion } from './codex-versions.mjs';
import { normalizeVersionPolicy } from './runtime-version-policy.mjs';
import { installAppLogin } from './app-login.mjs';
import { installSyncHooks } from './sync-hook-install.mjs';
import { inspectAppMod, ensureAppMod, defaultNativeModRun } from './app-mod.mjs';
import { findAppModRuntime, ensureAppModRuntime } from './app-mod-runtime.mjs';

const execute = promisify(execFile);
const defaults = Object.freeze({ allProjects: true, allowWrite: true, defaultPermission: 'workspace-write' });
const component = (id, label, state, detail, action) => ({ id, label, state, detail, ...(action ? { action } : {}) });
const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; }
};

/** Bounded, no-follow inspection. Never print native account or transcript data. */
export async function appPrivateJSON(path, maxBytes = 1024 * 1024) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > maxBytes)
      throw new Error('Setup state is not a bounded private file.');
    const data = await handle.readFile('utf8'), after = await handle.stat(), named = await lstat(path);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => stat[key] !== after[key])
      || after.dev !== named.dev || after.ino !== named.ino) throw new Error('Setup state changed during inspection.');
    return JSON.parse(data);
  } finally { await handle.close(); }
}

function safeFailure(error) {
  // execFile errors may contain native diagnostics, account names or auth URLs.
  if (error?.cmd || error?.stdout !== undefined || error?.stderr !== undefined)
    return 'The native operation did not complete. Existing settings and histories were preserved.';
  return String(error?.message ?? 'Setup could not be verified.').split('\n')[0].slice(0, 400);
}

export class AppSetup {
  constructor({ root = join(homedir(), '.local', 'share', 'claudex'), home = homedir(),
    engineRoot = fileURLToPath(new URL('..', import.meta.url)), runtimeDirectory,
    run = execute, platform = process.platform, discover = discoverProviders, ensure = ensureProviders,
    collaborationInstall = installCollaboration, collaborationControl = controlCollaboration, desktopInstall = installDesktopLauncher,
    serviceInstall = installService, serviceStatus = controlService, ownership = inspectServiceStart,
    foldersInstall = ensureClaudeFolderPresentationCache, collaborationCall = callCollaboration, desktopWakeInstall = installClaudeDesktopWake,
    desktopWakeCacheInstall = ensureClaudeChatWakeCache, desktopOwnerWakeCacheInstall = ensureClaudeOwnerWakeCache,
    interfaceInstall = installAppLogin, syncHooksInstall = installSyncHooks,
    modInspect = inspectAppMod, modEnsure = ensureAppMod, modFindRuntime = findAppModRuntime,
    modEnsureRuntime = ensureAppModRuntime, modRun = defaultNativeModRun, appPath, readOnly = false } = {}) {
    if (![root, home, engineRoot].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('Setup paths must be absolute.');
    Object.assign(this, { root: resolve(root), home, engineRoot: resolve(engineRoot), runtimeDirectory: runtimeDirectory ?? resolve(engineRoot, '..', 'runtime'),
      run, platform, discover, ensure, collaborationInstall, collaborationControl, desktopInstall, serviceInstall, serviceStatus, ownership, foldersInstall, collaborationCall, desktopWakeInstall, desktopWakeCacheInstall, desktopOwnerWakeCacheInstall,
      interfaceInstall, syncHooksInstall, modInspect, modEnsure, modFindRuntime, modEnsureRuntime, modRun,
      appPath: appPath ?? resolve(engineRoot, '../../..'), readOnly });
    this.cli = join(this.engineRoot, 'bin', 'claudex.mjs');
    this.collaborationCli = join(this.engineRoot, 'bin', 'claudex-collaboration.mjs');
    this.node = join(this.runtimeDirectory, 'bin', 'node');
  }

  nativeRun = (command, args, options = {}) => {
    const username = userInfo().username;
    const env = { HOME: this.home, USER: username, LOGNAME: username, TMPDIR: tmpdir(), LANG: process.env.LANG ?? 'en_US.UTF-8',
      PATH: [join(this.runtimeDirectory, 'bin'), join(this.home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':') };
    for (const name of ['TMPDIR', 'npm_config_cache', 'npm_config_registry', 'npm_config_userconfig', 'npm_config_globalconfig'])
      if (options.env?.[name]) env[name] = options.env[name];
    return this.run(command, args, { timeout: 30000, maxBuffer: 1024 * 1024, ...options, env });
  };

  requireWritable() {
    if (this.readOnly) throw new Error('Read-only application inspection cannot change setup, accounts or services.');
  }

  async runtimeReady() {
    try { await access(this.node, constants.X_OK); await access(join(this.runtimeDirectory, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')); return true; }
    catch { return false; }
  }

  // Only report inspection may reuse a recent unchanged deep signature verification;
  // setup and sign-in always verify again. Read-only inspection never records one.
  async providers(install = false, { reuseSignatures = false } = {}) {
    if (install) this.requireWritable();
    const signatures = new AppSignatureCache({ root: this.root, reuse: reuseSignatures, persist: !this.readOnly });
    return (install ? this.ensure : this.discover)({ root: this.root, home: this.home, runtime: this.runtimeDirectory,
      env: { ...process.env, PATH: `${join(this.home, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }, run: this.nativeRun, signatures });
  }

  async auth(provider, binary) {
    if (!binary) return { ready: false, missing: true };
    try {
      const result = await this.nativeRun(binary, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']);
      if (provider === 'codex') return { ready: /Logged in using ChatGPT/i.test(`${result.stdout}\n${result.stderr}`) };
      const state = JSON.parse(result.stdout);
      return { ready: state.loggedIn === true && state.authMethod === 'claude.ai' && state.apiProvider === 'firstParty' };
    } catch (error) {
      if (provider === 'codex' && /not logged in/i.test(`${error.stdout}\n${error.stderr}`)) return { ready: false };
      if (provider === 'claude') {
        try { if (JSON.parse(error.stdout).loggedIn === false) return { ready: false }; } catch { /* Not an authenticated native status response. */ }
      }
      return { ready: false, failed: true };
    }
  }

  async collaborationRequest(method, params = {}) {
    const reads = ['list', 'models', 'mod_wake_status', 'cache_warm_settings', 'cache_warm_list', 'codex_cache_warm_list'];
    if (this.readOnly && (!reads.includes(method) || method === 'cache_warm_settings' && params.defaultLimit !== undefined
      || method === 'models' && (params.defaultModels !== undefined || params.defaultEfforts !== undefined || params.defaultPermission !== undefined)))
      this.requireWritable();
    const root = join(this.root, 'collaboration');
    try {
      const file = await open(join(root, 'controller-key'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let token;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size !== 65)
          throw new Error('Invalid collaboration controller key.');
        token = (await file.readFile('utf8')).trim();
      } finally { await file.close(); }
      return await this.collaborationCall({ root, peer: 'codex', token, method, params, timeoutMs: 3000 });
    } catch (error) {
      if (method === 'list' && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) return null;
      throw error;
    }
  }

  async collaborationStatus() {
    return this.collaborationRequest('list');
  }

  async modActivationStatus() {
    try { return await this.collaborationRequest('mod_wake_status'); }
    catch { return null; } // Missing/older/offline brokers are unobserved, never ready.
  }

  async inspectMod(providers, { install = false, receiver, enable = false } = {}) {
    if (install) this.requireWritable();
    if (receiver !== undefined && !['enabled', 'disabled'].includes(receiver)) throw new Error('Invalid Mod receiver choice.');
    if (!providers?.claude?.app || !await this.runtimeReady())
      return { runtime: { state: 'missing' }, installation: { state: 'missing', reason: 'prerequisites' } };
    const options = { root: this.root, home: this.home, runtime: this.runtimeDirectory,
      claudeBinary: providers.claude.binary, run: this.modRun };
    const runtime = await (install ? this.modEnsureRuntime : this.modFindRuntime)(options);
    if (runtime.state !== 'ready') return { runtime, installation: { state: runtime.state, reason: 'manager-unavailable' } };
    const installation = await (install ? this.modEnsure : this.modInspect)({ root: this.root, home: this.home,
      engineRoot: this.engineRoot, node: this.node, claudeBinary: runtime.binary, run: this.modRun,
      readOnly: this.readOnly, ...(install ? { receiver, enable } : {}) });
    return { runtime, installation };
  }

  /** Explicit App action; startup also maintains only this owned plugin, not
   * native user work or unrelated plugins. Inspection remains mutation-free. */
  async modSetup({ receiver, enable = false } = {}) {
    this.requireWritable();
    if (this.platform !== 'darwin') throw new Error('The Claudex app requires macOS.');
    this.root = await privateDirectory(this.root);
    return withLock(join(this.root, 'app-setup.lock'), async () => {
      const providers = await this.providers(false);
      const mod = await this.inspectMod(providers, { install: true, receiver, enable });
      const report = await this.inspect({ providers, mod });
      await writeJSON(join(this.root, 'app-setup-status.json'), { ...report, updatedAt: Date.now() });
      return report;
    }, { recoverDead: true });
  }

  async models(defaultModels, defaultEfforts, defaultPermission) {
    if (defaultModels !== undefined || defaultEfforts !== undefined || defaultPermission !== undefined) this.requireWritable();
    return this.collaborationRequest('models', {
      ...(defaultModels === undefined ? {} : { defaultModels }),
      ...(defaultEfforts === undefined ? {} : { defaultEfforts }),
      ...(defaultPermission === undefined ? {} : { defaultPermission }),
    });
  }

  /** The limit a warming on command uses when it is given none, shared by
   * Claude and Codex. Saving it changes no enrollment and starts no model work.
   * The enrolled counts are a best-effort summary of the two status lists. */
  async warmSettings(defaultLimit) {
    if (defaultLimit !== undefined) this.requireWritable();
    const settings = await this.collaborationRequest('cache_warm_settings', defaultLimit === undefined ? {} : { defaultLimit });
    const enrolled = async method => {
      try { return (await this.collaborationRequest(method)).policies.filter(policy => policy.enabled === true).length; }
      catch { return null; }
    };
    return { ...settings, active: { claude: await enrolled('cache_warm_list'), codex: await enrolled('codex_cache_warm_list') } };
  }

  /** The user's confirmation in the app is the operator attestation for work the
   * broker could not prove stopped. Live processes still refuse; nothing reruns. */
  async resolveUncertain() {
    this.requireWritable();
    const broker = await this.collaborationRequest('list');
    const attestation = 'The user confirmed in the Claudex app that no worker from this task is still running.';
    let resolved = 0;
    const failed = [];
    for (const summary of broker?.uncertainTasks ?? []) {
      try {
        const task = await this.collaborationRequest('status', { taskId: summary.id });
        if (task.status !== 'uncertain') continue;
        const execution = task.active ?? task.lastExecution;
        await this.collaborationRequest('resolve', { taskId: task.id, revision: task.revision, outcome: 'failed',
          requestId: `app-resolve-${task.id}-${task.revision}`, reason: 'Closed from the Claudex app after an unknown native outcome. Nothing was rerun.',
          ...(task.permission === 'read-only' ? {} : { workspaceReconciled: true,
            reconciliationNotes: `${attestation} Any file changes it made were kept for review.` }),
          ...(execution?.processInventoryError ? { processInventoryReconciled: true, processInventoryNotes: attestation } : {}) });
        resolved++;
      } catch (error) { failed.push({ taskId: summary.id, error: safeFailure(error) }); }
    }
    return { resolved, failed };
  }

  async inspect({ providers, notes = {}, mod } = {}) {
    const rows = [component('projects', 'Project access', 'ready', 'All projects are available by default. Agents work only on the task you assign; macOS permissions still apply.')];
    if (notes.lifecycle) rows.push(component('lifecycle', 'Claudex application', 'blocked', notes.lifecycle, 'diagnostics'));
    let interfaceError = notes.interface;
    if (!interfaceError) {
      try { interfaceError = (await appPrivateJSON(join(this.root, 'app-interface-status.json')))?.error; }
      catch (error) { interfaceError = safeFailure(error); }
    }
    if (interfaceError) rows.push(component('interface', 'Claudex application', 'blocked', interfaceError, 'retry'));
    const runtimeReady = await this.runtimeReady();
    rows.push(component('runtime', 'Bundled runtime', runtimeReady ? 'ready' : 'missing',
      runtimeReady ? 'Node.js and the setup engine are included in this app.' : 'Use the complete Claudex app bundle; no separate Node.js installation is required.', 'retry'));
    let found = providers;
    if (!found) {
      try { found = await this.providers(false, { reuseSignatures: true }); }
      catch (error) { rows.push(component('providers', 'Native applications', 'blocked', safeFailure(error), 'retry')); }
    }
    // Both native account checks are independent read-only CLI calls; auth() never rejects.
    const auths = Object.fromEntries(await Promise.all(['codex', 'claude']
      .map(async name => [name, await this.auth(name, found?.[name]?.binary)])));
    for (const name of ['codex', 'claude']) {
      const item = found?.[name];
      rows.push(component(`${name}-cli`, name === 'codex' ? 'Codex' : 'Claude Code', item?.binary ? 'ready' : 'missing',
        item?.binary ? `Available: ${item.version ?? 'native CLI'}` : item?.issue ?? 'The official tool will be installed during setup.', 'retry'));
      const auth = auths[name];
      rows.push(component(`${name}-login`, name === 'codex' ? 'ChatGPT sign-in' : 'Claude sign-in', auth.ready ? 'ready' : auth.missing ? 'missing' : auth.failed ? 'blocked' : 'login-required',
        auth.ready ? 'Native account sign-in is available. Credentials are not copied.'
          : auth.missing ? 'Install the native tool before signing in.' : auth.failed ? 'Native account status could not be verified. Use the official sign-in flow.' : 'Sign in through the official provider in your browser.', `login-${name}`));
      rows.push(component(`${name}-desktop`, name === 'codex' ? 'Codex Desktop integration' : 'Claude Desktop integration',
        item?.app ? 'ready' : item?.appIssue ? 'blocked' : 'missing',
        item?.app ? item.appSignature === 'local' ? 'The installed app is a locally re-signed build of the official app.'
          : 'The installed app has the expected vendor signature.' : item?.appIssue
          ?? 'Claudex expects this desktop app to be installed already. It will not download or replace it.', item?.appIssue ? 'retry' : `open-${name}`));
    }
    let modSettings, modInfo;
    try {
      mod ??= await this.inspectMod(found);
      const item = mod.installation, runtime = mod.runtime;
      const inline = item.modSettings?.inline;
      if (typeof inline?.nativeWake === 'boolean' && typeof inline.selfWake === 'boolean')
        modSettings = { nativeWake: inline.nativeWake, selfWake: inline.selfWake };
      const messages = {
        ready: item.reason === 'newer-installed-preserved'
          ? 'A newer Claude Mod is installed. It was preserved instead of being downgraded.'
          : 'The bundled Claude Mod is installed, enabled and verified.',
        missing: 'The Claude Mod and its management runtime will be installed automatically.',
        'update-available': 'A bundled Claude Mod update is available and will be installed automatically.',
        disabled: 'Claude Mod is disabled. Your preference was preserved.',
        blocked: runtime.state !== 'ready' ? 'The Claude Mod manager could not be verified. Existing tools and settings were preserved.'
          : 'Claude Mod installation needs attention. Use Install or update Claude Mod to retry; existing data is preserved.',
      };
      rows.push(component('claude-mod', 'Claude Mod', item.state === 'ready' ? 'ready' : item.state === 'disabled' ? 'waiting'
        : item.state === 'missing' || item.state === 'update-available' ? 'missing' : 'blocked',
      messages[item.state] ?? messages.blocked, item.state === 'disabled' ? 'mod-enable' : 'mod-setup'));
      modInfo = { bundledVersion: item.bundledVersion ?? null, installedVersion: item.installedVersion ?? null,
        managerVersion: runtime.version ?? null, loadedVersion: null, reason: String(item.reason ?? '').slice(0, 128), route: null };
      if (item.state === 'ready') {
        const observation = await this.modActivationStatus();
        const current = observation?.diagnosticOnly === true && observation.provenance === 'mod-self-reported' && !observation.brokerStopping
          && Array.isArray(observation.versions)
          ? observation.versions.find(v => v.version === item.installedVersion && v.build === 'observer-v1' && v.observers > 0) : null;
        const matchingCount = !current || !modSettings ? 0 : modSettings.nativeWake
          ? modSettings.selfWake ? current.bothEnabledCount : current.nativeWakeCount - current.bothEnabledCount
          : modSettings.selfWake ? current.selfWakeCount - current.bothEnabledCount
            : current.observers - current.nativeWakeCount - current.selfWakeCount + current.bothEnabledCount;
        const matches = Number.isSafeInteger(matchingCount) && matchingCount > 0;
        if (matches) modInfo.loadedVersion = current.version;
        if (['mod-self', 'mod', 'renderer'].includes(observation?.route)) modInfo.route = observation.route;
        rows.push(component('claude-mod-activation', 'Claude Mod activation', matches ? 'ready' : 'waiting',
          matches ? 'The current Mod version is observed in a native Claude session. This is not proof of message delivery.'
            : !observation ? 'The broker is unavailable, so native Mod activation cannot be observed yet.'
              : current ? 'Claude Mod receiver settings changed. Open a new Claude Code session to apply them; existing sessions are preserved.'
                : 'Open a new Claude Code session and run /claudex to load the installed Mod. Existing sessions are not restarted.',
          matches ? undefined : 'open-claude'));
      }
    } catch {
      rows.push(component('claude-mod', 'Claude Mod', 'blocked',
        'Claude Mod installation needs attention. Use Install or update Claude Mod to retry; existing data is preserved.', 'mod-setup'));
    }
    try {
      const broker = await this.collaborationStatus();
      const writable = ['workspace-write', 'full-access'].includes(broker?.limits?.defaultPermission);
      rows.push(component('collaboration', 'Cross-model collaboration', !broker ? 'missing' : broker.blockedByUncertainWork ? 'blocked'
        : broker.limits?.allowWrite && writable ? 'ready' : 'waiting',
      !broker ? 'The background broker and MCP connections will be configured automatically.' : broker.blockedByUncertainWork
        ? 'Some collaboration tasks could not be confirmed stopped. Only related work waits; other work continues. Close them after checking that no agent from them is still running.'
        : broker.limits?.defaultPermission === 'full-access' ? 'Sub-agents run with full access: no sandbox or permission prompts. All projects are available.'
          : writable ? 'All projects are available for task-scoped file editing and handoff.' : 'An existing broker retains its previous read-only policy. It must be upgraded when safely stopped.',
      broker?.blockedByUncertainWork ? 'resolve-uncertain' : 'retry'));
    } catch (error) { rows.push(component('collaboration', 'Cross-model collaboration', 'blocked', safeFailure(error), 'retry')); }
    try {
      const config = await appPrivateJSON(join(this.root, 'config.json'));
      const watcher = await appPrivateJSON(join(this.root, 'watcher-status.json'));
      const live = watcher && processAlive(watcher.pid) && watcher.running === true && Number.isFinite(watcher.updatedAt)
        && watcher.updatedAt <= Date.now() + 5000 && Date.now() - watcher.updatedAt < 90000;
      const policy = normalizeVersionPolicy(config?.versionPolicy ?? 'warn');
      const compatible = found?.codex?.version && isAllowedCodexVersion(found.codex.version, policy);
      const claudeCompatible = policy === 'warn' || found?.claude?.version?.split(/\s+/)[0] === '2.1.281';
      const configured = config?.mode === 'desktop' && config?.allProjects === true;
      const held = live && (watcher.synchronization === 'blocked' || watcher.synchronization === 'degraded'
        || watcher.blocked || watcher.blockedConversationCount || watcher.blockedSourceCount);
      const initialCheck = watcher && Object.hasOwn(watcher, 'checkingConversationCount')
        ? watcher.initialSweepCompletedAt : watcher?.foregroundCompletedAt;
      const synchronized = live && Number.isFinite(initialCheck) && watcher.synchronization === 'ready'
        && !watcher.waiting && !watcher.blocked && !watcher.blockedConversationCount && !watcher.blockedSourceCount;
      rows.push(component('synchronization', 'Conversation synchronization', !config ? 'missing' : !compatible || !claudeCompatible ? 'blocked'
        : held ? 'blocked' : !configured || !synchronized ? 'waiting' : 'ready', !config ? 'All-project synchronization will be configured automatically.'
        : !compatible || !claudeCompatible ? 'This native runtime is outside the synchronization policy. Collaboration can still be set up independently.'
          : held ? (watcher.blocked?.reason === 'Owned projection has dependent threads.'
            ? 'Synchronization is paused: an older snapshot has dependent threads. The pending transaction and all histories are preserved; no input is resent.'
            : watcher.blocked?.reason ?? watcher.blockedConversations?.[0]?.reason ?? watcher.blockedSources?.[0]?.reason
              ?? 'The running watcher has paused synchronization for history or ownership checks. Existing work is preserved; no input is resent.')
          : !configured ? 'Existing synchronization settings are preserved until a safe configuration change is possible.'
            : synchronized ? 'The watcher reports ready and is running for all projects.'
              : live && watcher.waiting ? watcher.waiting : 'Waiting for a current ready watcher and shared Desktop backend. Do not restart active native work.', held ? 'diagnostics' : 'retry'));
      const rendererHeld = live && watcher?.rendererAdapters?.state === 'held';
      const rendererChecking = live && ['checking', 'held'].includes(watcher?.rendererAdapters?.state);
      rows.push(component('folders', 'Native project folders', watcher?.folderProjection?.state === 'error' ? 'blocked'
        : rendererChecking ? 'waiting' : config?.folderProjection?.enabled && live && watcher.folderProjection?.state === 'ready' ? 'ready' : 'waiting',
        watcher?.folderProjection?.state === 'error' ? watcher.folderProjection.error ?? 'The current frontend resource could not be verified. No replacement resource was assumed.'
          : rendererHeld ? 'Desktop integration is waiting for Claudex to resume and finish checking. No action is required.'
          : rendererChecking ? 'The frontend cache changed during inspection. Claudex is checking it again; no action is required.'
          : config?.folderProjection?.enabled ? 'The folder adapter is configured. Running-watcher verification and a normal idle Claude restart may still be required.'
          : 'Folder integration requires a supported frontend resource and an idle synchronization setup.', watcher?.folderProjection?.state === 'error' || rendererChecking ? 'diagnostics' : 'retry'));
      rows.push(component('handoffs', 'Native predecessor archival', watcher?.localHandoff?.state === 'error' ? 'blocked'
        : config?.desktopLocalHandoff?.enabled && live && watcher.localHandoff?.state === 'ready' ? 'ready' : 'waiting',
        watcher?.localHandoff?.state === 'error' ? watcher.localHandoff.error ?? 'The native handoff coordinator reports an unresolved guard. Original histories are preserved.'
          : config?.desktopLocalHandoff?.enabled ? 'Native handoffs are configured; each archival still requires verified history and native lifecycle checks.'
          : 'Native handoff integration is waiting for verified folder setup. Original conversations remain preserved.', watcher?.localHandoff?.state === 'error' ? 'diagnostics' : 'retry'));
    } catch (error) { rows.push(component('synchronization', 'Conversation synchronization', 'blocked', safeFailure(error), 'retry')); }
    for (const row of rows) if (notes[row.id]) { row.state = 'blocked'; row.detail = notes[row.id]; row.action = 'retry'; }
    const phase = rows.every(row => row.state === 'ready') ? 'ready' : rows.some(row => row.state === 'blocked') ? 'blocked'
      : rows.some(row => ['missing', 'login-required'].includes(row.state)) ? 'needs-action' : 'waiting';
    return { version: 1, phase, allProjects: true, allowWrite: true, components: rows, modSettings, modInfo,
      message: phase === 'ready' ? 'Claudex is configured for all projects.'
        : phase === 'waiting' ? 'No setup changes are required. Claudex will continue automatically.'
          : 'Independent features stay available while the remaining requirements are resolved.' };
  }

  async setup() {
    this.requireWritable();
    if (this.platform !== 'darwin') throw new Error('The Claudex app requires macOS.');
    this.root = await privateDirectory(this.root);
    const directory = await lstat(this.root);
    if (directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700) throw new Error('Application state directory must be owner-private.');
    return withLock(join(this.root, 'app-setup.lock'), async () => {
      const notes = {};
      try { await this.prepareInterface(); }
      catch (error) { notes.interface = safeFailure(error); }
      if (!await this.runtimeReady()) return this.inspect({ notes });
      let providers;
      try { providers = await this.providers(true); }
      catch (error) { return this.inspect({ notes: { ...notes, providers: safeFailure(error) } }); }
      const mod = await this.inspectMod(providers, { install: true });
      if (!providers.codex?.app || !providers.claude?.app) return this.inspect({ providers, notes, mod });
      const authenticated = Object.fromEntries(await Promise.all(['codex', 'claude'].map(async name => [name, await this.auth(name, providers[name]?.binary)])));
      const mappedRun = (command, args, options) => this.nativeRun(command === 'codex' ? providers.codex.binary : command === 'claude' ? providers.claude.binary : command, args, options);
      if (authenticated.codex.ready && authenticated.claude.ready) {
        try {
          await this.collaborationInstall({ root: join(this.root, 'collaboration'), cli: this.collaborationCli,
            node: this.node, home: this.home, allowWrite: true, defaultPermission: defaults.defaultPermission,
            codexBinary: providers.codex.binary, claudeBinary: providers.claude.binary,
            environmentPath: `${join(this.runtimeDirectory, 'bin')}:${join(this.home, '.local', 'bin')}:/usr/bin:/bin` }, { run: mappedRun });
          await this.desktopWakeInstall({ root: join(this.root, 'collaboration'),
            configPath: join(this.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
            command: this.node,
            args: [this.collaborationCli, 'desktop-wake-mcp', '--root', join(this.root, 'collaboration'), '--peer', 'claude'] });
          const rendererConfig = await appPrivateJSON(join(this.root, 'config.json'));
          const chatCache = await this.desktopWakeCacheInstall({ root: this.root, home: this.home,
            folders: rendererConfig?.folderProjection?.enabled !== false });
          const ownerCache = await this.desktopOwnerWakeCacheInstall({ root: this.root, home: this.home });
          if (chatCache?.status === 'skipped' || ownerCache?.status === 'skipped')
            notes.collaboration = chatCache?.reason ?? ownerCache?.reason;
        } catch (error) { notes.collaboration = safeFailure(error); }
      }
      // Native writer ownership gates only synchronization configuration, not independent collaboration.
      if (providers.codex.app && providers.claude.app && authenticated.codex.ready && authenticated.claude.ready) {
        try { await this.configureSynchronization(providers); }
        catch (error) { notes.synchronization = safeFailure(error); }
      }
      const report = await this.inspect({ providers, notes, mod });
      await writeJSON(join(this.root, 'app-setup-status.json'), { ...report, updatedAt: Date.now() });
      return report;
    }, { recoverDead: true });
  }

  async prepareInterface() {
    this.requireWritable();
    try {
      const result = await this.interfaceInstall({ root: this.root, home: this.home, appPath: this.appPath,
        run: this.nativeRun, platform: this.platform });
      await writeJSON(join(this.root, 'app-interface-status.json'), { version: 1, updatedAt: Date.now(), error: null });
      return result;
    } catch (error) {
      await writeJSON(join(this.root, 'app-interface-status.json'), { version: 1, updatedAt: Date.now(), error: safeFailure(error) });
      throw error;
    }
  }

  async startup() {
    this.requireWritable();
    if (this.platform !== 'darwin') throw new Error('The Claudex app requires macOS.');
    this.root = await privateDirectory(this.root);
    const notes = {};
    try { await this.resumeStoppedServices(); }
    catch (error) { notes.lifecycle = safeFailure(error); }
    try { await this.prepareInterface(); }
    catch (error) { notes.interface = safeFailure(error); }
    let providers, mod;
    try {
      providers = await this.providers(false);
      // App upgrades maintain the separately journaled Mod once at startup;
      // status timers never call this mutation path or run model work.
      mod = await withLock(join(this.root, 'app-setup.lock'), () => this.inspectMod(providers, { install: true }), { recoverDead: true });
    } catch { mod = { runtime: { state: 'blocked' }, installation: { state: 'blocked', reason: 'startup-mod-maintenance' } }; }
    return this.inspect({ providers, notes, mod });
  }

  serviceOptions() {
    return { root: this.root, cli: this.cli, node: this.node, home: this.home };
  }

  collaborationOptions() {
    return { root: join(this.root, 'collaboration'), cli: this.collaborationCli, node: this.node, home: this.home };
  }

  async stopStatus() {
    if (this.platform !== 'darwin') throw new Error('Application shutdown requires macOS.');
    const native = { run: this.nativeRun, platform: this.platform };
    const sync = await this.serviceStatus('status', this.serviceOptions(), native);
    const collaboration = await this.collaborationControl('status', this.collaborationOptions(), native);
    const owners = await this.ownership(this.root, { includeSupervisor: true });
    const unverified = (owners.blockers ?? []).filter(blocker => !['live-owner', 'live-native-child'].includes(blocker.code));
    if (unverified.length) throw new Error(`Cannot verify synchronization shutdown: ${unverified.map(item => item.code).join(', ')}. Existing ownership evidence was preserved.`);
    const stopped = !sync.loaded && collaboration.stopped && owners.allowed;
    return { stopped, detail: stopped ? 'All Claudex services have stopped.'
      : 'Waiting for Claudex services and their native work to exit safely.',
      synchronization: { loaded: sync.loaded, ownerBlockerCount: owners.blockerCount ?? (owners.blockers ?? []).length },
      collaboration: { loaded: collaboration.loaded, stopped: collaboration.stopped } };
  }

  async stop() {
    this.requireWritable();
    if (this.platform !== 'darwin') throw new Error('Application shutdown requires macOS.');
    this.root = await privateDirectory(this.root);
    // Serialize against setup and startup; status inspection remains read-only.
    return withLock(join(this.root, 'app-setup.lock'), async () => {
      const previous = await readAppStopState(this.root);
      await writeJSON(join(this.root, 'app-stop.json'), { version: 1, stopped: true,
        requestedAt: previous?.stopped ? previous.requestedAt : Date.now() });
      const native = { run: this.nativeRun, platform: this.platform };
      const failures = [];
      // Attempt both stops even if one fails. Never erase ownership evidence.
      try {
        const sync = await this.serviceStatus('status', this.serviceOptions(), native);
        if (sync.loaded) await this.serviceStatus('stop', this.serviceOptions(), native);
      } catch (error) { failures.push(safeFailure(error)); }
      try { await this.collaborationControl('stop', this.collaborationOptions(), native); }
      catch (error) { failures.push(safeFailure(error)); }
      if (failures.length) throw new Error(failures.join(' '));
      return this.stopStatus();
    }, { recoverDead: true });
  }

  async resumeStoppedServices() {
    this.requireWritable();
    if (!(await readAppStopState(this.root))?.stopped) return;
    return withLock(join(this.root, 'app-setup.lock'), async () => {
      const state = await readAppStopState(this.root);
      if (!state?.stopped) return;
      if (!state.resuming) {
        const status = await this.stopStatus();
        // Login may already have loaded the verified jobs. Reuse them, but do not
        // bootstrap over detached work from an unloaded, still-draining service.
        if ((!status.synchronization.loaded && status.synchronization.ownerBlockerCount > 0)
          || (!status.collaboration.loaded && !status.collaboration.stopped))
          throw new Error('Previous shutdown is still draining native work. Wait before reopening Claudex.');
        await writeJSON(join(this.root, 'app-stop.json'), { ...state, resuming: true });
      }
      const native = { run: this.nativeRun, platform: this.platform };
      // Only restart already-installed, verified services; no setup or model work.
      if (await appPrivateJSON(join(this.root, 'service-install.json')))
        await this.serviceStatus('start', this.serviceOptions(), native);
      const collaboration = await this.collaborationControl('status', this.collaborationOptions(), native);
      if (collaboration.installed) await this.collaborationControl('start', this.collaborationOptions(), native);
      await writeJSON(join(this.root, 'app-stop.json'), { version: 1, stopped: false, resumedAt: Date.now() });
    }, { recoverDead: true });
  }

  async configureSynchronization(providers) {
    this.requireWritable();
    const path = join(this.root, 'config.json');
    let config = await appPrivateJSON(path);
    const original = JSON.stringify(config);
    const launcher = await appPrivateJSON(join(this.root, 'desktop-launcher.json'));
    const service = await appPrivateJSON(join(this.root, 'service-install.json'));
    if (config?.mode === 'desktop' && config.allProjects === true && config.projects?.length === 0
      && config.binary === providers.codex.binary && config.claudeBinary === providers.claude.binary
      && launcher?.launcher === join(this.engineRoot, 'bin', 'claudex-codex.mjs') && service?.cli === this.cli) {
      // Reopening a fully configured app is inspection, not a request to stop live owners.
      await this.syncHooksInstall({ root: this.root, codexHome: config.codexHome, claudeHome: config.claudeHome,
        nodePath: this.node, hookPath: join(this.engineRoot, 'bin', 'claudex-sync-hook.mjs') });
      if (config.folderProjection?.enabled === true) await this.configureFolderPresentation(config);
      return;
    }
    const lease = await this.ownership(this.root, { includeSupervisor: true });
    if (!lease.allowed) throw new Error('An existing synchronization owner is active. Its settings and native work were preserved; retry after a safe shutdown.');
    if (config && (config.version !== 1 || ![undefined, 'legacy', 'desktop'].includes(config.mode))) throw new Error('Unsupported existing synchronization configuration.');
    if (config?.mode !== 'desktop') {
      const previous = await appPrivateJSON(join(this.root, 'state.json'), 32 * 1024 * 1024);
      if (previous?.pending || previous?.records?.length) throw new Error('Existing CLI-only history requires an explicit migration; it was preserved.');
    }
    await mkdir(join(this.home, '.codex'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.home, '.claude'), { recursive: true, mode: 0o700 });
    config = { version: 1, since: Date.now(), codexHome: join(this.home, '.codex'), claudeHome: join(this.home, '.claude'), ...config,
      mode: 'desktop', allProjects: true, projects: [], contextMode: config?.contextMode ?? 'archive',
      versionPolicy: normalizeVersionPolicy(config?.versionPolicy ?? 'warn'), binary: providers.codex.binary, claudeBinary: providers.claude.binary };
    await this.desktopInstall({ root: this.root, launcher: join(this.engineRoot, 'bin', 'claudex-codex.mjs'), binary: providers.codex.binary, run: this.nativeRun });
    if (JSON.stringify(await appPrivateJSON(path)) !== original) throw new Error('Synchronization configuration changed during setup; it was preserved.');
    await writeJSON(path, config);
    await this.syncHooksInstall({ root: this.root, codexHome: config.codexHome, claudeHome: config.claudeHome,
      nodePath: this.node, hookPath: join(this.engineRoot, 'bin', 'claudex-sync-hook.mjs') });
    await this.configureFolderPresentation(config);
    await this.serviceInstall({ root: this.root, cli: this.cli, node: this.node, home: this.home,
      path: `${join(this.runtimeDirectory, 'bin')}:/usr/bin:/bin` }, { run: this.nativeRun });
  }

  async configureFolderPresentation(config) {
    this.requireWritable();
    const disabled = config.folderProjection?.enabled === false;
    const cachePath = claudeFolderPresentationCachePath(this.home, config.folderProjection?.cachePath);
    // Presentation is independently guarded. A cache mismatch cannot prevent the base watcher from being installed.
    try {
      const resource = disabled ? null : await this.foldersInstall({ root: this.root, home: this.home, cachePath });
      const next = { ...config, rendererAdapters: { enabled: config.rendererAdapters?.enabled !== false },
        ...(!disabled ? { folderProjection: { enabled: true, cachePath: resource?.cachePath ?? cachePath },
          desktopLocalHandoff: config.desktopLocalHandoff ?? { enabled: true } } : {}) };
      if (JSON.stringify(await appPrivateJSON(join(this.root, 'config.json'))) !== JSON.stringify(config))
        throw new Error('Synchronization configuration changed during folder setup; it was preserved.');
      if (JSON.stringify(next) !== JSON.stringify(config)) await writeJSON(join(this.root, 'config.json'), next);
    } catch { /* inspect reports waiting; never substitute or patch an unknown frontend. */ }
  }

  async login(provider) {
    this.requireWritable();
    if (!['codex', 'claude'].includes(provider)) throw new Error('Unknown account provider.');
    const found = await this.providers();
    const binary = found[provider]?.binary;
    if (!binary) return this.inspect({ providers: found });
    try {
      await this.nativeRun(binary, provider === 'codex' ? ['login'] : ['auth', 'login', '--claudeai'], { timeout: 10 * 60 * 1000, maxBuffer: 65536 });
    } catch { return this.inspect({ providers: found, notes: { [`${provider}-login`]: 'Official sign-in has not completed. Finish it in the browser, then retry.' } }); }
    return this.setup();
  }
}

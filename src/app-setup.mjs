import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open } from 'node:fs/promises';
import { homedir, userInfo, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { privateDirectory, withLock, writeJSON } from './storage.mjs';
import { discoverProviders, ensureProviders } from './app-providers.mjs';
import { installCollaboration } from './collaboration-install.mjs';
import { callCollaboration } from './collaboration-transport.mjs';
import { installDesktopLauncher } from './desktop-install.mjs';
import { installService, controlService } from './service.mjs';
import { inspectServiceStart } from './service-supervisor.mjs';
import { ensureClaudeFolderCache } from './claude-folder-install.mjs';
import { isAllowedCodexVersion } from './codex-versions.mjs';
import { normalizeVersionPolicy } from './runtime-version-policy.mjs';
import { installAppLogin } from './app-login.mjs';
import { installSyncHooks } from './sync-hook-install.mjs';

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
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
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
    collaborationInstall = installCollaboration, desktopInstall = installDesktopLauncher,
    serviceInstall = installService, serviceStatus = controlService, ownership = inspectServiceStart,
    foldersInstall = ensureClaudeFolderCache, collaborationCall = callCollaboration,
    interfaceInstall = installAppLogin, syncHooksInstall = installSyncHooks, appPath } = {}) {
    if (![root, home, engineRoot].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('Setup paths must be absolute.');
    Object.assign(this, { root: resolve(root), home, engineRoot: resolve(engineRoot), runtimeDirectory: runtimeDirectory ?? resolve(engineRoot, '..', 'runtime'),
      run, platform, discover, ensure, collaborationInstall, desktopInstall, serviceInstall, serviceStatus, ownership, foldersInstall, collaborationCall,
      interfaceInstall, syncHooksInstall, appPath: appPath ?? resolve(engineRoot, '../../..') });
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

  async runtimeReady() {
    try { await access(this.node, constants.X_OK); await access(join(this.runtimeDirectory, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')); return true; }
    catch { return false; }
  }

  async providers(install = false) {
    return (install ? this.ensure : this.discover)({ root: this.root, home: this.home, runtime: this.runtimeDirectory,
      env: { ...process.env, PATH: `${join(this.home, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }, run: this.nativeRun });
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
    const root = join(this.root, 'collaboration');
    try {
      const file = await open(join(root, 'controller-key'), constants.O_RDONLY | constants.O_NOFOLLOW);
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

  async models(defaultModels, defaultEfforts) {
    return this.collaborationRequest('models', {
      ...(defaultModels === undefined ? {} : { defaultModels }),
      ...(defaultEfforts === undefined ? {} : { defaultEfforts }),
    });
  }

  async inspect({ providers, notes = {} } = {}) {
    const rows = [component('projects', 'Project access', 'ready', 'All projects are available by default. Agents work only on the task you assign; macOS permissions still apply.')];
    let interfaceError = notes.interface;
    if (!interfaceError) {
      try { interfaceError = (await appPrivateJSON(join(this.root, 'app-interface-status.json')))?.error; }
      catch (error) { interfaceError = safeFailure(error); }
    }
    if (interfaceError) rows.push(component('interface', 'Claudex application', 'blocked', interfaceError, 'retry'));
    rows.push(component('runtime', 'Bundled runtime', await this.runtimeReady() ? 'ready' : 'missing',
      await this.runtimeReady() ? 'Node.js and the setup engine are included in this app.' : 'Use the complete Claudex app bundle; no separate Node.js installation is required.', 'retry'));
    let found = providers;
    if (!found) {
      try { found = await this.providers(); }
      catch (error) { rows.push(component('providers', 'Native applications', 'blocked', safeFailure(error), 'retry')); }
    }
    for (const name of ['codex', 'claude']) {
      const item = found?.[name];
      rows.push(component(`${name}-cli`, name === 'codex' ? 'Codex' : 'Claude Code', item?.binary ? 'ready' : 'missing',
        item?.binary ? `Available: ${item.version ?? 'native CLI'}` : item?.issue ?? 'The official tool will be installed during setup.', 'retry'));
      const auth = await this.auth(name, item?.binary);
      rows.push(component(`${name}-login`, name === 'codex' ? 'ChatGPT sign-in' : 'Claude sign-in', auth.ready ? 'ready' : auth.missing ? 'missing' : auth.failed ? 'blocked' : 'login-required',
        auth.ready ? 'Native account sign-in is available. Credentials are not copied.'
          : auth.missing ? 'Install the native tool before signing in.' : auth.failed ? 'Native account status could not be verified. Use the official sign-in flow.' : 'Sign in through the official provider in your browser.', `login-${name}`));
      rows.push(component(`${name}-desktop`, name === 'codex' ? 'Codex Desktop integration' : 'Claude Desktop integration', item?.app ? 'ready' : 'missing',
        item?.app ? 'The installed app has the expected vendor signature.' : 'Claudex expects this desktop app to be installed already. It will not download or replace it.', `open-${name}`));
    }
    try {
      const broker = await this.collaborationStatus();
      rows.push(component('collaboration', 'Cross-model collaboration', !broker ? 'missing' : broker.blockedByUncertainWork ? 'blocked'
        : broker.limits?.allowWrite && broker.limits?.defaultPermission === 'workspace-write' ? 'ready' : 'waiting',
      !broker ? 'The background broker and MCP connections will be configured automatically.' : broker.blockedByUncertainWork
        ? 'Uncertain native work needs inspection. No input will be resent.' : broker.limits?.defaultPermission === 'workspace-write'
          ? 'All projects are available for task-scoped file editing and handoff.' : 'An existing broker retains its previous read-only policy. It must be upgraded when safely stopped.', broker?.blockedByUncertainWork ? 'diagnostics' : 'retry'));
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
      rows.push(component('folders', 'Native project folders', watcher?.folderProjection?.state === 'error' ? 'blocked'
        : config?.folderProjection?.enabled && live && watcher.folderProjection?.state === 'ready' ? 'ready' : 'waiting',
        watcher?.folderProjection?.state === 'error' ? watcher.folderProjection.error ?? 'The current frontend resource could not be verified. No replacement resource was assumed.'
          : config?.folderProjection?.enabled ? 'The folder adapter is configured. Running-watcher verification and a normal idle Claude restart may still be required.'
          : 'Folder integration requires a supported frontend resource and an idle synchronization setup.', watcher?.folderProjection?.state === 'error' ? 'diagnostics' : 'retry'));
      rows.push(component('handoffs', 'Native predecessor archival', watcher?.localHandoff?.state === 'error' ? 'blocked'
        : config?.desktopLocalHandoff?.enabled && live && watcher.localHandoff?.state === 'ready' ? 'ready' : 'waiting',
        watcher?.localHandoff?.state === 'error' ? watcher.localHandoff.error ?? 'The native handoff coordinator reports an unresolved guard. Original histories are preserved.'
          : config?.desktopLocalHandoff?.enabled ? 'Native handoffs are configured; each archival still requires verified history and native lifecycle checks.'
          : 'Native handoff integration is waiting for verified folder setup. Original conversations remain preserved.', watcher?.localHandoff?.state === 'error' ? 'diagnostics' : 'retry'));
    } catch (error) { rows.push(component('synchronization', 'Conversation synchronization', 'blocked', safeFailure(error), 'retry')); }
    for (const row of rows) if (notes[row.id]) { row.state = 'blocked'; row.detail = notes[row.id]; row.action = 'retry'; }
    const phase = rows.every(row => row.state === 'ready') ? 'ready' : rows.some(row => row.state === 'blocked') ? 'blocked'
      : rows.some(row => ['missing', 'login-required'].includes(row.state)) ? 'needs-action' : 'waiting';
    return { version: 1, phase, allProjects: true, allowWrite: true, components: rows,
      message: phase === 'ready' ? 'Claudex is configured for all projects.'
        : phase === 'waiting' ? 'No setup changes are required. Claudex will continue automatically.'
          : 'Independent features stay available while the remaining requirements are resolved.' };
  }

  async setup() {
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
      if (!providers.codex?.app || !providers.claude?.app) return this.inspect({ providers, notes });
      const authenticated = Object.fromEntries(await Promise.all(['codex', 'claude'].map(async name => [name, await this.auth(name, providers[name]?.binary)])));
      const mappedRun = (command, args, options) => this.nativeRun(command === 'codex' ? providers.codex.binary : command === 'claude' ? providers.claude.binary : command, args, options);
      if (authenticated.codex.ready && authenticated.claude.ready) {
        try {
          await this.collaborationInstall({ root: join(this.root, 'collaboration'), cli: this.collaborationCli,
            node: this.node, home: this.home, allowWrite: true, defaultPermission: defaults.defaultPermission,
            codexBinary: providers.codex.binary, claudeBinary: providers.claude.binary,
            environmentPath: `${join(this.runtimeDirectory, 'bin')}:${join(this.home, '.local', 'bin')}:/usr/bin:/bin` }, { run: mappedRun });
        } catch (error) { notes.collaboration = safeFailure(error); }
      }
      // Native writer ownership gates only synchronization configuration, not independent collaboration.
      if (providers.codex.app && providers.claude.app && authenticated.codex.ready && authenticated.claude.ready) {
        try { await this.configureSynchronization(providers); }
        catch (error) { notes.synchronization = safeFailure(error); }
      }
      const report = await this.inspect({ providers, notes });
      await writeJSON(join(this.root, 'app-setup-status.json'), { ...report, updatedAt: Date.now() });
      return report;
    }, { recoverDead: true });
  }

  async prepareInterface() {
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
    if (this.platform !== 'darwin') throw new Error('The Claudex app requires macOS.');
    this.root = await privateDirectory(this.root);
    const notes = {};
    try { await this.prepareInterface(); }
    catch (error) { notes.interface = safeFailure(error); }
    return this.inspect({ notes });
  }

  async configureSynchronization(providers) {
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
    const cachePath = config.folderProjection?.cachePath ?? join(this.home, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data', '15bc54146dcdb4ce_0');
    // Presentation is independently guarded. A cache mismatch cannot prevent the base watcher from being installed.
    try {
      await this.foldersInstall({ root: this.root, cachePath });
      config = { ...config, folderProjection: { enabled: true, cachePath }, desktopLocalHandoff: { enabled: true } };
      await writeJSON(path, config);
    } catch { /* inspect reports waiting; never substitute or patch an unknown frontend. */ }
    await this.serviceInstall({ root: this.root, cli: this.cli, node: this.node, home: this.home,
      path: `${join(this.runtimeDirectory, 'bin')}:/usr/bin:/bin` }, { run: this.nativeRun });
  }

  async login(provider) {
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

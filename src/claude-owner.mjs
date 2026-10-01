import { spawn, execFile } from 'node:child_process';
import { isInlineBase64 } from './base64.mjs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { open, readFile, unlink, lstat, link, realpath, access } from 'node:fs/promises';
import { ftruncateSync, writeSync, fsyncSync, constants } from 'node:fs';
import { hash, privateDirectory, readJSON, snapshot, writeJSON } from './storage.mjs';
import { sessionPath } from './claude.mjs';
import { captureImageAssets, restoreImageAssets } from './claude-image-assets.mjs';
import { inspectMaintenancePolicy } from './maintenance-policy.mjs';
import { normalizeVersionPolicy, runtimeVersionPermitted } from './runtime-version-policy.mjs';

export const CLAUDE_OWNER_SDK_VERSION = '0.3.281';
export const CLAUDE_OWNER_CLI_VERSION = '2.1.281';
const execute = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REMOTE_ID = /^cse_[A-Za-z0-9_-]+$/;

export async function resolveClaudeOwnerExecutable(command, env = process.env, cwd = process.cwd()) {
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [resolve(cwd, command)]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try {
      const absolute = await realpath(candidate);
      if (!(await lstat(absolute)).isFile()) continue;
      await access(absolute, constants.X_OK);
      return absolute;
    } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('Claude owner executable could not be resolved to an executable file.');
}

export async function claudeOwnerEnvironment(claudeHome, overrides = {}, inherited = process.env) {
  const canonical = async path => {
    try { return await realpath(path); }
    catch (error) { if (error.code === 'ENOENT') return resolve(path); throw error; }
  };
  const env = { ...inherited, ...overrides, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
  // Setting CLAUDE_CONFIG_DIR changes the native Keychain namespace even when
  // its value names the default directory. Preserve default OAuth credentials
  // by omitting it, not by copying credentials into another namespace.
  if (await canonical(claudeHome) === await canonical(join(homedir(), '.claude'))) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = await canonical(claudeHome);
  return env;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid owner process identity.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

const sameSnapshot = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink']
  .every(key => a[key] === b[key]);

async function readOwnerJSON(path) {
  const named = await lstat(path, { bigint: true });
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n
        || (before.mode & 0o777n) !== 0o600n || !sameSnapshot(named, before))
      throw new Error('Claude owner metadata must be a stable private owned regular file.');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (length !== Number(before.size) || !sameSnapshot(before, after) || !sameSnapshot(after, current))
      throw new Error('Claude owner metadata changed while being read.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    return { state: JSON.parse(text), identity: after, text };
  } finally { await file.close(); }
}

async function acquireLock(path) {
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const { state: old, identity: original, text } = await readOwnerJSON(path);
    if (alive(old.pid) || old.childPid && alive(old.childPid)) throw new Error('Claude owner is already running; refusing a second writer.');
    // One reaper at a time. A crash during reaping remains explicit, not an
    // invitation to race another process or discard an uncertain live owner.
    const claim = `${path}.reap`;
    try { await link(path, claim); }
    catch { throw new Error('Claude owner recovery is already claimed; inspect the owner lock.'); }
    try {
      const current = await lstat(path, { bigint: true }), claimed = await lstat(claim, { bigint: true });
      if (current.ino !== original.ino || current.dev !== original.dev
          || current.ino !== claimed.ino || current.dev !== claimed.dev
          || (await readFile(claim, 'utf8')) !== text
          || alive(old.pid) || old.childPid && alive(old.childPid)) throw new Error('Claude owner lock changed during recovery.');
      await unlink(path);
      file = await open(path, 'wx', 0o600);
    } finally { await unlink(claim); }
  }
  const identity = { pid: process.pid, childPid: null, nonce: randomUUID() };
  const save = () => {
    ftruncateSync(file.fd, 0);
    writeSync(file.fd, JSON.stringify(identity), 0, 'utf8');
    fsyncSync(file.fd);
  };
  save();
  return {
    setChild(pid) { identity.childPid = pid; save(); },
    async release() {
      const { state: current } = await readOwnerJSON(path);
      if (current.nonce !== identity.nonce) throw new Error('Claude owner lock changed before release.');
      await file.close();
      await unlink(path);
    },
  };
}

function inputQueue() {
  const queue = [];
  let wake, ended = false;
  return {
    push(value) { if (ended) throw new Error('Claude owner input is closed.'); queue.push(value); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || queue.length) {
        if (queue.length) yield queue.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

function normalizedContent(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return value;
  return value.map(block => block.type === 'text' ? { type: 'text', text: block.text }
    : block.type === 'image' ? { type: 'image', source: { type: block.source?.type,
      media_type: block.source?.media_type, data: block.source?.data } } : block);
}

function validateContent(content) {
  if (typeof content === 'string') {
    if (!content.trim()) throw new Error('Owner appends require nonempty handoff content.');
    return;
  }
  if (!Array.isArray(content) || !content.length) throw new Error('Owner appends require nonempty handoff content.');
  for (const block of content) {
    if (!block || typeof block !== 'object') throw new Error('Unsupported handoff content block.');
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) continue;
    if (block.type === 'image' && block.source?.type === 'base64'
      && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.source.media_type)
      && isInlineBase64(block.source.data)) continue;
    throw new Error('Handoffs support text and inline base64 images only.');
  }
}

function appendUuid(sessionId, operationId) {
  const digits = hash(`${sessionId}\0${operationId}`).slice(0, 32).split('');
  digits[12] = '5'; digits[16] = ((parseInt(digits[16], 16) & 3) | 8).toString(16);
  const value = digits.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** The sole SDK writer for a stable local session and its Desktop Remote Control view. */
export class ClaudeOwner {
  static async readSavedState(path) {
    try { return (await readOwnerJSON(path)).state; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  /** Hold the native writer lock for a process-free read. Never register,
   * reconcile pending work, load the SDK, or expose an external input channel.
   */
  static async readStopped({ root, conversationId, cwd, claudeHome, sessionId, path, versionPolicy }, read) {
    const owner = new ClaudeOwner({ root, conversationId, cwd, claudeHome, versionPolicy });
    const directory = join(owner.root, 'owners'), before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.uid !== BigInt(process.getuid()) || (before.mode & 0o077n) !== 0n
        || await realpath(directory) !== directory) throw new Error('Claude owner directory must be canonical, private and owned.');
    owner.statePath = join(directory, `${hash(conversationId)}.json`);
    const lock = await acquireLock(`${owner.statePath}.lock`);
    try {
      const saved = await readOwnerJSON(owner.statePath);
      owner.state = saved.state;
      if (!owner.state || owner.state.version !== 1 || owner.state.conversationId !== conversationId
          || !UUID.test(sessionId) || owner.state.sessionId !== sessionId || owner.state.cwd !== cwd
          || owner.state.claudeHome !== claudeHome || await realpath(cwd) !== cwd
          || await realpath(claudeHome) !== claudeHome || path !== sessionPath(claudeHome, cwd, sessionId))
        throw new Error('Stored Claude owner state identity does not match its record.');
      if (owner.state.blocked) throw new Error(owner.state.blocked);
      if (owner.state.reset) throw new Error('A pending native context reset requires owner recovery before process-free inspection.');
      if (owner.state.pending) throw new Error('A pending native append requires owner recovery before process-free inspection.');
      if (owner.state.remoteId && !REMOTE_ID.test(owner.state.remoteId)) throw new Error('Invalid saved native remote identity.');
      if (owner.state.displayTitle !== undefined && (typeof owner.state.displayTitle !== 'string' || !owner.state.displayTitle.trim()))
        throw new Error('Saved Claude owner display title must be nonempty text.');
      owner.transcriptPath = path;
      const result = await read(owner);
      const after = await lstat(directory, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid
          || await realpath(directory) !== directory || !sameSnapshot(saved.identity, await lstat(owner.statePath, { bigint: true })))
        throw new Error('Stored Claude owner state changed during inspection.');
      return result;
    } finally { await lock.release(); }
  }

  static async open(options) {
    const owner = new ClaudeOwner(options);
    await owner.start();
    return owner;
  }

  constructor({ root, conversationId, cwd, claudeHome = join(homedir(), '.claude'), title = 'Claudex conversation', newSessionTitle,
    queryFactory, sdkVersion, claudeVersion, options = {}, onEvent = () => {}, receiptTimeoutMs = 30_000,
    deferRemoteConnection = false, connectAfterReset = true, settingsResolver, policyPreflight = inspectMaintenancePolicy,
    versionPolicy = 'strict' }) {
    if (!root || !conversationId || !cwd) throw new Error('Owner root, conversation identity, and working directory are required.');
    if (!Number.isFinite(receiptTimeoutMs) || receiptTimeoutMs <= 0) throw new Error('Invalid append receipt timeout.');
    for (const key of ['sessionId', 'resume', 'continue', 'forkSession', 'resumeSessionAt', 'resumeDropsTurn', 'persistSession', 'spawnClaudeCodeProcess']) {
      if (Object.hasOwn(options, key)) throw new Error(`Owner controls SDK option ${key}.`);
    }
    if (deferRemoteConnection && (options.extraArgs || typeof options.settings === 'string' || options.connect))
      throw new Error('Cold owners require a local process and inline settings without extra native arguments.');
    this.root = resolve(root); this.conversationId = conversationId; this.cwd = resolve(cwd);
    this.claudeHome = resolve(claudeHome); this.title = title; this.newSessionTitle = newSessionTitle; this.options = options;
    this.queryFactory = queryFactory; this.sdkVersion = sdkVersion; this.claudeVersion = claudeVersion;
    this.versionPolicy = normalizeVersionPolicy(versionPolicy); this.versionWarning = null; this.versionWarningEmitted = false;
    this.settingsResolver = settingsResolver; this.injectedSettingsResolver = typeof settingsResolver === 'function';
    this.policyPreflight = policyPreflight;
    this.onEvent = onEvent; this.receiptTimeoutMs = receiptTimeoutMs;
    this.deferRemoteConnection = deferRemoteConnection;
    this.connectAfterReset = connectAfterReset;
    this.everConnected = false; this.coldStartVerified = false;
    this.input = inputQueue(); this.closed = false; this.closing = false;
    this.nativeState = 'idle'; this.blocked = null; this.appendBusy = false; this.identityUncertain = false;
    // The pinned SDK's background level is process-local and starts empty.
    this.backgroundTasks = []; this.activityRevision = 0; this.resetBusy = false;
  }

  status() {
    return { sessionId: this.state?.sessionId ?? null, remoteId: this.state?.remoteId ?? null,
      transcriptPath: this.transcriptPath ?? null, pending: this.state?.pending?.operationId ?? null,
      nativeState: this.nativeState, backgroundTasks: structuredClone(this.backgroundTasks),
      reset: this.state?.reset ? { operationId: this.state.reset.operationId, phase: this.state.reset.phase,
        previousSessionId: this.state.reset.previous.sessionId, targetSessionId: this.state.reset.targetSessionId ?? null } : null,
      lastReset: this.state?.lastReset ? structuredClone(this.state.lastReset) : null,
      retainedGeneration: this.state?.retainedGeneration ? { sessionId: this.state.retainedGeneration.sessionId,
        transcriptPath: this.state.retainedGeneration.transcriptPath } : null,
      maintenanceOnly: this.deferRemoteConnection, deferRemoteConnection: this.deferRemoteConnection,
      versionPolicy: this.versionPolicy, versionWarning: this.versionWarning ? { ...this.versionWarning } : null,
      coldResetEligible: this.coldStartVerified && !this.everConnected && this.activityRevision === 0
        && this.nativeState === 'idle' && !this.backgroundTasks.length && !this.blocked
        && !this.closed && !this.closing && !this.appendBusy && !this.resetBusy && !this.waiting,
      blocked: this.blocked, closed: this.closed };
  }

  async emit(event) {
    try { await this.onEvent(event); }
    catch { this.blocked = 'Owner event consumer failed; synchronization is paused.';
      this.waiting?.reject(new Error(this.blocked)); this.resetWaiting?.reject(new Error(this.blocked));
      this.resetIdleWaiting?.reject(new Error(this.blocked)); }
  }

  async save() { await writeJSON(this.statePath, this.state); }

  async contextUsage() {
    if (this.closed || this.closing || !this.query) throw new Error('Claude owner is closed or not started.');
    const response = await this.query.getContextUsage({ detail: 'summary' });
    const usage = Object.fromEntries(['totalTokens', 'maxTokens', 'rawMaxTokens', 'percentage'].map(key => [key, response?.[key]]));
    if (Object.values(usage).some(value => !Number.isFinite(value) || value < 0)
      || usage.maxTokens === 0 || usage.rawMaxTokens === 0) throw new Error('Native context usage is missing or invalid.');
    return usage;
  }

  async waitForResetIdle() {
    if (this.nativeState === 'idle') return;
    let timeout;
    try {
      await new Promise((resolve, reject) => {
        this.resetIdleWaiting = { resolve, reject };
        timeout = setTimeout(() => reject(new Error('Native context maintenance has not returned to idle; its state was preserved.')), this.receiptTimeoutMs);
      });
    } finally { clearTimeout(timeout); this.resetIdleWaiting = null; }
  }

  async start() {
    this.cwd = await realpath(this.cwd);
    this.claudeHome = await realpath(this.claudeHome);
    this.ownerDirectory = await privateDirectory(join(await privateDirectory(this.root), 'owners'));
    this.statePath = join(this.ownerDirectory, `${hash(this.conversationId)}.json`);
    this.lock = await acquireLock(`${this.statePath}.lock`);
    try {
      this.state = await readJSON(this.statePath, null);
      if (this.state && (this.state.version !== 1 || this.state.conversationId !== this.conversationId || this.state.cwd !== this.cwd
        || this.state.claudeHome !== this.claudeHome || !UUID.test(this.state.sessionId))) throw new Error('Owner state identity does not match this conversation.');
      if (!this.state) {
        const displayTitle = this.newSessionTitle ?? this.title;
        if (typeof displayTitle !== 'string' || !displayTitle.trim()) throw new Error('New Claude owner display title must be nonempty text.');
        this.state = { version: 1, conversationId: this.conversationId, cwd: this.cwd, claudeHome: this.claudeHome,
          sessionId: randomUUID(), remoteId: null, registration: null, pending: null, lastAppend: null, displayTitle };
        await this.save();
      }
      if (this.state.displayTitle !== undefined && (typeof this.state.displayTitle !== 'string' || !this.state.displayTitle.trim()))
        throw new Error('Saved Claude owner display title must be nonempty text.');
      this.transcriptPath = sessionPath(this.claudeHome, this.cwd, this.state.sessionId);
      if (this.state.blocked) throw new Error(this.state.blocked);
      if (this.state.reset && !this.deferRemoteConnection) throw new Error('A pending context reset requires a deferred cold maintenance owner.');
      if (this.state.reset) await this.validateResetRecovery();
      const transcript = await this.inspectTranscript();
      if (!transcript.exists && (this.state.remoteId || this.state.lastAppend || this.state.registration === 'registered')) {
        throw new Error('The owned native transcript is missing; refusing an empty restart of its existing remote identity.');
      }
      const recoveredId = this.inspectRemoteIdentity(transcript);
      if (!this.state.remoteId && recoveredId) { this.state.remoteId = recoveredId; this.state.registration = 'registered'; await this.save(); }
      if (this.state.registration === 'registering' && !this.state.remoteId) throw new Error('Remote registration outcome is unknown; refusing to allocate another remote conversation.');
      if (this.state.pending) await this.reconcilePending(transcript);
      if (this.deferRemoteConnection && transcript.exists && !this.state.reset) this.assertColdTranscriptBoundary(transcript);
      await this.loadRuntime();
      const runtimeEnv = await claudeOwnerEnvironment(this.claudeHome, this.options.env);
      if (this.deferRemoteConnection) await this.verifyMaintenancePolicy(runtimeEnv);
      this.query = this.queryFactory({ prompt: this.input, options: {
        settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...this.options, cwd: this.cwd, title: this.state.displayTitle ?? this.title, persistSession: true,
        // Maintenance is a separate, input-isolated process profile. Do not
        // load normal user/project extensions or mutate persistent settings.
        ...(this.deferRemoteConnection ? { settingSources: [], strictMcpConfig: true,
          mcpServers: {}, plugins: [], tools: [], hooks: {}, settings: { ...this.options.settings,
            remoteControlAtStartup: false, crossSessionInbound: 'refuse', disableAllHooks: true, enabledPlugins: {} } } : {}),
        env: runtimeEnv,
        ...(transcript.exists ? { resume: this.state.sessionId } : { sessionId: this.state.sessionId }),
        spawnClaudeCodeProcess: options => {
          const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'ignore'] });
          this.child = child;
          if (child.pid) this.lock.setChild(child.pid);
          return child;
        },
      } });
      this.consumer = this.consume();
      const initialized = await this.query.initializationResult();
      if (initialized?.session_state) this.nativeState = initialized.session_state;
      if (this.deferRemoteConnection) {
        const servers = await this.query.mcpServerStatus();
        if (!Array.isArray(servers) || servers.length)
          throw new Error('Cold maintenance requires a verified empty native MCP server list.');
      }
      this.clearSupported = Array.isArray(initialized?.commands)
        && initialized.commands.some(command => command.name === 'clear');
      this.coldStartVerified = this.deferRemoteConnection && initialized?.session_state === 'idle';
      // Never expose a cleared-but-not-restored session to external inputs.
      if (this.state.remoteId && !this.state.reset && !this.deferRemoteConnection) await this.connect();
    } catch (error) {
      if (this.query && (this.nativeState !== 'idle' || this.backgroundTasks.length)) {
        this.blocked = 'Owner startup failed while Claude was active; the live session is preserved.';
        await this.emit({ type: 'owner_error', message: this.blocked });
        throw error;
      }
      // Startup has sent no user work. Existing remote work is never interrupted
      // by append/event errors after startup has completed.
      this.input.end();
      this.query?.close();
      if (this.consumer) await this.consumer;
      await this.waitForChildExit();
      await this.lock.release(); this.closed = true;
      throw error;
    }
  }

  async loadRuntime() {
    if (!this.queryFactory) {
      const moduleUrl = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
      const metadata = JSON.parse(await readFile(join(dirname(fileURLToPath(moduleUrl)), 'package.json'), 'utf8'));
      this.sdkVersion = metadata.version;
      const sdk = await import(moduleUrl);
      this.queryFactory = sdk.query;
      this.settingsResolver ??= sdk.resolveSettings;
      const executable = await resolveClaudeOwnerExecutable(this.options.pathToClaudeCodeExecutable ?? 'claude',
        { ...process.env, ...this.options.env }, this.cwd);
      const version = await execute(executable, ['--version'], { timeout: 10_000, maxBuffer: 4096 });
      this.claudeVersion = version.stdout.trim().split(/\s+/)[0];
      // The SDK must launch the binary just checked, not its bundled binary or
      // a different command found through a later PATH lookup.
      this.options = { ...this.options, pathToClaudeCodeExecutable: executable };
    }
    if (!runtimeVersionPermitted(this.sdkVersion, CLAUDE_OWNER_SDK_VERSION, this.versionPolicy)
        || !runtimeVersionPermitted(this.claudeVersion, CLAUDE_OWNER_CLI_VERSION, this.versionPolicy))
      throw new Error('Unsupported Claude owner runtime; SDK and native CLI must match the pinned versions or an explicit warn policy.');
    // An unfamiliar version is not a compatibility failure. Native protocol,
    // ownership and history checks remain the source of operational errors.
    this.versionWarning = null;
  }

  async verifyMaintenancePolicy(runtimeEnv) {
    if (typeof this.settingsResolver !== 'function') throw new Error('Cold maintenance requires a read-only native settings resolver.');
    // resolveSettings has no per-call env/config-directory option. Do not read
    // the standard policy namespace and claim it covers an isolated CLI home.
    if (!this.injectedSettingsResolver && runtimeEnv.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR)
      throw new Error('Cold maintenance cannot verify policy in a different Claude settings namespace.');
    const snapshot = await this.policyPreflight({ claudeHome: this.claudeHome });
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.sources))
      throw new Error('Cold maintenance policy preflight did not return a valid source snapshot.');
    const resolved = await this.settingsResolver({ cwd: this.cwd, settingSources: [],
      ...(this.options.managedSettings ? { managedSettings: this.options.managedSettings } : {}) });
    if (!resolved || !Array.isArray(resolved.sources) || !resolved.effective || typeof resolved.effective !== 'object')
      throw new Error('Cold maintenance policy settings are unavailable or invalid.');
    // The public resolver deliberately does not execute policyHelper. Its
    // dynamic policy cannot prove a hook-free/input-isolated maintenance run.
    const settings = [resolved.effective, ...resolved.sources.map(source => source.settings)];
    if (settings.some(value => !value || typeof value !== 'object' || value.policyHelper || value.policyHelpers
      || value.policyUnreadable || value.policyHookCount > 0))
      throw new Error('Cold maintenance cannot establish hook-free managed policy.');
    if (resolved.sources.filter(source => source.source === 'managed').some(source =>
      source.settings.hooks && Object.keys(source.settings.hooks).length))
      throw new Error('Cold maintenance refuses configured managed hooks; organizational policy is not overridden.');
    const digest = hash({ snapshot, effective: resolved.effective, sources: resolved.sources });
    if (this.maintenancePolicyDigest && this.maintenancePolicyDigest !== digest)
      throw new Error('Cold maintenance policy changed after startup; context reset is refused.');
    this.maintenancePolicyDigest = digest;
  }

  async inspectTranscript() {
    if (this.state.retainedGeneration) await this.verifyResetGeneration(this.state.retainedGeneration);
    let data;
    try {
      const info = await lstat(this.transcriptPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Owned transcript must be a regular file.');
      data = await snapshot(this.transcriptPath);
    } catch (error) { if (error.code === 'ENOENT') return { rows: [], exists: false }; throw error; }
    // Only the bridge's logical read view substitutes lossless originals for
    // native resized previews. The SDK-owned transcript is never edited.
    const rows = await restoreImageAssets({ root: this.root, rows: data.rows,
      bindings: this.state.imageBindings === undefined ? {} : this.state.imageBindings });
    return { ...data, rows, text: rows === data.rows ? data.text : rows.map(row => JSON.stringify(row)).join('\n') + '\n', exists: true };
  }

  inspectRemoteIdentity(transcript) {
    const remoteIds = new Set(transcript.rows.filter(row => row.type === 'bridge-session' && row.sessionId === this.state.sessionId)
      .map(row => row.bridgeSessionId));
    if ([...remoteIds].some(id => !REMOTE_ID.test(id)) || remoteIds.size > 1) throw new Error('Native remote identity is invalid or ambiguous.');
    const recoveredId = [...remoteIds][0];
    if (this.state.remoteId && recoveredId && this.state.remoteId !== recoveredId) throw new Error('Native and saved remote identities disagree.');
    if (this.state.registration === 'registering' && !this.state.remoteId && !recoveredId)
      throw new Error('Remote registration outcome is unknown; refusing to allocate another remote conversation.');
    return recoveredId;
  }

  async inspectResetSource(operationId, sessionId) {
    const reset = this.state.reset?.operationId === operationId ? this.state.reset : null;
    const previous = reset?.previous ?? (this.state.lastReset?.operationId === operationId ? this.state.retainedGeneration : null);
    if (!previous || previous.sessionId !== sessionId) throw new Error('No verified retained source exists for this reset operation.');
    const data = await this.verifyResetGeneration(previous, reset?.receipt);
    const rows = await restoreImageAssets({ root: this.root, rows: data.rows, bindings: previous.imageBindings ?? {} });
    return { ...data, path: previous.transcriptPath, rows,
      text: rows === data.rows ? data.text : rows.map(row => JSON.stringify(row)).join('\n') + '\n', exists: true };
  }

  async findAppend(transcript, pending) {
    const matches = transcript.rows.filter(row => row.uuid === pending.uuid);
    if (!matches.length) return false;
    if (matches.length !== 1 || matches[0].type !== 'user' || matches[0].sessionId !== this.state.sessionId) throw new Error('Owned append identity or content does not match the durable intent.');
    if (hash(normalizedContent(matches[0].message?.content)) !== pending.contentHash) {
      if (!pending.content || !normalizedContent(pending.content).some(block => block.type === 'image')
        || this.state.imageBindings?.[pending.uuid]) throw new Error('Owned append identity or content does not match the durable intent.');
      const temporaryBase = this.options.env?.CLAUDE_CODE_TMPDIR ?? process.env.CLAUDE_CODE_TMPDIR ?? (process.platform === 'darwin' ? '/tmp' : tmpdir());
      const captured = await captureImageAssets({ root: this.root, claudeTempRoot: join(temporaryBase, `claude-${process.getuid()}`),
        cwd: this.cwd, sessionId: this.state.sessionId, row: matches[0], expectedContent: pending.content,
        expectedHash: pending.contentHash, normalizeContent: normalizedContent, versionPolicy: this.versionPolicy });
      this.state.imageBindings = { ...this.state.imageBindings, [pending.uuid]: captured.bindings };
      await this.save();
    }
    return true;
  }

  async hasAppend({ operationId, content }) {
    validateContent(content);
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256) throw new Error('A bounded logical append identity is required.');
    return this.findAppend(await this.inspectTranscript(), {
      uuid: appendUuid(this.state.sessionId, operationId), contentHash: hash(normalizedContent(content)), content,
    });
  }

  async reconcilePending(transcript) {
    const pending = this.state.pending;
    if (!pending) return false;
    transcript ??= await this.inspectTranscript();
    if (!UUID.test(pending.uuid)) throw new Error('Invalid durable append identity.');
    if (await this.findAppend(transcript, pending)) {
      // A native record proves persistence even if a crash lost its result. It
      // does not invent a zero-cost receipt; recovered is explicit to callers.
      this.state.lastAppend = { operationId: pending.operationId, uuid: pending.uuid, contentHash: pending.contentHash, recovered: true };
      this.state.pending = null; await this.save(); return true;
    }
    if (pending.phase === 'sent') throw new Error('Append delivery is uncertain and its native UUID is absent; automatic resend is refused.');
    return false;
  }

  /** Migrate only this bridge's exact former display prefix. The live SDK is
   * the sole writer; never use the standalone transcript-appending rename API.
   */
  async reconcileDisplayTitle(title) {
    if (typeof title !== 'string' || !title.trim() || title.length > 4096) return false;
    const oldTitle = `[Claudex] ${title}`;
    if (this.state.displayTitleReconciled === 1 && !this.state.displayTitleMigration) return false;
    if (!this.state.remoteId && this.state.displayTitle !== oldTitle && !this.state.displayTitleMigration) return false;
    if (this.closed || this.closing || this.blocked || this.deferRemoteConnection || this.state.reset || this.state.pending
      || this.nativeState !== 'idle' || this.backgroundTasks.length || this.appendBusy || this.resetBusy) return false;
    const nativeTitle = data => data.rows.filter(row => row.type === 'custom-title'
      && row.sessionId === this.state.sessionId).at(-1)?.customTitle;
    let actual = nativeTitle(await this.inspectTranscript());
    const pending = this.state.displayTitleMigration;
    if (pending && (pending.sessionId !== this.state.sessionId || pending.from !== oldTitle
      || pending.to !== title || !['prepared', 'sent'].includes(pending.phase)))
      throw new Error('Claude display-title migration identity changed.');
    if (actual !== undefined && actual !== oldTitle) {
      if (typeof actual !== 'string' || !actual.trim()) throw new Error('Invalid native Claude display title.');
      // A completed rename is recoverable; a different manual title is kept.
      this.state.displayTitle = actual;
      this.state.displayTitleReconciled = 1;
      delete this.state.displayTitleMigration;
      await this.save();
      return actual === title;
    }
    if (actual === undefined && this.state.displayTitle !== oldTitle && !pending) {
      this.state.displayTitleReconciled = 1; await this.save(); return false;
    }
    if (pending?.phase === 'sent')
      throw new Error('Claude display-title rename outcome is uncertain; no request was resent.');
    if (typeof this.query?.renameSession !== 'function')
      throw new Error('Native Claude owner does not support an identity-bound title update.');
    this.state.displayTitleMigration = { sessionId: this.state.sessionId, from: oldTitle, to: title, phase: 'prepared' };
    await this.save();
    this.state.displayTitleMigration.phase = 'sent';
    await this.save();
    await this.query.renameSession(title, this.state.sessionId);
    actual = nativeTitle(await this.inspectTranscript());
    if (actual !== title) throw new Error('Native Claude title update is not durably verified.');
    this.state.displayTitle = title;
    this.state.displayTitleReconciled = 1;
    delete this.state.displayTitleMigration;
    await this.save();
    return true;
  }

  async connect() {
    if (this.connected) return;
    if (this.state.reset) throw new Error('A pending context reset must be restored before Remote Control reconnects.');
    // Even a failed connection may have accepted input; never regain cold status
    // by detaching or observing a later idle level.
    this.everConnected = true;
    if (!this.state.remoteId) { this.state.registration = 'registering'; await this.save(); }
    const previous = this.state.remoteId;
    // A name is chosen only for the first registration. Reattachment must not
    // overwrite the native/cloud title, including an explicit user UI rename.
    const response = await this.query.enableRemoteControl(true, previous ? undefined : this.state.displayTitle ?? this.title,
      { keepSessionOnExit: true, ...(previous ? { reattachSessionId: previous } : {}) });
    if (!REMOTE_ID.test(response?.bridge_session_id) || previous && response.bridge_session_id !== previous) {
      this.blocked = 'Remote Control did not preserve the owned conversation identity.';
      throw new Error(this.blocked);
    }
    this.state.remoteId = response.bridge_session_id; this.state.registration = 'registered';
    await this.save(); this.connected = true;
    await this.emit({ type: 'owner_connected', sessionId: this.state.sessionId, remoteId: this.state.remoteId });
  }

  async append(input) { return this.#append(input); }

  async #append({ operationId, content }, resetOperationId = null) {
    if (this.closed || this.closing) throw new Error('Claude owner is closed.');
    if (this.blocked) throw new Error(this.blocked);
    if ((this.resetBusy || this.state.reset) && (!resetOperationId || resetOperationId !== this.state.reset?.operationId))
      throw new Error('A context reset must be restored before ordinary appends.');
    if (this.appendBusy || this.waiting) throw new Error('Another owner append is pending.');
    if (this.nativeState !== 'idle' || this.backgroundTasks.length) throw new Error('Claude is working or waiting for user action; append postponed.');
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256) throw new Error('A bounded logical append identity is required.');
    validateContent(content);
    content = typeof content === 'string' ? content : normalizedContent(content);
    this.appendBusy = true;
    try {
      const contentHash = hash(normalizedContent(content));
      if (this.state.lastAppend?.operationId === operationId) {
        if (this.state.lastAppend.contentHash !== contentHash) throw new Error('Logical append identity was reused with different content.');
        if (!await this.findAppend(await this.inspectTranscript(), this.state.lastAppend)) throw new Error('Previously committed owner append is missing.');
        if (!resetOperationId) await this.connect();
        return { ...this.state.lastAppend, ...this.status(), duplicate: true };
      }
      if (this.state.pending && (this.state.pending.operationId !== operationId || this.state.pending.contentHash !== contentHash)) throw new Error('A different durable owner append must be resolved first.');
      if (!this.state.pending) {
        this.state.pending = { operationId, uuid: appendUuid(this.state.sessionId, operationId), contentHash, content, phase: 'prepared' };
        await this.save();
      }
      if (await this.reconcilePending()) { if (!resetOperationId) await this.connect(); return { ...this.state.lastAppend, ...this.status(), duplicate: true }; }
      const pending = this.state.pending;
      const receipt = new Promise((resolve, reject) => { this.waiting = { uuid: pending.uuid, resolve, reject }; });
      // The sent checkpoint precedes transport submission. An ambiguous crash
      // blocks instead of turning at-most-once delivery into a guessed retry.
      pending.phase = 'sent'; await this.save();
      this.input.push({ type: 'user', uuid: pending.uuid, session_id: this.state.sessionId, parent_tool_use_id: null,
        message: { role: 'user', content }, shouldQuery: false, client_composed: true });
      let timeout;
      try {
        await Promise.race([receipt, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Owner append receipt timed out; delivery remains pending.')), this.receiptTimeoutMs); })]);
      } finally { clearTimeout(timeout); this.waiting = null; }
      if (!await this.findAppend(await this.inspectTranscript(), pending)) throw new Error('No-query receipt arrived without the exact persisted native append.');
      this.state.lastAppend = { operationId, uuid: pending.uuid, contentHash, recovered: false };
      this.state.pending = null; await this.save();
      if (!resetOperationId) await this.connect();
      return { ...this.state.lastAppend, ...this.status(), duplicate: false };
    } finally { this.appendBusy = false; }
  }

  async captureResetGeneration() {
    const info = await lstat(this.transcriptPath), data = await snapshot(this.transcriptPath);
    if (!info.isFile() || info.isSymbolicLink() || !data.bytes) throw new Error('Context reset requires an existing regular native transcript.');
    this.assertColdTranscriptBoundary(data);
    let queued = 0;
    for (const row of data.rows.filter(row => row.type === 'queue-operation')) {
      if (row.sessionId !== this.state.sessionId || !['enqueue', 'dequeue'].includes(row.operation))
        throw new Error('Native input queue history is unsupported; context reset refused.');
      queued += row.operation === 'enqueue' ? 1 : -1;
      if (queued < 0) throw new Error('Native input queue history is incomplete; context reset refused.');
    }
    if (queued) throw new Error('Native input queue has unresolved work; context reset refused.');
    return { sessionId: this.state.sessionId, transcriptPath: this.transcriptPath,
      dev: info.dev, ino: info.ino, bytes: data.bytes, hash: data.hash,
      costCheckpoint: data.rows.findLast(row => row.type === 'cost-state') ?? null,
      imageBindings: structuredClone(this.state.imageBindings ?? {}), lastAppend: this.state.lastAppend };
  }

  assertColdTranscriptBoundary(data) {
    const last = data.rows.filter(row => !row.isSidechain && !row.isMeta && ['user', 'assistant'].includes(row.type)).at(-1);
    const completed = last?.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(last.message?.stop_reason);
    const imported = last?.type === 'user' && last.uuid === this.state.lastAppend?.uuid;
    if (!completed && !imported) throw new Error('Wait for a complete assistant turn or a verified no-query append before cold context maintenance.');
  }

  async verifyResetGeneration(previous, clearReceipt = null) {
    if (!UUID.test(previous?.sessionId) || previous.transcriptPath !== sessionPath(this.claudeHome, this.cwd, previous.sessionId)
      || !Number.isSafeInteger(previous.bytes) || previous.bytes < 1 || !/^[a-f0-9]{64}$/.test(previous.hash))
      throw new Error('Invalid retained context-reset source identity.');
    // macOS may renumber a volume's st_dev across reboots, so the saved dev is not
    // compared. The file must share its native project directory's volume and keep
    // its inode; the saved content prefix below remains the authoritative check.
    const info = await lstat(previous.transcriptPath), parent = await lstat(dirname(previous.transcriptPath));
    const data = await snapshot(previous.transcriptPath);
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== parent.dev || info.ino !== previous.ino
      || data.bytes < previous.bytes || hash(Buffer.from(data.text).subarray(0, previous.bytes).toString('utf8')) !== previous.hash)
      throw new Error('The preserved context-reset source changed; refusing to discard concurrent history.');
    if (data.bytes === previous.bytes) return data;
    if (!clearReceipt || previous.sealed || clearReceipt.localCommand !== 'clear')
      throw new Error('The preserved context-reset source changed; refusing to discard concurrent history.');
    // The native clear appends its queue pair and may flush bridge/cost metadata
    // to the old file. Never treat arbitrary new user/assistant records as that
    // transport tail. After acceptance this entire generation is sealed again.
    const tail = Buffer.from(data.text).subarray(previous.bytes).toString('utf8').trim().split('\n').map(JSON.parse);
    const pair = tail.slice(0, 2);
    if (pair.length !== 2 || pair[0].type !== 'queue-operation' || pair[0].operation !== 'enqueue' || pair[0].content !== '/clear'
      || pair[1].type !== 'queue-operation' || pair[1].operation !== 'dequeue' || pair[1].content !== undefined
      || tail.some(row => row.sessionId !== previous.sessionId))
      throw new Error('The preserved context-reset source changed outside its exact clear transport tail.');
    let bridge = false, cost = false;
    for (const row of tail.slice(2)) {
      if (row.type === 'bridge-session' && !bridge && !cost && row.bridgeSessionId === '' && row.lastSequenceNum === 0) { bridge = true; continue; }
      if (row.type === 'cost-state' && !cost) {
        const before = previous.costCheckpoint;
        const usageKeys = ['totalCostUSD', 'totalAPIDuration', 'totalAPIDurationWithoutRetries', 'totalToolDuration', 'totalLinesAdded', 'totalLinesRemoved'];
        if (usageKeys.some(key => (row[key] ?? 0) !== (before?.[key] ?? 0))
          || hash(row.modelUsage ?? {}) !== hash(before?.modelUsage ?? {})
          || (row.hasUnknownModelCost ?? false) !== (before?.hasUnknownModelCost ?? false))
          throw new Error('The preserved context-reset source has unaccounted native usage.');
        cost = true; continue;
      }
      throw new Error('The preserved context-reset source changed outside its exact clear transport tail.');
    }
    return data;
  }

  async sealResetGeneration(reset) {
    if (reset.previous.sealed) return this.verifyResetGeneration(reset.previous);
    const data = await this.verifyResetGeneration(reset.previous, reset.receipt);
    reset.previous.originalPrefix = { bytes: reset.previous.bytes, hash: reset.previous.hash };
    reset.previous.bytes = data.bytes; reset.previous.hash = data.hash; reset.previous.sealed = true;
    await this.save();
  }

  async validateResetRecovery() {
    const reset = this.state.reset;
    if (typeof reset.operationId !== 'string' || !reset.operationId || reset.operationId.length > 256
      || !UUID.test(reset.clearUuid) || !REMOTE_ID.test(reset.remoteId) || reset.remoteId !== this.state.remoteId
      || !['prepared', 'sent', 'cleared', 'restoring'].includes(reset.phase)) throw new Error('Invalid durable context-reset intent.');
    await this.verifyResetGeneration(reset.previous, ['cleared', 'restoring'].includes(reset.phase) ? reset.receipt : null);
    if (reset.phase === 'sent') throw new Error('Context clear outcome is unknown; automatic resend and empty-session restart are refused.');
    if (reset.phase === 'prepared') {
      if (this.state.sessionId !== reset.previous.sessionId || this.state.pending)
        throw new Error('Prepared context-reset identity is inconsistent.');
      return;
    }
    if (!UUID.test(reset.targetSessionId) || reset.targetSessionId === reset.previous.sessionId
      || reset.targetSessionId !== reset.initSessionId || reset.targetSessionId !== this.state.sessionId
      || reset.receipt?.sessionId !== reset.targetSessionId || reset.receipt?.uuid !== reset.clearUuid
      || reset.receipt?.numTurns !== 0 || reset.receipt?.apiMs !== 0 || reset.receipt?.cost !== 0
      || reset.receipt?.localCommand !== 'clear') throw new Error('Context-reset native identity lacks a verified no-query receipt and matching init.');
    if (this.state.pending && this.state.pending.operationId !== reset.restoreOperationId)
      throw new Error('Context reset has an unrelated pending append.');
  }

  /**
   * Rotate native context while retaining the entire old generation. A caller
   * must supply the same deterministic authenticated archive bootstrap on retry.
   *
   * Only a fresh local process started with deferRemoteConnection may reset.
   * Its external inputs have never been connected, and the writer lock proves
   * the previous owner process exited. The pinned SDK does NOT provide a hot
   * exclusive queue/input barrier: RC detach + idle never makes an owner cold.
   * This method never closes or interrupts an active owner to obtain eligibility.
   */
  async resetContext({ operationId, buildContent }) {
    if (this.closed || this.closing) throw new Error('Claude owner is closed.');
    if (this.blocked) throw new Error(this.blocked);
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256 || typeof buildContent !== 'function')
      throw new Error('Context reset requires a bounded operation identity and a deterministic archive builder.');
    if (this.resetBusy || this.appendBusy || this.waiting || this.resetWaiting) throw new Error('Claude owner has a pending operation.');
    if (this.nativeState !== 'idle' || this.backgroundTasks.length) throw new Error('Claude owner is busy; context reset postponed.');
    if (this.state.lastReset?.operationId === operationId) {
      this.resetBusy = true;
      try {
        const content = await buildContent(this.state.lastReset.sessionId);
        if (!await this.hasAppend({ operationId: this.state.lastReset.restoreOperationId, content }))
          throw new Error('The completed reset bootstrap is missing or changed.');
        await this.verifyResetGeneration(this.state.retainedGeneration);
        if (this.connectAfterReset) await this.connect();
        return { ...this.state.lastReset, duplicate: true };
      } finally { this.resetBusy = false; }
    }
    if (this.state.reset && this.state.reset.operationId !== operationId) throw new Error('A different context-reset transaction must be resolved first.');
    if (!this.state.reset && this.state.retainedGeneration)
      throw new Error('A retained context generation still needs verified retirement; another reset is refused.');
    if (!this.state.reset && this.state.pending) throw new Error('A durable append must be resolved before context reset.');
    if (!REMOTE_ID.test(this.state.remoteId)) throw new Error('Context reset requires an existing stable Remote Control identity.');
    if (!this.coldStartVerified || this.everConnected || this.activityRevision !== 0)
      throw new Error('Context reset requires a fresh cold owner with deferred Remote Control; hot detach is not an exclusive input lease.');
    if (!this.clearSupported) throw new Error('The pinned native runtime did not advertise the clear command.');
    this.resetBusy = true;
    let completed = false;
    try {
      if (this.state.reset) await this.validateResetRecovery();
      const assertSafe = () => {
        if (!this.coldStartVerified || this.everConnected || this.activityRevision !== 0
          || this.nativeState !== 'idle' || this.backgroundTasks.length || this.blocked)
          throw new Error('Claude activity or an exposed input channel prevents cold context reset.');
      };
      await assertSafe();
      if (!this.state.reset) {
        const previous = await this.captureResetGeneration();
        this.state.reset = { operationId, clearUuid: appendUuid(previous.sessionId, `reset:${operationId}`),
          restoreOperationId: `restore:${hash(operationId)}`, phase: 'prepared', previous, remoteId: this.state.remoteId };
        await this.save();
      }
      const reset = this.state.reset;
      await this.verifyResetGeneration(reset.previous, ['cleared', 'restoring'].includes(reset.phase) ? reset.receipt : null);
      if (reset.phase === 'prepared') {
        await this.verifyMaintenancePolicy(await claudeOwnerEnvironment(this.claudeHome, this.options.env));
        await assertSafe();
        const revision = this.activityRevision;
        reset.phase = 'sent'; await this.save();
        if (this.nativeState !== 'idle' || this.backgroundTasks.length || this.activityRevision !== revision || this.blocked) {
          reset.phase = 'prepared'; await this.save();
          throw new Error('Claude became active before context clear; the original session was preserved.');
        }
        let timeout;
        const receipt = new Promise((resolve, reject) => { this.resetWaiting = { resolve, reject }; });
        // client_composed MUST be omitted: true makes /clear ordinary text.
        this.input.push({ type: 'user', uuid: reset.clearUuid, session_id: reset.previous.sessionId,
          message: { role: 'user', content: '/clear' }, shouldQuery: false });
        try {
          await Promise.race([receipt, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Context clear receipt timed out; outcome remains pending without resend.')), this.receiptTimeoutMs);
          })]);
        } finally { clearTimeout(timeout); this.resetWaiting = null; }
      }
      await this.waitForResetIdle();
      await this.verifyResetGeneration(reset.previous, reset.receipt);
      await assertSafe();
      const content = await buildContent(reset.targetSessionId);
      validateContent(content);
      const contentHash = hash(normalizedContent(content));
      if (reset.contentHash && reset.contentHash !== contentHash) throw new Error('Context-reset archive builder returned different content.');
      reset.contentHash = contentHash; reset.phase = 'restoring'; await this.save();
      await assertSafe();
      const restored = await this.#append({ operationId: reset.restoreOperationId, content }, operationId);
      await this.waitForResetIdle();
      await this.sealResetGeneration(reset);
      await assertSafe();
      this.state.retainedGeneration = reset.previous;
      this.state.lastReset = { operationId, previousSessionId: reset.previous.sessionId, sessionId: reset.targetSessionId,
        remoteId: reset.remoteId, bootstrapUuid: restored.uuid, restoreOperationId: reset.restoreOperationId,
        contentHash, recovered: restored.recovered, receipt: reset.receipt };
      this.state.reset = null; await this.save(); completed = true;
      return { ...this.state.lastReset, duplicate: false };
    } finally {
      try {
        // Pending/unknown outcomes remain unexposed. A restored generation may
        // reattach only to the exact previously registered remote identity.
        if (completed && this.connectAfterReset) await this.connect();
      } finally { this.resetBusy = false; }
    }
  }

  async consumeResetEvent(event, keys) {
    const reset = this.state.reset;
    if (!reset || reset.phase !== 'sent') return false;
    if (event.type === 'conversation_reset' && keys.has(reset.clearUuid)) {
      // This is a surface/display identity, never the resumable native ID.
      await this.emit({ type: 'native_event', event }); return true;
    }
    const isReceipt = event.type === 'result' && keys.has(reset.clearUuid);
    const isInit = event.type === 'system' && event.subtype === 'init';
    if (!isReceipt && !isInit) return false;
    // A resumed process can announce its initial identity immediately before
    // the first command. Only the post-clear init confirms the new native ID.
    if (isInit && event.session_id === reset.previous.sessionId && !reset.targetSessionId) return false;
    if (!UUID.test(event.session_id) || event.session_id === reset.previous.sessionId)
      throw new Error('Context clear did not establish a new native session identity.');
    if (isReceipt) {
      if (event.subtype !== 'success' || event.is_error || event.local_command !== 'clear' || event.num_turns !== 0
        || event.duration_api_ms !== 0 || event.total_cost_usd !== 0 || keys.size !== 1)
        throw new Error('Context clear received a querying or ambiguous result.');
      if (reset.targetSessionId && reset.targetSessionId !== event.session_id) throw new Error('Context clear returned conflicting native identities.');
      reset.targetSessionId = event.session_id;
      reset.receipt = { uuid: reset.clearUuid, sessionId: event.session_id, localCommand: 'clear', numTurns: 0, apiMs: 0, cost: 0 };
    } else {
      if (reset.initSessionId && reset.initSessionId !== event.session_id) throw new Error('Context clear returned conflicting init identities.');
      reset.initSessionId = event.session_id;
    }
    if (reset.targetSessionId && reset.initSessionId && reset.targetSessionId !== reset.initSessionId)
      throw new Error('Context clear receipt and native init identities disagree.');
    if (reset.targetSessionId && reset.initSessionId) {
      reset.phase = 'cleared'; this.state.sessionId = reset.targetSessionId;
      this.transcriptPath = sessionPath(this.claudeHome, this.cwd, reset.targetSessionId);
      this.state.lastAppend = null; this.state.imageBindings = {};
    }
    await this.save();
    if (reset.phase === 'cleared') {
      this.resetWaiting?.resolve();
      await this.emit({ type: 'owner_reset_receipt', ...reset.receipt, previousSessionId: reset.previous.sessionId, remoteId: reset.remoteId });
    }
    return true;
  }

  async consume() {
    try {
      for await (const event of this.query) {
        // Even a failed/disconnected native bridge may already have exposed
        // an input route; startup policy overrides never preserve cold status.
        if (event.type === 'system' && event.subtype === 'bridge_state') this.everConnected = true;
        const keys = new Set([event.user_message_uuid, ...(event.user_message_uuids ?? [])].filter(Boolean));
        if (await this.consumeResetEvent(event, keys)) continue;
        if (event.session_id && event.session_id !== this.state.sessionId) {
          // A native fork/reset outside our transaction may still be doing
          // user work. Its old idle level is not authority to terminate it.
          this.nativeState = 'unknown';
          this.identityUncertain = true;
          this.blocked = 'SDK event belongs to another session.';
          this.state.blocked = this.blocked; await this.save();
          this.waiting?.reject(new Error(this.blocked));
          this.resetWaiting?.reject(new Error(this.blocked));
          this.resetIdleWaiting?.reject(new Error(this.blocked));
          await this.emit({ type: 'owner_error', message: this.blocked }); continue;
        }
        if (event.type === 'system' && event.subtype === 'session_state_changed') {
          this.nativeState = event.state;
          // The pinned CLI emits running/idle even for no-query appends and
          // local /clear. Their correlated zero-query receipts still gate the
          // transaction; an owned lifecycle is not external user activity.
          if (event.state !== 'idle' && !this.waiting && !this.resetWaiting) this.activityRevision++;
          if (event.state === 'idle') this.resetIdleWaiting?.resolve();
        }
        if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
          if (!Array.isArray(event.tasks)) {
            this.backgroundTasks = [{ task_id: 'unknown', task_type: 'unknown', description: 'Invalid background task snapshot' }];
            throw new Error('Claude background task membership is unknown.');
          }
          this.backgroundTasks = structuredClone(event.tasks);
          if (event.tasks.length) this.activityRevision++;
        }
        const own = this.state.pending && keys.has(this.state.pending.uuid);
        if (!own && ['user', 'assistant', 'result'].includes(event.type)) this.activityRevision++;
        if (event.type === 'result' && own) {
          // CLI 2.1.281's shouldQuery:false branch fixes turns/API time at
          // zero, but total_cost_usd is the cumulative session cost ledger.
          // A prior real Desktop reply must not make a no-query import fail.
          if (event.subtype !== 'success' || event.is_error || event.num_turns !== 0 || event.duration_api_ms !== 0
            || !Number.isFinite(event.total_cost_usd) || event.total_cost_usd < 0 || keys.size !== 1) {
            this.blocked = 'Bridge append received a querying or ambiguous result; synchronization is paused without stopping user work.';
            this.state.blocked = this.blocked; await this.save();
            this.waiting?.reject(new Error(this.blocked));
            await this.emit({ type: 'owner_error', message: this.blocked });
          } else {
            this.waiting?.resolve();
            await this.emit({ type: 'owner_append_receipt', uuid: this.state.pending.uuid, numTurns: 0, apiMs: 0,
              cumulativeCost: event.total_cost_usd });
          }
        } else {
          // Real Desktop turns are deliberately not rejected for nonzero usage.
          // The SDK owns their queue, tools and permission prompts; this adapter
          // never submits a querying message or interrupts a user's turn.
          if (event.type === 'result' && (event.num_turns > 0 || event.duration_api_ms > 0)) {
            let actualUserTurn = false;
            try {
              const transcript = await this.inspectTranscript();
              actualUserTurn = keys.size > 0 && [...keys].every(id => id !== this.state.lastAppend?.uuid && id !== this.state.pending?.uuid
                && transcript.rows.some(row => row.uuid === id && row.type === 'user' && row.sessionId === this.state.sessionId
                  && !row.isMeta && !row.isSynthetic && !row.isSidechain && row.message?.role === 'user'));
            } catch { /* Unverifiable provenance pauses appends without stopping the native process. */ }
            if (!actualUserTurn) {
              this.blocked = 'A querying result has no verified external user turn; synchronization is paused without stopping user work.';
              this.state.blocked = this.blocked; await this.save();
              this.waiting?.reject(new Error(this.blocked));
              await this.emit({ type: 'owner_error', message: this.blocked });
            }
          }
          await this.emit({ type: 'native_event', event });
        }
      }
      if (!this.closing) {
        this.blocked = 'Claude owner stream ended; synchronization is paused.';
        this.waiting?.reject(new Error(this.blocked));
        this.resetWaiting?.reject(new Error(this.blocked));
        this.resetIdleWaiting?.reject(new Error(this.blocked));
        await this.emit({ type: 'owner_error', message: this.blocked });
      }
    } catch (error) {
      this.blocked = this.state.reset ? `Context-reset stream failed: ${error.message}` : 'Claude owner stream failed; synchronization is paused.';
      if (this.state.reset) { this.state.blocked = this.blocked; await this.save(); }
      this.waiting?.reject(new Error(this.blocked));
      this.resetWaiting?.reject(new Error(this.blocked));
      this.resetIdleWaiting?.reject(new Error(this.blocked));
      await this.emit({ type: 'owner_error', message: this.blocked });
    }
  }

  async close() {
    if (this.closed) return;
    if (this.identityUncertain || this.nativeState !== 'idle' || this.backgroundTasks.length || this.appendBusy || this.resetBusy)
      throw new Error('Claude owner is busy; refusing to interrupt user work.');
    this.closing = true; this.input.end(); this.query.close();
    await this.consumer;
    await this.waitForChildExit();
    await this.lock.release(); this.closed = true;
  }

  async waitForChildExit() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise(resolve => this.child.once('exit', resolve));
    }
  }
}

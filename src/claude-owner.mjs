import { spawn, execFile } from 'node:child_process';
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
  const env = { ...inherited, ...overrides, DISABLE_AUTOUPDATER: '1' };
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

async function acquireLock(path) {
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = await readJSON(path);
    if (alive(old.pid) || old.childPid && alive(old.childPid)) throw new Error('Claude owner is already running; refusing a second writer.');
    // One reaper at a time. A crash during reaping remains explicit, not an
    // invitation to race another process or discard an uncertain live owner.
    const claim = `${path}.reap`;
    try { await link(path, claim); }
    catch { throw new Error('Claude owner recovery is already claimed; inspect the owner lock.'); }
    try {
      const current = await lstat(path), claimed = await lstat(claim);
      if (current.ino !== claimed.ino || current.dev !== claimed.dev) throw new Error('Claude owner lock changed during recovery.');
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
      const current = await readJSON(path);
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
      && typeof block.source.data === 'string' && block.source.data.length > 0
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.source.data)) continue;
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
  static async open(options) {
    const owner = new ClaudeOwner(options);
    await owner.start();
    return owner;
  }

  constructor({ root, conversationId, cwd, claudeHome = join(homedir(), '.claude'), title = 'Claudex conversation',
    queryFactory, sdkVersion, claudeVersion, options = {}, onEvent = () => {}, receiptTimeoutMs = 30_000 }) {
    if (!root || !conversationId || !cwd) throw new Error('Owner root, conversation identity, and working directory are required.');
    if (!Number.isFinite(receiptTimeoutMs) || receiptTimeoutMs <= 0) throw new Error('Invalid append receipt timeout.');
    for (const key of ['sessionId', 'resume', 'continue', 'forkSession', 'resumeSessionAt', 'resumeDropsTurn', 'persistSession', 'spawnClaudeCodeProcess']) {
      if (Object.hasOwn(options, key)) throw new Error(`Owner controls SDK option ${key}.`);
    }
    this.root = resolve(root); this.conversationId = conversationId; this.cwd = resolve(cwd);
    this.claudeHome = resolve(claudeHome); this.title = title; this.options = options;
    this.queryFactory = queryFactory; this.sdkVersion = sdkVersion; this.claudeVersion = claudeVersion;
    this.onEvent = onEvent; this.receiptTimeoutMs = receiptTimeoutMs;
    this.input = inputQueue(); this.closed = false; this.closing = false;
    this.nativeState = 'idle'; this.blocked = null; this.appendBusy = false;
  }

  status() {
    return { sessionId: this.state?.sessionId ?? null, remoteId: this.state?.remoteId ?? null,
      transcriptPath: this.transcriptPath ?? null, pending: this.state?.pending?.operationId ?? null,
      nativeState: this.nativeState, blocked: this.blocked, closed: this.closed };
  }

  async emit(event) {
    try { await this.onEvent(event); }
    catch { this.blocked = 'Owner event consumer failed; synchronization is paused.'; this.waiting?.reject(new Error(this.blocked)); }
  }

  async save() { await writeJSON(this.statePath, this.state); }

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
        this.state = { version: 1, conversationId: this.conversationId, cwd: this.cwd, claudeHome: this.claudeHome,
          sessionId: randomUUID(), remoteId: null, registration: null, pending: null, lastAppend: null };
        await this.save();
      }
      this.transcriptPath = sessionPath(this.claudeHome, this.cwd, this.state.sessionId);
      if (this.state.blocked) throw new Error(this.state.blocked);
      const transcript = await this.inspectTranscript();
      if (!transcript.exists && (this.state.remoteId || this.state.lastAppend || this.state.registration === 'registered')) {
        throw new Error('The owned native transcript is missing; refusing an empty restart of its existing remote identity.');
      }
      const remoteIds = new Set(transcript.rows.filter(row => row.type === 'bridge-session' && row.sessionId === this.state.sessionId)
        .map(row => row.bridgeSessionId));
      if ([...remoteIds].some(id => !REMOTE_ID.test(id)) || remoteIds.size > 1) throw new Error('Native remote identity is invalid or ambiguous.');
      const recoveredId = [...remoteIds][0];
      if (this.state.remoteId && recoveredId && this.state.remoteId !== recoveredId) throw new Error('Native and saved remote identities disagree.');
      if (!this.state.remoteId && recoveredId) { this.state.remoteId = recoveredId; this.state.registration = 'registered'; await this.save(); }
      if (this.state.registration === 'registering' && !this.state.remoteId) throw new Error('Remote registration outcome is unknown; refusing to allocate another remote conversation.');
      if (this.state.pending) await this.reconcilePending(transcript);
      await this.loadRuntime();
      const runtimeEnv = await claudeOwnerEnvironment(this.claudeHome, this.options.env);
      this.query = this.queryFactory({ prompt: this.input, options: {
        settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...this.options, cwd: this.cwd, title: this.title, persistSession: true,
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
      if (this.state.remoteId) await this.connect();
    } catch (error) {
      if (this.query && this.nativeState !== 'idle') {
        this.blocked = 'Owner startup failed while Claude was active; the live session is preserved.';
        await this.emit({ type: 'owner_error', message: this.blocked });
        throw error;
      }
      // Startup has sent no user work. Existing remote work is never interrupted
      // by append/event errors after startup has completed.
      this.input.end();
      this.query?.close();
      if (this.consumer) await this.consumer;
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
      const executable = await resolveClaudeOwnerExecutable(this.options.pathToClaudeCodeExecutable ?? 'claude',
        { ...process.env, ...this.options.env }, this.cwd);
      const version = await execute(executable, ['--version'], { timeout: 10_000, maxBuffer: 4096 });
      this.claudeVersion = version.stdout.trim().split(/\s+/)[0];
      // The SDK must launch the binary just checked, not its bundled binary or
      // a different command found through a later PATH lookup.
      this.options = { ...this.options, pathToClaudeCodeExecutable: executable };
    }
    if (this.sdkVersion !== CLAUDE_OWNER_SDK_VERSION || this.claudeVersion !== CLAUDE_OWNER_CLI_VERSION) throw new Error('Unsupported Claude owner runtime; SDK and native CLI must match the pinned versions.');
  }

  async inspectTranscript() {
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
        expectedHash: pending.contentHash, normalizeContent: normalizedContent });
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

  async connect() {
    if (this.connected) return;
    if (!this.state.remoteId) { this.state.registration = 'registering'; await this.save(); }
    const previous = this.state.remoteId;
    const response = await this.query.enableRemoteControl(true, this.title,
      { keepSessionOnExit: true, ...(previous ? { reattachSessionId: previous } : {}) });
    if (!REMOTE_ID.test(response?.bridge_session_id) || previous && response.bridge_session_id !== previous) {
      this.blocked = 'Remote Control did not preserve the owned conversation identity.';
      throw new Error(this.blocked);
    }
    this.state.remoteId = response.bridge_session_id; this.state.registration = 'registered';
    await this.save(); this.connected = true;
    await this.emit({ type: 'owner_connected', sessionId: this.state.sessionId, remoteId: this.state.remoteId });
  }

  async append({ operationId, content }) {
    if (this.closed || this.closing) throw new Error('Claude owner is closed.');
    if (this.blocked) throw new Error(this.blocked);
    if (this.appendBusy || this.waiting) throw new Error('Another owner append is pending.');
    if (this.nativeState !== 'idle') throw new Error('Claude is working or waiting for user action; append postponed.');
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256) throw new Error('A bounded logical append identity is required.');
    validateContent(content);
    content = typeof content === 'string' ? content : normalizedContent(content);
    this.appendBusy = true;
    try {
      const contentHash = hash(normalizedContent(content));
      if (this.state.lastAppend?.operationId === operationId) {
        if (this.state.lastAppend.contentHash !== contentHash) throw new Error('Logical append identity was reused with different content.');
        if (!await this.findAppend(await this.inspectTranscript(), this.state.lastAppend)) throw new Error('Previously committed owner append is missing.');
        await this.connect();
        return { ...this.state.lastAppend, ...this.status(), duplicate: true };
      }
      if (this.state.pending && (this.state.pending.operationId !== operationId || this.state.pending.contentHash !== contentHash)) throw new Error('A different durable owner append must be resolved first.');
      if (!this.state.pending) {
        this.state.pending = { operationId, uuid: appendUuid(this.state.sessionId, operationId), contentHash, content, phase: 'prepared' };
        await this.save();
      }
      if (await this.reconcilePending()) { await this.connect(); return { ...this.state.lastAppend, ...this.status(), duplicate: true }; }
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
      await this.connect();
      return { ...this.state.lastAppend, ...this.status(), duplicate: false };
    } finally { this.appendBusy = false; }
  }

  async consume() {
    try {
      for await (const event of this.query) {
        if (event.session_id && event.session_id !== this.state.sessionId) {
          this.blocked = 'SDK event belongs to another session.';
          this.state.blocked = this.blocked; await this.save();
          this.waiting?.reject(new Error(this.blocked));
          await this.emit({ type: 'owner_error', message: this.blocked }); continue;
        }
        if (event.type === 'system' && event.subtype === 'session_state_changed') this.nativeState = event.state;
        const keys = new Set([event.user_message_uuid, ...(event.user_message_uuids ?? [])].filter(Boolean));
        const own = this.state.pending && keys.has(this.state.pending.uuid);
        if (event.type === 'result' && own) {
          if (event.subtype !== 'success' || event.is_error || event.num_turns !== 0 || event.duration_api_ms !== 0 || event.total_cost_usd !== 0 || keys.size !== 1) {
            this.blocked = 'Bridge append received a querying or ambiguous result; synchronization is paused without stopping user work.';
            this.state.blocked = this.blocked; await this.save();
            this.waiting?.reject(new Error(this.blocked));
            await this.emit({ type: 'owner_error', message: this.blocked });
          } else {
            this.waiting?.resolve();
            await this.emit({ type: 'owner_append_receipt', uuid: this.state.pending.uuid, numTurns: 0, apiMs: 0, cost: 0 });
          }
        } else {
          // Real Desktop turns are deliberately not rejected for nonzero usage.
          // The SDK owns their queue, tools and permission prompts; this adapter
          // never submits a querying message or interrupts a user's turn.
          if (event.type === 'result' && (event.num_turns > 0 || event.duration_api_ms > 0 || event.total_cost_usd > 0)) {
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
        await this.emit({ type: 'owner_error', message: this.blocked });
      }
    } catch {
      this.blocked = 'Claude owner stream failed; synchronization is paused.';
      this.waiting?.reject(new Error(this.blocked));
      await this.emit({ type: 'owner_error', message: this.blocked });
    }
  }

  async close() {
    if (this.closed) return;
    if (this.nativeState !== 'idle' || this.appendBusy) throw new Error('Claude owner is busy; refusing to interrupt user work.');
    this.closing = true; this.input.end(); this.query.close();
    await this.consumer;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise(resolve => this.child.once('exit', resolve));
    }
    await this.lock.release(); this.closed = true;
  }
}

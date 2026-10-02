import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { privateDirectory, readJSON, writeJSON, publishExclusive } from './storage.mjs';
import { readFile } from 'node:fs/promises';
import { validateCollaborationEffort } from './collaboration-effort.mjs';
import { resolveCollaborationWorkspace, revalidateWorkspace, workspacesConflict } from './collaboration-workspace.mjs';
import { ChatMailbox } from './chat-mailbox.mjs';
import { dispatchModWake } from './mod-wake-broker.mjs';
import { enrichChatTitles } from './chat-titles.mjs';
import { validateClaudeOwnerWakeRequest } from './claude-owner-wake.mjs';
import { inspectOwnedProcesses, validateOwnedProcesses } from './collaboration-processes.mjs';

const providers = ['codex', 'claude'];
const terminal = new Set(['completed', 'failed', 'cancelled', 'uncertain']);
const digest = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const copy = value => structuredClone(value);
function text(value, name, limit = 16384) {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > limit || value.includes('\0'))
    throw new Error(`${name} must be nonempty text of at most ${limit} bytes.`);
  return value;
}
function provider(value) {
  if (!providers.includes(value)) throw new Error('Provider must be codex or claude.');
  return value;
}
function model(value) {
  if (value === null) return null;
  text(value, 'model', 200);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value) || value !== value.trim())
    throw new Error('model must not contain control characters or surrounding whitespace.');
  return value;
}
function defaultModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !providers.every(name => Object.hasOwn(value, name)))
    throw new Error('defaultModels must specify codex and claude, each as a model or null.');
  return Object.fromEntries(providers.map(name => [name, value[name] === null ? null : model(value[name])]));
}
function defaultEfforts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !providers.every(name => Object.hasOwn(value, name)))
    throw new Error('defaultEfforts must specify codex and claude, each as an effort or null.');
  return Object.fromEntries(providers.map(name => [name, validateCollaborationEffort(name, value[name])]));
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error('A stable requestId is required.');
  return value;
}
// Ordered from least to most authority. full-access runs native tools without a
// sandbox or permission prompts, by explicit controller choice.
export const COLLABORATION_PERMISSIONS = ['read-only', 'workspace-write', 'full-access'];
const permissionRank = value => COLLABORATION_PERMISSIONS.indexOf(value);
const AUTO_RESOLVE_INTERVAL_MS = 30_000;

const USAGE_FIELDS = ['inputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];

// Native token accounting is optional evidence: an invalid report is dropped, never
// allowed to change a task outcome.
function recordedUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const recorded = {};
  for (const key of USAGE_FIELDS) {
    if (usage[key] === undefined && key === 'reasoningOutputTokens') continue;
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) return null;
    recorded[key] = usage[key];
  }
  if (usage.reportedCostUsd !== undefined) {
    if (typeof usage.reportedCostUsd !== 'number' || !Number.isFinite(usage.reportedCostUsd) || usage.reportedCostUsd < 0) return null;
    recorded.reportedCostUsd = usage.reportedCostUsd;
  }
  return recorded;
}

function addUsage(task, provider, usage) {
  task.usageTotals ??= {};
  const total = task.usageTotals[provider] ??= { invocations: 0 };
  total.invocations++;
  for (const [key, value] of Object.entries(usage)) {
    const sum = (total[key] ?? 0) + value;
    if (key === 'reportedCostUsd' ? Number.isFinite(sum) : Number.isSafeInteger(sum)) total[key] = sum;
  }
}

function publicTask(task) {
  const result = copy(task);
  if (result.active) delete result.active.tokenHash;
  Object.assign(result, taskPresentation(task));
  return result;
}

function taskPresentation(task) {
  const cancelPending = task.status === 'running' && task.cancelRequested;
  const phase = terminal.has(task.status) ? task.status : cancelPending ? 'cancelling' : task.pendingHandoff ? 'handoff-pending'
    : task.status === 'waiting' ? 'waiting-for-children' : task.status === 'ready' ? 'queued' : task.status;
  const resultFinal = task.status === 'completed' && Boolean(task.result) && task.result.generation === task.generation;
  const resultRole = !task.result ? 'none' : resultFinal ? 'final' : task.status === 'cancelled' ? 'cancelled'
    : task.result.generation === task.generation && (task.status === 'waiting'
      || task.status === 'ready' && (task.lastExecution?.boundary === true || task.owner !== task.result.provider)) ? 'boundary' : 'superseded';
  return { phase, terminal: terminal.has(task.status), cancelPending: Boolean(cancelPending), resultFinal,
    resultRole, resultGeneration: task.result?.generation ?? null };
}

// Signal zero observes existence only. Both the recorded leader and its detached
// group must be gone; permission failures cannot establish that fact.
function inspectExitedProcessGroup(pid) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Process-group inspection is unsupported on this platform.');
  const absent = target => {
    try { process.kill(target, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  };
  return { pid, processAbsent: absent(pid), groupAbsent: absent(-pid), inspectedAt: Date.now() };
}

/** A single durable work graph. Delegation adds an edge; handoff changes its owner. */
export class CollaborationHub extends EventEmitter {
  constructor({ root, run, mcp, allowWrite = false, allowFullAccess = false, defaultPermission = 'read-only', maxWorkers = 64, maxDepth = 3,
    maxSteps = 12, maxTasks = 1000, maxRequests = 10000, maxStateBytes = 32 * 1024 * 1024,
    inspectProcessGroup = inspectExitedProcessGroup, inspectProcesses = inspectOwnedProcesses, chatTitleResolver = enrichChatTitles,
    nativeChatDiscovery = null, chatWake = null, claudeWakeManifest = null, claudeOwnerWake = null } = {}) {
    super();
    // Bounded socket waiters can legitimately exceed EventEmitter's default ten.
    this.setMaxListeners(136);
    if (!isAbsolute(root ?? '') || typeof run !== 'function') throw new Error('Absolute root and native runner are required.');
    if (typeof inspectProcessGroup !== 'function') throw new Error('Process-group inspector must be a function.');
    if (typeof inspectProcesses !== 'function') throw new Error('Owned-process inspector must be a function.');
    if (permissionRank(defaultPermission) < 0
      || permissionRank(defaultPermission) > (allowFullAccess ? 2 : allowWrite ? 1 : 0)) throw new Error('Default permission exceeds broker authorization.');
    for (const [name, value, max] of [['maxWorkers', maxWorkers, 64], ['maxDepth', maxDepth, 8],
      ['maxSteps', maxSteps, 100], ['maxTasks', maxTasks, 10000], ['maxRequests', maxRequests, 100000],
      ['maxStateBytes', maxStateBytes, 128 * 1024 * 1024]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}.`);
    }
    Object.assign(this, { root, run, mcp, allowWrite: allowWrite || allowFullAccess, allowFullAccess, defaultPermission, maxWorkers, maxDepth, maxSteps, maxTasks, maxRequests, maxStateBytes, inspectProcessGroup, inspectProcesses });
    this.serial = Promise.resolve(); this.running = new Map(); this.closed = false; this.pumping = false;
    this.chatMailbox = new ChatMailbox({ root: join(root, 'chat-mailbox') });
    this.chatTitleResolver = chatTitleResolver;
    this.nativeChatDiscovery = nativeChatDiscovery;
    this.chatWake = chatWake;
    this.claudeWakeManifest = claudeWakeManifest;
    this.claudeOwnerWake = claudeOwnerWake;
    this.modWaiters = 0;
    this.modReads = new Set();
  }

  // The controller's saved default is its explicit authorization for that level;
  // installation flags remain the floor of what the broker accepts.
  effectiveDefaultPermission(state = this.state) { return state.defaultPermission ?? this.defaultPermission; }

  permissionCeiling(state = this.state) {
    return Math.max(this.allowFullAccess ? 2 : this.allowWrite ? 1 : 0, permissionRank(this.effectiveDefaultPermission(state)));
  }

  checkPermission(permission, parent, state = this.state) {
    if (permissionRank(permission) < 0) throw new Error('Unsupported permission.');
    if (permissionRank(permission) > this.permissionCeiling(state)
      || parent && permissionRank(permission) > permissionRank(parent.permission))
      throw new Error(permission === 'full-access' ? 'Full access is not authorized by the broker or parent.'
        : 'Workspace writes are not authorized by the broker or parent.');
  }

  async initialize() {
    this.root = await privateDirectory(this.root);
    const info = await lstat(this.root);
    if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('Collaboration root must be owner-private (0700).');
    const keyPath = join(this.root, 'controller-key');
    try { await lstat(keyPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await publishExclusive(keyPath, randomBytes(32).toString('hex') + '\n');
    }
    const keyInfo = await lstat(keyPath);
    if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || keyInfo.uid !== process.getuid()
      || keyInfo.nlink !== 1 || (keyInfo.mode & 0o777) !== 0o600 || keyInfo.size !== 65) throw new Error('Unsafe controller key.');
    this.controllerToken = (await readFile(keyPath, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(this.controllerToken)) throw new Error('Malformed controller key.');
    this.path = join(this.root, 'work.json');
    try {
      const file = await lstat(this.path);
      if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || file.nlink !== 1
        || (file.mode & 0o777) !== 0o600 || file.size > this.maxStateBytes) throw new Error('Unsafe collaboration ledger.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.state = await readJSON(this.path, { version: 1, tasks: {}, requests: {} });
    this.serializedState = JSON.stringify(this.state);
    if (this.state?.version !== 1 || !this.state.tasks || !this.state.requests
      || Array.isArray(this.state.tasks) || Array.isArray(this.state.requests)) throw new Error('Unsupported collaboration ledger.');
    if (Object.hasOwn(this.state, 'defaultModels')) defaultModels(this.state.defaultModels);
    if (Object.hasOwn(this.state, 'defaultEfforts')) defaultEfforts(this.state.defaultEfforts);
    if (this.state.nativeWakeRoute !== undefined && !['mod', 'renderer'].includes(this.state.nativeWakeRoute))
      throw new Error('Malformed Claude native wake route.');
    if (Object.hasOwn(this.state, 'defaultPermission') && permissionRank(this.state.defaultPermission) < 0)
      throw new Error('Malformed default collaboration permission.');
    for (const [id, task] of Object.entries(this.state.tasks)) {
      for (const execution of [task.active, task.lastExecution]) if (execution?.ownedProcesses !== undefined)
        validateOwnedProcesses(execution.ownedProcesses);
      if (task.projectRoot !== undefined && (!isAbsolute(task.projectRoot) || task.cwd !== task.projectRoot)
        || ['readOnlyDirs', 'writableDirs'].some(key => task[key] !== undefined
          && (!Array.isArray(task[key]) || task[key].length > 16 || task[key].some(path => typeof path !== 'string' || !isAbsolute(path)))))
        throw new Error('Malformed collaboration workspace scope.');
      if (task.model !== null && task.model !== undefined) model(task.model);
      if (Object.hasOwn(task, 'effort')) validateCollaborationEffort(task.owner, task.effort);
      if (task.pendingHandoff) {
        provider(task.pendingHandoff.provider);
        if (task.pendingHandoff.model !== null && task.pendingHandoff.model !== undefined) model(task.pendingHandoff.model);
        if (Object.hasOwn(task.pendingHandoff, 'effort')) validateCollaborationEffort(task.pendingHandoff.provider, task.pendingHandoff.effort);
      }
      if (id !== task.id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
        || !providers.includes(task.owner) || !['ready', 'running', 'waiting', ...terminal].includes(task.status)
        || !Array.isArray(task.messages) || !Number.isSafeInteger(task.revision) || task.revision < 1 || !isAbsolute(task.cwd ?? '')
        || !Number.isSafeInteger(task.depth) || task.depth < 0 || !Number.isSafeInteger(task.generation) || task.generation < 0
        || (task.parentId !== null && this.state.tasks[task.parentId]?.depth !== task.depth - 1)
        || (task.parentId === null && task.depth !== 0)
        || task.messages.some(message => !message || typeof message.text !== 'string' || typeof message.kind !== 'string')
        || (task.status === 'running' && (!task.active || !/^[a-f0-9]{64}$/.test(task.active.tokenHash ?? '')
          || task.active.generation !== task.generation || !Number.isSafeInteger(task.active.messageCount)))
        || permissionRank(task.permission) < 0) throw new Error('Malformed collaboration task.');
    }
    await this.mutate(state => {
      state.defaultModels ??= { codex: null, claude: null };
      state.defaultEfforts ??= { codex: null, claude: null };
      for (const task of Object.values(state.tasks)) {
        task.effort ??= null;
        if (task.pendingHandoff) task.pendingHandoff.effort ??= null;
        if (task.status === 'running') {
          task.status = 'uncertain'; task.error = 'Broker stopped during native execution. No automatic replay or ownership transfer is allowed.';
          task.revision++; task.updatedAt = Date.now();
        }
      }
    });
    await this.autoResolveUncertain();
    // Proof failures are expected while processes still run; the next pass rechecks.
    this.autoResolveTimer = setInterval(() => {
      this.autoResolveUncertain().then(count => { if (count) this.schedule(); }, () => {});
    }, AUTO_RESOLVE_INTERVAL_MS);
    this.autoResolveTimer.unref?.();
    return this;
  }

  /** Shared evidence that an uncertain invocation and everything it recorded exited.
   * Throws with the specific missing proof; never replays or edits work. */
  async exitProof(state, task, { inventoryAttested = false } = {}) {
    const descendants = Object.values(state.tasks).filter(candidate => {
      let cursor = candidate;
      while (cursor) { if (cursor.id === task.id) return true; cursor = state.tasks[cursor.parentId]; }
      return false;
    });
    if (descendants.some(candidate => this.running.has(candidate.id))) throw new Error('An in-memory native worker is still active.');
    if (descendants.some(candidate => candidate.id !== task.id && !['completed', 'failed', 'cancelled'].includes(candidate.status)))
      throw new Error('Resolve or finish descendant work first.');
    // A crash can leave a newer active generation beside an older receipt.
    // Only the newest invocation's identity can prove that its work stopped.
    const execution = task.active ?? task.lastExecution;
    const pid = execution?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1 || execution?.generation !== task.generation)
      throw new Error('Recorded native process identity is missing or ambiguous.');
    if (execution.processInventoryRequired && !execution.ownedProcesses)
      throw new Error('Recorded native descendant identities are missing; process absence cannot be established.');
    if (execution.processInventoryError && !inventoryAttested)
      throw new Error('Recorded native process inventory is incomplete; descendant absence cannot be established.');
    let ownedProcessInspection;
    if (execution.ownedProcesses) {
      ownedProcessInspection = await this.inspectProcesses(execution.ownedProcesses);
      if (!Array.isArray(ownedProcessInspection?.processes)
        || ownedProcessInspection.processes.length !== execution.ownedProcesses.length
        || !Number.isSafeInteger(ownedProcessInspection.inspectedAt) || ownedProcessInspection.inspectedAt <= 0
        || ownedProcessInspection.processes.some((record, index) => record.absent !== true
          || ['pid', 'ppid', 'pgid', 'uid', 'startedAt'].some(key => record[key] !== execution.ownedProcesses[index][key])))
        throw new Error('Recorded native descendants must all be confirmed absent.');
    }
    const proof = await this.inspectProcessGroup(pid);
    if (proof?.pid !== pid || proof.processAbsent !== true || proof.groupAbsent !== true
      || !Number.isSafeInteger(proof.inspectedAt) || proof.inspectedAt <= 0)
      throw new Error('Recorded native process and process group must both be confirmed absent.');
    return { pid, proof, ownedProcessInspection };
  }

  /** Close uncertain work as failed once every recorded process is proven gone.
   * Nothing is replayed; writable work is flagged for review instead of blocking. */
  async autoResolveUncertain() {
    if (this.closed || !Object.values(this.state.tasks).some(task => task.status === 'uncertain')) return 0;
    const resolved = await this.mutate(async state => {
      let count = 0;
      for (let changed = true; changed;) {
        changed = false;
        // Deepest first so a parent can follow its resolved children in one pass.
        const uncertain = Object.values(state.tasks).filter(task => task.status === 'uncertain').sort((a, b) => b.depth - a.depth);
        for (const task of uncertain) {
          let evidence;
          try { evidence = await this.exitProof(state, task); } catch { continue; }
          task.resolution = { outcome: 'failed', automatic: true,
            reason: 'Every recorded native process was confirmed exited after an unknown outcome. Nothing was replayed.',
            previousStatus: task.status, previousError: task.error, previousRevision: task.revision,
            inspectedAt: evidence.proof.inspectedAt, pid: evidence.pid, processAbsent: true, groupAbsent: true, resolvedAt: Date.now(),
            ...(evidence.ownedProcessInspection ? { ownedProcessInspection: evidence.ownedProcessInspection } : {}),
            ...(task.permission !== 'read-only' ? { workspaceReviewRecommended: true } : {}) };
          task.status = 'failed';
          task.error = task.permission === 'read-only' ? task.error
            : `${task.error ?? 'Native execution outcome was unknown.'} Its workspace may contain partial changes; review them before relying on it.`.slice(0, 2048);
          task.revision++; task.updatedAt = Date.now();
          this.deliverToParent(state, task);
          count++; changed = true;
        }
      }
      return count;
    });
    return resolved;
  }

  /** Unknown work blocks only its own task tree and work that shares its access. */
  blockedByUncertain(state, candidate) {
    const root = task => { let cursor = task; while (cursor?.parentId && state.tasks[cursor.parentId]) cursor = state.tasks[cursor.parentId]; return cursor?.id; };
    return Object.values(state.tasks).some(task => task.status === 'uncertain'
      && (root(task) === root(candidate) || task.permission !== 'read-only' && workspacesConflict(task, candidate)));
  }

  serialized(fn) {
    const operation = this.serial.then(fn);
    this.serial = operation.catch(() => {});
    return operation;
  }

  mutate(fn) { return this.serialized(() => this.commit(fn)); }

  // Runs only inside the serialized journal chain. The committed state is never
  // mutated in place, so its compact serialization is kept for change detection
  // and the capacity check instead of re-serializing it on every transaction.
  async commit(fn) {
    const state = copy(this.state);
    const value = await fn(state);
    const serialized = JSON.stringify(state);
    if (serialized === this.serializedState) return value;
    if (Buffer.byteLength(serialized) > this.maxStateBytes) throw new Error('Collaboration ledger capacity reached; no history was discarded.');
    await writeJSON(this.path, state);
    this.state = state; this.serializedState = serialized; this.emit('change');
    return value;
  }

  actor({ peer, token }, state = this.state) {
    provider(peer);
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid worker capability.');
    const tokenHash = digest(token);
    if (tokenHash === digest(this.controllerToken)) return { peer, task: null, key: `controller:${peer}` };
    const task = Object.values(state.tasks).find(item => item.status === 'running' && item.owner === peer && item.active?.tokenHash === tokenHash);
    if (!task) throw new Error('Worker capability expired or does not match its owner.');
    return { peer, task, key: `worker:${task.id}:${task.active.generation}` };
  }

  allowed(actor, task, state) {
    if (!task) throw new Error('Unknown task.');
    if (!actor.task) return;
    let cursor = task;
    while (cursor) {
      if (cursor.id === actor.task.id) return;
      cursor = state.tasks[cursor.parentId];
    }
    throw new Error('Worker may only access its own task and descendants.');
  }

  async dispatch(envelope) {
    if (!envelope || !envelope.params || typeof envelope.params !== 'object' || Array.isArray(envelope.params)) throw new Error('Invalid protocol envelope.');
    const { method, params } = envelope;
    const actor = this.actor(envelope);
    if (method === 'native_wake' || method.startsWith('mod_wake_')) return dispatchModWake(this, envelope, actor);
    if (method === 'desktop_owner_wake') {
      if (actor.task || actor.peer !== 'claude' || !this.claudeOwnerWake || this.closed)
        throw new Error('Native Desktop owner wake endpoint is unavailable.');
      validateClaudeOwnerWakeRequest(params);
      return this.claudeOwnerWake(params);
    }
    if (['desktop_wake_claim', 'desktop_wake_receipt'].includes(method)) {
      if (actor.task || actor.peer !== 'claude' || !this.claudeWakeManifest) throw new Error('Native Desktop wake endpoint is unavailable.');
      const message = await this.chatMailbox.status(params.messageId);
      if (message.wakeRoute === 'mod') throw new Error('This message belongs to the native Mod route.');
      if (message.targetProvider !== 'claude' || message.targetSessionId !== params.sessionId || message.wakeRequested !== true)
        throw new Error('Desktop wake identity or authorization mismatch.');
      if (method === 'desktop_wake_receipt') {
        if (!['accepted', 'uncertain'].includes(params.status)) throw new Error('Invalid Desktop wake receipt.');
        const result = await this.chatMailbox.finishWake(params.messageId, { claimId: params.claimId, state: params.status, detail: params.detail });
        await this.claudeWakeManifest.publish(this.chatMailbox);
        return result;
      }
      if (this.closed) throw new Error('Broker is stopping.');
      await this.claudeWakeManifest.verify(params.sessionId);
      const claim = await this.chatMailbox.claimWake(params.messageId, { route: 'renderer' });
      if (!claim) return { claimed: false };
      return { claimed: true, messageId: claim.messageId, claimId: claim.wake.claimId, context: claim.context };
    }
    if (['chat_list', 'chat_send', 'chat_status'].includes(method)) {
      if (actor.task) throw new Error('Only an external controller may coordinate native chats.');
      if (method === 'chat_list') {
        const limit = params.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
          || params.cursor !== undefined && (typeof params.cursor !== 'string' || !/^\d{1,4}$/.test(params.cursor)))
          throw new Error('Invalid native chat page bounds.');
        if (params.provider !== undefined) provider(params.provider);
        if (params.match !== undefined && !['exact', 'contains'].includes(params.match)) throw new Error('Invalid title match mode.');
        const normalize = value => value.normalize('NFC').trim().toLowerCase();
        const nativeQuery = params.query === undefined ? null : text(params.query, 'title query', 4096).trim();
        const query = nativeQuery === null ? null : normalize(nativeQuery);
        const registered = (await this.chatMailbox.list()).filter(chat => params.provider === undefined || chat.provider === params.provider);
        let titled = await this.chatTitleResolver(registered);
        if (query && this.nativeChatDiscovery && params.provider !== 'claude') {
          const discovered = await this.nativeChatDiscovery({ query: nativeQuery });
          const known = new Map(titled.map(chat => [chat.chatId, chat]));
          for (const chat of discovered) {
            const previous = known.get(chat.chatId);
            known.set(chat.chatId, previous ? { ...chat, phase: previous.phase, lastSeenAt: previous.lastSeenAt,
              registeredByHook: previous.registeredByHook ?? true } : chat);
          }
          titled = [...known.values()];
        }
        const all = titled.map(chat => ({ ...chat, titleMatch: query && typeof chat.title === 'string'
          ? normalize(chat.title) === query ? 'exact' : normalize(chat.title).includes(query) ? 'contains' : null : null }))
          .filter(chat => query === null || chat.titleMatch === 'exact' || params.match !== 'exact' && chat.titleMatch === 'contains');
        const start = Number(params.cursor ?? 0);
        const chats = []; let next = start, size = 0;
        while (next < all.length && chats.length < limit) {
          const item = all[next], length = bytes(item);
          if (size + length > 512 * 1024) break;
          chats.push(item); size += length; next++;
        }
        return { chats, nextCursor: next < all.length ? String(next) : null, totalCount: all.length,
          unavailableTitleCount: titled.filter(chat => !chat.title || chat.titleError).length,
          exactMatchCount: query === null ? null : all.filter(chat => chat.titleMatch === 'exact').length,
          deliveryMode: this.chatWake || this.claudeWakeManifest ? 'native-owner-or-hook' : 'next-native-hook',
          idleWakeSupported: Boolean(this.chatWake || this.claudeWakeManifest),
          wakeProviders: { codex: Boolean(this.chatWake), claude: Boolean(this.claudeWakeManifest) },
          scope: query && this.nativeChatDiscovery ? 'registered-and-native-metadata' : 'hook-registered-native-chats',
          note: 'Titles are metadata, not unique IDs. Confirm the exact candidate when duplicate or partial titles match; send by sessionId with expectedTitle.' };
      }
      if (method === 'chat_status') return this.chatMailbox.status(params.messageId);
      if (this.closed) throw new Error('Broker is stopping; new messages are refused.');
      requestId(params.requestId);
      if (params.wake !== undefined && typeof params.wake !== 'boolean') throw new Error('wake must be boolean.');
      let targetProvider = params.provider, targetSessionId = params.sessionId, expectedTitle = params.expectedTitle;
      let nativeTarget;
      if (params.title !== undefined) {
        if (targetSessionId !== undefined || expectedTitle !== undefined) throw new Error('Use title or sessionId/expectedTitle, not both.');
        if (targetProvider !== undefined) provider(targetProvider);
        const normalize = value => value.normalize('NFC').trim().toLowerCase();
        const title = normalize(text(params.title, 'recipient title', 4096));
        let titled = await this.chatTitleResolver((await this.chatMailbox.list())
          .filter(chat => targetProvider === undefined || chat.provider === targetProvider));
        if (this.nativeChatDiscovery && targetProvider !== 'claude') {
          const discovered = await this.nativeChatDiscovery({ query: params.title });
          const known = new Map(titled.map(chat => [chat.chatId, chat]));
          for (const chat of discovered) known.set(chat.chatId, { ...known.get(chat.chatId), ...chat });
          titled = [...known.values()];
        }
        const candidates = titled
          .filter(chat => !chat.titleError && !chat.archived && typeof chat.title === 'string' && normalize(chat.title) === title);
        if (candidates.length !== 1) return { status: candidates.length ? 'needs-selection' : 'not-found', queued: false,
          candidates: candidates.map(({ provider, sessionId, title, cwd, phase }) => ({ provider, sessionId, title, cwd, phase })),
          note: candidates.length ? 'Several chats have this title. Confirm the exact recipient; no message was queued.'
            : 'No registered chat has this exact title. Search chat_list; no message was queued.' };
        ({ provider: targetProvider, sessionId: targetSessionId, title: expectedTitle } = candidates[0]);
      }
      if (this.nativeChatDiscovery && targetProvider === 'codex') {
        [nativeTarget] = (await this.nativeChatDiscovery({ sessionId: targetSessionId }))
          .filter(chat => chat.sessionId === targetSessionId);
        if (!nativeTarget) throw new Error('Exact native chat is unavailable or archived; no message was queued.');
      }
      if (expectedTitle !== undefined) {
        text(expectedTitle, 'expected title', 4096);
        const exact = (await this.chatMailbox.list()).filter(chat => chat.provider === targetProvider && chat.sessionId === targetSessionId);
        const [current] = nativeTarget ? [nativeTarget] : await this.chatTitleResolver(exact);
        if (!current || current.titleError || current.archived || current.title !== expectedTitle)
          throw new Error('Native chat title changed or could not be verified. Search again; no message was queued.');
      }
      if (nativeTarget) await this.chatMailbox.discover(nativeTarget);
      let receipt = await this.chatMailbox.send({ fromProvider: actor.peer, targetProvider,
        targetSessionId, message: params.message, requestId: params.requestId, wakeRequested: params.wake !== false,
        ...(targetProvider === 'claude' && params.wake !== false ? { wakeRoute: this.state.nativeWakeRoute ?? 'renderer' } : {}),
        ...(params.expiresInMs === undefined ? {} : { expiresInMs: params.expiresInMs }) });
      let wakeStatus = params.wake === false ? 'disabled' : 'unavailable';
      if (receipt.wakeRoute === 'mod' && receipt.state === 'queued') { wakeStatus = 'waiting-for-mod'; this.emit('chat-wake'); }
      if (params.wake !== false && targetProvider === 'claude' && receipt.wakeRoute !== 'mod' && this.claudeWakeManifest && receipt.state === 'queued') {
        try { await this.claudeWakeManifest.publish(this.chatMailbox); wakeStatus = 'waiting-for-desktop'; }
        catch { wakeStatus = 'unavailable'; }
      }
      if (params.wake !== false && targetProvider === 'codex' && this.chatWake && receipt.state === 'queued') {
        let handle;
        try {
          handle = await this.chatWake({ sessionId: targetSessionId });
          wakeStatus = handle.status;
          if (handle.status === 'ready') {
            const claim = await this.chatMailbox.claimWake(receipt.messageId);
            if (claim) {
              let outcome;
              try { outcome = await handle.dispatch({ messageId: claim.messageId, text: claim.context }); }
              catch { outcome = { status: 'uncertain' }; }
              wakeStatus = outcome.status;
              receipt = await this.chatMailbox.finishWake(claim.messageId, {
                claimId: claim.wake.claimId,
                state: outcome.status === 'accepted' ? 'accepted' : ['busy', 'unavailable'].includes(outcome.status) ? 'deferred' : 'uncertain',
                detail: outcome.status === 'accepted' ? `Native owner accepted turn ${outcome.turnId}; hook acknowledgement is separate.`
                  : ['busy', 'unavailable'].includes(outcome.status) ? 'Native owner refused before input dispatch; waiting for a native hook.'
                    : 'Native dispatch outcome is uncertain; no automatic resend is permitted.',
              });
            } else receipt = await this.chatMailbox.status(receipt.messageId);
          }
        } catch (error) {
          // Before a claim this is mere unavailability; after a claim preserve uncertainty.
          receipt = await this.chatMailbox.status(receipt.messageId);
          wakeStatus = receipt.wake?.state === 'dispatching' ? 'uncertain' : 'unavailable';
        } finally { await handle?.close?.(); }
      }
      return { ...receipt, wakeStatus,
        deliveryMode: receipt.wake?.state === 'accepted' ? 'native-owner' : 'next-native-hook',
        idleWakeSupported: targetProvider === 'codex' ? Boolean(this.chatWake) : Boolean(this.claudeWakeManifest),
        note: 'Queued is not delivered. Offered is not acknowledged. Acknowledgement does not prove requested work stopped; verify work status separately.' };
    }
    if (method === 'models') {
      if (actor.task) throw new Error('Only the controller may manage default models.');
      if (Object.keys(params).some(key => !['defaultModels', 'defaultEfforts', 'defaultPermission'].includes(key))) throw new Error('Invalid model settings parameters.');
      const updatePermission = Object.hasOwn(params, 'defaultPermission');
      if (updatePermission && permissionRank(params.defaultPermission) < 0) throw new Error('defaultPermission must be read-only, workspace-write or full-access.');
      const update = Object.hasOwn(params, 'defaultModels');
      const selected = update ? defaultModels(params.defaultModels) : null;
      const updateEfforts = Object.hasOwn(params, 'defaultEfforts');
      const selectedEfforts = updateEfforts ? defaultEfforts(params.defaultEfforts) : null;
      if ((update || updateEfforts || updatePermission) && this.closed) throw new Error('Broker is stopping; new mutations are refused.');
      return this.mutate(state => {
        if (this.actor(envelope, state).task) throw new Error('Only the controller may manage default models.');
        if (update) state.defaultModels = selected;
        if (updateEfforts) state.defaultEfforts = selectedEfforts;
        if (updatePermission) state.defaultPermission = params.defaultPermission;
        return { defaultModels: copy(state.defaultModels), defaultEfforts: copy(state.defaultEfforts),
          defaultPermission: this.effectiveDefaultPermission(state) };
      });
    }
    if (method === 'status') {
      return this.readTask(envelope);
    }
    if (method === 'list') {
      const tasks = Object.values(this.state.tasks).filter(task => {
        try { this.allowed(actor, task, this.state); return true; } catch { return false; }
      });
      return { tasks: tasks.map(task => ({ id: task.id, parentId: task.parentId, owner: task.owner, status: task.status,
        revision: task.revision, updatedAt: task.updatedAt, ...taskPresentation(task) })),
        limits: { maxWorkers: this.maxWorkers, maxDepth: this.maxDepth, maxSteps: this.maxSteps, allowWrite: this.permissionCeiling() >= 1,
          allowFullAccess: this.permissionCeiling() >= 2, defaultPermission: this.effectiveDefaultPermission(),
          defaultModels: copy(this.state.defaultModels), defaultEfforts: copy(this.state.defaultEfforts), allProjects: true },
        blockedByUncertainWork: Object.values(this.state.tasks).some(task => task.status === 'uncertain'),
        uncertainTasks: Object.values(this.state.tasks).filter(task => task.status === 'uncertain').slice(0, 20)
          .map(task => ({ id: task.id, owner: task.owner, permission: task.permission, cwd: task.cwd, error: task.error,
            revision: task.revision, updatedAt: task.updatedAt })) };
    }
    if (method === 'wait') {
      if (params.view !== undefined && !['full', 'summary'].includes(params.view)) throw new Error('Invalid task view.');
      this.allowed(actor, this.state.tasks[params.taskId], this.state);
      if (actor.task?.id === params.taskId) throw new Error('A worker cannot wait on its own running task. Finish the native turn instead.');
      const timeoutMs = params.timeoutMs ?? 30000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000
        || params.afterRevision !== undefined && (!Number.isSafeInteger(params.afterRevision) || params.afterRevision < 0)) throw new Error('Invalid wait bounds.');
      const current = this.state.tasks[params.taskId];
      const baseline = params.afterRevision ?? current.revision;
      const signal = envelope.signal;
      let timedOut = false;
      const ready = () => terminal.has(this.state.tasks[params.taskId].status)
        || this.state.tasks[params.taskId].revision > (params.afterRevision ?? current.revision);
      if (!ready() && timeoutMs) await new Promise(resolve => {
        const done = () => {
          clearTimeout(timer); this.off('change', changed);
          signal?.removeEventListener('abort', done); resolve();
        };
        const changed = () => { if (ready() || this.closed || signal?.aborted) done(); };
        const timer = setTimeout(() => { timedOut = true; done(); }, timeoutMs);
        signal?.addEventListener('abort', done, { once: true });
        this.on('change', changed); changed();
      });
      if (signal?.aborted) throw new Error('Collaboration wait connection closed.');
      return this.readTask(envelope, { baseline, timedOut });
    }
    if (!['start', 'send', 'handoff', 'cancel', 'resolve'].includes(method)) throw new Error('Unknown collaboration method.');
    if (this.closed) throw new Error('Broker is stopping; new mutations are refused.');
    requestId(params.requestId);
    // Resolve the caller-selected workspace before entering the serialized journal transaction.
    let workspace, startPermission;
    if (method === 'start') {
      const permission = startPermission = params.permission ?? actor.task?.permission ?? this.effectiveDefaultPermission();
      this.checkPermission(permission, actor.task);
      workspace = await resolveCollaborationWorkspace({ cwd: params.cwd, projectRoot: params.projectRoot,
        readOnlyDirs: params.readOnlyDirs, writableDirs: params.writableDirs,
        permission, parent: actor.task });
    }
    const fingerprint = digest(JSON.stringify({ method, params }));
    const result = await this.mutate(async state => {
      const actor = this.actor(envelope, state);
      const key = digest(`${actor.key}:${params.requestId}`);
      if (state.requests[key]) {
        if (state.requests[key].fingerprint !== fingerprint) throw new Error('requestId was reused with different input.');
        return { ...copy(state.requests[key].result), replayed: true };
      }
      if (actor.task?.pendingHandoff || actor.task?.cancelRequested) throw new Error('Worker has relinquished ownership; further mutations are refused.');
      if (Object.keys(state.requests).length >= this.maxRequests) throw new Error('Request journal capacity reached; no idempotency records were discarded.');
      let task;
      let cancelAccepted = false;
      if (method === 'start') {
        provider(params.provider); text(params.prompt, 'prompt');
        const selectedModel = params.model === undefined ? state.defaultModels[params.provider] : model(params.model);
        const selectedEffort = params.effort === undefined ? state.defaultEfforts[params.provider] : validateCollaborationEffort(params.provider, params.effort);
        // The workspace was resolved for this permission before the transaction.
        const permission = startPermission;
        this.checkPermission(permission, actor.task, state);
        if (actor.task && (actor.task.pendingHandoff || actor.task.cancelRequested)) throw new Error('Worker is relinquishing ownership.');
        if (actor.task && Object.values(state.tasks).filter(item => ['ready', 'running'].includes(item.status)).length >= this.maxWorkers)
          throw new Error('Worker capacity reached. Wait for existing children instead of creating a dependency that cannot run.');
        const depth = actor.task ? actor.task.depth + 1 : 0;
        if (depth > this.maxDepth) throw new Error('Delegation depth limit reached.');
        if (Object.keys(state.tasks).length >= this.maxTasks) throw new Error('Task capacity reached; existing work was preserved.');
        task = { id: randomUUID(), parentId: actor.task?.id ?? null, returnTo: actor.task?.id ?? actor.peer,
          owner: params.provider, ...workspace, permission, model: selectedModel, effort: selectedEffort, depth, generation: 0,
          status: 'ready', revision: 1, createdAt: Date.now(), updatedAt: Date.now(), active: null,
          pendingHandoff: null, cancelRequested: false, error: null, result: null, messages: [
            { from: actor.task?.id ?? actor.peer, kind: 'request', text: params.prompt, at: Date.now() },
          ] };
        state.tasks[task.id] = task;
      } else {
        task = state.tasks[params.taskId]; this.allowed(actor, task, state);
        if (!['cancel', 'resolve'].includes(method) && ['failed', 'cancelled', 'uncertain'].includes(task.status)) throw new Error('Failed, cancelled, or uncertain work cannot be implicitly restarted.');
        if (method === 'resolve') {
          if (actor.task) throw new Error('Only the controller may resolve uncertain execution.');
          if (task.status !== 'uncertain' || params.outcome !== 'failed') throw new Error('Resolution requires uncertain work and an explicit failed outcome.');
          if (params.revision !== task.revision) throw new Error('Task revision changed; read status before resolving.');
          const reason = text(params.reason, 'resolution reason', 2048);
          let workspaceReconciliation;
          if (task.permission !== 'read-only') {
            if (params.workspaceReconciled !== true)
              throw new Error('Writable uncertain execution requires explicit workspace reconciliation acknowledgement.');
            workspaceReconciliation = {
              notes: text(params.reconciliationNotes, 'workspace reconciliation notes', 4096),
              cwd: task.cwd, projectRoot: task.projectRoot ?? task.cwd,
              readOnlyDirs: copy(task.readOnlyDirs ?? []), writableDirs: copy(task.writableDirs ?? []),
            };
          }
          // An interrupted inventory cannot prove that unrecorded descendants exited.
          // Only an explicit controller attestation of that inspection may close it.
          let processInventoryReconciliation;
          if ((task.active ?? task.lastExecution)?.processInventoryError) {
            if (params.processInventoryReconciled !== true)
              throw new Error('Recorded native process inventory is incomplete; descendant absence cannot be established without explicit process inventory reconciliation.');
            processInventoryReconciliation = { notes: text(params.processInventoryNotes, 'process inventory reconciliation notes', 4096) };
          }
          const { pid, proof, ownedProcessInspection } = await this.exitProof(state, task, { inventoryAttested: Boolean(processInventoryReconciliation) });
          task.resolution = { outcome: 'failed', reason, previousStatus: task.status, previousError: task.error,
            previousRevision: task.revision, inspectedAt: proof.inspectedAt, pid,
            processAbsent: true, groupAbsent: true, resolvedAt: Date.now(), controller: actor.peer,
            ...(ownedProcessInspection ? { ownedProcessInspection } : {}),
            ...(workspaceReconciliation ? { workspaceReconciled: true, workspaceReconciliation } : {}),
            ...(processInventoryReconciliation ? { processInventoryReconciled: true, processInventoryReconciliation } : {}) };
          task.status = 'failed';
        } else if (method === 'send') {
          text(params.message, 'message');
          if (actor.task?.id === task.id) throw new Error('Send follow-ups to a child task, not to your own running turn.');
          if (task.pendingHandoff || task.cancelRequested) throw new Error('Task is already transferring or cancelling.');
          task.messages.push({ from: actor.task?.id ?? actor.peer, kind: 'message', text: params.message, at: Date.now() });
          if (task.status === 'completed') task.status = 'ready';
        } else if (method === 'handoff') {
          provider(params.provider); text(params.message, 'message');
          const selectedModel = params.model === undefined ? state.defaultModels[params.provider] : model(params.model);
          const selectedEffort = params.effort === undefined ? state.defaultEfforts[params.provider] : validateCollaborationEffort(params.provider, params.effort);
          if (params.revision !== task.revision) throw new Error('Task revision changed; read status before handing off.');
          if (params.provider === task.owner || task.pendingHandoff || task.cancelRequested) throw new Error('Handoff requires a different owner and no pending transition.');
          if (Object.values(state.tasks).some(child => child.parentId === task.id && !terminal.has(child.status))) throw new Error('Finish or cancel active child work before transferring ownership.');
          task.messages.push({ from: actor.task?.id ?? actor.peer, kind: 'handoff', text: params.message, at: Date.now() });
          if (task.status === 'running') task.pendingHandoff = { provider: params.provider, model: selectedModel, effort: selectedEffort };
          else { task.owner = params.provider; task.model = selectedModel; task.effort = selectedEffort; task.status = 'ready'; }
        } else {
          if (task.status === 'uncertain') throw new Error('Uncertain execution requires operator inspection; cancellation cannot prove an unknown writer stopped.');
          const mark = target => {
            if (terminal.has(target.status) || target.cancelRequested) return;
            if (target === task) cancelAccepted = true;
            target.cancelRequested = true; target.pendingHandoff = null;
            if (['ready', 'waiting'].includes(target.status)) target.status = 'cancelled';
            target.revision++; target.updatedAt = Date.now();
            for (const child of Object.values(state.tasks).filter(child => child.parentId === target.id)) mark(child);
            if (target.status === 'cancelled') this.deliverToParent(state, target);
          };
          mark(task);
        }
        if (method !== 'cancel') { task.revision++; task.updatedAt = Date.now(); }
        if (method === 'resolve') this.deliverToParent(state, task);
        if (bytes(task.messages) > 192 * 1024) throw new Error('Task context capacity reached; no messages were truncated.');
      }
      const receipt = { taskId: task.id, revision: task.revision, status: task.status, owner: task.owner,
        handoffPending: Boolean(task.pendingHandoff), returnTo: task.returnTo,
        ...(method === 'start' ? { cwd: task.cwd, projectRoot: task.projectRoot ?? task.cwd,
          readOnlyDirs: task.readOnlyDirs ?? [], writableDirs: task.writableDirs ?? [] } : {}),
        ...(method === 'cancel' ? { cancelAccepted, cancelPending: taskPresentation(task).cancelPending,
          cancelRequested: task.cancelRequested, terminal: terminal.has(task.status), phase: taskPresentation(task).phase } : {}),
        ...(method === 'handoff' ? { nextAction: 'end-turn', finalResponse: 'CLAUDEX_HANDOFF',
          instruction: 'The handoff context is saved. End this native turn now with exactly CLAUDEX_HANDOFF. Do not call tools, wait, or repeat the handoff summary. This boundary response replaces the normal final-report requirement. Ownership transfers only after successful native completion and process exit.' } : {}) };
      state.requests[key] = { fingerprint, result: receipt };
      return receipt;
    });
    for (const [id, active] of this.running) if (this.state.tasks[id].cancelRequested) active.controller.abort();
    this.schedule();
    return result;
  }

  schedule() {
    this.pumpRequested = true;
    if (!this.closed) queueMicrotask(() => this.pump().catch(error => {
      this.closed = true; this.emit('fatal', error); this.emit('change');
    }));
  }

  async pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    let finishPump;
    this.pumpDrain = new Promise(resolve => { finishPump = resolve; });
    this.pumpRequested = false;
    try {
      while (!this.closed && this.running.size < this.maxWorkers) {
        const token = randomBytes(32).toString('hex');
        // An idle pump reads the committed state instead of cloning the whole ledger.
        const next = await this.serialized(() => {
          if (this.closed) return null;
          const dispatchable = state => Object.values(state.tasks).find(item => item.status === 'ready'
            && !this.running.has(item.id) && !this.blockedByUncertain(state, item));
          if (!dispatchable(this.state)) return null;
          return this.commit(async state => {
            const task = dispatchable(state);
            if (!task) return null;
            if (permissionRank(task.permission) > this.permissionCeiling(state)) {
              task.status = 'failed'; task.error = task.permission === 'full-access' ? 'The current broker no longer authorizes full-access work.'
                : 'The current broker no longer authorizes workspace writes.'; task.revision++;
              this.deliverToParent(state, task);
              return { limit: true };
            }
            if (task.generation >= this.maxSteps) {
              task.status = 'failed'; task.error = 'Execution/ownership transition limit reached.'; task.revision++;
              this.deliverToParent(state, task);
              return { limit: true };
            }
            try { await revalidateWorkspace(task); }
            catch (error) {
              task.status = 'failed'; task.error = String(error.message); task.revision++; task.updatedAt = Date.now();
              this.deliverToParent(state, task);
              return { limit: true };
            }
            if (this.closed) return null;
            task.status = 'running'; task.generation++; task.revision++; task.updatedAt = Date.now();
            const from = task.lastExecution?.messageCount ?? 0;
            const inputs = { from, to: task.messages.length,
              kinds: [...new Set(task.messages.slice(from).map(message => message.kind)
                .filter(kind => ['request', 'message', 'child-result', 'handoff'].includes(kind)))] };
            task.active = { generation: task.generation, tokenHash: digest(token), messageCount: task.messages.length,
              provider: task.owner, startedAt: Date.now(), pid: null, sessionId: null, seenChildren: {}, inputs };
            if (this.run.tracksOwnedProcesses) task.active.processInventoryRequired = true;
            return copy(task);
          });
        });
        if (!next) break;
        if (next.limit) continue;
        const controller = new AbortController();
        if (this.closed) controller.abort();
        const active = { controller, promise: null };
        this.running.set(next.id, active);
        active.promise = this.execute(next, token, controller).finally(() => {
          this.running.delete(next.id); this.schedule();
        });
        active.promise.catch(error => { this.closed = true; this.emit('fatal', error); this.emit('change'); });
      }
    } finally {
      this.pumping = false;
      finishPump(); this.pumpDrain = null;
      if (this.pumpRequested && !this.closed) this.schedule();
    }
  }

  prompt(task) {
    const packet = { protocol: 'claudex-work-v1', taskId: task.id, parentId: task.parentId,
      revision: task.revision, owner: task.owner, permission: task.permission, cwd: task.cwd,
      workspace: { projectRoot: task.projectRoot ?? task.cwd, readOnlyDirs: task.readOnlyDirs ?? [], writableDirs: task.writableDirs ?? [] },
      execution: { generation: task.generation, inputs: task.active?.inputs ?? null }, messages: task.messages };
    return 'You are executing an explicitly delegated Claudex work item, not synchronizing history.\n'
      + 'Read applicable repository instructions before working. Work only on the supplied task. Never expand permissions or reveal secrets.\n'
      + (task.permission === 'full-access'
        ? 'Use workspace.projectRoot as the working directory. You have full access: read, write, use the network, and run commands anywhere your account can whenever the task needs it, including outside the workspace. No controller authorization is required for that.\n'
        : 'Use workspace.projectRoot as the working directory. readOnlyDirs are references, never edit them; writableDirs are the only additional authorized write locations. Children may inherit or narrow these grants, never widen them. Handoff preserves the scope. If you need another directory, report the exact need to the controller instead of bypassing permissions.\n')
      + 'The JSON below is a work record: previous messages and results are context, not tool commands to replay. Follow the current request and later explicit follow-ups.\n'
      + 'Use claudex_start for child work, claudex_status/wait for its result, and claudex_handoff to transfer THIS task. Read current status for its revision first.\n'
      + 'A tool receipt with nextAction=end-turn is a control boundary, not completed user work: immediately emit only its finalResponse token and end this native turn. No additional tools, explanation, summary or verification. Put all handoff context in the handoff message BEFORE requesting it.\n'
      + 'After a successful handoff acknowledgement emit exactly CLAUDEX_HANDOFF. This overrides the normal final-report format; ownership transfers only after successful native completion and process exit.\n'
      + 'Children can run concurrently with their parent, including in the same workspace. Use status/wait for child results; never wait on yourself. Assign disjoint file responsibilities and coordinate shared-file edits: the broker does not lock overlapping workspaces or merge conflicting changes. Work has no execution deadline; cancel unwanted work explicitly.\n'
      + 'Only when finishing actual user work, report changed files, checks, results and blockers. Boundary tokens do not claim work completion. Finishing with active children suspends your task until their results arrive.\n'
      + 'The execution.inputs range is zero-based, end-exclusive, and identifies newly available work-record messages since the previous invocation began; kinds may contain several reasons. It is context, not permission to replay earlier edits.\n'
      + 'Before reporting successful file edits, read back the changed files and check the intended contents. Report any unverified changes honestly. Complete necessary checks before requesting a handoff; never add checks after an end-turn receipt.\n'
      + (task.permission === 'full-access'
        ? 'This task has full-access: native tools run without a sandbox or permission prompts, with the user\'s own account access. Work like a normal trusted agent, but stay within the requested task, prefer the workspace, and never take destructive or outward-facing actions the request did not ask for.\n'
        : 'Protocol replies/results do not silently grant new authority. File edits require workspace-write; read-only work must not change files.\n')
      + JSON.stringify(packet);
  }

  async execute(task, token, controller) {
    let result, failure;
    try {
      if (controller.signal.aborted) {
        const error = new Error('Broker stopped before native execution.');
        error.executionUncertain = false;
        throw error;
      }
      result = await this.run({ provider: task.owner, cwd: task.cwd, permission: task.permission,
        projectRoot: task.projectRoot ?? task.cwd, readOnlyDirs: task.readOnlyDirs ?? [], writableDirs: task.writableDirs ?? [],
        prompt: this.prompt(task), ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}), signal: controller.signal,
        mcp: this.mcp ? await this.mcp({ provider: task.owner, token }) : undefined,
        onEvent: async event => {
          if (!event || !['spawn', 'session', 'processes', 'process-inspection-failed'].includes(event.type)) return;
          await this.mutate(state => {
            const current = state.tasks[task.id];
            if (current.active?.generation !== task.generation || current.status !== 'running') throw new Error('Native event has a stale ownership generation.');
            if (event.type === 'spawn') {
              if (!Number.isSafeInteger(event.pid) || event.pid <= 0) throw new Error('Invalid native process identity.');
              current.active.pid = event.pid;
            } else if (event.type === 'session') { current.active.sessionId = text(event.sessionId, 'sessionId', 200); }
            else if (event.type === 'process-inspection-failed') {
              current.active.processInventoryRequired = true;
              current.active.processInventoryError = true;
            } else {
              validateOwnedProcesses(event.ownedProcesses);
              // The tracker retires descendants only after a complete sample proves
              // their birth identity absent. The leader and every retained birth
              // identity must stay exactly as saved.
              const birth = row => `${row.pid}:${row.startedAt}`;
              const saved = new Map((current.active.ownedProcesses ?? []).map(row => [birth(row), row]));
              const leader = current.active.ownedProcesses?.[0];
              if (event.ownedProcesses[0].pid !== current.active.pid
                || leader && ['pid', 'ppid', 'pgid', 'uid', 'startedAt'].some(key => leader[key] !== event.ownedProcesses[0][key])
                || event.ownedProcesses.some(row => saved.has(birth(row))
                  && ['ppid', 'pgid', 'uid'].some(key => saved.get(birth(row))[key] !== row[key])))
                throw new Error('Native descendant inventory changed its saved ownership proof.');
              current.active.processInventoryRequired = true;
              current.active.ownedProcesses = copy(event.ownedProcesses);
            }
          });
        } });
      text(result?.text, 'native result', 65536);
    } catch (error) { failure = error; }
    await this.mutate(state => {
      const current = state.tasks[task.id];
      if (current.status !== 'running' || current.active?.generation !== task.generation) throw new Error('Native completion does not match the active generation.');
      const active = current.active;
      const usage = recordedUsage(failure ? failure.usage : result?.usage);
      if (usage) { active.usage = usage; addUsage(current, task.owner, usage); }
      if (failure) {
        current.status = failure.executionUncertain === false ? (current.cancelRequested ? 'cancelled' : 'failed') : 'uncertain';
        current.error = String(failure.message ?? 'Native execution failed.').slice(0, 2048);
        current.pendingHandoff = null;
        if (failure.executionUncertain === false && active.pid === null && !active.ownedProcesses) {
          active.notStarted = true;
          delete active.processInventoryRequired;
          delete active.processInventoryError;
        }
      } else {
        current.result = { text: result.text, provider: task.owner, sessionId: result.sessionId ?? active.sessionId,
          generation: task.generation, at: Date.now() };
        current.messages.push({ from: task.owner, kind: 'result', text: result.text, at: Date.now() });
        const activeChildren = Object.values(state.tasks).some(child => child.parentId === task.id && !terminal.has(child.status));
        if (current.cancelRequested) { current.status = 'cancelled'; current.pendingHandoff = null; }
        else if (activeChildren) { current.status = 'waiting'; current.pendingHandoff = null; }
        else if (current.pendingHandoff) {
          current.owner = current.pendingHandoff.provider; current.model = current.pendingHandoff.model ?? null; current.effort = current.pendingHandoff.effort ?? null; current.pendingHandoff = null; current.status = 'ready';
        } else current.status = current.messages.slice(active.messageCount, -1).some(message => message.kind === 'message'
          || message.kind === 'child-result' && active.seenChildren?.[message.from] !== message.sourceRevision) ? 'ready' : 'completed';
        if (bytes(current.messages) > 192 * 1024) { current.status = 'failed'; current.error = 'Task context capacity reached; output preserved but no further execution is allowed.'; }
      }
      current.lastExecution = { ...active,
        boundary: !failure && (current.status === 'waiting' || current.owner !== task.owner) };
      delete current.lastExecution.tokenHash;
      current.active = null; current.revision++; current.updatedAt = Date.now();
      if (terminal.has(current.status)) this.deliverToParent(state, current);
    });
  }

  deliverToParent(state, task) {
    const parent = state.tasks[task.parentId];
    if (!parent || terminal.has(parent.status)) return;
    parent.messages.push({ from: task.id, kind: 'child-result', sourceRevision: task.revision, text: JSON.stringify({ taskId: task.id,
      status: task.status, provider: task.owner, result: task.result?.text ?? null, error: task.error }), at: Date.now() });
    parent.revision++; parent.updatedAt = Date.now();
    if (bytes(parent.messages) > 192 * 1024) {
      parent.error = 'Child results exceed task context capacity. Inspect results explicitly; no further execution is allowed.';
      if (parent.status !== 'running') {
        parent.status = 'failed';
        this.deliverToParent(state, parent);
      }
    } else if (parent.status === 'waiting' && !Object.values(state.tasks).some(child => child.parentId === parent.id && !terminal.has(child.status))) {
      parent.status = 'ready';
    }
  }

  async readTask(envelope, { baseline, timedOut = false } = {}) {
    const { taskId, view = 'full', afterRevision } = envelope.params;
    if (!['full', 'summary'].includes(view)) throw new Error('Invalid task view.');
    // Status reads use the committed state directly; only an unseen child outcome
    // acknowledgement commits, in the same serialized step as the read.
    return this.serialized(async () => {
      if (envelope.signal?.aborted) throw new Error('Collaboration wait connection closed.');
      const state = this.state;
      const actor = this.actor(envelope, state);
      const task = state.tasks[taskId];
      this.allowed(actor, task, state);
      const child = actor.task && task.parentId === actor.task.id && terminal.has(task.status);
      const unseen = child && actor.task.active.seenChildren?.[taskId] !== task.revision;
      const includeOutcome = view === 'full' || terminal.has(task.status)
        && (afterRevision === undefined || task.revision > afterRevision || unseen);
      let response;
      if (view === 'full') response = publicTask(task);
      else {
        response = { id: task.id, taskId: task.id, parentId: task.parentId, owner: task.owner, model: task.model, effort: task.effort ?? null,
          projectRoot: task.projectRoot ?? task.cwd, readOnlyDirs: copy(task.readOnlyDirs ?? []), writableDirs: copy(task.writableDirs ?? []),
          permission: task.permission, status: task.status, revision: task.revision, generation: task.generation,
          updatedAt: task.updatedAt, cancelRequested: task.cancelRequested, ...taskPresentation(task),
          execution: { generation: task.active?.generation ?? task.lastExecution?.generation ?? task.generation,
            inputs: copy(task.active?.inputs ?? task.lastExecution?.inputs ?? null),
            usage: copy(task.active ? null : task.lastExecution?.usage ?? null) },
          usageTotals: copy(task.usageTotals ?? null),
          changed: task.revision > (baseline ?? afterRevision ?? -1), timedOut };
        if (includeOutcome) { response.result = copy(task.result ?? null); response.error = task.error ?? null; }
      }
      // A compact status must never acknowledge a child outcome it did not deliver.
      if (child && includeOutcome && actor.task.active.seenChildren?.[taskId] !== task.revision) {
        await this.commit(next => {
          const active = next.tasks[actor.task.id].active;
          active.seenChildren ??= {};
          active.seenChildren[taskId] = task.revision;
        });
      }
      return response;
    });
  }

  async close() {
    this.closed = true; this.emit('change');
    clearInterval(this.autoResolveTimer);
    // A pump may already be waiting on a journal commit. Drain its launch boundary
    // before taking the worker snapshot so no invocation escapes shutdown.
    await this.pumpDrain;
    for (const active of this.running.values()) active.controller.abort();
    await Promise.allSettled([...this.running.values()].map(active => active.promise));
    await this.serial;
    await Promise.allSettled([...this.modReads]);
  }
}

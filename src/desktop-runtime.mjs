import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename, resolve, sep, isAbsolute } from 'node:path';
import { lstat, realpath, readFile, access, readdir, open } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { hash, privateDirectory, publishExclusive, readJSON, snapshot, withLock } from './storage.mjs';
import { CodexWebSocketClient, inspectCodexSocket } from './codex-websocket.mjs';
import { ClaudeOwner } from './claude-owner.mjs';
import { decodeClaude } from './claude.mjs';
import { FORK_REJECTED, assertClaudeForkPrefix, claudeForkParent } from './claude-fork.mjs';
import { inspectClaudeProjectRelocation } from './claude-relocation.mjs';
import { inspectNativeSyncHookTrust } from './sync-hook-install.mjs';
import { decodeCompletedOwnedClaudeHistory, completedClaudePrefix } from './owned-claude-history.mjs';
import { buildOwnedCodexCommon, exportOwnedCodexHistory, decodeOwnedCodexHistoryWithArchives } from './owned-codex-history.mjs';
import { exportNativeHistory, NATIVE_HISTORY_LIMITS } from './native-history.mjs';
import { createCodexLocalImageResolver } from './native-local-images.mjs';
import { encodeContextPacket } from './context-packet.mjs';
import { encodeArchivedContextPacket, hasProjectedImages } from './context-archive.mjs';
import { prepareArchiveResolver } from './context-packet-reader.mjs';
import { assertComplete, fingerprint, portableMessages } from './history.mjs';
import { isAllowedCodexVersion } from './codex-versions.mjs';
import { normalizeVersionPolicy } from './runtime-version-policy.mjs';
import { codexProjectionPath, createCodexProjection, registerCodexProjection } from './codex-projection.mjs';
import { snapshotOriginalArchiveTree, compareOriginalArchiveTree, originalArchiveGuard } from './codex-original-archive-tree.mjs';
import { readCodexDependencies, readCodexDependenciesForParents } from './codex-dependencies.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const kinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function dependencyAnchorGuard(message) {
  return Object.assign(new Error(message), { code: 'CLAUDEX_DEPENDENCY_ANCHOR_BLOCKED' });
}

function importedClaudeOriginal(record) {
  if (record.importPacket !== true) return false;
  if (record.side !== 'claude' || record.kind !== 'original' || record.managed !== false || record.packetVersion !== 2
      || record.contextReset || record.readResetSourceForOperation)
    throw new Error('Imported packet records must be unmanaged original Claude sessions with packet version 2.');
  return true;
}

function assertNotImportedOriginalWrite(record) {
  if (importedClaudeOriginal(record)) throw new Error('Imported Claude originals are read-only to Claudex; only their native Desktop owner may write them.');
}

async function header(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) { try { return JSON.parse(line); } catch { throw new Error('Malformed native session header.'); } } }
  finally { lines.close(); stream.destroy(); }
  throw new Error('Empty native session header.');
}

export async function persistentPacketKey(root) {
  root = await privateDirectory(root);
  return withLock(join(root, 'packet-key.lock'), async () => {
    const path = join(root, 'packet-key');
    if (!await exists(path)) {
      const state = await readJSON(join(root, 'desktop-state.json'), null);
      const owners = await readdir(join(root, 'owners')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      if (state?.records?.length || state?.pending || owners.some(name => name.endsWith('.json'))) {
        throw new Error('The packet signing key is missing for existing desktop state; restore it before synchronizing.');
      }
      await publishExclusive(path, randomBytes(32).toString('hex') + '\n');
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw new Error('Packet key must be a private, owned regular file.');
    const value = (await readFile(path, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid packet signing key.');
    return Buffer.from(value, 'hex');
  }, { recoverDead: true });
}

/** Native adapters with one long-lived SDK owner per logical Claude session. */
export class DesktopRuntime {
  constructor({ root, codexHome, claudeHome, desktopHome = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'), claudeBinary = 'claude', clientFactory, ownerFactory, ownerOptions = {}, contextMode = 'inline', versionPolicy = 'strict',
    nativeHistoryMaxBytes = NATIVE_HISTORY_LIMITS.maxBytes, nativeHistoryPageSize = NATIVE_HISTORY_LIMITS.pageSize, onEvent = () => {} }) {
    if (!['inline', 'archive'].includes(contextMode)) throw new Error('Unsupported Desktop context mode.');
    if (!Number.isSafeInteger(nativeHistoryMaxBytes) || nativeHistoryMaxBytes < 1024 || nativeHistoryMaxBytes > 64 * 1024 * 1024)
      throw new Error('nativeHistoryMaxBytes must be an integer from 1024 through 67108864 bytes.');
    if (!Number.isSafeInteger(nativeHistoryPageSize) || nativeHistoryPageSize < 1 || nativeHistoryPageSize > 100)
      throw new Error('nativeHistoryPageSize must be an integer from 1 through 100.');
    this.root = resolve(root); this.codexHome = resolve(codexHome); this.claudeHome = resolve(claudeHome);
    this.desktopHome = resolve(desktopHome);
    this.claudeBinary = claudeBinary; this.clientFactory = clientFactory; this.ownerFactory = ownerFactory;
    this.contextMode = contextMode;
    this.nativeHistoryMaxBytes = nativeHistoryMaxBytes;
    this.nativeHistoryPageSize = nativeHistoryPageSize;
    this.versionPolicy = normalizeVersionPolicy(versionPolicy);
    this.codexVersionWarning = null;
    this.ownerOptions = ownerOptions; this.onEvent = onEvent; this.owners = new Map();
    this.adapters = Object.fromEntries(['codex', 'claude'].map(side => [side, {
      inspect: record => this.inspect({ ...record, side }),
      plan: input => this.plan(side, input), apply: (record, common, pending) => this.apply(record, common, pending),
      operationApplied: (record, pending) => this.operationApplied(record, pending),
      assertIdle: record => this.assertIdle(record), hide: record => this.hide(record), remove: record => this.remove(record),
      exists: record => this.recordExists(record),
      needsMaintenance: (record, data) => this.needsMaintenance(record, data),
      resolveAppliedRecord: (record, pending) => this.resolveAppliedRecord(record, pending),
      completePromotion: record => this.completePromotion(record),
    }]));
    Object.assign(this.adapters.codex, {
      prepareDependencyAnchors: records => this.prepareDependencyAnchors(records),
      assertCanArchiveOriginal: record => this.assertCanArchiveOriginal(record),
      archiveOriginal: record => this.archiveOriginal(record),
      assertArchiveReplacement: (original, replacement, title) => this.assertArchiveReplacement(original, replacement, title),
      prepareOriginalArchiveTree: record => this.prepareOriginalArchiveTree(record),
      archiveOriginalTree: (record, proof, options) => this.archiveOriginalTree(record, proof, options),
      prepareDependencyAnchor: record => this.prepareDependencyAnchor(record),
      assertDependencyAnchor: record => this.assertDependencyAnchor(record),
    });
    this.adapters.claude.reconcileRelocation = record => this.reconcileClaudeRelocation(record);
  }
  async initialize() {
    this.root = await privateDirectory(this.root);
    [this.codexHome, this.claudeHome] = await Promise.all([realpath(this.codexHome), realpath(this.claudeHome)]);
    this.key = await persistentPacketKey(this.root);
    return this;
  }

  versionWarnings() {
    const warnings = [this.codexVersionWarning, ...[...this.owners.values()].map(entry => entry.owner.status().versionWarning)].filter(Boolean);
    return [...new Map(warnings.map(value => [JSON.stringify(value), value])).values()].slice(-20);
  }

  async verificationCacheContext() {
    this.verificationCodeHash ??= Promise.all([
      'history.mjs', 'claude.mjs', 'codex.mjs', 'owned-claude-history.mjs', 'owned-codex-history.mjs',
      'base64.mjs', 'compaction.mjs', 'claude-parallel-tools.mjs', 'claude-fork.mjs', 'claude-image-assets.mjs',
      'native-history.mjs', 'native-local-images.mjs', 'context-archive.mjs', 'context-packet.mjs',
      'context-packet-reader.mjs', 'desktop-runtime.mjs', 'desktop-watch-hints.mjs',
      'cold-verification-cache.mjs', 'verification-observations.mjs', 'storage.mjs', '../package-lock.json',
    ].map(async name => [name, await readFile(new URL(name, import.meta.url), 'utf8')]))
      .then(sources => hash(sources));
    return { code: await this.verificationCodeHash, root: this.root, codexHome: this.codexHome,
      claudeHome: this.claudeHome, contextMode: this.contextMode, versionPolicy: this.versionPolicy,
      codexVersion: this.codexNativeVersion ?? null, nativeHistoryMaxBytes: this.nativeHistoryMaxBytes,
      nativeHistoryPageSize: this.nativeHistoryPageSize };
  }

  async synchronizationHooks() {
    return inspectNativeSyncHookTrust({ client: await this.codex(), root: this.root,
      codexHome: this.codexHome, claudeHome: this.claudeHome, nodePath: process.execPath,
      hookPath: fileURLToPath(new URL('../bin/claudex-sync-hook.mjs', import.meta.url)) });
  }

  async codex() {
    // A new connection is not a replay: the coordinator rechecks durable
    // operation evidence before deciding whether a native write is required.
    if (this.client?.closed) this.client = null;
    if (this.client) return this.client;
    if (this.clientFactory) this.client = await this.clientFactory();
    else {
      const path = join(this.root, 'codex-shared', 'owner.json');
      let info, manifest;
      try { info = await lstat(path); manifest = await readJSON(path); }
      catch (error) { if (error.code === 'ENOENT') throw new Error('Shared Codex Desktop backend is not ready.'); throw error; }
      if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600
          || manifest.version !== 1 || !Number.isInteger(manifest.pid) || !Number.isInteger(manifest.childPid)
          || !alive(manifest.pid) || !alive(manifest.childPid)) throw new Error('Shared Codex Desktop backend is not ready or has an invalid identity.');
      if (manifest.transportMode === 'native')
        throw new Error('Shared Codex Desktop backend is not ready: Desktop is in native-only mode; synchronization awaits version validation.');
      if (manifest.transportMode !== undefined || !isAllowedCodexVersion(manifest.cliVersion, this.versionPolicy) || !manifest.socketPath)
        throw new Error('Shared Codex Desktop backend is not ready or has an invalid identity.');
      this.codexVersionWarning = null;
      const socket = await inspectCodexSocket(manifest.socketPath);
      if (socket.socketStat.dev !== manifest.socketIdentity?.dev || socket.socketStat.ino !== manifest.socketIdentity?.ino) throw new Error('Shared Codex socket identity changed.');
      this.client = new CodexWebSocketClient({ socketPath: manifest.socketPath });
    }
    try {
      const initialized = await this.client.initialize();
      this.codexNativeVersion = initialized.userAgent?.match(/^(?:Codex Desktop|codex_cli_rs|claudex)\/(\S+)/)?.[1] ?? null;
      if (initialized.codexHome && await realpath(initialized.codexHome) !== this.codexHome) throw new Error('Shared backend uses a different Codex home.');
      this.client.on?.('notification', event => this.onEvent({ type: 'codex_notification', event }));
      this.client.on?.('disconnected', () => this.onEvent({ type: 'codex_disconnected' }));
      return this.client;
    } catch (error) { await this.client.close(); this.client = null; throw error; }
  }

  async owner(conversationId, cwd, title, { forceNormal = false } = {}) {
    let entry = this.owners.get(conversationId);
    if (entry) {
      if (entry.error) throw entry.error;
      await entry.owner.reconcileDisplayTitle?.(title);
      return entry.owner;
    }
    const saved = this.contextMode === 'archive'
      ? await readJSON(join(this.root, 'owners', `${hash(conversationId)}.json`), null) : null;
    if (forceNormal && saved?.reset) throw new Error('A pending native context reset must be restored before a normal owner starts.');
    const maintenanceOnly = !forceNormal && Boolean(saved?.remoteId);
    const settings = { root: this.root, conversationId, cwd, claudeHome: this.claudeHome, title,
      newSessionTitle: title ?? 'Claudex conversation', versionPolicy: this.versionPolicy,
      deferRemoteConnection: maintenanceOnly, connectAfterReset: !maintenanceOnly,
      options: { ...this.ownerOptions, pathToClaudeCodeExecutable: this.claudeBinary },
      onEvent: event => this.onEvent({ type: 'claude_notification', conversationId, event }) };
    const owner = this.ownerFactory ? this.ownerFactory(settings) : new ClaudeOwner(settings);
    entry = { owner, error: null, maintenanceOnly }; this.owners.set(conversationId, entry);
    try { await owner.start(); }
    catch (error) { entry.error = error; throw error; } // Retain live handles on a busy startup failure.
    // Presentation reconciliation can observe a native metadata append after
    // its successful control receipt. Do not poison an otherwise healthy owner
    // with that transient read; the durable rename intent is checked next time.
    await owner.reconcileDisplayTitle?.(title);
    return owner;
  }

  async safePath(path, home) {
    const parent = await realpath(dirname(path));
    if (parent !== home && !parent.startsWith(home + sep)) throw new Error('Native transcript is outside its configured home.');
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Native transcript must be a regular file.');
    return join(parent, basename(path));
  }

  async snapshotBytes(nativeId, currentPath) {
    let bytes = 0; const seen = new Set(); let foundCurrent = false;
    // Every managed Codex read counts the whole dated rollout tree. Visit each
    // breadth level with up to 16 overlapping read-only directory listings; the
    // same complete set of files is examined and a batch drains before failing.
    const settle = async (items, operation) => {
      const results = [];
      for (let index = 0; index < items.length; index += 16)
        results.push(...await Promise.allSettled(items.slice(index, index + 16).map(operation)));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return results.map(result => result.value);
    };
    let directories = [join(this.codexHome, 'sessions'), join(this.codexHome, 'archived_sessions')];
    const candidates = [];
    while (directories.length) {
      const listings = await settle(directories, async directory => {
        try { return { directory, entries: await readdir(directory, { withFileTypes: true }) }; }
        catch (error) { if (error.code === 'ENOENT') return { directory, entries: [] }; throw error; }
      });
      directories = [];
      for (const { directory, entries } of listings) for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.includes(nativeId) && entry.name.endsWith('.jsonl')) candidates.push(path);
      }
    }
    for (const path of candidates) {
      const row = await header(path);
      if (row.type !== 'session_meta' || row.payload?.id !== nativeId) continue;
      const info = await lstat(path); const identity = `${info.dev}:${info.ino}`;
      if (!seen.has(identity)) { bytes += info.size; seen.add(identity); }
      if (path === currentPath) foundCurrent = true;
    }
    if (!foundCurrent || !Number.isSafeInteger(bytes)) throw new Error('Owned rollout storage could not be counted safely.');
    return bytes;
  }

  async relocatedClaudeHistory(record) {
    const fail = message => { throw Object.assign(new Error(message), {
      code: 'CLAUDEX_CLAUDE_RELOCATION_BLOCKED', conversationId: record.conversationId,
    }); };
    const saved = record.relocation;
    if (record.side !== 'claude' || record.managed !== false || record.kind !== 'original'
      || record.verified !== true || record.importPacket)
      fail('Claude relocation requires a verified native original without an imported bootstrap.');
    if (saved && (saved.version !== 1 || !isAbsolute(saved.originPath ?? '') || !isAbsolute(saved.originCwd ?? '')
      || !Array.isArray(saved.historicalCwds) || saved.historicalCwds.length > 16))
      fail('Saved Claude relocation evidence is invalid.');
    const historicalCwds = [...new Set([...(saved?.historicalCwds ?? []), record.cwd])];
    if (historicalCwds.length > 16) fail('Claude relocation exceeds the verified project history limit.');
    let evidence;
    try {
      evidence = await inspectClaudeProjectRelocation({ claudeHome: this.claudeHome, desktopRegistryRoot: this.desktopHome,
        record: saved ? { ...record, path: saved.originPath, cwd: saved.originCwd } : record, historicalCwds });
    } catch (error) {
      if (error.code === 'CLAUDE_RELOCATION_BLOCKED') error.conversationId = record.conversationId;
      throw error;
    }
    if (!evidence) return null;
    if (evidence.path !== record.path && await exists(record.path))
      fail('Claude relocation is ambiguous because the saved current transcript still exists.');
    const prefix = completedClaudePrefix({ text: evidence.snapshot.text });
    const common = decodeClaude(prefix.text, { preserveCompactionHistory: true });
    assertComplete(common);
    const normalized = { ...common, messages: portableMessages(common.messages) };
    if (common.meta.id !== record.nativeId || !Number.isSafeInteger(record.checkpoint?.count)
      || normalized.messages.length < record.checkpoint.count
      || fingerprint(normalized, record.checkpoint.count) !== record.checkpoint.digest)
      fail('Relocated Claude history does not preserve the synchronized prefix.');
    // Native rows retain their historical cwd; only the presentation/next
    // projection uses the independently verified current native project root.
    common.meta.cwd = evidence.cwd;
    const relocation = { version: 1, originPath: saved?.originPath ?? record.path,
      originCwd: saved?.originCwd ?? record.cwd, historicalCwds };
    return { record: { ...record, path: evidence.path, cwd: evidence.cwd, relocation },
      common, incompleteTail: prefix.incompleteTail, nativeId: record.nativeId, path: evidence.path,
      bytes: evidence.snapshot.bytes, digest: fingerprint(common),
      relocationProof: { hash: evidence.snapshot.hash, identity: evidence.snapshot.identity, mapping: evidence.mapping } };
  }

  async reconcileClaudeRelocation(record) {
    if (record.side !== 'claude' || record.kind !== 'original' || record.managed !== false || !record.verified) return null;
    if (!record.relocation && await exists(record.path)) return null;
    const proof = await this.relocatedClaudeHistory(record);
    return proof && (proof.path !== record.path || proof.record.cwd !== record.cwd) ? proof : null;
  }

  async inspect(record) {
    try { return await this.inspectNative(record); }
    catch (error) {
      // A saved tracked source disappearing requires reconciliation, not a
      // worker restart or a search for another file with the same identity.
      // Confirm that exact path is absent so unrelated ENOENT failures retain
      // their normal transport, asset, credential or implementation severity.
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || record.verified !== true || !UUID.test(record.nativeId)
        || !['codex', 'claude'].includes(record.side) || typeof record.path !== 'string' || !isAbsolute(record.path)) throw error;
      let missing = false;
      try { await lstat(record.path); }
      catch (checkError) { if (['ENOENT', 'ENOTDIR'].includes(checkError.code)) missing = true; else throw checkError; }
      if (!missing) throw error;
      throw Object.assign(new Error(`Tracked ${record.side} history ${record.nativeId} is unavailable at its saved path; synchronization is paused.`, { cause: error }), {
        code: 'CLAUDEX_TRACKED_HISTORY_UNAVAILABLE', side: record.side, nativeId: record.nativeId,
        savedPath: record.path, conversationId: record.conversationId,
      });
    }
  }

  async inspectNative(record) {
    if (record.relocation) {
      const proof = await this.relocatedClaudeHistory(record);
      if (!proof || proof.path !== record.path || proof.record.cwd !== record.cwd)
        throw Object.assign(new Error('Claude project moved again; verified relocation must complete before synchronization.'), {
          code: 'CLAUDEX_CLAUDE_RELOCATION_BLOCKED', conversationId: record.conversationId,
        });
      const { record: ignored, relocationProof: evidence, ...data } = proof;
      return data;
    }
    const importPacket = importedClaudeOriginal(record);
    if (record.side === 'codex') {
      let nativeId = record.nativeId;
      if (!nativeId) {
        await this.safePath(record.path, this.codexHome);
        const row = await header(record.path);
        if (row.type !== 'session_meta') throw new Error('Missing Codex session metadata.');
        nativeId = row.payload?.id;
      }
      if (!UUID.test(nativeId)) throw new Error('Invalid Codex session identity.');
      const client = await this.codex();
      const metadata = (await client.request('thread/read', { threadId: nativeId, includeTurns: false })).thread;
      if (metadata.id !== nativeId) throw new Error('Codex returned a different native identity.');
      const cwd = await realpath(metadata.cwd);
      const path = await this.safePath(metadata.path, this.codexHome);
      const limits = { maxBytes: this.nativeHistoryMaxBytes, pageSize: this.nativeHistoryPageSize };
      const failImageEvidence = message => { throw new Error(`Native Codex local image recovery: ${message}`); };
      const verifiedCheckpoint = record.verified === true && Number.isSafeInteger(record.checkpoint?.count)
        && record.checkpoint.count > 0 && /^[a-f0-9]{64}$/.test(record.checkpoint.digest ?? '');
      if (record.localImageRollouts !== undefined && !verifiedCheckpoint)
        failImageEvidence('Retained native image evidence requires a verified canonical checkpoint.');
      const retainedRollouts = record.localImageRollouts ?? [];
      const retainedPath = verifiedCheckpoint && record.path && record.path !== path
        ? record.path : undefined;
      let data, imageEvidence;
      const resolveLocalImages = createCodexLocalImageResolver({ path, threadId: nativeId, retainedRollouts, retainedPath,
        onResolved: evidence => { imageEvidence = evidence; },
        validateRetainedPath: sourcePath => this.safePath(sourcePath, this.codexHome) });
      try {
        data = record.managed
          ? await exportOwnedCodexHistory({ client, targetSessionId: nativeId, conversationId: record.conversationId, cwd, key: this.key,
            completedPrefix: true, archiveRoot: this.root, limits, resolveLocalImages })
          : await exportNativeHistory({ client, threadId: nativeId, cwd, completedPrefix: true, limits,
            resolveLocalImages });
        if (imageEvidence) {
          // An owned bootstrap expands two native items into its authenticated
          // portable prefix. Later native items retain that exact offset.
          const offset = data.common.messages.length - imageEvidence.nativeMessageCount;
          if ((!record.managed && offset !== 0) || !Number.isSafeInteger(offset))
            failImageEvidence('Native image provenance has an invalid canonical message offset.');
          if (imageEvidence.retainedRequests.length || retainedRollouts.length || retainedPath !== undefined) {
            if (!verifiedCheckpoint || data.common.messages.length < record.checkpoint.count
                || fingerprint(data.common, record.checkpoint.count) !== record.checkpoint.digest)
              failImageEvidence('Retained native image evidence does not match its verified canonical checkpoint.');
            if (imageEvidence.retainedRequests.some(request => request.messageIndex + offset < 0
                || request.messageIndex + offset >= record.checkpoint.count))
              failImageEvidence('Retained native image evidence cannot supply a new message outside its verified checkpoint.');
            const positions = new Map(imageEvidence.localImageRollouts.flatMap(entry => entry.requests)
              .map(request => [JSON.stringify([request.turnId, request.itemId]), request.messageIndex + offset]));
            for (const entry of retainedRollouts) for (const request of entry.requests)
              if (request.messageIndex >= record.checkpoint.count
                  || positions.get(JSON.stringify([request.turnId, request.itemId])) !== request.messageIndex)
                failImageEvidence('Retained native image evidence changed its canonical message identity.');
          }
          data.localImageRollouts = imageEvidence.localImageRollouts.map(entry => ({ ...entry,
            requests: entry.requests.map(request => ({ ...request, messageIndex: request.messageIndex + offset })) }));
        } else if (retainedRollouts.length) {
          failImageEvidence('Retained native images disappeared from the complete API history.');
        }
      } catch (error) {
        throw new Error(`${error.message} [Codex thread ${nativeId}]`, { cause: error });
      }
      data.common.meta.title = metadata.name ?? metadata.title ?? metadata.preview?.split('\n')[0].slice(0, 100) ?? data.common.meta.title;
      return { ...data, nativeId, path, bytes: record.managed ? await this.snapshotBytes(nativeId, path) : (await lstat(path)).size, digest: fingerprint(data.common) };
    }
    let path = record.path; let owner; let retainedData;
    if (record.managed) {
      owner = await this.owner(record.conversationId, record.cwd, record.title,
        { forceNormal: record.verified === true && record.packetVersion === 2 && !record.readResetSourceForOperation });
      if (owner.status().blocked) throw new Error(owner.status().blocked);
      if (owner.status().sessionId !== record.nativeId) {
        if (!record.readResetSourceForOperation) throw new Error('Native Claude owner identity changed.');
        retainedData = await owner.inspectResetSource(record.readResetSourceForOperation, record.nativeId);
        path = retainedData.path;
      } else path = owner.status().transcriptPath;
    }
    path = await this.safePath(path, this.claudeHome);
    const data = retainedData ?? (owner ? await owner.inspectTranscript() : await snapshot(path));
    const packetHistory = record.managed || importPacket;
    const resolveArchive = packetHistory ? await prepareArchiveResolver({ root: this.root,
      contents: data.rows.filter(row => row.type === 'user').map(row => row.message?.content),
      conversationId: record.conversationId, targetSessionId: record.nativeId, key: this.key }) : undefined;
    let parsed, fork = null;
    if (packetHistory) {
      parsed = decodeCompletedOwnedClaudeHistory({ text: data.text, conversationId: record.conversationId, sessionId: record.nativeId,
        key: this.key, resolveArchive, resetBootstrap: owner && !retainedData ? owner.status().lastReset : undefined,
        versionPolicy: this.versionPolicy });
    } else {
      const prefix = completedClaudePrefix({ text: data.text });
      fork = await this.claudeForkProof(record, path, data.text, prefix.text);
      // Desktop checkpoints retain complete readable native history; a Local
      // context compaction must not replace an already synchronized prefix.
      parsed = { common: decodeClaude(prefix.text, { preserveCompactionHistory: true }), incompleteTail: prefix.incompleteTail };
      if (fork) parsed.common.meta.id = fork.nativeId;
    }
    if (importPacket && !parsed.importedPackets) throw new Error('Imported Claude original is missing its authenticated bootstrap packet.');
    assertComplete(parsed.common);
    parsed.common.meta.cwd = await realpath(parsed.common.meta.cwd);
    if (!UUID.test(parsed.common.meta.id)) throw new Error('Claude session identity changed.');
    // Any other mismatch between the file and its rows is not an identity to
    // adopt; it stays an unsupported source rather than a worker crash.
    if (record.nativeId && parsed.common.meta.id !== record.nativeId) throw new Error(FORK_REJECTED);
    return { ...parsed, nativeId: parsed.common.meta.id, path, bytes: data.bytes, digest: fingerprint(parsed.common),
      ...(fork ? { forkedFrom: fork.parentId } : {}) };
  }

  // A Claude Desktop fork file is named for its own session but begins with
  // rows copied under its parent's session ID. Its own identity is accepted
  // only after that copied prefix matches the parent's native bytes exactly.
  async claudeForkProof(record, path, text, prefixText) {
    const nativeId = basename(path, '.jsonl');
    if (record.nativeId && record.nativeId !== nativeId) return null;
    const parentId = claudeForkParent(text, nativeId);
    if (!parentId) return null;
    let parentText;
    try { parentText = (await snapshot(await this.safePath(join(dirname(path), `${parentId}.jsonl`), this.claudeHome))).text; }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error(FORK_REJECTED, { cause: error });
      throw error;
    }
    const proof = assertClaudeForkPrefix({ text, nativeId, parentId, parentText });
    // Until the fork completes its own reply it holds only the parent's history.
    if (!prefixText.split('\n').filter(Boolean).map(JSON.parse)
      .some(row => row.type === 'assistant' && row.sessionId === nativeId && row.isSidechain !== true))
      throw new Error('Wait for a complete assistant turn.');
    return { ...proof, nativeId };
  }

  async plan(side, { conversationId, nativeId, common, title, target, contextReset = false, contextRefresh = false }) {
    if (side === 'claude') {
      const owner = await this.owner(conversationId, common.meta.cwd, title);
      const status = owner.status();
      if (target?.managed && target.nativeId !== status.sessionId) throw new Error('Existing Claude owner does not match the tracked identity.');
      const refresh = !contextReset && this.contextMode === 'archive' && target?.managed
        && (contextRefresh || target.imageProjectionVersion !== 1 && hasProjectedImages(common.messages));
      return { nativeId: status.sessionId, path: status.transcriptPath, kind: 'owner', title,
        packetVersion: this.contextMode === 'archive' ? 2 : 1,
        ...(this.contextMode === 'archive' ? { archiveVersion: 2, imageProjectionVersion: 1 } : {}),
        ...(contextReset ? { contextReset: true } : {}), ...(refresh ? { contextRefresh: true } : {}) };
    }
    await this.codex();
    if (contextRefresh && target) await this.assertOwnedSnapshot(target);
    return { nativeId, path: codexProjectionPath(this.codexHome, common, nativeId), kind: 'snapshot', title,
      packetVersion: this.contextMode === 'archive' ? 2 : 1,
      ...(this.contextMode === 'archive' ? { archiveVersion: 2, imageProjectionVersion: 1 } : {}) };
  }

  async needsMaintenance(record, data) {
    importedClaudeOriginal(record);
    if (!record.managed || this.contextMode !== 'archive') return false;
    const needsImages = record.packetVersion === 2 && record.imageProjectionVersion !== 1
      && data?.common?.messages && hasProjectedImages(data.common.messages);
    if (record.side === 'codex') return needsImages && record.kind === 'snapshot' ? 'images' : false;
    if (record.side !== 'claude') return false;
    const owner = await this.owner(record.conversationId, record.cwd, record.title);
    if (record.packetVersion !== 2) {
      if (!owner.status().coldResetEligible) throw new Error('Inline context migration requires a fresh cold native owner; active input channels were preserved.');
      return true;
    }
    await this.activateNormalOwner(record);
    return needsImages ? 'images' : false;
  }

  async activateNormalOwner(record) {
    assertNotImportedOriginalWrite(record);
    const entry = this.owners.get(record.conversationId);
    if (!entry) {
      const owner = await this.owner(record.conversationId, record.cwd, record.title, { forceNormal: true });
      if (owner.status().sessionId !== record.nativeId) throw new Error('Normal owner startup changed the promoted native identity.');
      await owner.connect();
      return;
    }
    if (!entry.maintenanceOnly) {
      await entry.owner.connect();
      return;
    }
    const status = entry.owner.status();
    if (status.reset || status.pending || status.nativeState !== 'idle' || status.backgroundTasks?.length)
      throw new Error('Cold native owner is not ready for normal input; its process was preserved.');
    // This process has never exposed a user-input route. Wait for its real exit
    // before restoring the original normal user/project settings in a new one.
    await entry.owner.close();
    this.owners.delete(record.conversationId);
    const owner = await this.owner(record.conversationId, record.cwd, record.title, { forceNormal: true });
    if (owner.status().sessionId !== record.nativeId) throw new Error('Normal owner startup changed the promoted native identity.');
    await owner.connect();
  }

  async completePromotion(record) {
    importedClaudeOriginal(record);
    if (record.side === 'claude' && record.managed && this.contextMode === 'archive') await this.activateNormalOwner(record);
  }

  async resolveAppliedRecord(record, pending) {
    importedClaudeOriginal(record);
    if (record.side !== 'claude' || !record.contextReset) return record;
    const owner = await this.owner(record.conversationId, record.cwd, record.title);
    const status = owner.status(), reset = status.lastReset;
    if (reset?.operationId !== pending.operationId) return record;
    if (reset.sessionId !== status.sessionId || reset.remoteId !== status.remoteId
        || ![reset.previousSessionId, reset.sessionId].includes(record.nativeId)) throw new Error('Applied context reset has an inconsistent native identity.');
    return { ...record, nativeId: reset.sessionId, path: status.transcriptPath };
  }

  async packet(record, common, pending) {
    const encode = record.packetVersion === 2 ? encodeArchivedContextPacket : encodeContextPacket;
    return encode({ root: this.root, archiveVersion: record.archiveVersion ?? 1,
      imageProjectionVersion: record.imageProjectionVersion ?? 0,
      maxNativeBytes: this.nativeHistoryMaxBytes,
      ...(record.contextRefresh ? { historyPrefixCount: pending.previous.count } : {}),
      messages: record.contextRefresh ? common.messages : common.messages.slice(pending.previous.count), key: this.key,
      conversationId: record.conversationId, sourceSide: 'codex', targetSessionId: record.nativeId,
      operationId: pending.operationId, previousDigest: pending.previous.digest });
  }
  async operationApplied(record, pending) {
    assertNotImportedOriginalWrite(record);
    if (record.side === 'claude') {
      const owner = await this.owner(record.conversationId, record.cwd, record.title);
      if (record.contextReset) {
        const reset = owner.status().lastReset;
        if (reset?.operationId !== pending.operationId) return false;
        const resolved = await this.resolveAppliedRecord(record, pending);
        const applied = await owner.hasAppend({ operationId: reset.restoreOperationId, content: await this.packet(resolved, pending.common, pending) });
        if (applied && !this.owners.get(record.conversationId)?.maintenanceOnly) await owner.connect();
        return applied;
      }
      const applied = await owner.hasAppend({ operationId: pending.operationId, content: await this.packet(record, pending.common, pending) });
      // A crash can happen after persistence but before Remote Control was
      // registered. Recover registration without submitting the packet again.
      if (applied && !this.owners.get(record.conversationId)?.maintenanceOnly) await owner.connect();
      return applied;
    }
    if (!await exists(record.path)) return false;
    await this.safePath(record.path, this.codexHome);
    const data = await decodeOwnedCodexHistoryWithArchives({ text: (await snapshot(record.path)).text, conversationId: record.conversationId,
      targetSessionId: record.nativeId, key: this.key, archiveRoot: this.root });
    if (data.operationId !== pending.operationId || data.bootstrapDigest !== pending.checkpoint.digest) throw new Error('Existing projection does not match the durable handoff intent.');
    // Registration may have been interrupted after exclusive file publication.
    await registerCodexProjection({ client: await this.codex(), path: record.path, id: record.nativeId, cwd: record.cwd, title: record.title });
    return true;
  }
  async apply(record, common, pending) {
    assertNotImportedOriginalWrite(record);
    if (record.side === 'claude') {
      let owner = await this.owner(record.conversationId, record.cwd, record.title);
      if (record.contextReset) {
        await owner.resetContext({ operationId: pending.operationId,
          buildContent: sessionId => this.packet({ ...record, nativeId: sessionId }, common, pending) });
        return;
      }
      if (this.owners.get(record.conversationId)?.maintenanceOnly) {
        await this.activateNormalOwner(record);
        owner = await this.owner(record.conversationId, record.cwd, record.title);
      }
      await owner.append({ operationId: pending.operationId, content: await this.packet(record, common, pending) });
      return;
    }
    let contextContent, resolveArchive;
    if (record.packetVersion === 2) {
      contextContent = await encodeArchivedContextPacket({ root: this.root, common, key: this.key, archiveVersion: record.archiveVersion ?? 1,
        imageProjectionVersion: record.imageProjectionVersion ?? 0,
        maxNativeBytes: this.nativeHistoryMaxBytes,
        conversationId: record.conversationId, targetSessionId: record.nativeId, sourceSide: 'claude', operationId: pending.operationId });
      resolveArchive = await prepareArchiveResolver({ root: this.root, contents: [contextContent], key: this.key,
        conversationId: record.conversationId, targetSessionId: record.nativeId });
    }
    const canonical = buildOwnedCodexCommon({ canonical: common, key: this.key, conversationId: record.conversationId,
      targetSessionId: record.nativeId, operationId: pending.operationId, contextContent, resolveArchive });
    await createCodexProjection({ client: await this.codex(), codexHome: this.codexHome, common: canonical,
      id: record.nativeId, title: record.title, historyMode: 'paginated' });
  }

  async assertIdle(record) {
    importedClaudeOriginal(record);
    if (record.side === 'claude') {
      if (!record.managed) {
        if ((await this.inspect(record)).incompleteTail) throw new Error('Claude turn is still running.');
        return;
      }
      const owner = await this.owner(record.conversationId, record.cwd, record.title);
      if (owner.status().nativeState !== 'idle') throw new Error('Claude turn is still running.');
      return;
    }
    const client = await this.codex();
    const { thread } = await client.request('thread/read', { threadId: record.nativeId, includeTurns: false });
    if (thread.status?.type === 'active') throw new Error('Codex destination is active.');
    if (record.managed && !thread.path.includes(`${sep}archived_sessions${sep}`)) await client.resumeThread(record.nativeId, { excludeTurns: true });
  }
  async assertOwnedSnapshot(record) {
    if (record.status === 'dependency-anchor') throw dependencyAnchorGuard('Dependency anchor cannot be retired.');
    if (record.side !== 'codex' || record.kind !== 'snapshot' || !record.managed || !record.verified) throw new Error('Only verified owned Codex snapshots can be retired.');
    await this.inspect(record); // Verifies the signed bootstrap, even after native rollover.
    await this.assertCodexIndependent(record, 'Owned projection');
  }
  assertDependencyAnchorRecord(record, { saved = false } = {}) {
    if (record.side !== 'codex' || record.kind !== 'snapshot' || record.managed !== true || record.verified !== true
        || !UUID.test(record.nativeId) || typeof record.cwd !== 'string' || !record.cwd
        || typeof record.path !== 'string' || !record.path
        || !Number.isSafeInteger(record.checkpoint?.count) || record.checkpoint.count < 1
        || !/^[a-f0-9]{64}$/.test(record.checkpoint?.digest ?? '')
        || saved && record.status !== 'dependency-anchor')
      throw dependencyAnchorGuard('Dependency anchor requires a verified owned Codex snapshot and canonical checkpoint.');
  }
  async dependencyAnchorRawProof(path, record) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'nlink'].every(key => a[key] === b[key]);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1
          || before.size > 64 * 1024 * 1024) throw dependencyAnchorGuard('Dependency anchor transcript is not a bounded owned regular file.');
      const digest = createHash('sha256'), chunks = [];
      let length = 0, headerLength = 0, endedHeader = false, lastByte = null;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        length += chunk.length;
        if (length > before.size) throw dependencyAnchorGuard('Dependency anchor transcript grew during verification.');
        digest.update(chunk); lastByte = chunk.at(-1);
        if (!endedHeader) {
          const newline = chunk.indexOf(10), part = newline < 0 ? chunk : chunk.subarray(0, newline);
          headerLength += part.length;
          if (headerLength > 64 * 1024 * 1024) throw dependencyAnchorGuard('Dependency anchor transcript header exceeds its byte limit.');
          chunks.push(part); endedHeader = newline >= 0;
        }
      }
      const after = await file.stat(), current = await lstat(path);
      if (!sameStat(before, after) || !sameStat(after, current) || length !== before.size || lastByte !== 10)
        throw dependencyAnchorGuard('Dependency anchor transcript changed during verification.');
      let row;
      try { row = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw dependencyAnchorGuard('Dependency anchor transcript header is malformed.'); }
      if (row.type !== 'session_meta' || row.payload?.id !== record.nativeId || row.payload?.cwd !== record.cwd)
        throw dependencyAnchorGuard('Dependency anchor transcript identity or working directory changed.');
      return { path, hash: digest.digest('hex'), bytes: before.size };
    } finally { await file.close(); }
  }
  async dependencyAnchorSnapshot(record) {
    const client = await this.codex();
    const readMetadata = async () => {
      const { thread } = await client.request('thread/read', { threadId: record.nativeId, includeTurns: false });
      if (thread?.id !== record.nativeId || typeof thread.cwd !== 'string' || typeof thread.path !== 'string'
          || await realpath(thread.cwd) !== record.cwd)
        throw dependencyAnchorGuard('Dependency anchor native identity or working directory changed.');
      if (!['idle', 'notLoaded'].includes(thread.status?.type))
        throw dependencyAnchorGuard('Dependency anchor parent is active or its idle state is unverified.');
      return this.safePath(thread.path, this.codexHome);
    };
    const path = await readMetadata();
    if (path !== record.path) throw dependencyAnchorGuard('Dependency anchor native transcript path changed.');
    const before = await this.dependencyAnchorRawProof(path, record);
    const data = await this.inspect(record);
    if (data.nativeId !== record.nativeId || data.path !== path || data.common?.meta?.cwd !== record.cwd
        || data.incompleteTail !== false || data.common.messages.length !== record.checkpoint.count
        || data.digest !== record.checkpoint.digest || fingerprint(data.common) !== record.checkpoint.digest
        || !Number.isSafeInteger(data.bytes) || data.bytes < before.bytes)
      throw dependencyAnchorGuard('Dependency anchor canonical history changed or has an unfinished turn.');
    const latestPath = await readMetadata(), after = await this.dependencyAnchorRawProof(latestPath, record);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw dependencyAnchorGuard('Dependency anchor transcript changed during canonical verification.');
    return { raw: after, bytes: data.bytes };
  }
  async prepareDependencyAnchor(record) {
    return this.prepareDependencyAnchorFromInventory(record);
  }
  async prepareDependencyAnchors(records) {
    for (const record of records) this.assertDependencyAnchorRecord(record);
    const dependencies = await readCodexDependenciesForParents(await this.codex(), records.map(record => record.nativeId));
    const proofs = new Map();
    for (const record of records) proofs.set(record.id,
      await this.prepareDependencyAnchorFromInventory(record, dependencies.get(record.nativeId)));
    return proofs;
  }
  async prepareDependencyAnchorFromInventory(record, initialDependencies) {
    try {
      this.assertDependencyAnchorRecord(record);
      const client = await this.codex();
      const dependencies = initialDependencies ?? await readCodexDependencies(client, record.nativeId);
      if (!dependencies.length) return null;
      const proof = await this.dependencyAnchorSnapshot(record);
      const latest = await readCodexDependencies(client, record.nativeId);
      if (JSON.stringify(dependencies) !== JSON.stringify(latest)) throw dependencyAnchorGuard('Dependency anchor inventory changed during verification.');
      const after = await this.dependencyAnchorSnapshot(record);
      if (JSON.stringify(proof) !== JSON.stringify(after)) throw dependencyAnchorGuard('Dependency anchor parent changed during dependency verification.');
      return { dependencyIds: dependencies.map(value => value.id),
        dependencyAnchor: { version: 1, dependencies, raw: after.raw }, bytes: after.bytes };
    } catch (error) {
      if (error.message.startsWith('Codex dependency inventory: '))
        throw dependencyAnchorGuard(`Dependency anchor verification failed: ${error.message}`);
      throw error;
    }
  }
  async assertDependencyAnchor(record) {
    try {
      this.assertDependencyAnchorRecord(record, { saved: true });
      const anchor = record.dependencyAnchor;
      if (anchor?.version !== 1 || !Array.isArray(anchor.dependencies) || !anchor.dependencies.length
          || !Array.isArray(record.dependencyIds) || record.dependencyIds.length !== anchor.dependencies.length
          || anchor.raw?.path !== record.path || !/^[a-f0-9]{64}$/.test(anchor.raw?.hash ?? '')
          || !Number.isSafeInteger(anchor.raw?.bytes) || anchor.raw.bytes < 1 || anchor.raw.bytes > 64 * 1024 * 1024)
        throw dependencyAnchorGuard('Dependency anchor saved proof is malformed.');
      let previous = '';
      for (const [index, edge] of anchor.dependencies.entries()) {
        if (!UUID.test(edge?.id) || edge.id === record.nativeId || edge.parentId !== record.nativeId
            || !['spawn', 'fork'].includes(edge.kind) || previous && previous.localeCompare(edge.id) >= 0
            || record.dependencyIds[index] !== edge.id)
          throw dependencyAnchorGuard('Dependency anchor saved dependency identities are malformed.');
        previous = edge.id;
      }
      const proof = await this.dependencyAnchorSnapshot(record);
      if (JSON.stringify(anchor.raw) !== JSON.stringify(proof.raw)) throw dependencyAnchorGuard('Dependency anchor saved transcript bytes changed.');
      if (proof.bytes !== record.bytes) throw dependencyAnchorGuard('Dependency anchor aggregate storage changed.');
      return { bytes: proof.bytes };
    } catch (error) {
      throw error;
    }
  }
  async assertCodexIndependent(record, label) {
    if (await exists(join(this.codexHome, 'sessions', record.nativeId))) throw new Error(`${label} has auxiliary data; retirement requires dependency verification.`);
    const client = await this.codex();
    // A freshly forked thread can be loaded before thread/list exposes its
    // persisted row. Check the live owner as well as both stored inventories.
    let loadedCursor; const loadedCursors = new Set();
    do {
      const page = await client.request('thread/loaded/list', { limit: 100, ...(loadedCursor ? { cursor: loadedCursor } : {}) });
      for (const id of page.data) {
        if (id === record.nativeId) continue;
        const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
        if (thread.id !== id) throw new Error('Loaded Codex dependency identity changed.');
        if (thread.forkedFromId === record.nativeId) throw new Error(`${label} has a dependent fork.`);
        if (thread.source?.subAgent?.thread_spawn?.parent_thread_id === record.nativeId)
          throw new Error(`${label} has dependent threads.`);
      }
      loadedCursor = page.nextCursor;
      if (loadedCursor && loadedCursors.has(loadedCursor)) throw new Error('Loaded Codex dependency pagination repeated.');
      if (loadedCursor) loadedCursors.add(loadedCursor);
    } while (loadedCursor);
    for (const archived of [false, true]) {
      if ((await client.request('thread/list', { ancestorThreadId: record.nativeId, archived, sourceKinds: kinds, limit: 1 })).data.length) throw new Error(`${label} has dependent threads.`);
      let cursor;
      do {
        const page = await client.request('thread/list', { archived, sourceKinds: kinds, limit: 100, ...(cursor ? { cursor } : {}) });
        for (const value of page.data) {
          if (value.id === record.nativeId) continue;
          if ((await client.request('thread/read', { threadId: value.id, includeTurns: false })).thread.forkedFromId === record.nativeId) throw new Error(`${label} has a dependent fork.`);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
  }
  async originalArchiveSnapshot(record) {
    if (record.side !== 'codex' || record.kind !== 'original' || record.managed !== false || record.verified !== true
        || !['current', 'original'].includes(record.status) || !UUID.test(record.nativeId)
        || !Number.isSafeInteger(record.checkpoint?.count) || record.checkpoint.count < 1
        || !/^[a-f0-9]{64}$/.test(record.checkpoint?.digest ?? ''))
      throw new Error('Only verified unmanaged Codex originals with a saved checkpoint can be archived.');
    const client = await this.codex();
    const readMetadata = async () => {
      const { thread } = await client.request('thread/read', { threadId: record.nativeId, includeTurns: false });
      if (thread.id !== record.nativeId || !record.cwd || await realpath(thread.cwd) !== record.cwd)
        throw new Error('Codex original identity or working directory changed; it was not archived.');
      if (!['idle', 'notLoaded'].includes(thread.status?.type))
        throw new Error('Codex original is active or its idle state is unverified; it was not archived.');
      return { thread, path: await this.safePath(thread.path, this.codexHome) };
    };
    const initial = await readMetadata();
    const before = await snapshot(initial.path);
    if (before.rows[0]?.type !== 'session_meta' || before.rows[0].payload?.id !== record.nativeId)
      throw new Error('Codex original transcript identity changed; it was not archived.');
    const data = await this.inspect(record);
    if (data.common.meta.cwd !== record.cwd || data.nativeId !== record.nativeId || data.path !== initial.path
        || data.incompleteTail || data.common.messages.length !== record.checkpoint.count || data.digest !== record.checkpoint.digest)
      throw new Error('Codex original history changed or has an unfinished turn; it was not archived.');
    const latest = await readMetadata();
    if (latest.path !== initial.path || (await snapshot(latest.path)).hash !== before.hash)
      throw new Error('Codex original changed during archive preflight; it was not archived.');
    return { path: latest.path, hash: before.hash };
  }
  async assertCanArchiveOriginal(record) {
    const before = await this.originalArchiveSnapshot(record);
    await this.assertCodexIndependent(record, 'Codex original');
    const after = await this.originalArchiveSnapshot(record);
    if (before.path !== after.path || before.hash !== after.hash)
      throw new Error('Codex original changed during dependency verification; it was not archived.');
    return after;
  }
  async archiveOriginal(record) {
    const before = await this.assertCanArchiveOriginal(record);
    const client = await this.codex();
    if (!before.path.includes(`${sep}archived_sessions${sep}`))
      await client.request('thread/archive', { threadId: record.nativeId });
    // The native API owns the move. Verify its result without replacing bytes,
    // adopting ownership, or enabling the original for snapshot deletion.
    const after = await this.originalArchiveSnapshot(record);
    if (!after.path.includes(`${sep}archived_sessions${sep}`) || after.hash !== before.hash)
      throw new Error('Codex original archive outcome changed; native history was preserved for inspection.');
    return { path: after.path };
  }
  async assertArchiveReplacement(original, replacement, title) {
    const client = await this.codex();
    if (!replacement.managed || !replacement.verified || replacement.status !== 'current'
        || replacement.kind !== 'snapshot' || replacement.side !== 'codex' || original.nativeId === replacement.nativeId)
      throw originalArchiveGuard('Original archive requires a verified independent current Codex replacement.');
    for (const record of [original, replacement]) {
      const { thread } = await client.request('thread/read', { threadId: record.nativeId, includeTurns: false });
      if (thread.id !== record.nativeId || thread.name !== title || await realpath(thread.cwd) !== record.cwd
          || !['idle', 'notLoaded'].includes(thread.status?.type))
        throw originalArchiveGuard('Original archive title, identity, cwd or idle state does not match its replacement.');
    }
  }
  async readOriginalArchiveTree(record) {
    const client = await this.codex();
    if (!['0.155.0-alpha.16.4', '0.158.0-alpha.2.1'].includes(this.codexNativeVersion))
      throw originalArchiveGuard('Preserved original archive requires a validated native cascade-archive version.');
    return snapshotOriginalArchiveTree({ client, codexHome: this.codexHome, parentId: record.nativeId, cwd: record.cwd,
      safePath: path => this.safePath(path, this.codexHome) });
  }
  async prepareOriginalArchiveTree(record) {
    const original = await this.originalArchiveSnapshot(record);
    const proof = await this.readOriginalArchiveTree(record);
    compareOriginalArchiveTree(proof, await this.readOriginalArchiveTree(record));
    const after = await this.originalArchiveSnapshot(record);
    if (original.path !== after.path || original.hash !== after.hash || proof.members[0].hash !== after.hash)
      throw originalArchiveGuard('Codex original changed while preparing its preserved archive tree.');
    return proof;
  }
  async archiveOriginalTree(record, proof, { allowWrite = false, beforeDispatch } = {}) {
    const original = await this.originalArchiveSnapshot(record);
    const before = await this.readOriginalArchiveTree(record);
    const alreadyArchived = original.path.includes(`${sep}archived_sessions${sep}`);
    compareOriginalArchiveTree(proof, before, { archivedOutcome: alreadyArchived });
    if (!alreadyArchived) {
      if (!allowWrite) throw originalArchiveGuard('Original archive request outcome is unknown; no native request was repeated.');
      // Re-enumerate immediately before the native cascade. Any unexpected new
      // fork, child, activity or byte change prevents dispatch.
      compareOriginalArchiveTree(proof, await this.readOriginalArchiveTree(record));
      if (typeof beforeDispatch !== 'function') throw originalArchiveGuard('Original archive dispatch requires its durable intent callback.');
      await beforeDispatch();
      await (await this.codex()).request('thread/archive', { threadId: record.nativeId });
    }
    const after = await this.readOriginalArchiveTree(record);
    compareOriginalArchiveTree(proof, after, { archivedOutcome: true });
    const confirmed = await this.originalArchiveSnapshot(record);
    if (!confirmed.path.includes(`${sep}archived_sessions${sep}`) || confirmed.hash !== original.hash)
      throw originalArchiveGuard('Codex original archive changed its history; evidence was preserved.');
    return { path: confirmed.path, archivedTree: after };
  }
  async hide(record) {
    if (record.status === 'dependency-anchor') throw dependencyAnchorGuard('Dependency anchor cannot be hidden.');
    await this.assertIdle(record); await this.assertOwnedSnapshot(record);
    const client = await this.codex();
    let { thread } = await client.request('thread/read', { threadId: record.nativeId, includeTurns: false });
    if (!thread.path.includes(`${sep}archived_sessions${sep}`)) await client.request('thread/archive', { threadId: record.nativeId });
    ({ thread } = await client.request('thread/read', { threadId: record.nativeId, includeTurns: false }));
    return { path: thread.path };
  }
  async remove(record) {
    if (record.status === 'dependency-anchor') throw dependencyAnchorGuard('Dependency anchor cannot be deleted.');
    await this.assertIdle(record); await this.assertOwnedSnapshot(record);
    await (await this.codex()).request('thread/delete', { threadId: record.nativeId });
  }
  async recordExists(record) {
    if (record.side !== 'codex') return exists(record.path);
    try { await (await this.codex()).request('thread/read', { threadId: record.nativeId, includeTurns: false }); return true; }
    catch (error) { if (/not found|no rollout|does not exist/i.test(error.message)) return false; throw error; }
  }

  async ownedNativeIds() {
    const known = new Set();
    const directory = join(this.root, 'owners');
    let names;
    try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return known; throw error; }
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = await readJSON(join(directory, name));
      if (record.version !== 1 || !UUID.test(record.sessionId)) throw new Error('Invalid persisted native owner identity.');
      known.add(`claude:${record.sessionId}`);
      for (const id of [record.retainedGeneration?.sessionId, record.reset?.previous?.sessionId, record.reset?.targetSessionId]) {
        if (id === undefined) continue;
        if (!UUID.test(id)) throw new Error('Invalid retained native owner identity.');
        known.add(`claude:${id}`);
      }
    }
    return known;
  }
  async close() {
    for (const entry of this.owners.values()) if (!entry.owner.status().closed) await entry.owner.close();
    if (this.client) await this.client.close();
    this.client = null;
  }
}

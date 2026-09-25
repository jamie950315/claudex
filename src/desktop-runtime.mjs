import { randomBytes } from 'node:crypto';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { lstat, realpath, readFile, access, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { hash, privateDirectory, publishExclusive, readJSON, snapshot, withLock } from './storage.mjs';
import { CodexWebSocketClient, inspectCodexSocket } from './codex-websocket.mjs';
import { ClaudeOwner } from './claude-owner.mjs';
import { decodeClaude } from './claude.mjs';
import { decodeOwnedClaudeHistory, completedClaudePrefix } from './owned-claude-history.mjs';
import { buildOwnedCodexCommon, exportOwnedCodexHistory, decodeOwnedCodexHistoryWithArchives } from './owned-codex-history.mjs';
import { exportNativeHistory } from './native-history.mjs';
import { encodeContextPacket } from './context-packet.mjs';
import { encodeArchivedContextPacket } from './context-archive.mjs';
import { prepareArchiveResolver } from './context-packet-reader.mjs';
import { assertComplete, fingerprint } from './history.mjs';
import { isSupportedCodexVersion } from './codex-versions.mjs';
import { codexProjectionPath, createCodexProjection, registerCodexProjection } from './codex-projection.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const kinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }

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
  constructor({ root, codexHome, claudeHome, claudeBinary = 'claude', clientFactory, ownerFactory, ownerOptions = {}, contextMode = 'inline', onEvent = () => {} }) {
    if (!['inline', 'archive'].includes(contextMode)) throw new Error('Unsupported Desktop context mode.');
    this.root = resolve(root); this.codexHome = resolve(codexHome); this.claudeHome = resolve(claudeHome);
    this.claudeBinary = claudeBinary; this.clientFactory = clientFactory; this.ownerFactory = ownerFactory;
    this.contextMode = contextMode;
    this.ownerOptions = ownerOptions; this.onEvent = onEvent; this.owners = new Map();
    this.adapters = Object.fromEntries(['codex', 'claude'].map(side => [side, {
      inspect: record => this.inspect({ ...record, side }),
      plan: input => this.plan(side, input), apply: (record, common, pending) => this.apply(record, common, pending),
      operationApplied: (record, pending) => this.operationApplied(record, pending),
      assertIdle: record => this.assertIdle(record), hide: record => this.hide(record), remove: record => this.remove(record),
      exists: record => this.recordExists(record),
      needsMaintenance: record => this.needsMaintenance(record),
      resolveAppliedRecord: (record, pending) => this.resolveAppliedRecord(record, pending),
      completePromotion: record => this.completePromotion(record),
    }]));
    Object.assign(this.adapters.codex, {
      assertCanArchiveOriginal: record => this.assertCanArchiveOriginal(record),
      archiveOriginal: record => this.archiveOriginal(record),
    });
  }
  async initialize() {
    this.root = await privateDirectory(this.root);
    [this.codexHome, this.claudeHome] = await Promise.all([realpath(this.codexHome), realpath(this.claudeHome)]);
    this.key = await persistentPacketKey(this.root);
    return this;
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
      if (manifest.transportMode !== undefined || !isSupportedCodexVersion(manifest.cliVersion) || !manifest.socketPath)
        throw new Error('Shared Codex Desktop backend is not ready or has an invalid identity.');
      const socket = await inspectCodexSocket(manifest.socketPath);
      if (socket.socketStat.dev !== manifest.socketIdentity?.dev || socket.socketStat.ino !== manifest.socketIdentity?.ino) throw new Error('Shared Codex socket identity changed.');
      this.client = new CodexWebSocketClient({ socketPath: manifest.socketPath });
    }
    try {
      const initialized = await this.client.initialize();
      if (initialized.codexHome && await realpath(initialized.codexHome) !== this.codexHome) throw new Error('Shared backend uses a different Codex home.');
      this.client.on?.('notification', event => this.onEvent({ type: 'codex_notification', event }));
      return this.client;
    } catch (error) { await this.client.close(); this.client = null; throw error; }
  }

  async owner(conversationId, cwd, title, { forceNormal = false } = {}) {
    let entry = this.owners.get(conversationId);
    if (entry) {
      if (entry.error) throw entry.error;
      return entry.owner;
    }
    const saved = this.contextMode === 'archive'
      ? await readJSON(join(this.root, 'owners', `${hash(conversationId)}.json`), null) : null;
    if (forceNormal && saved?.reset) throw new Error('A pending native context reset must be restored before a normal owner starts.');
    const maintenanceOnly = !forceNormal && Boolean(saved?.remoteId);
    const settings = { root: this.root, conversationId, cwd, claudeHome: this.claudeHome, title,
      deferRemoteConnection: maintenanceOnly, connectAfterReset: !maintenanceOnly,
      options: { ...this.ownerOptions, pathToClaudeCodeExecutable: this.claudeBinary },
      onEvent: event => this.onEvent({ type: 'claude_notification', conversationId, event }) };
    const owner = this.ownerFactory ? this.ownerFactory(settings) : new ClaudeOwner(settings);
    entry = { owner, error: null, maintenanceOnly }; this.owners.set(conversationId, entry);
    try { await owner.start(); return owner; }
    catch (error) { entry.error = error; throw error; } // Retain live handles on a busy startup failure.
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
    const walk = async directory => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.includes(nativeId) || !entry.name.endsWith('.jsonl')) continue;
        const row = await header(path);
        if (row.type !== 'session_meta' || row.payload?.id !== nativeId) continue;
        const info = await lstat(path); const identity = `${info.dev}:${info.ino}`;
        if (!seen.has(identity)) { bytes += info.size; seen.add(identity); }
        if (path === currentPath) foundCurrent = true;
      }
    };
    await walk(join(this.codexHome, 'sessions'));
    await walk(join(this.codexHome, 'archived_sessions'));
    if (!foundCurrent || !Number.isSafeInteger(bytes)) throw new Error('Owned rollout storage could not be counted safely.');
    return bytes;
  }

  async inspect(record) {
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
      const data = record.managed
        ? await exportOwnedCodexHistory({ client, targetSessionId: nativeId, conversationId: record.conversationId, cwd, key: this.key, completedPrefix: true, archiveRoot: this.root })
        : await exportNativeHistory({ client, threadId: nativeId, cwd, completedPrefix: true });
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
    const resolveArchive = record.managed ? await prepareArchiveResolver({ root: this.root,
      contents: data.rows.filter(row => row.type === 'user').map(row => row.message?.content),
      conversationId: record.conversationId, targetSessionId: record.nativeId, key: this.key }) : undefined;
    const prefix = completedClaudePrefix({ text: data.text, conversationId: record.conversationId, sessionId: record.nativeId,
      ...(record.managed ? { key: this.key, resolveArchive } : {}) });
    const parsed = record.managed
      ? decodeOwnedClaudeHistory({ text: prefix.text, conversationId: record.conversationId, sessionId: record.nativeId, key: this.key, resolveArchive,
        resetBootstrap: !retainedData ? owner.status().lastReset : undefined })
      : { common: decodeClaude(prefix.text) };
    assertComplete(parsed.common);
    parsed.common.meta.cwd = await realpath(parsed.common.meta.cwd);
    if (!UUID.test(parsed.common.meta.id) || record.nativeId && parsed.common.meta.id !== record.nativeId) throw new Error('Claude session identity changed.');
    return { ...parsed, nativeId: parsed.common.meta.id, path, bytes: data.bytes, digest: fingerprint(parsed.common), incompleteTail: prefix.incompleteTail };
  }

  async plan(side, { conversationId, nativeId, common, title, target, contextReset = false }) {
    if (side === 'claude') {
      const owner = await this.owner(conversationId, common.meta.cwd, title);
      const status = owner.status();
      if (target?.managed && target.nativeId !== status.sessionId) throw new Error('Existing Claude owner does not match the tracked identity.');
      return { nativeId: status.sessionId, path: status.transcriptPath, kind: 'owner', title,
        packetVersion: this.contextMode === 'archive' ? 2 : 1,
        ...(this.contextMode === 'archive' ? { archiveVersion: 2 } : {}), ...(contextReset ? { contextReset: true } : {}) };
    }
    await this.codex();
    return { nativeId, path: codexProjectionPath(this.codexHome, common, nativeId), kind: 'snapshot', title,
      packetVersion: this.contextMode === 'archive' ? 2 : 1, ...(this.contextMode === 'archive' ? { archiveVersion: 2 } : {}) };
  }

  async needsMaintenance(record) {
    if (record.side !== 'claude' || !record.managed || this.contextMode !== 'archive') return false;
    const owner = await this.owner(record.conversationId, record.cwd, record.title);
    if (record.packetVersion !== 2) {
      if (!owner.status().coldResetEligible) throw new Error('Inline context migration requires a fresh cold native owner; active input channels were preserved.');
      return true;
    }
    await this.activateNormalOwner(record);
    return false;
  }

  async activateNormalOwner(record) {
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
    if (record.side === 'claude' && this.contextMode === 'archive') await this.activateNormalOwner(record);
  }

  async resolveAppliedRecord(record, pending) {
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
      messages: common.messages.slice(pending.previous.count), key: this.key,
      conversationId: record.conversationId, sourceSide: 'codex', targetSessionId: record.nativeId,
      operationId: pending.operationId, previousDigest: pending.previous.digest });
  }
  async operationApplied(record, pending) {
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
    if (record.side !== 'codex' || record.kind !== 'snapshot' || !record.managed || !record.verified) throw new Error('Only verified owned Codex snapshots can be retired.');
    await this.inspect(record); // Verifies the signed bootstrap, even after native rollover.
    await this.assertCodexIndependent(record, 'Owned projection');
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
  async hide(record) {
    await this.assertIdle(record); await this.assertOwnedSnapshot(record);
    const client = await this.codex();
    let { thread } = await client.request('thread/read', { threadId: record.nativeId, includeTurns: false });
    if (!thread.path.includes(`${sep}archived_sessions${sep}`)) await client.request('thread/archive', { threadId: record.nativeId });
    ({ thread } = await client.request('thread/read', { threadId: record.nativeId, includeTurns: false }));
    return { path: thread.path };
  }
  async remove(record) {
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

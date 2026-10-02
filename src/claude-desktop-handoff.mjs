import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { hash } from './storage.mjs';
import { readDesktopSessionMappings } from './desktop.mjs';
import { sessionPath } from './claude.mjs';
import { isDesktopTracked } from './desktop-enrollment.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const REMOTE = /^cse_[A-Za-z0-9_-]{1,200}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_TRANSCRIPT = 512 * 1024 * 1024;
const MAX_CANDIDATES = 4096;
const MAX_ACTIONS = 32;
const REVERIFY_MS = 60_000;
const ACTION_LIFETIME_MS = 15_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Claude Desktop handoff: ${message}`); };
const canonical = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value);
const checkpoint = value => object(value) && Number.isSafeInteger(value.count) && value.count > 0 && DIGEST.test(value.digest);
const identity = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'nlink', 'mode'].map(key => [key, String(stat[key])]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function privateRoot(root) {
  const stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o700n || await realpath(root) !== root)
    fail('state root must be a canonical private owned directory.');
  return identity(stat);
}

async function fileIdentity(path, { privateFile = false, maxBytes = MAX_TRANSCRIPT } = {}) {
  if (!canonical(path) || await realpath(path) !== path) fail('file path is not canonical.');
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || stat.nlink !== 1n
    || privateFile && (stat.mode & 0o7777n) !== 0o600n || stat.size > BigInt(maxBytes))
    fail('file must be bounded, owned and regular with the required permissions.');
  return identity(stat);
}

async function stableRead(path, { optional = false } = {}) {
  let before;
  try { before = await fileIdentity(path, { privateFile: true, maxBytes: MAX_METADATA }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!equal(identity(await file.stat({ bigint: true })), before)) fail('metadata changed before read.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== Number(before.size) || !equal(identity(await file.stat({ bigint: true })), before)
      || !equal(await fileIdentity(path, { privateFile: true, maxBytes: MAX_METADATA }), before)) fail('metadata changed while read.');
    let value, text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); value = JSON.parse(text); }
    catch { fail('metadata contains invalid JSON.'); }
    return { path, identity: before, value, text };
  } finally { await file.close(); }
}

async function unchanged(snapshot) {
  if (!equal(await fileIdentity(snapshot.path, { privateFile: true, maxBytes: MAX_METADATA }), snapshot.identity))
    fail('owner metadata changed during verification.');
}

async function prefixHash(path, before, bytes = Number(before.size)) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Number(before.size)) fail('original prefix length is invalid.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!equal(identity(await file.stat({ bigint: true })), before)) fail('transcript changed before hashing.');
    const digest = createHash('sha256'), buffer = Buffer.alloc(Math.min(1024 * 1024, bytes));
    for (let position = 0; position < bytes;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (!bytesRead) fail('transcript was truncated while hashing.');
      digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (!equal(identity(await file.stat({ bigint: true })), before) || !equal(await fileIdentity(path), before))
      fail('transcript changed while hashing.');
    return digest.digest('hex');
  } finally { await file.close(); }
}

function assertInspection(record, data, expected, cwd) {
  if (!object(data) || data.nativeId !== record.nativeId || data.path !== record.path || data.incompleteTail !== false
    || data.common?.meta?.cwd !== cwd || data.common?.messages?.length !== expected.count || data.digest !== expected.digest)
    fail(`session ${record.nativeId} no longer matches its complete saved checkpoint.`);
}

function candidates(state) {
  if (!object(state) || state.version !== 2 || !object(state.conversations) || !Array.isArray(state.records)) fail('invalid Desktop ledger.');
  if (state.pending != null) return [];
  const result = [];
  for (const current of state.records.filter(record => record.side === 'claude' && record.status === 'current'
    && isDesktopTracked(state.conversations[record.conversationId])
    && record.managed === true && record.verified === true && record.kind === 'owner')) {
    const originals = state.records.filter(record => record.conversationId === current.conversationId && record.side === 'claude'
      && record.status === 'original' && record.managed === false && record.kind === 'original' && record.verified === true);
    if (!originals.length) continue;
    if (originals.length !== 1) fail('a conversation has ambiguous superseded Claude originals.');
    const original = originals[0], conversation = state.conversations[current.conversationId];
    // An original superseded by a project move keeps its old project's Local
    // entry; it is not a same-project continuation and is never archived here.
    if (object(conversation) && original.cwd !== conversation.cwd && current.cwd === conversation.cwd
      && state.records.some(record => record.conversationId === current.conversationId && record.status === 'current'
        && record.relocation?.kind === 'codex-project-move' && record.relocation.originCwd === original.cwd)) continue;
    if (!object(conversation) || !UUID.test(conversation.id) || conversation.id !== current.conversationId
      || !UUID.test(current.nativeId) || !UUID.test(original.nativeId) || current.nativeId === original.nativeId
      || !canonical(conversation.cwd) || original.cwd !== conversation.cwd || current.cwd !== conversation.cwd
      || !canonical(original.path) || !canonical(current.path) || !checkpoint(original.checkpoint) || !checkpoint(conversation.canonical)
      || !equal(current.checkpoint, conversation.canonical) || original.checkpoint.count >= conversation.canonical.count
      || typeof conversation.title !== 'string' || !conversation.title.trim() || conversation.title.length > 4096
      || /[\x00-\x1f\x7f]/.test(conversation.title)) fail('replacement/original ledger identity is invalid or not a promoted continuation.');
    result.push({ original, current, conversation });
  }
  if (result.length > MAX_CANDIDATES || new Set(result.map(item => item.conversation.id)).size !== result.length)
    fail('candidate conversations are duplicated or exceed the safety bound.');
  return result.sort((a, b) => a.conversation.id.localeCompare(b.conversation.id));
}

async function writeManifest(root, actions, now, anchors = []) {
  const rootBefore = await privateRoot(root), path = join(root, 'desktop-handoff.json');
  const previous = await stableRead(path, { optional: true });
  if (previous && (!object(previous.value) || previous.value.version !== 1 || previous.value.kind !== 'claude-local-archive'
    || !Array.isArray(previous.value.actions) || previous.value.actions.length > MAX_ACTIONS
    || previous.value.anchors !== undefined && (!Array.isArray(previous.value.anchors) || previous.value.anchors.length > MAX_CANDIDATES)))
    fail('existing manifest is not owned handoff metadata.');
  const value = { version: 1, kind: 'claude-local-archive', generatedAt: actions.length ? now : null,
    expiresAt: actions.length ? now + ACTION_LIFETIME_MS : null, actions,
    anchorsUpdatedAt: anchors.length ? now : null, anchors };
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > MAX_METADATA) fail('manifest exceeds the byte limit.');
  if (previous?.text === text) return false;
  const recheck = async () => {
    const rootNow = await privateRoot(root);
    if (rootNow.dev !== rootBefore.dev || rootNow.ino !== rootBefore.ino) fail('state root changed during publication.');
    if (previous) await unchanged(previous);
    else {
      try { await lstat(path); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      fail('another publisher created the handoff manifest.');
    }
  };
  const temporary = join(root, `.desktop-handoff.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const temporaryIdentity = identity(await file.stat({ bigint: true }));
  let published = false;
  try {
    await file.writeFile(text); await file.sync(); await recheck();
    const current = await fileIdentity(temporary, { privateFile: true, maxBytes: MAX_METADATA });
    if (current.dev !== temporaryIdentity.dev || current.ino !== temporaryIdentity.ino) fail('temporary manifest identity changed.');
    await rename(temporary, path); published = true;
    const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } finally {
    await file.close();
    if (!published) {
      const current = await lstat(temporary, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current && String(current.dev) === temporaryIdentity.dev && String(current.ino) === temporaryIdentity.ino) await unlink(temporary);
    }
  }
}

/** Revoke presentation commands before explicit enrollment maintenance. This
 * uses only the owned private manifest, never a transcript or native mutation.
 * A later watcher publication rebuilds associations from active enrollments.
 */
export async function revokeClaudeDesktopHandoffActions({ root }) {
  return { changed: await writeManifest(root, [], Date.now(), []) };
}

function presentationAnchor(action) {
  return { conversationId: action.conversationId, localSessionId: action.localSessionId,
    nativeId: action.nativeId, replacementNativeId: action.replacement.nativeId,
    remoteId: action.remoteId, cwd: action.cwd, title: action.title };
}

/** Presentation associations never authorize archive actions. Existing evidence
 * may survive new turns and resets-in-progress only while every native identity
 * still matches. This path does not inspect, stat or hash either transcript and
 * cannot establish new associations or advance semantic checkpoints.
 */
async function retainPresentationAnchors({ root, desktopHome, state, anchors }) {
  if (!object(state) || state.version !== 2 || !object(state.conversations) || !Array.isArray(state.records)
    || !Array.isArray(anchors) || anchors.length > MAX_CANDIDATES) return [];
  const selected = [];
  for (const anchor of anchors) {
    if (!object(anchor) || !UUID.test(anchor.conversationId) || !UUID.test(anchor.nativeId) || !UUID.test(anchor.replacementNativeId)
      || !/^local_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(anchor.localSessionId)
      || !REMOTE.test(anchor.remoteId) || !canonical(anchor.cwd) || typeof anchor.title !== 'string'
      || !anchor.title.trim() || anchor.title.length > 4096
      || anchors.filter(other => other?.conversationId === anchor.conversationId).length !== 1) continue;
    const conversation = state.conversations[anchor.conversationId];
    const current = state.records.filter(record => record.conversationId === anchor.conversationId && record.side === 'claude'
      && record.status === 'current' && record.managed === true && record.kind === 'owner' && record.verified === true);
    const original = state.records.filter(record => record.conversationId === anchor.conversationId && record.side === 'claude'
      && record.status === 'original' && record.managed === false && record.kind === 'original' && record.verified === true);
    if (!isDesktopTracked(conversation) || conversation?.id !== anchor.conversationId || conversation.cwd !== anchor.cwd || current.length !== 1 || original.length !== 1
      || current[0].nativeId !== anchor.replacementNativeId || current[0].cwd !== anchor.cwd
      || original[0].nativeId !== anchor.nativeId || original[0].cwd !== anchor.cwd) continue;
    selected.push(anchor);
  }
  if (!selected.length) return [];
  let mappings;
  try {
    await privateRoot(join(root, 'owners'));
    mappings = await readDesktopSessionMappings(desktopHome, selected.map(anchor => anchor.nativeId));
  } catch { return []; } // Unknown or conflicting identity cannot support placement.
  const results = [], owners = [];
  for (const anchor of selected) {
    const mapping = mappings.get(anchor.nativeId.toLowerCase());
    if (mapping?.sessionId !== anchor.localSessionId || mapping.nativeId !== anchor.nativeId || mapping.cwd !== anchor.cwd) continue;
    try {
      const owner = await stableRead(join(root, 'owners', `${hash(anchor.conversationId)}.json`)), data = owner.value;
      if (!object(data) || data.version !== 1 || data.conversationId !== anchor.conversationId || data.sessionId !== anchor.replacementNativeId
        || data.cwd !== anchor.cwd || data.remoteId !== anchor.remoteId || data.registration !== 'registered') continue;
      owners.push(owner);
      results.push({ ...anchor, title: mapping.title });
    } catch { /* Missing or unreadable ownership evidence invalidates this anchor. */ }
  }
  try {
    for (const owner of owners) await unchanged(owner);
    const latest = await readDesktopSessionMappings(desktopHome, results.map(anchor => anchor.nativeId));
    return results.filter(anchor => {
      const mapping = latest.get(anchor.nativeId.toLowerCase());
      return mapping?.sessionId === anchor.localSessionId && mapping.nativeId === anchor.nativeId && mapping.cwd === anchor.cwd
        && mapping.title === anchor.title && results.filter(other => other.remoteId === anchor.remoteId
          || other.localSessionId === anchor.localSessionId || other.nativeId === anchor.nativeId).length === 1;
    });
  } catch { return []; }
}

/** Produce bounded, expiring archive intents under the coordinator's existing
 * single-writer ownership. This is NOT a Desktop writer lease: the consumer must
 * reread native Local state and its CLI mapping, match identity/title/activity,
 * require the predecessor idle, and invoke only the normal native archive action.
 * The caller checks the replacement's complete history and owner lifecycle.
 * No registry, original transcript, bridge checkpoint or retention state is
 * ever written here. Originals remain fixed recoverable sources, not backups.
 */
export function createClaudeDesktopHandoffPublisher({ root, desktopHome, inspect, now = () => Date.now() } = {}) {
  if (!canonical(root) || desktopHome != null && !canonical(desktopHome) || typeof inspect !== 'function')
    fail('canonical roots and a coordinator-owned inspection callback are required.');
  const verified = new Map();
  let running = false, cursor = 0;
  async function publish(state, { conversationIds } = {}) {
    if (running) fail('publication is already in progress.');
    running = true;
    let previousAnchors = [];
    try {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail('invalid publication clock.');
      const previousManifest = await stableRead(join(root, 'desktop-handoff.json'), { optional: true });
      previousAnchors = previousManifest?.value?.anchors ?? [];
      let scope = null;
      if (conversationIds !== undefined) {
        if (!(Array.isArray(conversationIds) || conversationIds instanceof Set)) fail('invalid conversation publication scope.');
        scope = new Set(conversationIds);
        if (scope.size > MAX_CANDIDATES || [...scope].some(id => typeof id !== 'string' || !UUID.test(id)))
          fail('invalid conversation publication scope.');
      }
      // Validate the complete candidate inventory and owner metadata even when
      // only one event-selected conversation may authorize new archive work.
      // Unselected cached entries remain hints, never republished authority.
      const selected = candidates(state), live = new Set(selected.map(item => item.conversation.id));
      for (const id of verified.keys()) if (!live.has(id)) verified.delete(id);
      if (state.pending != null) {
        verified.clear();
        const anchors = await retainPresentationAnchors({ root, desktopHome, state, anchors: previousAnchors });
        return { changed: await writeManifest(root, [], timestamp, anchors), actions: 0, anchors: anchors.length,
          acknowledged: [], deferred: 'pending' };
      }
      const mappings = await readDesktopSessionMappings(desktopHome, selected.map(item => item.original.nativeId));
      if (selected.length) await privateRoot(join(root, 'owners'));
      const ready = [], dirty = [], acknowledged = [];
      const remoteIds = new Set();
      let ownerTransition = false;
      for (const candidate of selected) {
        const { original, current, conversation } = candidate, id = conversation.id;
        const mapping = mappings.get(original.nativeId.toLowerCase());
        if (!mapping) { verified.delete(id); continue; } // Ordinary CLI originals have no Desktop row to archive.
        if (mapping.cwd !== conversation.cwd || mapping.title !== conversation.title) fail('original Desktop cwd or title differs from the logical conversation.');
        const ownerPath = join(root, 'owners', `${hash(id)}.json`);
        const owner = await stableRead(ownerPath), data = owner.value;
        if (!object(data) || data.version !== 1 || data.conversationId !== id || data.sessionId !== current.nativeId
          || data.cwd !== conversation.cwd || !canonical(data.claudeHome)
          || sessionPath(data.claudeHome, conversation.cwd, data.sessionId) !== current.path || data.registration !== 'registered'
          || !REMOTE.test(data.remoteId) || data.blocked) fail('replacement Remote Control owner identity or registration is invalid.');
        if (remoteIds.has(data.remoteId)) fail('replacement Remote Control identity is duplicated.');
        remoteIds.add(data.remoteId);
        if (data.pending != null || data.reset != null || data.displayTitleMigration != null) {
          verified.delete(id); ownerTransition = true; continue;
        }
        if (scope && !scope.has(id)) continue;
        const originalIdentity = await fileIdentity(original.path), currentIdentity = await fileIdentity(current.path);
        const hint = JSON.stringify({ original, current, conversation, mapping, ownerIdentity: owner.identity, originalIdentity, currentIdentity });
        const prior = verified.get(id);
        const item = { ...candidate, mapping, owner, originalIdentity, currentIdentity, hint, prior };
        const unexpiredScopedAction = !scope || previousManifest?.value?.expiresAt > timestamp
          && previousManifest.value.generatedAt <= timestamp
          && previousManifest.value.actions?.some(action => action.operationId === prior?.action.operationId);
        if (prior?.hint === hint && timestamp - prior.verifiedAt < REVERIFY_MS && timestamp >= prior.verifiedAt
          && unexpiredScopedAction) ready.push(prior);
        else dirty.push(item);
      }
      if (ownerTransition) {
        verified.clear();
        const anchors = await retainPresentationAnchors({ root, desktopHome, state, anchors: previousAnchors });
        return { changed: await writeManifest(root, [], now(), anchors), actions: 0, anchors: anchors.length,
          acknowledged: [], deferred: 'owner_transition' };
      }
      // Bound each poll to one full history verification, retaining fair progress
      // across many originals. File observations select work, never checkpoints.
      if (dirty.length) {
        // Revoke the previous operation before a potentially slow read. New
        // activity cannot leave yesterday's archive authority actionable while
        // the newly observed histories are still being verified.
        const anchors = await retainPresentationAnchors({ root, desktopHome, state, anchors: previousAnchors });
        await writeManifest(root, [], now(), anchors);
        const item = dirty[cursor % dirty.length]; cursor++;
        const { original, current, conversation, mapping, owner, originalIdentity, currentIdentity, prior } = item;
        const before = Number(originalIdentity.size);
        const originalData = await inspect(original);
        assertInspection(original, originalData, original.checkpoint, conversation.cwd);
        const currentData = await inspect(current);
        assertInspection(current, currentData, conversation.canonical, conversation.cwd);
        if (!equal(await fileIdentity(original.path), originalIdentity) || !equal(await fileIdentity(current.path), currentIdentity))
          throw Object.assign(new Error('Claude Desktop handoff: native history changed during handoff verification.'),
            { code: 'CLAUDEX_HANDOFF_HISTORY_CHANGED', conversationId: conversation.id,
              title: typeof conversation.title === 'string' ? conversation.title.slice(0, 200) : undefined });
        await unchanged(owner);
        const latest = (await readDesktopSessionMappings(desktopHome, [original.nativeId])).get(original.nativeId.toLowerCase());
        if (!equal(latest, mapping) || state.pending != null) fail('native registration or coordinator state changed during verification.');
        let originalProof = { checkpoint: structuredClone(original.checkpoint), path: original.path, bytes: before,
          sha256: await prefixHash(original.path, originalIdentity), fileIdentity: originalIdentity };
        const previousAction = prior?.action ?? previousManifest?.value?.actions?.find(action => action.conversationId === conversation.id
          && action.localSessionId === mapping.sessionId && action.nativeId === original.nativeId && action.remoteId === owner.value.remoteId);
        if (mapping.isArchived && previousAction) {
          const saved = previousAction.originalProof;
          if (!object(saved) || saved.path !== original.path || !equal(saved.checkpoint, original.checkpoint)
            || !DIGEST.test(saved.sha256) || !Number.isSafeInteger(saved.bytes) || saved.bytes < 0)
            fail('saved original prefix proof is invalid.');
          if (await prefixHash(original.path, originalIdentity, saved.bytes) !== saved.sha256)
            fail('archived original no longer preserves its previously verified byte prefix.');
          originalProof = saved;
        }
        const action = { operationId: randomUUID(), conversationId: conversation.id,
          localSessionId: mapping.sessionId, nativeId: original.nativeId, remoteId: owner.value.remoteId,
          cwd: conversation.cwd, title: conversation.title, expectedLastActivityAt: mapping.lastActivityAt,
          registryProof: { path: mapping.registryPath, identity: mapping.registryIdentity },
          originalProof, replacement: { nativeId: current.nativeId, checkpoint: structuredClone(conversation.canonical) } };
        const entry = { hint: item.hint, verifiedAt: now(), archived: mapping.isArchived, action,
          observation: { owner, originalPath: original.path, currentPath: current.path, originalIdentity, currentIdentity, mapping } };
        verified.set(conversation.id, entry); ready.push(entry);
        if (mapping.isArchived) acknowledged.push({ conversationId: conversation.id, localSessionId: mapping.sessionId });
      }
      // A full verification of a different conversation may be slow. Recheck
      // every reused observation before publishing it, not only before that
      // operation began. The consumer still performs its own fresh native guard.
      if (ready.length) {
        const latestMappings = await readDesktopSessionMappings(desktopHome, ready.map(item => item.action.nativeId));
        for (const entry of ready) {
          const observed = entry.observation;
          await unchanged(observed.owner);
          if (!equal(await fileIdentity(observed.originalPath), observed.originalIdentity)
            || !equal(await fileIdentity(observed.currentPath), observed.currentIdentity)
            || !equal(latestMappings.get(entry.action.nativeId.toLowerCase()), observed.mapping) || state.pending != null)
            fail('native observations changed before publication.');
        }
      }
      const actions = ready.filter(item => !item.archived).map(item => item.action).slice(0, MAX_ACTIONS);
      const anchorCandidates = new Map(previousAnchors.filter(object).map(anchor => [anchor.conversationId, anchor]));
      for (const { action } of ready) anchorCandidates.set(action.conversationId, presentationAnchor(action));
      const anchors = await retainPresentationAnchors({ root, desktopHome, state, anchors: [...anchorCandidates.values()] });
      return { changed: await writeManifest(root, actions, now(), anchors), actions: actions.length, anchors: anchors.length, acknowledged,
        deferred: dirty.length > 1 ? 'verification_queue' : null };
    } catch (error) {
      verified.clear();
      // Revocation is essential: a stale successful proof must not survive a
      // newly observed conflict. Failure to revoke remains explicit as well.
      try {
        const anchors = await retainPresentationAnchors({ root, desktopHome, state, anchors: previousAnchors });
        const changed = await writeManifest(root, [], now(), anchors);
        if (['CLAUDEX_HANDOFF_HISTORY_CHANGED', 'CLAUDEX_HANDOFF_OWNER_NOT_IDLE'].includes(error.code)) return {
          changed, actions: 0, anchors: anchors.length, acknowledged: [],
          deferred: error.code === 'CLAUDEX_HANDOFF_OWNER_NOT_IDLE' ? 'owner_not_idle' : 'history_changed',
          conversationId: error.conversationId, title: error.title,
        };
      }
      catch (revokeError) { throw new AggregateError([error, revokeError], 'Claude Desktop handoff verification and manifest revocation failed.'); }
      throw error;
    } finally { running = false; }
  }
  return { publish };
}

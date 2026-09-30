import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { privateDirectory, readJSON, writeJSON, withLock } from './storage.mjs';
import { assertComplete, fingerprint, portableMessages } from './history.mjs';
import { DEFAULT_POLICY, planRetention } from './retention.mjs';
import { originalArchiveGuard } from './codex-original-archive-tree.mjs';

const other = side => side === 'codex' ? 'claude' : 'codex';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const anchorGuard = message => Object.assign(new Error(message), { code: 'CLAUDEX_DEPENDENCY_ANCHOR_BLOCKED' });
const relocationGuard = message => Object.assign(new Error(message), { code: 'CLAUDEX_CLAUDE_RELOCATION_BLOCKED' });
const normalize = common => ({ ...common, messages: portableMessages(common.messages).map(({ role, content }) => ({ role, content })) });
function matches(common, checkpoint) {
  return common.messages.length >= checkpoint.count && fingerprint(common, checkpoint.count) === checkpoint.digest;
}
// Same predicate for a reading returned by inspect(): when the checkpoint spans
// the whole reading, its full digest was just computed over this exact value.
function readingMatches(data, checkpoint) {
  if (data.common.messages.length === checkpoint.count) return data.digest === checkpoint.digest;
  return matches(data.common, checkpoint);
}
function checkpoint(common) { return { count: common.messages.length, digest: fingerprint(common) }; }

async function readBatches(records, read) {
  const readings = [];
  for (let index = 0; index < records.length; index += 4) {
    // Complete every started read before selecting the first ordered error or
    // releasing the coordinator lock. Never leave a native inspection running
    // into recovery, allocation, shutdown or a later batch.
    const batch = await Promise.allSettled(records.slice(index, index + 4).map(read));
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      readings.push(result.value);
    }
  }
  return readings;
}

function imageOrigins(side, data, committed) {
  if (data.localImageRollouts === undefined) return {};
  if (side !== 'codex' || !Array.isArray(data.localImageRollouts))
    throw new Error('Native image origins require verified Codex read metadata.');
  // A recovery read can include later completed turns. Preserve only origins
  // inside the checkpoint actually committed by this transaction, not that tail.
  return { localImageRollouts: data.localImageRollouts.map(origin => ({ ...origin,
    requests: origin.requests.filter(request => {
      if (!Number.isSafeInteger(request.messageIndex) || request.messageIndex < 0)
        throw new Error('Native image origin lacks its canonical message position.');
      return request.messageIndex < committed.count;
    }),
  })).filter(origin => origin.requests.length) };
}

/** Durable bidirectional coordinator: stable Claude owner, bounded Codex snapshots.
 * Adapters implement native writes; this class never edits a native transcript.
 */
export class DesktopBridge {
  constructor({ root, adapters, policy = {}, now = () => Date.now() }) {
    this.root = root; this.adapters = adapters; this.policy = { ...DEFAULT_POLICY, ...policy }; this.now = now;
    planRetention([], { policy: this.policy });
  }

  async load() {
    await privateDirectory(this.root);
    const state = await readJSON(join(this.root, 'desktop-state.json'), { version: 2, conversations: {}, records: [], pending: null, audit: [] });
    if (state.version !== 2) throw new Error('Unsupported desktop bridge state version.');
    return state;
  }
  async save(state, event) {
    if (event) state.audit.push({ at: this.now(), ...event });
    state.audit = this.policy.maxAuditEntries ? state.audit.slice(-this.policy.maxAuditEntries) : [];
    await writeJSON(join(this.root, 'desktop-state.json'), state);
  }
  async locked(fn) {
    await privateDirectory(this.root);
    return withLock(join(this.root, 'desktop-operation.lock'), async () => fn(await this.load()), { recoverDead: true });
  }
  status() { return this.load(); }
  current(state, id, side) { return state.records.find(record => record.conversationId === id && record.side === side && record.status === 'current'); }
  async inspect(record) {
    const data = await this.adapters[record.side].inspect(record);
    if (data.nativeId !== record.nativeId) throw new Error('Native source identity changed; synchronization paused.');
    const common = normalize(data.common);
    assertComplete(common);
    if (record.cwd && common.meta.cwd !== record.cwd) throw new Error('Source working directory changed; synchronization paused.');
    return { ...data, common, digest: fingerprint(common) };
  }

  /** Adopt native-owned original relocation metadata, never rewrite its history.
   * The adapter proves the native move; the coordinator proves that adopting it
   * cannot select between competing histories or reroute an existing operation.
   */
  async reconcileOriginalRelocations(state, conversationId) {
    const reconcile = this.adapters.claude?.reconcileRelocation;
    if (!reconcile || state.pending) return;
    for (const record of state.records.filter(record => record.side === 'claude'
      && record.status === 'current' && record.managed === false && record.kind === 'original'
      && (!conversationId || record.conversationId === conversationId))) {
      try {
        const proof = await reconcile(record);
        if (!proof) continue;
        const conversation = state.conversations[record.conversationId];
        const validate = candidate => {
          if (!candidate?.record || !candidate.common || !conversation || !record.verified)
            throw relocationGuard('Claude relocation proof is incomplete; saved histories were preserved.');
          const relocated = candidate.record;
          const invariant = value => Object.fromEntries(Object.entries(value)
            .filter(([key]) => !['path', 'cwd', 'relocation'].includes(key)));
          if (!isDeepStrictEqual(invariant(relocated), invariant(record))
            || candidate.nativeId !== record.nativeId || candidate.path !== relocated.path
            || typeof relocated.path !== 'string' || typeof relocated.cwd !== 'string'
            || !relocated.relocation || (relocated.path === record.path && relocated.cwd === record.cwd))
            throw relocationGuard('Claude relocation changed protected identity or lifecycle fields.');
          const common = normalize(candidate.common); assertComplete(common);
          if (common.meta.cwd !== relocated.cwd || !matches(common, conversation.canonical)
            || !isDeepStrictEqual(record.checkpoint, conversation.canonical))
            throw relocationGuard('Claude relocation does not preserve the synchronized history prefix.');
          if (candidate.incompleteTail)
            throw new Error('Claude relocation has an in-progress turn; wait for a complete assistant turn.');
          return common;
        };
        const common = validate(proof);
        const target = this.current(state, record.conversationId, 'codex');
        if (target) {
          if (!target.managed || target.kind !== 'snapshot' || !target.verified)
            throw relocationGuard('Claude relocation requires an unchanged managed Codex snapshot.');
          await this.adapters.codex.assertIdle(target);
          const destination = await this.inspect(target);
          if (destination.incompleteTail || destination.common.messages.length !== conversation.canonical.count
            || destination.digest !== conversation.canonical.digest
            || !isDeepStrictEqual(target.checkpoint, conversation.canonical))
            throw relocationGuard('Codex changed during Claude relocation; no branch was selected.');
        }
        const latest = await reconcile(record);
        const latestCommon = validate(latest);
        if (!isDeepStrictEqual(latest.record, proof.record) || latest.bytes !== proof.bytes
          || !isDeepStrictEqual(latest.relocationProof, proof.relocationProof)
          || fingerprint(latestCommon) !== fingerprint(common)
          || latestCommon.messages.length !== common.messages.length)
          throw new Error('Source history changed between complete reads; relocation waits for a stable boundary.');
        // Atomic ledger update retains checkpoint, original native identity, and
        // every previous snapshot's original cwd. A normal handoff updates Codex.
        Object.assign(record, latest.record);
        conversation.cwd = record.cwd;
        await this.save(state, { event: 'claude-original-relocated', conversationId: record.conversationId,
          nativeId: record.nativeId });
      } catch (error) {
        // Global collection can encounter another conversation's migration.
        // Preserve its identity so the caller does not blame the current task.
        error.conversationId ??= record.conversationId;
        throw error;
      }
    }
  }

  /** Conversations whose saved working directory no longer exists (for example
   * a cleaned-up Codex worktree) cannot be verified until it returns. Global
   * guards defer them instead of blocking every other conversation; their own
   * syncs still fail with an explicit per-conversation hold.
   */
  async frozenConversations(state) {
    const frozen = new Set();
    // Only native adapters can observe working directories; synthetic adapters
    // without this capability never freeze a conversation.
    const probe = ['codex', 'claude'].map(side => this.adapters[side]?.workingDirectoryAbsent).find(Boolean);
    if (!probe) return frozen;
    const absent = new Map();
    for (const [id, conversation] of Object.entries(state.conversations)) {
      const cwds = [conversation.cwd, ...state.records.filter(record => record.conversationId === id).map(record => record.cwd)]
        .filter(cwd => typeof cwd === 'string' && isAbsolute(cwd));
      for (const cwd of new Set(cwds)) {
        if (!absent.has(cwd)) absent.set(cwd, await probe(cwd) === true);
        if (absent.get(cwd)) { frozen.add(id); break; }
      }
    }
    return frozen;
  }

  async assertOriginalsUnchanged(state, conversationId, frozen = new Set()) {
    const included = record => conversationId ? record.conversationId === conversationId : !frozen.has(record.conversationId);
    for (const record of state.records.filter(record => record.status === 'dependency-anchor' && included(record))) {
      await this.assertDependencyAnchor(record);
    }
    await readBatches(state.records.filter(record => !record.managed && record.status === 'original' && included(record)), async record => {
      const data = await this.inspect(record);
      if (data.digest !== record.checkpoint.digest || data.common.messages.length !== record.checkpoint.count) {
        const current = this.current(state, record.conversationId, record.side);
        throw new Error(`Superseded original ${record.nativeId} changed; current ${record.side} session is ${current?.nativeId ?? 'unavailable'}. No branch was selected.`);
      }
      if (data.incompleteTail) throw new Error('A superseded original has an in-progress turn; synchronization postponed.');
    });
  }

  async assertDependencyAnchor(record) {
    if (record.side !== 'codex' || !record.managed || !record.verified || record.kind !== 'snapshot'
      || record.status !== 'dependency-anchor' || !this.adapters.codex.assertDependencyAnchor)
      throw anchorGuard('Dependency anchor cannot be verified; histories were preserved.');
    await this.adapters.codex.assertDependencyAnchor(record);
  }

  dependencyAnchorCandidate(record, proof) {
    if (!proof || !Array.isArray(proof.dependencyIds) || !proof.dependencyIds.length
      || !proof.dependencyAnchor || !Number.isSafeInteger(proof.bytes) || proof.bytes < 0)
      throw anchorGuard('Dependency anchor proof is incomplete; histories were preserved.');
    return { ...record, status: 'dependency-anchor', dependencyIds: proof.dependencyIds,
      dependencyAnchor: proof.dependencyAnchor, bytes: proof.bytes };
  }

  assertDependencyCapacity(state, candidate) {
    const records = state.records.filter(record => record.managed && record.kind === 'snapshot')
      .map(record => record.id === candidate.id ? candidate : record);
    const plan = planRetention(records.map(record => ({ ...record, createdAt: record.retiredAt ?? record.createdAt })),
      { now: this.now(), policy: this.policy });
    if (plan.blocked.length) throw anchorGuard('Dependency anchor capacity exceeded; histories were preserved.');
  }

  async verifyPromotedPrefix(state, pending) {
    const source = state.records.find(record => record.id === pending.sourceId);
    const current = this.current(state, pending.record.conversationId, pending.record.side);
    if (!source || current?.id !== pending.record.id || current.nativeId !== pending.record.nativeId)
      throw anchorGuard('Dependency anchor replacement identity changed; histories were preserved.');
    for (const record of [source, current]) {
      if (!readingMatches(await this.inspect(record), pending.checkpoint))
        throw anchorGuard('Dependency anchor replacement prefix changed; histories were preserved.');
    }
  }

  async preserveDependentSnapshot(state, record, pending, preparedProof) {
    const prepare = this.adapters[record.side].prepareDependencyAnchor;
    if (!prepare) return false;
    const proof = preparedProof === undefined ? await prepare(record) : preparedProof;
    if (!proof) return false;
    const candidate = this.dependencyAnchorCandidate(record, proof);
    this.assertDependencyCapacity(state, candidate);
    if (pending) await this.verifyPromotedPrefix(state, pending);
    // Revalidate after the other native reads and before the durable transition.
    await this.assertDependencyAnchor(candidate);
    Object.assign(record, candidate);
    await this.save(state, { event: 'dependency-anchor-preserved', conversationId: record.conversationId,
      nativeId: record.nativeId, dependencyCount: record.dependencyIds.length });
    return true;
  }

  async track(source) {
    return this.locked(async state => {
      if (state.pending) throw new Error('An unfinished desktop handoff must be recovered first.');
      if (!['codex', 'claude'].includes(source.side)) throw new Error('Invalid source side.');
      const data = await this.adapters[source.side].inspect({ ...source, managed: false });
      const common = normalize(data.common); assertComplete(common);
      const existing = state.records.find(record => record.side === source.side && record.nativeId === data.nativeId);
      if (existing) return { conversationId: existing.conversationId, existing: true };
      const id = randomUUID();
      const firstText = common.messages.find(message => message.role === 'user')?.content.find(block => block.type === 'text')?.text;
      state.conversations[id] = { id, cwd: common.meta.cwd, title: source.title || common.meta.title || firstText?.split('\n')[0].slice(0, 100) || 'Claudex conversation',
        canonical: checkpoint(common) };
      state.records.push({ id: randomUUID(), conversationId: id, side: source.side, nativeId: data.nativeId,
        path: data.path ?? source.path, cwd: common.meta.cwd, managed: false, kind: 'original', verified: true,
        status: 'current', checkpoint: checkpoint(common), bytes: data.bytes ?? 0, createdAt: this.now(),
        ...imageOrigins(source.side, data, checkpoint(common)) });
      await this.save(state, { event: 'tracked', conversationId: id, side: source.side });
      return { conversationId: id, existing: false };
    });
  }

  /** Enroll an independently published, signed Local import without spawning a
   * Remote Control owner. Both files remain originals, never rollback garbage.
   * Desktop adoption itself is performed through the native UI, not this ledger.
   */
  async trackImportedPair({ conversationId, source, target, title }) {
    return this.locked(async state => {
      if (state.pending) throw new Error('An unfinished desktop handoff must be recovered first.');
      if (!UUID.test(conversationId) || !UUID.test(source.nativeId) || !UUID.test(target.nativeId)
          || source.side !== 'codex' || source.managed !== false || source.kind !== 'original'
          || target.side !== 'claude' || target.managed !== false || target.kind !== 'original'
          || target.importPacket !== true || target.packetVersion !== 2
          || target.conversationId !== conversationId)
        throw new Error('Invalid cold-import pair.');
      const prior = state.records.find(record => record.side === 'codex' && record.nativeId === source.nativeId);
      const priorTarget = state.records.find(record => record.side === 'claude' && record.nativeId === target.nativeId);
      if (prior || priorTarget || state.conversations[conversationId]) {
        if (prior?.conversationId === conversationId && priorTarget?.conversationId === conversationId
            && priorTarget.importPacket && state.conversations[conversationId]?.discoveryMode === 'cold-import')
          return { conversationId, existing: true };
        throw new Error('Cold-import identity is already tracked by a different enrollment.');
      }
      const from = await this.inspect(source), to = await this.inspect(target);
      if (from.digest !== to.digest || from.common.messages.length !== to.common.messages.length
          || from.common.meta.cwd !== to.common.meta.cwd || to.incompleteTail)
        throw new Error('Cold import does not exactly match its source checkpoint.');
      const latest = await this.inspect(source);
      if (latest.digest !== from.digest || latest.common.messages.length !== from.common.messages.length
          || latest.common.meta.cwd !== from.common.meta.cwd)
        throw new Error('Source changed during cold import; published evidence was preserved.');
      const canonical = checkpoint(from.common), cwd = from.common.meta.cwd;
      state.conversations[conversationId] = { id: conversationId, cwd,
        title: title || from.common.meta.title || 'Claudex conversation', canonical, discoveryMode: 'cold-import' };
      for (const [record, data] of [[source, latest], [target, to]]) state.records.push({
        ...record, id: randomUUID(), conversationId, cwd, path: data.path,
        managed: false, kind: 'original', verified: true, status: 'current',
        checkpoint: canonical, bytes: data.bytes ?? 0, createdAt: this.now(),
        ...imageOrigins(record.side, data, canonical),
      });
      await this.save(state, { event: 'cold-import-paired', conversationId });
      return { conversationId, existing: false };
    });
  }

  async sync(id) {
    return this.locked(async state => {
      if (state.pending) throw new Error('An unfinished desktop handoff must be recovered first.');
      const conversation = state.conversations[id];
      if (!conversation) throw new Error('Unknown desktop bridge conversation.');
      await this.reconcileOriginalRelocations(state, id);
      await this.assertOriginalsUnchanged(state, id);
      const records = ['codex', 'claude'].map(side => this.current(state, id, side)).filter(Boolean);
      const readings = await readBatches(records, async record => {
        const data = await this.inspect(record);
        if (!readingMatches(data, conversation.canonical)) throw new Error('Conversation history diverged before the common checkpoint; no branch was selected.');
        return { record, data };
      });
      const changed = readings.filter(({ data }) => data.common.messages.length > conversation.canonical.count);
      if (changed.length > 1) throw new Error('Both sides changed; no history was replaced.');
      const maintenance = [];
      const relocatedTarget = readings.find(({ record }) => record.side === 'codex' && record.cwd !== conversation.cwd);
      if (relocatedTarget) {
        const relocatedSource = readings.find(({ record }) => record.side === 'claude' && record.cwd === conversation.cwd
          && record.managed === false && record.relocation);
        if (!relocatedSource || !relocatedTarget.record.managed || relocatedTarget.record.kind !== 'snapshot'
          || changed.some(entry => entry.record.side === 'codex') || relocatedTarget.data.incompleteTail)
          throw Object.assign(relocationGuard('Relocated project requires an unchanged managed Codex destination.'), { conversationId: id });
        maintenance.push({ side: 'codex', kind: 'relocation' });
      }
      for (const { record, data } of readings) {
        const kind = await this.adapters[record.side].needsMaintenance?.(record, data);
        if (kind !== undefined && kind !== null && kind !== false && kind !== true && kind !== 'images')
          throw new Error('Unsupported native maintenance kind.');
        if (kind) maintenance.push({ side: record.side, kind: kind === true ? 'reset' : kind });
      }
      if (maintenance.filter(item => item.kind === 'reset').length > 1)
        throw new Error('Only one native context migration may be planned at a time.');
      // Visual repairs are independent, serial native deliveries. Select only
      // one per transaction, with a required cold reset taking precedence.
      const upkeep = maintenance.find(item => item.kind === 'relocation')
        ?? maintenance.find(item => item.kind === 'reset') ?? maintenance[0];
      if (!changed.length && records.length === 2 && !maintenance.length) return {
        changed: false,
        ...(conversation.discoveryMode === 'cold-import' ? { incompleteTail: readings.some(({ data }) => data.incompleteTail) } : {}),
      };
      const reading = changed[0] ?? (upkeep ? readings.find(entry => entry.record.side !== upkeep.side) : readings[0]);
      if (!reading) throw new Error('Context migration requires its verified paired source.');
      const { record: source, data } = reading;
      const side = other(source.side);
      const contextReset = upkeep?.side === side && upkeep.kind === 'reset';
      const contextRefresh = upkeep?.side === side && upkeep.kind === 'images';
      const target = this.current(state, id, side);
      if (target) await this.adapters[side].assertIdle(target);
      // A visual-only refresh of an already managed snapshot must not acquire
      // a new archival intent for a legacy preserved original. Its semantic
      // checkpoint is unchanged; the managed predecessor still has its own
      // full native retirement/dependency guards.
      const visualOnlyManagedRefresh = contextRefresh && !changed.length && target?.managed === true;
      const originalToArchive = side !== 'codex' || visualOnlyManagedRefresh ? null : target?.managed === false ? target
        : state.records.find(record => record.conversationId === id && record.side === 'codex'
          && record.status === 'original' && !record.managed && !record.archivedAt);
      if (originalToArchive) {
        if (!this.adapters.codex.assertCanArchiveOriginal || !this.adapters.codex.archiveOriginal)
          throw new Error('The Codex adapter cannot safely archive a superseded original.');
        // Refuse unsafe originals before allocating a same-title replacement.
        await this.adapters.codex.assertCanArchiveOriginal(originalToArchive);
      }
      // Cleanup precedes allocation; a protected backup cannot create an
      // unlimited stream of replacement generations.
      await this.collectInLock(state);
      if (source.cwd !== data.common.meta.cwd || conversation.cwd !== data.common.meta.cwd)
        throw Object.assign(relocationGuard('Source project changed while preparing synchronization; no handoff was allocated.'), { conversationId: id });
      if (side === 'codex' && target?.managed && this.adapters.codex.prepareDependencyAnchor) {
        const proof = await this.adapters.codex.prepareDependencyAnchor(target);
        if (proof) this.assertDependencyCapacity(state, this.dependencyAnchorCandidate(target, proof));
      }
      const operationId = randomUUID();
      const common = { ...data.common, meta: { ...data.common.meta, cwd: conversation.cwd, timestamp: new Date(this.now()).toISOString() } };
      // Preserve the logical title. After verification, archive the superseded
      // Codex original rather than keeping two same-title active entries.
      const title = conversation.title;
      const planned = await this.adapters[side].plan({ conversationId: id, nativeId: randomUUID(), common, title, target, operationId, contextReset, contextRefresh });
      const reuse = Boolean(target?.managed && target.nativeId === planned.nativeId);
      if (contextReset && (side !== 'claude' || !reuse || planned.kind !== 'owner' || planned.contextReset !== true))
        throw new Error('Context migration requires a reusable owned Claude reset plan.');
      if (planned.contextRefresh && (contextReset || side !== 'claude' || !reuse || planned.kind !== 'owner'
        || planned.imageProjectionVersion !== 1)) throw new Error('Visual refresh requires the same verified Claude owner.');
      if (contextRefresh && (planned.imageProjectionVersion !== 1 || side === 'claude' && !planned.contextRefresh))
        throw new Error('Visual maintenance requires an explicit native image projection.');
      if (reuse && (side !== 'claude' || target.kind !== 'owner' || planned.kind !== 'owner')) throw new Error('Only a verified native Claude owner may reuse its identity.');
      if (reuse) await this.adapters[side].assertIdle(target);
      const record = { ...planned, id: reuse ? target.id : randomUUID(), side, conversationId: id, cwd: conversation.cwd,
        managed: true, status: 'current', verified: false, bytes: 0, createdAt: reuse ? target.createdAt : this.now() };
      if (!record.nativeId || !['owner', 'snapshot'].includes(record.kind)) throw new Error('Invalid native handoff plan.');
      state.pending = { phase: 'prepared', operationId, sourceId: source.id, targetId: target?.id ?? null,
        archiveOriginalId: originalToArchive?.id ?? null,
        reuse, record, common, checkpoint: checkpoint(common), previous: reuse && !contextReset ? conversation.canonical : { count: 0, digest: null } };
      await this.save(state, { event: 'prepared', conversationId: id, side });
      return this.finish(state);
    });
  }

  async recover() { return this.locked(state => state.pending ? this.finish(state) : { changed: false }); }

  /** Explicit legacy reconciliation only: preserves the exact original and its
   * native spawned-agent tree, without allocating or deleting any session.
   */
  async reconcileOriginalArchive(conversationId, originalNativeId) {
    return this.locked(async state => {
      if (state.pending) throw new Error('Recover the pending desktop handoff before original archival.');
      const original = state.records.find(record => record.conversationId === conversationId
        && record.nativeId === originalNativeId && record.side === 'codex' && record.status === 'original'
        && record.kind === 'original' && record.managed === false && record.verified);
      const replacement = this.current(state, conversationId, 'codex'), conversation = state.conversations[conversationId];
      if (!original || !replacement || !conversation) throw new Error('The exact superseded Codex original or its current replacement is missing.');
      if (original.archivedAt) return { changed: false, conversationId, nativeId: original.nativeId };
      await this.verifyOriginalArchiveReplacement(state, original, replacement, conversation.canonical, conversation.title);
      const proof = await this.adapters.codex.prepareOriginalArchiveTree(original);
      state.pending = { kind: 'original-archive', phase: 'prepared', operationId: randomUUID(),
        record: { ...original }, originalId: original.id, replacementId: replacement.id,
        checkpoint: conversation.canonical, title: conversation.title, archiveTree: proof };
      await this.save(state, { event: 'original-archive-prepared', conversationId, nativeId: original.nativeId });
      return this.finishOriginalArchive(state);
    });
  }

  async verifyOriginalArchiveReplacement(state, original, replacement, canonical, title) {
    if (!original || original.managed !== false || original.status !== 'original' || original.kind !== 'original'
        || !replacement || replacement.managed !== true || !replacement.verified || replacement.status !== 'current'
        || replacement.conversationId !== original.conversationId || replacement.side !== 'codex')
      throw originalArchiveGuard('Original archive intent no longer matches its replacement.');
    await this.assertOriginalsUnchanged(state, original.conversationId);
    const data = await this.inspect(replacement);
    if (data.incompleteTail || data.digest !== canonical.digest || data.common.messages.length !== canonical.count
        || !readingMatches(data, original.checkpoint))
      throw originalArchiveGuard('Original archive replacement changed or does not contain the exact original prefix.');
    await this.adapters.codex.assertArchiveReplacement(original, replacement, title);
  }

  async finishOriginalArchive(state) {
    const pending = state.pending, original = state.records.find(record => record.id === pending.originalId),
      replacement = state.records.find(record => record.id === pending.replacementId);
    if (pending.kind !== 'original-archive' || !['prepared', 'requested'].includes(pending.phase)
        || !original || original.nativeId !== pending.record.nativeId
        || original.conversationId !== pending.record.conversationId)
      throw originalArchiveGuard('Invalid preserved-original archive journal.');
    await this.verifyOriginalArchiveReplacement(state, original, replacement, pending.checkpoint, pending.title);
    const allowWrite = pending.phase === 'prepared';
    const result = await this.adapters.codex.archiveOriginalTree(original, pending.archiveTree, { allowWrite,
      beforeDispatch: async () => {
        // Read-only preflight failures leave the intent prepared. Journal the
        // uncertain-write boundary only immediately before native dispatch.
        if (!allowWrite || pending.phase !== 'prepared') throw originalArchiveGuard('Original archive dispatch was already recorded.');
        pending.phase = 'requested';
        await this.save(state, { event: 'original-archive-requested', conversationId: original.conversationId });
      } });
    await this.verifyOriginalArchiveReplacement(state, original, replacement, pending.checkpoint, pending.title);
    Object.assign(original, result, { archivedAt: this.now() });
    state.pending = null;
    const preservedDescendants = result.archivedTree.members.filter(member => member.disposition === 'archive').length - 1;
    await this.save(state, { event: 'original-archive-completed', conversationId: original.conversationId,
      nativeId: original.nativeId, preservedDescendants });
    return { changed: true, conversationId: original.conversationId, nativeId: original.nativeId,
      preservedDescendants };
  }

  async finish(state) {
    const pending = state.pending;
    if (pending.kind === 'original-archive') return this.finishOriginalArchive(state);
    await this.assertOriginalsUnchanged(state, pending.record.conversationId);
    const driver = this.adapters[pending.record.side];
    if (pending.phase !== 'promoted') {
      const source = state.records.find(record => record.id === pending.sourceId);
      if (!source) throw new Error('Desktop handoff source is missing.');
      const sourceData = await this.inspect(source);
      // A later complete source turn may already exist. Only the copied prefix
      // is committed now; the subsequent round remains dirty for the next sync.
      if (!readingMatches(sourceData, pending.checkpoint)) throw new Error('Source changed during handoff; pending evidence was preserved.');
      const target = state.records.find(record => record.id === pending.targetId);
      const applied = await driver.operationApplied(pending.record, pending);
      // A new projection does not write the old target. Recheck that target on
      // recovery too: it may have received a competing turn after apply.
      if (target && (!applied || !pending.reuse)) {
        await this.adapters[target.side].assertIdle(target);
        const targetData = await this.inspect(pending.record.contextReset ? { ...target, readResetSourceForOperation: pending.operationId } : target);
        if (targetData.digest !== target.checkpoint.digest) throw new Error('Destination changed during handoff; no branch was selected.');
      }
      if (!applied) await driver.apply(pending.record, pending.common, pending);
      if (driver.resolveAppliedRecord) {
        const resolved = await driver.resolveAppliedRecord(pending.record, pending);
        if (resolved.nativeId !== pending.record.nativeId && (!pending.reuse || pending.record.side !== 'claude' || !pending.record.contextReset))
          throw new Error('Only a verified native context reset may adopt a different reusable identity.');
        pending.record = resolved;
      }
      const targetData = await this.inspect(pending.record);
      if (!readingMatches(targetData, pending.checkpoint)) throw new Error('Native destination did not preserve the complete copied checkpoint.');
      pending.record = { ...pending.record, path: targetData.path ?? pending.record.path, verified: true,
        checkpoint: pending.checkpoint, bytes: targetData.bytes ?? 0,
        ...imageOrigins(pending.record.side, targetData, pending.checkpoint) };
      pending.phase = 'applied';
      await this.save(state, { event: 'verified', conversationId: pending.record.conversationId });
      const latestSource = await this.inspect(source);
      if (!readingMatches(latestSource, pending.checkpoint)) throw new Error('Source changed before promotion; pending evidence was preserved.');
      await this.assertOriginalsUnchanged(state, pending.record.conversationId);
      if (target && !pending.reuse) {
        await this.adapters[target.side].assertIdle(target);
        if ((await this.inspect(target)).digest !== target.checkpoint.digest) throw new Error('Destination changed during handoff; no branch was selected.');
      }
      Object.assign(source, { path: latestSource.path ?? source.path, checkpoint: pending.checkpoint, bytes: latestSource.bytes ?? source.bytes,
        ...imageOrigins(source.side, latestSource, pending.checkpoint) });
      if (pending.reuse) {
        const index = state.records.findIndex(record => record.id === pending.record.id);
        if (index < 0) throw new Error('Reusable owner record is missing.');
        state.records[index] = pending.record;
      } else {
        if (target) {
          target.status = target.managed ? 'previous' : 'original';
          target.retiredAt = this.now();
        }
        state.records.push(pending.record);
      }
      state.conversations[pending.record.conversationId].canonical = pending.checkpoint;
      pending.phase = 'promoted';
      await this.save(state, { event: 'promoted', conversationId: pending.record.conversationId });
    }
    const old = state.records.find(record => record.id === pending.targetId);
    if (!pending.reuse && old?.managed) {
      if (old.kind !== 'snapshot') throw new Error('A stable native owner cannot be retired as a snapshot.');
      if (old.status === 'dependency-anchor') {
        await this.verifyPromotedPrefix(state, pending);
        await this.assertDependencyAnchor(old);
      } else {
        if (!await this.preserveDependentSnapshot(state, old, pending)) {
          await this.assertUnchanged(old);
          Object.assign(old, await driver.hide(old));
        }
      }
    }
    if (pending.archiveOriginalId) {
      const original = state.records.find(record => record.id === pending.archiveOriginalId);
      if (pending.reuse || pending.record.side !== 'codex' || !original || original.side !== 'codex'
        || original.conversationId !== pending.record.conversationId
        || original.managed || original.kind !== 'original' || original.status !== 'original')
        throw new Error('Original archive intent does not match the promoted Codex handoff.');
      await this.assertOriginalsUnchanged(state, original.conversationId);
      Object.assign(original, await driver.archiveOriginal(original));
      // The original stays unmanaged and outside disposable backup retention.
      original.archivedAt ??= this.now();
    }
    if (driver.completePromotion) await driver.completePromotion(pending.record);
    const result = { changed: true, conversationId: pending.record.conversationId, side: pending.record.side, nativeId: pending.record.nativeId };
    state.pending = null;
    await this.save(state, { event: 'completed', conversationId: result.conversationId, side: result.side });
    await this.collectInLock(state);
    return result;
  }

  async assertUnchanged(record) {
    if (!record.managed || record.kind !== 'snapshot' || !record.verified) throw new Error('Unowned or unverified retirement target.');
    await this.adapters[record.side].assertIdle(record);
    const data = await this.inspect(record);
    if (data.incompleteTail || data.common.messages.length !== record.checkpoint.count
      || data.digest !== record.checkpoint.digest) throw new Error('A retained snapshot was edited; it was not retired.');
    return data;
  }

  async collect() {
    return this.locked(async state => {
      if (state.pending) throw new Error('Recover the pending desktop handoff before collection.');
      return this.collectInLock(state);
    });
  }
  async collectInLock(state) {
    await this.reconcileOriginalRelocations(state);
    const frozen = await this.frozenConversations(state);
    await this.assertOriginalsUnchanged(state, undefined, frozen);
    const snapshots = state.records.filter(record => record.managed && record.kind === 'snapshot');
    const retainedConversations = new Set(snapshots.map(record => record.conversationId)
      .filter(id => !frozen.has(id)));
    // Only conversations with disposable snapshots participate in retention.
    // Unchanged cold-import pairs have no backups to protect and must not make
    // global collection export every historical transcript or start an owner.
    // Both current sides of every affected conversation still gate retirement.
    for (const current of state.records.filter(record => record.status === 'current'
      && retainedConversations.has(record.conversationId))) {
      try {
        const data = await this.inspect(current);
        if (!readingMatches(data, current.checkpoint)) throw new Error('Current history changed; prior snapshots were preserved.');
      } catch (error) {
        // Allocation-time collection reads other conversations. Preserve the
        // failing history's identity so the caller does not blame its own task.
        error.conversationId ??= current.conversationId;
        throw error;
      }
    }
    const previous = [];
    for (const record of snapshots.filter(record => record.status === 'previous' && !frozen.has(record.conversationId))) {
      if (!await this.adapters[record.side].exists(record)) {
        state.records = state.records.filter(value => value.id !== record.id);
        continue;
      }
      previous.push(record);
    }
    const codexPrevious = previous.filter(record => record.side === 'codex');
    const batchPrepare = this.adapters.codex?.prepareDependencyAnchors;
    let prepared;
    if (batchPrepare && codexPrevious.length) {
      prepared = await batchPrepare(codexPrevious);
      if (!(prepared instanceof Map) || prepared.size !== codexPrevious.length
        || codexPrevious.some(record => !prepared.has(record.id)
          || prepared.get(record.id) !== null && (!prepared.get(record.id)
            || typeof prepared.get(record.id) !== 'object' || Array.isArray(prepared.get(record.id)))))
        throw new Error('Snapshot dependency batch is incomplete; prior snapshots were preserved.');
    }
    for (const record of previous) {
      if (!await this.preserveDependentSnapshot(state, record, undefined, prepared?.get(record.id))) {
        const data = await this.assertUnchanged(record);
        record.bytes = data.bytes ?? record.bytes;
      }
    }
    const plan = planRetention(state.records.filter(record => record.managed && record.kind === 'snapshot')
      .map(record => ({ ...record, createdAt: record.retiredAt ?? record.createdAt,
        ...(frozen.has(record.conversationId) ? { frozen: true } : {}) })), { now: this.now(), policy: this.policy });
    if (plan.blocked.length) throw new Error('Snapshot retention cannot be satisfied safely; new allocations are paused.');
    for (const id of plan.remove) {
      const record = state.records.find(value => value.id === id);
      if (!record || record.status !== 'previous') throw new Error('Invalid snapshot collection target.');
      await this.assertUnchanged(record);
      await this.adapters[record.side].remove(record);
      state.records = state.records.filter(value => value.id !== id);
      await this.save(state, { event: 'pruned', conversationId: record.conversationId });
    }
    await this.save(state);
    return { removed: plan.remove.length, backupBytes: plan.backupBytes, frozen: [...frozen].sort() };
  }
}

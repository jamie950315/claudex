import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateDirectory, readJSON, writeJSON, withLock } from './storage.mjs';
import { assertComplete, fingerprint, portableMessages } from './history.mjs';
import { DEFAULT_POLICY, planRetention } from './retention.mjs';

const other = side => side === 'codex' ? 'claude' : 'codex';
const normalize = common => ({ ...common, messages: portableMessages(common.messages).map(({ role, content }) => ({ role, content })) });
function matches(common, checkpoint) {
  return common.messages.length >= checkpoint.count && fingerprint(common, checkpoint.count) === checkpoint.digest;
}
function checkpoint(common) { return { count: common.messages.length, digest: fingerprint(common) }; }

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

  async assertOriginalsUnchanged(state, conversationId) {
    for (const record of state.records.filter(record => !record.managed && record.status === 'original'
      && (!conversationId || record.conversationId === conversationId))) {
      const data = await this.inspect(record);
      if (data.digest !== record.checkpoint.digest || data.common.messages.length !== record.checkpoint.count) {
        const current = this.current(state, record.conversationId, record.side);
        throw new Error(`Superseded original ${record.nativeId} changed; current ${record.side} session is ${current?.nativeId ?? 'unavailable'}. No branch was selected.`);
      }
      if (data.incompleteTail) throw new Error('A superseded original has an in-progress turn; synchronization postponed.');
    }
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
        status: 'current', checkpoint: checkpoint(common), bytes: data.bytes ?? 0, createdAt: this.now() });
      await this.save(state, { event: 'tracked', conversationId: id, side: source.side });
      return { conversationId: id, existing: false };
    });
  }

  async sync(id) {
    return this.locked(async state => {
      if (state.pending) throw new Error('An unfinished desktop handoff must be recovered first.');
      const conversation = state.conversations[id];
      if (!conversation) throw new Error('Unknown desktop bridge conversation.');
      await this.assertOriginalsUnchanged(state, id);
      const records = ['codex', 'claude'].map(side => this.current(state, id, side)).filter(Boolean);
      const readings = [];
      for (const record of records) {
        const data = await this.inspect(record);
        if (!matches(data.common, conversation.canonical)) throw new Error('Conversation history diverged before the common checkpoint; no branch was selected.');
        readings.push({ record, data });
      }
      const changed = readings.filter(({ data }) => data.common.messages.length > conversation.canonical.count);
      if (changed.length > 1) throw new Error('Both sides changed; no history was replaced.');
      if (!changed.length && records.length === 2) return { changed: false };
      const { record: source, data } = changed[0] ?? readings[0];
      const side = other(source.side);
      const target = this.current(state, id, side);
      if (target) await this.adapters[side].assertIdle(target);
      // Cleanup precedes allocation; a protected backup cannot create an
      // unlimited stream of replacement generations.
      await this.collectInLock(state);
      const operationId = randomUUID();
      const common = { ...data.common, meta: { ...data.common.meta, cwd: conversation.cwd, timestamp: new Date(this.now()).toISOString() } };
      // Originals remain untouched. Label replacement Codex tasks so a user can
      // distinguish the synchronized continuation from the preserved original.
      const title = side === 'codex' ? `[Claudex] ${conversation.title}` : conversation.title;
      const planned = await this.adapters[side].plan({ conversationId: id, nativeId: randomUUID(), common, title, target, operationId });
      const reuse = Boolean(target?.managed && target.nativeId === planned.nativeId);
      if (reuse && (side !== 'claude' || target.kind !== 'owner' || planned.kind !== 'owner')) throw new Error('Only a verified native Claude owner may reuse its identity.');
      if (reuse) await this.adapters[side].assertIdle(target);
      const record = { ...planned, id: reuse ? target.id : randomUUID(), side, conversationId: id, cwd: conversation.cwd,
        managed: true, status: 'current', verified: false, bytes: 0, createdAt: reuse ? target.createdAt : this.now() };
      if (!record.nativeId || !['owner', 'snapshot'].includes(record.kind)) throw new Error('Invalid native handoff plan.');
      state.pending = { phase: 'prepared', operationId, sourceId: source.id, targetId: target?.id ?? null,
        reuse, record, common, checkpoint: checkpoint(common), previous: reuse ? conversation.canonical : { count: 0, digest: null } };
      await this.save(state, { event: 'prepared', conversationId: id, side });
      return this.finish(state);
    });
  }

  async recover() { return this.locked(state => state.pending ? this.finish(state) : { changed: false }); }

  async finish(state) {
    const pending = state.pending;
    await this.assertOriginalsUnchanged(state, pending.record.conversationId);
    const driver = this.adapters[pending.record.side];
    if (pending.phase !== 'promoted') {
      const source = state.records.find(record => record.id === pending.sourceId);
      if (!source) throw new Error('Desktop handoff source is missing.');
      const sourceData = await this.inspect(source);
      // A later complete source turn may already exist. Only the copied prefix
      // is committed now; the subsequent round remains dirty for the next sync.
      if (!matches(sourceData.common, pending.checkpoint)) throw new Error('Source changed during handoff; pending evidence was preserved.');
      const target = state.records.find(record => record.id === pending.targetId);
      const applied = await driver.operationApplied(pending.record, pending);
      // A new projection does not write the old target. Recheck that target on
      // recovery too: it may have received a competing turn after apply.
      if (target && (!applied || !pending.reuse)) {
        await this.adapters[target.side].assertIdle(target);
        const targetData = await this.inspect(target);
        if (targetData.digest !== target.checkpoint.digest) throw new Error('Destination changed during handoff; no branch was selected.');
      }
      if (!applied) await driver.apply(pending.record, pending.common, pending);
      const targetData = await this.inspect(pending.record);
      if (!matches(targetData.common, pending.checkpoint)) throw new Error('Native destination did not preserve the complete copied checkpoint.');
      pending.record = { ...pending.record, path: targetData.path ?? pending.record.path, verified: true,
        checkpoint: pending.checkpoint, bytes: targetData.bytes ?? 0 };
      pending.phase = 'applied';
      await this.save(state, { event: 'verified', conversationId: pending.record.conversationId });
      const latestSource = await this.inspect(source);
      if (!matches(latestSource.common, pending.checkpoint)) throw new Error('Source changed before promotion; pending evidence was preserved.');
      await this.assertOriginalsUnchanged(state, pending.record.conversationId);
      if (target && !pending.reuse) {
        await this.adapters[target.side].assertIdle(target);
        if ((await this.inspect(target)).digest !== target.checkpoint.digest) throw new Error('Destination changed during handoff; no branch was selected.');
      }
      Object.assign(source, { path: latestSource.path ?? source.path, checkpoint: pending.checkpoint, bytes: latestSource.bytes ?? source.bytes });
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
      await this.assertUnchanged(old);
      Object.assign(old, await driver.hide(old));
    }
    const result = { changed: true, conversationId: pending.record.conversationId, side: pending.record.side, nativeId: pending.record.nativeId };
    state.pending = null;
    await this.save(state, { event: 'completed', conversationId: result.conversationId, side: result.side });
    await this.collectInLock(state);
    return result;
  }

  async assertUnchanged(record) {
    if (!record.managed || record.kind !== 'snapshot' || !record.verified) throw new Error('Unowned or unverified retirement target.');
    await this.adapters[record.side].assertIdle(record);
    if ((await this.inspect(record)).digest !== record.checkpoint.digest) throw new Error('A retained snapshot was edited; it was not retired.');
  }

  async collect() {
    return this.locked(async state => {
      if (state.pending) throw new Error('Recover the pending desktop handoff before collection.');
      return this.collectInLock(state);
    });
  }
  async collectInLock(state) {
    await this.assertOriginalsUnchanged(state);
    for (const current of state.records.filter(record => record.status === 'current')) {
      const data = await this.inspect(current);
      if (!matches(data.common, current.checkpoint)) throw new Error('Current history changed; prior snapshots were preserved.');
    }
    const snapshots = state.records.filter(record => record.managed && record.kind === 'snapshot');
    for (const record of snapshots.filter(record => record.status === 'previous')) {
      if (!await this.adapters[record.side].exists(record)) {
        state.records = state.records.filter(value => value.id !== record.id);
        continue;
      }
      await this.assertUnchanged(record);
      record.bytes = (await this.inspect(record)).bytes ?? record.bytes;
    }
    const plan = planRetention(state.records.filter(record => record.managed && record.kind === 'snapshot')
      .map(record => ({ ...record, createdAt: record.retiredAt ?? record.createdAt })), { now: this.now(), policy: this.policy });
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
    return { removed: plan.remove.length, backupBytes: plan.backupBytes };
  }
}

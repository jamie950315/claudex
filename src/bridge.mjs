import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
import { readJSON, writeJSON, withLock } from './storage.mjs';
import { DEFAULT_POLICY, planRetention } from './retention.mjs';
import { assertComplete, fingerprint } from './history.mjs';

/** One durable transaction at a time. Drivers never receive unowned deletion targets. */
export class Bridge {
  constructor({ root, drivers, policy = {}, now = () => Date.now() }) {
    this.root = root;
    this.drivers = drivers;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    planRetention([], { policy: this.policy });
    this.now = now;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Bridge state directory must not be a symlink.');
  }

  async load() {
    const state = await readJSON(join(this.root, 'state.json'), { version: 1, conversations: {}, records: [], pending: null, audit: [] });
    if (state.version !== 1) throw new Error('Unsupported bridge state version.');
    return state;
  }

  async save(state, event) {
    if (event) state.audit.push({ at: this.now(), ...event });
    state.audit = this.policy.maxAuditEntries ? state.audit.slice(-this.policy.maxAuditEntries) : [];
    await writeJSON(join(this.root, 'state.json'), state);
  }

  async locked(fn) {
    await this.initialize();
    return withLock(join(this.root, 'operation.lock'), async () => fn(await this.load()));
  }

  current(state, conversationId, side) {
    return state.records.find(record => record.conversationId === conversationId && record.side === side && record.status === 'current');
  }

  async status() { await this.initialize(); return this.load(); }

  async track({ side, path, title }) {
    return this.locked(async state => {
      if (state.pending) throw new Error('An unfinished transaction requires recover or abort.');
      if (!this.drivers[side]) throw new Error('Unknown source side.');
      const source = await this.drivers[side].inspect({ path, side, managed: false });
      assertComplete(source.common);
      await (this.drivers[side].assertReadable ?? this.drivers[side].assertIdle)({ ...source, path, side, managed: false });
      const existing = state.records.find(record => record.side === side && record.nativeId === source.nativeId);
      if (existing) return { conversationId: existing.conversationId, existing: true };
      const id = randomUUID();
      const firstText = source.common.messages.find(message => message.role === 'user')?.content.find(block => block.type === 'text')?.text;
      const derivedTitle = firstText?.trim().split('\n')[0].slice(0, 100);
      state.conversations[id] = { id, cwd: source.common.meta.cwd, title: title || source.common.meta.title || derivedTitle || 'Claudex conversation' };
      state.records.push({ id: randomUUID(), nativeId: source.nativeId, path: source.path ?? path, conversationId: id, cwd: source.common.meta.cwd,
        side, managed: false, verified: true, status: 'current', bytes: source.bytes, createdAt: this.now(),
        checkpoint: source.digest, messageCount: source.common.messages.length });
      await this.save(state, { event: 'tracked', conversationId: id, side });
      return { conversationId: id, existing: false };
    });
  }

  async sync(conversationId, side) {
    return this.locked(async state => {
      if (state.pending) throw new Error('An unfinished transaction requires recover or abort.');
      await this.collectInLock(state);
      const sourceRecord = this.current(state, conversationId, side);
      if (!sourceRecord) throw new Error('No tracked source for this conversation and side.');
      const otherSide = side === 'codex' ? 'claude' : 'codex';
      const target = this.current(state, conversationId, otherSide);
      await (this.drivers[side].assertReadable ?? this.drivers[side].assertIdle)(sourceRecord);
      const source = await this.drivers[side].inspect(sourceRecord);
      assertComplete(source.common);
      if (fingerprint(source.common, sourceRecord.messageCount) !== sourceRecord.checkpoint) throw new Error('Source history changed before its checkpoint; automatic handoff paused.');
      if (target) {
        const destination = await this.drivers[otherSide].inspect(target);
        if (source.digest === sourceRecord.checkpoint) return { changed: false, reason: 'No new source messages.' };
        if (destination.digest !== target.checkpoint) throw new Error('Both sides have unsynchronized changes. Choose a branch; no history was replaced.');
        await this.drivers[otherSide].assertIdle(target);
      }
      const nativeId = randomUUID();
      const conversation = state.conversations[conversationId];
      const common = { ...source.common, meta: { ...source.common.meta, cwd: conversation.cwd, timestamp: new Date(this.now()).toISOString() } };
      if (this.drivers[otherSide].expected && fingerprint(this.drivers[otherSide].expected(common, nativeId)) !== fingerprint(common)) {
        throw new Error('This conversion changes canonical history; unsupported content was not silently dropped.');
      }
      const plan = await this.drivers[otherSide].plan({ nativeId, common, title: conversation.title });
      const record = { ...plan, id: randomUUID(), nativeId, conversationId, cwd: conversation.cwd, side: otherSide, managed: true,
        verified: false, status: 'current', bytes: 0, createdAt: this.now() };
      state.pending = { phase: 'prepared', sourceId: sourceRecord.id, sourceDigest: source.digest,
        oldTargetId: target?.id ?? null, record, common, title: conversation.title };
      await this.save(state, { event: 'prepared', conversationId, side: otherSide });
      return this.completeInLock(state);
    });
  }

  async recover() {
    return this.locked(async state => state.pending ? this.completeInLock(state) : { changed: false, reason: 'No pending transaction.' });
  }

  async completeInLock(state) {
    const pending = state.pending;
    const driver = this.drivers[pending.record.side];
    const sourceRecord = state.records.find(record => record.id === pending.sourceId);
    if (!sourceRecord) throw new Error('Transaction source is missing.');
    if (pending.phase !== 'promoted') {
      await (this.drivers[sourceRecord.side].assertReadable ?? this.drivers[sourceRecord.side].assertIdle)(sourceRecord);
      const source = await this.drivers[sourceRecord.side].inspect(sourceRecord);
      if (source.digest !== pending.sourceDigest) throw new Error('Source changed during handoff; abort the unpublished projection and sync again.');
      const oldTarget = state.records.find(record => record.id === pending.oldTargetId);
      if (oldTarget) {
        await driver.assertIdle(oldTarget);
        if ((await driver.inspect(oldTarget)).digest !== oldTarget.checkpoint) throw new Error('Destination changed during handoff; abort required.');
      }
      // materialize must recover only an exact owned projection, never overwrite.
      await driver.materialize(pending.record, pending.common, pending.title);
      const verified = await driver.verify(pending.record, pending.common);
      pending.record = { ...pending.record, ...verified, verified: true, checkpoint: verified.digest, messageCount: verified.common.messages.length };
      delete pending.record.common;
      delete pending.record.digest;
      pending.phase = 'verified';
      await this.save(state, { event: 'verified', conversationId: pending.record.conversationId });
      if ((await this.drivers[sourceRecord.side].inspect(sourceRecord)).digest !== pending.sourceDigest) throw new Error('Source changed before promotion; abort required.');
      if (oldTarget) {
        if ((await driver.inspect(oldTarget)).digest !== oldTarget.checkpoint) throw new Error('Destination changed before promotion; abort required.');
        oldTarget.status = 'previous';
        oldTarget.retiredAt = this.now();
      }
      sourceRecord.checkpoint = source.digest;
      sourceRecord.messageCount = source.common.messages.length;
      sourceRecord.bytes = source.bytes;
      state.records.push(pending.record);
      pending.phase = 'promoted';
      await this.save(state, { event: 'promoted', conversationId: pending.record.conversationId });
    }
    const previous = state.records.find(record => record.id === pending.oldTargetId);
    if (previous?.managed) {
      await driver.assertIdle(previous);
      if ((await driver.inspect(previous)).digest !== previous.checkpoint) throw new Error('Previous version was edited; retirement paused.');
      Object.assign(previous, await driver.hide(previous));
    }
    // Original user sessions stay untouched and outside managed retention.
    if (previous && !previous.managed) previous.status = 'original';
    const result = { changed: true, conversationId: pending.record.conversationId, side: pending.record.side, nativeId: pending.record.nativeId, path: pending.record.path };
    state.pending = null;
    await this.save(state, { event: 'completed', conversationId: result.conversationId });
    await this.collectInLock(state);
    return result;
  }

  async abort() {
    return this.locked(async state => {
      const pending = state.pending;
      if (!pending) return { aborted: false };
      if (pending.phase === 'promoted') throw new Error('A promoted transaction must be recovered, not aborted.');
      const driver = this.drivers[pending.record.side];
      if (await driver.exists(pending.record)) {
        await driver.materialize(pending.record, pending.common, pending.title);
        await driver.verify(pending.record, pending.common);
        await driver.assertIdle(pending.record);
        await driver.remove(pending.record);
      }
      state.pending = null;
      await this.save(state, { event: 'aborted' });
      return { aborted: true };
    });
  }

  async collect() {
    return this.locked(async state => {
      if (state.pending) throw new Error('Recover the pending handoff before collection.');
      return this.collectInLock(state);
    });
  }

  async collectInLock(state) {
    for (const current of state.records.filter(record => record.status === 'current')) {
      const data = await this.drivers[current.side].inspect(current);
      if (fingerprint(data.common, current.messageCount) !== current.checkpoint) throw new Error('Current history changed before its checkpoint; old backups were preserved.');
    }
    const candidates = state.records.filter(record => record.managed && record.status === 'previous');
    for (const record of candidates) {
      const driver = this.drivers[record.side];
      if (!(await driver.exists(record))) {
        // A prior remove can have succeeded before its checkpoint was saved.
        state.records = state.records.filter(item => item.id !== record.id);
        continue;
      }
      const inspected = await driver.inspect(record);
      if (inspected.digest !== record.checkpoint) throw new Error('A retained version was edited; no automatic deletion is safe.');
      record.bytes = inspected.bytes;
      await driver.assertIdle(record);
    }
    const plan = planRetention(state.records.filter(record => record.managed).map(record => ({ ...record, createdAt: record.retiredAt ?? record.createdAt })), { now: this.now(), policy: this.policy });
    if (plan.blocked.length) throw new Error('Retention quota cannot be met safely; new handoffs are paused.');
    for (const id of plan.remove) {
      const record = state.records.find(item => item.id === id);
      if (!record?.managed || record.status !== 'previous' || !record.verified) throw new Error('Unsafe retention target.');
      const driver = this.drivers[record.side];
      await driver.assertIdle(record);
      if ((await driver.inspect(record)).digest !== record.checkpoint) throw new Error('Retention target changed; collection paused.');
      await driver.remove(record);
      state.records = state.records.filter(item => item.id !== id);
      await this.save(state, { event: 'pruned', conversationId: record.conversationId, side: record.side });
    }
    await this.save(state);
    return { removed: plan.remove.length, backupBytes: plan.backupBytes };
  }
}

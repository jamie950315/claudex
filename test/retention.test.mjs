import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, MAX_DEPENDENCY_ANCHORS, planRetention } from '../src/retention.mjs';

const now = 20 * 86400000;
const record = (id, overrides = {}) => ({ id, conversationId: 'one', side: 'codex', status: 'previous', managed: true, verified: true, bytes: 10, createdAt: now - 100, ...overrides });
const plan = (records, policy = {}) => planRetention(records, { now, policy });
const anchor = (id, overrides = {}) => record(id, { status: 'dependency-anchor', kind: 'snapshot', dependencyIds: ['child'], ...overrides });

test('dependency anchors survive count and age limits while counting toward the global byte quota', () => {
  const records = [anchor('anchor', { createdAt: 0 }), record('old', { createdAt: now - 200 }), record('latest')];
  const before = structuredClone(records);
  assert.deepEqual(plan(records), { keep: ['anchor', 'latest'], remove: ['old'], blocked: [], backupBytes: 20 });
  assert.deepEqual(plan([records[0]], { previousPerSide: 0 }), { keep: ['anchor'], remove: [], blocked: [], backupBytes: 10 });
  assert.deepEqual(records, before);
});

test('dependency anchor quota evicts disposable backups first and reports an unresolved protected quota', () => {
  const records = [anchor('anchor', { bytes: 11 }), record('backup')];
  assert.deepEqual(plan(records, { maxBackupBytes: 11 }), {
    keep: ['anchor'], remove: ['backup'], blocked: [], backupBytes: 11,
  });
  assert.deepEqual(plan(records, { maxBackupBytes: 10 }), {
    keep: ['anchor'], remove: ['backup'], blocked: [{ id: 'anchor', reason: 'dependency-anchor-quota' }], backupBytes: 11,
  });
});

test('dependency anchors have an explicit global count limit and are never pruned to meet it', () => {
  const records = Array.from({ length: MAX_DEPENDENCY_ANCHORS }, (_, index) => anchor(`anchor-${index}`));
  assert.equal(plan(records).blocked.length, 0);
  records.push(anchor('extra'));
  const result = plan(records);
  assert.deepEqual(result.remove, []);
  assert.deepEqual(result.keep, records.map(record => record.id));
  assert.equal(result.backupBytes, records.length * 10);
  assert.deepEqual(result.blocked, records.map(record => ({ id: record.id, reason: 'dependency-anchor-limit' })));
});

test('dependency anchors reject missing ownership and ambiguous dependency identities', () => {
  for (const overrides of [{ side: 'claude' }, { kind: 'owner' }, { managed: false }, { verified: false },
    { dependencyIds: undefined }, { dependencyIds: [] }, { dependencyIds: 'child' },
    { dependencyIds: [''] }, { dependencyIds: ['child', 'child'] }])
    assert.throws(() => plan([anchor('bad', overrides)]), TypeError);
});

test('caps previous versions independently per conversation and side without mutating records', () => {
  const records = [record('old', { createdAt: now - 200 }), record('latest'), record('claude', { side: 'claude' }), record('other', { conversationId: 'two' }), record('current', { status: 'current', bytes: Number.MAX_SAFE_INTEGER })];
  const before = structuredClone(records);
  assert.deepEqual(plan(records), { keep: ['latest', 'claude', 'other', 'current'], remove: ['old'], blocked: [], backupBytes: 30 });
  assert.deepEqual(records, before);
});

test('age cutoff is inclusive and younger backups remain', () => {
  assert.deepEqual(plan([record('at', { createdAt: now - DEFAULT_POLICY.maxAgeMs }), record('young', { createdAt: now - DEFAULT_POLICY.maxAgeMs + 1 })], { previousPerSide: 2 }).remove, ['at']);
});

test('global quota evicts oldest backups across conversations, including otherwise retained backups', () => {
  const records = [record('new', { conversationId: 'new' }), record('old', { conversationId: 'old', createdAt: now - 300 }), record('middle', { conversationId: 'middle', createdAt: now - 200 })];
  assert.deepEqual(plan(records, { maxBackupBytes: 10 }), { keep: ['new'], remove: ['old', 'middle'], blocked: [], backupBytes: 10 });
  assert.equal(plan([record('equal')], { maxBackupBytes: 10 }).remove.length, 0);
});

test('protected candidates are retained and unresolved quota stays visible', () => {
  const records = [record('original', { managed: false }), record('unchecked', { verified: false }), record('active', { busy: true }), record('parent', { dependentIds: ['child'] }), record('safe')];
  const result = plan(records, { previousPerSide: 0, maxBackupBytes: 0 });
  assert.deepEqual(result.remove, ['safe']);
  assert.equal(result.backupBytes, 40);
  assert.deepEqual(Object.fromEntries(result.blocked.map(item => [item.id, item.reason])), { original: 'unmanaged', unchecked: 'unverified', active: 'busy', parent: 'dependent-records' });
});

test('current versions are never candidates, even when unverified, old, or beyond byte quota', () => {
  assert.deepEqual(plan([record('current', { status: 'current', verified: false, createdAt: 0, bytes: 999 })], { previousPerSide: 0, maxBackupBytes: 0 }), { keep: ['current'], remove: [], blocked: [], backupBytes: 0 });
});

test('zero backup count is supported and newer protected backup does not prevent old safe eviction', () => {
  assert.deepEqual(plan([record('one'), record('two', { side: 'claude' })], { previousPerSide: 0 }).remove, ['one', 'two']);
  assert.deepEqual(plan([record('old', { createdAt: now - 200 }), record('protected', { busy: true })]).remove, ['old']);
});

test('invalid records and policies fail explicitly', () => {
  for (const overrides of [{ id: '' }, { conversationId: '' }, { side: 'other' }, { status: 'old' }, { managed: 1 }, { verified: null }, { busy: 'yes' }, { bytes: -1 }, { bytes: Infinity }, { bytes: 0.5 }, { createdAt: NaN }, { createdAt: -1 }, { createdAt: 8640000000000001 }, { dependentIds: 'x' }, { dependentIds: [''] }, { dependentIds: ['x', 'x'] }]) assert.throws(() => plan([record('bad', overrides)]), TypeError);
  assert.throws(() => plan([record('same'), record('same')]), /Duplicate/);
  assert.throws(() => plan([record('a', { bytes: Number.MAX_SAFE_INTEGER }), record('b')]), /Total backup/);
  for (const key of Object.keys(DEFAULT_POLICY)) for (const value of [-1, 0.5, Infinity, '1', undefined]) assert.throws(() => plan([], { [key]: value }), TypeError);
  assert.throws(() => plan([], { unknown: true }), /Unknown/);
  assert.throws(() => planRetention([], { now: NaN }), TypeError);
  assert.throws(() => plan(null), TypeError);
  assert.throws(() => plan([], null), TypeError);
});

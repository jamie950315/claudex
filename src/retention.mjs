export const DEFAULT_POLICY = Object.freeze({
  previousPerSide: 1,
  maxAgeMs: 7 * 86400000,
  maxBackupBytes: 512 * 1024 * 1024,
  maxAuditEntries: 50,
});

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
}

function timestamp(value, label) {
  nonnegativeInteger(value, label);
  if (value > 8640000000000000) throw new TypeError(`${label} must be a valid timestamp`);
}

function nonemptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string`);
}

/** Plan only: callers must recheck ownership, activity, and dependencies before removal. */
export function planRetention(records, { now = Date.now(), policy = DEFAULT_POLICY } = {}) {
  timestamp(now, 'now');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('policy must be an object');
  for (const key of Object.keys(policy)) {
    if (!Object.hasOwn(DEFAULT_POLICY, key)) throw new TypeError(`Unknown policy field: ${key}`);
  }
  const limits = { ...DEFAULT_POLICY, ...policy };
  for (const [key, value] of Object.entries(limits)) nonnegativeInteger(value, key);
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const ids = new Set();
  let backupBytes = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('record must be an object');
    nonemptyString(record.id, 'id');
    if (ids.has(record.id)) throw new TypeError(`Duplicate record id: ${record.id}`);
    ids.add(record.id);
    nonemptyString(record.conversationId, 'conversationId');
    if (!['codex', 'claude'].includes(record.side)) throw new TypeError('Invalid record side');
    if (!['current', 'previous'].includes(record.status)) throw new TypeError('Invalid record status');
    for (const key of ['managed', 'verified']) {
      if (typeof record[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`);
    }
    if (record.busy !== undefined && typeof record.busy !== 'boolean') throw new TypeError('busy must be a boolean');
    nonnegativeInteger(record.bytes, 'bytes');
    timestamp(record.createdAt, 'createdAt');
    if (record.dependentIds !== undefined) {
      if (!Array.isArray(record.dependentIds)) throw new TypeError('dependentIds must be an array');
      record.dependentIds.forEach(id => nonemptyString(id, 'dependentId'));
      if (new Set(record.dependentIds).size !== record.dependentIds.length) throw new TypeError('Duplicate dependent id');
    }
    if (record.status === 'previous') {
      backupBytes += record.bytes;
      nonnegativeInteger(backupBytes, 'Total backup bytes');
    }
  }

  const previous = records.filter(record => record.status === 'previous')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const groups = new Map();
  for (const record of previous) {
    const key = JSON.stringify([record.conversationId, record.side]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const candidates = new Set(previous.filter(record => now - record.createdAt >= limits.maxAgeMs).map(record => record.id));
  for (const group of groups.values()) {
    for (const record of group.slice(0, Math.max(0, group.length - limits.previousPerSide))) candidates.add(record.id);
  }
  const remove = new Set();
  const blocked = new Map();
  function evict(record) {
    const reason = !record.managed ? 'unmanaged' : !record.verified ? 'unverified' : record.busy ? 'busy'
      : record.dependentIds?.length ? 'dependent-records' : null;
    if (reason) { blocked.set(record.id, { id: record.id, reason }); return; }
    remove.add(record.id);
    backupBytes -= record.bytes;
  }
  for (const record of previous) if (candidates.has(record.id)) evict(record);
  for (const record of previous) {
    if (backupBytes <= limits.maxBackupBytes) break;
    if (!remove.has(record.id)) evict(record);
  }
  return {
    keep: records.filter(record => !remove.has(record.id)).map(record => record.id),
    remove: previous.filter(record => remove.has(record.id)).map(record => record.id),
    blocked: [...blocked.values()],
    backupBytes,
  };
}

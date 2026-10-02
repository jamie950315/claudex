import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

function eligibleRecords(state, id) {
  if (state.pending || state.conversations[id]?.discoveryMode !== 'cold-import') return null;
  const records = state.records.filter(record => record.conversationId === id);
  if (!records.length || records.some(record => record.side === 'claude' && record.managed
    && record.kind === 'owner' && record.status === 'current')) return null;
  return records;
}

/** Read-only change hints, never evidence that a semantic checkpoint advanced.
 * Include superseded originals: activity there remains a conflict, not silence.
 */
export async function coldImportHint(state, id) {
  const records = eligibleRecords(state, id);
  if (!records) return null;
  const files = [];
  for (const record of records) {
    const path = record.path;
    if (typeof path !== 'string' || !isAbsolute(path)) return null;
    try {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isFile() || await realpath(path) !== resolve(path)) return null;
      files.push([path, ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink']
        .map(key => stat[key].toString())]);
    } catch {
      // A missing/unreadable path is not unchanged. The normal full sync must
      // handle it and expose any semantic or lifecycle failure to the caller.
      return null;
    }
  }
  return JSON.stringify({ conversation: state.conversations[id], records, files });
}

/** Inactive native metadata is needed only when establishing a fresh hint.
 * Live SDK owners are excluded above; Local Claude appends change their file.
 */
export async function coldImportInactive(state, id, codex) {
  const records = eligibleRecords(state, id);
  if (!records) return false;
  for (const record of records.filter(record => record.side === 'codex')) {
    const thread = (await codex.request('thread/read', { threadId: record.nativeId, includeTurns: false }))?.thread;
    if (!thread || thread.id !== record.nativeId) throw new Error('Codex returned a different native identity.');
    if (!['idle', 'notLoaded'].includes(thread.status?.type)) return false;
  }
  return true;
}

/** Persistent reuse is narrower than in-process hints: only untouched original
 * pairs, never managed owners, retained snapshots or special provenance chains.
 */
export function persistentColdEligible(state, id) {
  const records = eligibleRecords(state, id), canonical = state.conversations[id]?.canonical;
  if (!records || records.length !== 2 || !canonical || !Number.isSafeInteger(canonical.count)
    || canonical.count < 1 || !/^[a-f0-9]{64}$/.test(canonical.digest ?? '')) return false;
  if (records.some(record => record.status !== 'current' || record.managed !== false || record.kind !== 'original'
    || record.verified !== true || record.relocation || record.localImageRollouts
    || record.checkpoint?.count !== canonical.count || record.checkpoint?.digest !== canonical.digest)) return false;
  const claude = records.find(record => record.side === 'claude');
  return records.filter(record => record.side === 'codex').length === 1
    && claude?.importPacket === true && claude.packetVersion === 2;
}

export async function persistentColdNativeIdentity(state, id, codex) {
  if (!persistentColdEligible(state, id)) return null;
  const record = state.records.find(record => record.conversationId === id && record.side === 'codex');
  const thread = (await codex.request('thread/read', { threadId: record.nativeId, includeTurns: false }))?.thread;
  if (!thread || thread.id !== record.nativeId) throw new Error('Codex returned a different native identity.');
  if (!['idle', 'notLoaded'].includes(thread.status?.type) || typeof thread.path !== 'string'
    || typeof thread.cwd !== 'string') return null;
  // Missing native paths invalidate reuse, not the watcher. The normal full
  // inspection supplies the precise tracked-history/directory diagnostic.
  const resolved = await Promise.allSettled([realpath(thread.path), realpath(thread.cwd)]);
  const unexpected = resolved.find(result => result.status === 'rejected'
    && !['ENOENT', 'ENOTDIR'].includes(result.reason?.code));
  if (unexpected) throw unexpected.reason;
  if (resolved.some(result => result.status === 'rejected')) return null;
  const [path, cwd] = resolved.map(result => result.value);
  if (path !== record.path || cwd !== record.cwd) return null;
  return { nativeId: thread.id, path, cwd, inactive: true, updatedAt: thread.updatedAt ?? null };
}

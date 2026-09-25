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

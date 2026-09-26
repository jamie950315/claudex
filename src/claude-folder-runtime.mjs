import { buildClaudeFolderProjection, lookupClaudeFolderProjection } from './claude-folder-projection.mjs';

/** Read-only, bounded presentation subscription. No native session is created
 * or mutated. This factory is also embedded in the version-pinned UI resource.
 */
export function createClaudeFolderRuntime({ readMap, intervalMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => {} } = {}) {
  let entries = [], revision = 0, text = '', timer, reading = false, generation = 0, lastError = null;
  let rows, keyFunction, projectionRevision = -1;
  let projection = { version: 1, overrides: {} };
  const listeners = new Set();
  const notify = () => { revision++; for (const listener of listeners) listener(); };
  function accept(result) {
    if (!result || typeof result.contents !== 'string' || result.contents.length > 2 * 1024 * 1024 || result.isTail)
      throw new Error('Folder mapping unavailable or truncated');
    if (text === result.contents) return;
    const data = JSON.parse(result.contents);
    if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 4096
        || Object.keys(data).some(key => !['version', 'entries'].includes(key))
        || data.entries.some(entry => !entry || entry.verified !== true || typeof entry.remoteId !== 'string'
          || !/^cse_[A-Za-z0-9_-]{1,200}$/.test(entry.remoteId) || typeof entry.canonicalCwd !== 'string'
          || !entry.canonicalCwd.startsWith('/') || entry.canonicalCwd.length > 4096
          || Object.keys(entry).some(key => !['remoteId', 'canonicalCwd', 'verified'].includes(key))))
      throw new Error('Invalid folder mapping');
    entries = data.entries; text = result.contents; lastError = null; notify();
  }
  async function poll() {
    if (!listeners.size || reading || typeof readMap !== 'function') return;
    const observed = generation; reading = true;
    try { const result = await readMap(); if (observed === generation && listeners.size) accept(result); }
    catch (error) {
      if (observed !== generation || !listeners.size) return;
      if (text || entries.length) { text = ''; entries = []; notify(); }
      const message = String(error.message ?? error).slice(0, 200);
      if (message !== lastError) { lastError = message; onError(message); }
    } finally {
      reading = false;
      if (listeners.size) timer = setTimer(poll, intervalMs);
    }
  }
  return {
    getSnapshot: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) { generation++; void poll(); }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { generation++; if (timer !== undefined) clearTimer(timer); timer = undefined; }
      };
    },
    setRows(localRows, projectKey) {
      if (rows === localRows && keyFunction === projectKey && projectionRevision === revision) return;
      projection = buildClaudeFolderProjection({ entries, localRows, projectKey });
      rows = localRows; keyFunction = projectKey; projectionRevision = revision;
    },
    lookup(row) { return row?.type === 'bridge' ? lookupClaudeFolderProjection(projection, row.id) : undefined; },
  };
}

/** Embedded only in the pinned conversation component. Open and native submit
 * callbacks provide identity, never prompt text. No global input interception.
 */
export function createClaudeOwnerWakeRuntime({ readMap, callTool, now = Date.now,
  onError = () => {} } = {}) {
  let running = false, generation = 0, lastError;
  const recent = new Map(), pending = new Set();
  const remoteId = value => typeof value === 'string' && /^(?:cse_|session_)[A-Za-z0-9_-]{1,200}$/.test(value)
    ? value.replace(/^session_/, 'cse_') : null;
  const error = message => {
    message = String(message).slice(0, 200);
    if (message !== lastError) { lastError = message; onError(message); }
  };
  async function signal(identity) {
    const id = remoteId(identity), ticket = generation;
    if (!running || !id || pending.has(id)) return;
    for (const [key, at] of recent) if (now() - at >= 30_000) recent.delete(key);
    if (recent.has(id) && now() - recent.get(id) < 5000 || recent.size >= 16 || pending.size >= 16) return;
    recent.set(id, now()); pending.add(id);
    try {
      if (typeof readMap !== 'function' || typeof callTool !== 'function') throw new Error('Owner wake native API is unavailable');
      const read = await readMap();
      if (!read || typeof read.contents !== 'string' || read.contents.length > 2 * 1024 * 1024 || read.isTail)
        throw new Error('Owner wake folder map is unavailable or truncated');
      const map = JSON.parse(read.contents);
      if (map?.version !== 1 || Object.keys(map).sort().join(',') !== 'entries,version'
        || !Array.isArray(map.entries) || map.entries.length > 4096) throw new Error('Owner wake folder map is invalid');
      const ids = new Set();
      for (const row of map.entries) {
        if (!row || Object.keys(row).sort().join(',') !== 'canonicalCwd,remoteId,verified'
          || row.verified !== true || remoteId(row.remoteId) !== row.remoteId || ids.has(row.remoteId)
          || typeof row.canonicalCwd !== 'string' || !row.canonicalCwd.startsWith('/') || row.canonicalCwd.length > 4096
          || /[\x00-\x1f\x7f]/.test(row.canonicalCwd)) throw new Error('Owner wake folder map identity is invalid');
        ids.add(row.remoteId);
      }
      if (!running || ticket !== generation || !ids.has(id)) return;
      const result = await callTool('claudex-desktop-wake', 'claudex_desktop_owner_wake', { remoteId: id });
      if (result?.isError) throw new Error('Owner wake native MCP call was refused');
      let receipt = result?.structuredContent;
      if (!receipt) {
        const text = result?.content?.filter(item => item.type === 'text');
        if (text?.length !== 1 || typeof text[0].text !== 'string' || text[0].text.length > 2048)
          throw new Error('Owner wake receipt is invalid');
        receipt = JSON.parse(text[0].text);
      }
      if (typeof receipt?.accepted !== 'boolean') throw new Error('Owner wake receipt is invalid');
      if (!receipt.accepted) error(`Owner wake deferred: ${String(receipt.reason ?? 'not accepted').slice(0, 150)}`);
      else lastError = null;
    } catch (failure) { error(failure?.message ?? failure); }
    finally { pending.delete(id); }
  }
  return { signal, start() { running = true; generation++; }, stop() { running = false; generation++; } };
}

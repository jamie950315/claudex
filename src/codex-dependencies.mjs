const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const kinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const MAX_PAGES = 100;
const MAX_IDS = 10000;
const fail = message => {
  throw Object.assign(new Error(`Codex dependency inventory: ${message}`), { code: 'CLAUDEX_DEPENDENCY_ANCHOR_BLOCKED' });
};
const validId = value => typeof value === 'string' && UUID.test(value);

function relationship(thread) {
  const spawn = thread.source?.subAgent?.thread_spawn;
  if (spawn != null && (typeof spawn !== 'object' || Array.isArray(spawn) || !validId(spawn.parent_thread_id)))
    fail('spawn parent identity is malformed.');
  const fork = thread.forkedFromId;
  if (fork != null && !validId(fork)) fail('fork parent identity is malformed.');
  if (spawn && fork != null && spawn.parent_thread_id !== fork) fail('parent identity is ambiguous.');
  return spawn ? { parentId: spawn.parent_thread_id, kind: 'spawn' }
    : fork != null ? { parentId: fork, kind: 'fork' } : null;
}

// Metadata only. A dependency preserves a snapshot as an anchor; this inventory
// does not authorize native archival, retirement, loading or transcript writes.
export async function readCodexDependencies(client, parentId) {
  if (!validId(parentId)) fail('parent identity is malformed.');
  const ids = new Set(), ancestorIds = new Set(), listed = new Map();
  for (const mode of [{ loaded: true }, { archived: false }, { archived: true },
    { archived: false, ancestorThreadId: parentId }, { archived: true, ancestorThreadId: parentId }]) {
    let cursor; const cursors = new Set(); let pages = 0;
    do {
      if (++pages > MAX_PAGES) fail('page limit exceeded.');
      const page = await client.request(mode.loaded ? 'thread/loaded/list' : 'thread/list', {
        limit: 100, ...(mode.loaded ? {} : { ...mode, sourceKinds: kinds }), ...(cursor ? { cursor } : {}),
      });
      if (!page || !Array.isArray(page.data) || page.data.length > 100) fail('page is malformed.');
      for (const row of page.data) {
        const id = mode.loaded ? row : row?.id;
        if (!validId(id)) fail('native identity is malformed.');
        ids.add(id);
        if (ids.size > MAX_IDS) fail('identity limit exceeded.');
        if (mode.ancestorThreadId) ancestorIds.add(id);
        if (!mode.loaded) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) fail('metadata is malformed.');
          // Native lists may omit relationship fields. Any fields they expose
          // must agree with the authoritative metadata read.
          const witnesses = listed.get(id) ?? [];
          witnesses.push(row); listed.set(id, witnesses);
        }
      }
      cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096 || cursors.has(cursor)))
        fail('pagination cursor is malformed or repeated.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  const metadata = new Map();
  async function read(id) {
    if (metadata.has(id)) return metadata.get(id);
    if (!ids.has(id)) { ids.add(id); if (ids.size > MAX_IDS) fail('identity limit exceeded.'); }
    const result = await client.request('thread/read', { threadId: id, includeTurns: false });
    const thread = result?.thread;
    if (!thread || thread.id !== id) fail('native identity changed.');
    const edge = relationship(thread);
    for (const row of listed.get(id) ?? []) {
      // The native list can expose null even when metadata thread/read proves
      // fork ancestry. Only a concrete listed parent is a conflicting witness.
      if (row.forkedFromId != null && row.forkedFromId !== (thread.forkedFromId ?? null))
        fail('listed fork identity changed.');
      if (row.source?.subAgent?.thread_spawn != null
        && relationship(row)?.parentId !== edge?.parentId) fail('listed spawn identity changed.');
    }
    metadata.set(id, edge); return edge;
  }
  for (const id of [...ids].sort()) await read(id);
  // Ancestor queries can include nested agents. Authenticate their parent chain
  // rather than treating a query result as proof of a direct relationship.
  for (const id of ancestorIds) {
    const seen = new Set([parentId]); let current = id;
    while (current !== parentId) {
      if (seen.has(current)) fail('ancestry cycle detected.');
      seen.add(current);
      if (seen.size > 100) fail('ancestry depth limit exceeded.');
      const edge = await read(current);
      if (!edge) fail('ancestor query returned an unrelated native identity.');
      current = edge.parentId;
    }
  }
  return [...metadata].filter(([id, edge]) => id !== parentId && edge?.parentId === parentId)
    .map(([id, edge]) => ({ id, ...edge })).sort((a, b) => a.id.localeCompare(b.id));
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const kinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const MAX_PAGES = 100;
const MAX_IDS = 10000;
const fail = message => {
  throw Object.assign(new Error(`Codex dependency inventory: ${message}`), { code: 'CLAUDEX_DEPENDENCY_ANCHOR_BLOCKED' });
};
const validId = value => typeof value === 'string' && UUID.test(value);

export function codexSourceReadFailure(error, nativeId, options = {}) {
  if (error instanceof Error && error.name !== 'AbortError') error.nativeSource ??= {
    side: 'codex', nativeId, parentIds: options.parentIds ?? [], transientCandidate: options.transientCandidate === true,
  };
  return error;
}

/** A fresh, bounded native absence check, only after a loaded-only metadata
 * read failed. Stored/ancestor witnesses and still-loaded sources remain guards. */
export async function codexInventoryContains(client, nativeId, parentIds = []) {
  if (!validId(nativeId) || !Array.isArray(parentIds) || parentIds.length > MAX_IDS || parentIds.some(id => !validId(id)))
    fail('parent or source identity is malformed.');
  for (const mode of [{ loaded: true }, { archived: false }, { archived: true },
    ...parentIds.flatMap(ancestorThreadId => [{ archived: false, ancestorThreadId }, { archived: true, ancestorThreadId }])]) {
    let cursor; const cursors = new Set(); let pages = 0;
    do {
      if (++pages > MAX_PAGES) fail('page limit exceeded.');
      const page = await client.request(mode.loaded ? 'thread/loaded/list' : 'thread/list', {
        limit: 100, ...(mode.loaded ? {} : { ...mode, sourceKinds: kinds }), ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page?.data) || page.data.length > 100) fail('page is malformed.');
      for (const row of page.data) {
        const id = mode.loaded ? row : row?.id;
        if (!validId(id)) fail('native identity is malformed.');
        if (id.toLowerCase() === nativeId.toLowerCase()) return true;
      }
      cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096 || cursors.has(cursor)))
        fail('pagination cursor is malformed or repeated.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  return false;
}

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
export async function readCodexDependencies(client, parentId, options) {
  return (await readCodexDependenciesForParents(client, [parentId], options)).get(parentId);
}

// One fresh collection inventory classifies multiple retirement candidates.
// Global witnesses are read once; each parent's ancestor query and chain still
// receive independent validation. Nothing survives this invocation.
export async function readCodexDependenciesForParents(client, parentIds, { readMetadata = (id) =>
  client.request('thread/read', { threadId: id, includeTurns: false }) } = {}) {
  if (!Array.isArray(parentIds) || parentIds.length > MAX_IDS || parentIds.some(id => !validId(id)))
    fail('parent identity is malformed.');
  const parents = [...new Set(parentIds)];
  if (!parents.length) return new Map();
  const ids = new Set(), ancestorIds = new Map(parents.map(id => [id, new Set()])), listed = new Map();
  for (const mode of [{ loaded: true }, { archived: false }, { archived: true },
    ...parents.flatMap(parentId => [{ archived: false, ancestorThreadId: parentId }, { archived: true, ancestorThreadId: parentId }])]) {
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
        if (mode.ancestorThreadId) ancestorIds.get(mode.ancestorThreadId).add(id);
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
    const inventoried = ids.has(id);
    if (!ids.has(id)) { ids.add(id); if (ids.size > MAX_IDS) fail('identity limit exceeded.'); }
    const options = { parentIds: parents, transientCandidate: !parents.includes(id) && !listed.has(id)
      && ![...ancestorIds.values()].some(values => values.has(id)) && inventoried };
    let result;
    try { result = await readMetadata(id, options); }
    catch (error) { throw codexSourceReadFailure(error, id, options); }
    if (result === null && options.transientCandidate) { metadata.set(id, null); return null; }
    try {
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
    } catch (error) {
      // A contradiction is never a transient read failure eligible for absence.
      throw codexSourceReadFailure(error, id, { ...options, transientCandidate: false });
    }
  }
  for (const id of [...ids].sort()) await read(id);
  // Ancestor queries can include nested agents. Authenticate their parent chain
  // rather than treating a query result as proof of a direct relationship.
  for (const [parentId, descendants] of ancestorIds) for (const id of descendants) {
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
  return new Map(parents.map(parentId => [parentId,
    [...metadata].filter(([id, edge]) => id !== parentId && edge?.parentId === parentId)
      .map(([id, edge]) => ({ id, ...edge })).sort((a, b) => a.id.localeCompare(b.id))]));
}

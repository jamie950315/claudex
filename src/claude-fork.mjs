const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const authoredTypes = new Set(['user', 'assistant', 'system', 'attachment']);

export const FORK_REJECTED = 'Forked Claude history belongs to another native session; it was not enrolled.';

const lines = text => {
  const values = text.split('\n');
  if (values.at(-1) === '') values.pop();
  return values;
};

/** Identify a Claude Desktop fork from its transcript text alone. A fork file
 * starts with rows copied from its parent under the parent's session ID and
 * continues under its own file identity. Returns null for an ordinary file.
 */
export function claudeForkParent(text, nativeId) {
  if (!UUID.test(nativeId ?? '')) return null;
  const sessions = new Set();
  for (const line of lines(text)) {
    const row = JSON.parse(line);
    if (typeof row.sessionId === 'string' && row.sessionId !== nativeId) sessions.add(row.sessionId);
  }
  if (!sessions.size) return null;
  const [parentId] = sessions;
  if (sessions.size !== 1 || !UUID.test(parentId)) throw new Error(FORK_REJECTED);
  return parentId;
}

/** Prove that every row under the parent's identity is an exact copied prefix
 * of the parent's own transcript. Rows are compared as native bytes; nothing
 * is rewritten, reordered or adopted from the parent's later history. Only
 * identity-free session metadata may follow the byte-identical copied prefix.
 */
export function assertClaudeForkPrefix({ text, nativeId, parentId, parentText }) {
  const own = lines(text), parent = lines(parentText);
  const rows = own.map(line => JSON.parse(line));
  let boundary = rows.findIndex(row => row.sessionId === nativeId);
  if (boundary < 0) boundary = rows.length;
  if (!rows.slice(0, boundary).some(row => row.sessionId === parentId)
      || rows.slice(boundary).some(row => row.sessionId !== undefined && row.sessionId !== nativeId))
    throw new Error(FORK_REJECTED);
  let shared = 0;
  while (shared < boundary && shared < parent.length && own[shared] === parent[shared]) shared++;
  if (!shared || rows.slice(shared, boundary).some(row => row.uuid !== undefined || authoredTypes.has(row.type)
      || row.message !== undefined || (row.sessionId !== undefined && row.sessionId !== parentId)))
    throw new Error(FORK_REJECTED);
  return { parentId, sharedLines: shared, ownRows: rows.length - boundary };
}

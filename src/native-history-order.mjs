import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ordered = value => Array.isArray(value) ? value.map(ordered) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const fail = message => { throw new Error(`Native Codex history ordering: ${message}`); };
const key = (turnId, itemId) => JSON.stringify([turnId, itemId]);

export function nativeItemDigest(item) {
  return createHash('sha256').update(JSON.stringify(ordered(item))).digest('hex');
}

/** Keep native turns intact. A proven late completion changes only portable
 * display order; every native item still appears exactly once with its parent.
 */
export function nativeHistoryEntries(snapshot, { arrivalOrder = snapshot?.nativeItemOrder !== 'legacy' } = {}) {
  if (!Array.isArray(snapshot?.turns) || typeof arrivalOrder !== 'boolean') fail('invalid native snapshot.');
  if (snapshot.nativeItemOrder !== undefined && !['legacy', 'arrival'].includes(snapshot.nativeItemOrder)) fail('invalid native item order.');
  const proof = snapshot.lateItemEvidence, turns = new Map(), items = new Map();
  for (const [index, turn] of snapshot.turns.entries()) {
    if (typeof turn?.id !== 'string' || turns.has(turn.id) || !Array.isArray(turn.items)) fail('ambiguous native turn identity.');
    turns.set(turn.id, { turn, index });
    for (const item of turn.items) {
      const identity = key(turn.id, item?.id);
      if (typeof item?.id !== 'string' || !item.id || proof != null && items.has(identity)) fail('ambiguous native item identity.');
      items.set(identity, item);
    }
  }
  const moved = new Map(), after = new Map();
  if (proof != null) {
    if (!keys(proof, ['placements', 'sourceIdentity', 'evidenceDigest']) || !object(proof.sourceIdentity)
      || !/^[a-f0-9]{64}$/.test(proof.evidenceDigest ?? '') || !Array.isArray(proof.placements)
      || !proof.placements.length || proof.placements.length > items.size) fail('invalid late item provenance.');
    let previousBoundary = -1;
    for (const placement of proof.placements) {
      if (!keys(placement, ['turnId', 'itemId', 'afterTurnId', 'itemDigest'])) fail('invalid late item placement.');
      const parent = turns.get(placement.turnId), boundary = turns.get(placement.afterTurnId);
      const identity = key(placement.turnId, placement.itemId), item = items.get(identity);
      if (!parent || !boundary || boundary.index < parent.index || boundary.index < previousBoundary
        || boundary.turn.status !== 'completed' || boundary.turn.error != null
        || !boundary.turn.items.some(entry => entry.type === 'agentMessage' && entry.phase !== 'commentary'
          && typeof entry.text === 'string' && entry.text.trim())
        || !item || item.type !== 'commandExecution' || !['completed', 'failed'].includes(item.status)
        || moved.has(identity) || placement.itemDigest !== nativeItemDigest(item)) fail('late item identity or completed boundary differs from the API.');
      previousBoundary = boundary.index;
      moved.set(identity, placement);
      const list = after.get(placement.afterTurnId) ?? [];
      list.push({ kind: 'item', turnId: placement.turnId, item }); after.set(placement.afterTurnId, list);
    }
  }
  const entries = [];
  for (const turn of snapshot.turns) {
    for (const item of turn.items) if (!arrivalOrder || !moved.has(key(turn.id, item.id)))
      entries.push({ kind: 'item', turnId: turn.id, item });
    if (['failed', 'interrupted'].includes(turn.status)) entries.push({ kind: 'closedTurnStatus', turnId: turn.id,
      status: turn.status, ...(turn.error === undefined ? {} : { error: turn.error }) });
    if (arrivalOrder) entries.push(...(after.get(turn.id) ?? []));
  }
  return entries.map((entry, messageIndex) => ({ ...entry, messageIndex }));
}

export function nativeImagePositions(snapshot) {
  return nativeHistoryEntries(snapshot).filter(entry => entry.kind === 'item' && entry.item.type === 'userMessage'
    && entry.item.content?.some(input => input.type === 'localImage' || input.nativeLocalImage !== undefined))
    .map(({ turnId, item, messageIndex }) => ({ turnId, itemId: item.id, messageIndex }));
}

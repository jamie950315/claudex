const nonempty = value => typeof value === 'string' && value.length > 0;
const authored = row => row.type === 'user' || row.type === 'assistant';

/** Validate the observed split-response / parallel-result graph. Return only
 * virtual parents for graph validation; native rows, codec input, message order
 * and tool contents are never rewritten or discarded.
 */
export function parallelToolGraphParents(rows) {
  const byId = new Map(), duplicates = new Set(), children = new Map(), responses = new Map();
  const positions = new Map(), toolUses = new Map(), toolResults = new Map();
  rows.forEach((row, index) => {
    if (row.uuid) {
      if (byId.has(row.uuid)) duplicates.add(row.uuid);
      byId.set(row.uuid, row); positions.set(row.uuid, index);
    }
    if (authored(row) && row.parentUuid) {
      const list = children.get(row.parentUuid) ?? new Set(); list.add(row.uuid); children.set(row.parentUuid, list);
    }
    if (row.type === 'assistant' && nonempty(row.message?.id)) {
      const list = responses.get(row.message.id) ?? []; list.push(row); responses.set(row.message.id, list);
    }
    if (!Array.isArray(row.message?.content)) return;
    for (const block of row.message.content) {
      const map = row.type === 'assistant' && block.type === 'tool_use' ? toolUses
        : row.type === 'user' && block.type === 'tool_result' ? toolResults : null;
      if (!map) continue;
      const id = block.id ?? block.tool_use_id, list = map.get(id) ?? [];
      list.push(row); map.set(id, list);
    }
  });
  const candidates = new Set([...children].filter(([, ids]) => ids.size > 1)
    .map(([parent]) => byId.get(parent)?.message?.id).filter(nonempty));
  const parents = new Map();
  for (const id of candidates) {
    const group = responses.get(id) ?? [], first = group[0];
    if (group.length < 2 || !nonempty(first?.requestId) || !nonempty(first.message?.model) || !nonempty(first.sessionId)
        || !nonempty(first.cwd) || !nonempty(first.version)) continue;
    const anchor = byId.get(first.parentUuid);
    if (!anchor || duplicates.has(first.parentUuid) || positions.get(first.parentUuid) >= positions.get(first.uuid)
        || anchor.sessionId !== first.sessionId || anchor.cwd !== first.cwd) continue;
    const sameSession = row => row.sessionId === first.sessionId && row.cwd === first.cwd
      && row.version === first.version && row.isSidechain !== true && row.isMeta !== true && row.isSynthetic !== true;
    if (group.some((row, index) => !nonempty(row.uuid) || duplicates.has(row.uuid) || !sameSession(row)
        || row.requestId !== first.requestId || row.apiBlockIndex !== index || row.message?.role !== 'assistant'
        || row.message.model !== first.message.model || row.isApiErrorMessage === true
        || row.message.stop_reason !== 'tool_use' || !Array.isArray(row.message.content) || row.message.content.length !== 1
        || !['text', 'thinking', 'tool_use'].includes(row.message.content[0].type))) continue;
    const calls = group.filter(row => row.message.content[0].type === 'tool_use');
    if (calls.length < 2) continue;
    const results = [];
    let valid = true;
    for (const call of calls) {
      const block = call.message.content[0], matches = toolResults.get(block.id) ?? [];
      if (!nonempty(block.id) || toolUses.get(block.id)?.length !== 1 || matches.length !== 1) { valid = false; break; }
      const result = matches[0], content = result.message?.content;
      if (!nonempty(result.uuid) || duplicates.has(result.uuid) || !sameSession(result) || !nonempty(result.promptId)
          || result.message.role !== 'user' || result.sourceToolAssistantUUID !== call.uuid || result.parentUuid !== call.uuid
          || content.length !== 1 || content[0].type !== 'tool_result' || content[0].tool_use_id !== block.id
          || positions.get(result.uuid) <= positions.get(call.uuid)) { valid = false; break; }
      results.push(result);
    }
    if (!valid) continue;
    results.sort((a, b) => positions.get(a.uuid) - positions.get(b.uuid));
    if (results.some(row => row.promptId !== results[0].promptId)) continue;
    const members = new Set([...group, ...results].map(row => row.uuid));
    const start = positions.get(first.uuid), end = positions.get(results.at(-1).uuid);
    const toolHook = row => {
      const hook = row.attachment;
      if (row.type !== 'attachment' || !nonempty(row.uuid) || duplicates.has(row.uuid) || row.message !== undefined
          || !sameSession(row) || !members.has(row.parentUuid) || positions.get(row.parentUuid) >= positions.get(row.uuid)
          || hook?.type !== 'hook_success' || hook.hookEvent !== 'PreToolUse' || hook.exitCode !== 0
          || hook.content !== '' || hook.stderr !== '' || typeof hook.stdout !== 'string' || !nonempty(hook.command)
          || !Number.isFinite(hook.durationMs) || hook.durationMs < 0) return false;
      const call = calls.find(call => call.message.content[0].id === hook.toolUseID);
      const result = results.find(result => result.sourceToolAssistantUUID === call?.uuid);
      return Boolean(call && result && hook.hookName === `PreToolUse:${call.message.content[0].name}`
        && positions.get(call.uuid) < positions.get(row.uuid) && positions.get(row.uuid) < positions.get(result.uuid));
    };
    // The observed CLI can persist a successful, empty-display PreToolUse hook
    // between parallel results. Keep it in the native/codec input as inert
    // historical metadata; its command/stdout are never executed or replayed.
    if (rows.slice(start, end + 1).some(row => (authored(row) || row.uuid) && !members.has(row.uuid) && !toolHook(row))) continue;
    // One streamed response may contain multiple completed tool waves. A later
    // block must follow the last result only after every earlier call finished.
    // Validate physical order; never reorder, omit, or choose a native branch.
    const waveParents = new Map(), outstanding = new Set();
    let previous = first.parentUuid, returning = false;
    for (const row of rows.slice(start, end + 1)) {
      if (!members.has(row.uuid)) continue;
      if (row.type === 'assistant') {
        if (returning && outstanding.size || row.parentUuid !== previous) { valid = false; break; }
        returning = false;
        const block = row.message.content[0];
        if (block.type === 'tool_use') outstanding.add(block.id);
      } else {
        if (!outstanding.delete(row.message.content[0].tool_use_id)) { valid = false; break; }
        returning = true;
        waveParents.set(row.uuid, previous);
      }
      previous = row.uuid;
    }
    if (!valid || outstanding.size || previous !== results.at(-1).uuid
        || positions.get(group.at(-1).uuid) > end) continue;
    const join = results.at(-1).uuid;
    let exits = 0;
    for (const row of rows) {
      if (!authored(row) || members.has(row.uuid)) continue;
      let parent = row.parentUuid; const seen = new Set();
      // Follow inert attachment/system anchors only to prove that no outside
      // continuation escapes an earlier tool result or forks the final join.
      while (parent && byId.has(parent) && !authored(byId.get(parent))) {
        if (seen.has(parent) || duplicates.has(parent)) { valid = false; break; }
        seen.add(parent); parent = byId.get(parent).parentUuid;
      }
      if (!valid) break;
      if (members.has(parent) && (parent !== join || ++exits > 1)) { valid = false; break; }
    }
    if (!valid) continue;
    for (const [uuid, parent] of waveParents) parents.set(uuid, parent);
  }
  return parents;
}

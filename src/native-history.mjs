import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isInlineBase64 } from './base64.mjs';
import { assertComplete, fingerprint } from './history.mjs';
import { CODEX_RECONSTRUCTION_NOTICE, isNativeInitialDelegation } from './codex-delegation.mjs';
import { hydrateNativeLocalImages } from './native-local-images.mjs';
import { isNativeInitialGoalRequest } from './native-goal-request.mjs';

export const NATIVE_HISTORY_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxItems: 25000,
  maxPages: 256,
  pageSize: 100,
});

function fail(message) { throw new Error(`Native Codex history export: ${message}`); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}
function serialize(value) {
  try { return JSON.stringify(ordered(value)); } catch { fail('invalid JSON history.'); }
}
// Values parsed from serialize() output already enumerate keys in canonical
// order, and JSON.stringify(JSON.parse(text)) reproduces that text exactly.
// Hash them directly instead of rebuilding an ordered deep copy.
function canonicalDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

// Codex Desktop attaches a full-page screenshot of the tool surface to each
// Browser Use/computer-use call for its own UI. It is presentation metadata,
// not model input (the call's content keeps any model-visible image), and can
// dominate a history. When requested, it is replaced by an explicit record of
// what was omitted; nothing else in the item changes.
const DISPLAY_SCREENSHOT = /^data:(image\/(?:png|jpeg|webp|gif));base64,/;
export function omitDisplayScreenshots(turns) {
  for (const turn of turns) for (const item of Array.isArray(turn?.items) ? turn.items : []) {
    const surface = item?.type === 'mcpToolCall' ? item.result?._meta?.['codex/toolSurface'] : null;
    const screenshot = object(surface) ? surface.screenshot : null;
    const match = object(screenshot) && typeof screenshot.url === 'string' ? DISPLAY_SCREENSHOT.exec(screenshot.url) : null;
    if (!match) continue;
    surface.screenshot = { ...screenshot, url: null, omitted: { reason: 'display-only tool surface screenshot',
      mimeType: match[1], bytes: Buffer.byteLength(screenshot.url),
      sha256: createHash('sha256').update(screenshot.url).digest('hex') } };
  }
}

function checkedLimits(input) {
  if (input !== undefined && !object(input)) fail('limits must be an object.');
  const limits = { ...NATIVE_HISTORY_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!(name in NATIVE_HISTORY_LIMITS) || !Number.isSafeInteger(value) || value < 1) fail('invalid export limit.');
  }
  return limits;
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value * 1000).getTime())) fail('invalid native turn timestamp.');
  return value;
}

// An observed native completed control turn contains only this marker. It is
// history metadata, never a completed model reply or a new request boundary.
function compactionControl(turn) {
  const item = turn.items?.[0];
  return turn.status === 'completed' && turn.items?.length === 1 && object(item)
    && Object.keys(item).sort().join(',') === 'id,type'
    && item.type === 'contextCompaction' && typeof item.id === 'string' && item.id.length > 0;
}

const responseBoundary = turn => turn.status === 'completed' && !compactionControl(turn);

function validateTurn(turn, previousStart, { completedPrefix = false, allowActive = false, hasPriorRequest = false, allowInitialDelegation = false } = {}) {
  if (!object(turn) || typeof turn.id !== 'string' || !turn.id || !Array.isArray(turn.items)) fail('malformed turn.');
  if (turn.status === 'inProgress' && !allowActive) fail('wait for the in-progress turn to complete.');
  if (turn.status !== 'completed' && turn.status !== 'inProgress'
      && !(completedPrefix && ['failed', 'interrupted'].includes(turn.status))) fail('only completed, error-free turns can be exported.');
  if (turn.status === 'completed' && turn.error != null) fail('only completed, error-free turns can be exported.');
  // Require positive confirmation from the live API, not a schema default that
  // might disguise an older server returning a summarized history.
  if (turn.itemsView !== 'full') fail('the native API did not return full turn items.');
  const startedAt = timestamp(turn.startedAt);
  const completedAt = timestamp(turn.completedAt);
  if (startedAt !== null && completedAt !== null && completedAt < startedAt) fail('turn completion precedes its start.');
  if (startedAt !== null && previousStart !== null && startedAt < previousStart) fail('native turns are not in ascending order.');
  if (turn.status === 'completed' && !turn.items.length) fail('a completed turn has no persisted items.');
  // The exact Desktop create_thread ingress is an observed request boundary,
  // not an assistant-only loophole. Keep the original function event unchanged.
  let lastUser = allowInitialDelegation && isNativeInitialDelegation(turn.items[0]) ? 0 : -1; let lastAgent = -1;
  // Native goal continuations can begin without a new persisted user item and
  // receive steering later. Preserve that native order against the earlier
  // verified user context; never invent a prompt to force alternating roles.
  const continuation = hasPriorRequest;
  for (let index = 0; index < turn.items.length; index++) {
    const item = turn.items[index];
    if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.type !== 'string' || !item.type) fail('malformed native item.');
    if (turn.status === 'completed' && item.status === 'inProgress') fail('a persisted item is still in progress.');
    if (item.type === 'userMessage') lastUser = index;
    if (item.type === 'agentMessage') {
      if (lastUser < 0 && !continuation) fail('an assistant message precedes the turn user input.');
      lastAgent = index;
    }
  }
  if (continuation && compactionControl(turn)) return startedAt ?? previousStart;
  if (turn.status === 'completed' && ((!continuation && lastUser < 0) || lastAgent <= lastUser || turn.items[lastAgent].phase === 'commentary' || typeof turn.items[lastAgent].text !== 'string' || !turn.items[lastAgent].text.trim())) fail('a completed turn lacks its final assistant response.');
  return startedAt ?? previousStart;
}

async function readPass(client, threadId, limits, completedPrefix, resolveInitialGoal, displayScreenshots) {
  const turns = []; const ids = new Set(); const cursors = new Set();
  let initialGoal = null;
  let cursor; let pages = 0; let bytes = 0; let itemCount = 0; let previousStart = null; let hasPriorRequest = false;
  while (true) {
    if (pages >= limits.maxPages) fail('page limit exceeded; no partial export is returned.');
    let response;
    try {
      response = await client.request('thread/turns/list', {
        threadId, limit: limits.pageSize, itemsView: 'full', sortDirection: 'asc',
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (error) {
      // Native errors may include private text or paths. Keep the public error
      // explicit without leaking an arbitrary server error message.
      if (client.closed) fail('native transport unavailable; no export was produced.');
      const code = Number.isInteger(error?.code) ? ` (code ${error.code})` : '';
      fail(`thread/turns/list is unavailable or failed${code}; no export was produced.`);
    }
    if (!object(response) || !Array.isArray(response.data)) fail('malformed pagination response.');
    if (displayScreenshots === 'omitted') omitDisplayScreenshots(response.data);
    const encoded = serialize(response);
    bytes += Buffer.byteLength(encoded);
    if (bytes > limits.maxBytes) fail('byte limit exceeded; no partial export is returned.');
    // Detach the snapshot from clients/mocks that reuse mutable response objects.
    response = JSON.parse(encoded);
    pages++;
    const nextCursor = response.nextCursor ?? null;
    if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor)) fail('invalid pagination cursor.');
    if (nextCursor !== null && response.data.length === 0) fail('empty page with a continuation cursor.');
    for (const turn of response.data) {
      if (!turns.length && object(turn) && turn.status === 'completed' && turn.itemsView === 'full'
          && Array.isArray(turn.items) && turn.items.some(item => item?.type === 'agentMessage')
          && !turn.items.some(item => item?.type === 'userMessage') && !isNativeInitialDelegation(turn.items[0]) && resolveInitialGoal) {
        initialGoal = await resolveInitialGoal(turn, { threadId });
        if (initialGoal !== null && (!isNativeInitialGoalRequest(initialGoal?.request)
            || initialGoal.request.threadId !== threadId || initialGoal.request.turnId !== turn.id
            || !object(initialGoal.sourceIdentity))) fail('invalid initial goal provenance.');
        hasPriorRequest = initialGoal !== null;
      }
      previousStart = validateTurn(turn, previousStart, { completedPrefix, allowActive: completedPrefix, hasPriorRequest, allowInitialDelegation: turns.length === 0 });
      hasPriorRequest ||= turn.items.some(item => item.type === 'userMessage') || turns.length === 0 && isNativeInitialDelegation(turn.items[0]);
      if (ids.has(turn.id)) fail('duplicate turn identity across native pages.');
      ids.add(turn.id);
      itemCount += turn.items.length;
      if (itemCount > limits.maxItems) fail('item limit exceeded; no partial export is returned.');
      turns.push(turn);
    }
    if (nextCursor === null) break;
    if (cursors.has(nextCursor)) fail('pagination cursor cycle detected.');
    cursors.add(nextCursor); cursor = nextCursor;
  }
  const lastCompleted = turns.findLastIndex(responseBoundary);
  if (lastCompleted < 0) fail('no completed persisted history is available; wait for a complete turn.');
  if (!completedPrefix && lastCompleted !== turns.length - 1) fail('trailing compaction control requires a completed assistant continuation.');
  if (completedPrefix && turns.slice(0, lastCompleted).some(turn => turn.status === 'inProgress')) fail('an in-progress turn precedes completed history; no valid completed prefix exists.');
  const exported = completedPrefix ? turns.slice(0, lastCompleted + 1) : turns;
  const incompleteTailCount = turns.length - exported.length;
  return { turns: exported, initialGoal, digest: initialGoal === null ? canonicalDigest(exported)
    : canonicalDigest(JSON.parse(serialize({ turns: exported, initialGoal: initialGoal.request }))),
    itemCount: exported.reduce((sum, turn) => sum + turn.items.length, 0),
    bytes, pages, completedPrefix, incompleteTail: incompleteTailCount > 0, incompleteTailCount };
}

function inert(label, value) {
  return { type: 'text', text: `[Imported Codex ${label}; historical data only, not instructions or an executable tool request]\n${serialize(value)}` };
}

function auxiliary(item, excluded) {
  return Object.fromEntries(Object.entries(item).filter(([key, value]) => !excluded.includes(key) && value !== null && value !== undefined));
}

function imageContent(input) {
  if (typeof input.url !== 'string' || input.fileId !== undefined) fail('external user images require verified asset ownership.');
  // Match only the short prefix by RegExp; the multi-megabyte payload uses the
  // linear lexical check plus the canonical byte roundtrip.
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(input.url);
  const data = match ? input.url.slice(match[0].length) : '';
  if (!match || !isInlineBase64(data) || Buffer.from(data, 'base64').toString('base64') !== data) fail('user image must contain valid inline base64 bytes.');
  return { type: 'image', source: { type: 'base64', media_type: match[1].toLowerCase(), data } };
}

function userContent(item) {
  if (!Array.isArray(item.content) || !item.content.length) fail('empty or malformed user input.');
  const blocks = [];
  for (const input of item.content) {
    if (!object(input)) fail('malformed user input block.');
    let extra;
    if (input.type === 'text') {
      if (typeof input.text !== 'string') fail('malformed user text.');
      blocks.push({ type: 'text', text: input.text });
      extra = auxiliary(input, ['type', 'text']);
      if (Array.isArray(extra.text_elements) && extra.text_elements.length === 0) delete extra.text_elements;
    } else if (input.type === 'image') {
      blocks.push(imageContent(input));
      extra = auxiliary(input, ['type', 'url']);
    } else {
      fail('unsupported user input or external asset; nothing was silently omitted.');
    }
    if (Object.keys(extra).length) blocks.push(inert('user input metadata', extra));
  }
  const extra = auxiliary(item, ['type', 'id', 'content']);
  if (Object.keys(extra).length) blocks.push(inert('user message metadata', extra));
  return blocks;
}

export function convertNativeTurns(snapshot, { threadId, cwd, timestamp: suppliedTimestamp, includeNotice = true }) {
  validateSource(threadId, cwd, suppliedTimestamp);
  if (typeof includeNotice !== 'boolean') fail('invalid provenance notice option.');
  if (!object(snapshot) || !Array.isArray(snapshot.turns) || !snapshot.turns.length) fail('no completed persisted history is available.');
  if (snapshot.threadId !== undefined && snapshot.threadId !== threadId) fail('snapshot thread identity does not match.');
  if (snapshot.completedPrefix !== undefined && typeof snapshot.completedPrefix !== 'boolean') fail('invalid completed-prefix policy.');
  const goal = snapshot.initialGoal?.request;
  if (snapshot.initialGoal != null && (!isNativeInitialGoalRequest(goal) || goal.threadId !== threadId
      || goal.turnId !== snapshot.turns[0].id || snapshot.turns[0].items?.some(item => item.type === 'userMessage')))
    fail('invalid initial goal provenance.');
  const ids = new Set(); let previousStart = null; let hasPriorRequest = goal !== undefined;
  for (const turn of snapshot.turns) {
    previousStart = validateTurn(turn, previousStart, { completedPrefix: snapshot.completedPrefix === true, hasPriorRequest, allowInitialDelegation: ids.size === 0 });
    hasPriorRequest ||= turn.items.some(item => item.type === 'userMessage') || ids.size === 0 && isNativeInitialDelegation(turn.items[0]);
    if (ids.has(turn.id)) fail('duplicate turn identity across native pages.');
    ids.add(turn.id);
  }
  if (!responseBoundary(snapshot.turns.at(-1))) fail('snapshot does not end at a completed assistant response.');
  const messages = goal === undefined ? [] : [{ role: 'assistant', content: [inert('historical event', goal)],
    timestamp: new Date(goal.goal.createdAt * 1000).toISOString() }];
  for (const turn of snapshot.turns) {
    const messageTimestamp = turn.startedAt == null ? suppliedTimestamp : new Date(turn.startedAt * 1000).toISOString();
    for (const item of turn.items) {
      let role = 'assistant'; let content;
      if (item.type === 'userMessage') {
        role = 'user'; content = userContent(item);
      } else if (item.type === 'agentMessage') {
        if (typeof item.text !== 'string') fail('malformed assistant text.');
        content = [{ type: 'text', text: item.text }];
        const extra = auxiliary(item, ['type', 'id', 'text']);
        if (Object.keys(extra).length) content.push(inert('assistant message metadata', extra));
      } else {
        // Tool calls, tool outputs, plans, visible reasoning, compaction markers,
        // and future item types remain inert text. Never replay their commands.
        content = [inert('historical event', item)];
      }
      messages.push({ role, content, ...(messageTimestamp === undefined ? {} : { timestamp: messageTimestamp }) });
    }
    if (turn.status === 'failed' || turn.status === 'interrupted') {
      messages.push({ role: 'assistant', content: [inert('closed turn status', {
        turnId: turn.id, status: turn.status, ...(turn.error === undefined ? {} : { error: turn.error }),
      })], ...(messageTimestamp === undefined ? {} : { timestamp: messageTimestamp }) });
    }
  }
  const firstTimestamp = suppliedTimestamp ?? (snapshot.turns[0].startedAt == null ? undefined : new Date(snapshot.turns[0].startedAt * 1000).toISOString());
  // Codecs need not preserve custom metadata, so the reconstruction boundary
  // must also remain visible in the destination transcript itself.
  if (includeNotice) messages[0].content.unshift({ type: 'text', text: CODEX_RECONSTRUCTION_NOTICE });
  const common = { meta: {
    id: threadId, cwd, ...(firstTimestamp === undefined ? {} : { timestamp: firstTimestamp }),
    nativeHistory: {
      source: 'codex', method: 'thread/turns/list', itemsView: 'full',
      representation: 'native-persisted-display-history',
      encryptedReasoningRecovered: false,
      toolsReplayed: false,
      ...(goal === undefined ? {} : { initialRequest: 'verified-native-rollout-goal' }),
      notice: 'Persisted native display history, including historical events as inert data. Encrypted reasoning and internal model context are not reconstructed.',
      digest: snapshot.digest, turnCount: snapshot.turns.length, itemCount: snapshot.itemCount,
    },
  }, messages };
  assertComplete(common);
  return common;
}

// Read-only local app-server requests only: no resume, mutation, model inference,
// database access, source transcript writes, or hidden partial-history fallback.
// Two matching complete reads detect observed changes, not a writer lease. The
// coordinator still rechecks source identity/checkpoints before publication.
export async function readStableNativeHistory({ client, threadId, limits: inputLimits, completedPrefix = false, resolveInitialGoal, displayScreenshots } = {}) {
  if (!client || typeof client.request !== 'function') fail('a native app-server client is required.');
  if (typeof threadId !== 'string' || !threadId) fail('thread identity is required.');
  if (typeof completedPrefix !== 'boolean') fail('invalid completed-prefix policy.');
  if (resolveInitialGoal !== undefined && typeof resolveInitialGoal !== 'function') fail('invalid initial goal resolver.');
  if (displayScreenshots !== undefined && displayScreenshots !== 'omitted') fail('invalid display screenshot policy.');
  const limits = checkedLimits(inputLimits);
  const first = await readPass(client, threadId, limits, completedPrefix, resolveInitialGoal, displayScreenshots);
  const second = await readPass(client, threadId, limits, completedPrefix, resolveInitialGoal, displayScreenshots);
  if (first.digest !== second.digest || serialize(first.initialGoal?.sourceIdentity ?? null) !== serialize(second.initialGoal?.sourceIdentity ?? null)
    || serialize(first.initialGoal?.prefixHashAlternatives ?? null) !== serialize(second.initialGoal?.prefixHashAlternatives ?? null))
    fail('source history changed between complete reads; synchronization paused.');
  return { ...first, threadId, turnCount: first.turns.length };
}

function validateSource(threadId, cwd, suppliedTimestamp) {
  if (typeof threadId !== 'string' || !threadId) fail('thread identity is required.');
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('an absolute source working directory is required.');
  if (suppliedTimestamp !== undefined && (typeof suppliedTimestamp !== 'string' || !Number.isFinite(Date.parse(suppliedTimestamp)))) fail('invalid source timestamp.');
}

export async function exportNativeHistory({ client, threadId, cwd, timestamp: suppliedTimestamp, limits: inputLimits, completedPrefix = false, resolveLocalImages, resolveInitialGoal, displayScreenshots, checkpoint } = {}) {
  validateSource(threadId, cwd, suppliedTimestamp);
  const limits = checkedLimits(inputLimits);
  const first = await readStableNativeHistory({ client, threadId, limits, completedPrefix, resolveInitialGoal, displayScreenshots });
  const hydrated = await hydrateNativeLocalImages(first, resolveLocalImages, limits.maxBytes);
  let common = convertNativeTurns(hydrated, { threadId, cwd, timestamp: suppliedTimestamp });
  // Preserve an existing representation only if the entire saved canonical
  // prefix authenticates it. Never choose a branch or renew a checkpoint.
  if (checkpoint && Number.isSafeInteger(checkpoint.count) && checkpoint.count > 0
    && checkpoint.count <= common.messages.length && /^[a-f0-9]{64}$/.test(checkpoint.digest ?? '')
    && fingerprint(common, checkpoint.count) !== checkpoint.digest && first.initialGoal) {
    const alternatives = first.initialGoal.prefixHashAlternatives;
    if (Array.isArray(alternatives) && alternatives.length <= 2
      && alternatives.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
      for (const prefixHash of alternatives) {
        const candidate = convertNativeTurns({ ...hydrated, initialGoal: { ...first.initialGoal,
          request: { ...first.initialGoal.request, prefixHash } } }, { threadId, cwd, timestamp: suppliedTimestamp });
        if (fingerprint(candidate, checkpoint.count) === checkpoint.digest) { common = candidate; break; }
      }
    }
  }
  // Key order never changes the serialized byte length of plain JSON values.
  let encoded;
  try { encoded = JSON.stringify(common); } catch { fail('invalid JSON history.'); }
  if (Buffer.byteLength(encoded) > limits.maxBytes) fail('converted byte limit exceeded; no partial export is returned.');
  return { common, digest: first.digest, turnCount: first.turns.length, itemCount: first.itemCount, bytes: first.bytes, pages: first.pages,
    incompleteTail: first.incompleteTail, incompleteTailCount: first.incompleteTailCount,
    nativeMessageOffset: first.initialGoal === null ? 0 : 1 };
}

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { isInlineBase64 } from './base64.mjs';

export const LOCAL_IMAGE_ROLLOUT_LIMITS = Object.freeze({ maxBytes: 512 * 1024 * 1024, maxRowBytes: 64 * 1024 * 1024, maxRollouts: 256 });
const defaultIO = { lstat, open, realpath, readdir };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const regular = info => info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid();
const fail = message => { throw new Error(`Native Codex local image recovery: ${message}`); };
const requestKey = ({ turnId, item }) => JSON.stringify([turnId, item.id]);
const inlineImage = value => {
  if (typeof value !== 'string') return false;
  const prefix = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(value);
  const data = prefix ? value.slice(prefix[0].length) : '';
  return !!prefix && isInlineBase64(data) && Buffer.from(data, 'base64').toString('base64') === data;
};

function translateCompletedItem(item) {
  if (item?.type !== 'UserMessage' || !Array.isArray(item.content)) return null;
  if (Object.hasOwn(item, 'clientId')) fail('native completed user item contains conflicting client identity aliases.');
  const result = { ...item, type: 'userMessage', clientId: Object.hasOwn(item, 'client_id') ? item.client_id : null,
    content: item.content.map(input => {
      if (input?.type === 'local_image')
        return { ...input, type: 'localImage', ...(!Object.hasOwn(input, 'detail') ? { detail: null } : {}) };
      if (input?.type !== 'image') return input;
      if (Object.hasOwn(input, 'url') || typeof input.image_url !== 'string')
        fail('native completed image contains conflicting or unavailable URL identity.');
      const image = { ...input, url: input.image_url, ...(!Object.hasOwn(input, 'detail') ? { detail: null } : {}) };
      delete image.image_url;
      return image;
    }) };
  delete result.client_id;
  return result;
}

function candidateImages(payload, request, activeTurn, contextTurn) {
  const { item, turnId } = request, content = payload.content;
  if (!Array.isArray(content) || !content.some(block => block?.type === 'input_image')) return null;
  if (content[0]?.type !== 'input_text' || content[0].text !== item.content[0].text) return null;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  const hasResponseId = Object.hasOwn(payload, 'id');
  if (!(keys(payload, ['type', 'id', 'role', 'content', 'internal_chat_message_metadata_passthrough'])
        || keys(payload, ['type', 'role', 'content', 'internal_chat_message_metadata_passthrough']))
      || payload.type !== 'message' || payload.role !== 'user' || hasResponseId && (typeof payload.id !== 'string' || !payload.id)
      || !(keys(metadata, ['turn_id', 'create_time', 'content_item_kinds']) || keys(metadata, ['turn_id', 'create_time']) || keys(metadata, ['turn_id']))
      || metadata.turn_id !== turnId || activeTurn !== turnId || contextTurn !== turnId
      || Object.hasOwn(metadata, 'create_time') && (typeof metadata.create_time !== 'number' || !Number.isFinite(metadata.create_time))
      || !keys(content[0], ['type', 'text'])) fail('image response provenance does not match its native turn.');
  const inputs = item.content.slice(1), kinds = ['user.text'], images = [];
  if (content.length !== 1 + inputs.reduce((count, input) => count + (input.type === 'localImage' ? 3 : 1), 0))
    fail('image response count does not match the native user item.');
  let cursor = 1;
  for (let index = 0; index < inputs.length; index++) {
    if (inputs[index].type === 'image') {
      const image = content[cursor++];
      if (!keys(image, ['type', 'image_url', 'detail']) || image.type !== 'input_image'
          || !['high', 'original'].includes(image.detail) || !inlineImage(image.image_url))
        fail('inline image response does not match the native user item.');
      // The native model input can resize an inline image. Preserve the API's
      // original bytes, authenticated by the exact completed user item below;
      // never replace them with this normalized model-input image.
      kinds.push('user.image');
      continue;
    }
    const [start, image, end] = content.slice(cursor, cursor + 3);
    cursor += 3;
    if (!keys(start, ['type', 'text']) || start.type !== 'input_text'
        || start.text !== `<image name=[Image #${index + 1}] path="${inputs[index].path}">`
        || !keys(image, ['type', 'image_url', 'detail']) || image.type !== 'input_image' || !['high', 'original'].includes(image.detail)
        || typeof image.image_url !== 'string'
        || !keys(end, ['type', 'text']) || end.type !== 'input_text' || end.text !== '</image>')
      fail('image response ordering, wrapper path, or native image shape does not match.');
    // No lookup through the wrapper/API path is ever performed. These bytes
    // are the persisted model-input image, not a claim about the upload's
    // original resolution or an external file's historical hash.
    images.push({ url: image.image_url, detail: image.detail });
    kinds.push('user.text', 'user.image', 'user.text');
  }
  // Observed older rows can omit response ID, create_time and the kind list;
  // never synthesize them. Native completion-item identity and the exact
  // message/triplet shapes stay mandatory; a present list is never ignored.
  if (Object.hasOwn(metadata, 'content_item_kinds') && !isDeepStrictEqual(metadata.content_item_kinds, kinds))
    fail('image response content-kind provenance does not match.');
  return images;
}

/** Resolve only the observed native image triplet format from one authoritative
 * current rollout. The complete API item must match its persisted completion;
 * a unique earlier response in the same closed turn binds text, path and order.
 * Imported text remains data, and external image paths/URLs are never read.
 */
function createSingleRolloutImageResolver({ path, threadId, sourceThreadId = threadId, prefix, maxBytes = LOCAL_IMAGE_ROLLOUT_LIMITS.maxBytes,
  maxRowBytes = LOCAL_IMAGE_ROLLOUT_LIMITS.maxRowBytes, io = defaultIO, allowAbsent = false, onScanned = () => {} }) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
      || typeof threadId !== 'string' || !threadId || typeof sourceThreadId !== 'string' || !sourceThreadId
      || prefix !== undefined && (!keys(prefix, ['startOrdinal', 'endOrdinal', 'endByte'])
        || ![prefix.startOrdinal, prefix.endOrdinal, prefix.endByte].every(Number.isSafeInteger)
        || prefix.startOrdinal < 0 || prefix.endOrdinal <= prefix.startOrdinal || prefix.endByte < 1))
    fail('an authoritative absolute rollout path and thread identity are required.');
  for (const [name, value] of Object.entries({ maxBytes, maxRowBytes }))
    if (!Number.isSafeInteger(value) || value < 1 || value > LOCAL_IMAGE_ROLLOUT_LIMITS[name]) fail('invalid bounded rollout scan limit.');
  return async (requests, { maxBytes: imageBudget, threadId: expectedThreadId }) => {
    if (expectedThreadId !== threadId) fail('resolver and native API thread identities do not match.');
    if (!Array.isArray(requests) || !requests.length || !Number.isSafeInteger(imageBudget) || imageBudget < 1)
      fail('explicit image requests and a positive output budget are required.');
    const byId = new Map(), byTurn = new Map(), found = new Map();
    for (const request of requests) {
      const { turnId, item } = request;
      if (typeof turnId !== 'string' || !turnId || item?.type !== 'userMessage' || typeof item.id !== 'string' || !item.id
          || byId.has(item.id) || !Array.isArray(item.content) || item.content.length < 2
          || item.content[0]?.type !== 'text' || typeof item.content[0].text !== 'string'
          || item.content.slice(1).some(input => input?.type === 'localImage'
            ? typeof input.path !== 'string' || !input.path || /["\r\n]/.test(input.path)
            : input?.type !== 'image' || !inlineImage(input.url)))
        fail('unsupported or ambiguous native local-image request shape.');
      const state = { request, candidate: null, completion: false, started: false, closed: false, lastUserCompletion: -1 };
      byId.set(item.id, state);
      const group = byTurn.get(turnId) ?? []; group.push(state); byTurn.set(turnId, group);
    }
    if (await io.realpath(dirname(path)) !== dirname(path)) fail('rollout parent path must already be canonical.');
    const initial = await io.lstat(path);
    // A history_base reference covers only the rows before its exact ordinal;
    // the referenced rollout may still grow after it.
    const length = prefix ? prefix.endByte : initial.size;
    if (!regular(initial) || length > maxBytes || initial.size < length) fail('rollout must be an owned regular file within the scan byte limit.');
    let scannedEnd = 0, rowOffset = 0, previousRowStart = 0, stopped = false;
    const unchanged = (a, b) => !prefix ? same(a, b) : a.dev === b.dev && a.ino === b.ino && b.size >= scannedEnd;
    const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let stream, total = 0, rowBytes = 0, parts = [], ordinal = 0, activeTurn = null, contextTurn = null, imageBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const consume = (bytes, rowStart) => {
      if (!bytes.length) return;
      let row;
      try { row = JSON.parse(decoder.decode(bytes)); } catch { fail('malformed rollout row; no image was recovered.'); }
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string' || !row.type)
        fail('malformed rollout row; no image was recovered.');
      if (prefix) {
        // Native rows carry contiguous ordinals, which bound the reference
        // exactly. Observed native byte offsets can land a few bytes inside
        // the last included or first excluded row, so the offset must fall
        // within those two adjacent rows; anything else is another history.
        if (row.ordinal !== prefix.startOrdinal + ordinal) fail('history_base rows do not have contiguous native ordinals.');
        if (row.ordinal === prefix.endOrdinal) {
          if (prefix.endByte < previousRowStart || prefix.endByte > rowStart + bytes.length)
            fail('history_base byte offset does not match its ordinal boundary.');
          stopped = true;
          return;
        }
        previousRowStart = rowStart;
      }
      const index = ordinal++;
      if (index === 0) {
        if (row.type !== 'session_meta' || row.payload?.id !== sourceThreadId) fail('rollout metadata has a different thread identity.');
        return;
      }
      if (row.type === 'session_meta') fail('rollout contains multiple session metadata records.');
      const payload = row.payload;
      if (row.type === 'event_msg' && payload?.type === 'task_started') {
        if (byTurn.has(activeTurn) && byTurn.get(activeTurn).some(state => !state.closed)) fail('image turn did not close before the next native turn.');
        activeTurn = payload.turn_id; contextTurn = null;
        for (const state of byTurn.get(activeTurn) ?? []) {
          if (state.started) fail('native image turn was started more than once.');
          state.started = true;
        }
      } else if (row.type === 'turn_context') {
        contextTurn = payload?.turn_id;
        if (byTurn.has(activeTurn) && contextTurn !== activeTurn) fail('native image turn context changed.');
      } else if (row.type === 'response_item' && payload?.type === 'message' && payload.role === 'user' && byTurn.has(activeTurn)) {
        const candidates = [];
        for (const state of byTurn.get(activeTurn)) {
          const images = candidateImages(payload, state.request, activeTurn, contextTurn);
          if (images) candidates.push({ state, images });
        }
        if (candidates.length > 1) fail('image response matches multiple native user items.');
        for (const { state, images } of candidates) {
          if (state.candidate) fail('multiple image responses match one native user item.');
          imageBytes += images.reduce((sum, image) => sum + Buffer.byteLength(image.url), 0);
          if (imageBytes > imageBudget) fail('recovered image byte limit exceeded; no partial recovery was returned.');
          state.candidate = { images, ordinal: index };
        }
      } else if (row.type === 'event_msg' && payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') {
        const state = byId.get(payload.item.id);
        if (state) {
          if (state.completion || payload.thread_id !== sourceThreadId || payload.turn_id !== state.request.turnId
              || activeTurn !== state.request.turnId || contextTurn !== state.request.turnId
              || !isDeepStrictEqual(translateCompletedItem(payload.item), state.request.item))
            fail('native completed user item does not exactly match the API identity and content.');
          if (!state.candidate || state.candidate.ordinal <= state.lastUserCompletion || state.candidate.ordinal >= index)
            fail('native image response is missing or separated from its user completion.');
          state.completion = true;
          found.set(requestKey(state.request), state.candidate.images);
        }
        for (const candidate of byTurn.get(activeTurn) ?? []) candidate.lastUserCompletion = index;
      } else if (row.type === 'event_msg' && (payload?.type === 'task_complete'
        // An interrupted turn closes with turn_aborted; the API reports it as
        // an interrupted closed turn. Its persisted user input is unchanged.
        || payload?.type === 'turn_aborted' && payload.reason === 'interrupted')) {
        if (byTurn.has(activeTurn)) {
          if (payload.turn_id !== activeTurn) fail('native image turn completion has a different identity.');
          for (const state of byTurn.get(activeTurn)) state.closed = true;
        }
        activeTurn = null; contextTurn = null;
      }
    };
    try {
      const opened = await file.stat();
      if (!regular(opened) || !unchanged(initial, opened)) fail('transcript changed while being read before image recovery.');
      stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, start: 0, ...(prefix ? {} : { end: length - 1 }) });
      reading: for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxBytes) fail('rollout scan byte limit exceeded.');
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf(10, start), limit = end < 0 ? chunk.length : end;
          const part = chunk.subarray(start, limit);
          rowBytes += part.length;
          if (rowBytes > maxRowBytes) fail('rollout row byte limit exceeded.');
          if (part.length) parts.push(part);
          if (end < 0) break;
          const rowStart = rowOffset;
          rowOffset += rowBytes + 1;
          consume(parts.length === 1 ? parts[0] : Buffer.concat(parts, rowBytes), rowStart);
          parts = []; rowBytes = 0; start = end + 1;
          if (stopped) break reading;
        }
      }
      if (prefix && !stopped) {
        // The referenced rollout ends exactly at the boundary.
        if (rowBytes || prefix.endByte < previousRowStart || prefix.endByte > rowOffset || prefix.startOrdinal + ordinal !== prefix.endOrdinal)
          fail('history_base byte offset does not match its ordinal boundary.');
      } else if (rowBytes) fail('rollout has an incomplete final line.');
      scannedEnd = rowOffset;
      const after = await file.stat(), current = await io.lstat(path);
      if (!regular(current) || !unchanged(initial, after) || !unchanged(initial, current) || !prefix && total !== length)
        fail('transcript changed while being read during image recovery; no recovery was returned.');
      if (!ordinal || !allowAbsent && found.size !== requests.length || [...byId.values()].some(state =>
        (!allowAbsent || state.started || state.closed || state.completion || state.candidate) && (!state.started || !state.closed || !state.completion)))
        fail('current rollout lacks complete unambiguous image provenance; referenced histories were not searched.');
      onScanned({ bytes: prefix ? scannedEnd : total, identity: `${initial.dev}:${initial.ino}`, stat: initial, unchanged });
      return found;
    } finally {
      stream?.destroy();
      await file.close();
    }
  };
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_HISTORY_BASE_LINKS = 64;

async function readHeader(path, io, maxRowBytes) {
  if (await io.realpath(dirname(path)) !== dirname(path)) fail('rollout parent path must already be canonical.');
  const info = await io.lstat(path);
  if (!regular(info)) fail('history_base rollout must be an owned regular file.');
  const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!regular(opened) || opened.dev !== info.dev || opened.ino !== info.ino) fail('history_base rollout changed while being opened.');
    const parts = []; let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (!bytesRead) fail('history_base rollout has no complete metadata row.');
      const chunk = buffer.subarray(0, bytesRead), end = chunk.indexOf(10);
      parts.push(Buffer.from(end < 0 ? chunk : chunk.subarray(0, end))); total += end < 0 ? bytesRead : end;
      if (total > maxRowBytes) fail('rollout row byte limit exceeded.');
      if (end >= 0) break;
    }
    let row;
    try { row = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { fail('malformed history_base rollout metadata.'); }
    if (row?.type !== 'session_meta' || !row.payload || typeof row.payload.id !== 'string') fail('malformed history_base rollout metadata.');
    return { meta: row.payload, size: info.size };
  } finally { await file.close(); }
}

/** Find the one rollout file named for an exact history_base segment ID. A
 * root segment is named for its thread and a rollover segment for
 * <thread>_<segment>; nothing else is guessed, and duplicates fail. */
export function createCodexRolloutLocator(codexHome, io = defaultIO) {
  let names;
  const list = async () => {
    if (names) return names;
    names = [];
    const walk = async (directory, depth) => {
      let entries;
      try { entries = await io.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        // Native layout only: sessions/YYYY/MM/DD/<file> and archived_sessions/<file>.
        if (entry.isDirectory() && depth > 0 && /^\d+$/.test(entry.name)) await walk(join(directory, entry.name), depth - 1);
        else if (depth === 0 && entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) names.push(join(directory, entry.name));
      }
    };
    await walk(join(codexHome, 'sessions'), 3);
    await walk(join(codexHome, 'archived_sessions'), 0);
    return names;
  };
  return async segmentId => {
    if (!UUID_TEXT.test(segmentId)) fail('invalid history_base segment identity.');
    const matches = (await list()).filter(path => basename(path).endsWith(`-${segmentId}.jsonl`)
      || basename(path).endsWith(`_${segmentId}.jsonl`));
    if (matches.length !== 1) fail(`history_base segment ${segmentId} is ${matches.length ? 'ambiguous' : 'missing'}; no image was recovered.`);
    return matches[0];
  };
}

/** Follow the exact history_base chain of a rollout: each link names the
 * previous segment and the byte prefix of it that this history includes.
 * A fork's first link must belong to the thread it was forked from. */
export async function resolveRolloutHistoryBase({ path, threadId, locate, io = defaultIO,
  maxRowBytes = LOCAL_IMAGE_ROLLOUT_LIMITS.maxRowBytes }) {
  let { meta } = await readHeader(path, io, maxRowBytes);
  if (meta.id !== threadId) fail('rollout metadata has a different thread identity.');
  const chain = [], seen = new Set([path]);
  let owner = threadId, ordinal = Infinity;
  while (meta.history_base != null) {
    const base = meta.history_base;
    if (chain.length >= MAX_HISTORY_BASE_LINKS) fail('history_base chain exceeds its bound.');
    if (!keys(base, ['thread_id', 'end_byte_offset', 'end_ordinal_exclusive']) || !UUID_TEXT.test(base.thread_id)
        || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 1
        || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 1 || base.end_ordinal_exclusive >= ordinal)
      fail('invalid history_base reference.');
    // A fork inherits its parent's history; a rollover continues its own.
    const expected = meta.forked_from_id ?? owner;
    if (meta.forked_from_id != null && (typeof meta.forked_from_id !== 'string'
        || meta.forked_from_ordinal_exclusive !== base.end_ordinal_exclusive))
      fail('fork metadata does not match its history_base reference.');
    const segmentPath = await locate(base.thread_id);
    if (seen.has(segmentPath)) fail('history_base chain repeats a rollout.');
    seen.add(segmentPath);
    const segment = await readHeader(segmentPath, io, maxRowBytes);
    const name = basename(segmentPath);
    const named = segment.meta.id === base.thread_id ? name.endsWith(`-${base.thread_id}.jsonl`)
      : name.endsWith(`-${segment.meta.id}_${base.thread_id}.jsonl`);
    if (segment.meta.id !== expected || !named) fail('history_base segment belongs to a different thread.');
    if (segment.size < base.end_byte_offset) fail('history_base segment is shorter than its reference.');
    const startOrdinal = segment.meta.history_base?.end_ordinal_exclusive ?? 0;
    if (!Number.isSafeInteger(startOrdinal) || startOrdinal >= base.end_ordinal_exclusive) fail('invalid history_base reference.');
    chain.push({ path: segmentPath, threadId: segment.meta.id,
      prefix: { startOrdinal, endOrdinal: base.end_ordinal_exclusive, endByte: base.end_byte_offset } });
    owner = segment.meta.id; ordinal = base.end_ordinal_exclusive; meta = segment.meta;
  }
  return chain;
}

/** Previously verified image-bearing rollouts are explicit ledger evidence,
 * never a history_base search. Each retained image is still re-read against
 * the complete current API item; the caller must verify its saved semantic
 * checkpoint before accepting the emitted provenance for another promotion.
 */
export function createCodexLocalImageResolver({ path, threadId, retainedRollouts = [], retainedPath, locateRollout,
  onResolved = () => {}, maxBytes = LOCAL_IMAGE_ROLLOUT_LIMITS.maxBytes,
  maxRowBytes = LOCAL_IMAGE_ROLLOUT_LIMITS.maxRowBytes, io = defaultIO,
  validateRetainedPath = sourcePath => io.lstat(sourcePath) }) {
  const validPath = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
  if (!Array.isArray(retainedRollouts) || retainedRollouts.length > LOCAL_IMAGE_ROLLOUT_LIMITS.maxRollouts)
    fail('retained rollout evidence exceeds its bounded schema.');
  const retained = new Map(), bindings = new Map();
  for (const entry of retainedRollouts) {
    if (!keys(entry, ['path', 'requests']) || !validPath(entry.path) || retained.has(entry.path)
        || !Array.isArray(entry.requests) || !entry.requests.length || entry.requests.length > 25000)
      fail('invalid retained rollout evidence.');
    const ids = new Set();
    for (const request of entry.requests) {
      if (!keys(request, ['turnId', 'itemId', 'messageIndex']) || typeof request.turnId !== 'string' || !request.turnId
          || typeof request.itemId !== 'string' || !request.itemId
          || !Number.isSafeInteger(request.messageIndex) || request.messageIndex < 0)
        fail('invalid retained native image identity.');
      const key = JSON.stringify([request.turnId, request.itemId]);
      if (ids.has(key) || bindings.has(key)) fail('ambiguous retained native image identity.');
      ids.add(key); bindings.set(key, entry.path);
      if (bindings.size > 25000) fail('retained native image identities exceed the complete API item bound.');
    }
    retained.set(entry.path, ids);
  }
  if (retainedPath !== undefined && !validPath(retainedPath)) fail('invalid previously verified rollout path.');
  if (retainedPath && retainedPath !== path && !retained.has(retainedPath)) retained.set(retainedPath, null);
  if (retained.size + (retained.has(path) ? 0 : 1) > LOCAL_IMAGE_ROLLOUT_LIMITS.maxRollouts)
    fail('retained rollout evidence exceeds its bounded schema.');
  // Construct eagerly so malformed current paths and limits retain their
  // original fail-fast behavior, before any retained file is inspected.
  createSingleRolloutImageResolver({ path, threadId, maxBytes, maxRowBytes, io });
  return async (requests, options) => {
    const found = new Map(), origins = new Map(), identities = new Set(), observed = new Map(); let scanned = 0;
    const knownRequests = new Map(requests.map(request => [requestKey(request), request]));
    for (const key of bindings.keys()) if (!knownRequests.has(key))
      fail('retained native image disappeared from the complete API history.');
    // Inherited history (a fork or rollover) lives in exactly referenced
    // prefixes of earlier rollouts. The chain is resolved only when needed:
    // for retained evidence from another thread's segment, or for images the
    // current and retained rollouts do not prove.
    let chain, links;
    const inherited = async () => {
      if (!chain) {
        if (!locateRollout) fail('explicit rollout evidence lacks complete native image provenance; referenced histories were not searched.');
        chain = await resolveRolloutHistoryBase({ path, threadId, locate: locateRollout, io, maxRowBytes });
        if (retained.size + chain.length + 1 > LOCAL_IMAGE_ROLLOUT_LIMITS.maxRollouts) fail('retained rollout evidence exceeds its bounded schema.');
        links = new Map(chain.map(link => [link.path, link]));
      }
      return links;
    };
    const sources = [[path, null], ...[...retained].filter(([value]) => value !== path)];
    let expanded = false;
    for (let index = 0; ; index++) {
      if (index === sources.length) {
        // Only images still unproven by the current and retained rollouts
        // follow the inherited chain, nearest segment first.
        if (expanded || !locateRollout || found.size === requests.length) break;
        expanded = true;
        for (const link of (await inherited()).values()) if (!retained.has(link.path)) sources.push([link.path, undefined]);
        if (index === sources.length) break;
      }
      const [sourcePath, ids] = sources[index];
      const selected = ids ? requests.filter(request => ids.has(requestKey(request)))
        : ids === undefined ? requests.filter(request => !found.has(requestKey(request))) : requests;
      if (!selected.length) continue;
      let link = ids === undefined ? links.get(sourcePath) : undefined;
      if (sourcePath !== path) {
        try { await validateRetainedPath(sourcePath); }
        catch (error) {
          // Native archival can move the exact current rollout. Its new
          // authoritative path may replace a missing old path only when it
          // already proves every associated API image; checkpoint validation
          // remains mandatory in the runtime before these origins are saved.
          if (error.code === 'ENOENT' && selected.every(request => found.has(requestKey(request)))) continue;
          if (error.code === 'ENOENT') fail('explicit retained rollout image evidence is missing; referenced histories were not searched.');
          throw error;
        }
        // Retained evidence from an inherited segment keeps its exact link.
        if (ids && locateRollout && (await readHeader(sourcePath, io, maxRowBytes)).meta.id !== threadId) {
          link = (await inherited()).get(sourcePath);
          if (!link) fail('retained rollout belongs to another thread outside this history_base chain.');
        }
      }
      const scan = createSingleRolloutImageResolver({ path: sourcePath, threadId,
        ...(link ? { sourceThreadId: link.threadId, prefix: link.prefix } : {}),
        maxBytes: maxBytes - scanned, maxRowBytes, io,
        allowAbsent: ids === undefined || ids === null && (retained.size > 0 || Boolean(locateRollout)),
        onScanned({ bytes, identity, stat, unchanged }) {
          if (identities.has(identity)) fail('retained rollout paths alias the same native file.');
          identities.add(identity); observed.set(sourcePath, { stat, unchanged }); scanned += bytes;
        } });
      const images = await scan(selected, options);
      for (const [key, value] of images) {
        if (found.has(key) && !isDeepStrictEqual(found.get(key), value))
          fail('current and retained rollouts contain conflicting native image proofs.');
        if (!found.has(key)) { found.set(key, value); origins.set(key, sourcePath); }
      }
    }
    if (found.size !== requests.length) fail('explicit rollout evidence lacks complete native image provenance; referenced histories were not searched.');
    if ([...found.values()].flat().reduce((sum, image) => sum + Buffer.byteLength(image.url), 0) > options.maxBytes)
      fail('recovered image byte limit exceeded; no partial recovery was returned.');
    for (const [sourcePath, { stat, unchanged }] of observed) {
      const current = await io.lstat(sourcePath);
      if (!regular(current) || !unchanged(stat, current))
        fail('transcript changed while being read across retained image evidence; no recovery was returned.');
    }
    const rollouts = new Map();
    for (const request of requests) {
      const sourcePath = origins.get(requestKey(request)), list = rollouts.get(sourcePath) ?? [];
      list.push({ turnId: request.turnId, itemId: request.item.id, messageIndex: request.messageIndex }); rollouts.set(sourcePath, list);
    }
    onResolved({ localImageRollouts: [...rollouts].map(([sourcePath, values]) => ({ path: sourcePath, requests: values })),
      // Images from the declared history_base chain are inherited history the
      // current rollout itself references, not retained earlier evidence.
      retainedRequests: requests.filter(request => origins.get(requestKey(request)) !== path
        && !links?.has(origins.get(requestKey(request)))),
      nativeMessageCount: options.nativeMessageCount });
    return found;
  };
}

/** Hydrate just local-image blocks after the stable native API read. Keep the
 * original input descriptor as inert metadata; no other native item is changed.
 */
export async function hydrateNativeLocalImages(snapshot, resolveLocalImages, maxBytes) {
  let nativeMessageCount = 0;
  const requests = snapshot.turns.flatMap(turn => {
    const items = turn.items.flatMap(item => {
      const messageIndex = nativeMessageCount++;
      return item.type === 'userMessage' && item.content?.some(input => input.type === 'localImage')
        ? [{ turnId: turn.id, item, messageIndex }] : [];
    });
    if (['failed', 'interrupted'].includes(turn.status)) nativeMessageCount++;
    return items;
  });
  if (!requests.length || resolveLocalImages === undefined) return snapshot;
  if (typeof resolveLocalImages !== 'function') fail('local-image resolver must be a function.');
  const resolved = await resolveLocalImages(requests, { maxBytes, threadId: snapshot.threadId, nativeMessageCount });
  if (!(resolved instanceof Map) || resolved.size !== requests.length) fail('local-image resolver returned an incomplete mapping.');
  return { ...snapshot, turns: snapshot.turns.map(turn => ({ ...turn, items: turn.items.map(item => {
    const images = resolved.get(requestKey({ turnId: turn.id, item }));
    if (!images) return item;
    if (!Array.isArray(images) || images.length !== item.content.filter(input => input.type === 'localImage').length)
      fail('local-image resolver returned an inconsistent image count.');
    let index = 0;
    return { ...item, content: item.content.map(input => {
      if (input.type !== 'localImage') return input;
      const image = images[index++];
      return { type: 'image', url: image.url, nativeLocalImage: input, nativePersistedImageDetail: image.detail };
    }) };
  }) })) };
}

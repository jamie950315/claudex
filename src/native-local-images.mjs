import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';

export const LOCAL_IMAGE_ROLLOUT_LIMITS = Object.freeze({ maxBytes: 512 * 1024 * 1024, maxRowBytes: 64 * 1024 * 1024 });
const defaultIO = { lstat, open, realpath };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const fail = message => { throw new Error(`Native Codex local image recovery: ${message}`); };
const requestKey = ({ turnId, item }) => JSON.stringify([turnId, item.id]);

function translateCompletedItem(item) {
  if (item?.type !== 'UserMessage' || !Array.isArray(item.content)) return null;
  const result = { ...item, type: 'userMessage', clientId: item.client_id,
    content: item.content.map(input => input?.type === 'local_image'
      ? { ...input, type: 'localImage', ...(!Object.hasOwn(input, 'detail') ? { detail: null } : {}) } : input) };
  delete result.client_id;
  return result;
}

function candidateImages(payload, request, activeTurn, contextTurn) {
  const { item, turnId } = request, content = payload.content;
  if (!Array.isArray(content) || !content.some(block => block?.type === 'input_image')) return null;
  if (content[0]?.type !== 'input_text' || content[0].text !== item.content[0].text) return null;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  if (!keys(payload, ['type', 'id', 'role', 'content', 'internal_chat_message_metadata_passthrough'])
      || payload.type !== 'message' || payload.role !== 'user' || typeof payload.id !== 'string' || !payload.id
      || !(keys(metadata, ['turn_id', 'create_time', 'content_item_kinds']) || keys(metadata, ['turn_id', 'create_time']))
      || metadata.turn_id !== turnId || activeTurn !== turnId || contextTurn !== turnId
      || typeof metadata.create_time !== 'number' || !Number.isFinite(metadata.create_time)
      || !keys(content[0], ['type', 'text'])) fail('image response provenance does not match its native turn.');
  const inputs = item.content.slice(1), kinds = ['user.text'], images = [];
  if (content.length !== 1 + inputs.length * 3) fail('image response count does not match the native user item.');
  for (let index = 0; index < inputs.length; index++) {
    const [start, image, end] = content.slice(1 + index * 3, 4 + index * 3);
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
  // Older observed rollouts omit only this parallel kind list. Their exact
  // message/triplet shapes are still mandatory; a present list is never ignored.
  if (Object.hasOwn(metadata, 'content_item_kinds') && !isDeepStrictEqual(metadata.content_item_kinds, kinds))
    fail('image response content-kind provenance does not match.');
  return images;
}

/** Resolve only the observed native image triplet format from one authoritative
 * current rollout. The complete API item must match its persisted completion;
 * a unique earlier response in the same closed turn binds text, path and order.
 * Imported text remains data, and external image paths/URLs are never read.
 */
export function createCodexLocalImageResolver({ path, threadId, maxBytes = LOCAL_IMAGE_ROLLOUT_LIMITS.maxBytes,
  maxRowBytes = LOCAL_IMAGE_ROLLOUT_LIMITS.maxRowBytes, io = defaultIO }) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
      || typeof threadId !== 'string' || !threadId) fail('an authoritative absolute rollout path and thread identity are required.');
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
          || item.content.slice(1).some(input => input?.type !== 'localImage' || typeof input.path !== 'string'
            || !input.path || /["\r\n]/.test(input.path)))
        fail('unsupported or ambiguous native local-image request shape.');
      const state = { request, candidate: null, completion: false, started: false, closed: false, lastUserCompletion: -1 };
      byId.set(item.id, state);
      const group = byTurn.get(turnId) ?? []; group.push(state); byTurn.set(turnId, group);
    }
    if (await io.realpath(dirname(path)) !== dirname(path)) fail('rollout parent path must already be canonical.');
    const initial = await io.lstat(path);
    const regular = info => info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid();
    if (!regular(initial) || initial.size > maxBytes) fail('rollout must be an owned regular file within the scan byte limit.');
    const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let stream, total = 0, rowBytes = 0, parts = [], ordinal = 0, activeTurn = null, contextTurn = null, imageBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const consume = bytes => {
      if (!bytes.length) return;
      let row;
      try { row = JSON.parse(decoder.decode(bytes)); } catch { fail('malformed rollout row; no image was recovered.'); }
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string' || !row.type)
        fail('malformed rollout row; no image was recovered.');
      const index = ordinal++;
      if (index === 0) {
        if (row.type !== 'session_meta' || row.payload?.id !== threadId) fail('rollout metadata has a different thread identity.');
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
          if (state.completion || payload.thread_id !== threadId || payload.turn_id !== state.request.turnId
              || activeTurn !== state.request.turnId || contextTurn !== state.request.turnId
              || !isDeepStrictEqual(translateCompletedItem(payload.item), state.request.item))
            fail('native completed user item does not exactly match the API identity and content.');
          if (!state.candidate || state.candidate.ordinal <= state.lastUserCompletion || state.candidate.ordinal >= index)
            fail('native image response is missing or separated from its user completion.');
          state.completion = true;
          found.set(requestKey(state.request), state.candidate.images);
        }
        for (const candidate of byTurn.get(activeTurn) ?? []) candidate.lastUserCompletion = index;
      } else if (row.type === 'event_msg' && payload?.type === 'task_complete') {
        if (byTurn.has(activeTurn)) {
          if (payload.turn_id !== activeTurn) fail('native image turn completion has a different identity.');
          for (const state of byTurn.get(activeTurn)) state.closed = true;
        }
        activeTurn = null; contextTurn = null;
      }
    };
    try {
      const opened = await file.stat();
      if (!regular(opened) || !same(initial, opened)) fail('transcript changed while being read before image recovery.');
      stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
      for await (const chunk of stream) {
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
          consume(parts.length === 1 ? parts[0] : Buffer.concat(parts, rowBytes));
          parts = []; rowBytes = 0; start = end + 1;
        }
      }
      if (rowBytes) fail('rollout has an incomplete final line.');
      const after = await file.stat(), current = await io.lstat(path);
      if (!regular(current) || !same(initial, after) || !same(initial, current) || total !== initial.size)
        fail('transcript changed while being read during image recovery; no recovery was returned.');
      if (!ordinal || found.size !== requests.length || [...byId.values()].some(state => !state.started || !state.closed || !state.completion))
        fail('current rollout lacks complete unambiguous image provenance; referenced histories were not searched.');
      return found;
    } finally {
      stream?.destroy();
      await file.close();
    }
  };
}

/** Hydrate just local-image blocks after the stable native API read. Keep the
 * original input descriptor as inert metadata; no other native item is changed.
 */
export async function hydrateNativeLocalImages(snapshot, resolveLocalImages, maxBytes) {
  const requests = snapshot.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage'
    && item.content?.some(input => input.type === 'localImage')).map(item => ({ turnId: turn.id, item })));
  if (!requests.length || resolveLocalImages === undefined) return snapshot;
  if (typeof resolveLocalImages !== 'function') fail('local-image resolver must be a function.');
  const resolved = await resolveLocalImages(requests, { maxBytes, threadId: snapshot.threadId });
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

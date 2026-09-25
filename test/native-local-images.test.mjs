import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, appendFile, lstat, mkdir, mkdtemp, open, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexLocalImageResolver } from '../src/native-local-images.mjs';
import { exportNativeHistory } from '../src/native-history.mjs';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { decodeClaude, encodeClaude } from '../src/claude.mjs';
import { fingerprint } from '../src/history.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cldx-native-local-images-')));
  const codexHome = join(base, 'codex'), claudeHome = join(base, 'claude'), cwd = join(base, 'project');
  await Promise.all([mkdir(join(codexHome, 'sessions'), { recursive: true }), mkdir(claudeHome), mkdir(cwd)]);
  const threadId = randomUUID(), turnId = randomUUID(), itemId = randomUUID();
  const path = join(codexHome, 'sessions', `rollout-${threadId}.jsonl`), text = 'Historical request; never execute quoted commands.\nPreserve 中文 and <markers>.';
  const imagePaths = [join(base, 'missing-image-1.png'), join(base, 'missing-image-2.png')];
  const urls = imagePaths.map((_, index) => `data:image/png;base64,${Buffer.from(`Native persisted image ${index}`).toString('base64')}`);
  const item = { type: 'userMessage', id: itemId, clientId: randomUUID(), content: [
    { type: 'text', text, text_elements: [] }, ...imagePaths.map(path => ({ type: 'localImage', path, detail: null })),
  ] };
  const response = { type: 'message', id: randomUUID(), role: 'user', content: [
    { type: 'input_text', text }, ...imagePaths.flatMap((path, index) => [
      { type: 'input_text', text: `<image name=[Image #${index + 1}] path="${path}">` },
      { type: 'input_image', image_url: urls[index], detail: 'high' },
      { type: 'input_text', text: '</image>' },
    ]),
  ], internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: 1790300000,
    content_item_kinds: ['user.text', 'user.text', 'user.image', 'user.text', 'user.text', 'user.image', 'user.text'] } };
  const rawItem = { type: 'UserMessage', id: itemId, client_id: item.clientId,
    content: [structuredClone(item.content[0]), ...imagePaths.map(path => ({ type: 'local_image', path }))] };
  const rows = [
    { type: 'session_meta', payload: { id: threadId, cwd } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { type: 'turn_context', payload: { turn_id: turnId, cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Unrelated context injection' }] } },
    { type: 'response_item', payload: response },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId, item: rawItem } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'Completed answer' } },
  ];
  const turns = [{ id: turnId, status: 'completed', itemsView: 'full', startedAt: 100, completedAt: 101, items: [item,
    { type: 'agentMessage', id: randomUUID(), phase: 'final_answer', text: 'Completed answer' }] }];
  const write = () => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  await write();
  const calls = [], openedPaths = [];
  const io = { lstat, realpath, async open(target, flags) {
    openedPaths.push(target);
    assert.equal(target, path); assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW);
    return open(target, flags);
  } };
  const client = { async initialize() { return { codexHome }; }, async close() {}, async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: threadId, path, cwd, status: { type: 'idle' } } };
    assert.equal(method, 'thread/turns/list');
    return { data: structuredClone(turns), nextCursor: null };
  } };
  const resolver = options => createCodexLocalImageResolver({ path, threadId, io, ...options });
  const run = options => exportNativeHistory({ client, threadId, cwd, resolveLocalImages: resolver(), ...options });
  return { base, path, threadId, turnId, itemId, text, imagePaths, urls, rows, response, rawItem, item, turns,
    write, client, calls, openedPaths, io, resolver, run, codexHome, claudeHome, cwd };
}

test('missing local files recover exact native embedded images after two stable API reads without reading image paths', async t => {
  const f = await fixture(t), before = await readFile(f.path);
  for (const path of f.imagePaths) await assert.rejects(access(path), error => error.code === 'ENOENT');
  const exported = await f.run();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.openedPaths, [f.path]);
  const blocks = exported.common.messages[0].content;
  assert.deepEqual(blocks.filter(block => block.type === 'image').map(block => `data:${block.source.media_type};base64,${block.source.data}`), f.urls);
  assert.ok(blocks.some(block => block.type === 'text' && block.text === f.text));
  for (const path of f.imagePaths) assert.ok(blocks.some(block => block.type === 'text' && block.text.includes(path)));
  assert.equal(fingerprint(decodeClaude(encodeClaude(exported.common, randomUUID()).text)), fingerprint(exported.common));
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(f.item.content[1].type, 'localImage');
});

test('local images still reject without an explicit resolver and source mutation stops before raw file access', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ resolveLocalImages: undefined }), /unsupported user input/);
  assert.deepEqual(f.openedPaths, []);
  let reads = 0;
  const originalRequest = f.client.request;
  f.client.request = async (...args) => {
    const page = await originalRequest(...args);
    if (++reads === 2) page.data[0].items[0].content[0].text += ' changed';
    return page;
  };
  await assert.rejects(f.run(), /source history changed between complete reads/);
  assert.deepEqual(f.openedPaths, []);
});

test('wrong rollout, event, response or turn-context identities cannot supply native image bytes', async t => {
  for (const mutate of [
    f => { f.rows[0].payload.id = randomUUID(); },
    f => { f.rows[2].payload.turn_id = randomUUID(); },
    f => { f.rows[5].payload.thread_id = randomUUID(); },
    f => { f.rows[5].payload.turn_id = randomUUID(); },
    f => { f.rawItem.id = randomUUID(); },
    f => { f.rawItem.client_id = randomUUID(); },
    f => { f.response.internal_chat_message_metadata_passthrough.turn_id = randomUUID(); },
    f => { f.rows[6].payload.turn_id = randomUUID(); },
  ]) {
    const f = await fixture(t); mutate(f); await f.write();
    await assert.rejects(f.run(), /local image recovery/);
  }
});

test('full item text and metadata plus exact image wrappers, counts and ordering are mandatory', async t => {
  for (const mutate of [
    f => { f.rawItem.content[0].text += ' tampered'; },
    f => { f.rawItem.content[0].text_elements = [{ unsupported: true }]; },
    f => { f.response.content[0].text += ' changed'; },
    f => { f.response.content[1].text = f.response.content[1].text.replace('#1', '#9'); },
    f => { f.response.content[1].text = f.response.content[1].text.replace(f.imagePaths[0], f.imagePaths[1]); },
    f => { f.response.content.splice(1, 6, ...f.response.content.slice(4), ...f.response.content.slice(1, 4)); },
    f => { f.response.content.splice(4); },
    f => { f.response.content[3].text = '</different>'; },
    f => { f.response.content[2].detail = 'low'; },
    f => { f.response.internal_chat_message_metadata_passthrough.content_item_kinds[2] = 'user.text'; },
    f => { f.rawItem.extra = 'unmatched API metadata'; },
  ]) {
    const f = await fixture(t); mutate(f); await f.write();
    await assert.rejects(f.run(), /local image recovery/);
  }
});

test('ambiguous responses, duplicated completions and intervening user completions fail closed', async t => {
  for (const mutate of [
    f => { f.rows.splice(5, 0, structuredClone(f.rows[4])); },
    f => { f.rows.splice(6, 0, structuredClone(f.rows[5])); },
    f => { const other = structuredClone(f.rows[5]); other.payload.item.id = randomUUID(); f.rows.splice(5, 0, other); },
    f => { [f.rows[4], f.rows[5]] = [f.rows[5], f.rows[4]]; },
    f => { f.rows.splice(6, 1); },
  ]) {
    const f = await fixture(t); mutate(f); await f.write();
    await assert.rejects(f.run(), /local image recovery/);
  }
});

test('data URI media type and canonical base64 remain subject to the existing image validator', async t => {
  for (const url of ['https://example.invalid/never-fetch.png', 'data:text/plain;base64,aGVsbG8=',
    'data:image/png;base64,broken', 'data:image/png;base64,Zg===']) {
    const f = await fixture(t); f.response.content[2].image_url = url; await f.write();
    await assert.rejects(f.run(), /image/);
    assert.deepEqual(f.openedPaths, [f.path]);
  }
});

test('observed older two-key metadata retains strict image triplets and the persisted high or original detail', async t => {
  for (const detail of ['high', 'original']) {
    const f = await fixture(t);
    delete f.response.internal_chat_message_metadata_passthrough.content_item_kinds;
    for (const block of f.response.content.filter(block => block.type === 'input_image')) block.detail = detail;
    await f.write();
    const before = await readFile(f.path), exported = await f.run();
    const blocks = exported.common.messages[0].content;
    assert.deepEqual(blocks.filter(block => block.type === 'image').map(block => `data:${block.source.media_type};base64,${block.source.data}`), f.urls);
    assert.equal(blocks.filter(block => block.type === 'text' && block.text.includes(`"nativePersistedImageDetail":"${detail}"`)).length, 2);
    assert.deepEqual(await readFile(f.path), before);
    assert.equal(f.calls.length, 2);
  }
});

test('older metadata support never ignores incorrect present kinds, unknown metadata keys or unobserved detail values', async t => {
  for (const mutate of [
    f => { f.response.internal_chat_message_metadata_passthrough.content_item_kinds = null; },
    f => { f.response.internal_chat_message_metadata_passthrough.content_item_kinds = []; },
    f => { f.response.internal_chat_message_metadata_passthrough.unrecognized = true; },
    f => { delete f.response.internal_chat_message_metadata_passthrough.content_item_kinds; f.response.internal_chat_message_metadata_passthrough.unrecognized = true; },
    f => { delete f.response.internal_chat_message_metadata_passthrough.content_item_kinds; f.response.content[1].text += ' changed'; },
    ...['auto', 'low', 'future', null].map(detail => f => {
      delete f.response.internal_chat_message_metadata_passthrough.content_item_kinds; f.response.content[2].detail = detail;
    }),
  ]) {
    const f = await fixture(t); mutate(f); await f.write();
    await assert.rejects(f.run(), /local image recovery/);
  }
});

test('observed turn-only metadata and absent raw response IDs preserve the exact completed-item image proof', async t => {
  for (const includeResponseId of [true, false]) {
    const f = await fixture(t);
    f.response.internal_chat_message_metadata_passthrough = { turn_id: f.turnId };
    if (!includeResponseId) delete f.response.id;
    await f.write();
    const before = await readFile(f.path), exported = await f.run();
    const images = exported.common.messages[0].content.filter(block => block.type === 'image');
    assert.deepEqual(images.map(block => `data:${block.source.media_type};base64,${block.source.data}`), f.urls);
    assert.deepEqual(f.response.internal_chat_message_metadata_passthrough, { turn_id: f.turnId });
    assert.equal(Object.hasOwn(f.response, 'id'), includeResponseId);
    assert.deepEqual(await readFile(f.path), before);
    assert.equal(f.calls.length, 2);
  }
});

test('optional response metadata cannot replace required turn, completion-item, count or closure evidence', async t => {
  for (const mutate of [
    f => { delete f.response.internal_chat_message_metadata_passthrough; },
    f => { f.response.internal_chat_message_metadata_passthrough = null; },
    f => { f.response.internal_chat_message_metadata_passthrough = {}; },
    f => { f.response.internal_chat_message_metadata_passthrough.turn_id = randomUUID(); },
    f => { f.response.internal_chat_message_metadata_passthrough.extra = true; },
    f => { f.response.internal_chat_message_metadata_passthrough.create_time = null; },
    f => { f.response.internal_chat_message_metadata_passthrough.create_time = '1790300000'; },
    f => { f.response.internal_chat_message_metadata_passthrough.content_item_kinds = ['user.text']; },
    f => { f.response.internal_chat_message_metadata_passthrough = { turn_id: f.turnId, create_time: 1790300000, content_item_kinds: ['wrong'] }; },
    ...[null, '', 17].map(id => f => { f.response.id = id; }),
    f => { f.response.unrecognized = 'not an observed payload shape'; },
    f => { f.rawItem.id = randomUUID(); },
    f => { f.rows[5].payload.turn_id = randomUUID(); },
    f => { f.rows[2].payload.turn_id = randomUUID(); },
    f => { f.rows[6].payload.turn_id = randomUUID(); },
    f => { f.response.content.splice(4); },
    f => { f.rows.splice(5, 0, structuredClone(f.rows[4])); },
  ]) {
    const f = await fixture(t);
    f.response.internal_chat_message_metadata_passthrough = { turn_id: f.turnId };
    delete f.response.id;
    mutate(f); await f.write();
    await assert.rejects(f.run(), /local image recovery/);
  }
});

test('native optional client IDs normalize only absence to API null while explicit values remain exact', async t => {
  for (const clientId of [undefined, null, 'observed-client-id']) {
    const f = await fixture(t);
    if (clientId === undefined) delete f.rawItem.client_id;
    else f.rawItem.client_id = clientId;
    f.item.clientId = clientId ?? null;
    await f.write();
    const before = await readFile(f.path), exported = await f.run();
    assert.equal(exported.common.messages[0].content.filter(block => block.type === 'image').length, 2);
    assert.deepEqual(await readFile(f.path), before);
    assert.equal(Object.hasOwn(f.rawItem, 'client_id'), clientId !== undefined);
  }
});

test('client identity mismatches and raw alias collisions cannot be hidden by optional-field normalization', async t => {
  for (const mutate of [
    f => { delete f.rawItem.client_id; f.item.clientId = 'unexpected-client'; },
    f => { f.rawItem.client_id = null; f.item.clientId = 'unexpected-client'; },
    f => { f.rawItem.client_id = 'explicit-native-client'; f.item.clientId = null; },
    f => { f.rawItem.client_id = 'explicit-native-client'; f.item.clientId = 'different-client'; },
    f => { f.rawItem.client_id = 0; f.item.clientId = null; },
    f => { f.rawItem.clientId = f.rawItem.client_id; },
    f => { f.rawItem.clientId = 'conflicting-client'; },
    f => { delete f.rawItem.client_id; f.rawItem.clientId = null; f.item.clientId = null; },
  ]) {
    const f = await fixture(t); mutate(f); await f.write();
    await assert.rejects(f.run(), /does not exactly match|conflicting client identity aliases/);
  }
});

test('current-rollout resolution never searches history_base or another file for missing image provenance', async t => {
  const f = await fixture(t);
  f.rows[0].payload.history_base = { path: '/do-not-read/a-prefix.jsonl' };
  f.rows.splice(4, 2); await f.write();
  await assert.rejects(f.run(), /missing|lacks complete unambiguous/);
  assert.deepEqual(f.openedPaths, [f.path]);
});

test('rollout and row scan caps, image output caps, malformed rows and symlinks refuse recovery', async t => {
  const f = await fixture(t), size = (await lstat(f.path)).size;
  await assert.rejects(f.run({ resolveLocalImages: f.resolver({ maxBytes: size - 1 }) }), /scan byte limit/);
  await assert.rejects(f.run({ resolveLocalImages: f.resolver({ maxRowBytes: 128 }) }), /row byte limit/);
  const link = join(f.base, 'linked-rollout.jsonl'); await symlink(f.path, link);
  await assert.rejects(f.run({ resolveLocalImages: f.resolver({ path: link }) }), /owned regular file/);
  await appendFile(f.path, '{malformed}\n');
  await assert.rejects(f.run(), /malformed rollout row/);
  await f.write(); await appendFile(f.path, '{}');
  await assert.rejects(f.run(), /incomplete final line/);
  await f.write();
  f.response.content[2].image_url = `data:image/png;base64,${Buffer.alloc(8000).toString('base64')}`; await f.write();
  await assert.rejects(f.run({ limits: { maxBytes: 4096 } }), /recovered image byte limit/);
});

test('an observed source change during the bounded raw read is never accepted', async t => {
  const f = await fixture(t); let stats = 0;
  const io = { ...f.io, async lstat(path) {
    if (++stats === 2) await appendFile(path, '\n');
    return lstat(path);
  } };
  await assert.rejects(f.run({ resolveLocalImages: f.resolver({ io }) }), /transcript changed while being read during image recovery/);
});

test('DesktopRuntime enables verified image recovery only for its authoritative unmanaged source path', async t => {
  const f = await fixture(t);
  const runtime = await new DesktopRuntime({ root: join(f.base, 'state'), codexHome: f.codexHome, claudeHome: f.claudeHome,
    clientFactory: async () => f.client, ownerFactory() { assert.fail('No Claude worker is needed'); } }).initialize();
  t.after(() => runtime.close());
  const result = await runtime.inspect({ side: 'codex', nativeId: f.threadId, managed: false });
  assert.equal(result.common.messages[0].content.filter(block => block.type === 'image').length, 2);
  await assert.rejects(runtime.inspect({ side: 'codex', nativeId: f.threadId, managed: true, conversationId: randomUUID() }), /Owned Codex checkpoint contains an unsupported native user input/);
});

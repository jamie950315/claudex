import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, realpath, writeFile, readFile, appendFile, lstat, rename, symlink, chmod, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { ClaudeOwner, CLAUDE_OWNER_CLI_VERSION, CLAUDE_OWNER_SDK_VERSION } from '../src/claude-owner.mjs';
import { encodeClaude, sessionPath } from '../src/claude.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';
import { encodeArchivedContextPacket } from '../src/context-archive.mjs';
import { captureImageAssets } from '../src/claude-image-assets.mjs';
import { fingerprint } from '../src/history.mjs';
import { hash, writeJSON } from '../src/storage.mjs';
import { publishClaudeFolderMap } from '../src/claude-folder-map.mjs';

function queue() {
  const items = []; let wake, ended = false;
  return { push(item) { items.push(item); wake?.(); }, end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || items.length) {
        if (items.length) yield items.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    } };
}

const turn = label => [{ role: 'user', content: [{ type: 'text', text: `Question ${label}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${label}` }] }];

async function fixture(t, { count = 1, packetVersion = 2, images = false, incomplete = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cldx-stopped owner 空白-')));
  const root = join(base, 'state'), codexHome = join(base, 'codex'), claudeHome = join(base, 'claude'), cwd = join(base, 'project');
  await Promise.all([codexHome, claudeHome, cwd].map(path => mkdir(path, { mode: 0o700 })));
  const calls = { starts: [], inputs: [], connections: [], renames: [] }, outputs = new Map();
  let clock = 0;
  const runtime = await new DesktopRuntime({ root, codexHome, claudeHome, contextMode: 'archive', now: () => clock,
    claudeOwnerIdleSeconds: 60, ownerFactory: settings => new ClaudeOwner({ ...settings,
      sdkVersion: CLAUDE_OWNER_SDK_VERSION, claudeVersion: CLAUDE_OWNER_CLI_VERSION,
      settingsResolver: async () => ({ effective: {}, sources: [] }), policyPreflight: async () => ({ version: 1, sources: [] }),
      queryFactory: ({ prompt, options }) => {
        calls.starts.push(options);
        const id = options.resume ?? options.sessionId, path = sessionPath(claudeHome, cwd, id), output = queue();
        outputs.set(id, output);
        (async () => {
          for await (const item of prompt) {
            calls.inputs.push(item);
            assert.equal(item.shouldQuery, false, 'synthetic transport must never request inference');
            const previous = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse).findLast(row => row.uuid)?.uuid ?? null;
            await appendFile(path, JSON.stringify({ type: 'user', uuid: item.uuid, sessionId: id, cwd,
              parentUuid: previous, timestamp: '2026-09-25T01:00:00Z', message: item.message }) + '\n');
            output.push({ type: 'result', subtype: 'success', is_error: false, session_id: id,
              user_message_uuid: item.uuid, user_message_uuids: [item.uuid], num_turns: 0, duration_api_ms: 0, total_cost_usd: 0 });
          }
        })();
        return { initializationResult: async () => ({ session_state: 'idle', commands: [{ name: 'clear' }] }),
          mcpServerStatus: async () => [],
          async enableRemoteControl(_enabled, _title, registration) {
            calls.connections.push(registration); return { bridge_session_id: registration.reattachSessionId };
          },
          async renameSession(title, sessionId) {
            calls.renames.push({ title, sessionId });
            await appendFile(path, JSON.stringify({ type: 'custom-title', sessionId, customTitle: title }) + '\n');
          },
          close() { output.end(); }, [Symbol.asyncIterator]: () => output[Symbol.asyncIterator]() };
      } }) }).initialize();
  t.after(async () => { await runtime.close(); await rm(base, { recursive: true, force: true }); });
  const records = [], savedStates = [], statePaths = [], messages = turn('imported');
  if (images) messages[0].content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
  for (let index = 0; index < count; index++) {
    const conversationId = randomUUID(), nativeId = randomUUID(), path = sessionPath(claudeHome, cwd, nativeId);
    const record = { id: randomUUID(), conversationId, nativeId, side: 'claude', path, cwd, title: `Synthetic ${index}`,
      kind: 'owner', managed: true, verified: true, status: 'current', packetVersion, imageProjectionVersion: 1,
      checkpoint: { count: messages.length, digest: fingerprint({ messages }) } };
    const content = await (packetVersion === 2 ? encodeArchivedContextPacket : encodeContextPacket)({ root,
      messages, conversationId, targetSessionId: nativeId, key: runtime.key, operationId: 'initial', sourceSide: 'codex',
      imageProjectionVersion: 1 });
    const encoded = encodeClaude({ meta: { id: nativeId, cwd, timestamp: '2026-09-25T00:00:00Z' }, messages: [
      { role: 'user', content }, ...(incomplete ? [{ role: 'user', content: [{ type: 'text', text: 'Unfinished native input' }] }] : []),
    ] }, nativeId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const saved = { version: 1, conversationId, sessionId: nativeId, cwd, claudeHome, remoteId: `cse_synthetic_${index}`,
      registration: 'registered', pending: null, reset: null, displayTitle: record.title,
      lastAppend: { operationId: 'initial', uuid: encoded.rows.find(row => row.type === 'user').uuid } };
    encoded.rows.push({ type: 'bridge-session', sessionId: nativeId, bridgeSessionId: saved.remoteId });
    await writeFile(path, encoded.rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    const statePath = join(root, 'owners', `${hash(conversationId)}.json`);
    await writeJSON(statePath, saved);
    records.push(record); savedStates.push(saved); statePaths.push(statePath);
  }
  return { runtime, root, base, cwd, claudeHome, messages, records, savedStates, statePaths, calls, outputs,
    record: records[0], saved: savedStates[0], statePath: statePaths[0], advance: ms => { clock += ms; } };
}

test('unchanged lifecycle syncs and presentation publication over twelve managed owners start zero processes', async t => {
  const f = await fixture(t, { count: 12 });
  const state = { version: 2, pending: null, audit: [], conversations: {}, records: [] };
  for (const record of f.records) {
    state.conversations[record.conversationId] = { id: record.conversationId, cwd: record.cwd, title: record.title, canonical: record.checkpoint };
    state.records.push(record, { ...record, id: randomUUID(), side: 'codex', nativeId: randomUUID(), kind: 'snapshot' });
  }
  await writeJSON(join(f.root, 'desktop-state.json'), state);
  const bridge = new DesktopBridge({ root: f.root, adapters: { ...f.runtime.adapters,
    codex: { inspect: async record => ({ nativeId: record.nativeId, common: { meta: { id: record.nativeId, cwd: record.cwd }, messages: f.messages },
      digest: fingerprint({ messages: f.messages }), incompleteTail: false }) } } });
  for (let pass = 0; pass < 2; pass++) for (const record of f.records) {
    assert.deepEqual(await bridge.sync(record.conversationId), { changed: false });
    await f.runtime.assertIdle(record);
  }
  await publishClaudeFolderMap({ root: f.root, state });
  const map = JSON.parse(await readFile(join(f.root, 'folder-map.json'), 'utf8'));
  assert.equal(map.entries.length, 12);
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.renames.length, 0); assert.equal(f.runtime.owners.size, 0);
});

for (const packetVersion of [1, 2]) test(`stopped v${packetVersion} image history matches the live owner canonical digest`, async t => {
  const f = await fixture(t, { packetVersion, images: true });
  const before = await readFile(f.record.path), stopped = await f.runtime.inspect(f.record);
  assert.equal(stopped.digest, fingerprint({ messages: f.messages }));
  assert.equal(stopped.incompleteTail, false); assert.equal(f.calls.starts.length, 0);
  await f.runtime.owner(f.record.conversationId, f.cwd, f.record.title, { forceNormal: true });
  const live = await f.runtime.inspect(f.record);
  assert.equal(live.digest, stopped.digest); assert.deepEqual(live.common.messages, stopped.common.messages);
  assert.equal(f.calls.starts.length, 1); assert.deepEqual(await readFile(f.record.path), before);
});

test('a stopped incomplete tail stays withheld while the absent owner is idle', async t => {
  const f = await fixture(t, { incomplete: true });
  const data = await f.runtime.inspect(f.record);
  assert.equal(data.incompleteTail, true); assert.equal(data.digest, fingerprint({ messages: f.messages }));
  await f.runtime.assertIdle(f.record); assert.equal(f.calls.starts.length, 0);
});

test('an already running owner retains live inspection, idle checks and busy refusal', async t => {
  const f = await fixture(t);
  const owner = await f.runtime.owner(f.record.conversationId, f.cwd, f.record.title, { forceNormal: true });
  assert.equal((await f.runtime.inspect(f.record)).digest, fingerprint({ messages: f.messages }));
  await f.runtime.assertIdle(f.record); assert.equal(await f.runtime.needsMaintenance(f.record), false);
  owner.nativeState = 'running';
  await assert.rejects(f.runtime.assertIdle(f.record), /turn is still running/);
  assert.equal(f.calls.starts.length, 1); assert.equal(f.runtime.owners.get(f.record.conversationId).owner, owner);
  owner.nativeState = 'idle';
});

for (const child of [false, true]) test(`a live foreign ${child ? 'child' : 'owner'} lock refuses all stopped inspection paths`, async t => {
  const f = await fixture(t), lockPath = f.statePath + '.lock';
  const text = JSON.stringify({ pid: child ? 2147483647 : process.pid, childPid: child ? process.pid : null, nonce: randomUUID() });
  await writeFile(lockPath, text, { mode: 0o600 });
  for (const read of [() => f.runtime.inspect(f.record), () => f.runtime.assertIdle(f.record), () => f.runtime.needsMaintenance(f.record)])
    await assert.rejects(read(), /already running/);
  assert.equal(await readFile(lockPath, 'utf8'), text); assert.equal(f.calls.starts.length, 0);
});

test('a verified dead owner lock is reclaimed without a process or native mutation', async t => {
  const f = await fixture(t), before = await readFile(f.record.path);
  await writeFile(f.statePath + '.lock', JSON.stringify({ pid: 2147483647, childPid: null, nonce: randomUUID() }, null, 2), { mode: 0o600 });
  assert.equal((await f.runtime.inspect(f.record)).digest, fingerprint({ messages: f.messages }));
  await assert.rejects(lstat(f.statePath + '.lock'), { code: 'ENOENT' });
  assert.equal(f.calls.starts.length, 0); assert.deepEqual(await readFile(f.record.path), before);
});

test('mismatched state, pending work and native Remote Control disagreements fail without startup', async t => {
  const f = await fixture(t);
  const engineVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  for (const change of [{ version: 2 }, { conversationId: randomUUID() }, { sessionId: randomUUID() },
    { cwd: f.base }, { claudeHome: f.base }, { pending: { phase: 'sent' } }, { reset: { phase: 'restoring' } },
    { blocked: 'Synthetic owner blocked', blockedEngine: engineVersion }, { remoteId: 'cse_foreign' }]) {
    await writeJSON(f.statePath, { ...f.saved, ...change });
    await assert.rejects(f.runtime.inspect(f.record), /identity|pending|blocked|disagree/);
    assert.equal(f.calls.starts.length, 0);
  }
  await writeJSON(f.statePath, f.saved);
  await assert.rejects(f.runtime.inspect({ ...f.record, path: join(f.claudeHome, 'wrong.jsonl') }), /identity/);
});

test('replaced or nonprivate owner metadata is refused and no writer can start during its read lease', async t => {
  const f = await fixture(t);
  await chmod(f.statePath, 0o644);
  await assert.rejects(f.runtime.inspect(f.record), /private owned regular file/);
  await chmod(f.statePath, 0o600);
  const original = f.statePath + '.preserved'; await rename(f.statePath, original); await symlink(original, f.statePath);
  await assert.rejects(f.runtime.inspect(f.record));
  await rm(f.statePath); await rename(original, f.statePath);
  await f.runtime.readStoppedOwner(f.record, async () => {
    await assert.rejects(ClaudeOwner.open({ root: f.root, conversationId: f.record.conversationId, cwd: f.cwd, claudeHome: f.claudeHome }), /already running/);
    await writeJSON(f.statePath, f.saved);
  }).then(() => assert.fail('state replacement must be refused'), error => assert.match(error.message, /state changed/));
  assert.equal(f.calls.starts.length, 0);
});

test('a transcript replacement during a stopped read fails its exact snapshot identity check', async t => {
  const f = await fixture(t), original = fs.open;
  const mock = t.mock.method(fs, 'open', async (path, ...args) => {
    const file = await original(path, ...args);
    if (path === f.record.path) {
      const read = file.readFile.bind(file);
      file.readFile = async (...readArgs) => {
        const text = await read(...readArgs);
        await rename(path, path + '.preserved'); await writeFile(path, text, { mode: 0o600 });
        return text;
      };
    }
    return file;
  });
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(f.runtime.inspect(f.record), /Transcript changed while being read/);
  assert.equal(f.calls.starts.length, 0);
});

test('a no-query delivery starts one normal owner and later disk checks do not defeat idle eviction', async t => {
  const f = await fixture(t), common = { meta: { cwd: f.cwd }, messages: [...f.messages, ...turn('new delivery')] };
  const planned = await f.runtime.plan('claude', { conversationId: f.record.conversationId, common, title: f.record.title, target: f.record });
  const record = { ...f.record, ...planned }, pending = { operationId: 'delivery', previous: f.record.checkpoint };
  assert.equal(f.calls.starts.length, 1); assert.notDeepEqual(f.calls.starts[0].settingSources, []);
  await f.runtime.apply(record, common, pending);
  assert.equal(f.calls.inputs.length, 1); assert.equal(f.calls.starts.length, 1);
  assert.equal((await f.runtime.inspect(record)).digest, fingerprint(common));
  f.advance(61_000); assert.deepEqual(await f.runtime.closeIdleOwners(), [record.conversationId]);
  const remoteId = JSON.parse(await readFile(f.statePath, 'utf8')).remoteId;
  assert.equal((await f.runtime.inspect(record)).digest, fingerprint(common));
  await f.runtime.assertIdle(record); assert.equal(await f.runtime.needsMaintenance(record), false);
  assert.equal(f.calls.starts.length, 1); assert.equal(f.runtime.nextOwnerIdleAt(), Infinity);
  assert.deepEqual(await f.runtime.wakeClaudeOwner(record, { ...f.saved, remoteId }), { woken: true });
  assert.equal(f.calls.starts.length, 2); assert.equal(f.calls.connections.at(-1).reattachSessionId, remoteId);
});

test('maintenance discovery stays process-free; only an actual reset plan starts a cold owner', async t => {
  const f = await fixture(t, { packetVersion: 1 });
  const data = await f.runtime.inspect(f.record);
  assert.equal(await f.runtime.needsMaintenance(f.record, data), true); await f.runtime.assertIdle(f.record);
  assert.equal(f.calls.starts.length, 0);
  await f.runtime.plan('claude', { conversationId: f.record.conversationId, common: data.common, title: f.record.title,
    target: f.record, contextReset: true });
  assert.deepEqual(f.calls.starts[0].settingSources, []); assert.equal(f.calls.connections.length, 0);
  const owner = f.runtime.owners.get(f.record.conversationId).owner;
  assert.equal(owner.status().coldResetEligible, true);
  owner.everConnected = true;
  await assert.rejects(f.runtime.plan('claude', { conversationId: f.record.conversationId, common: data.common,
    title: f.record.title, target: f.record, contextReset: true }), /fresh cold native owner/);
});

test('image maintenance and legacy title migration stay lazy until a delivery plan starts the owner', async t => {
  const f = await fixture(t, { images: true });
  f.record.imageProjectionVersion = 0;
  f.saved.displayTitle = `[Claudex] ${f.record.title}`;
  await writeJSON(f.statePath, f.saved);
  await appendFile(f.record.path, JSON.stringify({ type: 'custom-title', sessionId: f.record.nativeId, customTitle: f.saved.displayTitle }) + '\n');
  const data = await f.runtime.inspect(f.record);
  assert.equal(await f.runtime.needsMaintenance(f.record, data), 'images');
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.renames.length, 0);
  const planned = await f.runtime.plan('claude', { conversationId: f.record.conversationId, common: data.common,
    title: f.record.title, target: f.record, contextRefresh: true });
  assert.equal(planned.contextRefresh, true); assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.renames.length, 1);
});

test('stopped readers restore bound original images without editing native previews', async t => {
  const f = await fixture(t, { packetVersion: 1, images: true });
  const rows = (await readFile(f.record.path, 'utf8')).trim().split('\n').map(JSON.parse), row = rows.find(row => row.type === 'user');
  const content = structuredClone(row.message.content), preview = Buffer.from('synthetic native preview');
  Object.assign(row, { version: CLAUDE_OWNER_CLI_VERSION, queueTranscriptOnly: true, promptSource: 'sdk', imagePasteIds: [1] });
  row.message.content.find(block => block.type === 'image').source.data = preview.toString('base64');
  const claudeTempRoot = join(f.base, 'cache'), imagesPath = join(claudeTempRoot, f.cwd.replace(/[^a-zA-Z0-9]/g, '-'), f.record.nativeId, 'images');
  await mkdir(imagesPath, { recursive: true, mode: 0o700 });
  await writeFile(join(imagesPath, '1.png'), Buffer.from('hello'), { mode: 0o600 });
  const normalizeContent = blocks => blocks.map(block => block.type === 'image'
    ? { type: 'image', source: { type: block.source.type, media_type: block.source.media_type, data: block.source.data } } : block);
  const captured = await captureImageAssets({ root: f.root, claudeTempRoot, cwd: f.cwd, sessionId: f.record.nativeId,
    row, expectedContent: content, expectedHash: hash(normalizeContent(content)), normalizeContent });
  await writeJSON(f.statePath, { ...f.saved, imageBindings: { [row.uuid]: captured.bindings } });
  await writeFile(f.record.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = await readFile(f.record.path), data = await f.runtime.inspect(f.record);
  assert.equal(data.digest, fingerprint({ messages: f.messages })); assert.equal(f.calls.starts.length, 0);
  await f.runtime.owner(f.record.conversationId, f.cwd, f.record.title, { forceNormal: true });
  assert.equal((await f.runtime.inspect(f.record)).digest, data.digest);
  assert.deepEqual(await readFile(f.record.path), before);
});

test('stopped reset generations authenticate lastReset and still guard the retained original', async t => {
  const f = await fixture(t), previousId = randomUUID(), previousPath = sessionPath(f.claudeHome, f.cwd, previousId);
  // Promotion retains this operation flag in the current ledger record.
  f.record.contextReset = true;
  const previousText = encodeClaude({ meta: { id: previousId, cwd: f.cwd, timestamp: '2026-09-25T00:00:00Z' }, messages: f.messages }, previousId).text;
  await writeFile(previousPath, previousText, { mode: 0o600 });
  const info = await lstat(previousPath), operationId = 'reset-bootstrap';
  const content = await encodeArchivedContextPacket({ root: f.root, messages: f.messages, conversationId: f.record.conversationId,
    targetSessionId: f.record.nativeId, key: f.runtime.key, operationId, sourceSide: 'codex', imageProjectionVersion: 1 });
  const base = { isSidechain: false, cwd: f.cwd, sessionId: f.record.nativeId, version: CLAUDE_OWNER_CLI_VERSION,
    timestamp: '2026-09-25T01:00:00Z' };
  const rows = [
    { ...base, type: 'user', uuid: randomUUID(), parentUuid: null, isMeta: true, queueTranscriptOnly: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>' } },
    { ...base, type: 'user', uuid: randomUUID(), queueTranscriptOnly: true,
      message: { role: 'user', content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>' } },
    { ...base, type: 'system', uuid: randomUUID(), subtype: 'local_command', content: '<local-command-stdout></local-command-stdout>' },
    { ...base, type: 'user', uuid: randomUUID(), queueTranscriptOnly: true, promptSource: 'sdk', message: { role: 'user', content } },
  ];
  for (let index = 1; index < rows.length; index++) rows[index].parentUuid = rows[index - 1].uuid;
  const lastReset = { operationId, sessionId: f.record.nativeId, bootstrapUuid: rows[3].uuid,
    receipt: { sessionId: f.record.nativeId, localCommand: 'clear', numTurns: 0, apiMs: 0, cost: 0 } };
  const saved = { ...f.saved, lastReset, lastAppend: { operationId, uuid: rows[3].uuid },
    retainedGeneration: { sessionId: previousId, transcriptPath: previousPath, ino: info.ino,
      bytes: Buffer.byteLength(previousText), hash: hash(previousText), sealed: true, imageBindings: {} } };
  await writeJSON(f.statePath, saved);
  await writeFile(f.record.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const stopped = await f.runtime.inspect(f.record);
  assert.equal(stopped.digest, fingerprint({ messages: f.messages })); assert.equal(f.calls.starts.length, 0);
  await f.runtime.owner(f.record.conversationId, f.cwd, f.record.title, { forceNormal: true });
  assert.equal((await f.runtime.inspect(f.record)).digest, stopped.digest);
  f.advance(61_000); await f.runtime.closeIdleOwners();
  await writeJSON(f.statePath, { ...saved, lastReset: { ...lastReset, receipt: { ...lastReset.receipt, apiMs: 1 } } });
  await assert.rejects(f.runtime.inspect(f.record), /verified native no-query receipt/);
  await writeJSON(f.statePath, saved);
  await appendFile(previousPath, JSON.stringify({ type: 'user', sessionId: previousId, message: { role: 'user', content: 'Concurrent history' } }) + '\n');
  await assert.rejects(f.runtime.inspect(f.record), /preserved context-reset source changed/);
  assert.equal(f.calls.starts.length, 1);
});

test('durable append recovery starts an owner, reconciles exact persistence and never resends', async t => {
  const f = await fixture(t), common = { meta: { cwd: f.cwd }, messages: [...f.messages, ...turn('recovery')] };
  const planned = await f.runtime.plan('claude', { conversationId: f.record.conversationId, common, title: f.record.title, target: f.record });
  const record = { ...f.record, ...planned }, pending = { operationId: 'recover-delivery', previous: f.record.checkpoint, common };
  await f.runtime.apply(record, common, pending);
  f.advance(61_000); await f.runtime.closeIdleOwners();
  const saved = JSON.parse(await readFile(f.statePath, 'utf8'));
  await writeJSON(f.statePath, { ...saved, pending: { ...saved.lastAppend, phase: 'sent' }, lastAppend: null });
  await assert.rejects(f.runtime.inspect(record), /pending native append requires owner recovery/);
  assert.equal(f.calls.starts.length, 1);
  assert.equal(await f.runtime.operationApplied(record, pending), true);
  assert.equal(f.calls.starts.length, 2); assert.equal(f.calls.inputs.length, 1);
  const recovered = JSON.parse(await readFile(f.statePath, 'utf8'));
  assert.equal(recovered.pending, null); assert.equal(recovered.lastAppend.recovered, true);
  await f.runtime.completePromotion(record);
  assert.equal((await f.runtime.inspect(record)).digest, fingerprint(common));
  assert.equal(f.calls.inputs.length, 1); assert.equal(f.calls.connections.at(-1).reattachSessionId, f.saved.remoteId);
});

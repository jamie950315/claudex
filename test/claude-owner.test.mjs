import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, appendFile, readFile, writeFile, realpath, lstat, chmod, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ClaudeOwner, CLAUDE_OWNER_CLI_VERSION, CLAUDE_OWNER_SDK_VERSION, claudeOwnerEnvironment, resolveClaudeOwnerExecutable } from '../src/claude-owner.mjs';
import { sessionPath } from '../src/claude.mjs';

function queue() {
  const items = []; let wake, ended = false;
  return {
    push(item) { items.push(item); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || items.length) {
        if (items.length) yield items.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

test('default Claude home preserves the default Keychain namespace without copying credentials', async () => {
  const standard = join(homedir(), '.claude');
  const env = await claudeOwnerEnvironment(standard, { CLAUDE_CONFIG_DIR: standard, EXAMPLE_SETTING: 'retained' },
    { CLAUDE_CONFIG_DIR: '/different/home', PATH: '/example/path' });
  assert.equal(Object.hasOwn(env, 'CLAUDE_CONFIG_DIR'), false);
  assert.equal(env.EXAMPLE_SETTING, 'retained');
  assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  assert.equal(env.PATH, '/example/path');
  const isolated = await claudeOwnerEnvironment('/example/isolated-claude', {}, {});
  assert.equal(isolated.CLAUDE_CONFIG_DIR, '/example/isolated-claude');
  assert.equal(Object.hasOwn(isolated, 'DISABLE_AUTOUPDATER'), false);
  const inheritedUpdate = await claudeOwnerEnvironment('/example/isolated-claude', {}, { DISABLE_AUTOUPDATER: '1' });
  assert.equal(inheritedUpdate.DISABLE_AUTOUPDATER, '1');
  const explicitUpdate = await claudeOwnerEnvironment('/example/isolated-claude', { DISABLE_AUTOUPDATER: '0' }, { DISABLE_AUTOUPDATER: '1' });
  assert.equal(explicitUpdate.DISABLE_AUTOUPDATER, '0');
});

test('owner resolves a PATH command to the same absolute executable it will validate and launch', async () => {
  const executable = await realpath(process.execPath);
  assert.equal(await resolveClaudeOwnerExecutable(basename(process.execPath), { PATH: dirname(process.execPath) }), executable);
  assert.equal(await resolveClaudeOwnerExecutable(process.execPath, { PATH: '' }), executable);
  await assert.rejects(resolveClaudeOwnerExecutable('missing-synthetic-claude', { PATH: '/does-not-exist' }), /could not be resolved/);
});

async function fixture({ receipt = true, persist = true, receiptMutator, beforeReceipt, persistRow,
  directoryPrefix = 'claudex-owner-', remoteFailure = false, initializationFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), directoryPrefix));
  const claudeHome = join(root, 'claude'); await mkdir(claudeHome);
  const calls = { appends: [], remote: [], options: [] }, events = [];
  let live, output, closeCount = 0;
  const queryFactory = ({ prompt, options }) => {
    calls.options.push(options); output = queue();
    const id = options.resume ?? options.sessionId;
    const path = sessionPath(claudeHome, options.cwd, id);
    live = {
      initializationResult: async () => {
        if (initializationFailure) {
          output.push({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: id });
          await new Promise(resolve => setImmediate(resolve));
          throw new Error('Synthetic initialization failure during remote activity.');
        }
        return { session_state: 'idle' };
      },
      async enableRemoteControl(enabled, title, settings) {
        calls.remote.push({ enabled, title, settings });
        const remoteId = settings.reattachSessionId ?? `cse_${randomUUID().replaceAll('-', '')}`;
        await mkdir(join(path, '..'), { recursive: true });
        await appendFile(path, JSON.stringify({ type: 'bridge-session', sessionId: id, bridgeSessionId: remoteId }) + '\n');
        if (remoteFailure) throw new Error('Synthetic connection loss after durable registration.');
        return { bridge_session_id: remoteId, session_url: `https://claude.ai/code/${remoteId}` };
      },
      close() { closeCount++; output.end(); },
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    };
    (async () => {
      for await (const item of prompt) {
        calls.appends.push(item);
        if (persist) {
          await mkdir(join(path, '..'), { recursive: true });
          const row = persistRow ? await persistRow({ item, id, options })
            : { type: 'user', uuid: item.uuid, sessionId: id, message: item.message };
          await appendFile(path, JSON.stringify(row) + '\n');
        }
        if (beforeReceipt) await beforeReceipt({ output, item, id, path });
        if (receipt) {
          const result = { type: 'result', subtype: 'success', is_error: false, session_id: id,
            uuid: randomUUID(), user_message_uuid: item.uuid, user_message_uuids: [item.uuid],
            num_turns: 0, duration_api_ms: 0, total_cost_usd: 0 };
          output.push(receiptMutator ? receiptMutator(result) : result);
        }
      }
    })();
    return live;
  };
  const config = { root: join(root, 'state'), conversationId: 'synthetic conversation', cwd: root, claudeHome,
    queryFactory, sdkVersion: CLAUDE_OWNER_SDK_VERSION, claudeVersion: CLAUDE_OWNER_CLI_VERSION,
    // Receipt classification needs fixture filesystem I/O to finish under the
    // full suite. Only intentional missing-receipt cases use the short timeout.
    receiptTimeoutMs: receipt ? 2000 : 80, onEvent: event => events.push(event) };
  return { root, config, calls, events, emit: event => output.push(event), closeCount: () => closeCount };
}

test('owner preserves identities, uses no-query appends, and deduplicates across restart', async () => {
  const f = await fixture(); let owner = await ClaudeOwner.open(f.config);
  const first = await owner.append({ operationId: 'a', content: 'Source user: Alpha. Source assistant: Acknowledged.' });
  assert.match(first.remoteId, /^cse_/);
  assert.equal(f.calls.appends[0].shouldQuery, false);
  assert.equal(f.calls.appends[0].client_composed, true);
  assert.equal(f.calls.options[0].persistSession, true);
  assert.deepEqual(f.calls.options[0].settingSources, ['user', 'project', 'local']);
  await owner.append({ operationId: 'b', content: 'Source user: Beta. Source assistant: Updated.' });
  const repeated = await owner.append({ operationId: 'a', content: 'Source user: Alpha. Source assistant: Acknowledged.' });
  assert.equal(repeated.duplicate, true);
  assert.equal(f.calls.appends.length, 2);
  await owner.close();
  owner = await ClaudeOwner.open(f.config);
  assert.equal(owner.status().sessionId, first.sessionId);
  assert.equal(owner.status().remoteId, first.remoteId);
  assert.equal(f.calls.remote.at(-1).settings.reattachSessionId, first.remoteId);
  const again = await owner.append({ operationId: 'a', content: 'Source user: Alpha. Source assistant: Acknowledged.' });
  assert.equal(again.duplicate, true);
  assert.equal(f.calls.appends.length, 2);
  await assert.rejects(owner.append({ operationId: 'a', content: 'Different history' }), /different content/);
  await owner.close();
});

test('an unexpected native session identity never turns an old idle level into shutdown authority', async () => {
  const f = await fixture(), owner = await ClaudeOwner.open(f.config);
  try {
    f.emit({ type: 'system', subtype: 'init', session_id: randomUUID() });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(owner.status().blocked, /another session/);
    await assert.rejects(owner.close(), /busy/);
    assert.equal(f.closeCount(), 0);
    // Even a late frame from the old identity cannot restore authority over
    // the now-unidentified native process.
    f.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: owner.status().sessionId });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(owner.close(), /busy/);
    assert.equal(f.closeCount(), 0);
  } finally {
    // This is a process-free fixture: terminate its synthetic stream explicitly
    // after proving the production close path refused to interrupt it.
    owner.input.end(); owner.query.close(); await owner.consumer; await owner.lock.release();
  }
});

test('owner rejects another writer and mismatched runtime versions', async () => {
  const f = await fixture(), owner = await ClaudeOwner.open(f.config);
  assert.equal(owner.status().versionPolicy, 'strict');
  assert.equal(owner.status().versionWarning, null);
  await assert.rejects(ClaudeOwner.open(f.config), /already running/);
  await owner.close();
  await assert.rejects(ClaudeOwner.open({ ...f.config, sdkVersion: '0.0.0' }), /pinned versions/);
});

test('warn policy permits future Claude CLI and SDK versions without bypassing ownership or no-query receipts', async () => {
  const f = await fixture();
  const config = { ...f.config, versionPolicy: 'warn', sdkVersion: '0.4.1', claudeVersion: '2.2.1' };
  const owner = await ClaudeOwner.open(config);
  try {
    assert.equal(owner.status().versionPolicy, 'warn');
    assert.equal(owner.status().versionWarning, null);
    await owner.loadRuntime();
    assert.equal(f.events.filter(event => event.type === 'owner_version_warning').length, 0);
    await assert.rejects(ClaudeOwner.open(config), /already running/);
    await owner.append({ operationId: 'future-version', content: 'Verified no-query handoff using a future runtime fixture.' });
    assert.equal(f.calls.appends[0].shouldQuery, false);
    assert.equal(f.events.filter(event => event.type === 'owner_append_receipt').length, 1);
  } finally { await owner.close(); }
  await assert.rejects(ClaudeOwner.open({ ...config, claudeVersion: '' }), /pinned versions/);
  await assert.rejects(ClaudeOwner.open({ ...config, sdkVersion: 'invalid\nversion' }), /pinned versions/);
  assert.throws(() => new ClaudeOwner({ ...f.config, versionPolicy: 'invalid' }), /versionPolicy/);
});

test('startup failure during a remote turn retains the owner and lock without closing the native process', async () => {
  const f = await fixture({ initializationFailure: true }), owner = new ClaudeOwner(f.config);
  await assert.rejects(owner.start(), /Synthetic initialization failure/);
  assert.equal(f.closeCount(), 0);
  assert.equal(owner.status().closed, false);
  assert.match(owner.status().blocked, /live session is preserved/);
  await assert.rejects(ClaudeOwner.open(f.config), /already running/);
  f.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: owner.status().sessionId });
  await new Promise(resolve => setImmediate(resolve));
  await owner.close();
});

test('owner preserves inline image blocks and rejects unsupported content before sending', async () => {
  const f = await fixture(), owner = await ClaudeOwner.open(f.config);
  const content = [{ type: 'text', text: 'Source image:' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }];
  await owner.append({ operationId: 'image', content });
  assert.deepEqual(f.calls.appends[0].message.content, content);
  const repeated = await owner.append({ operationId: 'image', content });
  assert.equal(repeated.duplicate, true);
  await assert.rejects(owner.append({ operationId: 'external', content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid/private.png' } }] }), /inline base64 images only/);
  assert.equal(f.calls.appends.length, 1);
  await owner.close();
});

test('owner accepts and deduplicates a five-MiB image without native RegExp stack exhaustion', async () => {
  const f = await fixture(), owner = await ClaudeOwner.open({ ...f.config, receiptTimeoutMs: 2000 });
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png',
    data: Buffer.alloc(5 * 1024 * 1024, 71).toString('base64') } }];
  try {
    assert.equal((await owner.append({ operationId: 'large-image', content })).duplicate, false);
    assert.equal((await owner.append({ operationId: 'large-image', content })).duplicate, true);
    assert.equal(f.calls.appends.length, 1);
    assert.equal(f.calls.appends[0].shouldQuery, false);
    assert.equal(f.calls.appends[0].message.content[0].source.data, content[0].source.data);
  } finally { await owner.close(); }
});

test('a receipt without exact native persistence never commits', async () => {
  const f = await fixture({ persist: false }), owner = await ClaudeOwner.open(f.config);
  await assert.rejects(owner.append({ operationId: 'a', content: 'Synthetic handoff' }), /without the exact persisted/);
  assert.equal(owner.status().pending, 'a');
  await owner.close();
  await assert.rejects(ClaudeOwner.open(f.config), /delivery is uncertain/);
  assert.equal(f.calls.appends.length, 1);
});

test('lost receipt recovers by native UUID and content without a second append', async () => {
  const f = await fixture({ receipt: false }); let owner = await ClaudeOwner.open(f.config);
  await assert.rejects(owner.append({ operationId: 'a', content: 'Synthetic handoff' }), /timed out/);
  await owner.close();
  owner = await ClaudeOwner.open(f.config);
  const recovered = await owner.append({ operationId: 'a', content: 'Synthetic handoff' });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.duplicate, true);
  assert.equal(f.calls.appends.length, 1);
  await owner.close();
});

async function resizedImageFixture({ receipt = true, cacheMode = 0o700 } = {}) {
  const original = Buffer.from('Synthetic original image from an isolated user profile');
  const preview = Buffer.from('Synthetic native resized preview');
  const image = bytes => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
  const content = [{ type: 'text', text: 'Preserve this exact image' }, image(original)];
  let cache;
  const f = await fixture({ receipt, directoryPrefix: 'claudex owner 空白路徑-',
    async persistRow({ item, id, options }) {
      const cacheRoot = join(options.env.CLAUDE_CODE_TMPDIR, `claude-${process.getuid()}`);
      const project = join(cacheRoot, resolve(options.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
      const images = join(project, id, 'images');
      await mkdir(cacheRoot, { recursive: true, mode: cacheMode });
      await mkdir(images, { recursive: true, mode: 0o755 });
      // Establish the observed native modes explicitly: a caller's restrictive
      // umask must not turn this regression into an already-private cache.
      await chmod(cacheRoot, cacheMode);
      for (const path of [project, dirname(images), images]) await chmod(path, 0o755);
      await writeFile(join(images, '1.png'), original, { mode: 0o600 });
      cache = { root: cacheRoot, project, path: join(images, '1.png'), identity: await lstat(project) };
      return { type: 'user', uuid: item.uuid, sessionId: id, version: CLAUDE_OWNER_CLI_VERSION,
        queueTranscriptOnly: true, promptSource: 'sdk', imagePasteIds: [1],
        message: { ...item.message, content: [content[0], image(preview)] } };
    } });
  f.config.options = { env: { CLAUDE_CODE_TMPDIR: join(f.root, 'custom temporary 快取') } };
  return { ...f, content, original, preview: image(preview), cache: () => cache };
}

test('new native 0755 image projects recover through custom temporary paths and restart without rewriting or resending', async t => {
  for (const receipt of [true, false]) await t.test(receipt ? 'normal receipt' : 'lost receipt', async () => {
    const f = await resizedImageFixture({ receipt });
    let owner;
    try {
      owner = await ClaudeOwner.open(f.config);
      const operationId = 'portable-native-image';
      if (receipt) await owner.append({ operationId, content: f.content });
      else {
        await assert.rejects(owner.append({ operationId, content: f.content }), /timed out/);
        assert.equal(owner.status().pending, operationId);
        assert.equal((await lstat(f.cache().project)).mode & 0o777, 0o755);
      }
      const sessionId = owner.status().sessionId, remoteId = owner.status().remoteId;
      const nativeBefore = await readFile(owner.status().transcriptPath);
      const nativeRow = nativeBefore.toString().trim().split('\n').map(JSON.parse).find(row => row.type === 'user');
      assert.deepEqual(nativeRow.message.content[1], f.preview);
      await owner.close(); owner = null;
      owner = await ClaudeOwner.open(f.config);
      assert.equal(owner.status().sessionId, sessionId); assert.equal(owner.status().remoteId, remoteId);
      assert.equal(owner.status().pending, null);
      const recovered = await owner.append({ operationId, content: f.content });
      assert.equal(recovered.duplicate, true);
      assert.equal(recovered.recovered === true, !receipt);
      assert.equal(f.calls.appends.length, 1); assert.equal(f.calls.appends[0].shouldQuery, false);
      assert.equal(f.calls.options.every(options => options.env.CLAUDE_CODE_TMPDIR === f.config.options.env.CLAUDE_CODE_TMPDIR), true);
      const after = await lstat(f.cache().project);
      assert.equal(after.mode & 0o777, 0o700);
      assert.equal(after.dev, f.cache().identity.dev); assert.equal(after.ino, f.cache().identity.ino);
      assert.deepEqual(await readFile(f.cache().path), f.original);
      assert.deepEqual((await readFile(owner.status().transcriptPath)).subarray(0, nativeBefore.length), nativeBefore);
      const restored = await owner.inspectTranscript();
      assert.deepEqual(restored.rows.find(row => row.type === 'user').message.content, f.content);
      // Once durably bound, restart reads the private asset store rather than
      // depending on a native temporary cache that the OS can remove.
      await rm(f.config.options.env.CLAUDE_CODE_TMPDIR, { recursive: true });
      await owner.close(); owner = null;
      owner = await ClaudeOwner.open(f.config);
      assert.deepEqual((await owner.inspectTranscript()).rows.find(row => row.type === 'user').message.content, f.content);
      assert.equal((await owner.append({ operationId, content: f.content })).duplicate, true);
      assert.equal(f.calls.appends.length, 1);
    } finally { await owner?.close(); await rm(f.root, { recursive: true, force: true }); }
  });
});

test('unsafe image caches retain the exact pending append until guarded recovery becomes possible', async () => {
  const f = await resizedImageFixture({ cacheMode: 0o755 });
  let owner;
  try {
    owner = await ClaudeOwner.open(f.config);
    await assert.rejects(owner.append({ operationId: 'unsafe-cache', content: f.content }), /private owned directory/);
    assert.equal(owner.status().pending, 'unsafe-cache');
    const nativeBefore = await readFile(owner.status().transcriptPath);
    await owner.close(); owner = null;
    const failedRestart = new ClaudeOwner(f.config);
    await assert.rejects(failedRestart.start(), /private owned directory/);
    assert.equal(f.calls.appends.length, 1); assert.equal(f.calls.options.length, 1);
    assert.equal((await lstat(f.cache().root)).mode & 0o777, 0o755);
    assert.equal((await lstat(f.cache().project)).mode & 0o777, 0o755);
    assert.deepEqual(await readFile(failedRestart.status().transcriptPath), nativeBefore);
    // Only the isolated fixture repairs its deliberately unsafe parent. The
    // product must not alter it or discard the intent to regain availability.
    await chmod(f.cache().root, 0o700);
    owner = await ClaudeOwner.open(f.config);
    assert.equal(owner.status().pending, null);
    assert.equal((await owner.append({ operationId: 'unsafe-cache', content: f.content })).recovered, true);
    assert.equal(f.calls.appends.length, 1);
    assert.deepEqual((await readFile(owner.status().transcriptPath)).subarray(0, nativeBefore.length), nativeBefore);
  } finally { await owner?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('real remote results cannot satisfy a bridge receipt and are not interrupted', async () => {
  const f = await fixture({ beforeReceipt: async ({ output, id, path }) => {
    const uuid = randomUUID();
    await appendFile(path, JSON.stringify({ type: 'user', uuid, sessionId: id, message: { role: 'user', content: 'Actual synthetic remote user input' } }) + '\n');
    output.push({ type: 'result', subtype: 'success', session_id: id, user_message_uuid: uuid,
      num_turns: 2, duration_api_ms: 1500, total_cost_usd: 0.3 });
  } });
  const owner = await ClaudeOwner.open(f.config);
  await owner.append({ operationId: 'a', content: 'Synthetic handoff' });
  assert.equal(f.events.filter(e => e.type === 'owner_append_receipt').length, 1);
  assert.equal(f.events.filter(e => e.type === 'native_event' && e.event.type === 'result').length, 1);
  assert.equal(f.closeCount(), 0);
  f.emit({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: owner.status().sessionId });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(owner.append({ operationId: 'b', content: 'Later handoff' }), /postponed/);
  await assert.rejects(owner.close(), /refusing to interrupt/);
  f.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: owner.status().sessionId });
  await new Promise(resolve => setImmediate(resolve));
  await owner.close();
});

test('unknown querying results pause appends but preserve the remote process', async () => {
  const f = await fixture(), owner = await ClaudeOwner.open(f.config);
  f.emit({ type: 'result', subtype: 'success', session_id: owner.status().sessionId,
    user_message_uuid: randomUUID(), num_turns: 1, duration_api_ms: 1500, total_cost_usd: 0.3 });
  for (let i = 0; i < 30 && !owner.status().blocked; i++) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(owner.append({ operationId: 'a', content: 'Synthetic handoff' }), /no verified external user turn/);
  assert.equal(f.closeCount(), 0);
  await owner.close();
});

test('querying bridge receipts pause synchronization without killing user work', async () => {
  const f = await fixture({ receiptMutator: result => ({ ...result, num_turns: 1, duration_api_ms: 1500, total_cost_usd: 0.3 }) });
  const config = { ...f.config, versionPolicy: 'warn', sdkVersion: '0.4.1', claudeVersion: '2.2.1' };
  const owner = await ClaudeOwner.open(config);
  await assert.rejects(owner.append({ operationId: 'a', content: 'Synthetic handoff' }), /querying or ambiguous/);
  assert.equal(f.closeCount(), 0);
  await assert.rejects(owner.append({ operationId: 'b', content: 'Next handoff' }), /synchronization is paused/);
  await owner.close();
  await assert.rejects(ClaudeOwner.open(config), /synchronization is paused/);
});

test('a no-query receipt retains prior session cost without treating it as new inference', async () => {
  const f = await fixture({ receiptMutator: result => ({ ...result, total_cost_usd: 0.205278,
    modelUsage: { 'claude-sonnet-5': { costUSD: 0.205278 } } }) });
  const owner = await ClaudeOwner.open(f.config);
  try {
    await owner.append({ operationId: 'after-real-reply', content: 'Synthetic handoff after an earlier model reply' });
    const receipt = f.events.find(event => event.type === 'owner_append_receipt');
    assert.equal(receipt.numTurns, 0);
    assert.equal(receipt.apiMs, 0);
    assert.equal(Object.hasOwn(receipt, 'cost'), false);
    assert.equal(receipt.cumulativeCost, 0.205278);
    assert.equal(owner.status().blocked, null);
  } finally { await owner.close(); }
});

test('a positive session cost cannot disguise querying or ambiguous bridge receipts', async () => {
  for (const fields of [{ num_turns: 1 }, { duration_api_ms: 1 }, { total_cost_usd: -1 },
    { user_message_uuids: [randomUUID()] }]) {
    const f = await fixture({ receiptMutator: result => ({ ...result, total_cost_usd: 0.205278, ...fields }) });
    const owner = await ClaudeOwner.open(f.config);
    try { await assert.rejects(owner.append({ operationId: 'bad-receipt', content: 'Synthetic handoff' }), /querying or ambiguous/); }
    finally { await owner.close(); }
  }
});

test('remote registration crash recovers native bridge identity rather than allocating a duplicate', async () => {
  const f = await fixture({ remoteFailure: true }), owner = await ClaudeOwner.open(f.config);
  await assert.rejects(owner.append({ operationId: 'a', content: 'Synthetic handoff' }), /Synthetic connection loss/);
  const savedPath = owner.statePath, nativePath = owner.status().transcriptPath;
  const saved = JSON.parse(await readFile(savedPath));
  assert.equal(saved.registration, 'registering'); assert.equal(saved.remoteId, null);
  const native = (await readFile(nativePath, 'utf8')).trim().split('\n').map(JSON.parse);
  const remoteId = native.find(r => r.type === 'bridge-session').bridgeSessionId;
  await owner.close();
  await assert.rejects(ClaudeOwner.open(f.config), /Synthetic connection loss/);
  assert.equal(f.calls.remote.at(-1).settings.reattachSessionId, remoteId);
  assert.equal(JSON.parse(await readFile(savedPath)).remoteId, remoteId);
});

test('tampered native UUID content prevents crash recovery', async () => {
  const f = await fixture({ receipt: false }), owner = await ClaudeOwner.open(f.config);
  await assert.rejects(owner.append({ operationId: 'a', content: 'Synthetic handoff' }), /timed out/);
  const path = owner.status().transcriptPath;
  await owner.close();
  const row = JSON.parse((await readFile(path, 'utf8')).trim());
  row.message.content = 'Changed history';
  await writeFile(path, JSON.stringify(row) + '\n');
  await assert.rejects(ClaudeOwner.open(f.config), /does not match/);
  assert.equal(f.calls.appends.length, 1);
});

test('a newly created owner persists its distinct display title without changing the logical title', async () => {
  const f = await fixture();
  const config = { ...f.config, title: 'Ping', newSessionTitle: '[Claudex] Ping' };
  const owner = await ClaudeOwner.open(config);
  try {
    assert.equal(owner.title, 'Ping');
    assert.equal(f.calls.options[0].title, '[Claudex] Ping');
    assert.equal(JSON.parse(await readFile(owner.statePath)).displayTitle, '[Claudex] Ping');
    await owner.append({ operationId: 'first', content: 'Synthetic handoff' });
    assert.equal(f.calls.remote[0].title, '[Claudex] Ping');
    assert.equal(f.calls.remote[0].settings.reattachSessionId, undefined);
    assert.equal(f.calls.appends[0].shouldQuery, false);
  } finally { await owner.close(); }
});

test('a saved creation title survives restart before the first Remote Control registration', async () => {
  const f = await fixture();
  const config = { ...f.config, title: 'Ping', newSessionTitle: '[Claudex] Ping' };
  let owner = await ClaudeOwner.open(config);
  const nativeId = owner.status().sessionId;
  await owner.close();
  owner = await ClaudeOwner.open({ ...config, newSessionTitle: '[Different creation default] Ping' });
  try {
    assert.equal(owner.status().sessionId, nativeId);
    assert.equal(f.calls.options.at(-1).title, '[Claudex] Ping');
    await owner.append({ operationId: 'after-restart', content: 'Synthetic handoff' });
    assert.equal(f.calls.remote.at(-1).title, '[Claudex] Ping');
    assert.equal(JSON.parse(await readFile(owner.statePath)).displayTitle, '[Claudex] Ping');
  } finally { await owner.close(); }
});

test('registered owner restart reattaches without imposing a title or repeatedly adding a prefix', async () => {
  const f = await fixture();
  const config = { ...f.config, title: 'Ping', newSessionTitle: '[Claudex] Ping' };
  let owner = await ClaudeOwner.open(config);
  await owner.append({ operationId: 'first', content: 'Synthetic handoff' });
  const nativeId = owner.status().sessionId, remoteId = owner.status().remoteId;
  await owner.close();
  for (let restart = 0; restart < 2; restart++) {
    owner = await ClaudeOwner.open({ ...config, newSessionTitle: '[Claudex] [Claudex] Ping' });
    try {
      assert.equal(owner.title, 'Ping');
      assert.equal(owner.status().sessionId, nativeId);
      assert.equal(owner.status().remoteId, remoteId);
      assert.equal(f.calls.options.at(-1).title, '[Claudex] Ping');
      assert.equal(f.calls.remote.at(-1).title, undefined);
      assert.equal(f.calls.remote.at(-1).settings.reattachSessionId, remoteId);
      assert.equal(JSON.parse(await readFile(owner.statePath)).displayTitle, '[Claudex] Ping');
    } finally { await owner.close(); }
  }
  assert.equal(f.calls.appends.length, 1);
});

test('a legacy owner without a display title is not bulk-renamed by a new creation default', async () => {
  const f = await fixture();
  const config = { ...f.config, title: 'Legacy title' };
  let owner = await ClaudeOwner.open(config);
  await owner.append({ operationId: 'legacy', content: 'Synthetic handoff' });
  const statePath = owner.statePath, remoteId = owner.status().remoteId;
  await owner.close();
  const saved = JSON.parse(await readFile(statePath));
  delete saved.displayTitle;
  await writeFile(statePath, JSON.stringify(saved));
  owner = await ClaudeOwner.open({ ...config, newSessionTitle: '[Claudex] Legacy title' });
  try {
    assert.equal(f.calls.options.at(-1).title, 'Legacy title');
    assert.equal(f.calls.remote.at(-1).title, undefined);
    assert.equal(f.calls.remote.at(-1).settings.reattachSessionId, remoteId);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath)), 'displayTitle'), false);
  } finally { await owner.close(); }
});

test('a malformed saved display title fails before starting a native owner or registering Remote Control', async () => {
  for (const displayTitle of ['', null, 42, { text: 'Invalid title' }]) {
    const f = await fixture();
    const owner = await ClaudeOwner.open({ ...f.config, title: 'Ping', newSessionTitle: '[Claudex] Ping' });
    const statePath = owner.statePath;
    await owner.close();
    const saved = JSON.parse(await readFile(statePath));
    await writeFile(statePath, JSON.stringify({ ...saved, displayTitle }));
    await assert.rejects(ClaudeOwner.open(f.config), /title/i);
    assert.equal(f.calls.options.length, 1);
    assert.equal(f.calls.remote.length, 0);
    assert.equal(f.calls.appends.length, 0);
  }
});

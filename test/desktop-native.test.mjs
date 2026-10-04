import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, appendFile, readFile, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { DesktopRuntime, persistentPacketKey } from '../src/desktop-runtime.mjs';
import { CodexClient } from '../src/codex.mjs';
import { ClaudeOwner, CLAUDE_OWNER_CLI_VERSION, CLAUDE_OWNER_SDK_VERSION } from '../src/claude-owner.mjs';
import { createCodexProjection, encodeCodexProjection } from '../src/codex-projection.mjs';
import { encodeClaude, sessionPath } from '../src/claude.mjs';
import { snapshot, hash, writeJSON } from '../src/storage.mjs';
import { fingerprint } from '../src/history.mjs';

function queue() {
  const items = []; let wake, ended = false, failure;
  return { push(item) { items.push(item); wake?.(); }, end() { ended = true; wake?.(); },
    fail(error) { failure = error; ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || items.length) {
        if (items.length) yield items.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
      if (failure) throw failure;
    } };
}

test('packet signing key persists across runtime restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-key-'));
  const first = await persistentPacketKey(root), second = await persistentPacketKey(root);
  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
  await writeJSON(join(root, 'desktop-state.json'), { records: [{ nativeId: 'existing' }] });
  await unlink(join(root, 'packet-key'));
  await assert.rejects(persistentPacketKey(root), /key is missing/);
});

test('runtime reconnects after backend closure but never replays a request', async () => {
  let connections = 0;
  const root = await mkdtemp(join(tmpdir(), 'cldx-reconnect-'));
  const runtime = new DesktopRuntime({ root, codexHome: root, claudeHome: root,
    clientFactory: async () => { connections++; return { closed: false, initialize: async () => ({}), close() { this.closed = true; } }; } });
  const first = await runtime.codex();
  assert.equal(await runtime.codex(), first);
  first.closed = true;
  assert.notEqual(await runtime.codex(), first);
  assert.equal(connections, 2);
  await runtime.close();
});

for (const contextMode of ['inline', 'archive']) test(`native ${contextMode} adapters alternate snapshots and a stable owner without losing canonical history`, { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-desktop-native-')));
  const stateRoot = join(root, 'state'), cwd = join(root, 'project'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path)));
  const turn = label => [
    { role: 'user', content: [{ type: 'text', text: `Synthetic question ${label}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `Synthetic answer ${label}` }] },
  ];
  const ownerStates = new Map();
  const ownerFactory = config => new ClaudeOwner({ ...config,
    sdkVersion: CLAUDE_OWNER_SDK_VERSION, claudeVersion: CLAUDE_OWNER_CLI_VERSION,
    settingsResolver: async () => ({ effective: {}, sources: [] }), policyPreflight: async () => ({ version: 1, sources: [] }),
    queryFactory: ({ prompt, options }) => {
      const id = options.resume ?? options.sessionId, path = sessionPath(claudeHome, config.cwd, id), output = queue();
      const data = { id, path, parent: null }; ownerStates.set(config.conversationId, data);
      const input = (async () => {
        for await (const item of prompt) {
          assert.equal(item.shouldQuery, false, 'synthetic transport must never request inference');
          await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
          const previous = await snapshot(path).catch(error => { if (error.code === 'ENOENT') return { rows: [] }; throw error; });
          data.parent = previous.rows.filter(row => row.uuid).at(-1)?.uuid ?? null;
          const row = { type: 'user', uuid: item.uuid, sessionId: id, cwd: config.cwd, parentUuid: data.parent,
            version: CLAUDE_OWNER_CLI_VERSION, timestamp: new Date().toISOString(), message: item.message };
          await appendFile(path, JSON.stringify(row) + '\n', { mode: 0o600 }); data.parent = item.uuid;
          output.push({ type: 'result', subtype: 'success', is_error: false, session_id: id,
            user_message_uuid: item.uuid, user_message_uuids: [item.uuid], num_turns: 0, duration_api_ms: 0, total_cost_usd: 0 });
        }
      })();
      input.catch(error => output.fail(error));
      return { initializationResult: async () => ({ session_state: 'idle', commands: [{ name: 'clear' }] }),
        mcpServerStatus: async () => [],
        async enableRemoteControl(_enabled, _title, registration) {
          const remoteId = registration.reattachSessionId ?? `cse_${randomUUID().replaceAll('-', '')}`;
          await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
          await appendFile(path, JSON.stringify({ type: 'bridge-session', sessionId: id, bridgeSessionId: remoteId }) + '\n', { mode: 0o600 });
          return { bridge_session_id: remoteId };
        },
        close() { output.end(); }, [Symbol.asyncIterator]: () => output[Symbol.asyncIterator]() };
    } });
  const options = { root: stateRoot, codexHome, claudeHome, ownerFactory, contextMode,
    clientFactory: async () => new CodexClient({ codexHome }) };
  let runtime = await new DesktopRuntime(options).initialize();
  let bridge = new DesktopBridge({ root: stateRoot, adapters: runtime.adapters });
  const originalId = randomUUID();
  const original = await createCodexProjection({ client: await runtime.codex(), codexHome,
    id: originalId, title: 'Original synthetic source', common: { meta: { id: originalId, cwd, timestamp: new Date().toISOString() }, messages: turn('A') } });
  const originalHash = hash(await readFile(original.path, 'utf8'));
  let id;
  try {
    ({ conversationId: id } = await bridge.track({ side: 'codex', path: original.path }));
    await bridge.sync(id);
    const claudeId = bridge.current(await bridge.status(), id, 'claude').nativeId;
    for (let round = 0; round < 6; round++) {
      const side = round % 2 === 0 ? 'claude' : 'codex';
      const source = bridge.current(await bridge.status(), id, side);
      // Stop the isolated native backend before fixture-only authored writes.
      // No production transcript, live writer, or model is involved.
      await runtime.close();
      const data = await snapshot(source.path);
      if (side === 'claude') {
        const owner = ownerStates.get(id);
        const rows = encodeClaude({ meta: { id: owner.id, cwd, timestamp: new Date().toISOString() }, messages: turn(`round-${round}`) }, owner.id, owner.parent);
        await appendFile(source.path, rows.text);
        owner.parent = rows.rows.filter(row => row.uuid).at(-1).uuid;
      } else {
        const seed = randomUUID();
        const rows = encodeCodexProjection({ meta: { id: seed, cwd, timestamp: new Date().toISOString() }, messages: turn(`round-${round}`) }, seed, { historyMode: 'paginated' })
          .trim().split('\n').map(JSON.parse).filter(row => row.type !== 'session_meta');
        let ordinal = Math.max(...data.rows.map(row => row.ordinal ?? -1)) + 1;
        for (const row of rows) { row.ordinal = ordinal++; if (row.payload.thread_id) row.payload.thread_id = source.nativeId; }
        await appendFile(source.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      }
      runtime = await new DesktopRuntime(options).initialize();
      bridge = new DesktopBridge({ root: stateRoot, adapters: runtime.adapters });
      if (side === 'codex') await (await runtime.codex()).resumeThread(source.nativeId, { excludeTurns: true });
      assert.equal((await bridge.sync(id)).changed, true, `Round ${round}: ${side}`);
      assert.equal((await bridge.sync(id)).changed, false);
      const state = await bridge.status();
      assert.equal(state.pending, null);
      assert.equal(bridge.current(state, id, 'claude').nativeId, claudeId);
      assert.ok(state.records.filter(record => record.managed && record.side === 'codex').length <= 2);
      const a = await runtime.inspect(bridge.current(state, id, 'codex'));
      const b = await runtime.inspect(bridge.current(state, id, 'claude'));
      assert.equal(fingerprint(a.common), fingerprint(b.common));
      const preserved = state.records.find(record => record.nativeId === originalId);
      assert.equal(preserved.managed, false);
      assert.equal(preserved.status, 'original');
      assert.match(preserved.path, /\/archived_sessions\//);
      assert.equal(hash(await readFile(preserved.path, 'utf8')), originalHash);
    }
    t.diagnostic(`Native desktop adapter evidence: ${root}`);
  } finally { await runtime.close(); }
});

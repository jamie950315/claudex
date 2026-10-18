import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeOwnerWakeRuntime } from '../crates/claudex-app/host/renderer/claude-owner-wake-runtime.mjs';

const attachedClient = callTool => ({
  transport: { _closed: false, pid: null, stderr: null, _port: { postMessage() {}, close() {} } },
  getServerVersion: () => ({ name: 'claudex', version: '1.0.3' }),
  getServerCapabilities: () => ({ tools: {} }), callTool,
});

function fixture() {
  const calls = [], errors = [], statuses = [], lookups = [];
  const map = { version: 1, entries: [{ remoteId: 'cse_owned', canonicalCwd: '/synthetic/project', verified: true }] };
  let clock = 0;
  const client = attachedClient(async (...args) => { calls.push(args); return { content: [{ type: 'text', text: '{"accepted":true}' }] }; });
  const options = { readMap: async () => ({ contents: JSON.stringify(map) }), now: () => clock,
    getClient: name => { lookups.push(name); return client; },
    onError: message => errors.push(message), onStatus: message => statuses.push(message) };
  const runtime = createClaudeOwnerWakeRuntime(options); runtime.start();
  const signal = (id, source = 'selection', type = 'bridge') => runtime.signal(id, source, type);
  return { calls, errors, statuses, lookups, client, map, options, runtime, signal, advance: ms => { clock += ms; } };
}

test('renderer activation carries only a published exact identity and debounces open plus submit', async () => {
  const f = fixture();
  await f.signal('local_00000000-0000-4000-8000-000000000000', 'selection', 'local');
  await f.signal('cse_owned', 'selection', 'remote');
  await f.signal('cse_foreign');
  await f.signal('session_owned');
  await f.signal('cse_owned', 'submit');
  assert.deepEqual(f.calls, [[{ name: 'claudex_desktop_owner_wake', arguments: { remoteId: 'cse_owned' } }]]);
  assert.deepEqual(f.lookups, ['claudex-desktop-wake']);
  assert.ok(f.statuses.includes('signal selection ignored non-rc-session'));
  assert.ok(f.statuses.includes('signal selection ignored unpublished'));
  assert.ok(f.statuses.includes('signal selection matched published'));
  assert.ok(f.statuses.includes('signal selection mcp lookup'));
  assert.ok(f.statuses.includes('signal selection mcp connected'));
  assert.ok(f.statuses.includes('signal selection called'));
  assert.ok(f.statuses.includes('signal selection accepted'));
  assert.ok(f.statuses.includes('signal submit ignored debounced'));
  f.advance(5000); await f.signal('session_owned', 'submit');
  assert.equal(f.calls.length, 2);
  f.runtime.stop(); f.advance(5000); await f.signal('cse_owned');
  assert.equal(f.calls.length, 2);
});

test('renderer rejects malformed or duplicate maps and does not dispatch after unload', async () => {
  const f = fixture(); f.map.entries.push({ ...f.map.entries[0] });
  await f.signal('cse_owned'); await f.signal('cse_owned');
  assert.equal(f.calls.length, 0); assert.equal(f.errors.length, 1);
  let finish;
  const late = createClaudeOwnerWakeRuntime({ ...f.options, readMap: () => new Promise(resolve => { finish = resolve; }) });
  late.start(); const flight = late.signal('cse_owned', 'selection', 'bridge'); late.stop();
  finish({ contents: JSON.stringify({ version: 1, entries: [f.map.entries[0]] }) }); await flight;
  assert.equal(f.calls.length, 0);
  assert.ok(f.statuses.includes('signal selection ignored stale-generation'));
});

test('renderer uses only an attached stdio MessagePort and never borrows a native session proxy', async () => {
  for (const mutate of [
    client => { client.transport = undefined; },
    client => { client.transport = { send() {}, sessionId: 'local_unrelated' }; },
    client => { client.transport._closed = true; },
    client => { client.getServerVersion = () => ({ name: 'foreign' }); },
    client => { client.getServerCapabilities = () => ({}); },
  ]) {
    const f = fixture(); mutate(f.client);
    await f.signal('cse_owned');
    assert.equal(f.calls.length, 0);
    assert.ok(f.statuses.includes('signal selection mcp lookup'));
    assert.ok(!f.statuses.includes('signal selection mcp connected'));
    assert.match(f.errors.at(-1), /mcp-(?:not-connected|client-unvalidated)/);
  }
});

test('renderer bounds activation attempts and reports native grant refusal without another channel', async () => {
  const f = fixture();
  f.map.entries = Array.from({ length: 20 }, (_, i) => ({ remoteId: `cse_${i}`, canonicalCwd: '/synthetic/project', verified: true }));
  for (let i = 0; i < 20; i++) await f.signal(`cse_${i}`);
  assert.equal(f.calls.length, 16);
  const refused = createClaudeOwnerWakeRuntime({ ...f.options,
    getClient: () => attachedClient(async () => ({ isError: true, content: [{ type: 'text', text: 'Native grant refused' }] })) });
  refused.start(); await refused.signal('cse_0', 'selection', 'bridge');
  assert.match(f.errors.at(-1), /refused/);
});



test('renderer diagnoses native API, map, grant, connection and receipt failures without exposing error text', async () => {
  const cases = [
    [{ readMap: undefined }, 'map-api-unavailable'],
    [{ getClient: undefined }, 'mcp-api-unavailable'],
    [{ readMap: async () => { throw new Error('Private prompt or credential'); } }, 'map-read-failed'],
    [{ readMap: async () => ({ contents: '{"private":"Private prompt or credential"}' }) }, 'map-invalid'],
    [{ readMap: async () => ({ contents: '{"entries":', isTail: true }) }, 'map-unavailable-or-truncated'],
    [{ getClient: () => { throw new Error('Private prompt or credential'); } }, 'mcp-lookup-failed'],
    [{ getClient: () => undefined }, 'mcp-not-connected'],
    [{ getClient: () => attachedClient(async () => { throw new Error('Private prompt or credential'); }) }, 'mcp-call-failed'],
    [{ getClient: () => attachedClient(async () => ({ isError: true, content: [{ type: 'text', text: "Access to 'claudex-desktop-wake' was not approved on this device" }] })) }, 'mcp-grant-refused'],
    [{ getClient: () => attachedClient(async () => ({ isError: true, content: [{ type: 'text', text: "Server 'claudex-desktop-wake' is not connected" }] })) }, 'mcp-not-connected'],
    [{ getClient: () => attachedClient(async () => ({ isError: true, content: [{ type: 'text', text: 'Private prompt or credential' }] })) }, 'mcp-refused'],
    [{ getClient: () => attachedClient(async () => ({ content: [{ type: 'text', text: 'Private prompt or credential' }] })) }, 'receipt-invalid'],
  ];
  for (const [overrides, reason] of cases) {
    const f = fixture(), runtime = createClaudeOwnerWakeRuntime({ ...f.options, ...overrides });
    runtime.start(); await runtime.signal('cse_owned', 'submit', 'bridge');
    assert.ok(f.statuses.includes(`signal submit call failed ${reason}`), reason);
    assert.equal(f.errors.at(-1), `Owner wake ${reason}`);
    assert.ok(![...f.errors, ...f.statuses].join('\n').includes('Private prompt or credential'));
  }
});

test('renderer bounds diagnostic rate, rereads membership and reports only known deferral reasons', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) await f.signal(`not an identity ${i}`);
  assert.equal(f.statuses.filter(line => line === 'signal selection ignored invalid-identity').length, 1);
  const runtime = createClaudeOwnerWakeRuntime({ ...f.options,
    getClient: () => attachedClient(async () => ({ structuredContent: { accepted: false, reason: 'Private prompt or credential' } })) });
  runtime.start(); await runtime.signal('cse_owned', 'selection', 'bridge');
  assert.ok(f.statuses.includes('signal selection deferred not accepted'));
  await f.signal('cse_owned');
  f.map.entries = []; f.advance(5000); await f.signal('session_owned', 'submit');
  assert.equal(f.calls.length, 1);
  assert.ok(f.statuses.includes('signal submit ignored unpublished'));
  const bounded = fixture();
  for (let i = 0; i < 25; i++) {
    bounded.advance(1000);
    for (const source of ['selection', 'submit']) {
      await bounded.signal('invalid', source);
      await bounded.signal('cse_owned', source, 'local');
    }
  }
  assert.equal(bounded.statuses.length, 64);
  bounded.advance(5000); await bounded.signal('invalid');
  assert.equal(bounded.statuses.length, 65);
  assert.ok(!f.statuses.join('\n').includes('Private prompt or credential'));
});

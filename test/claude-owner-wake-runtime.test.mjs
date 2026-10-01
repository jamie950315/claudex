import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createClaudeOwnerWakeRuntime } from '../src/claude-owner-wake-runtime.mjs';
import { buildClaudeOwnerWakeSource, transformClaudeOwnerWakeSource } from '../src/claude-owner-wake-cache.mjs';

function fixture() {
  const calls = [], errors = [], statuses = [];
  const map = { version: 1, entries: [{ remoteId: 'cse_owned', canonicalCwd: '/synthetic/project', verified: true }] };
  let clock = 0;
  const options = { readMap: async () => ({ contents: JSON.stringify(map) }), now: () => clock,
    callTool: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: '{"accepted":true}' }] }; },
    onError: message => errors.push(message), onStatus: message => statuses.push(message) };
  const runtime = createClaudeOwnerWakeRuntime(options); runtime.start();
  const signal = (id, source = 'selection', type = 'bridge') => runtime.signal(id, source, type);
  return { calls, errors, statuses, map, options, runtime, signal, advance: ms => { clock += ms; } };
}

test('renderer activation carries only a published exact identity and debounces open plus submit', async () => {
  const f = fixture();
  await f.signal('local_00000000-0000-4000-8000-000000000000', 'selection', 'local');
  await f.signal('cse_owned', 'selection', 'remote');
  await f.signal('cse_foreign');
  await f.signal('session_owned');
  await f.signal('cse_owned', 'submit');
  assert.deepEqual(f.calls, [['claudex-desktop-wake', 'claudex_desktop_owner_wake', { remoteId: 'cse_owned' }]]);
  assert.ok(f.statuses.includes('signal selection ignored non-rc-session'));
  assert.ok(f.statuses.includes('signal selection ignored unpublished'));
  assert.ok(f.statuses.includes('signal selection matched published'));
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

test('renderer bounds activation attempts and reports native grant refusal without another channel', async () => {
  const f = fixture();
  f.map.entries = Array.from({ length: 20 }, (_, i) => ({ remoteId: `cse_${i}`, canonicalCwd: '/synthetic/project', verified: true }));
  for (let i = 0; i < 20; i++) await f.signal(`cse_${i}`);
  assert.equal(f.calls.length, 16);
  const refused = createClaudeOwnerWakeRuntime({ ...f.options,
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'Native grant refused' }] }) });
  refused.start(); await refused.signal('cse_0', 'selection', 'bridge');
  assert.match(f.errors.at(-1), /refused/);
});

test('pinned Code component signals current RC selection and submit before native refusal without changing input', async () => {
  const runtimeSource = await readFile(new URL('../src/claude-owner-wake-runtime.mjs', import.meta.url), 'utf8');
  // The live Code asset owns X={id,type} in o8. Shared FM is a different view.
  const fixtureSource = 'function o8(Te){let X=Te,Z=X?.id??null,De;let fS;fS=async(e,t)=>{if(t?.blocked)return "blocked_transport";return nativeSend(e,t)};return fS}';
  const source = transformClaudeOwnerWakeSource(fixtureSource, { root: '/private/claudex', runtimeSource });
  const calls = [], effects = [], events = [], diagnostics = [];
  const context = { globalThis: { 'claude.web': {
    LocalSessions: { readFileAtCwd: async (...args) => { calls.push(args); return { contents: JSON.stringify({ version: 1,
      entries: [{ remoteId: 'cse_open', canonicalCwd: '/synthetic/project', verified: true },
        { remoteId: 'cse_send', canonicalCwd: '/synthetic/project', verified: true }] }) }; } },
    LocalAgentModeSessions: { directMcpCallTool: async (...args) => { events.push(args); return { structuredContent: { accepted: true } }; } },
  } }, m: (effect, deps) => { effects.push({ effect, deps }); }, window: { addEventListener() {} }, console: { warn: line => diagnostics.push(line) },
    Date, capture: null };
  runInNewContext(source, context);
  assert.deepEqual(diagnostics, ['[Claudex owner wake] loaded cc43287c9-6nYyeS-m.js', '[Claudex owner wake] started',
    '[Claudex owner wake] native APIs map=available mcp=available']);
  context.o8({ id: 'session_open', type: 'bridge' });
  await effects[0].effect();
  await new Promise(resolve => setImmediate(resolve));
  const submit = context.o8({ id: 'session_send', type: 'bridge' });
  // A disconnected native path still signals before returning its own refusal.
  assert.equal(await submit('Private native input', { blocked: true }), 'blocked_transport');
  await new Promise(resolve => setImmediate(resolve));
  const input = { prompt: 'Private native input' }, options = { native: true };
  context.nativeSend = async (value, opts) => { assert.equal(value, input); assert.equal(opts, options); return 'queued by Claude'; };
  assert.equal(await submit(input, options), 'queued by Claude');
  assert.deepEqual(calls, [['/private/claudex', 'folder-map.json'], ['/private/claudex', 'folder-map.json']]);
  assert.equal(effects.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(effects.map(effect => effect.deps))), [['session_open', 'bridge'], ['session_send', 'bridge']]);
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    ['claudex-desktop-wake', 'claudex_desktop_owner_wake', { remoteId: 'cse_open' }],
    ['claudex-desktop-wake', 'claudex_desktop_owner_wake', { remoteId: 'cse_send' }],
  ]);
  assert.throws(() => buildClaudeOwnerWakeSource(fixtureSource, {}), /unvalidated/);
  assert.throws(() => transformClaudeOwnerWakeSource(fixtureSource + fixtureSource, {}), /binding changed/);
  assert.throws(() => transformClaudeOwnerWakeSource('function FM(e){return e.conversationUuid}', {}), /binding changed/);
  assert.ok(diagnostics.includes('[Claudex owner wake] signal submit matched published'));
  assert.ok(!diagnostics.join('\n').includes('Private native input'));
});

test('renderer diagnoses native API, map, grant, connection and receipt failures without exposing error text', async () => {
  const cases = [
    [{ readMap: undefined }, 'map-api-unavailable'],
    [{ callTool: undefined }, 'mcp-api-unavailable'],
    [{ readMap: async () => { throw new Error('Private prompt or credential'); } }, 'map-read-failed'],
    [{ readMap: async () => ({ contents: '{"private":"Private prompt or credential"}' }) }, 'map-invalid'],
    [{ readMap: async () => ({ contents: '{"entries":', isTail: true }) }, 'map-unavailable-or-truncated'],
    [{ callTool: async () => { throw new Error('Private prompt or credential'); } }, 'mcp-call-failed'],
    [{ callTool: async () => ({ isError: true, content: [{ type: 'text', text: "Access to 'claudex-desktop-wake' was not approved on this device" }] }) }, 'mcp-grant-refused'],
    [{ callTool: async () => ({ isError: true, content: [{ type: 'text', text: "Server 'claudex-desktop-wake' is not connected" }] }) }, 'mcp-not-connected'],
    [{ callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'Private prompt or credential' }] }) }, 'mcp-refused'],
    [{ callTool: async () => ({ content: [{ type: 'text', text: 'Private prompt or credential' }] }) }, 'receipt-invalid'],
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
    callTool: async () => ({ structuredContent: { accepted: false, reason: 'Private prompt or credential' } }) });
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

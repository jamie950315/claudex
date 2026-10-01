import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createClaudeOwnerWakeRuntime } from '../src/claude-owner-wake-runtime.mjs';
import { buildClaudeOwnerWakeSource, transformClaudeOwnerWakeSource } from '../src/claude-owner-wake-cache.mjs';

function fixture() {
  const calls = [], errors = [];
  const map = { version: 1, entries: [{ remoteId: 'cse_owned', canonicalCwd: '/synthetic/project', verified: true }] };
  let clock = 0;
  const options = { readMap: async () => ({ contents: JSON.stringify(map) }), now: () => clock,
    callTool: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: '{"accepted":true}' }] }; },
    onError: message => errors.push(message) };
  const runtime = createClaudeOwnerWakeRuntime(options); runtime.start();
  return { calls, errors, map, options, runtime, advance: ms => { clock += ms; } };
}

test('renderer activation carries only a published exact identity and debounces open plus submit', async () => {
  const f = fixture();
  await f.runtime.signal('local_00000000-0000-4000-8000-000000000000');
  await f.runtime.signal('cse_foreign');
  await f.runtime.signal('session_owned');
  await f.runtime.signal('cse_owned');
  assert.deepEqual(f.calls, [['claudex-desktop-wake', 'claudex_desktop_owner_wake', { remoteId: 'cse_owned' }]]);
  f.advance(5000); await f.runtime.signal('session_owned');
  assert.equal(f.calls.length, 2);
  f.runtime.stop(); f.advance(5000); await f.runtime.signal('cse_owned');
  assert.equal(f.calls.length, 2);
});

test('renderer rejects malformed or duplicate maps and does not dispatch after unload', async () => {
  const f = fixture(); f.map.entries.push({ ...f.map.entries[0] });
  await f.runtime.signal('cse_owned'); await f.runtime.signal('cse_owned');
  assert.equal(f.calls.length, 0); assert.equal(f.errors.length, 1);
  let finish;
  const late = createClaudeOwnerWakeRuntime({ ...f.options, readMap: () => new Promise(resolve => { finish = resolve; }) });
  late.start(); const flight = late.signal('cse_owned'); late.stop();
  finish({ contents: JSON.stringify({ version: 1, entries: [f.map.entries[0]] }) }); await flight;
  assert.equal(f.calls.length, 0);
});

test('renderer bounds activation attempts and reports native grant refusal without another channel', async () => {
  const f = fixture();
  f.map.entries = Array.from({ length: 20 }, (_, i) => ({ remoteId: `cse_${i}`, canonicalCwd: '/synthetic/project', verified: true }));
  for (let i = 0; i < 20; i++) await f.runtime.signal(`cse_${i}`);
  assert.equal(f.calls.length, 16);
  const refused = createClaudeOwnerWakeRuntime({ ...f.options,
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'Native grant refused' }] }) });
  refused.start(); await refused.signal('cse_0');
  assert.match(f.errors.at(-1), /refused/);
});

test('pinned component transformation signals on mount and native send without inspecting or changing input', async () => {
  const runtimeSource = await readFile(new URL('../src/claude-owner-wake-runtime.mjs', import.meta.url), 'utf8');
  const fixtureSource = 'function FM(e){return e.sessionId}async function submit(c,L,ee){let U;U=await L.onSend(ee);return U}';
  const source = transformClaudeOwnerWakeSource(fixtureSource, { root: '/private/claudex', runtimeSource });
  const calls = [], effects = [], events = [], diagnostics = [];
  const context = { globalThis: { 'claude.web': {
    LocalSessions: { readFileAtCwd: async (...args) => { calls.push(args); return { contents: JSON.stringify({ version: 1,
      entries: [{ remoteId: 'cse_open', canonicalCwd: '/synthetic/project', verified: true },
        { remoteId: 'cse_send', canonicalCwd: '/synthetic/project', verified: true }] }) }; } },
    LocalAgentModeSessions: { directMcpCallTool: async (...args) => { events.push(args); return { structuredContent: { accepted: true } }; } },
  } }, h: (effect, deps) => { effects.push(deps); effect(); }, window: { addEventListener() {} }, console: { warn: line => diagnostics.push(line) },
    Date, capture: null };
  runInNewContext(source, context);
  assert.deepEqual(diagnostics, ['[Claudex owner wake] loaded shared-16-B0kpSitB.js', '[Claudex owner wake] started']);
  context.FM({ sessionId: 'unrelated-native-id', conversationUuid: 'session_open' });
  const input = { prompt: 'Private native input' }, native = { onSend: async value => { assert.equal(value, input); return 'queued by Claude'; } };
  assert.equal(await context.submit('session_send', native, input), 'queued by Claude');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['/private/claudex', 'folder-map.json'], ['/private/claudex', 'folder-map.json']]);
  assert.equal(effects.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    ['claudex-desktop-wake', 'claudex_desktop_owner_wake', { remoteId: 'cse_open' }],
    ['claudex-desktop-wake', 'claudex_desktop_owner_wake', { remoteId: 'cse_send' }],
  ]);
  assert.throws(() => buildClaudeOwnerWakeSource(fixtureSource, {}), /unvalidated/);
  assert.throws(() => transformClaudeOwnerWakeSource(fixtureSource + fixtureSource, {}), /binding changed/);
});

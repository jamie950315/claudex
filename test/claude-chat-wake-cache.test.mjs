import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { buildClaudeChatWakeBootstrap, buildClaudeChatWakeSource } from '../src/claude-chat-wake-cache.mjs';

test('wake bootstrap starts on module load independently of sidebar subscriptions and stops on unload', async () => {
  const events = [], native = { readFileAtCwd: async (...args) => { events.push(args); return {}; } };
  const source = buildClaudeChatWakeBootstrap({ root: '/private/claudex', registryRoot: '/native/registry',
    wakeSource: 'export function createClaudeChatWakeRuntime(options) { capture(options); return {start(){ record("start") },stop(){record("stop")}}; }'
  });
  let options, unload;
  runInNewContext(source, { Ve: native, capture: value => { options = value; }, record: value => events.push(value),
    document: { querySelectorAll: () => [] }, window: { addEventListener: (name, fn, settings) => {
      assert.equal(name, 'beforeunload'); assert.equal(settings.once, true); unload = fn;
    } }, console: { warn() {} } });
  assert.equal(events[0], 'start'); assert.equal(options.native, native);
  assert.equal(options.hasDraft(), false); await options.readManifest();
  assert.deepEqual(events[1], ['/private/claudex', 'collaboration/chat-mailbox/wake-manifest.json']);
  unload(); assert.equal(events.at(-1), 'stop');
});

test('wake bootstrap preserves any unsent text and refuses noncanonical roots', () => {
  const source = buildClaudeChatWakeBootstrap({ root: '/private/claudex', registryRoot: '/native/registry',
    wakeSource: 'export function createClaudeChatWakeRuntime(options) { capture(options); return {start(){},stop(){}}; }'
  });
  let options;
  runInNewContext(source, { Ve: {}, capture: value => { options = value; },
    document: { querySelectorAll: () => [{ textContent: 'unsent draft' }] },
    window: { addEventListener() {} }, console: { warn() {} } });
  assert.equal(options.hasDraft(), true);
  assert.throws(() => buildClaudeChatWakeBootstrap({ root: '/private/../other', registryRoot: '/native/registry', wakeSource: '' }), /canonical/);
});

test('unknown native frontend bytes never receive an executable wake adapter', () => {
  assert.throws(() => buildClaudeChatWakeSource('kd as Ke; Ke?.forkSession; Ke?.shareSession;', {}), /unvalidated/);
});

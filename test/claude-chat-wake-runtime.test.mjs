import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeChatWakeRuntime } from '../src/claude-chat-wake-runtime.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const localSessionId = 'local_33333333-3333-4333-8333-333333333333';
const claimId = '44444444-4444-4444-8444-444444444444';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(change = {}) {
  const message = { messageId: id, sessionId, localSessionId, cwd: '/project', title: 'Example',
    registryPath: `/registry/account/${localSessionId}.json`, expiresAt: 2000, ...change.message };
  const session = { sessionId: localSessionId, cwd: '/project', title: 'Example',
    isArchived: false, isRunning: false, turnRunning: false, lastActivityAt: 100, ...change.session };
  const registry = { ...session, cliSessionId: sessionId, ...change.registry };
  const sends = [], receipts = [], errors = [], claims = [], statuses = [];
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const native = {
    readFileAtCwd: async () => ({ contents: JSON.stringify(registry) }),
    getSession: async () => ({ ...session }),
    getBusyShellPtyKeys: async () => ({ probed: true, busy: [], unknown: [], ...change.busy }),
    mcpCallTool: async (target, server, tool, args) => {
      assert.equal(target, localSessionId); assert.equal(server, 'claudex-desktop-wake');
      if (tool === 'claudex_desktop_wake_claim') {
        claims.push(args); change.onClaim?.(session);
        if (change.claimError) throw new Error('Lost claim response');
        return result({ claimed: true, messageId: id, claimId, context: 'Quoted peer message', ...change.claim });
      }
      assert.equal(tool, 'claudex_desktop_wake_receipt'); receipts.push(args); return result({ accepted: true });
    },
    sendMessage: async (...args) => { sends.push(args); if (change.sendError) throw new Error('Unknown native outcome'); },
  };
  const runtime = createClaudeChatWakeRuntime({ native, registryRoot: '/registry', now: () => 1000,
    readManifest: async () => ({ contents: JSON.stringify({ version: 1, messages: [message] }) }),
    hasDraft: () => change.draft ?? false, setTimer: () => 1, clearTimer() {}, onError: error => errors.push(error),
    onStatus: status => statuses.push(status) });
  return { runtime, sends, receipts, errors, claims, statuses };
}

test('lifecycle and waiting diagnostics are distinct and repeated reasons are coalesced', async () => {
  const f = fixture({ draft: true });
  f.runtime.start(); await flush(); await f.runtime.poll(); f.runtime.stop();
  assert.deepEqual(f.statuses, ['loaded', 'started', 'waiting: draft']);
  assert.equal(f.claims.length, 0);
});

test('idle exact native identity is claimed once, sent through existing session and receipted without claiming acknowledgement', async () => {
  const f = fixture(); f.runtime.start(); await flush(); await f.runtime.poll(); f.runtime.stop();
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][0], localSessionId); assert.equal(f.sends[0][7], id);
  assert.deepEqual(f.receipts[0], { messageId: id, sessionId, claimId, status: 'accepted',
    detail: 'Native send call returned; recipient acknowledgement is still required' });
  assert.deepEqual(f.errors, []);
});

for (const [name, change] of Object.entries({
  busy: { session: { isRunning: true } }, archived: { session: { isArchived: true } },
  permission: { session: { pendingToolPermissions: [{}] } }, draft: { draft: true },
  remote: { session: { remoteTarget: {} } }, mismatchedIdentity: { registry: { cliSessionId: id } },
  changedActivity: { registry: { lastActivityAt: 99 } }, terminal: { busy: { busy: ['terminal'] } },
  escapedPath: { message: { registryPath: `/registry/../foreign/${localSessionId}.json` } },
  expired: { message: { expiresAt: 500 } },
})) test(`wake does not claim or send for ${name}`, async () => {
  const f = fixture(change); f.runtime.start(); await flush(); f.runtime.stop();
  assert.equal(f.claims.length, 0); assert.equal(f.sends.length, 0);
});

test('state change after claim consumes no input and records uncertainty', async () => {
  const f = fixture({ onClaim: session => { session.isRunning = true; } });
  f.runtime.start(); await flush(); f.runtime.stop();
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.receipts[0].status, 'uncertain');
});

test('unknown native send outcome is recorded and never sent again', async () => {
  const f = fixture({ sendError: true }); f.runtime.start(); await flush(); await f.runtime.poll(); f.runtime.stop();
  assert.equal(f.sends.length, 1); assert.equal(f.receipts[0].status, 'uncertain');
});

test('unknown claim outcome and previously consumed claim never send', async () => {
  for (const change of [{ claimError: true }, { claim: { claimed: false } }]) {
    const f = fixture(change); f.runtime.start(); await flush(); await f.runtime.poll(); f.runtime.stop();
    assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0);
  }
});

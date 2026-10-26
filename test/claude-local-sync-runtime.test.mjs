import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeLocalSyncRuntime } from '../crates/claudex-app/host/renderer/claude-local-sync-runtime.mjs';

const opId = '11111111-1111-4111-8111-111111111111';
const cliSessionId = '22222222-2222-4222-8222-222222222222';
const localSessionId = 'local_33333333-3333-4333-8333-333333333333';
const claimId = '44444444-4444-4444-8444-444444444444';
const inputUuid = '55555555-5555-4555-8555-555555555555';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(change = {}) {
  const entry = { opId, conversationId: opId, cliSessionId, localSessionId, inputUuid,
    cwd: '/project', title: 'Example', command: 'claudex-sync', args: opId, expiresAt: 2000,
    registryPath: `/registry/account/${localSessionId}.json`,
    images: [{ path: `/state/local-sync/${opId}/image-0.json`, mimeType: 'image/png' }], ...change.entry };
  const session = { sessionId: localSessionId, cwd: '/project', title: 'Example',
    lastActivityAt: 100, isArchived: false, isRunning: false, turnRunning: false, ...change.session };
  const registry = { ...session, cliSessionId, ...change.registry };
  let reads = 0, manifestReads = 0, claimed = false;
  const sends = [], claims = [], receipts = [], statuses = [], catalogues = [];
  const response = value => ({ structuredContent: value });
  const native = {
    readFileAtCwd: async (cwd, filename) => {
      if (filename === 'image-0.json') return { contents: JSON.stringify({ mimeType: 'image/png', base64: 'aW1hZ2U=', ...change.image }), ...change.imageRead };
      if (change.registryError) throw new Error('Private registry read failure');
      return { contents: JSON.stringify(registry) };
    },
    getSession: async () => change.getSession ? change.getSession({ ...session }, ++reads) : ({ ...session }),
    getBusyShellPtyKeys: async () => {
      if (change.busyError) throw new Error('Private shell read failure');
      return { probed: true, busy: [], unknown: [], ...change.busy };
    },
    getSupportedCommands: async options => {
      assert.deepEqual(options, { sessionId: localSessionId });
      catalogues.push({ claimed });
      if (change.commandError) throw new Error('Private command catalogue error');
      return (claimed ? change.commandsAfterClaim : change.commands) ?? [{ name: 'claudex-sync', description: 'Apply exact history' }];
    },
    mcpCallTool: async (target, server, name, args) => {
      assert.equal(target, localSessionId); assert.equal(server, 'claudex-desktop-wake');
      if (name === 'claudex_local_sync_claim') {
        claims.push(args); claimed = true; change.onClaim?.(session);
        if (change.claimError) throw new Error('Private claim failure');
        return response({ ready: true, claimId, ...entry, ...change.claim });
      }
      assert.equal(name, 'claudex_local_sync_receipt'); receipts.push(args); return response({ recorded: true });
    },
    sendMessage: async (...args) => { sends.push(args); if (change.sendError) throw new Error('Private native error'); },
  };
  const runtime = createClaudeLocalSyncRuntime({ native, root: '/state', registryRoot: '/registry',
    now: () => 1000, setTimer: () => 1, clearTimer() {}, hasDraft: () => change.draft ?? false,
    onStatus: status => statuses.push(status), readManifest: async () => ({ contents: JSON.stringify({ version: 1,
      entries: change.entries ? change.entries(entry, ++manifestReads, claimed) : [entry] }) }) });
  return { runtime, sends, claims, receipts, statuses, catalogues };
}
async function run(f) { f.runtime.start(); await flush(); await f.runtime.poll(); f.runtime.stop(); }

test('local sync sends only the exact registered command and ordered native images once', async () => {
  const f = fixture(); await run(f);
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0], [localSessionId, `/claudex-sync ${opId} ${claimId}`,
    [{ mimeType: 'image/png', base64: 'aW1hZ2U=' }], undefined, undefined, undefined, undefined, inputUuid]);
  assert.deepEqual(f.receipts[0], { opId, localSessionId, cliSessionId, cwd: '/project', claimId,
    outcome: 'submitted', detail: 'native-send-returned' });
  assert.ok(f.statuses.includes('submitted-awaiting-native-proof'));
});

test('text-only local sync passes no native image argument', async () => {
  const f = fixture({ entry: { images: [] } }); await run(f);
  assert.equal(f.sends[0][2], undefined);
});

test('a native warm boot marker requires live control initialization before and after claiming', async () => {
  const f = fixture({ session: { cliBootPending: true } }); await run(f);
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.catalogues, [{ claimed: false }, { claimed: false }, { claimed: true }]);
  assert.equal(f.receipts[0].outcome, 'submitted');
});

for (const [name, change] of Object.entries({
  missing: { commands: [] }, duplicate: { commands: [{ name: 'claudex-sync' }, { name: 'claudex-sync' }] },
  unavailable: { commandError: true }, backgroundWork: { session: { hasBackgroundWork: true } },
  malformedBootMarker: { session: { cliBootPending: 'true' } },
})) test(`native warm boot cannot bypass ${name}`, async () => {
  const f = fixture({ ...change, session: { cliBootPending: true, ...change.session } }); await run(f);
  assert.equal(f.claims.length, 0); assert.equal(f.sends.length, 0);
});

test('a live command revoked after a warm-boot claim never becomes model input', async () => {
  const f = fixture({ session: { cliBootPending: true }, commandsAfterClaim: [] }); await run(f);
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0);
  assert.equal(f.receipts[0].outcome, 'rejected');
  assert.ok(f.statuses.includes('native-command-missing'));
});

for (const [name, change] of Object.entries({
  archived: { session: { isArchived: true }, registry: { isArchived: false }, status: 'waiting-native-archive-state' },
  active: { session: { turnRunning: true }, status: 'waiting-native-turn-state' },
  unverifiedIdle: { session: { isRunning: undefined }, status: 'waiting-native-running-state' },
  invalidActivity: { session: { lastActivityAt: 'private activity' }, status: 'native-last-activity-unverified' },
  pendingCwd: { session: { pendingCwd: '/private/native/path' }, status: 'waiting-native-pendingCwd' },
  malformedLoops: { session: { loops: {} }, status: 'waiting-native-loops' },
  permissions: { session: { pendingToolPermissions: [{}] }, status: 'waiting-native-pendingToolPermissions' },
  draft: { draft: true, status: 'waiting-composer-draft' },
  terminal: { busy: { unknown: ['pty'] }, status: 'waiting-native-shells' },
  registryError: { registryError: true, status: 'waiting-registry-metadata' },
  shellError: { busyError: true, status: 'waiting-native-shell-metadata' },
  identity: { registry: { cliSessionId: opId }, status: 'registry-identity-mismatch' },
  sessionIdentity: { session: { sessionId: opId }, registry: { sessionId: localSessionId }, status: 'native-session-identity-mismatch' },
  missingSession: { getSession: () => null, status: 'native-session-missing' },
  missingCommand: { commands: [], status: 'native-command-missing' },
  unavailableCommands: { commands: {}, status: 'native-command-catalogue-unavailable' },
  ambiguousCommand: { commands: [{ name: 'claudex-sync' }, { name: 'claudex-sync' }], status: 'native-command-duplicate' },
  aliasOnly: { commands: [{ name: 'prompt', aliases: ['claudex-sync'] }], status: 'native-command-missing' },
  commandError: { commandError: true, status: 'waiting-native-command-catalogue' },
  activity: { registry: { lastActivityAt: 101 }, status: 'native-registry-activity-mismatch' },
  sessionError: { getSession: () => { throw new Error('Private session read failure'); }, status: 'waiting-native-session' },
  sessionRecheckError: { getSession: (session, count) => { if (count % 2 === 0) throw new Error('Private recheck failure'); return session; }, status: 'waiting-native-session-recheck' },
  sessionChanged: { getSession: (session, count) => ({ ...session, lastActivityAt: count % 2 === 0 ? 101 : 100 }), status: 'native-session-activity-changed' },
  expired: { entry: { expiresAt: 999 } },
  foreignCommand: { entry: { command: 'ordinary-prompt' } },
  escapedRegistry: { entry: { registryPath: `/registry/../foreign/${localSessionId}.json` } },
  escapedImage: { entry: { images: [{ path: `/state/local-sync/${opId}/../image-0.json`, mimeType: 'image/png' }] } },
  wrongImageType: { image: { mimeType: 'image/jpeg' } }, invalidBase64: { image: { base64: 'not base64' } },
  truncatedImage: { imageRead: { isTail: true } },
})) test(`local sync does not claim or send for ${name}`, async () => {
  const f = fixture(change); await run(f); assert.equal(f.claims.length, 0); assert.equal(f.sends.length, 0);
  if (change.status) assert.ok(f.statuses.includes(change.status), JSON.stringify(f.statuses));
  assert.doesNotMatch(JSON.stringify(f.statuses), /private|\/project|\/registry|11111111/i);
});

test('an unknown claim result is never requested again', async () => {
  const f = fixture({ claimError: true }); await run(f);
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.receipts.length, 0);
});

test('an unknown native send result records uncertainty without sending again', async () => {
  const f = fixture({ sendError: true }); await run(f);
  assert.equal(f.sends.length, 1); assert.equal(f.receipts[0].outcome, 'unknown');
  assert.equal(f.receipts[0].detail, 'native-send-unknown');
  assert.doesNotMatch(JSON.stringify(f.statuses), /private|error/i);
});

test('claim identity or image changes never authorize native input', async () => {
  for (const claim of [{ inputUuid: opId }, { images: [] }, { command: 'prompt' }, { cliSessionId: opId }]) {
    const f = fixture({ claim }); await run(f);
    assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0);
  }
});

test('native activity after claim records a proven pre-send refusal', async () => {
  const f = fixture({ onClaim: session => { session.turnRunning = true; } }); await run(f);
  assert.equal(f.sends.length, 0); assert.equal(f.receipts[0].outcome, 'rejected');
});

test('revoked manifest authority after claim cannot send', async () => {
  const f = fixture({ entries: (entry, _count, claimed) => claimed ? [] : [entry] }); await run(f);
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.receipts[0].outcome, 'rejected');
});

test('command registration revoked after claim cannot become model input', async () => {
  const f = fixture({ commandsAfterClaim: [] }); await run(f);
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0);
  assert.equal(f.receipts[0].outcome, 'rejected');
});

test('a failed native recheck after claim records no native send', async () => {
  const f = fixture({ getSession: (session, count) => { if (count === 5) throw new Error('Private read failure'); return session; } });
  await run(f); assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0);
  assert.equal(f.receipts[0].outcome, 'rejected'); assert.ok(f.statuses.includes('waiting-native-session'));
});

test('an unchanged blocked guard reports once without diagnostic retries or native claims', async () => {
  const f = fixture({ commands: [] });
  f.runtime.start(); await flush(); await f.runtime.poll(); await f.runtime.poll(); f.runtime.stop();
  assert.deepEqual(f.statuses, ['started', 'native-command-missing']);
  assert.equal(f.claims.length, 0); assert.equal(f.sends.length, 0);
});

test('stop during an awaited recheck cannot claim or send', async () => {
  const f = fixture({ getSession: (session, count) => { if (count === 2) f.runtime.stop(); return session; } });
  await run(f); assert.equal(f.claims.length, 0); assert.equal(f.sends.length, 0);
});

test('omitting an unknown claim on a manifest page does not reauthorize it', async () => {
  let visible = true;
  const f = fixture({ claimError: true, entries: entry => visible ? [entry] : [] });
  f.runtime.start(); await flush(); visible = false; await f.runtime.poll();
  visible = true; await f.runtime.poll(); f.runtime.stop();
  assert.equal(f.claims.length, 1); assert.equal(f.sends.length, 0);
});

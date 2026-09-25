import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';
import { encodeArchivedContextPacket } from '../src/context-archive.mjs';
import { encodeClaude, sessionPath } from '../src/claude.mjs';
import { hash, snapshot, writeJSON } from '../src/storage.mjs';

async function fixture(packetVersion = 2) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cldx-profile-')));
  const root = join(base, 'state'), codexHome = join(base, 'codex'), claudeHome = join(base, 'claude'), cwd = join(base, 'project');
  await Promise.all([codexHome, claudeHome, cwd].map(path => mkdir(path)));
  const conversationId = randomUUID(), nativeId = randomUUID(), path = sessionPath(claudeHome, cwd, nativeId), calls = [];
  const runtime = await new DesktopRuntime({ root, codexHome, claudeHome, contextMode: 'archive', ownerFactory: settings => {
    const call = { settings, connected: 0, closed: false }; calls.push(call);
    return { async start() {}, status: () => ({ sessionId: nativeId, transcriptPath: path, nativeState: 'idle',
      coldResetEligible: settings.deferRemoteConnection, closed: call.closed }),
    async inspectTranscript() { return snapshot(path); }, async connect() { call.connected++; }, async close() { call.closed = true; } };
  } }).initialize();
  const record = { side: 'claude', conversationId, nativeId, path, cwd, title: 'Synthetic profile', managed: true, verified: true, kind: 'owner', packetVersion };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] }];
  const encode = packetVersion === 2 ? encodeArchivedContextPacket : encodeContextPacket;
  const content = await encode({ root: runtime.root, messages, conversationId, targetSessionId: nativeId,
    operationId: 'initial', sourceSide: 'codex', key: runtime.key });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodeClaude({ meta: { id: nativeId, cwd, timestamp: '2026-09-25T00:00:00.000Z' }, messages: [{ role: 'user', content }] }, nativeId).text);
  const ownerState = join(runtime.root, 'owners', `${hash(conversationId)}.json`);
  await writeJSON(ownerState, { version: 1, sessionId: nativeId, remoteId: 'cse_synthetic' });
  return { runtime, record, calls, ownerState };
}

test('a verified archived current owner resumes directly with normal user settings', async () => {
  const f = await fixture();
  try {
    await f.runtime.inspect(f.record);
    assert.equal(f.calls[0].settings.deferRemoteConnection, false);
    await f.runtime.needsMaintenance(f.record);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].closed, false);
    assert.equal(f.calls[0].connected, 1);
  } finally { await f.runtime.close(); }
});

test('an inline owner remains private until a verified migration is promoted', async () => {
  const f = await fixture(1);
  try {
    await f.runtime.inspect(f.record);
    assert.equal(f.calls[0].settings.deferRemoteConnection, true);
    assert.equal(f.calls[0].settings.connectAfterReset, false);
    assert.equal(await f.runtime.needsMaintenance(f.record), true);
    assert.equal(f.calls[0].connected, 0);
  } finally { await f.runtime.close(); }
});

test('promoted recovery starts the normal owner even when the runtime has no cached handle', async () => {
  const f = await fixture();
  try {
    await f.runtime.completePromotion(f.record);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].settings.deferRemoteConnection, false);
    assert.equal(f.calls[0].connected, 1);
  } finally { await f.runtime.close(); }
});

test('a pending reset cannot be launched under normal settings even with a stale promoted record', async () => {
  const f = await fixture();
  try {
    await writeJSON(f.ownerState, { version: 1, sessionId: f.record.nativeId, remoteId: 'cse_synthetic', reset: { phase: 'restoring' } });
    await assert.rejects(f.runtime.inspect(f.record), /pending native context reset/);
    assert.equal(f.calls.length, 0);
  } finally { await f.runtime.close(); }
});

test('native-only Desktop startup never becomes an available synchronization backend', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.runtime.root, 'codex-shared'), { mode: 0o700 });
    await writeJSON(join(f.runtime.root, 'codex-shared', 'owner.json'), { version: 1,
      pid: process.pid, childPid: process.pid, transportMode: 'native', cliVersion: 'codex-cli 99.0.0', socketPath: null });
    await assert.rejects(f.runtime.codex(), /native-only mode.*awaits version validation/);
    assert.equal(f.runtime.client, undefined);
  } finally { await f.runtime.close(); }
});

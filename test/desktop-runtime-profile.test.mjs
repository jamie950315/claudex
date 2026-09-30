import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';
import { encodeArchivedContextPacket, inspectArchivedContextPacket } from '../src/context-archive.mjs';
import { fingerprint } from '../src/history.mjs';
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
    assert.equal(f.calls[0].settings.title, 'Synthetic profile');
    assert.equal(f.calls[0].settings.newSessionTitle, 'Synthetic profile');
    assert.equal(f.record.title, 'Synthetic profile');
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

test('concurrent Codex readers share one fully initialized transport', async () => {
  const f = await fixture();
  const factoryGate = Promise.withResolvers(), initializeGate = Promise.withResolvers(), started = Promise.withResolvers();
  let factories = 0, initializations = 0, early = false;
  const client = {
    async initialize() { initializations++; started.resolve(); await initializeGate.promise; return {}; },
    async close() {},
  };
  f.runtime.clientFactory = async () => { factories++; await factoryGate.promise; return client; };
  const first = f.runtime.codex(), second = f.runtime.codex();
  try {
    assert.equal(factories, 1);
    factoryGate.resolve();
    await started.promise;
    const third = f.runtime.codex().then(value => { early = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(early, false);
    initializeGate.resolve();
    assert.deepEqual(await Promise.all([first, second, third]), [client, client, client]);
    assert.equal(initializations, 1);
  } finally {
    factoryGate.resolve(); initializeGate.resolve();
    await Promise.allSettled([first, second]);
    await f.runtime.close();
  }
});

test('shared Codex initialization failure reaches every reader before a later explicit connection', async () => {
  const f = await fixture();
  const gate = Promise.withResolvers(), failure = new Error('Synthetic initialization failed');
  let factories = 0, closes = 0;
  const client = { async initialize() { await gate.promise; throw failure; }, async close() { closes++; } };
  f.runtime.clientFactory = async () => { factories++; return client; };
  const reads = [f.runtime.codex(), f.runtime.codex()];
  const settled = Promise.allSettled(reads);
  try {
    gate.resolve();
    for (const result of await settled) { assert.equal(result.status, 'rejected'); assert.equal(result.reason, failure); }
    assert.equal(factories, 1); assert.equal(closes, 1); assert.equal(f.runtime.client, null);
    const next = { async initialize() { return {}; }, async close() {} };
    f.runtime.clientFactory = async () => { factories++; return next; };
    assert.equal(await f.runtime.codex(), next);
    assert.equal(factories, 2);
  } finally { gate.resolve(); await settled; await f.runtime.close(); }
});

test('a transient title-proof read does not poison or replace the healthy native owner', async () => {
  const f = await fixture();
  let started = 0, checked = 0;
  f.runtime.ownerFactory = () => ({
    async start() { started++; }, status: () => ({ closed: false }), async close() {},
    async reconcileDisplayTitle() { if (++checked === 1) throw new Error('Transcript changed while being read.'); },
  });
  try {
    await assert.rejects(f.runtime.owner(f.record.conversationId, f.record.cwd, f.record.title), /changed while/);
    await f.runtime.owner(f.record.conversationId, f.record.cwd, f.record.title);
    assert.equal(started, 1); assert.equal(checked, 2);
  } finally { await f.runtime.close(); }
});

test('legacy text-only image owners refresh a full checkpoint while old pending packets remain byte-compatible', async () => {
  const f = await fixture();
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } };
  const common = { meta: { cwd: f.record.cwd }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Image question' }, image] },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
  ] };
  try {
    await f.runtime.inspect(f.record);
    assert.equal(await f.runtime.needsMaintenance(f.record, { common }), 'images');
    assert.equal(await f.runtime.needsMaintenance({ ...f.record, imageProjectionVersion: 1 }, { common }), false);
    assert.equal(await f.runtime.needsMaintenance({ ...f.record, side: 'codex', kind: 'snapshot' }, { common }), 'images');
    const planned = await f.runtime.plan('claude', { conversationId: f.record.conversationId, common,
      title: f.record.title, target: f.record });
    assert.equal(planned.nativeId, f.record.nativeId);
    assert.equal(planned.contextRefresh, true); assert.equal(planned.imageProjectionVersion, 1);
    const record = { ...f.record, ...planned };
    const packet = await f.runtime.packet(record, common, { operationId: 'visual-refresh',
      previous: { count: 2, digest: fingerprint(common) } });
    assert.equal(packet.filter(block => block.type === 'image').length, 1);
    const metadata = inspectArchivedContextPacket({ content: packet, key: f.runtime.key,
      conversationId: record.conversationId, targetSessionId: record.nativeId });
    assert.equal(metadata.historyPrefixCount, 2);
    const legacy = await f.runtime.packet({ ...record, contextRefresh: undefined, imageProjectionVersion: undefined },
      common, { operationId: 'old-prepared-operation', previous: { count: 0, digest: null } });
    assert.equal(legacy.length, 3); assert.ok(legacy.every(block => block.type === 'text'));
  } finally { await f.runtime.close(); }
});

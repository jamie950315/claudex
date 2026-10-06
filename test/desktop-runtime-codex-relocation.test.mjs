import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { hash } from '../src/storage.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-codex-move-')));
  const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude'), desktopHome = join(root, 'desktop');
  for (const path of [codexHome, claudeHome, desktopHome]) await mkdir(path);
  const started = [];
  const runtime = await new DesktopRuntime({ root: join(root, 'state'), codexHome, claudeHome, desktopHome,
    ownerFactory(settings) {
      const sessionId = randomUUID();
      started.push({ ...settings, sessionId });
      return { async start() {}, async close() {}, async reconcileDisplayTitle() {},
        status: () => ({ sessionId, transcriptPath: join(claudeHome, `${sessionId}.jsonl`), nativeState: 'idle' }) };
    },
    clientFactory() { throw new Error('Tests supply the Codex client.'); },
  }).initialize();
  const oldCwd = join(root, 'SafAI'), newCwd = join(root, 'Margina');
  await mkdir(oldCwd);
  const nativeId = randomUUID();
  let threadCwd = oldCwd;
  runtime.codex = async () => ({ async request(method, params) {
    assert.equal(method, 'thread/read');
    return { thread: { id: params.threadId, cwd: threadCwd, path: join(codexHome, 'rollout.jsonl') } };
  } });
  runtime.inspectNative = async record => ({ nativeId: record.nativeId, path: join(codexHome, 'rollout.jsonl'), bytes: 10,
    incompleteTail: false, common: { meta: { cwd: await realpath(threadCwd) }, messages: [] } });
  const record = { id: randomUUID(), conversationId: randomUUID(), side: 'codex', kind: 'original', managed: false,
    status: 'current', verified: true, nativeId, cwd: oldCwd, path: join(codexHome, 'rollout.jsonl') };
  return { root, runtime, record, oldCwd, newCwd, started, setThreadCwd: value => { threadCwd = value; } };
}

test('only a proven Codex project move produces relocation evidence', async () => {
  const f = await fixture();
  try {
    // An unmoved directory never contacts the Codex backend.
    const codex = f.runtime.codex;
    f.runtime.codex = async () => { throw new Error('Codex backend must not be needed.'); };
    assert.equal(await f.runtime.reconcileCodexRelocation(f.record), null);
    // Global checks never ask Codex about a saved directory that still exists.
    await mkdir(f.newCwd); f.setThreadCwd(f.newCwd);
    assert.equal(await f.runtime.reconcileCodexRelocation(f.record), null);
    f.runtime.codex = codex;
    // The conversation's own sync does: Codex moved the thread while the old
    // directory stayed, as after a move into a worktree.
    const moved = await f.runtime.reconcileCodexRelocation(f.record, { thorough: true });
    assert.equal(moved.record.cwd, f.newCwd);
    assert.equal(moved.record.relocation.previousCwdState, 'independent');
    assert.equal(moved.relocationProof.previousCwdState, 'independent');
    f.setThreadCwd(f.oldCwd);
    assert.equal(await f.runtime.reconcileCodexRelocation(f.record, { thorough: true }), null);
    f.setThreadCwd(f.newCwd);
    // An alias that leads somewhere else is not this move either.
    const elsewhere = join(f.root, 'elsewhere'); await mkdir(elsewhere);
    const aliasRecord = { ...f.record, cwd: join(f.root, 'alias') };
    await symlink(elsewhere, aliasRecord.cwd);
    assert.equal(await f.runtime.reconcileCodexRelocation(aliasRecord), null);
    // Renamed with an alias left behind: the old path resolves to the new one.
    await rename(f.newCwd, `${f.newCwd}-unused`);
    await rename(f.oldCwd, f.newCwd); await symlink(f.newCwd, f.oldCwd);
    const proof = await f.runtime.reconcileCodexRelocation(f.record);
    assert.equal(proof.record.cwd, f.newCwd);
    assert.deepEqual(proof.record.relocation, { version: 1, kind: 'codex-project-move', originCwd: f.oldCwd,
      previousCwd: f.oldCwd, previousPath: f.record.path, previousCwdState: 'alias' });
    assert.equal(proof.relocationProof.previousCwdState, 'alias');
    assert.equal(f.record.cwd, f.oldCwd);
    for (const changed of [{ managed: true }, { kind: 'snapshot' }, { status: 'original' }, { verified: false }])
      assert.equal(await f.runtime.reconcileCodexRelocation({ ...f.record, ...changed }), null);
  } finally { await f.runtime.close(); }
});

test('a removed saved directory is a move only when Codex reports an existing new one', async () => {
  const f = await fixture();
  try {
    await rename(f.oldCwd, f.newCwd); f.setThreadCwd(f.newCwd);
    assert.equal((await f.runtime.reconcileCodexRelocation(f.record)).record.relocation.previousCwdState, 'absent');
    f.setThreadCwd(join(f.root, 'missing'));
    assert.equal(await f.runtime.reconcileCodexRelocation(f.record), null);
  } finally { await f.runtime.close(); }
});

test('retiring an owner preserves its state, never restarts it and starts a new owner in the new project', async () => {
  const f = await fixture();
  try {
    const conversationId = randomUUID(), sessionId = randomUUID();
    const owners = join(f.root, 'state', 'owners');
    await mkdir(owners, { recursive: true, mode: 0o700 });
    const state = { version: 1, conversationId, cwd: f.oldCwd, sessionId, remoteId: 'cse_old', registration: 'registered', pending: null };
    const statePath = join(owners, `${hash(conversationId)}.json`);
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    const target = { id: randomUUID(), conversationId, side: 'claude', kind: 'owner', managed: true, verified: true,
      status: 'current', nativeId: sessionId, cwd: f.oldCwd, path: join(f.root, 'claude', `${sessionId}.jsonl`) };
    await assert.rejects(f.runtime.retireOwner({ ...target, cwd: f.newCwd }), /does not match/);
    await writeFile(`${statePath}.lock`, 'held', { mode: 0o600 });
    await assert.rejects(f.runtime.retireOwner(target), /still locked/);
    await rename(`${statePath}.lock`, join(f.root, 'released.lock'));
    const plan = await f.runtime.plan('claude', { conversationId, common: { meta: { cwd: f.newCwd }, messages: [] },
      title: 'Moved', target, relocation: true });
    assert.equal(plan.kind, 'owner');
    assert.notEqual(plan.nativeId, sessionId);
    assert.deepEqual(f.started.map(item => item.cwd), [f.newCwd]);
    assert.deepEqual(await readdir(join(owners, 'retired')), [`${hash(conversationId)}-${sessionId}.json`]);
    assert.deepEqual(JSON.parse(await readFile(join(owners, 'retired', `${hash(conversationId)}-${sessionId}.json`), 'utf8')), state);
    assert.ok((await f.runtime.ownedNativeIds()).has(`claude:${sessionId}`));
    // An interrupted move recognizes the retirement and never restarts the old owner.
    f.runtime.owners.clear();
    assert.equal(await f.runtime.ownerRetired(target), true);
    await f.runtime.retireOwner(target);
    await f.runtime.assertIdle(target);
    assert.equal(await f.runtime.needsMaintenance(target, {}), false);
    assert.equal(f.started.length, 1);
    // The replacement can already own the per-conversation state path.
    await writeFile(statePath, JSON.stringify({ ...state, sessionId: plan.nativeId, cwd: f.newCwd }), { mode: 0o600 });
    assert.equal(await f.runtime.ownerRetired(target), true);
    await f.runtime.retireOwner(target);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).sessionId, plan.nativeId);
    assert.equal(await f.runtime.ownerRetired({ ...target, nativeId: plan.nativeId }), false);
  } finally { await f.runtime.close(); }
});

test('a Claude history recorded in a renamed project keeps its saved directory instead of the alias target', async () => {
  const f = await fixture();
  try {
    const { encodeClaude, sessionPath } = await import('../src/claude.mjs');
    const claudeHome = join(f.root, 'claude'), nativeId = randomUUID();
    const rows = encodeClaude({ meta: { id: nativeId, cwd: f.oldCwd, timestamp: '2026-09-28T00:00:00.000Z' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] }] }, nativeId).rows;
    const path = sessionPath(claudeHome, f.oldCwd, nativeId);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
    const record = { id: randomUUID(), conversationId: randomUUID(), side: 'claude', kind: 'original', managed: false,
      status: 'current', verified: true, nativeId, cwd: f.oldCwd, path };
    await rename(f.oldCwd, f.newCwd); await symlink(f.newCwd, f.oldCwd);
    const inspected = await DesktopRuntime.prototype.inspectNative.call(f.runtime, record);
    assert.equal(inspected.common.meta.cwd, f.oldCwd);
    // A different recorded directory is still canonicalized and reported.
    const moved = await DesktopRuntime.prototype.inspectNative.call(f.runtime, { ...record, cwd: join(f.root, 'other') });
    assert.equal(moved.common.meta.cwd, f.newCwd);
  } finally { await f.runtime.close(); }
});

test('an owner whose saved directory became an alias is held and read from disk without starting', async () => {
  const f = await fixture();
  try {
    const conversationId = randomUUID(), sessionId = randomUUID();
    const owners = join(f.root, 'state', 'owners');
    await mkdir(owners, { recursive: true, mode: 0o700 });
    const statePath = join(owners, `${hash(conversationId)}.json`);
    await writeFile(statePath, JSON.stringify({ version: 1, conversationId, cwd: f.oldCwd, sessionId, pending: null }), { mode: 0o600 });
    const target = { id: randomUUID(), conversationId, side: 'claude', kind: 'owner', managed: true, verified: true,
      status: 'current', nativeId: sessionId, cwd: f.oldCwd, path: join(f.root, 'claude', `${sessionId}.jsonl`) };
    assert.equal(await f.runtime.ownerStranded(target), false);
    await rename(f.oldCwd, f.newCwd); await symlink(f.newCwd, f.oldCwd);
    assert.equal(await f.runtime.ownerStranded(target), true);
    await assert.rejects(f.runtime.owner(conversationId, f.oldCwd, 'Moved'), error => {
      assert.equal(error.code, 'CLAUDEX_TRACKED_CWD_UNAVAILABLE');
      assert.equal(error.conversationId, conversationId); assert.equal(error.savedCwd, f.oldCwd);
      return true;
    });
    const read = [];
    f.runtime.inspectRetiredOwner = async record => { read.push(record.nativeId); return { nativeId: record.nativeId }; };
    assert.equal((await DesktopRuntime.prototype.inspectNative.call(f.runtime, target)).nativeId, sessionId);
    assert.deepEqual(read, [sessionId]);
    await f.runtime.assertIdle(target);
    assert.equal(await f.runtime.needsMaintenance(target, {}), false);
    await writeFile(`${statePath}.lock`, 'held', { mode: 0o600 });
    await assert.rejects(f.runtime.assertIdle(target), /still locked/);
    await rename(`${statePath}.lock`, join(f.root, 'released.lock'));
    await f.runtime.plan('claude', { conversationId, common: { meta: { cwd: f.newCwd }, messages: [] },
      title: 'Moved', target, relocation: true });
    assert.deepEqual(f.started.map(item => item.cwd), [f.newCwd]);
    assert.ok((await readdir(join(owners, 'retired'))).includes(`${hash(conversationId)}-${sessionId}.json`));
  } finally { await f.runtime.close(); }
});

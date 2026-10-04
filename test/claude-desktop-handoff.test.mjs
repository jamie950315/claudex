import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeDesktopHandoffPublisher } from '../src/claude-desktop-handoff.mjs';
import { readDesktopSessionMappings } from '../src/desktop.mjs';
import { sessionPath } from '../src/claude.mjs';
import { hash } from '../src/storage.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-local-handoff-')));
  const cwd = join(root, 'project'), desktopHome = join(root, 'desktop'), claudeHome = join(root, 'claude');
  for (const path of [cwd, desktopHome, claudeHome, join(root, 'owners')]) await mkdir(path, { mode: 0o700 });
  const state = { version: 2, pending: null, conversations: {}, records: [] };
  const inspections = [], results = new Map();
  let time = 100_000, interceptor;
  const inspect = async record => {
    inspections.push(record.nativeId);
    if (interceptor) await interceptor(record);
    return structuredClone(results.get(record.nativeId));
  };
  const factory = () => createClaudeDesktopHandoffPublisher({ root, desktopHome, inspect, now: () => time });
  const publisher = factory();
  return { root, cwd, desktopHome, claudeHome, state, results, inspections, factory,
    clock(value) { time = value; }, intercept(value) { interceptor = value; }, publish: options => publisher.publish(state, options),
    manifest: async () => JSON.parse(await readFile(join(root, 'desktop-handoff.json'), 'utf8')),
    async add() {
      const conversationId = randomUUID(), originalId = randomUUID(), currentId = randomUUID(), uiId = `local_${randomUUID()}`;
      const title = 'Ordinary conversation', originalCheckpoint = { count: 2, digest: 'a'.repeat(64) }, canonical = { count: 4, digest: 'b'.repeat(64) };
      const original = { id: randomUUID(), conversationId, nativeId: originalId, side: 'claude', managed: false,
        verified: true, kind: 'original', status: 'original', cwd, path: sessionPath(claudeHome, cwd, originalId), checkpoint: originalCheckpoint };
      const current = { id: randomUUID(), conversationId, nativeId: currentId, side: 'claude', managed: true,
        verified: true, kind: 'owner', status: 'current', cwd, path: sessionPath(claudeHome, cwd, currentId), checkpoint: canonical };
      await mkdir(dirname(original.path), { recursive: true, mode: 0o700 });
      await writeFile(original.path, 'original native bytes\n', { mode: 0o600 });
      await writeFile(current.path, 'replacement native bytes\n', { mode: 0o600 });
      state.conversations[conversationId] = { id: conversationId, cwd, title, canonical };
      state.records.push(original, current);
      for (const record of [original, current]) results.set(record.nativeId, { nativeId: record.nativeId, path: record.path,
        incompleteTail: false, digest: record.checkpoint.digest,
        common: { meta: { cwd }, messages: Array.from({ length: record.checkpoint.count }, () => ({ role: 'assistant', content: [] })) } });
      const mapping = { sessionId: uiId, cliSessionId: originalId, cwd, title, lastActivityAt: 99_000, isArchived: false };
      const registryPath = join(desktopHome, `${uiId}.json`);
      await writeFile(registryPath, JSON.stringify(mapping), { mode: 0o600 });
      const owner = { version: 1, conversationId, cwd, claudeHome, sessionId: currentId, remoteId: `cse_${randomUUID().replaceAll('-', '')}`,
        registration: 'registered', pending: null, reset: null };
      const ownerPath = join(root, 'owners', `${hash(conversationId)}.json`);
      await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
      return { conversationId, original, current, owner, ownerPath, mapping, registryPath,
        saveOwner: () => writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 }),
        saveMapping: () => writeFile(registryPath, JSON.stringify(mapping), { mode: 0o600 }) };
    },
  };
}

test('a promoted exact Remote Control replacement yields a private expiring intent, never a registry write', async () => {
  const f = await fixture(), pair = await f.add(), before = structuredClone(f.state);
  const registryBefore = await readFile(pair.registryPath), originalBefore = await readFile(pair.original.path);
  const status = await f.publish(), manifest = await f.manifest();
  assert.equal(status.actions, 1); assert.equal(status.anchors, 1);
  assert.equal(manifest.expiresAt - manifest.generatedAt, 15_000);
  const action = manifest.actions[0];
  assert.equal(action.localSessionId, pair.mapping.sessionId);
  assert.notEqual(action.nativeId, action.localSessionId.slice(6));
  assert.equal(action.nativeId, pair.original.nativeId); assert.equal(action.remoteId, pair.owner.remoteId);
  assert.equal(action.title, 'Ordinary conversation'); assert.equal(action.expectedLastActivityAt, 99_000);
  assert.deepEqual(action.originalProof.checkpoint, pair.original.checkpoint);
  assert.equal(action.originalProof.sha256, createHash('sha256').update(originalBefore).digest('hex'));
  assert.deepEqual(action.replacement.checkpoint, f.state.conversations[pair.conversationId].canonical);
  assert.deepEqual(manifest.anchors[0], { conversationId: pair.conversationId, localSessionId: pair.mapping.sessionId,
    nativeId: pair.original.nativeId, replacementNativeId: pair.current.nativeId,
    remoteId: pair.owner.remoteId, cwd: f.cwd, title: pair.mapping.title });
  assert.equal((await lstat(join(f.root, 'desktop-handoff.json'))).mode & 0o7777, 0o600);
  assert.deepEqual(f.state, before);
  assert.deepEqual(await readFile(pair.registryPath), registryBefore);
  assert.deepEqual(await readFile(pair.original.path), originalBefore);
});

test('stable observations reuse proof for enqueue only and full verification is due after 60 seconds', async () => {
  const f = await fixture(); await f.add();
  await f.publish(); const first = (await f.manifest()).actions[0];
  f.clock(110_000); await f.publish(); assert.equal(f.inspections.length, 2);
  assert.deepEqual((await f.manifest()).actions[0], first);
  f.clock(159_999); await f.publish(); assert.equal(f.inspections.length, 2);
  f.clock(160_000); await f.publish(); assert.equal(f.inspections.length, 4);
});

test('stopped enrollments revoke cached actions and anchors without inspecting native histories', async () => {
  const f = await fixture(), pair = await f.add();
  await f.publish(); assert.equal((await f.manifest()).actions.length, 1);
  f.state.conversations[pair.conversationId].tracking = { status: 'stopped', stoppedAt: 1 };
  f.intercept(() => { throw new Error('Stopped native histories must not be read'); });
  f.inspections.length = 0;
  const status = await f.publish();
  assert.equal(status.actions, 0); assert.equal(status.anchors, 0);
  assert.deepEqual(f.inspections, []);
  assert.deepEqual((await f.manifest()).actions, []); assert.deepEqual((await f.manifest()).anchors, []);
});

test('event-scoped publication inspects only the selected conversation while preserving global anchors', async () => {
  const f = await fixture(), first = await f.add(), second = await f.add();
  await f.publish(); await f.publish();
  const anchors = (await f.manifest()).anchors;
  assert.equal(anchors.length, 2);
  f.clock(200_000); f.inspections.length = 0;
  await f.publish({ conversationIds: [second.conversationId] });
  assert.deepEqual(f.inspections, [second.original.nativeId, second.current.nativeId]);
  assert.deepEqual((await f.manifest()).actions.map(action => action.conversationId), [second.conversationId]);
  assert.deepEqual((await f.manifest()).anchors, anchors);
  f.inspections.length = 0;
  await f.publish({ conversationIds: new Set([first.conversationId]) });
  assert.deepEqual(f.inspections, [first.original.nativeId, first.current.nativeId]);
});

test('empty or absent conversation selection revokes actions without reading any transcript', async () => {
  const f = await fixture(), pair = await f.add(); await f.publish();
  const anchors = (await f.manifest()).anchors;
  await rename(pair.original.path, `${pair.original.path}.not-readable`);
  await rename(pair.current.path, `${pair.current.path}.not-readable`);
  f.clock(200_000); f.inspections.length = 0;
  for (const conversationIds of [[], [randomUUID()]]) {
    const status = await f.publish({ conversationIds });
    assert.equal(status.actions, 0);
    assert.deepEqual(f.inspections, []);
    assert.deepEqual((await f.manifest()).anchors, anchors);
    assert.deepEqual((await f.manifest()).actions, []);
    assert.equal((await f.manifest()).expiresAt, null);
  }
});

test('event scopes retain cached evidence but never revive expired or revoked actions without full verification', async () => {
  const f = await fixture(), pair = await f.add();
  await f.publish({ conversationIds: [pair.conversationId] });
  const first = (await f.manifest()).actions[0].operationId;
  f.clock(115_000); f.inspections.length = 0;
  await f.publish({ conversationIds: [pair.conversationId] });
  assert.equal(f.inspections.length, 2);
  assert.notEqual((await f.manifest()).actions[0].operationId, first);
  await f.publish({ conversationIds: [] });
  f.inspections.length = 0;
  await f.publish({ conversationIds: [pair.conversationId] });
  assert.equal(f.inspections.length, 2);
});

test('unselected owner transitions and invalid ledger identities retain global revocation guards', async () => {
  const f = await fixture(), first = await f.add(), second = await f.add();
  await f.publish({ conversationIds: [first.conversationId] });
  second.owner.pending = { operationId: randomUUID() }; await second.saveOwner();
  f.inspections.length = 0;
  assert.equal((await f.publish({ conversationIds: [first.conversationId] })).deferred, 'owner_transition');
  assert.deepEqual(f.inspections, []);
  assert.deepEqual((await f.manifest()).actions, []);
  second.current.cwd = '/different';
  await assert.rejects(f.publish({ conversationIds: [] }), /ledger identity/);
  assert.deepEqual((await f.manifest()).actions, []);
});

test('pending coordinator work revokes commands but retains exact presentation identities without reading transcripts', async () => {
  const f = await fixture(), pair = await f.add(); await f.publish();
  const anchors = (await f.manifest()).anchors;
  await rename(pair.original.path, `${pair.original.path}.not-readable`);
  await rename(pair.current.path, `${pair.current.path}.not-readable`);
  f.state.pending = { phase: 'prepared' };
  assert.equal((await f.publish()).deferred, 'pending');
  const manifest = await f.manifest();
  assert.deepEqual(manifest.actions, []); assert.deepEqual(manifest.anchors, anchors);
  assert.equal(manifest.expiresAt, null); assert.equal(manifest.generatedAt, null);
  assert.equal(manifest.anchorsUpdatedAt, 100_000);
  assert.equal(f.inspections.length, 2);
});

test('owner append, reset and title migration transitions revoke all actions but retain exact presentation identities', async () => {
  for (const field of ['pending', 'reset', 'displayTitleMigration']) {
    const f = await fixture(), pair = await f.add(); await f.publish();
    await f.add(); await f.publish();
    const anchors = (await f.manifest()).anchors;
    pair.owner[field] = { operationId: randomUUID() }; await pair.saveOwner();
    assert.equal((await f.publish()).actions, 0);
    assert.deepEqual((await f.manifest()).anchors, anchors);
    assert.equal(f.inspections.length, 4);
  }
});

test('a restarted publisher retains expired presentation evidence during new work without promoting it to archive authority', async () => {
  const f = await fixture(), pair = await f.add(); await f.publish();
  const anchors = (await f.manifest()).anchors;
  f.clock(1_000_000); f.state.pending = { phase: 'applied' };
  pair.owner.pending = { operationId: randomUUID() }; await pair.saveOwner();
  const status = await f.factory().publish(f.state), manifest = await f.manifest();
  assert.equal(status.actions, 0); assert.equal(status.anchors, 1);
  assert.deepEqual(manifest.anchors, anchors); assert.deepEqual(manifest.actions, []);
  assert.equal(manifest.expiresAt, null); assert.equal(manifest.anchorsUpdatedAt, 1_000_000);
  assert.equal(f.inspections.length, 2);
});

test('pending work retains only anchors whose source, replacement, Remote Control and cwd identities still agree', async () => {
  for (const change of ['remote', 'replacement', 'cwd', 'source_ui', 'source_native', 'owner_missing']) {
    const f = await fixture(), pair = await f.add(); await f.publish();
    const retained = await f.add(); await f.publish();
    f.state.pending = { phase: 'prepared' };
    if (change === 'remote') { pair.owner.remoteId = 'cse_different'; await pair.saveOwner(); }
    if (change === 'replacement') {
      pair.current.nativeId = randomUUID(); pair.owner.sessionId = pair.current.nativeId; await pair.saveOwner();
    }
    if (change === 'cwd') f.state.conversations[pair.conversationId].cwd = '/different';
    if (change === 'source_ui') {
      await rename(pair.registryPath, `${pair.registryPath}.preserved`);
      pair.mapping.sessionId = `local_${randomUUID()}`;
      await writeFile(join(f.desktopHome, `${pair.mapping.sessionId}.json`), JSON.stringify(pair.mapping), { mode: 0o600 });
    }
    if (change === 'source_native') { pair.mapping.cliSessionId = randomUUID(); await pair.saveMapping(); }
    if (change === 'owner_missing') await rename(pair.ownerPath, `${pair.ownerPath}.preserved`);
    await f.factory().publish(f.state);
    const manifest = await f.manifest();
    assert.deepEqual(manifest.actions, []);
    assert.deepEqual(manifest.anchors.map(anchor => anchor.conversationId), [retained.conversationId]);
    assert.equal(f.inspections.length, 4);
  }
});

test('changed history revokes all prior commands before a slow inspection but keeps presentation evidence', async () => {
  const f = await fixture(), pair = await f.add(); await f.publish();
  const anchors = (await f.manifest()).anchors;
  await appendFile(pair.current.path, 'new native control metadata\n');
  f.intercept(async () => {
    const manifest = await f.manifest();
    assert.deepEqual(manifest.actions, []); assert.deepEqual(manifest.anchors, anchors);
    assert.equal(manifest.expiresAt, null);
  });
  await f.publish();
  assert.equal((await f.manifest()).actions.length, 1);
});

test('a new incomplete or changed original/replacement revokes the intent and fails explicitly', async () => {
  for (const side of ['original', 'current']) for (const change of ['digest', 'count', 'cwd', 'tail', 'nativeId']) {
    const f = await fixture(), pair = await f.add(); await f.publish();
    const record = pair[side], result = f.results.get(record.nativeId);
    await appendFile(record.path, 'new bytes\n');
    if (change === 'digest') result.digest = 'c'.repeat(64);
    if (change === 'count') result.common.messages.push({});
    if (change === 'cwd') result.common.meta.cwd = '/different';
    if (change === 'tail') result.incompleteTail = true;
    if (change === 'nativeId') result.nativeId = randomUUID();
    await assert.rejects(f.publish(), /complete saved checkpoint/);
    assert.deepEqual((await f.manifest()).actions, []);
  }
});

test('activity, title, registration and file changes during verification cannot publish a command', async () => {
  for (const change of ['activity', 'title', 'registry-rewrite', 'owner', 'original', 'pending']) {
    const f = await fixture(), pair = await f.add();
    f.intercept(async record => {
      if (record.nativeId !== pair.current.nativeId) return;
      if (change === 'activity' || change === 'title') {
        if (change === 'activity') pair.mapping.lastActivityAt++;
        else pair.mapping.title = 'Changed title';
        await pair.saveMapping();
      } else if (change === 'registry-rewrite') {
        const before = await lstat(pair.registryPath, { bigint: true });
        await pair.saveMapping();
        const after = await lstat(pair.registryPath, { bigint: true });
        assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
        assert.ok(after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs);
      } else if (change === 'owner') { pair.owner.pending = {}; await pair.saveOwner(); }
      else if (change === 'original') await appendFile(pair.original.path, 'changed\n');
      else f.state.pending = {};
    });
    if (change === 'original') {
      const result = await f.publish();
      assert.equal(result.deferred, 'history_changed');
      assert.equal(result.actions, 0);
      assert.equal(result.conversationId, pair.conversationId);
      assert.equal(result.title, pair.mapping.title);
    } else await assert.rejects(f.publish(), /changed/);
    assert.deepEqual((await f.manifest()).actions, []);
  }
});

test('an owner without verified idle state defers archival, revokes authority and requires fresh verification', async () => {
  const f = await fixture(), pair = await f.add();
  await f.publish();
  await appendFile(pair.current.path, 'native metadata\n');
  f.intercept(async record => { if (record.nativeId === pair.current.nativeId)
    throw Object.assign(new Error('Owner is not idle'), { code: 'CLAUDEX_HANDOFF_OWNER_NOT_IDLE', conversationId: pair.conversationId }); });
  assert.equal((await f.publish()).deferred, 'owner_not_idle');
  assert.deepEqual((await f.manifest()).actions, []);
  f.intercept(async () => {});
  assert.equal((await f.publish()).deferred, null);
  assert.equal((await f.manifest()).actions.length, 1);
});

test('a history race revokes authority and requires another full verification before archival', async () => {
  const f = await fixture(), pair = await f.add();
  await f.publish();
  await appendFile(pair.current.path, 'native metadata\n');
  f.intercept(async record => { if (record.nativeId === pair.current.nativeId) await appendFile(pair.current.path, 'more metadata\n'); });
  assert.equal((await f.publish()).deferred, 'history_changed');
  assert.deepEqual((await f.manifest()).actions, []);
  f.intercept(async () => { throw new Error('Actual canonical history conflict'); });
  await assert.rejects(f.publish(), /Actual canonical history conflict/);
  assert.deepEqual((await f.manifest()).actions, []);
  f.intercept(async () => {});
  assert.equal((await f.publish()).actions, 1);
});

test('archival is acknowledged only after another full verification and exact old byte-prefix preservation', async () => {
  const f = await fixture(), pair = await f.add(); await f.publish();
  pair.mapping.isArchived = true; await pair.saveMapping();
  await appendFile(pair.original.path, 'native archive metadata\n');
  const status = await f.publish();
  assert.equal(status.actions, 0); assert.equal(status.anchors, 1);
  assert.deepEqual(status.acknowledged, [{ conversationId: pair.conversationId, localSessionId: pair.mapping.sessionId }]);
  assert.equal(f.inspections.length, 4);
  assert.equal((await f.manifest()).anchors[0].localSessionId, pair.mapping.sessionId);
  assert.equal(f.state.records.length, 2); assert.equal(pair.original.status, 'original');
});

test('a changed archived prefix fails despite an unchanged semantic checkpoint, including publisher restart', async () => {
  for (const restart of [false, true]) {
    const f = await fixture(), pair = await f.add(); await f.publish();
    pair.mapping.isArchived = true; await pair.saveMapping();
    await writeFile(pair.original.path, 'altered! native bytes\n');
    const publisher = restart ? f.factory() : null;
    await assert.rejects(publisher ? publisher.publish(f.state) : f.publish(), /previously verified byte prefix/);
    assert.deepEqual((await f.manifest()).actions, []);
  }
});

test('one full candidate is checked per poll and cached proofs do not starve remaining candidates', async () => {
  const f = await fixture(); for (let index = 0; index < 4; index++) await f.add();
  for (let index = 1; index <= 4; index++) {
    const status = await f.publish(); assert.equal(f.inspections.length, index * 2); assert.equal(status.actions, index);
  }
  assert.equal(new Set((await f.manifest()).actions.map(action => action.nativeId)).size, 4);
});

test('a cached candidate changed during another history inspection is revoked before publication', async () => {
  const f = await fixture(), first = await f.add(); await f.publish();
  const second = await f.add();
  f.intercept(async record => {
    if (record.nativeId === second.current.nativeId) await appendFile(first.original.path, 'concurrent input\n');
  });
  await assert.rejects(f.publish(), /observations changed before publication/);
  assert.deepEqual((await f.manifest()).actions, []);
});

test('only exact superseded unmanaged originals and promoted verified owners are candidates', async () => {
  for (const update of [{ status: 'current' }, { managed: true }, { verified: false }, { side: 'codex' }]) {
    const f = await fixture(), pair = await f.add(); Object.assign(pair.original, update);
    assert.equal((await f.publish()).actions, 0); assert.equal(f.inspections.length, 0);
  }
  const f = await fixture(), pair = await f.add();
  pair.current.checkpoint = pair.original.checkpoint;
  await assert.rejects(f.publish(), /not a promoted continuation/);
});

test('an original left behind by a Codex project move is skipped, while other cwd mismatches still fail', async () => {
  const f = await fixture(), pair = await f.add(), moved = join(f.root, 'moved');
  await mkdir(moved, { mode: 0o700 });
  // The move happened without new turns; the original keeps its old project.
  f.state.conversations[pair.conversationId].cwd = moved;
  pair.current.cwd = moved; pair.original.checkpoint = pair.current.checkpoint;
  await assert.rejects(f.publish(), /not a promoted continuation/);
  f.state.records.push({ id: randomUUID(), conversationId: pair.conversationId, nativeId: randomUUID(), side: 'codex',
    managed: false, verified: true, kind: 'original', status: 'current', cwd: moved,
    relocation: { version: 1, kind: 'codex-project-move', originCwd: f.cwd, previousCwd: f.cwd } });
  assert.equal((await f.publish()).actions, 0); assert.equal(f.inspections.length, 0);
});

test('an ordinary CLI original without a Desktop registry row is not archived', async () => {
  const f = await fixture(), pair = await f.add();
  await rename(pair.registryPath, `${pair.registryPath}.not-a-registry-record`);
  assert.equal((await f.publish()).actions, 0); assert.equal(f.inspections.length, 0);
});

test('exact registry mappings include archived rows and reject duplicate or malformed identities', async () => {
  const f = await fixture(), pair = await f.add();
  pair.mapping.isArchived = true; await pair.saveMapping();
  const selected = await readDesktopSessionMappings(f.desktopHome, [pair.original.nativeId]);
  assert.equal(selected.get(pair.original.nativeId).sessionId, pair.mapping.sessionId);
  assert.equal(selected.get(pair.original.nativeId).isArchived, true);
  const secondId = `local_${randomUUID()}`;
  await writeFile(join(f.desktopHome, `${secondId}.json`), JSON.stringify({ ...pair.mapping, sessionId: secondId }));
  await assert.rejects(readDesktopSessionMappings(f.desktopHome, [pair.original.nativeId]), /Multiple Desktop records/);
});

test('mapping requires exact canonical cwd, native title, activity and archive state', async () => {
  for (const change of [{ cwd: '/not/canonical/../cwd' }, { title: '' }, { lastActivityAt: 'yesterday' }, { isArchived: undefined }]) {
    const f = await fixture(), pair = await f.add(); Object.assign(pair.mapping, change); await pair.saveMapping();
    await assert.rejects(f.publish(), /lacks exact/);
    assert.deepEqual((await f.manifest()).actions, []);
  }
});

test('owner metadata and original symlinks fail closed without modifying the target', async () => {
  for (const field of ['ownerPath', 'original']) {
    const f = await fixture(), pair = await f.add();
    const path = field === 'ownerPath' ? pair.ownerPath : pair.original.path;
    const bytes = await readFile(path); await rename(path, `${path}.preserved`); await symlink(`${path}.preserved`, path);
    await assert.rejects(f.publish(), /not canonical/);
    assert.deepEqual(await readFile(`${path}.preserved`), bytes);
  }
  const f = await fixture(), pair = await f.add(); await chmod(pair.ownerPath, 0o644);
  await assert.rejects(f.publish(), /required permissions/);
});

test('an exact frontend title/cwd must still agree with the stored logical identity', async () => {
  for (const update of [{ title: 'Different conversation' }, { cwd: '/different' }]) {
    const f = await fixture(), pair = await f.add(); Object.assign(pair.mapping, update); await pair.saveMapping();
    await assert.rejects(f.publish(), /differs from the logical conversation/);
    assert.deepEqual((await f.manifest()).actions, []);
  }
});

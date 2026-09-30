import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, lstat, chmod, symlink, rename, readdir, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash } from '../src/storage.mjs';
import { publishClaudeFolderMap } from '../src/claude-folder-map.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-folder-map-')));
  const cwd = join(root, 'project');
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(join(root, 'owners'), { mode: 0o700 });
  const state = { version: 2, pending: null, conversations: {}, records: [] };
  return { root, cwd, state, path: join(root, 'folder-map.json'),
    async addOwner({ remoteId = `cse_${randomUUID().replaceAll('-', '')}`, ...fields } = {}) {
      const conversationId = randomUUID(), nativeId = randomUUID();
      state.conversations[conversationId] = { id: conversationId, cwd, title: 'Private title omitted from map' };
      const record = { id: randomUUID(), conversationId, nativeId, cwd, side: 'claude', managed: true,
        verified: true, kind: 'owner', status: 'current' };
      state.records.push(record);
      const owner = { version: 1, conversationId, cwd, sessionId: nativeId, remoteId,
        registration: 'registered', pending: null, lastAppend: { contentHash: 'private content never published' }, ...fields };
      const path = join(root, 'owners', `${hash(conversationId)}.json`);
      await writeFile(path, JSON.stringify(owner), { mode: 0o600 });
      return { record, owner, path, async save() { await writeFile(path, JSON.stringify(owner), { mode: 0o600 }); } };
    },
    publish() { return publishClaudeFolderMap({ root, state }); },
  };
}

test('only verified current managed owners produce a deterministic private presentation map', async () => {
  const f = await fixture();
  await f.addOwner({ remoteId: 'cse_z' });
  await f.addOwner({ remoteId: 'cse_a' });
  for (const change of [{ managed: false }, { verified: false }, { status: 'original' }, { kind: 'snapshot' }, { side: 'codex' }]) {
    const { record } = await f.addOwner();
    Object.assign(record, change);
  }
  const before = structuredClone(f.state);
  assert.deepEqual(await f.publish(), { changed: true, entries: 2, deferred: null });
  const data = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(data, { version: 1, entries: [
    { remoteId: 'cse_a', canonicalCwd: f.cwd, verified: true },
    { remoteId: 'cse_z', canonicalCwd: f.cwd, verified: true },
  ] });
  assert.equal((await lstat(f.path)).mode & 0o7777, 0o600);
  assert.deepEqual(f.state, before);
  assert.equal((await readdir(f.root)).some(name => name.endsWith('.tmp')), false);
});

test('an owner whose working directory was removed only loses its own folder override', async () => {
  const f = await fixture();
  await f.addOwner({ remoteId: 'cse_kept' });
  const removed = join(f.root, 'removed-worktree');
  const gone = await f.addOwner({ remoteId: 'cse_removed', cwd: removed });
  gone.record.cwd = removed; f.state.conversations[gone.record.conversationId].cwd = removed;
  assert.deepEqual(await f.publish(), { changed: true, entries: 1, deferred: null });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).entries, [{ remoteId: 'cse_kept', canonicalCwd: f.cwd, verified: true }]);
});

test('stopped enrollments revoke their folder rows without reading owner metadata', async () => {
  const f = await fixture(), kept = await f.addOwner({ remoteId: 'cse_kept' }), stopped = await f.addOwner({ remoteId: 'cse_stopped' });
  await f.publish();
  f.state.conversations[stopped.record.conversationId].tracking = { status: 'stopped', stoppedAt: 1 };
  await writeFile(stopped.path, 'Invalid metadata must not be read', { mode: 0o600 });
  assert.deepEqual(await f.publish(), { changed: true, entries: 1, deferred: null });
  assert.deepEqual(JSON.parse(await readFile(f.path)).entries, [{ remoteId: kept.owner.remoteId, canonicalCwd: f.cwd, verified: true }]);
});

test('an unchanged map is not rewritten even when ledger records are reordered', async () => {
  const f = await fixture();
  await f.addOwner({ remoteId: 'cse_second' }); await f.addOwner({ remoteId: 'cse_first' });
  await f.publish();
  const before = await lstat(f.path, { bigint: true });
  f.state.records.reverse();
  assert.deepEqual(await f.publish(), { changed: false, entries: 2, deferred: null });
  const after = await lstat(f.path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
});

test('legacy owner states without a displayTitle still publish only exact identity and cwd', async () => {
  const f = await fixture();
  const { owner } = await f.addOwner({ remoteId: 'cse_legacy' });
  assert.equal(Object.hasOwn(owner, 'displayTitle'), false);
  await f.publish();
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.path)).entries[0]).sort(), ['canonicalCwd', 'remoteId', 'verified']);
});

test('pending bridge work preserves the previous map without reading invalid owner metadata', async () => {
  const f = await fixture();
  const current = await f.addOwner(); await f.publish();
  const original = await readFile(f.path), before = await lstat(f.path, { bigint: true });
  await writeFile(current.path, 'invalid owner JSON');
  f.state.pending = { phase: 'prepared' };
  assert.deepEqual(await f.publish(), { changed: false, entries: null, deferred: 'pending' });
  assert.deepEqual(await readFile(f.path), original);
  assert.equal((await lstat(f.path, { bigint: true })).ino, before.ino);
});

test('an owner append or reset transition also preserves the existing map', async () => {
  for (const field of ['pending', 'reset']) {
    const f = await fixture(), current = await f.addOwner();
    await f.publish(); const original = await readFile(f.path);
    current.owner[field] = { phase: 'prepared' }; await current.save();
    assert.deepEqual(await f.publish(), { changed: false, entries: null, deferred: 'owner_transition' });
    assert.deepEqual(await readFile(f.path), original);
  }
});

test('wrong native, conversation or cwd identities fail without partially replacing the prior map', async () => {
  for (const fields of [{ sessionId: randomUUID() }, { conversationId: randomUUID() }, { cwd: '/different' },
    { remoteId: 'session_not_a_registered_cse' }, { remoteId: '' }, { remoteId: null }, { registration: 'registering' }]) {
    const f = await fixture(), current = await f.addOwner();
    await f.publish(); const original = await readFile(f.path);
    Object.assign(current.owner, fields); await current.save();
    await assert.rejects(f.publish(), /identity or Remote Control registration/);
    assert.deepEqual(await readFile(f.path), original);
  }
});

test('owner symlinks, hardlinks and permissive modes are refused without touching their targets', async () => {
  for (const kind of ['symlink', 'hardlink', 'mode']) {
    const f = await fixture(), current = await f.addOwner();
    const original = await readFile(current.path);
    const moved = `${current.path}.preserved`;
    if (kind === 'mode') await chmod(current.path, 0o644);
    else {
      await rename(current.path, moved);
      if (kind === 'symlink') await symlink(moved, current.path);
      else await link(moved, current.path);
    }
    await assert.rejects(f.publish(), /private owned regular file/);
    assert.deepEqual(await readFile(kind === 'mode' ? current.path : moved), original);
    await assert.rejects(lstat(f.path), { code: 'ENOENT' });
  }
});

test('directory aliases and an existing map symlink are never followed or replaced', async () => {
  const f = await fixture(); await f.addOwner();
  const owners = join(f.root, 'owners'), moved = join(f.root, 'preserved-owners');
  await rename(owners, moved); await symlink(moved, owners);
  await assert.rejects(f.publish(), /directory must be canonical/);
  const other = await fixture(); await other.addOwner();
  const untouched = join(other.root, 'untouched'); await writeFile(untouched, 'not a map', { mode: 0o600 });
  await symlink(untouched, other.path);
  await assert.rejects(other.publish(), /private owned regular file/);
  assert.equal(await readFile(untouched, 'utf8'), 'not a map');
  assert.equal((await lstat(other.path)).isSymbolicLink(), true);
});

test('malformed or oversized metadata and invalid map schemas leave the previous map unchanged', async () => {
  for (const content of ['malformed', ' '.repeat(2 * 1024 * 1024 + 1)]) {
    const f = await fixture(), current = await f.addOwner();
    await f.publish(); const original = await readFile(f.path);
    await writeFile(current.path, content);
    await assert.rejects(f.publish(), /malformed JSON|byte limit/);
    assert.deepEqual(await readFile(f.path), original);
  }
  const f = await fixture(); await f.addOwner();
  const malformed = JSON.stringify({ version: 1, entries: [], unexpected: true });
  await writeFile(f.path, malformed, { mode: 0o600 });
  await assert.rejects(f.publish(), /existing map schema/);
  assert.equal(await readFile(f.path, 'utf8'), malformed);
});

test('duplicate owner identities and excess entries fail before any partial map is written', async () => {
  const duplicate = await fixture(); await duplicate.addOwner({ remoteId: 'cse_shared' }); await duplicate.addOwner({ remoteId: 'cse_shared' });
  await assert.rejects(duplicate.publish(), /identity or Remote Control registration/);
  await assert.rejects(lstat(duplicate.path), { code: 'ENOENT' });
  const excess = await fixture(), { record } = await excess.addOwner();
  excess.state.records = Array.from({ length: 4097 }, () => record);
  await assert.rejects(excess.publish(), /4096-entry limit/);
  await assert.rejects(lstat(excess.path), { code: 'ENOENT' });
});

test('an empty verified owner set publishes an empty map without needing an owners directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-empty-folder-map-')));
  assert.deepEqual(await publishClaudeFolderMap({ root, state: { version: 2, conversations: {}, records: [], pending: null } }),
    { changed: true, entries: 0, deferred: null });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'folder-map.json'))), { version: 1, entries: [] });
});

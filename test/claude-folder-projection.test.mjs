import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeFolderProjection, claudeFolderProjectKey, lookupClaudeFolderProjection,
  normalizeClaudeRemoteId } from '../src/claude-folder-projection.mjs';

const cwd = '/Users/example/claudex';
const remoteId = 'cse_exampleRemoteSession';
const entry = (overrides = {}) => ({ remoteId, canonicalCwd: cwd, verified: true, ...overrides });
const local = (overrides = {}) => ({ id: 'local_original', type: 'local', cwd,
  repoInfo: { owner: '', name: 'claudex', branch: '' }, ...overrides });

test('the observed Folder policy distinguishes native folder, repository and Remote Control keys', () => {
  assert.equal(claudeFolderProjectKey(local()), cwd);
  assert.equal(claudeFolderProjectKey(local({ type: 'cli', cwd: `${cwd}/` })), cwd);
  assert.equal(claudeFolderProjectKey(local({ repoInfo: { owner: 'Example', name: 'Repo' } })), 'example/repo');
  assert.equal(claudeFolderProjectKey(local({ type: 'bridge', environmentId: 'env_1' })), 'env_1:claudex');
  assert.equal(claudeFolderProjectKey(local({ repoInfo: undefined })), undefined);
  assert.equal(claudeFolderProjectKey(local({ isScratchWorkspace: true })), undefined);
});

test('only observed cse and session prefixes normalize to the same exact remote identity', () => {
  assert.equal(normalizeClaudeRemoteId(remoteId), remoteId);
  assert.equal(normalizeClaudeRemoteId(remoteId.replace('cse_', 'session_')), remoteId);
  for (const id of [null, '', 'cse_', 'local_exampleRemoteSession', `prefix-${remoteId}`, `${remoteId}/path`, `${remoteId} `]) {
    assert.equal(normalizeClaudeRemoteId(id), null);
  }
});

test('a verified exact remote uses the existing folder key and label without changing rows or routes', () => {
  const originalSession = Object.freeze({ id: remoteId, environment_id: 'env_1' });
  const remote = Object.freeze({ id: remoteId, type: 'bridge', environmentId: 'env_1',
    _originalSession: originalSession, repoInfo: undefined, route: `/code/${remoteId}` });
  const rows = [remote, Object.freeze(local())];
  const before = structuredClone(rows);
  const projection = buildClaudeFolderProjection({ entries: [entry()], localRows: rows });
  assert.deepEqual(lookupClaudeFolderProjection(projection, remoteId), { projectKey: cwd, label: 'claudex' });
  assert.deepEqual(lookupClaudeFolderProjection(projection, remoteId.replace('cse_', 'session_')), { projectKey: cwd, label: 'claudex' });
  assert.equal(lookupClaudeFolderProjection(projection, 'cse_unrelated'), undefined);
  assert.deepEqual(rows, before);
  assert.equal(remote._originalSession, originalSession);
  assert.equal(claudeFolderProjectKey(remote), undefined);
  assert.ok(Object.isFrozen(projection));
  assert.ok(Object.isFrozen(projection.overrides));
  assert.ok(Object.isFrozen(projection.overrides[remoteId]));
});

test('repository-backed folders reuse the actual existing group key and rendered label instead of the cwd', () => {
  const projection = buildClaudeFolderProjection({ entries: [entry()],
    localRows: [local({ repoInfo: { owner: 'Example', name: 'Project', branch: 'main' } })],
    groups: [{ key: 'example/project', label: 'Project · Example' }] });
  assert.deepEqual(lookupClaudeFolderProjection(projection, remoteId), { projectKey: 'example/project', label: 'Project · Example' });
});

test('observed harness roots match exactly without turning descendants into the same project', () => {
  for (const field of ['diffCwd', 'harnessCwd']) {
    const projection = buildClaudeFolderProjection({ entries: [entry({ canonicalCwd: '/private/worktree' })],
      localRows: [local({ [field]: '/private/worktree/' })] });
    assert.equal(lookupClaudeFolderProjection(projection, remoteId)?.projectKey, cwd);
  }
  const projection = buildClaudeFolderProjection({ entries: [entry({ canonicalCwd: `${cwd}/nested` })], localRows: [local()] });
  assert.equal(lookupClaudeFolderProjection(projection, remoteId), undefined);
  assert.equal(projection.excluded[0].reason, 'missing_existing_local_group');
});

test('missing or unverified mappings fail closed with explicit exclusions', () => {
  const projection = buildClaudeFolderProjection({ entries: [entry({ verified: false }),
    entry({ remoteId: 'cse_missing', canonicalCwd: '/missing' }), entry({ remoteId: 'not-a-remote' }),
    entry({ remoteId: 'cse_noncanonical', canonicalCwd: `${cwd}/../other` })], localRows: [local()] });
  assert.equal(Object.keys(projection.overrides).length, 0);
  assert.equal(projection.excludedCount, 4);
  assert.deepEqual(new Set(projection.excluded.map(value => value.reason)), new Set([
    'unverified_remote_id', 'missing_existing_local_group', 'invalid_remote_id', 'invalid_canonical_cwd',
  ]));
});

test('a same-path SSH, WSL, bridge or scratch row is not an existing same-host local folder', () => {
  for (const row of [local({ remote: { kind: 'ssh', sshHost: 'elsewhere' } }),
    local({ remote: { kind: 'wsl', distro: 'Ubuntu' } }), local({ type: 'bridge', environmentId: 'env_1' }),
    local({ isScratchWorkspace: true })]) {
    const projection = buildClaudeFolderProjection({ entries: [entry()], localRows: [row] });
    assert.equal(lookupClaudeFolderProjection(projection, remoteId), undefined);
  }
});

test('conflicting existing project keys or duplicate remote mappings never select an arbitrary target', () => {
  const ambiguous = buildClaudeFolderProjection({ entries: [entry()], localRows: [local(),
    local({ id: 'local_other', repoInfo: { owner: 'Example', name: 'Different' } })] });
  assert.equal(lookupClaudeFolderProjection(ambiguous, remoteId), undefined);
  assert.equal(ambiguous.excluded[0].reason, 'ambiguous_existing_local_group');
  const conflicting = buildClaudeFolderProjection({ entries: [entry(),
    entry({ remoteId: remoteId.replace('cse_', 'session_'), canonicalCwd: '/different' })], localRows: [local()] });
  assert.equal(lookupClaudeFolderProjection(conflicting, remoteId), undefined);
  assert.equal(conflicting.excluded[0].reason, 'conflicting_remote_mapping');
  const duplicate = buildClaudeFolderProjection({ entries: [entry(), entry({ remoteId: remoteId.replace('cse_', 'session_') })], localRows: [local()] });
  assert.equal(Object.keys(duplicate.overrides).length, 1);
});

test('provided native group labels are mandatory and cannot be replaced with a guessed path label', () => {
  for (const groups of [[], [{ key: cwd, label: '' }], [{ key: cwd, label: 'First' }, { key: cwd, label: 'Second' }]]) {
    const projection = buildClaudeFolderProjection({ entries: [entry()], localRows: [local()], groups });
    assert.equal(lookupClaudeFolderProjection(projection, remoteId), undefined);
    assert.equal(projection.excluded[0].reason, 'missing_or_ambiguous_local_label');
  }
});

test('an original native key function can be supplied without rewriting its input row', () => {
  const row = Object.freeze(local());
  let calls = 0;
  const projection = buildClaudeFolderProjection({ entries: [entry()], localRows: [row],
    groups: [{ key: 'native-existing-key', label: 'Existing native label' }], projectKey(input) {
      calls++;
      assert.equal(input, row);
      return 'native-existing-key';
    } });
  assert.equal(calls, 1);
  assert.deepEqual(lookupClaudeFolderProjection(projection, remoteId), { projectKey: 'native-existing-key', label: 'Existing native label' });
});

test('invalid inputs fail explicitly and excluded diagnostics remain bounded', () => {
  assert.throws(() => buildClaudeFolderProjection(), /requires/);
  assert.throws(() => buildClaudeFolderProjection({ entries: [], localRows: [], groups: {} }), /requires/);
  const projection = buildClaudeFolderProjection({ entries: Array.from({ length: 30 }, () => entry({ remoteId: 'invalid' })), localRows: [] });
  assert.equal(projection.excludedCount, 30);
  assert.equal(projection.excluded.length, 20);
  assert.equal(lookupClaudeFolderProjection({ version: 1, overrides: Object.create({ [remoteId]: { projectKey: 'inherited' } }) }, remoteId), undefined);
});

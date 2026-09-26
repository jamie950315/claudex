import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeLocalFolderAnchor } from '../src/claude-folder-anchor.mjs';
import { buildClaudeFolderProjection } from '../src/claude-folder-projection.mjs';

const localSessionId = 'local_11111111-1111-4111-8111-111111111111';
const nativeId = '22222222-2222-4222-8222-222222222222';
const base = { anchor: { localSessionId, nativeId, cwd: '/Users/test/claudex' },
  session: { sessionId: localSessionId, cliSessionId: nativeId, cwd: '/Users/test/claudex', originCwd: '', isArchived: true }, gitInfo: null };

test('an authenticated archived Local anchor retains the same native path key and folder label without a visible row', () => {
  const input = structuredClone(base), untouched = structuredClone(input);
  const anchor = normalizeClaudeLocalFolderAnchor(input);
  assert.deepEqual(anchor, { id: localSessionId, type: 'local', cwd: '/Users/test/claudex', diffCwd: '/Users/test/claudex',
    repoInfo: { owner: '', name: 'claudex', branch: '' }, isArchived: true, isScratchWorkspace: false });
  const projected = buildClaudeFolderProjection({ entries: [{ remoteId: 'cse_verified', canonicalCwd: base.anchor.cwd, verified: true }],
    localRows: [anchor] });
  assert.deepEqual(projected.overrides.cse_verified, { projectKey: '/Users/test/claudex', label: 'claudex' });
  assert.deepEqual(input, untouched);
});

test('Git owners, worktree origins, and harness branch precedence match the native Local normalizer', () => {
  const cases = [
    { gitInfo: { repo: 'Owner/Repo', branch: 'main' }, expected: { owner: 'Owner', name: 'Repo', branch: 'main' } },
    { gitInfo: { repo: 'Owner/Repo', branch: 'HEAD' }, expected: { owner: 'Owner', name: 'Repo', branch: '' } },
    { gitInfo: { repo: 'Owner/Repo', branch: 'detached:123' }, expected: { owner: 'Owner', name: 'Repo', branch: '' } },
    { session: { branch: 'saved' }, gitInfo: { repo: 'Owner/Repo', branch: 'live' }, expected: { owner: 'Owner', name: 'Repo', branch: 'saved' } },
    { session: { harnessCwd: '/Users/test/harness', branch: 'saved' }, gitInfo: { repo: 'Owner/Repo', branch: 'live' },
      expected: { owner: 'Owner', name: 'Repo', branch: 'live' } },
    { session: { cwd: '/Users/test/claudex/.claude/worktrees/task', originCwd: '/Users/test/claudex', branch: 'task' },
      gitInfo: null, originGitInfo: { repo: 'Origin/Repo', branch: 'main' }, expected: { owner: 'Origin', name: 'Repo', branch: 'task' } },
    { session: { cwd: '/Users/test/claudex/.claude/worktrees/task', originCwd: '/Users/test/claudex' },
      gitInfo: null, originGitInfo: { repo: 'Origin/Repo', branch: 'main' }, expected: { owner: '', name: 'claudex', branch: '' } },
  ];
  for (const item of cases) {
    const session = { ...base.session, ...item.session };
    const result = normalizeClaudeLocalFolderAnchor({ ...base, ...item, session, anchor: { ...base.anchor, cwd: session.cwd } });
    assert.deepEqual(result.repoInfo, item.expected);
    assert.equal(result.cwd, session.originCwd || session.cwd);
    assert.equal(result.diffCwd, session.harnessCwd || session.cwd);
  }
  const same = normalizeClaudeLocalFolderAnchor({ ...base, session: { ...base.session, originCwd: base.session.cwd }, gitInfo: null });
  assert.equal(same.repoInfo.name, 'claudex');
});

test('missing Git reads, source identity changes, remote hosts, scratch rows, and path substitution produce no anchor', () => {
  for (const change of [
    { session: { sessionId: 'local_33333333-3333-4333-8333-333333333333' } },
    { session: { cliSessionId: '33333333-3333-4333-8333-333333333333' } },
    { session: { cwd: '/Users/test/unrelated' } }, { session: { cwd: '/Users/test/../claudex' } },
    { session: { remoteTarget: { kind: 'ssh' } } }, { session: { remoteTarget: { kind: 'wsl' } } },
    { session: { sshConfig: {} } }, { session: { wslConfig: {} } }, { session: { isScratchWorkspace: true } },
    { gitInfo: undefined }, { gitInfo: 'unreadable' }, { gitInfo: { repo: {} } },
    { session: { originCwd: '/Users/test/parent' }, gitInfo: null, originGitInfo: undefined },
    { anchor: { cwd: '/Users/test/unrelated' } }, { anchor: { localSessionId: 'forged' } },
  ]) assert.equal(normalizeClaudeLocalFolderAnchor({ ...base, ...change,
    session: { ...base.session, ...change.session }, anchor: { ...base.anchor, ...change.anchor } }), null);
  assert.equal(normalizeClaudeLocalFolderAnchor({ ...base, session: { ...base.session, cwd: '/', originCwd: '' }, anchor: { ...base.anchor, cwd: '/' } }), null);
});

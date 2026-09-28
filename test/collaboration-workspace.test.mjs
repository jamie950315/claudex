import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCollaborationWorkspace as scope, revalidateWorkspace, workspaceAccess, workspacesConflict } from '../src/collaboration-workspace.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-scope-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['project', 'project-extra', 'reference', 'other'].map(name => [name, join(root, name)]));
  await Promise.all(Object.values(dirs).map(path => mkdir(path)));
  dirs.nested = join(dirs.project, 'src');
  await mkdir(dirs.nested);
  return { root, ...dirs };
}

test('root scopes discover the Git checkout, preserve non-Git directories and honor explicit project roots', async t => {
  const f = await fixture(t);
  assert.equal((await scope({ cwd: f.nested })).cwd, f.nested);
  await run('git', ['init', '-q', f.project]);
  assert.equal((await scope({ cwd: f.nested })).cwd, f.project);
  assert.equal((await scope({ cwd: f.nested, projectRoot: f.nested })).cwd, f.nested);
  await assert.rejects(scope({ cwd: f.other, projectRoot: f.project }), /must contain cwd/);
});

test('Git worktree file resolves to its own checkout, not the main repository', async t => {
  const f = await fixture(t);
  await run('git', ['init', '-q', f.project]);
  await run('git', ['-C', f.project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
  const worktree = join(f.root, 'worktree');
  await run('git', ['-C', f.project, 'worktree', 'add', '--detach', '-q', worktree]);
  const nested = join(worktree, 'src');
  await mkdir(nested);
  assert.equal((await scope({ cwd: nested })).projectRoot, worktree);
});

test('Git root detection needs no Git executable and malformed metadata fails explicitly', async t => {
  const f = await fixture(t);
  await mkdir(join(f.project, '.git'));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent-claudex-path';
    assert.equal((await scope({ cwd: f.nested })).projectRoot, f.project);
  } finally { process.env.PATH = savedPath; }
  await writeFile(join(f.other, '.git'), 'not a gitdir marker\n');
  await assert.rejects(scope({ cwd: f.other }), /unsupported format/);
  await writeFile(join(f.other, '.git'), `gitdir: ${f.reference}\n`);
  assert.equal((await scope({ cwd: f.other })).projectRoot, f.other);
  await symlink(join(f.project, '.git'), join(f['project-extra'], '.git'));
  await assert.rejects(scope({ cwd: f['project-extra'] }), /regular file or directory/);
});

test('canonical directories deduplicate, bound lists and reject read/write overlap', async t => {
  const f = await fixture(t);
  const refs = join(f.reference, 'nested');
  await mkdir(refs);
  const result = await scope({ cwd: f.project, permission: 'workspace-write', readOnlyDirs: [refs, f.reference, refs], writableDirs: [f.nested, f.other] });
  assert.deepEqual(result.readOnlyDirs, [f.reference]);
  assert.deepEqual(result.writableDirs, [f.other]);
  await assert.rejects(scope({ cwd: f.project, permission: 'workspace-write', readOnlyDirs: [f.nested] }), /must not overlap/);
  await assert.rejects(scope({ cwd: f.project, permission: 'workspace-write', readOnlyDirs: [f.root] }), /must not overlap/);
  await assert.rejects(scope({ cwd: f.project, writableDirs: [f.other] }), /read-only/);
  await assert.rejects(scope({ cwd: f.project, readOnlyDirs: Array(17).fill(f.reference) }), /at most 16/);
});

test('children inherit grants without Git promotion and can only narrow authorized roots', async t => {
  const f = await fixture(t);
  await run('git', ['init', '-q', f.project]);
  const parent = { ...await scope({ cwd: f.nested, projectRoot: f.nested, permission: 'workspace-write', readOnlyDirs: [f.reference], writableDirs: [f.other] }), permission: 'workspace-write' };
  const child = await scope({ parent, permission: 'workspace-write' });
  assert.equal(child.cwd, f.nested);
  assert.deepEqual(child.readOnlyDirs, [f.reference]);
  assert.deepEqual(child.writableDirs, [f.other]);
  await assert.rejects(scope({ parent, cwd: f.project, permission: 'workspace-write' }), /exceeds parent/);
  await assert.rejects(scope({ parent, writableDirs: [f.reference], permission: 'workspace-write', readOnlyDirs: [] }), /exceed parent/);
  const reader = await scope({ parent, permission: 'read-only' });
  assert.deepEqual(reader.writableDirs, []);
  assert.deepEqual(reader.readOnlyDirs, [f.other, f.reference].sort());
  await assert.rejects(scope({ parent: { ...reader, permission: 'read-only' }, permission: 'workspace-write' }), /exceeds parent/);
  const narrow = await scope({ parent, cwd: f.reference, permission: 'read-only', readOnlyDirs: [] });
  assert.equal(narrow.cwd, f.reference);
});

test('canonical aliases cannot escape parent grants and saved symlink replacements fail dispatch', async t => {
  const f = await fixture(t);
  const alias = join(f.project, 'escape');
  await symlink(f.other, alias);
  const parent = { ...await scope({ cwd: f.project, permission: 'workspace-write' }), permission: 'workspace-write' };
  await assert.rejects(scope({ parent, cwd: alias, permission: 'workspace-write' }), /exceeds parent/);
  await revalidateWorkspace(parent);
  await rename(f.project, `${f.project}-original`);
  await symlink(f.other, f.project);
  await assert.rejects(revalidateWorkspace(parent), /canonical identity/);
});

test('conflicts use full root overlap, not string prefixes, and preserve legacy cwd scopes', async t => {
  const f = await fixture(t);
  const writer = { cwd: f.project, permission: 'workspace-write' };
  assert.deepEqual(workspaceAccess(writer), { readRoots: [f.project], writeRoots: [f.project] });
  assert.equal(workspacesConflict(writer, { cwd: f.nested, permission: 'read-only' }), true);
  assert.equal(workspacesConflict(writer, { cwd: f.root, permission: 'read-only' }), true);
  assert.equal(workspacesConflict(writer, { cwd: f['project-extra'], permission: 'workspace-write' }), false);
  assert.equal(workspacesConflict({ ...writer, permission: 'read-only' }, { cwd: f.nested, permission: 'read-only' }), false);
  assert.equal(workspacesConflict(writer, { cwd: f.other, permission: 'workspace-write', readOnlyDirs: [f.nested] }), true);
  assert.equal(workspacesConflict(writer, { cwd: f.other, permission: 'workspace-write', writableDirs: [f.project] }), true);
});

test('saved grant schema and excessively broad initial grants fail closed', async t => {
  const f = await fixture(t);
  for (const readOnlyDirs of [null, 'not-array', {}, Array(17).fill(f.other)])
    await assert.rejects(revalidateWorkspace({ cwd: f.project, permission: 'read-only', readOnlyDirs }), /at most 16/);
  await assert.rejects(revalidateWorkspace({ cwd: f.project, permission: 'invalid' }), /Unsupported/);
  await assert.rejects(revalidateWorkspace({ cwd: f.project, permission: 'read-only', writableDirs: [f.other] }), /read-only/);
  await assert.rejects(scope({ cwd: f.project, projectRoot: '/' }), /Filesystem root/);
  await assert.rejects(scope({ cwd: f.project, readOnlyDirs: ['/'] }), /Filesystem root/);
  await assert.rejects(scope({ cwd: homedir(), permission: 'workspace-write' }), /entire home/);
});

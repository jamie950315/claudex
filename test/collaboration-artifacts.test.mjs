import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, symlink, link, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCollaborationArtifact } from '../src/collaboration-artifacts.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-artifact-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const task = { id: 'task-a', generation: 1, cwd, projectRoot: cwd, permission: 'full-access', reportHistory: [
    { generation: 1, provenance: 'worker-self-reported', artifacts: [{ kind: 'file', reference: 'result.txt' }] },
  ] };
  await writeFile(join(cwd, 'result.txt'), 'Observed content\n');
  return { root, cwd, task };
}
test('declared artifact reads are bounded current evidence, not worker authorship or acceptance', async t => {
  const { task } = await fixture(t), before = structuredClone(task);
  const result = await readCollaborationArtifact(task, { generation: 1, reference: 'result.txt' });
  assert.equal(result.content, 'Observed content\n'); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.attribution, 'unknown'); assert.equal(result.provenance, 'file-observed');
  assert.equal(result.declaration.provenance, 'worker-self-reported'); assert.deepEqual(task, before);
  await assert.rejects(readCollaborationArtifact(task, { generation: 0, reference: 'result.txt' }), /not a declared/);
  await assert.rejects(readCollaborationArtifact(task, { generation: 1, reference: 'result.txt', maxBytes: 2 }), /bounded read/);
});
test('full-access does not turn artifact references into arbitrary host reads or symlink traversal', async t => {
  const { task, root, cwd } = await fixture(t);
  await writeFile(join(root, 'private'), 'private');
  const refs = ['../private', 'alias', 'dir/private', 'hardlink'];
  task.reportHistory[0].artifacts.push(...refs.map(reference => ({ kind: 'file', reference })));
  await symlink(join(root, 'private'), join(cwd, 'alias')); await symlink(root, join(cwd, 'dir'));
  await link(join(root, 'private'), join(cwd, 'hardlink'));
  for (const reference of refs) await assert.rejects(readCollaborationArtifact(task, { generation: 1, reference }), /outside|single-link|symbolic links/);
  await assert.rejects(readCollaborationArtifact(task, { generation: 1, reference: 'not-declared' }), /not a declared/);
  assert.equal(await readFile(join(root, 'private'), 'utf8'), 'private');
});
test('exact declared Git diff shows shared changes without claiming worker ownership', async t => {
  const { task, cwd } = await fixture(t);
  await exec('git', ['init', '-q', cwd]); await exec('git', ['-C', cwd, 'add', 'result.txt']);
  await writeFile(join(cwd, 'result.txt'), 'Changed file\n'); await writeFile(join(cwd, 'other.txt'), 'UNRELATED');
  const result = await readCollaborationArtifact(task, { generation: 1, reference: 'result.txt', view: 'diff' });
  assert.match(result.content, /\+Changed file/); assert.ok(!result.content.includes('UNRELATED'));
  assert.equal(result.comparison, 'working-tree-versus-index'); assert.equal(result.attribution, 'unknown');
});

test('Git diff treats declared filenames as literal paths, never wildcard access', async t => {
  const { task, cwd } = await fixture(t);
  await exec('git', ['init', '-q', cwd]);
  await writeFile(join(cwd, 'item[1].txt'), 'literal before\n'); await writeFile(join(cwd, 'item1.txt'), 'other before\n');
  await exec('git', ['-C', cwd, 'add', '.']);
  await writeFile(join(cwd, 'item[1].txt'), 'literal after\n'); await writeFile(join(cwd, 'item1.txt'), 'PRIVATE UNDECLARED\n');
  task.reportHistory[0].artifacts.push({ kind: 'file', reference: 'item[1].txt' });
  const result = await readCollaborationArtifact(task, { generation: 1, reference: 'item[1].txt', view: 'diff' });
  assert.match(result.content, /literal after/); assert.ok(!result.content.includes('PRIVATE UNDECLARED'));
});

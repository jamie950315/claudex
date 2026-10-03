import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, readdir, rm, cp, chmod, symlink, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stageClaudeMod, MOD_STAGE_FILES } from '../src/claude-mod-install.mjs';
import { serveCollaborationSocket } from '../src/collaboration-transport.mjs';
const SOURCE = fileURLToPath(new URL('..', import.meta.url));

test('standalone stage loads its real transport and reads Unix RPC without the source checkout', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cms-'))); await chmod(root, 0o700);
  const repo = join(root, 'source'), state = join(root, 'state'), collaboration = join(state, 'collaboration');
  await mkdir(collaboration, { recursive: true, mode: 0o700 });
  const token = 'a'.repeat(64);
  await writeFile(join(collaboration, 'controller-key'), `${token}\n`, { mode: 0o600 });
  const node = join(root, 'node-fixture'); await writeFile(node, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  for (const file of MOD_STAGE_FILES) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await cp(join(SOURCE, file), join(repo, file));
  }
  const staged = await stageClaudeMod({ output: join(root, 'stage'), stateRoot: state, repoRoot: repo, nodeBinary: node });
  await rm(repo, { recursive: true });
  let reads = 0;
  const server = await serveCollaborationSocket({ root: collaboration, dispatch: async envelope => {
    assert.equal(envelope.token, token); assert.equal(envelope.peer, 'claude'); assert.equal(envelope.method, 'list');
    reads++; return { tasks: [], totalCount: 0, syntheticOnly: true };
  } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [join(staged.plugin, 'runtime/bin/claudex-mod-bridge.mjs'), '--root', state],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ version: 1, op: 'read', method: 'list', params: {},
    context: { sessionId: '11111111-1111-4111-8111-111111111111', cwd: root } }));
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr || stdout);
  assert.deepEqual(JSON.parse(stdout), { ok: true, result: { tasks: [], totalCount: 0, syntheticOnly: true } });
  assert.equal(reads, 1);
});
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-mod-stage-unit-')));
  const repo = join(root, 'repo'), state = join(root, 'state'), output = join(root, 'marketplace'), node = join(root, 'node-fixture');
  // Test executable metadata independently of shared CI runner permissions.
  await writeFile(node, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await mkdir(repo); await mkdir(state, { mode: 0o700 });
  for (const file of MOD_STAGE_FILES) {
    const target = join(repo, file); await mkdir(dirname(target), { recursive: true });
    // Transport fixtures are intentionally synthetic; source-package staging tests
    // do not substitute for the full repository/real broker integration test.
    if (file === 'src/collaboration-transport.mjs') await writeFile(target, 'export async function callCollaboration(){ throw new Error("synthetic transport must not run"); }\n');
    else if (file === 'src/collaboration-effort.mjs') await writeFile(target, 'export const collaborationEfforts = {};\n');
    else await cp(join(SOURCE, file), target);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo, state, output, node };
}
test('stager packages an explicit allowlist and private absolute defaults', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'private-api-key.txt'), 'NEVER PACKAGE THIS');
  const before = await readdir(f.state);
  const report = await stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node });
  const manifest = JSON.parse(await readFile(join(report.plugin, '.claude-plugin', 'plugin.json')));
  assert.equal(manifest.userConfig.stateRoot.default, f.state);
  assert.equal(manifest.userConfig.nodeBinary.default, f.node);
  assert.equal(manifest.userConfig.nativeWake.default, false);
  assert.equal(report.synchronizationPolicy, 'unchanged'); assert.equal(report.automaticInstallation, false);
  assert.deepEqual(await readdir(f.state), before);
  assert.equal((await lstat(f.output)).mode & 0o777, 0o700);
  for (const [path, hash] of Object.entries(report.hashes))
    assert.equal(createHash('sha256').update(await readFile(join(report.plugin, path))).digest('hex'), hash);
  await assert.rejects(lstat(join(f.output, 'private-api-key.txt')), { code: 'ENOENT' });
});
test('stage output works after source checkout is removed for doctor operations', async t => {
  const f = await fixture(t);
  const report = await stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node });
  await rm(f.repo, { recursive: true });
  const cli = join(report.plugin, 'runtime', 'bin', 'claudex-mod-bridge.mjs');
  const result = spawnSync(process.execPath, [cli, '--root', f.state], { encoding: 'utf8', input: JSON.stringify({
    version: 1, op: 'doctor', context: { sessionId: '11111111-1111-4111-8111-111111111111', cwd: f.root },
  }) });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result.socketPresent, false);
});
test('stage refuses an existing output and preserves its files', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(join(f.output, 'existing'), 'preserve');
  await assert.rejects(stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node }), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.output, 'existing'), 'utf8'), 'preserve');
});
test('stage validates sources before creating output', async t => {
  const f = await fixture(t); await rm(join(f.repo, 'src', 'collaboration-transport.mjs'));
  await assert.rejects(stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node }));
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});
test('stage rejects incomplete locale data before creating output', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'plugins/claudex/hooks/locales.mjs'),
    'const rows = {"Language":["語言"]};\n\nconst languages = [];\n');
  await assert.rejects(stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node }), { code: 'MOD_LOCALES' });
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});
test('stage rejects unsafe state roots and source symlinks', async t => {
  const f = await fixture(t); await chmod(f.state, 0o755);
  await assert.rejects(stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node }), { code: 'UNSAFE_ROOT' });
  await chmod(f.state, 0o700);
  const target = join(f.repo, 'src', 'collaboration-effort.mjs');
  await rm(target); await symlink(join(f.repo, 'src', 'collaboration-transport.mjs'), target);
  await assert.rejects(stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node }), { code: 'STAGE_SOURCE' });
});
test('native receipt staging requires explicit opt-in', async t => {
  const f = await fixture(t);
  const report = await stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node, nativeWake: true });
  assert.equal(report.nativeWake, true);
});

test('stage rejects symlinked source parents before creating output', async t => {
  const f = await fixture(t);
  const original = join(f.repo, 'plugins', 'claudex', 'hooks');
  const moved = join(f.root, 'external-hooks');
  await rename(original, moved);
  await symlink(moved, original);
  await assert.rejects(stageClaudeMod({ output: f.output, stateRoot: f.state, repoRoot: f.repo, nodeBinary: f.node }), { code: 'STAGE_SOURCE' });
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, lstat, open, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectMaintenancePolicy } from '../src/maintenance-policy.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claudex-policy-'));
  const claudeHome = join(root, 'claude'), managedDirectory = join(root, 'managed');
  const mdmUserDirectory = join(root, 'mdm-user'), mdmDeviceDirectory = join(root, 'mdm-device');
  await Promise.all([claudeHome, managedDirectory, mdmUserDirectory, mdmDeviceDirectory].map(path => mkdir(path)));
  const paths = { managedDirectory, mdmUserPlist: join(mdmUserDirectory, 'com.anthropic.claudecode.plist'),
    mdmDevicePlist: join(mdmDeviceDirectory, 'com.anthropic.claudecode.plist') };
  const config = { claudeHome, platform: 'darwin', username: 'synthetic', paths,
    runner: async () => { throw new Error('Unexpected process invocation'); } };
  return { root, config, paths, claudeHome,
    inspect: overrides => inspectMaintenancePolicy({ ...config, ...overrides }),
    managed: join(managedDirectory, 'managed-settings.json'), dropIns: join(managedDirectory, 'managed-settings.d'),
    remote: join(claudeHome, 'remote-settings.json') };
}

test('absent policy files produce only explicit source metadata without invoking a native process', async () => {
  const f = await fixture();
  const snapshot = await f.inspect();
  assert.equal(snapshot.version, 1); assert.equal(snapshot.platform, 'darwin');
  for (const path of [f.managed, f.remote, f.paths.mdmUserPlist, f.paths.mdmDevicePlist, f.dropIns])
    assert.equal(snapshot.sources.find(source => source.path === path).exists, false);
  assert.deepEqual(await f.inspect(), snapshot);
});

test('readable managed, sorted drop-in and remote JSON retain hashes but never policy contents', async () => {
  const f = await fixture(), content = '{"privateValue":"DO_NOT_RETURN_POLICY"}';
  await writeFile(f.managed, content); await writeFile(f.remote, '{}'); await mkdir(f.dropIns);
  await writeFile(join(f.dropIns, 'b.json'), '{}'); await writeFile(join(f.dropIns, 'a.json'), '{}');
  await writeFile(join(f.dropIns, '.ignored.json'), 'not json'); await writeFile(join(f.dropIns, 'ignored.txt'), 'not json');
  const snapshot = await f.inspect();
  assert.equal(JSON.stringify(snapshot).includes('DO_NOT_RETURN_POLICY'), false);
  assert.equal(snapshot.sources.find(source => source.path === f.managed).sha256,
    createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(snapshot.sources.filter(source => source.kind === 'json' && source.path.startsWith(f.dropIns)).map(source => source.path),
    [join(f.dropIns, 'a.json'), join(f.dropIns, 'b.json')]);
});

test('policy read and parse failures are not mistaken for absence and do not leak parse excerpts', async () => {
  for (const content of ['{"secret":"DO_NOT_LEAK",', '[]', 'null', '// JSONC is deliberately unsupported\n{}', '']) {
    const f = await fixture(); await writeFile(f.managed, content);
    await assert.rejects(f.inspect(), error => /valid strict JSON object/.test(error.message) && !error.message.includes('DO_NOT_LEAK'));
  }
  const f = await fixture();
  const io = { open, readdir, lstat: async path => {
    if (path === f.managed) throw Object.assign(new Error('DO_NOT_LEAK permission detail'), { code: 'EACCES' });
    return lstat(path);
  } };
  await assert.rejects(f.inspect({ io }), error => /could not be inspected/.test(error.message) && !error.message.includes('DO_NOT_LEAK'));
});

test('remote cache corruption refuses maintenance although the SDK would silently ignore it', async () => {
  const f = await fixture(); await writeFile(f.remote, '{invalid remote cache');
  await assert.rejects(f.inspect(), /valid strict JSON object/);
});

test('non-ENOENT inspection errors and unreadable files remain explicit', async () => {
  const f = await fixture();
  const io = { open, readdir, lstat: async path => {
    if (path === f.managed) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    return lstat(path);
  } };
  await assert.rejects(f.inspect({ io }), /could not be inspected/);
  await writeFile(f.managed, '{}');
  io.lstat = lstat;
  io.open = async () => { throw Object.assign(new Error('DO_NOT_LEAK I/O detail'), { code: 'EIO' }); };
  await assert.rejects(f.inspect({ io }), error => /could not be read/.test(error.message) && !error.message.includes('DO_NOT_LEAK'));
});

test('symlinked files, symlinked policy roots and nonregular drop-ins are refused', async () => {
  const fileFixture = await fixture(), target = join(fileFixture.root, 'target.json');
  await writeFile(target, '{}'); await symlink(target, fileFixture.managed);
  await assert.rejects(fileFixture.inspect(), /without symbolic links/);
  const directoryFixture = await fixture(), alias = join(directoryFixture.root, 'alias');
  await symlink(directoryFixture.paths.managedDirectory, alias);
  await assert.rejects(directoryFixture.inspect({ paths: { ...directoryFixture.paths, managedDirectory: alias } }), /without symbolic links/);
  const dropFixture = await fixture(); await mkdir(dropFixture.dropIns); await mkdir(join(dropFixture.dropIns, 'directory.json'));
  await assert.rejects(dropFixture.inspect(), /drop-in is not a regular file/);
});

test('managed and remote sources enforce their respective bounded input sizes', async () => {
  const managed = await fixture(); await writeFile(managed.managed, Buffer.alloc(2 * 1024 * 1024 + 1, ' '));
  await assert.rejects(managed.inspect(), /pinned size limit/);
  const remote = await fixture(); await writeFile(remote.remote, Buffer.alloc(8 * 1024 * 1024 + 1, ' '));
  await assert.rejects(remote.inspect(), /pinned size limit/);
});

test('MDM conversion stays in memory with pinned timeout/output bounds and sanitized failures', async () => {
  const f = await fixture(); await writeFile(f.paths.mdmUserPlist, 'synthetic binary plist');
  const calls = [];
  const snapshot = await f.inspect({ runner: async (...args) => { calls.push(args); return { stdout: '{"privateValue":"DO_NOT_RETURN_MDM"}' }; } });
  assert.equal(JSON.stringify(snapshot).includes('DO_NOT_RETURN_MDM'), false);
  assert.deepEqual(calls[0], ['/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', f.paths.mdmUserPlist],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 + 1 }]);
  await assert.rejects(f.inspect({ runner: async () => { throw new Error('DO_NOT_LEAK stderr'); } }),
    error => /could not be decoded/.test(error.message) && !error.message.includes('DO_NOT_LEAK'));
  await assert.rejects(f.inspect({ runner: async () => ({ stdout: Buffer.alloc(2 * 1024 * 1024 + 1) }) }), /decoded managed preferences exceed/);
});

test('MCP-policy directory listing errors and concurrent policy changes fail the snapshot', async () => {
  const f = await fixture(); await mkdir(f.dropIns);
  await assert.rejects(f.inspect({ io: { lstat, open, readdir: async () => { throw new Error('DO_NOT_LEAK'); } } }),
    error => /could not be listed/.test(error.message) && !error.message.includes('DO_NOT_LEAK'));
  await writeFile(f.managed, '{}'); await writeFile(f.paths.mdmDevicePlist, 'synthetic plist');
  await assert.rejects(f.inspect({ runner: async () => { await writeFile(f.managed, '{"changed":true}'); return { stdout: '{}' }; } }),
    /sources changed during/);
});

test('metadata snapshots change when policy content changes and unsupported namespaces fail closed', async () => {
  const f = await fixture(); await writeFile(f.managed, '{}');
  const before = await f.inspect(); await writeFile(f.managed, '{"changed":true}');
  assert.notDeepEqual(await f.inspect(), before);
  await assert.rejects(f.inspect({ platform: 'linux' }), /supports macOS only/);
  await assert.rejects(f.inspect({ paths: { managedDirectory: f.paths.managedDirectory } }), /complete and absolute/);
});

test('unrelated Claude runtime files do not masquerade as changed policy inputs', async () => {
  const f = await fixture(), before = await f.inspect();
  await writeFile(join(f.claudeHome, 'unrelated-runtime.json'), '{"runtime":true}');
  assert.deepEqual(await f.inspect(), before);
});

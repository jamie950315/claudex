import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopOwnsSession, readDesktopSessionMappings } from '../src/desktop.mjs';
import { nativeDrivers } from '../src/native-drivers.mjs';

test('desktop ownership includes archived native records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-guard-'));
  const id = randomUUID();
  const directory = join(root, 'account', 'organization');
  await mkdir(directory, { recursive: true });
  assert.equal(await desktopOwnsSession(root, id), false);
  await writeFile(join(directory, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, isArchived: true }));
  assert.equal(await desktopOwnsSession(root, id), true);
  assert.equal(await desktopOwnsSession(root, randomUUID()), false);
  assert.equal(await desktopOwnsSession(null, id), false);
  assert.equal(await desktopOwnsSession(join(root, 'missing'), id), false);
});

test('Desktop New session ownership uses the distinct CLI identity, even when archived', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-guard-'));
  const desktopId = randomUUID(), cliId = randomUUID();
  const directory = join(root, 'account', 'organization');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `local_${desktopId}.json`);
  for (const isArchived of [false, true]) {
    await writeFile(path, JSON.stringify({ sessionId: `local_${desktopId}`, cliSessionId: cliId, isArchived }));
    assert.equal(await desktopOwnsSession(root, cliId), true);
    assert.equal(await desktopOwnsSession(root, desktopId), true);
    assert.equal(await desktopOwnsSession(root, randomUUID()), false);
  }
  // Historical filename evidence is still sufficient to deny retirement.
  await writeFile(path, '{}');
  assert.equal(await desktopOwnsSession(root, desktopId), true);
});

test('desktop ownership refuses malformed, ambiguous and oversized registry records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-guard-'));
  const desktopId = randomUUID(), cliId = randomUUID();
  const path = join(root, `local_${desktopId}.json`);
  for (const contents of ['{', 'null', '[]', '{}',
    JSON.stringify({ sessionId: `local_${randomUUID()}`, cliSessionId: cliId }),
    JSON.stringify({ sessionId: `local_${desktopId}`, cliSessionId: '../invalid' })]) {
    await writeFile(path, contents);
    await assert.rejects(desktopOwnsSession(root, cliId), /Malformed|Ambiguous/);
  }
  await writeFile(path, ' '.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(desktopOwnsSession(root, cliId), /bounded/);
});

test('registry records without any CLI identity are skipped, not ambiguous', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-desktop-guard-')));
  const unstartedId = randomUUID(), desktopId = randomUUID(), cliId = randomUUID();
  const record = { cwd: '/tmp', title: 'Native title', lastActivityAt: 100, isArchived: false };
  await writeFile(join(root, `local_${unstartedId}.json`), JSON.stringify({ ...record, sessionId: `local_${unstartedId}` }), { mode: 0o600 });
  await writeFile(join(root, `local_${desktopId}.json`),
    JSON.stringify({ ...record, sessionId: `local_${desktopId}`, cliSessionId: cliId }), { mode: 0o600 });
  for (const cliSessionId of [undefined, null]) {
    await writeFile(join(root, `local_${unstartedId}.json`),
      JSON.stringify({ ...record, sessionId: `local_${unstartedId}`, cliSessionId }), { mode: 0o600 });
    assert.equal(await desktopOwnsSession(root, cliId), true);
    assert.equal(await desktopOwnsSession(root, randomUUID()), false);
    // The filename still protects that Desktop identity itself.
    assert.equal(await desktopOwnsSession(root, unstartedId), true);
    const mappings = await readDesktopSessionMappings(root, [cliId, unstartedId]);
    assert.deepEqual([...mappings.keys()], [cliId]);
    assert.equal(mappings.get(cliId).sessionId, `local_${desktopId}`);
  }
  for (const cliSessionId of ['', 'invalid', 7]) {
    await writeFile(join(root, `local_${unstartedId}.json`),
      JSON.stringify({ ...record, sessionId: `local_${unstartedId}`, cliSessionId }), { mode: 0o600 });
    await assert.rejects(readDesktopSessionMappings(root, [cliId]), /Ambiguous/);
    await assert.rejects(desktopOwnsSession(root, randomUUID()), /Ambiguous/);
  }
  await writeFile(join(root, `local_${unstartedId}.json`), JSON.stringify({ ...record, sessionId: `local_${randomUUID()}` }), { mode: 0o600 });
  await assert.rejects(readDesktopSessionMappings(root, [cliId]), /Ambiguous/);
});

test('desktop ownership refuses non-regular and symlinked registry records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-guard-'));
  const directory = join(root, 'directory');
  await mkdir(directory);
  await mkdir(join(directory, `local_${randomUUID()}.json`));
  await assert.rejects(desktopOwnsSession(directory, randomUUID()), /regular file/);
  const linked = join(root, 'linked');
  await mkdir(linked);
  await symlink(join(directory, 'missing'), join(linked, `local_${randomUUID()}.json`));
  await assert.rejects(desktopOwnsSession(linked, randomUUID()), /Symlinked/);
});

test('desktop ownership fails safely on symlinked stores and invalid identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-guard-'));
  const store = join(root, 'store');
  await mkdir(store);
  await symlink(store, join(root, 'linked'));
  await assert.rejects(desktopOwnsSession(join(root, 'linked'), randomUUID()), /Symlinked/);
  await assert.rejects(desktopOwnsSession(store, '../escape'), /Invalid/);
});

test('native Claude adapter refuses retirement of desktop-adopted transcripts', { skip: process.env.CLAUDEX_NATIVE_TEST !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-native-'));
  const id = randomUUID();
  const desktopHome = join(root, 'desktop');
  await mkdir(join(desktopHome, 'account', 'org'), { recursive: true });
  await writeFile(join(desktopHome, 'account', 'org', `local_${id}.json`), '{}');
  const native = await nativeDrivers({ root: join(root, 'state'), codexHome: join(root, 'codex'), claudeHome: join(root, 'claude'), desktopHome });
  try {
    await assert.rejects(native.drivers.claude.assertIdle({ nativeId: id }), /Claude Desktop owns/);
    await assert.rejects(native.drivers.claude.hide({ nativeId: id }), /Claude Desktop owns/);
    await assert.rejects(native.drivers.claude.remove({ nativeId: id }), /Claude Desktop owns/);
  } finally { await native.close(); }
});

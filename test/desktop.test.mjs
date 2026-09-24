import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopOwnsSession } from '../src/desktop.mjs';
import { nativeDrivers } from '../src/native-drivers.mjs';

test('desktop ownership includes archived native records without reading private content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-desktop-guard-'));
  const id = randomUUID();
  const directory = join(root, 'account', 'organization');
  await mkdir(directory, { recursive: true });
  assert.equal(await desktopOwnsSession(root, id), false);
  await writeFile(join(directory, `local_${id}.json`), JSON.stringify({ isArchived: true }));
  assert.equal(await desktopOwnsSession(root, id), true);
  assert.equal(await desktopOwnsSession(root, randomUUID()), false);
  assert.equal(await desktopOwnsSession(null, id), false);
  assert.equal(await desktopOwnsSession(join(root, 'missing'), id), false);
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

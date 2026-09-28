import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { APP_IDENTIFIER, APP_ICON_FILE, ENGINE_BIN, ENGINE_SRC, buildClaudexApp, buildAppIcon } from '../src/app-bundle.mjs';

test('engine allowlist covers current runtime sources without including tooling', async () => {
  const source = resolve(import.meta.dirname, '..');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual([...ENGINE_BIN].sort(), (await readdir(join(source, 'bin'))).filter(name => name !== 'build-claudex-app.mjs').sort());
  assert.deepEqual([...ENGINE_SRC].sort(), (await readdir(join(source, 'src'))).filter(name => name !== 'app-bundle.mjs').sort());
  assert.equal(APP_IDENTIFIER, 'dev.0ruka.claudex.app');
});

test('approved app artwork builds a complete native icon resource', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-icon-test-'));
  const resources = join(root, 'Resources');
  await mkdir(resources);
  const icon = await buildAppIcon(resolve(import.meta.dirname, '..'), resources, root);
  assert.equal(icon, join(resources, APP_ICON_FILE));
  const bytes = await readFile(icon);
  assert.equal(bytes.subarray(0, 4).toString(), 'icns');
  assert.equal(bytes.readUInt32BE(4), bytes.length);
  const builder = await readFile(new URL('../src/app-bundle.mjs', import.meta.url), 'utf8');
  assert.match(builder, /CFBundleIconFile/);
});

test('builder rejects an existing output without touching it', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-app-test-'));
  const app = join(root, 'Existing.app');
  await mkdir(app);
  await writeFile(join(app, 'sentinel'), 'keep');
  await assert.rejects(buildClaudexApp({ sourceRoot: resolve(import.meta.dirname, '..'), destination: app,
    nodeDistribution: root, identity: 'test' }), /Destination already exists/);
  assert.equal(await readFile(join(app, 'sentinel'), 'utf8'), 'keep');
});

test('builder rejects nonportable Node dependencies before staging', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-app-test-'));
  const distribution = join(root, 'node');
  await mkdir(join(distribution, 'bin'), { recursive: true });
  await mkdir(join(distribution, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
  await writeFile(join(distribution, 'bin', 'node'), 'fake');
  await writeFile(join(distribution, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'fake');
  await writeFile(join(distribution, 'LICENSE'), 'test');
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command.endsWith('/lipo')) return { stdout: 'arm64\n' };
    if (command.endsWith('/otool')) return { stdout: `${join(distribution, 'bin', 'node')}:\n  /opt/homebrew/opt/icu4c/lib/libicu.dylib (compatibility version 1.0.0)\n` };
    throw new Error('Unexpected command');
  };
  await assert.rejects(buildClaudexApp({ sourceRoot: resolve(import.meta.dirname, '..'), destination: join(root, 'Claudex.app'),
    nodeDistribution: distribution, identity: 'test', run }), /non-system library/);
  assert.equal(calls.length, 2);
});

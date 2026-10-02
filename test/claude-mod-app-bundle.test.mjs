import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_BIN, ENGINE_SRC, ENGINE_PLUGIN_FILES, copyAllowed } from '../src/app-bundle.mjs';
import { MOD_STAGE_FILES, stageClaudeMod } from '../src/claude-mod-install.mjs';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
async function scratch(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-mod-app-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(root) {
  const source = join(root, 'source');
  for (const name of [...ENGINE_BIN.map(n => `bin/${n}`), ...ENGINE_SRC.map(n => `src/${n}`), ...ENGINE_PLUGIN_FILES, 'package.json', 'package-lock.json']) {
    const file = join(source, name); await mkdir(dirname(file), { recursive: true });
    await writeFile(file, name.endsWith('/locales.mjs') ? await readFile(join(repo, name)) : '{}\n');
  }
  return source;
}
test('app engine includes every companion dependency through explicit allowlists', () => {
  const allowed = new Set([...ENGINE_BIN.map(n => `bin/${n}`), ...ENGINE_SRC.map(n => `src/${n}`), ...ENGINE_PLUGIN_FILES]);
  for (const name of [...MOD_STAGE_FILES, 'bin/claudex-mod.mjs', 'src/claude-mod-install.mjs']) assert.ok(allowed.has(name), name);
  assert.deepEqual([...ENGINE_PLUGIN_FILES].sort(), MOD_STAGE_FILES.filter(n => n.startsWith('plugins/')).sort());
  assert.equal(new Set(ENGINE_PLUGIN_FILES).size, ENGINE_PLUGIN_FILES.length);
});
test('copied app engine can stage the companion using only its packaged sources', async t => {
  const root = await scratch(t), engine = join(root, 'engine'), stateRoot = join(root, 'state');
  await mkdir(engine); await mkdir(stateRoot, { mode: 0o700 });
  await copyAllowed(repo, engine);
  for (const name of ENGINE_PLUGIN_FILES) assert.deepEqual(await readFile(join(engine, name)), await readFile(join(repo, name)));
  const result = await stageClaudeMod({ output: join(root, 'stage'), stateRoot, repoRoot: engine, nodeBinary: await realpath(process.execPath) });
  assert.equal(result.nativeWake, false);
  assert.equal(result.automaticInstallation, false);
  assert.equal(result.synchronizationPolicy, 'unchanged');
  assert.ok(existsSync(join(engine, 'bin', 'claudex-mod.mjs')));
  assert.equal(existsSync(join(engine, 'test')), false);
  assert.equal(existsSync(join(engine, 'dev')), false);
});
test('app resource copy excludes unlisted local plugin files', async t => {
  const root = await scratch(t), source = await fixture(root), engine = join(root, 'engine');
  await mkdir(engine);
  await writeFile(join(source, 'plugins/claudex/private-local.json'), 'private fixture\n');
  await copyAllowed(source, engine);
  assert.equal(existsSync(join(engine, 'plugins/claudex/private-local.json')), false);
});
test('app resource copy rejects a symlinked plugin source directory', async t => {
  const root = await scratch(t), source = await fixture(root), engine = join(root, 'engine');
  await mkdir(engine);
  const plugin = join(source, 'plugins/claudex');
  await rm(plugin, { recursive: true });
  const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, plugin);
  await assert.rejects(copyAllowed(source, engine), /Unsafe plugin source directory/);
});

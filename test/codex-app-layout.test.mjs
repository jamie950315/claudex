import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, unlink, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { resolveBundledCodex, bundledDesktopNode, isBundledCodexRelocation, verifyBundledCodex } from '../src/codex-app-layout.mjs';
import { installDesktopLauncher, applyDesktopEnvironment } from '../src/desktop-install.mjs';

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cldx-app-layout-')));
  const app = join(dir, 'Synthetic.app'), resources = join(app, 'Contents', 'Resources');
  await mkdir(resources, { recursive: true });
  const flat = join(resources, 'codex'), target = join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
  await writeFile(flat, '#!/bin/sh\nexit 0\n'); await chmod(flat, 0o700);
  const installPackage = async () => {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '#!/bin/sh\nexit 0\n'); await chmod(target, 0o700);
    await writeFile(join(resources, 'codex-cli', 'codex-package.json'), JSON.stringify({
      layoutVersion: 1, variant: 'codex', entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path',
    }));
  };
  return { dir, app, resources, flat, target, installPackage };
}

test('observed app layouts resolve only the signed nested native executable', async () => {
  const f = await fixture(); let checked;
  assert.equal(await resolveBundledCodex(f.flat), f.flat);
  await f.installPackage(); await unlink(f.flat);
  assert.equal(await resolveBundledCodex(f.flat, { verify: async path => { checked = path; } }), f.target);
  assert.equal(checked, f.target);
  assert.equal(bundledDesktopNode(f.target), join(f.resources, 'cua_node', 'bin', 'node'));
  assert.equal(isBundledCodexRelocation(f.flat, f.target), true);
  assert.equal(isBundledCodexRelocation(f.flat, f.target.replace('Synthetic.app', 'Different.app')), false);
  await assert.rejects(resolveBundledCodex(f.flat, { verify: async () => { throw new Error('Wrong signer'); } }), /Wrong signer/);
});

test('unknown package metadata never selects an old executable as a silent alternative', async () => {
  const f = await fixture(); await f.installPackage();
  await writeFile(join(f.resources, 'codex-cli', 'codex-package.json'), '{"layoutVersion":2}');
  await assert.rejects(resolveBundledCodex(f.flat, { verify: async () => {} }), /not supported/);
});

test('owned next-launch configuration upgrades a relocated CLI and preserves the signed Node choice', async () => {
  const f = await fixture(); const root = join(f.dir, 'root'); let environment = '';
  const run = async (_, args) => { if (args[0] === 'setenv') environment = args[2]; return { stdout: args[0] === 'getenv' ? environment : '' }; };
  const verifyRuntime = async () => {}, verifyBinary = async () => {};
  await installDesktopLauncher({ root, binary: f.flat, node: process.execPath,
    launcher: new URL('../bin/claudex-codex.mjs', import.meta.url).pathname, platform: 'darwin', run, verifyRuntime, verifyBinary });
  await f.installPackage(); await unlink(f.flat);
  await applyDesktopEnvironment({ root, run, verifyRuntime, verifyBinary });
  const state = JSON.parse(await readFile(join(root, 'desktop-launcher.json'), 'utf8'));
  assert.equal(state.binary, f.target); assert.equal(state.node, process.execPath); assert.equal(state.pendingRuntime, undefined);
  assert.match(await readFile(state.shim, 'utf8'), /CodexCLI\.app\/Contents\/MacOS\/codex/);
  assert.equal(environment, state.shim);
});

test('relocation signature verification requires the native Codex identifier and OpenAI team', async () => {
  const verify = text => verifyBundledCodex('/synthetic/codex', async (_, args) => ({ stderr: args[0] === '-d' ? text : '' }));
  await verify('Identifier=codex\nTeamIdentifier=2DC432GLL2\n');
  await assert.rejects(verify('Identifier=codex\nTeamIdentifier=OTHER\n'), /OpenAI-signed/);
  await assert.rejects(verify('Identifier=node\nTeamIdentifier=2DC432GLL2\n'), /OpenAI-signed/);
});

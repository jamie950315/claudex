import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopShim, verifyDesktopNode, installDesktopLauncher, applyDesktopEnvironment, uninstallDesktopLauncher } from '../src/desktop-install.mjs';
import { readJSON, writeJSON, hash } from '../src/storage.mjs';
const verifyRuntime = async () => {};

test('launcher quotes fixed paths and preserves original arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), "cldx-shim-'"));
  const path = join(root, 'shim');
  const probe = join(root, 'probe.mjs');
  await writeFile(probe, 'console.log(JSON.stringify({args:process.argv.slice(2),root:process.env.CLAUDEX_HOME}));');
  await writeFile(path, desktopShim({ root, node: process.execPath, launcher: probe, binary: '/bin/true' }));
  const { stdout } = await promisify(execFile)('/bin/sh', [path, 'app-server', '--config', 'a=b $(not-executed)']);
  assert.deepEqual(JSON.parse(stdout), { args: ['app-server', '--config', 'a=b $(not-executed)'], root });
});

test('next-launch install is idempotent, restored after login, and reversibly removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-install-'));
  let value = ''; const calls = [];
  const run = async (command, args) => {
    assert.equal(command, 'launchctl'); calls.push(args[0]);
    if (args[0] === 'setenv') value = args[2];
    if (args[0] === 'unsetenv') value = '';
    return { stdout: args[0] === 'getenv' ? value : '' };
  };
  const options = { root, node: process.execPath, launcher: new URL('../bin/claudex-codex.mjs', import.meta.url).pathname, binary: process.execPath, platform: 'darwin', run, verifyRuntime };
  const installed = await installDesktopLauncher(options);
  assert.equal(installed.appRestarted, false);
  assert.deepEqual(await installDesktopLauncher(options), installed);
  value = ''; await applyDesktopEnvironment({ root, run, verifyRuntime }); assert.equal(value, installed.shim);
  assert.equal((await uninstallDesktopLauncher({ root, run })).conversationDataPreserved, true);
  assert.equal(value, '');
  assert.ok(!calls.includes('kill'));
  await assert.rejects(readFile(installed.shim), { code: 'ENOENT' });
});

test('an existing override and an altered shim are preserved, not replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-install-conflict-'));
  let value = '/existing-launcher';
  const run = async (_, args) => { if (args[0] === 'setenv') value = args[2]; return { stdout: args[0] === 'getenv' ? value : '' }; };
  const options = { root, node: process.execPath, launcher: new URL('../bin/claudex-codex.mjs', import.meta.url).pathname, binary: process.execPath, platform: 'darwin', run, verifyRuntime };
  await assert.rejects(installDesktopLauncher(options), /existing CODEX_CLI_PATH/);
  value = '';
  const { shim } = await installDesktopLauncher(options);
  await writeFile(shim, 'changed');
  await assert.rejects(applyDesktopEnvironment({ root, run, verifyRuntime }), /ownership changed/);
  await assert.rejects(uninstallDesktopLauncher({ root, run }), /ownership changed/);
  assert.equal(await readFile(shim, 'utf8'), 'changed');
});

test('desktop runtime verification rejects ad-hoc or other-team Node identities', async () => {
  const check = identity => verifyDesktopNode('/synthetic/node', async (_, args) => ({ stdout: '', stderr: args[0] === '-d' ? identity : '' }));
  await check('Identifier=node\nTeamIdentifier=2DC432GLL2\n');
  await assert.rejects(check('Identifier=node\nTeamIdentifier=not set\n'), /OpenAI-signed/);
  await assert.rejects(check('Identifier=node\nTeamIdentifier=another-team\n'), /OpenAI-signed/);
});

test('an exact owned launcher runtime upgrade recovers its journal without restarting apps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-runtime-upgrade-'));
  let value = '';
  const run = async (_, args) => { if (args[0] === 'setenv') value = args[2]; return { stdout: args[0] === 'getenv' ? value : '' }; };
  const options = { root, node: process.execPath, binary: process.execPath,
    launcher: new URL('../bin/claudex-codex.mjs', import.meta.url).pathname, platform: 'darwin', run, verifyRuntime };
  const first = await installDesktopLauncher(options);
  const old = await readJSON(join(root, 'desktop-launcher.json'));
  const content = desktopShim({ ...options, root: dirname(first.shim), node: '/bin/sh' });
  const next = { ...old, node: '/bin/sh', shimHash: hash(content) };
  await writeJSON(join(root, 'desktop-launcher.json'), { ...old, pendingRuntime: next });
  await applyDesktopEnvironment({ root, run, verifyRuntime });
  assert.deepEqual(await readJSON(join(root, 'desktop-launcher.json')), next);
  assert.equal(await readFile(first.shim, 'utf8'), content);
  const installed = await installDesktopLauncher(options);
  assert.equal(installed.appRestarted, false);
  assert.equal((await readJSON(join(root, 'desktop-launcher.json'))).node, process.execPath);
});

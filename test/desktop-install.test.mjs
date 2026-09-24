import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopShim, installDesktopLauncher, applyDesktopEnvironment, uninstallDesktopLauncher } from '../src/desktop-install.mjs';

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
  const options = { root, node: process.execPath, launcher: new URL('../bin/claudex-codex.mjs', import.meta.url).pathname, binary: process.execPath, platform: 'darwin', run };
  const installed = await installDesktopLauncher(options);
  assert.equal(installed.appRestarted, false);
  assert.deepEqual(await installDesktopLauncher(options), installed);
  value = ''; await applyDesktopEnvironment({ root, run }); assert.equal(value, installed.shim);
  assert.equal((await uninstallDesktopLauncher({ root, run })).conversationDataPreserved, true);
  assert.equal(value, '');
  assert.ok(!calls.includes('kill'));
  await assert.rejects(readFile(installed.shim), { code: 'ENOENT' });
});

test('an existing override and an altered shim are preserved, not replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-install-conflict-'));
  let value = '/existing-launcher';
  const run = async (_, args) => { if (args[0] === 'setenv') value = args[2]; return { stdout: args[0] === 'getenv' ? value : '' }; };
  const options = { root, launcher: new URL('../bin/claudex-codex.mjs', import.meta.url).pathname, binary: process.execPath, platform: 'darwin', run };
  await assert.rejects(installDesktopLauncher(options), /existing CODEX_CLI_PATH/);
  value = '';
  const { shim } = await installDesktopLauncher(options);
  await writeFile(shim, 'changed');
  await assert.rejects(applyDesktopEnvironment({ root, run }), /ownership changed/);
  await assert.rejects(uninstallDesktopLauncher({ root, run }), /ownership changed/);
  assert.equal(await readFile(shim, 'utf8'), 'changed');
});

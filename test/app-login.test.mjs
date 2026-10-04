import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { appLaunchDefinition, installAppLogin } from '../src/app-login.mjs';
import { statusAppPaths, statusLaunchDefinition, installStatusApp } from '../src/status-app-install.mjs';

async function fixture(t, { legacy = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-unified-login-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state'), home = join(base, 'home'), appPath = join(base, 'Claudex.app');
  await mkdir(root, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(appPath, 'Contents', 'MacOS', 'ClaudexApp'), 'synthetic unified app');
  const calls = [], state = { loaded: legacy, running: legacy, legacyMismatch: false, appJobMismatch: false, refuseQuit: false };
  const paths = statusAppPaths(root, home), legacyDefinition = statusLaunchDefinition({ root, home });
  const definition = appLaunchDefinition({ root, home, appPath });
  if (legacy) {
    await mkdir(paths.directory, { mode: 0o700 }); await mkdir(paths.artifacts, { mode: 0o700 });
    await mkdir(join(paths.app, 'Contents', 'MacOS'), { recursive: true, mode: 0o700 });
    await chmod(join(paths.app, 'Contents'), 0o700); await chmod(join(paths.app, 'Contents', 'MacOS'), 0o700);
    const executable = Buffer.from('synthetic legacy app');
    await writeFile(paths.executable, executable, { mode: 0o700 });
    const manifest = { version: 1, root, bundleId: paths.label,
      tree: { directories: ['', 'Contents', 'Contents/MacOS'], files: [{ path: 'Contents/MacOS/ClaudexStatus', sha256: createHash('sha256').update(executable).digest('hex'), mode: 0o700 }] } };
    const bytes = `${JSON.stringify(manifest)}\n`, id = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(paths.artifacts, `${id}.json`), bytes, { mode: 0o600 });
    await writeFile(paths.journal, JSON.stringify({ version: 1, root, app: paths.app, label: paths.label, launchAgent: paths.launchAgent, current: id, previous: null, pending: null }), { mode: 0o600 });
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(paths.launchAgent, legacyDefinition.plist, { mode: 0o600 });
  }
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === '/usr/bin/codesign') return { stdout: '', stderr: args[0] === '-d' ? 'Identifier=dev.0ruka.claudex.app\nAuthority=Apple Development: Test\nTeamIdentifier=TESTTEAM00\n' : '' };
    if (command === '/usr/bin/plutil') return { stdout: 'OK', stderr: '' };
    if (command === '/usr/bin/osascript') {
      if (state.refuseQuit) throw new Error('Legacy display is still running.');
      assert.match(args.at(-1), /NSRunningApplication/); assert.match(args.at(-1), /\.terminate/);
      assert.ok(args.at(-1).includes(JSON.stringify(paths.app)));
      // The native JXA bridge returns NSArray.count as a string, including "0".
      const app = { bundleURL: { path: paths.app }, get terminate() { state.running = false; return true; } };
      runInNewContext(args.at(-1), { ObjC: { import() {}, unwrap: value => value },
        $: { NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({
          count: state.running ? '1' : '0', objectAtIndex: () => app,
        }) } }, delay() { throw new Error('The exited display must not enter the wait loop.'); } });
      return { stdout: '', stderr: '' };
    }
    if (command === '/usr/sbin/lsof') throw Object.assign(new Error('none'), { code: 1, stdout: '', stderr: '' });
    if (command === '/bin/launchctl') {
      if (args[0] === 'print') {
        if (args[1].endsWith(definition.label)) {
          if (state.appJobMismatch) return { stdout: 'program = /foreign/app', stderr: '' };
        } else if (state.loaded) return { stdout: `path = ${paths.launchAgent}\nprogram = ${state.legacyMismatch ? '/foreign/app' : paths.executable}\narguments = {\n${paths.executable}\n--root\n${root}\n}\nstate = ${state.running ? 'running' : 'not running'}`, stderr: '' };
        throw Object.assign(new Error('No such process'), { stderr: 'Could not find service' });
      }
      assert.equal(args[0], 'bootout'); assert.ok(args[1].endsWith(paths.label));
      assert.equal(state.running, false); state.loaded = false;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected synthetic command: ${command}`);
  };
  return { root, home, appPath, paths, definition, legacyDefinition, calls, state, run, platform: 'darwin' };
}

test('one unified login entry starts quietly and never launches model or service work', async t => {
  const options = await fixture(t);
  const result = await installAppLogin(options);
  assert.equal(result.loginStart, true); assert.equal(result.synchronizationRestarted, false);
  assert.equal(await readFile(options.definition.path, 'utf8'), options.definition.plist);
  assert.match(options.definition.plist, /--background/);
  assert.doesNotMatch(options.definition.plist, /KeepAlive|watch|claudex\.mjs/);
  assert.ok(!options.calls.some(call => ['bootstrap', 'kickstart', 'kill'].includes(call[1])));
  await installAppLogin(options);
});

test('trusted application ownership still refuses unsafe bundles and private login state before native work', async t => {
  for (const kind of ['bundle-write', 'executable-write', 'bundle-link', 'executable-link', 'private-root-write']) await t.test(kind, async t => {
    const options = await fixture(t);
    const executable = join(options.appPath, 'Contents', 'MacOS', 'ClaudexApp');
    if (kind === 'bundle-write') await chmod(options.appPath, 0o775);
    if (kind === 'executable-write') await chmod(executable, 0o775);
    if (kind === 'private-root-write') await chmod(options.root, 0o755);
    if (kind === 'bundle-link' || kind === 'executable-link') {
      const path = kind === 'bundle-link' ? options.appPath : executable;
      await rename(path, `${path}.original`);
      await symlink(`${path}.original`, path);
    }
    await assert.rejects(installAppLogin(options), /not an owned bundle|state must be private and owned/);
    assert.deepEqual(options.calls, []);
    await assert.rejects(readFile(options.definition.path), { code: 'ENOENT' });
    await assert.rejects(readFile(join(options.root, 'app-login.json')), { code: 'ENOENT' });
  });
});

test('application login retains strict signature and identity verification for protected bundles', async t => {
  for (const kind of ['verification', 'identifier', 'authority', 'team']) await t.test(kind, async t => {
    const options = await fixture(t);
    const run = async (command, args) => {
      const result = await options.run(command, args);
      if (command === '/usr/bin/codesign' && args[0] === '--verify' && kind === 'verification') throw new Error('Strict signature verification failed.');
      if (command === '/usr/bin/codesign' && args[0] === '-d') {
        const expected = { identifier: 'Identifier=dev.0ruka.claudex.app', authority: 'Authority=Apple Development: Test', team: 'TeamIdentifier=TESTTEAM00' };
        result.stderr = result.stderr.replace(expected[kind], `${kind}=foreign`);
      }
      return result;
    };
    await assert.rejects(installAppLogin({ ...options, run }), /signature.*verif/i);
    assert.ok(options.calls.every(call => call[0] === '/usr/bin/codesign'));
    await assert.rejects(readFile(options.definition.path), { code: 'ENOENT' });
  });
});

test('migration quits only verified legacy display, disables its login entry and preserves artifacts', async t => {
  const options = await fixture(t, { legacy: true });
  const before = await readFile(options.paths.executable);
  await installAppLogin(options);
  assert.equal(options.state.loaded, false); assert.equal(options.state.running, false);
  assert.equal(await readFile(join(options.paths.directory, 'login-disabled.plist'), 'utf8'), options.legacyDefinition.plist);
  await assert.rejects(readFile(options.paths.launchAgent), { code: 'ENOENT' });
  assert.deepEqual(await readFile(options.paths.executable), before);
  assert.ok(options.calls.findIndex(call => call[0] === '/usr/bin/osascript') < options.calls.findIndex(call => call[1] === 'bootout'));
  await installAppLogin(options);
  await assert.rejects(installStatusApp(options), /unified Claudex app already provides status/);
});

test('foreign login jobs and altered legacy artifacts are preserved before UI termination', async t => {
  for (const kind of ['plist', 'legacy-job', 'app-job', 'artifact']) await t.test(kind, async t => {
    const options = await fixture(t, { legacy: true });
    if (kind === 'plist') await writeFile(options.paths.launchAgent, 'foreign');
    if (kind === 'legacy-job') options.state.legacyMismatch = true;
    if (kind === 'app-job') options.state.appJobMismatch = true;
    if (kind === 'artifact') await writeFile(options.paths.executable, 'changed');
    await assert.rejects(installAppLogin(options), /differs|ownership changed/);
    assert.ok(!options.calls.some(call => call[0] === '/usr/bin/osascript' || call[1] === 'bootout'));
    assert.equal(options.state.loaded, true);
  });
});

test('refused native display quit leaves legacy startup recoverable and does not stop services', async t => {
  const options = await fixture(t, { legacy: true }); options.state.refuseQuit = true;
  await assert.rejects(installAppLogin(options), /still running/);
  assert.equal(await readFile(options.paths.launchAgent, 'utf8'), options.legacyDefinition.plist);
  assert.equal(options.state.loaded, true);
  assert.ok(!options.calls.some(call => call[1] === 'bootout'));
});

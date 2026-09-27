import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { installStatusApp, statusStatusApp, statusAppPaths, statusLaunchDefinition } from '../src/status-app-install.mjs';

const identity = '1'.repeat(40);
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cldx-status-app-')));
  const root = join(directory, 'root'), home = join(directory, 'home'), sourcesPath = join(directory, 'sources');
  await Promise.all([root, home, sourcesPath].map(path => mkdir(path, { mode: 0o700 })));
  await Promise.all(['StatusModel.swift', 'main.swift'].map(name => writeFile(join(sourcesPath, name), `// ${name}\n`)));
  const calls = [], state = { loaded: false, running: false, open: false, builds: 0 };
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith('/security')) return { stdout: `  1) ${identity} "Apple Development: Fixture (TESTUSER00)"\n`, stderr: '' };
    if (command.endsWith('/xcrun')) { state.builds++; await writeFile(args.at(-1), `synthetic executable ${state.builds}`); return { stdout: '', stderr: '' }; }
    if (command.endsWith('/codesign')) {
      if (args[0] === '--force') {
        const path = join(args.at(-1), 'Contents', '_CodeSignature'); await mkdir(path);
        await writeFile(join(path, 'CodeResources'), 'synthetic signature');
      }
      return { stdout: '', stderr: args[0] === '-d' ? `Identifier=${statusAppPaths(root).label}\nAuthority=Apple Development: Fixture (TESTUSER00)\nTeamIdentifier=TESTTEAM00\n` : '' };
    }
    if (command.endsWith('/launchctl')) {
      if (args[0] === 'print') {
        if (!state.loaded) throw Object.assign(new Error('No such process'), { stderr: 'Could not find service' });
        const paths = statusAppPaths(root, home);
        return { stdout: `path = ${paths.launchAgent}\nprogram = ${paths.executable}\narguments = {\n  ${paths.executable}\n  --root\n  ${root}\n}\nstate = ${state.running ? 'running' : 'not running'}`, stderr: '' };
      }
      assert.ok(['bootstrap', 'kickstart'].includes(args[0]));
      await assert.rejects(lstat(statusAppPaths(root, home).lock), { code: 'ENOENT' });
      state.loaded = true; state.running = true;
      return { stdout: '', stderr: '' };
    }
    if (command.endsWith('/lsof')) {
      if (state.open) return { stdout: '12345\n', stderr: '' };
      throw Object.assign(new Error('none'), { code: 1, stdout: '', stderr: '' });
    }
    assert.equal(command, '/usr/bin/plutil');
    return { stdout: 'OK', stderr: '' };
  };
  return { root, home, sourcesPath, identity, run, platform: 'darwin', calls, state };
}

test('status launch definition is independent, root-specific and quits normally without restarting', () => {
  const definition = statusLaunchDefinition({ root: '/private/test & status', home: '/private/test-user' });
  assert.match(definition.plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(definition.plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(definition.plist, /test &amp; status/);
  assert.match(definition.plist, /<string>--root<\/string>/);
  assert.doesNotMatch(definition.plist, /claudex\.mjs|watch|packet-key|CODEX_CLI_PATH/);
  assert.notEqual(definition.label, statusLaunchDefinition({ root: '/private/other', home: '/private/test-user' }).label);
});

test('signed status app installs idempotently and starts only after the install lock is released', async () => {
  const options = await fixture();
  const result = await installStatusApp(options);
  assert.equal(result.running, true); assert.equal(result.synchronizationRestarted, false);
  assert.equal(options.state.builds, 1);
  assert.equal((await installStatusApp(options)).artifact, result.artifact);
  assert.equal(options.state.builds, 1);
  const state = await statusStatusApp(options);
  assert.equal(state.installed, true); assert.equal(state.loginStart, true);
  assert.equal((await lstat(statusAppPaths(options.root, options.home).executable)).mode & 0o777, 0o700);
  const meta = await readFile(join(result.app, 'Contents', 'Info.plist'), 'utf8');
  assert.match(meta, /<key>LSUIElement<\/key><true\/>/);
  assert.ok(meta.includes(options.root));
  assert.ok(!options.calls.some(call => call.includes('kill') || call.includes('-k') || call.includes('bootout')));
});

test('owned app upgrade requires complete UI exit and retains one verified previous artifact', async () => {
  const options = await fixture();
  const first = await installStatusApp(options);
  await writeFile(join(options.sourcesPath, 'main.swift'), '// updated app\n');
  await assert.rejects(installStatusApp(options), /Quit Claudex Status/);
  assert.equal(options.state.builds, 1);
  options.state.running = false; options.state.open = true;
  await assert.rejects(installStatusApp(options), /executable is still in use/);
  options.state.open = false;
  const updated = await installStatusApp(options);
  assert.notEqual(first.artifact, updated.artifact);
  const paths = statusAppPaths(options.root, options.home);
  assert.equal(await readFile(join(paths.previous, 'Contents', 'MacOS', 'ClaudexStatus'), 'utf8'), 'synthetic executable 1');
  await writeFile(join(options.sourcesPath, 'main.swift'), '// third app\n');
  options.state.running = false;
  await installStatusApp(options);
  assert.equal(await readFile(join(paths.previous, 'Contents', 'MacOS', 'ClaudexStatus'), 'utf8'), 'synthetic executable 2');
});

test('foreign bundle, altered artifacts, symlinked files and foreign LaunchAgents are never replaced', async t => {
  for (const kind of ['bundle', 'manifest', 'symlink', 'agent']) await t.test(kind, async () => {
    const options = await fixture(); await installStatusApp(options); options.state.running = false;
    const paths = statusAppPaths(options.root, options.home);
    if (kind === 'bundle') await writeFile(paths.executable, 'foreign bytes');
    if (kind === 'manifest') {
      const state = JSON.parse(await readFile(paths.journal));
      await writeFile(join(paths.artifacts, `${state.current}.json`), '{}');
    }
    if (kind === 'symlink') {
      const destination = join(options.root, 'preserved'); await rename(paths.executable, destination); await symlink(destination, paths.executable);
    }
    if (kind === 'agent') await writeFile(paths.launchAgent, 'foreign agent');
    await assert.rejects(installStatusApp(options), /ownership changed|manifest changed|ELOOP|differs/);
    assert.equal(options.state.builds, 1);
  });
});

test('unsafe directory permissions and ambiguous signing identities fail before compilation', async () => {
  const options = await fixture(); await chmod(options.root, 0o755);
  await assert.rejects(installStatusApp(options), /not private and owned/);
  await chmod(options.root, 0o700);
  await assert.rejects(installStatusApp({ ...options, identity: '2'.repeat(40) }), /signing identity was not found/);
  assert.equal(options.state.builds, 0);
});

test('prepared initial app promotion recovers after publication was interrupted', async () => {
  const options = await fixture(); await installStatusApp(options); options.state.running = false;
  const paths = statusAppPaths(options.root, options.home);
  const old = JSON.parse(await readFile(paths.journal));
  const oldArtifactPath = join(paths.artifacts, `${old.current}.json`);
  const artifact = JSON.parse(await readFile(oldArtifactPath));
  const pending = { stage: '11111111-1111-4111-8111-111111111111', artifact: old.current };
  const stageRoot = join(paths.directory, `stage-${pending.stage}`), stage = join(stageRoot, 'Claudex Status.app');
  await mkdir(stageRoot, { mode: 0o700 });
  await rename(paths.app, stage);
  // Reusing the same exact bytes is enough to prove this new-install publish
  // crash path without executing a native program.
  await writeFile(paths.journal, JSON.stringify({ ...old, current: null, pending }), { mode: 0o600 });
  assert.equal((await statusStatusApp(options)).recoveryRequired, true);
  assert.equal((await installStatusApp(options)).artifact, hash(await readFile(oldArtifactPath)));
  assert.deepEqual(JSON.parse(await readFile(oldArtifactPath)), artifact);
  assert.equal(options.state.builds, 1);
});

test('published upgrade recovers without rebuilding or losing the preserved predecessor', async () => {
  const options = await fixture();
  const first = await installStatusApp(options); options.state.running = false;
  await writeFile(join(options.sourcesPath, 'main.swift'), '// upgraded app\n');
  const paths = statusAppPaths(options.root, options.home);
  let fail = true;
  const run = async (command, args) => {
    if (fail && command === '/usr/bin/codesign' && args[0] === '--verify' && args.at(-1) === paths.app
        && await readFile(paths.executable, 'utf8') === 'synthetic executable 2') {
      fail = false; throw new Error('Simulated crash after publishing the new bundle');
    }
    return options.run(command, args);
  };
  await assert.rejects(installStatusApp({ ...options, run }), /Simulated crash/);
  assert.equal((await statusStatusApp(options)).recoveryRequired, true);
  const result = await installStatusApp(options);
  assert.notEqual(result.artifact, first.artifact); assert.equal(options.state.builds, 2);
  assert.equal(await readFile(join(paths.previous, 'Contents', 'MacOS', 'ClaudexStatus'), 'utf8'), 'synthetic executable 1');
});

test('a failed build removes only its exact generated staging contents and permits a corrected build', async () => {
  const options = await fixture();
  const run = async (command, args) => {
    if (command === '/usr/bin/xcrun') throw new Error('Simulated compiler failure');
    return options.run(command, args);
  };
  await assert.rejects(installStatusApp({ ...options, run }), /Simulated compiler failure/);
  assert.equal((await installStatusApp(options)).installed, true);
});

test('a loaded foreign LaunchAgent with the same label is never adopted or restarted', async () => {
  const options = await fixture(); options.state.loaded = true;
  const run = async (command, args) => {
    const result = await options.run(command, args);
    if (command === '/bin/launchctl' && args[0] === 'print') result.stdout = result.stdout.replace('program = ', 'program = /foreign/');
    return result;
  };
  await assert.rejects(installStatusApp({ ...options, run }), /Loaded status LaunchAgent ownership differs/);
  assert.equal(options.state.builds, 0);
});

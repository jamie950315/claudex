import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, lstat, symlink, link, chmod, realpath, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProviders, ensureProviders } from '../src/app-providers.mjs';
import { findAppModRuntime } from '../src/app-mod-runtime.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-providers-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const root = join(base, 'root');
  const runtime = join(base, 'runtime');
  const systemApplications = join(base, 'system-apps');
  for (const path of [home, root, systemApplications, join(runtime, 'bin'),
    join(runtime, 'lib', 'node_modules', 'npm', 'bin')]) await mkdir(path, { recursive: true });
  await writeFile(join(runtime, 'bin', 'node'), '', { mode: 0o755 });
  await writeFile(join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
  return { base, home, root, runtime, systemApplications, env: { PATH: '' } };
}

async function app(home, name) {
  const path = join(home, 'Applications', name);
  await mkdir(path, { recursive: true });
  return path;
}

async function claudePackage(prefix, { hardlink = false, mutate } = {}) {
  const packageName = '@anthropic-ai/claude-code', nativeName = `${packageName}-${process.platform}-${process.arch}`;
  const wrapperRoot = join(prefix, 'node_modules', packageName), nativeRoot = join(prefix, 'node_modules', nativeName);
  await mkdir(join(wrapperRoot, 'bin'), { recursive: true, mode: 0o700 });
  await mkdir(nativeRoot, { mode: 0o700 });
  await writeFile(join(wrapperRoot, 'package.json'), JSON.stringify({ name: packageName, version: '2.1.283',
    bin: { claude: 'bin/claude.exe' }, optionalDependencies: { [nativeName]: '2.1.283' } }), { mode: 0o600 });
  await writeFile(join(nativeRoot, 'package.json'), JSON.stringify({ name: nativeName, version: '2.1.283',
    os: [process.platform], cpu: [process.arch] }), { mode: 0o600 });
  const native = join(nativeRoot, 'claude'), wrapper = join(wrapperRoot, 'bin', 'claude.exe');
  await writeFile(native, 'Synthetic native executable bytes.', { mode: 0o755 });
  await chmod(native, 0o755);
  if (hardlink) await link(native, wrapper); else await copyFile(native, wrapper);
  const binary = join(prefix, 'node_modules', '.bin', 'claude');
  await symlink('../@anthropic-ai/claude-code/bin/claude.exe', binary);
  await mutate?.({ wrapperRoot, nativeRoot, native, wrapper, binary });
  return { wrapperRoot, nativeRoot, native, wrapper, binary };
}

function runner({ commands = [], wrongTeam = false, install = false, hardlink = false, mutate } = {}) {
  return async (command, args) => {
    commands.push([command, ...args]);
    if (command === '/usr/bin/codesign' && args[0] === '--verify') return {};
    if (command === '/usr/bin/codesign' && args[0] === '-d') {
      const isClaude = args.at(-1).includes('Claude.app');
      return { stderr: `Identifier=${isClaude ? 'com.anthropic.claudefordesktop' : 'com.openai.codex'}\nTeamIdentifier=${wrongTeam ? 'WRONG' : isClaude ? 'Q6L2SF6YDW' : '2DC432GLL2'}\n` };
    }
    if (args[1] === 'install' && install) {
      const prefix = args[args.indexOf('--prefix') + 1];
      const name = prefix.includes('codex-cli') ? 'codex' : 'claude';
      const binary = join(prefix, 'node_modules', '.bin', name);
      await mkdir(join(prefix, 'node_modules', '.bin'), { recursive: true });
      if (name === 'claude') await claudePackage(prefix, { hardlink, mutate });
      else await writeFile(binary, '', { mode: 0o755 });
      return {};
    }
    if (args[0] === '--version') return { stdout: `${command.includes('claude') ? '2.1.283' : '0.158.0'}\n` };
    throw new Error(`Unexpected command: ${command}`);
  };
}

test('missing desktop prerequisite returns an issue without installing either CLI', async t => {
  const options = await fixture(t);
  await app(options.home, 'Claude.app');
  const commands = [];
  const found = await ensureProviders({ ...options, run: runner({ commands }) });
  assert.equal(found.codex.app, null);
  assert.match(found.codex.issue, /Desktop app is required/);
  assert.equal(found.claude.app, join(options.home, 'Applications', 'Claude.app'));
  assert.equal(commands.some(([command]) => command.endsWith('/node')), false);
});

test('signed desktop prerequisites allow private installation of missing CLIs', async t => {
  const options = await fixture(t);
  await app(options.home, 'ChatGPT.app');
  await app(options.home, 'Claude.app');
  const commands = [];
  const configs = [], baseRunner = runner({ commands, install: true });
  const run = async (command, args, runOptions) => {
    if (args[1] === 'install') {
      const { npm_config_userconfig: user, npm_config_globalconfig: global } = runOptions.env;
      assert.notEqual(user, global);
      assert.equal(user.startsWith(join(options.root, 'providers', 'npm-config')), true);
      for (const path of [user, global, join(runOptions.cwd, '.npmrc')]) {
        const info = await lstat(path);
        assert.equal(info.mode & 0o777, 0o600);
        assert.equal(info.uid, process.getuid());
        assert.equal(info.nlink, 1);
        assert.equal(await readFile(path, 'utf8'), '');
      }
      configs.push([user, global]);
    }
    return baseRunner(command, args, runOptions);
  };
  const found = await ensureProviders({ ...options, run });
  assert.equal(found.codex.binary, join(options.root, 'providers', 'codex-cli', 'node_modules', '.bin', 'codex'));
  assert.equal(found.claude.binary, join(options.root, 'providers', 'claude-cli', 'node_modules', '.bin', 'claude'));
  const installs = commands.filter(([command, , action]) => command === join(options.runtime, 'bin', 'node') && action === 'install');
  assert.equal(installs.length, 2);
  assert.ok(installs.some(command => command.includes('@openai/codex@0.158.0-alpha.2.1')));
  assert.ok(installs.some(command => command.includes('@anthropic-ai/claude-code@2.1.283')));
  assert.equal(found.codex.issue, undefined);
  assert.equal(found.claude.issue, undefined);
  assert.equal(configs.length, 2);
  assert.deepEqual(configs[0], configs[1], 'both CLI installs reuse only the two verified empty config files');
});

test('fresh official provider hardlink is separated before normal Mod manager selection', async t => {
  const options = await fixture(t); await chmod(options.root, 0o700);
  await app(options.home, 'ChatGPT.app'); await app(options.home, 'Claude.app');
  const commands = [], installed = [];
  const run = runner({ commands, install: true, hardlink: true, mutate: async value => {
    const before = await lstat(value.wrapper);
    installed.push({ ...value, before, bytes: await readFile(value.native) });
    assert.equal(before.nlink, 2);
  } });
  const found = await ensureProviders({ ...options, run });
  assert.equal(found.claude.issue, undefined);
  const [value] = installed;
  for (const path of [value.wrapper, value.native]) {
    const info = await lstat(path);
    assert.equal(info.nlink, 1); assert.equal(info.mode & 0o777, 0o755);
    assert.deepEqual(await readFile(path), value.bytes);
  }
  assert.equal((await lstat(value.native)).ino, value.before.ino, 'native package bytes/inode remain intact');
  assert.notEqual((await lstat(value.wrapper)).ino, value.before.ino);
  const probes = [];
  const selected = await findAppModRuntime({ root: options.root, home: options.home, runtime: options.runtime,
    claudeBinary: found.claude.binary, run: async (binary, args) => {
      probes.push({ binary, args });
      return { stdout: args[0] === '--version' ? '2.1.283 (Claude Code)\n' : `Usage: claude plugin ${args[1]} [options]\n` };
    } });
  assert.equal(selected.state, 'ready'); assert.equal(selected.source, 'provided-native-cli');
  assert.equal(probes.length, 3);
});

test('fresh provider separation refuses unexpected aliases and package identities without changing bytes', async t => {
  const cases = {
    'extra alias': async value => { await link(value.wrapper, value.wrapper + '.extra'); },
    'foreign alias': async value => {
      const outside = value.wrapper + '.original'; await writeFile(outside, 'Preserve unrelated executable.', { mode: 0o700 });
      await rm(value.wrapper); await link(outside, value.wrapper);
    },
    'wrapper version': async value => {
      const path = join(value.wrapperRoot, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.version = '2.1.999'; await writeFile(path, JSON.stringify(manifest));
    },
    'native version': async value => {
      const path = join(value.nativeRoot, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.version = '2.1.999'; await writeFile(path, JSON.stringify(manifest));
    },
    'native architecture': async value => {
      const path = join(value.nativeRoot, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.cpu = ['unrecognized']; await writeFile(path, JSON.stringify(manifest));
    },
    'linked metadata': async value => { await link(join(value.wrapperRoot, 'package.json'), value.wrapper + '.metadata'); },
    'foreign writable wrapper': async value => { await chmod(value.wrapper, 0o777); },
    'native symlink': async value => {
      await link(value.wrapper, value.wrapper + '.retained'); await rm(value.native); await symlink(value.wrapper, value.native);
    },
    'native directory symlink': async value => {
      const { rename } = await import('node:fs/promises');
      await rename(value.nativeRoot, value.nativeRoot + '.original'); await symlink(value.nativeRoot + '.original', value.nativeRoot);
    },
    'foreign command target': async value => {
      const outside = value.wrapper + '.command'; await writeFile(outside, 'Preserve unrelated command.', { mode: 0o700 });
      await rm(value.binary); await symlink(outside, value.binary);
    },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async t => {
    const options = await fixture(t);
    await app(options.home, 'ChatGPT.app'); await app(options.home, 'Claude.app');
    let installed, before;
    const found = await ensureProviders({ ...options, run: runner({ install: true, hardlink: true, mutate: async value => {
      await mutate(value); installed = value; before = await readFile(value.wrapper);
    } }) });
    assert.match(found.claude.issue, /CLI installation failed:/);
    assert.deepEqual(await readFile(installed.wrapper), before);
  });
});

test('existing private provider hardlink stays unchanged and the normal manager guard still blocks it', async t => {
  const options = await fixture(t); await chmod(options.root, 0o700);
  await app(options.home, 'ChatGPT.app'); await app(options.home, 'Claude.app');
  const prefix = join(options.root, 'providers', 'claude-cli');
  await mkdir(join(prefix, 'node_modules', '.bin'), { recursive: true, mode: 0o700 });
  const existing = await claudePackage(prefix, { hardlink: true }), before = await lstat(existing.wrapper);
  const commands = [], found = await ensureProviders({ ...options, run: runner({ commands, install: true }) });
  assert.equal(found.claude.binary, existing.binary);
  assert.equal(commands.some(args => args.includes('@anthropic-ai/claude-code@2.1.283')), false);
  assert.equal((await lstat(existing.wrapper)).ino, before.ino);
  assert.equal((await lstat(existing.wrapper)).nlink, 2);
  const probes = [], selected = await findAppModRuntime({ root: options.root, home: options.home, runtime: options.runtime,
    claudeBinary: found.claude.binary, run: async (...args) => { probes.push(args); throw new Error('Must not execute'); } });
  assert.equal(selected.state, 'blocked'); assert.match(selected.reason, /canonical, owned/);
  assert.deepEqual(probes, []);
});

test('provider bootstrap refuses and preserves nonempty, linked and foreign-writable npm config', async t => {
  for (const kind of ['nonempty', 'symlink', 'hardlink', 'writable', 'project']) await t.test(kind, async t => {
    const options = await fixture(t);
    await app(options.home, 'ChatGPT.app'); await app(options.home, 'Claude.app');
    const config = join(options.root, 'providers', 'npm-config');
    await mkdir(config, { recursive: true, mode: 0o700 });
    const outside = join(options.base, 'original');
    await writeFile(outside, 'preserve-original', { mode: 0o600 });
    let path = join(config, 'user.npmrc');
    if (kind === 'symlink') await symlink(outside, path);
    else if (kind === 'hardlink') await link(outside, path);
    else {
      if (kind === 'project') {
        path = join(options.root, 'providers', 'codex-cli', '.npmrc');
        await mkdir(join(options.root, 'providers', 'codex-cli'), { recursive: true, mode: 0o700 });
      }
      await writeFile(path, kind === 'writable' ? '' : 'ignore-scripts=true\n', { mode: 0o600 });
      if (kind === 'writable') await chmod(path, 0o666);
    }
    const commands = [];
    const found = await ensureProviders({ ...options, run: runner({ commands, install: true }) });
    assert.match(found.codex.issue, /CLI installation failed/);
    assert.equal(commands.some(args => args.includes('@openai/codex@0.158.0-alpha.2.1')), false);
    assert.equal(await readFile(outside, 'utf8'), 'preserve-original');
    if (kind !== 'project') assert.equal(commands.some(args => args.includes('@anthropic-ai/claude-code@2.1.283')), false);
  });
});

test('existing apps and CLIs are reused without installer commands', async t => {
  const options = await fixture(t);
  await app(options.home, 'Codex.app');
  await app(options.home, 'Claude.app');
  const claude = join(options.home, '.local', 'bin', 'claude');
  const codex = join(options.base, 'bin', 'codex');
  await mkdir(join(options.home, '.local', 'bin'), { recursive: true });
  await mkdir(join(options.base, 'bin'), { recursive: true });
  await writeFile(claude, '', { mode: 0o755 });
  await writeFile(codex, '', { mode: 0o755 });
  const commands = [];
  const found = await ensureProviders({ ...options, env: { PATH: join(options.base, 'bin') }, run: runner({ commands }) });
  assert.equal(found.codex.app, join(options.home, 'Applications', 'Codex.app'));
  assert.equal(found.codex.binary, codex);
  assert.equal(found.claude.binary, claude);
  assert.equal(commands.some(([command]) => command.endsWith('/node')), false);
  assert.equal(commands.filter(([command, flag, deep]) => command === '/usr/bin/codesign'
    && flag === '--verify' && deep === '--deep').length, 2, 'verify each app once when no installation is needed');
  assert.equal(commands.filter(([command, flag]) => command === codex && flag === '--version').length, 1);
  assert.equal(commands.filter(([command, flag]) => command === claude && flag === '--version').length, 1);
});

test('a desktop app with the wrong publisher is rejected', async t => {
  const options = await fixture(t);
  const path = await app(options.home, 'ChatGPT.app');
  const found = await discoverProviders({ ...options, run: runner({ wrongTeam: true }) });
  assert.equal(found.codex.app, null);
  assert.equal(found.codex.appIssue, `Unexpected publisher for ${path}`);
});

test('a foreign-publisher desktop app blocks only its own provider and never triggers installation', async t => {
  const options = await fixture(t);
  await app(options.home, 'ChatGPT.app');
  const claude = await app(options.home, 'Claude.app');
  // A signed copy elsewhere must not be substituted for the rejected bundle.
  await mkdir(join(options.systemApplications, 'Claude.app'), { recursive: true });
  const commands = [], base = runner({ commands, install: true });
  const run = async (command, args) => command === '/usr/bin/codesign' && args[0] === '-d' && args.at(-1) === claude
    ? { stderr: 'Identifier=com.anthropic.claudefordesktop\nTeamIdentifier=OTHERTEAM1\n' } : base(command, args);
  const found = await ensureProviders({ ...options, run });
  assert.equal(found.codex.app, join(options.home, 'Applications', 'ChatGPT.app'));
  assert.equal(found.codex.issue, undefined);
  assert.equal(found.claude.app, null);
  assert.equal(found.claude.issue, `Unexpected publisher for ${claude}`);
  assert.equal(commands.some(([command]) => command.endsWith('/node')), false);
});

test('a locally ad-hoc re-signed official Claude build is accepted but Codex is not', async t => {
  const options = await fixture(t);
  const codex = await app(options.home, 'ChatGPT.app');
  const claude = await app(options.home, 'Claude.app');
  const adhoc = id => ({ stderr: `Identifier=${id}\nSignature=adhoc\nTeamIdentifier=not set\n` });
  const base = runner();
  const run = async (command, args) => command === '/usr/bin/codesign' && args[0] === '-d'
    ? args.at(-1) === claude ? adhoc('com.anthropic.claudefordesktop') : args.at(-1) === codex ? adhoc('com.openai.codex') : base(command, args)
    : base(command, args);
  const found = await discoverProviders({ ...options, run });
  assert.equal(found.claude.app, claude);
  assert.equal(found.claude.appSignature, 'local');
  assert.equal(found.codex.app, null);
  assert.equal(found.codex.appIssue, `Unexpected publisher for ${codex}`);
  const renamed = async (command, args) => command === '/usr/bin/codesign' && args[0] === '-d' && args.at(-1) === claude
    ? adhoc('com.example.claude') : run(command, args);
  assert.equal((await discoverProviders({ ...options, run: renamed })).claude.appIssue, `Unexpected publisher for ${claude}`);
  const unsealed = async (command, args) => {
    if (command === '/usr/bin/codesign' && args[0] === '--verify' && args.at(-1) === claude) throw new Error('code object is not signed at all');
    return run(command, args);
  };
  await assert.rejects(discoverProviders({ ...options, run: unsealed }), /not signed/);
});

test('inspection reuses only a recent unchanged successful deep signature verification', async t => {
  const options = await fixture(t);
  const { chmod, utimes } = await import('node:fs/promises');
  const { AppSignatureCache } = await import('../src/app-signature-cache.mjs');
  await chmod(options.root, 0o700);
  const apps = [];
  for (const name of ['ChatGPT.app', 'Claude.app']) {
    const path = await app(options.home, name);
    await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(path, 'Contents', '_CodeSignature'), { recursive: true });
    await writeFile(join(path, 'Contents', 'Info.plist'), 'plist');
    await writeFile(join(path, 'Contents', '_CodeSignature', 'CodeResources'), 'seal');
    apps.push(path);
  }
  let clock = 1_000_000;
  const deepVerifications = commands => commands.filter(([command, flag, deep]) => command === '/usr/bin/codesign' && flag === '--verify' && deep === '--deep').length;
  const inspect = async ({ reuse = true, persist = true, wrongTeam = false } = {}) => {
    const commands = [];
    const signatures = new AppSignatureCache({ root: options.root, reuse, persist, now: () => clock });
    const found = await discoverProviders({ ...options, run: runner({ commands, wrongTeam }), signatures });
    return { found, deep: deepVerifications(commands) };
  };

  // Read-only inspection verifies but records nothing.
  assert.equal((await inspect({ persist: false })).deep, 2);
  assert.equal((await inspect()).deep, 2);
  const reused = await inspect();
  assert.equal(reused.deep, 0);
  assert.equal(reused.found.codex.app, apps[0]);
  assert.equal(reused.found.claude.app, apps[1]);
  // Setup and sign-in never reuse the record.
  assert.equal((await inspect({ reuse: false })).deep, 2);

  // A resealed bundle is verified again, and a rejected publisher is never cached.
  await writeFile(join(apps[1], 'Contents', '_CodeSignature', 'CodeResources'), 'new seal');
  const rejected = await inspect({ wrongTeam: true });
  assert.equal(rejected.deep, 1);
  assert.equal(rejected.found.claude.appIssue, `Unexpected publisher for ${apps[1]}`);
  assert.equal(rejected.found.codex.app, apps[0]);
  assert.equal((await inspect()).deep, 1);

  // Entries expire after their bounded age even when nothing observable changed.
  clock += 60 * 60 * 1000;
  assert.equal((await inspect()).deep, 2);
  const future = new Date(Date.now() + 5000);
  await utimes(join(apps[0], 'Contents', 'Info.plist'), future, future);
  assert.equal((await inspect()).deep, 1);
});

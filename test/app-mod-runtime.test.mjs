import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findAppModRuntime, ensureAppModRuntime, MOD_MANAGER_VERSION, MOD_MANAGER_PACKAGE, MOD_MANAGER_INTEGRITY, MOD_MANAGER_NATIVE_INTEGRITIES } from '../src/app-mod-runtime.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cldx-mod-runtime-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'root'), home = join(base, 'home'), runtime = join(base, 'runtime');
  for (const path of [root, home, join(runtime, 'bin'), join(runtime, 'lib', 'node_modules', 'npm', 'bin')]) {
    await mkdir(path, { mode: 0o700, recursive: true }); await chmod(path, 0o700);
  }
  await writeFile(join(runtime, 'bin', 'node'), '', { mode: 0o700 });
  await writeFile(join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '', { mode: 0o600 });
  const claudeBinary = join(home, 'claude'); await writeFile(claudeBinary, '', { mode: 0o700 });
  return { base, root, home, runtime, claudeBinary, platform: 'darwin', arch: 'arm64' };
}
async function desktop(f, version = '2.1.286') {
  const app = join(f.home, 'Library', 'Application Support', 'Claude', 'claude-code', version, 'abcdef012345', 'claude.app');
  await mkdir(join(app, 'Contents', 'MacOS'), { mode: 0o700, recursive: true });
  await mkdir(join(app, 'Contents', '_CodeSignature'), { mode: 0o700 });
  await writeFile(join(app, 'Contents', 'Info.plist'), 'fixture', { mode: 0o600 });
  await writeFile(join(app, 'Contents', '_CodeSignature', 'CodeResources'), 'fixture', { mode: 0o600 });
  const binary = join(app, 'Contents', 'MacOS', 'claude'); await writeFile(binary, '', { mode: 0o700 });
  return { app, binary };
}
const lock = integrity => ({ lockfileVersion: 3, packages: { '': { dependencies: { [MOD_MANAGER_PACKAGE]: MOD_MANAGER_VERSION } },
  'node_modules/@anthropic-ai/claude-code': { version: MOD_MANAGER_VERSION, integrity,
    resolved: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${MOD_MANAGER_VERSION}.tgz` },
  'node_modules/@anthropic-ai/claude-code-darwin-arm64': { version: MOD_MANAGER_VERSION, integrity: MOD_MANAGER_NATIVE_INTEGRITIES.arm64,
    resolved: `https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-${MOD_MANAGER_VERSION}.tgz` } } });
function runner(f, { calls = [], providedCapable = false, badSignature = false, failProbe = false, integrity = MOD_MANAGER_INTEGRITY, beforeSignature, nativeVersion } = {}) {
  return async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (binary === '/usr/bin/codesign') {
      if (args[0] === '--verify') { await beforeSignature?.(); return {}; }
      return { stderr: `Identifier=com.anthropic.claude-code\nTeamIdentifier=${badSignature ? 'WRONG' : 'Q6L2SF6YDW'}\n` };
    }
    if (binary === join(f.runtime, 'bin', 'node')) {
      const prefix = args[args.indexOf('--prefix') + 1];
      if (args[1] === 'install') { await writeFile(join(prefix, 'package-lock.json'), JSON.stringify(lock(integrity)), { mode: 0o600 }); return {}; }
      assert.equal(args[1], 'ci');
      const packageRoot = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
      await mkdir(join(packageRoot, 'bin'), { recursive: true, mode: 0o700 });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: MOD_MANAGER_PACKAGE, version: MOD_MANAGER_VERSION,
        bin: { claude: 'bin/claude.exe' }, optionalDependencies: { [`${MOD_MANAGER_PACKAGE}-darwin-arm64`]: MOD_MANAGER_VERSION } }), { mode: 0o600 });
      await writeFile(join(packageRoot, 'bin', 'claude.exe'), '', { mode: 0o700 });
      const nativeRoot = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code-darwin-arm64'); await mkdir(nativeRoot, { mode: 0o700 });
      await writeFile(join(nativeRoot, 'package.json'), JSON.stringify({ name: `${MOD_MANAGER_PACKAGE}-darwin-arm64`, version: MOD_MANAGER_VERSION, os: ['darwin'], cpu: ['arm64'] }), { mode: 0o600 });
      await writeFile(join(nativeRoot, 'claude'), '', { mode: 0o700 }); return {};
    }
    if (failProbe && binary === f.claudeBinary) throw Object.assign(new Error('Unexpected native process failure'), { code: 1, stderr: 'Native crash' });
    if (args[0] === '--version') return { stdout: `${nativeVersion ?? (binary === f.claudeBinary ? '2.1.283' : binary.includes('claude-code-darwin-') ? MOD_MANAGER_VERSION : '2.1.286')} (Claude Code)\n` };
    if (binary === f.claudeBinary && !providedCapable) return { stdout: 'Usage: claude [options] [command]\n' };
    return { stdout: `Usage: claude plugin ${args[1]} [options]\n` };
  };
}

test('read-only selection checks actual capability help instead of trusting generic exit-zero help', async t => {
  const f = await fixture(t), native = await desktop(f), calls = [];
  const found = await findAppModRuntime({ ...f, run: runner(f, { calls }) });
  assert.equal(found.state, 'ready'); assert.equal(found.binary, native.binary); assert.equal(found.source, 'desktop-cache');
  assert.equal(found.version, '2.1.286');
  assert.ok(calls.some(call => call.binary === '/usr/bin/codesign' && call.args.includes('--deep') && call.args.includes('--strict')));
  assert.equal(calls.some(call => call.binary === join(f.runtime, 'bin', 'node')), false);
  assert.deepEqual(await readdir(f.root), []);
});

test('capable provided native CLI is reused with minimal environment and no cache or install probes', async t => {
  const f = await fixture(t), calls = [];
  const found = await ensureAppModRuntime({ ...f, run: runner(f, { calls, providedCapable: true }) });
  assert.equal(found.source, 'provided-native-cli'); assert.equal(found.binary, f.claudeBinary);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(Object.keys(call.options.env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(calls[0].options.env.PATH, `${f.runtime}/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
});

test('unexpected native failures and untrusted Desktop candidates block rather than falling back', async t => {
  for (const mode of ['probe', 'publisher', 'rewrite', 'symlink']) {
    const f = await fixture(t), native = await desktop(f), calls = [];
    if (mode === 'symlink') {
      const cache = join(f.home, 'Library', 'Application Support', 'Claude', 'claude-code');
      await symlink(join(cache, '2.1.286'), join(cache, '2.1.999'));
    }
    const found = await ensureAppModRuntime({ ...f, run: runner(f, { calls, failProbe: mode === 'probe', badSignature: mode === 'publisher',
      beforeSignature: mode === 'rewrite' ? () => writeFile(native.binary, 'replacement', { mode: 0o700 }) : undefined }) });
    assert.equal(found.state, 'blocked', mode);
    assert.equal(calls.some(call => call.binary === join(f.runtime, 'bin', 'node')), false, mode);
    assert.equal(calls.some(call => call.binary === native.binary), false, mode);
  }
});

test('read-only missing diagnosis writes nothing and never bootstraps a manager', async t => {
  const f = await fixture(t), calls = [];
  const found = await findAppModRuntime({ ...f, run: runner(f, { calls }) });
  assert.equal(found.state, 'missing'); assert.deepEqual(await readdir(f.root), []);
  assert.equal(calls.some(call => call.binary === join(f.runtime, 'bin', 'node')), false);
});

test('fresh bootstrap uses exact package integrity and separate configs without changing the provider', async t => {
  const f = await fixture(t), calls = [], before = await readFile(f.claudeBinary);
  const found = await ensureAppModRuntime({ ...f, run: runner(f, { calls }) });
  assert.equal(found.state, 'ready'); assert.equal(found.source, 'private-mod-manager'); assert.equal(found.version, MOD_MANAGER_VERSION);
  assert.equal(found.binary, join(f.root, 'providers', 'claude-mod-cli', 'node_modules', '@anthropic-ai', 'claude-code-darwin-arm64', 'claude'));
  assert.deepEqual(await readFile(f.claudeBinary), before);
  const installs = calls.filter(call => call.binary === join(f.runtime, 'bin', 'node'));
  assert.equal(installs.length, 2);
  assert.equal(installs[0].args[1], 'install'); assert.ok(installs[0].args.includes('--package-lock-only'));
  assert.equal(installs[1].args[1], 'ci');
  for (const call of installs) {
    for (const flag of ['--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']) assert.ok(call.args.includes(flag));
    assert.notEqual(call.options.env.npm_config_userconfig, call.options.env.npm_config_globalconfig);
    assert.equal(Object.keys(call.options.env).some(key => /(?:API_KEY|TOKEN|SECRET)/.test(key)), false);
  }
  const again = await findAppModRuntime({ ...f, run: runner(f) });
  assert.equal(again.binary, found.binary); assert.equal(again.state, 'ready');
});

test('mismatched official integrity and incomplete prior installation remain preserved and blocked', async t => {
  const f = await fixture(t), calls = [];
  const mismatch = await ensureAppModRuntime({ ...f, run: runner(f, { calls, integrity: 'sha512-untrusted' }) });
  assert.equal(mismatch.state, 'blocked'); assert.match(mismatch.reason, /integrity/);
  assert.equal(calls.some(call => call.args[1] === 'ci'), false);
  const providers = join(f.root, 'providers');
  assert.ok((await readdir(providers)).some(name => name.startsWith('.claude-mod-cli-')));
  const prior = join(providers, 'claude-mod-cli'); await mkdir(prior, { mode: 0o700 });
  await writeFile(join(prior, 'preserved'), 'existing partial install', { mode: 0o600 });
  const after = await ensureAppModRuntime({ ...f, run: runner(f, { calls }) });
  assert.equal(after.state, 'blocked');
  assert.equal(await readFile(join(prior, 'preserved'), 'utf8'), 'existing partial install');
  assert.equal(calls.filter(call => call.binary === join(f.runtime, 'bin', 'node')).length, 1);
});

test('foreign-writable provider directories and aliased home inputs never reach installer commands', async t => {
  const f = await fixture(t), calls = [];
  await mkdir(join(f.root, 'providers'), { mode: 0o777 }); await chmod(join(f.root, 'providers'), 0o777);
  assert.equal((await ensureAppModRuntime({ ...f, run: runner(f, { calls }) })).state, 'blocked');
  assert.equal(calls.some(call => call.binary === join(f.runtime, 'bin', 'node')), false);
  const alias = join(f.base, 'home-alias'); await symlink(f.home, alias);
  assert.equal((await findAppModRuntime({ ...f, home: alias, run: runner(f) })).state, 'blocked');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const routes = new Map([
  ['claudex.mjs', []], ['claudex-app.mjs', ['app']],
  ['claudex-collaboration.mjs', ['collaboration']], ['claudex-mod.mjs', ['mod']],
  ['claudex-mod-bridge.mjs', ['mod-bridge']], ['claudex-codex-warm-hook.mjs', ['warm-hook']],
  ['claudex-sync-hook.mjs', ['sync-hook']], ['claudex-service.mjs', ['service-supervise']],
  ['claudex-codex.mjs', ['codex-host']],
]);

async function fixture(t, built = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-entry-')));
  const checkout = join(root, 'checkout with spaces');
  const bin = join(checkout, 'bin');
  await mkdir(bin, { recursive: true });
  for (const name of ['claudex', 'rust-entry.mjs', 'build-claudex-app.mjs', ...routes.keys()]) {
    await copyFile(join(source, 'bin', name), join(bin, name));
  }
  const host = 'crates/claudex-cli/host/codex-host.mjs';
  await mkdir(dirname(join(checkout, host)), { recursive: true });
  await copyFile(join(source, host), join(checkout, host));
  const engine = join(checkout, 'target/release/claudex');
  if (built) {
    await mkdir(dirname(engine), { recursive: true });
    await writeFile(engine, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--wait-for-signal')) {
  process.on('SIGTERM', () => process.exit(42));
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\\n');
  setInterval(() => {}, 1000);
} else if (process.argv.includes('--terminate')) {
  process.kill(process.pid, 'SIGTERM');
} else {
  const input = fs.readFileSync(0, 'utf8');
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input, env: process.env.ENTRY_PROBE, pid: process.pid }));
  process.stderr.write('engine-stderr');
  process.exit(37);
}
`, { mode: 0o755 });
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, ENTRY_PROBE: 'preserved environment' };
  delete env.CLAUDEX_RUST_ENGINE;
  return { root, checkout, bin, engine, env };
}

function run(program, args, env, input = 'stdin stays unchanged\n') {
  return spawnSync(program, args, { env, input, encoding: 'utf8', timeout: 10_000 });
}

test('npm points to the native launcher and keeps reference tests explicit', async () => {
  const manifest = JSON.parse(await readFile(join(source, 'package.json')));
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json')));
  assert.equal(manifest.bin.claudex, 'bin/claudex');
  assert.equal(lock.packages[''].bin.claudex, 'bin/claudex');
  assert.match(manifest.scripts.build, /^cargo build --locked --release -p claudex-cli$/);
  assert.match(manifest.scripts.test, /^cargo test --locked --workspace/);
  assert.equal(manifest.scripts['test:reference'], 'node dev/test-reference.mjs');
  for (const name of [...routes.keys(), 'build-claudex-app.mjs', 'rust-entry.mjs']) {
    const text = await readFile(join(source, 'bin', name), 'utf8');
    assert.doesNotMatch(text, /\.\.\/src\/|test\/reference|spawn\(['"]cargo|download/);
  }
});

test('primary launcher needs no Node on PATH, follows npm-style links and execs the engine', async t => {
  const f = await fixture(t);
  const tools = join(f.root, 'tools');
  await mkdir(tools);
  for (const name of ['dirname', 'readlink']) await symlink(`/usr/bin/${name}`, join(tools, name));
  const alias = join(tools, 'claudex');
  await symlink('../checkout with spaces/bin/claudex', alias);
  const args = ['help', 'space and "quotes"', '$(not-a-command)', 'line\nbreak'];
  const result = run(alias, args, { ...f.env, PATH: tools });
  assert.equal(result.status, 37, result.stderr);
  assert.equal(result.stderr, 'engine-stderr');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, args);
  assert.equal(output.input, 'stdin stays unchanged\n');
  assert.equal(output.env, f.env.ENTRY_PROBE);
  assert.equal(output.pid, result.pid);
});

test('explicit Node compatibility hosts only prepend their Rust subcommand', async t => {
  const f = await fixture(t);
  const args = ['--root', '/private/space and quotes\' "', 'help'];
  for (const [name, prefix] of routes) {
    const result = run(process.execPath, [join(f.bin, name), ...args], f.env);
    assert.equal(result.status, 37, `${name}: ${result.stderr}`);
    assert.equal(result.stderr, 'engine-stderr');
    const output = JSON.parse(result.stdout);
    const source = name === 'claudex-mod.mjs' ? ['--source-root', `${f.checkout}/`] : [];
    assert.deepEqual(output.args, [...prefix, ...source, ...args]);
    assert.equal(output.input, 'stdin stays unchanged\n');
    assert.equal(output.env, f.env.ENTRY_PROBE);
  }
  const alias = join(f.root, 'collaboration.mjs');
  await symlink(join(f.bin, 'claudex-collaboration.mjs'), alias);
  const linked = run(process.execPath, [alias, ...args], f.env);
  assert.equal(linked.status, 37, linked.stderr);
  assert.deepEqual(JSON.parse(linked.stdout).args, ['collaboration', ...args]);
});

test('build compatibility keeps a source-root default without overriding an explicit path', async t => {
  const f = await fixture(t);
  const command = join(f.bin, 'build-claudex-app.mjs');
  const defaults = run(process.execPath, [command, '--help'], f.env);
  assert.equal(defaults.status, 37, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout).args, ['app', 'build', '--source-root', `${f.checkout}/`, '--help']);
  const explicit = run(process.execPath, [command, '--source-root', '/explicit/checkout', '--help'], f.env);
  assert.equal(explicit.status, 37, explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout).args, ['app', 'build', '--source-root', '/explicit/checkout', '--help']);
  const mod = run(process.execPath, [join(f.bin, 'claudex-mod.mjs'), 'stage', '--source-root', '/explicit/checkout'], f.env);
  assert.equal(mod.status, 37, mod.stderr);
  assert.deepEqual(JSON.parse(mod.stdout).args, ['mod', 'stage', '--source-root', '/explicit/checkout']);
});

test('missing or nonexecutable engines fail without building or running legacy code', async t => {
  const f = await fixture(t, false);
  const marker = join(f.root, 'cargo-was-called');
  const tools = join(f.root, 'tools');
  await mkdir(tools);
  await writeFile(join(tools, 'cargo'), `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o755 });
  for (const name of ['dirname', 'readlink']) await symlink(`/usr/bin/${name}`, join(tools, name));
  for (const [program, args] of [
    [join(f.bin, 'claudex'), ['help']],
    [process.execPath, [join(f.bin, 'claudex.mjs'), 'help']],
    [process.execPath, [join(f.bin, 'claudex-codex.mjs'), '--version']],
  ]) {
    const result = run(program, args, { ...f.env, PATH: tools });
    assert.equal(result.status, 127);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /cargo build --locked --release -p claudex-cli/);
  }
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.checkout, 'target')), { code: 'ENOENT' });
  await mkdir(dirname(f.engine), { recursive: true });
  await writeFile(f.engine, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  await chmod(f.engine, 0o600);
  for (const [program, args] of [[join(f.bin, 'claudex'), []], [process.execPath, [join(f.bin, 'claudex.mjs')]]]) {
    assert.equal(run(program, args, f.env).status, 127);
  }
});

test('an explicit engine override is absolute and does not silently fall back', async t => {
  const f = await fixture(t);
  for (const override of ['', 'target/release/claudex', join(f.root, 'missing')]) {
    const env = { ...f.env, CLAUDEX_RUST_ENGINE: override };
    for (const [program, args] of [[join(f.bin, 'claudex'), []], [process.execPath, [join(f.bin, 'claudex.mjs')]]]) {
      assert.equal(run(program, args, env).status, 127);
    }
  }
  const alternate = join(f.root, 'alternate-engine');
  await copyFile(f.engine, alternate);
  const result = run(join(f.bin, 'claudex'), ['status'], { ...f.env, CLAUDEX_RUST_ENGINE: alternate });
  assert.equal(result.status, 37, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ['status']);
});

test('native and compatibility entry points preserve graceful signals and signal termination', async t => {
  const f = await fixture(t);
  for (const [program, prefix] of [[join(f.bin, 'claudex'), []], [process.execPath, [join(f.bin, 'claudex.mjs')]]]) {
    const child = spawn(program, [...prefix, '--wait-for-signal'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    const closed = once(child, 'close');
    const [ready] = await once(child.stdout, 'data');
    assert.equal(JSON.parse(ready.toString()).ready, true);
    child.kill('SIGTERM');
    assert.deepEqual(await closed, [42, null]);
    const terminated = run(program, [...prefix, '--terminate'], f.env);
    assert.equal(terminated.status, null);
    assert.equal(terminated.signal, 'SIGTERM');
  }
});

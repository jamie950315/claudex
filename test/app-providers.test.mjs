import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProviders, ensureProviders } from '../src/app-providers.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'claudex-providers-test-'));
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

function runner({ commands = [], wrongTeam = false, install = false } = {}) {
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
      await writeFile(binary, '', { mode: 0o755 });
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
  const found = await ensureProviders({ ...options, run: runner({ commands, install: true }) });
  assert.equal(found.codex.binary, join(options.root, 'providers', 'codex-cli', 'node_modules', '.bin', 'codex'));
  assert.equal(found.claude.binary, join(options.root, 'providers', 'claude-cli', 'node_modules', '.bin', 'claude'));
  const installs = commands.filter(([command, , action]) => command === join(options.runtime, 'bin', 'node') && action === 'install');
  assert.equal(installs.length, 2);
  assert.ok(installs.some(command => command.includes('@openai/codex@0.158.0-alpha.2.1')));
  assert.ok(installs.some(command => command.includes('@anthropic-ai/claude-code@2.1.283')));
  assert.equal(found.codex.issue, undefined);
  assert.equal(found.claude.issue, undefined);
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
});

test('a desktop app with the wrong publisher is rejected', async t => {
  const options = await fixture(t);
  await app(options.home, 'ChatGPT.app');
  await assert.rejects(discoverProviders({ ...options, run: runner({ wrongTeam: true }) }), /Unexpected publisher/);
});

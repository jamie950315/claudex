#!/usr/bin/env node
// Run legacy behavioral contracts without exposing a legacy product entry point.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const requested = process.argv.slice(2);
const available = (await readdir(join(source, 'test')))
  .filter(name => name.endsWith('.test.mjs') && name !== 'rust-entrypoints.test.mjs')
  .sort().map(name => `test/${name}`);
const tests = requested.length ? requested : available;
if (tests.some(name => !available.includes(name))) {
  process.stderr.write('Use explicit reference test paths, for example: npm run test:reference -- test/cli.test.mjs\n');
  process.exit(2);
}

const directory = await mkdtemp(join(tmpdir(), 'claudex-reference-'));
let child;
const forward = signal => child?.kill(signal);
const signals = ['SIGINT', 'SIGTERM'];
const handlers = signals.map(signal => () => forward(signal));
try {
  // Project code/test directories only; never copy native account directories.
  for (const name of ['src', 'test', 'plugins', 'native', 'dev', 'docs', 'README.md', 'AGENTS.md', 'package.json', 'package-lock.json']) {
    await cp(join(source, name), join(directory, name), { recursive: true });
  }
  await cp(join(source, 'test/reference/bin'), join(directory, 'bin'), { recursive: true });
  await cp(join(source, 'test/reference/assets'), directory, { recursive: true });
  await symlink(resolve(source, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const env = { ...process.env };
  delete env.CLAUDEX_TEST_RUST_ENGINE;
  delete env.CLAUDEX_RUST_ENGINE;
  child = spawn(process.execPath, ['--test', '--test-concurrency=4', ...tests], {
    cwd: directory, env, stdio: 'inherit',
  });
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  const [code, signal] = await once(child, 'exit');
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
} finally {
  signals.forEach((signal, index) => process.off(signal, handlers[index]));
  await rm(directory, { recursive: true, force: true });
}

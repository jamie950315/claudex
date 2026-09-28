import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installClaudeDesktopWake } from '../src/claude-desktop-wake-install.mjs';

async function fixture(config) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claudex-desktop-install-')));
  const vendor = join(directory, 'Claude');
  await mkdir(vendor, { mode: 0o700 });
  const root = join(directory, 'collaboration');
  const configPath = join(vendor, 'claude_desktop_config.json');
  if (config !== undefined) await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const options = { root, configPath, command: process.execPath,
    args: [join(directory, 'bin', 'claudex-collaboration.mjs'), 'desktop-wake-mcp', '--root', root, '--peer', 'claude'] };
  return { options, directory, journalPath: join(root, 'claude-desktop-wake-install.json'),
    run: () => installClaudeDesktopWake(options) };
}

test('Desktop registration preserves all existing data and journals only the owned entry', async () => {
  const before = { preferences: { theme: 'dark' }, mcpServers: { existing: { command: '/vendor/server', env: { TOKEN: 'private-synthetic-value' } } } };
  const { run, options, journalPath } = await fixture(before);
  assert.equal((await run()).changed, true);
  const after = JSON.parse(await readFile(options.configPath, 'utf8'));
  assert.deepEqual(after.preferences, before.preferences);
  assert.deepEqual(after.mcpServers.existing, before.mcpServers.existing);
  assert.deepEqual(after.mcpServers['claudex-desktop-wake'], { command: options.command, args: options.args });
  const journalText = await readFile(journalPath, 'utf8');
  assert.equal(journalText.includes('private-synthetic-value'), false);
  assert.equal(JSON.parse(journalText).phase, 'installed');
  assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  const bytes = await readFile(options.configPath, 'utf8');
  assert.equal((await run()).changed, false);
  assert.equal(await readFile(options.configPath, 'utf8'), bytes);
});

test('missing config is created only inside an existing vendor directory', async () => {
  const { run, options, directory } = await fixture();
  assert.equal((await run()).installed, true);
  assert.equal((await stat(options.configPath)).mode & 0o777, 0o600);
  await assert.rejects(installClaudeDesktopWake({ ...options, configPath: join(directory, 'missing', 'config.json') }), { code: 'ENOENT' });
});

test('conflicting registration, malformed JSON and symlink files preserve originals', async () => {
  const { run, options, directory } = await fixture({ mcpServers: { 'claudex-desktop-wake': { command: '/foreign' } } });
  const original = await readFile(options.configPath, 'utf8');
  await assert.rejects(run(), /different registration/);
  assert.equal(await readFile(options.configPath, 'utf8'), original);
  await writeFile(options.configPath, JSON.stringify({ mcpServers: { 'claudex-desktop-wake': null } }));
  await assert.rejects(run(), /invalid existing registration/);
  await writeFile(options.configPath, '{ broken');
  await assert.rejects(run(), /malformed/);
  const alias = join(directory, 'alias.json');
  await symlink(options.configPath, alias);
  await assert.rejects(installClaudeDesktopWake({ ...options, configPath: alias }), /owned regular file/);
  const dirAlias = join(directory, 'alias');
  await symlink(join(directory, 'Claude'), dirAlias);
  await assert.rejects(installClaudeDesktopWake({ ...options, configPath: join(dirAlias, 'config.json') }), /directory/);
});

test('prepared journal recovers before-write and after-write interruptions without duplicates', async () => {
  const before = { unrelated: ['retained'] };
  const { run, options, journalPath } = await fixture(before);
  const original = await readFile(options.configPath, 'utf8');
  await run();
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.phase = 'prepared';
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(options.configPath, original);
  assert.equal((await run()).changed, true);
  await writeFile(journalPath, JSON.stringify(journal));
  assert.equal((await run()).recovered, true);
  assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).phase, 'installed');
});

test('foreign changes during preparation and changed owned entry after installation are refused', async () => {
  const { run, options, journalPath } = await fixture({ unrelated: true });
  await run();
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.phase = 'prepared';
  await writeFile(journalPath, JSON.stringify(journal));
  const foreign = JSON.stringify({ unrelated: false });
  await writeFile(options.configPath, foreign);
  await assert.rejects(run(), /changed after preparation/);
  assert.equal(await readFile(options.configPath, 'utf8'), foreign);
  journal.phase = 'installed';
  await writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(run(), /changed outside Claudex/);
});

test('unrelated later config changes are retained while the exact owned entry stays installed', async () => {
  const { run, options } = await fixture({});
  await run();
  const config = JSON.parse(await readFile(options.configPath, 'utf8'));
  config.anotherPreference = 'new';
  await writeFile(options.configPath, JSON.stringify(config));
  assert.equal((await run()).changed, false);
  assert.deepEqual(JSON.parse(await readFile(options.configPath, 'utf8')), config);
  await assert.rejects(installClaudeDesktopWake({ ...options, args: [...options.args.slice(0, -1), 'codex'] }), /arguments/);
});

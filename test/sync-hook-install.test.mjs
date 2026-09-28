import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSyncHooks, inspectSyncHooks, inspectNativeSyncHookTrust, syncHookDefinitions } from '../src/sync-hook-install.mjs';

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-hook-install-')));
  const options = { root: join(base, 'private'), codexHome: join(base, '.codex'), claudeHome: join(base, '.claude'),
    nodePath: '/Applications/Claudex.app/Contents/Resources/runtime/bin/node',
    hookPath: '/Applications/Claudex.app/Contents/Resources/engine/bin/claudex-sync-hook.mjs' };
  for (const directory of [options.codexHome, options.claudeHome]) await mkdir(directory, { mode: 0o700 });
  return { base, options, definitions: syncHookDefinitions(options) };
}
const read = async path => JSON.parse(await readFile(path, 'utf8'));

test('installs bounded synchronous native event publishers without replacing user settings', async () => {
  const { options, definitions } = await fixture();
  const original = { permissions: { allow: ['Read'] }, model: 'existing-model',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/private/user-hook' }] }],
      Stop: [{ hooks: [{ type: 'command', command: '/private/user-stop' }] }] } };
  const originalBytes = JSON.stringify(original, null, 4);
  await writeFile(definitions.claude.path, originalBytes);
  const result = await installSyncHooks(options);
  assert.equal(result.changed, true);
  assert.equal(result.configured, true);
  assert.equal(result.providers.codex.requiresTrustReview, true);
  assert.equal(result.providers.codex.trust, 'not-inspected');
  const current = await read(definitions.claude.path);
  assert.deepEqual(current.permissions, original.permissions);
  assert.equal(current.model, original.model);
  assert.deepEqual(current.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(current.hooks.Stop[0], original.hooks.Stop[0]);
  for (const def of Object.values(definitions)) for (const event of def.events) {
    const group = (await read(def.path)).hooks[event].at(-1);
    assert.deepEqual(group, def.group);
    assert.equal(group.hooks[0].timeout, 3);
    assert.equal(group.hooks[0].async, undefined);
  }
  const journal = await read(result.journalPath);
  assert.equal(await readFile(journal.plans.find(p => p.provider === 'claude').beforePath, 'utf8'), originalBytes);
  assert.equal((await lstat(result.journalPath)).mode & 0o777, 0o600);
});

test('repeat installation is a true no-op and inspection does not create files', async () => {
  const { options, definitions } = await fixture();
  assert.equal((await inspectSyncHooks(options)).configured, false);
  assert.deepEqual(await readdir(options.codexHome), []);
  await installSyncHooks(options);
  const before = await lstat(definitions.claude.path, { bigint: true });
  assert.equal((await installSyncHooks(options)).changed, false);
  assert.equal((await lstat(definitions.claude.path, { bigint: true })).mtimeNs, before.mtimeNs);
});

test('upgrades only exact previously owned commands while retaining new native user settings', async () => {
  const { options, definitions } = await fixture();
  await installSyncHooks(options);
  const config = await read(definitions.codex.path);
  config.description = 'My hook configuration';
  config.hooks.Stop.unshift({ hooks: [{ type: 'command', command: '/user/custom' }] });
  await writeFile(definitions.codex.path, JSON.stringify(config));
  const changed = { ...options, nodePath: '/updated/runtime/node' };
  assert.equal((await installSyncHooks(changed)).changed, true);
  const after = await read(definitions.codex.path);
  assert.equal(after.description, config.description);
  assert.deepEqual(after.hooks.Stop[0], config.hooks.Stop[0]);
  assert.equal(after.hooks.Stop.length, 2);
  assert.match(after.hooks.Stop[1].hooks[0].command, /updated\/runtime/);
});

test('malformed second provider fails before writing first provider', async () => {
  const { options, definitions } = await fixture();
  await writeFile(definitions.claude.path, '{"hooks": []}');
  await assert.rejects(installSyncHooks(options), /unsupported shape/);
  await assert.rejects(readFile(definitions.codex.path), { code: 'ENOENT' });
  assert.equal(await readFile(definitions.claude.path, 'utf8'), '{"hooks": []}');
});

test('preserves foreign hook collisions and symlinked native settings', async () => {
  const { options, definitions, base } = await fixture();
  const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /foreign/claudex-sync-hook.mjs' }] }] } };
  await writeFile(definitions.codex.path, JSON.stringify(foreign));
  await assert.rejects(installSyncHooks(options), /unrecognized Claudex hook/);
  assert.deepEqual(await read(definitions.codex.path), foreign);
  const other = await fixture();
  const target = join(base, 'target.json');
  await writeFile(target, '{}');
  await symlink(target, other.definitions.claude.path);
  await assert.rejects(installSyncHooks(other.options), /owned regular file/);
  assert.equal(await readFile(target, 'utf8'), '{}');
});

test('recovers a fully written prepared transaction without duplicating handlers', async () => {
  const { options, definitions } = await fixture();
  const installed = await installSyncHooks(options);
  const journal = await read(installed.journalPath);
  journal.status = 'prepared';
  await writeFile(installed.journalPath, JSON.stringify(journal), { mode: 0o600 });
  const result = await installSyncHooks(options);
  assert.equal(result.changed, false);
  assert.equal((await read(installed.journalPath)).status, 'complete');
  assert.equal((await read(definitions.codex.path)).hooks.Stop.length, 1);
});

test('prepared recovery refuses intervening user edits rather than replaying a saved config', async () => {
  const { options, definitions } = await fixture();
  const installed = await installSyncHooks(options);
  const journal = await read(installed.journalPath);
  journal.status = 'prepared';
  await writeFile(installed.journalPath, JSON.stringify(journal), { mode: 0o600 });
  const changed = { ...(await read(definitions.codex.path)), description: 'User changed this' };
  await writeFile(definitions.codex.path, JSON.stringify(changed));
  await assert.rejects(installSyncHooks(options), /no user edits were overwritten/);
  assert.deepEqual(await read(definitions.codex.path), changed);
});

test('shell-quoted command arguments preserve spaces and apostrophes', () => {
  const definition = syncHookDefinitions({ root: "/private/User's root", nodePath: '/bin/node',
    hookPath: '/private/claudex-sync-hook.mjs', codexHome: '/home/codex', claudeHome: '/home/claude' }).codex;
  assert.match(definition.group.hooks[0].command, /User'\\''s root/);
  assert.throws(() => syncHookDefinitions({ root: '/a\nb', hookPath: '/a/b' }), /single-line/);
});

async function nativeFixture() {
  const f = await fixture();
  await installSyncHooks(f.options);
  const definition = f.definitions.codex;
  const inventory = { cwd: f.options.root, errors: [], warnings: [], hooks: definition.events.map(event => ({
    eventName: event[0].toLowerCase() + event.slice(1), command: definition.group.hooks[0].command,
    enabled: true, currentHash: 'native-current-definition-hash', trustStatus: 'trusted', sourcePath: definition.path,
  })) };
  const requests = [];
  const client = { async request(method, args) { requests.push({ method, args }); return { data: [inventory] }; } };
  return { ...f, inventory, requests, client, inspect: () => inspectNativeSyncHookTrust({ ...f.options, client }) };
}

test('native hook trust inspection is read-only and requires every exact loaded enabled definition', async () => {
  const f = await nativeFixture();
  f.inventory.hooks[0].trustStatus = 'managed';
  const before = await lstat(f.definitions.codex.path, { bigint: true });
  const result = await f.inspect();
  assert.equal(result.ready, true);
  assert.equal(result.codex.trusted, true);
  assert.equal(result.codex.events.length, 5);
  assert.deepEqual(f.requests, [{ method: 'hooks/list', args: { cwds: [f.options.root] } }]);
  assert.equal((await lstat(f.definitions.codex.path, { bigint: true })).mtimeNs, before.mtimeNs);
});

test('missing, disabled, untrusted and modified native hooks produce distinct actionable states', async () => {
  for (const [change, pattern] of [
    [hook => { hook.sourcePath = '/different/hooks.json'; }, /not loaded/],
    [hook => { hook.command += ' changed'; }, /not loaded/],
    [hook => { hook.enabled = false; }, /disabled in Codex/],
    [hook => { hook.trustStatus = 'untrusted'; }, /approval/],
    [hook => { hook.trustStatus = 'modified'; }, /approval/],
    [hook => { hook.currentHash = ''; }, /approval/],
  ]) {
    const f = await nativeFixture(); change(f.inventory.hooks[0]);
    const result = await f.inspect();
    assert.equal(result.ready, false); assert.equal(result.codex.trusted, false);
    assert.match(result.reason, pattern);
  }
  const f = await nativeFixture(); f.inventory.hooks.push({ ...f.inventory.hooks[0] });
  assert.match((await f.inspect()).reason, /not loaded/);
});

test('Claude disabled hooks and absent disk configuration cannot be masked by trusted native inventory', async () => {
  const f = await nativeFixture();
  const config = await read(f.definitions.claude.path); config.disableAllHooks = true;
  await writeFile(f.definitions.claude.path, JSON.stringify(config));
  const disabled = await f.inspect();
  assert.equal(disabled.ready, false); assert.equal(disabled.claude.enabled, false);
  assert.match(disabled.reason, /Claude hooks are disabled/);
  await writeFile(f.definitions.claude.path, '{}');
  assert.match((await f.inspect()).reason, /not configured/);
});

test('native inventory errors block readiness and transport failures propagate unchanged', async () => {
  const f = await nativeFixture(); f.inventory.errors.push({ message: 'native parser failure' });
  assert.match((await f.inspect()).reason, /configuration errors/);
  const failure = new Error('Shared Codex transport closed');
  await assert.rejects(inspectNativeSyncHookTrust({ ...f.options, client: { request: async () => { throw failure; } } }),
    error => error === failure);
  await assert.rejects(inspectNativeSyncHookTrust({ ...f.options, client: { request: async () => ({ data: [] }) } }), /missing or ambiguous/);
});

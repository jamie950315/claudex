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
    const group = (await read(def.path)).hooks[event].find(group => group.hooks[0]?.statusMessage === def.group.hooks[0].statusMessage);
    assert.deepEqual(group, def.group);
    assert.equal(group.hooks[0].timeout, 3);
    assert.equal(group.hooks[0].async, undefined);
  }
  for (const def of Object.values(definitions)) {
    const group = (await read(def.path)).hooks.PostToolUse.at(-1);
    assert.deepEqual(group, def.originGroup);
    assert.equal(group.matcher, '^mcp__claudex[-_]work__claudex_start$');
    assert.equal(group.hooks[0].timeout, 5);
    assert.equal(group.hooks[0].async, undefined);
  }
  assert.deepEqual((await read(definitions.codex.path)).hooks.UserPromptSubmit.at(-1), definitions.codex.warmGroup);
  assert.equal(result.providers.codex.warmCommandConfigured, true);
  assert.equal(definitions.claude.warmGroup, undefined);
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

test('legacy lifecycle-only v1 journals upgrade additively and preserve user PostToolUse groups', async () => {
  const { options, definitions } = await fixture();
  const installed = await installSyncHooks(options);
  const journal = await read(installed.journalPath);
  const user = { matcher: 'Read|Bash', hooks: [{ type: 'command', command: '/private/user-tool-notification' }] };
  for (const [provider, definition] of Object.entries(definitions)) {
    const config = await read(definition.path);
    config.hooks.PostToolUse = [user];
    await writeFile(definition.path, JSON.stringify(config));
    delete journal.definitions[provider].originGroup;
  }
  await writeFile(installed.journalPath, JSON.stringify(journal), { mode: 0o600 });
  const before = await inspectSyncHooks(options);
  assert.equal(before.configured, true);
  assert.equal(before.originConfigured, false);
  assert.equal(before.providers.codex.lifecycleConfigured, true);
  assert.equal(before.providers.codex.originConfigured, false);
  const upgraded = await installSyncHooks(options);
  assert.equal(upgraded.configured, true); assert.equal(upgraded.changed, true);
  assert.equal(upgraded.originConfigured, true);
  for (const definition of Object.values(definitions)) {
    const config = await read(definition.path);
    assert.deepEqual(config.hooks.PostToolUse, [user, definition.originGroup]);
    for (const event of definition.events) assert.deepEqual(config.hooks[event], [definition.group,
      ...(event === 'UserPromptSubmit' && definition.warmGroup ? [definition.warmGroup] : [])]);
  }
  assert.equal((await installSyncHooks(options)).changed, false);
});

test('foreign PostToolUse matches and modified origin ownership journals are never adopted', async () => {
  const f = await fixture();
  const group = { ...f.definitions.codex.originGroup, matcher: '.*' };
  await writeFile(f.definitions.codex.path, JSON.stringify({ hooks: { PostToolUse: [group] } }));
  await assert.rejects(installSyncHooks(f.options), /unrecognized Claudex hook/);
  const g = await fixture(), installed = await installSyncHooks(g.options);
  const journal = await read(installed.journalPath), before = await readFile(g.definitions.codex.path, 'utf8');
  journal.definitions.codex.originGroup.matcher = '.*';
  await writeFile(installed.journalPath, JSON.stringify(journal), { mode: 0o600 });
  await assert.rejects(installSyncHooks(g.options), /origin ownership journal/);
  assert.equal(await readFile(g.definitions.codex.path, 'utf8'), before);
});

test('cache command hooks upgrade independently without adopting foreign definitions or trust', async () => {
  const f = await fixture(), installed = await installSyncHooks(f.options);
  const config = await read(f.definitions.codex.path), journal = await read(installed.journalPath);
  config.hooks.UserPromptSubmit = [f.definitions.codex.group];
  delete journal.definitions.codex.warmGroup;
  await writeFile(f.definitions.codex.path, JSON.stringify(config));
  await writeFile(installed.journalPath, JSON.stringify(journal), { mode: 0o600 });
  assert.equal((await inspectSyncHooks(f.options)).providers.codex.warmCommandConfigured, false);
  assert.equal((await installSyncHooks(f.options)).providers.codex.warmCommandConfigured, true);
  const foreign = await fixture();
  const group = structuredClone(foreign.definitions.codex.warmGroup); group.hooks[0].async = true;
  await writeFile(foreign.definitions.codex.path, JSON.stringify({ hooks: { UserPromptSubmit: [group] } }));
  await assert.rejects(installSyncHooks(foreign.options), /unrecognized Claudex hook/);
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

test('a foreign handler placed in an owned group keeps the hooks configured and upgradable', async () => {
  const { options, definitions } = await fixture();
  await installSyncHooks(options);
  const foreign = { type: 'command', command: "'/Applications/Notifier.app/Contents/MacOS/Notifier' stop-hook", timeout: 5 };
  const shared = async () => {
    const config = await read(definitions.claude.path);
    config.hooks.Stop = [{ hooks: [definitions.claude.group.hooks[0], foreign] }];
    config.hooks.PostToolUse = [{ ...definitions.claude.originGroup, hooks: [foreign, definitions.claude.originGroup.hooks[0]] }];
    await writeFile(definitions.claude.path, JSON.stringify(config));
    return config;
  };
  const config = await shared();
  const status = await inspectSyncHooks(options);
  assert.equal(status.configured, true); assert.equal(status.originConfigured, true);
  // A working shared group is left exactly as the other tool wrote it.
  assert.equal((await installSyncHooks(options)).changed, false);
  assert.deepEqual(await read(definitions.claude.path), config);
  // A duplicate standalone group collapses into the shared one.
  config.hooks.Stop.push(definitions.claude.group);
  await writeFile(definitions.claude.path, JSON.stringify(config));
  assert.equal((await installSyncHooks(options)).changed, true);
  assert.deepEqual((await read(definitions.claude.path)).hooks.Stop, [{ hooks: [definitions.claude.group.hooks[0], foreign] }]);
  // An upgrade removes only the superseded handler and adds its own group.
  await shared();
  const changed = { ...options, nodePath: '/updated/runtime/node' }, updated = syncHookDefinitions(changed).claude;
  const result = await installSyncHooks(changed);
  assert.equal(result.changed, true); assert.equal(result.configured, true); assert.equal(result.originConfigured, true);
  const after = await read(definitions.claude.path);
  assert.deepEqual(after.hooks.Stop, [{ hooks: [foreign] }, updated.group]);
  assert.deepEqual(after.hooks.PostToolUse, [{ matcher: updated.originGroup.matcher, hooks: [foreign] }, updated.originGroup]);
  assert.equal((await installSyncHooks(changed)).changed, false);
});

test('an owned handler in a differently shaped or altered group is still unrecognized', async () => {
  for (const mutate of [
    (group, handler) => ({ ...group, matcher: '.*', hooks: [handler, { type: 'command', command: '/foreign' }] }),
    (group, handler) => ({ ...group, hooks: [{ ...handler, timeout: 9 }, { type: 'command', command: '/foreign' }] }),
  ]) {
    const { options, definitions } = await fixture();
    await installSyncHooks(options);
    const config = await read(definitions.claude.path);
    config.hooks.Stop = [mutate(definitions.claude.group, definitions.claude.group.hooks[0])];
    await writeFile(definitions.claude.path, JSON.stringify(config));
    assert.equal((await inspectSyncHooks(options)).providers.claude.configured, false);
    await assert.rejects(installSyncHooks(options), /unrecognized Claudex hook/);
    assert.deepEqual(await read(definitions.claude.path), config);
  }
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
  const inventory = { cwd: f.options.root, errors: [], warnings: [], hooks: [...definition.events, 'PostToolUse'].map(event => ({
    eventName: event[0].toLowerCase() + event.slice(1), command: definition.group.hooks[0].command,
    enabled: true, currentHash: 'native-current-definition-hash', trustStatus: 'trusted', sourcePath: definition.path,
    ...(event === 'PostToolUse' ? { matcher: definition.originGroup.matcher } : {}),
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
  assert.equal(result.notificationOrigin.ready, true);
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

test('the narrowly matched PostToolUse definition requires its own exact native approval', async () => {
  for (const change of [hook => { hook.matcher = '.*'; }, hook => { hook.trustStatus = 'untrusted'; }, hook => { hook.enabled = false; }]) {
    const f = await nativeFixture();
    change(f.inventory.hooks.find(hook => hook.eventName === 'postToolUse'));
    const result = await f.inspect();
    assert.equal(result.ready, true);
    assert.equal(result.codex.trusted, true);
    assert.equal(result.notificationOrigin.ready, false);
  }
});

test('cache command readiness requires its own native trust and never blocks synchronization', async () => {
  const f = await nativeFixture();
  assert.equal((await f.inspect()).warmCommand.ready, false);
  assert.equal((await f.inspect()).ready, true);
  const hook = { eventName: 'userPromptSubmit', command: f.definitions.codex.warmGroup.hooks[0].command,
    enabled: true, currentHash: 'native-warm-hash', trustStatus: 'untrusted', sourcePath: f.definitions.codex.path };
  f.inventory.hooks.push(hook);
  assert.equal((await f.inspect()).warmCommand.ready, false);
  hook.trustStatus = 'trusted';
  assert.equal((await f.inspect()).warmCommand.ready, true);
  assert.equal((await f.inspect()).ready, true);
});

test('missing optional origin hooks do not block already configured and trusted history synchronization', async () => {
  const f = await nativeFixture();
  f.inventory.hooks = f.inventory.hooks.filter(hook => hook.eventName !== 'postToolUse');
  for (const definition of Object.values(f.definitions)) {
    const config = await read(definition.path);
    delete config.hooks.PostToolUse;
    await writeFile(definition.path, JSON.stringify(config));
  }
  const disk = await inspectSyncHooks(f.options), native = await f.inspect();
  assert.equal(disk.configured, true); assert.equal(disk.originConfigured, false);
  assert.equal(native.ready, true); assert.equal(native.codex.trusted, true);
  assert.equal(native.notificationOrigin.ready, false);
  assert.equal(native.notificationOrigin.codex.configured, false);
  assert.equal(native.notificationOrigin.codex.loaded, false);
  assert.equal(native.notificationOrigin.claude.configured, false);
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

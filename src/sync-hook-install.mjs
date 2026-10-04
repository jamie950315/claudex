import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, withLock } from './storage.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const MARKER = 'Notify Claudex of a native conversation boundary';
const ORIGIN_MARKER = 'Verify the native origin of an opted-in Claudex task';
const WARM_MARKER = 'Handle explicit Claudex cache commands in this Codex chat';
const ORIGIN_MATCHER = '^mcp__claudex[-_]work__claudex_start$';
const EVENTS = {
  codex: ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'],
  claude: ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'],
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const identity = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink']
  .map(key => String(stat[key])).join(':');

function paths(options) {
  const { root, nodePath = process.execPath, hookPath,
    codexHome = join(homedir(), '.codex'), claudeHome = join(homedir(), '.claude') } = options;
  for (const value of [root, nodePath, hookPath, codexHome, claudeHome]) {
    if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value))
      throw new Error('Sync hook paths must be absolute single-line paths.');
  }
  return { root, directory: join(root, 'sync-hooks'), nodePath, hookPath, codexHome, claudeHome };
}

// Reject alias components before any config or recovery read/write. Native homes
// remain native homes: this module never copies authentication namespaces.
async function checkParents(path) {
  let current = dirname(path);
  while (true) {
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Sync hook parent is not a real directory.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function readStable(path) {
  await checkParents(path);
  let stat;
  try { stat = await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return { text: null, digest: null, identity: null }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid())
      || stat.size > BigInt(MAX_BYTES)) throw new Error('Sync hook file must be a bounded owned regular file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (identity(await file.stat({ bigint: true })) !== identity(stat)) throw new Error('Sync hook file changed during inspection.');
    const text = await file.readFile('utf8');
    if (identity(await file.stat({ bigint: true })) !== identity(stat)
        || identity(await lstat(path, { bigint: true })) !== identity(stat))
      throw new Error('Sync hook file changed during inspection.');
    return { text, digest: hash(text), identity: identity(stat) };
  } finally { await file.close(); }
}

async function writeChecked(path, text, expected) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Sync hook configuration exceeds the bounded size limit.');
  await checkParents(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.claudex-${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(text); await file.sync(); await file.close();
    const current = await readStable(path);
    if (current.digest !== expected.digest || current.identity !== expected.identity)
      throw new Error('Sync hook configuration changed; existing user configuration was preserved.');
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;
async function save(path, value) { await writeChecked(path, json(value), await readStable(path)); }
function decode(snapshot) {
  if (snapshot.text === null) return {};
  let value;
  try { value = JSON.parse(snapshot.text); } catch { throw new Error('Native hook configuration is malformed; it was preserved.'); }
  if (!object(value) || (value.hooks !== undefined && !object(value.hooks)))
    throw new Error('Native hook configuration has an unsupported shape; it was preserved.');
  return value;
}

export function syncHookDefinitions(options) {
  const config = paths(options);
  return Object.fromEntries(Object.entries(EVENTS).map(([provider, events]) => {
    const command = [config.nodePath, config.hookPath, '--root', config.root, '--provider', provider].map(quote).join(' ');
    const warmCommand = [config.nodePath, join(dirname(config.hookPath), 'claudex-codex-warm-hook.mjs'), '--root', config.root].map(quote).join(' ');
    return [provider, { provider, path: join(config[`${provider}Home`], provider === 'codex' ? 'hooks.json' : 'settings.json'),
      events, group: { hooks: [{ type: 'command', command, timeout: 3, statusMessage: MARKER }] },
      ...(provider === 'codex' ? { warmGroup: { hooks: [{ type: 'command', command: warmCommand, timeout: 30, statusMessage: WARM_MARKER }] } } : {}),
      originGroup: { matcher: ORIGIN_MATCHER, hooks: [{ type: 'command', command, timeout: 5, statusMessage: ORIGIN_MARKER }] } }];
  }));
}

function ownsGroup(definition, event, group) {
  return definition && (definition.events.includes(event) && JSON.stringify(group) === JSON.stringify(definition.group)
    || event === 'UserPromptSubmit' && definition.warmGroup && JSON.stringify(group) === JSON.stringify(definition.warmGroup)
    || event === 'PostToolUse' && definition.originGroup && JSON.stringify(group) === JSON.stringify(definition.originGroup));
}

function merge(snapshot, definition, prior) {
  const config = decode(snapshot);
  const hooks = config.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks)))
      throw new Error('Native hook matcher groups have an unsupported shape; they were preserved.');
    for (const group of groups) for (const handler of group.hooks) {
      if (typeof handler?.command !== 'string') continue;
      const owned = ownsGroup(definition, event, group) || ownsGroup(prior, event, group);
      if ((handler.command.includes('claudex-sync-hook.mjs') || handler.command.includes('claudex-codex-warm-hook.mjs')) && !owned)
        throw new Error('An unrecognized Claudex hook already exists; review it before installing another.');
    }
  }
  for (const event of new Set([...definition.events, ...(prior?.events ?? []), 'PostToolUse'])) {
    const retained = (hooks[event] ?? []).filter(group => !ownsGroup(definition, event, group) && !ownsGroup(prior, event, group));
    if (definition.events.includes(event)) retained.push(definition.group);
    if (event === 'UserPromptSubmit' && definition.warmGroup) retained.push(definition.warmGroup);
    if (event === 'PostToolUse') retained.push(definition.originGroup);
    hooks[event] = retained;
  }
  return { ...config, hooks };
}

function validateJournal(value, definitions, directory) {
  if (!object(value) || value.version !== 1 || !['prepared', 'complete'].includes(value.status)
      || !Array.isArray(value.plans) || value.plans.length > 2 || !object(value.definitions))
    throw new Error('Invalid sync hook installation journal; recovery evidence was preserved.');
  for (const plan of value.plans) {
    if (!definitions[plan.provider] || plan.path !== definitions[plan.provider].path
        || !/^[a-f0-9-]{36}$/.test(plan.id)
        || plan.beforePath !== join(directory, `${plan.id}.before.json`)
        || plan.afterPath !== join(directory, `${plan.id}.after.json`)
        || !/^[a-f0-9]{64}$/.test(plan.afterDigest)
        || !(plan.beforeDigest === null || /^[a-f0-9]{64}$/.test(plan.beforeDigest)))
      throw new Error('Sync hook journal targets changed; recovery evidence was preserved.');
  }
  for (const provider of Object.keys(value.definitions)) {
    const def = value.definitions[provider];
    if (!definitions[provider] || def.path !== definitions[provider].path || !Array.isArray(def.events)
        || def.events.some(event => !EVENTS[provider].includes(event))
        || !object(def.group) || !Array.isArray(def.group.hooks) || def.group.hooks.length !== 1
        || def.group.hooks[0]?.statusMessage !== MARKER || def.group.hooks[0]?.type !== 'command')
      throw new Error('Sync hook ownership journal is invalid.');
    if (def.originGroup !== undefined && (!object(def.originGroup) || def.originGroup.matcher !== ORIGIN_MATCHER
      || !Array.isArray(def.originGroup.hooks) || def.originGroup.hooks.length !== 1
      || def.originGroup.hooks[0]?.statusMessage !== ORIGIN_MARKER || def.originGroup.hooks[0]?.type !== 'command'
      || typeof def.originGroup.hooks[0]?.command !== 'string' || def.originGroup.hooks[0]?.timeout !== 5))
      throw new Error('Sync hook origin ownership journal is invalid.');
    if (def.warmGroup !== undefined && (provider !== 'codex' || !object(def.warmGroup)
      || Object.keys(def.warmGroup).some(key => key !== 'hooks')
      || !Array.isArray(def.warmGroup.hooks) || def.warmGroup.hooks.length !== 1
      || def.warmGroup.hooks[0]?.statusMessage !== WARM_MARKER || def.warmGroup.hooks[0]?.type !== 'command'
      || typeof def.warmGroup.hooks[0]?.command !== 'string' || def.warmGroup.hooks[0]?.timeout !== 30
      || Object.keys(def.warmGroup.hooks[0]).some(key => !['type', 'command', 'timeout', 'statusMessage'].includes(key))))
      throw new Error('Cache command hook ownership journal is invalid.');
  }
  return value;
}

async function loadJournal(directory, definitions) {
  const snapshot = await readStable(join(directory, 'installation.json'));
  if (snapshot.text === null) return null;
  let value;
  try { value = JSON.parse(snapshot.text); } catch { throw new Error('Sync hook installation journal is malformed.'); }
  return validateJournal(value, definitions, directory);
}

/** Configuration presence is deliberately not proof of Codex native trust. */
export async function inspectSyncHooks(options) {
  const definitions = syncHookDefinitions(options);
  const result = {};
  for (const [provider, definition] of Object.entries(definitions)) {
    const config = decode(await readStable(definition.path));
    const lifecycleConfigured = definition.events.every(event => Array.isArray(config.hooks?.[event])
      && config.hooks[event].some(group => JSON.stringify(group) === JSON.stringify(definition.group)));
    const originConfigured = Array.isArray(config.hooks?.PostToolUse)
      && config.hooks.PostToolUse.some(group => JSON.stringify(group) === JSON.stringify(definition.originGroup));
    result[provider] = { configured: lifecycleConfigured, lifecycleConfigured, originConfigured,
      path: definition.path, events: definition.events,
      ...(provider === 'codex' ? { warmCommandConfigured: Array.isArray(config.hooks?.UserPromptSubmit)
        && config.hooks.UserPromptSubmit.some(group => JSON.stringify(group) === JSON.stringify(definition.warmGroup)) } : {}),
      ...(provider === 'codex' ? { trust: 'not-inspected', requiresTrustReview: true } : {}) };
  }
  return { configured: Object.values(result).every(value => value.configured),
    originConfigured: Object.values(result).every(value => value.originConfigured), providers: result };
}

/** Read native approval state without granting trust or changing any hook. */
export async function inspectNativeSyncHookTrust({ client, ...options }) {
  if (typeof client?.request !== 'function') throw new Error('Native hook inspection requires a Codex client.');
  const definitions = syncHookDefinitions(options), disk = await inspectSyncHooks(options);
  const claudeSettings = decode(await readStable(definitions.claude.path));
  const claude = { configured: disk.providers.claude.configured, enabled: claudeSettings.disableAllHooks !== true };
  const response = await client.request('hooks/list', { cwds: [options.root] });
  if (!object(response) || !Array.isArray(response.data)) throw new Error('Native Codex hook inventory has an invalid shape.');
  const inventories = response.data.filter(item => item?.cwd === options.root);
  if (inventories.length !== 1 || !Array.isArray(inventories[0].hooks)
      || !Array.isArray(inventories[0].errors)) throw new Error('Native Codex hook inventory is missing or ambiguous.');
  const inventory = inventories[0], expected = definitions.codex;
  const inspectEvent = (eventName, groupOverride) => {
    const nativeEvent = eventName[0].toLowerCase() + eventName.slice(1);
    const group = groupOverride ?? (eventName === 'PostToolUse' ? expected.originGroup : expected.group);
    const found = inventory.hooks.filter(hook => hook?.eventName === nativeEvent
      && hook.command === group.hooks[0].command && hook.sourcePath === expected.path
      && (eventName !== 'PostToolUse' || hook.matcher === group.matcher));
    const hook = found.length === 1 ? found[0] : null;
    return { event: eventName, loaded: found.length === 1, enabled: hook?.enabled === true,
      trusted: hook?.enabled === true && typeof hook.currentHash === 'string' && hook.currentHash.length > 0
        && ['trusted', 'managed'].includes(hook.trustStatus),
      trustStatus: hook && ['trusted', 'managed', 'untrusted', 'modified'].includes(hook.trustStatus)
        ? hook.trustStatus : 'unknown' };
  };
  const events = expected.events.map(event => inspectEvent(event));
  const origin = inspectEvent('PostToolUse');
  const warmCommand = { configured: disk.providers.codex.warmCommandConfigured,
    ...inspectEvent('UserPromptSubmit', expected.warmGroup) };
  warmCommand.ready = warmCommand.configured && warmCommand.trusted && inventory.errors.length === 0;
  const notificationOrigin = {
    codex: { configured: disk.providers.codex.originConfigured, ...origin },
    claude: { configured: disk.providers.claude.originConfigured, enabled: claude.enabled },
  };
  notificationOrigin.ready = notificationOrigin.codex.configured && notificationOrigin.codex.trusted
    && notificationOrigin.claude.configured && notificationOrigin.claude.enabled && inventory.errors.length === 0;
  const codex = { configured: disk.providers.codex.configured, loaded: events.every(event => event.loaded),
    trusted: events.every(event => event.trusted), events };
  let reason;
  if (!codex.configured || !claude.configured) reason = 'Conversation completion hooks are not configured. Run Claudex setup to install them.';
  else if (!claude.enabled) reason = 'Claude hooks are disabled. Enable hooks in Claude settings to resume event-driven synchronization.';
  else if (inventory.errors.length) reason = 'Codex reported hook configuration errors. Review the native hooks configuration before synchronizing.';
  else if (!codex.loaded) reason = 'Codex has not loaded all Claudex completion hooks. Open /hooks in Codex and review the configured hooks.';
  else if (events.some(event => !event.enabled)) reason = 'Claudex completion hooks are disabled in Codex. Open /hooks to review and enable them.';
  else if (!codex.trusted) reason = 'Claudex completion hooks need native Codex approval. Open /hooks and trust the exact Claudex hook definitions.';
  return { ready: reason === undefined, codex, claude, notificationOrigin, warmCommand, ...(reason ? { reason } : {}) };
}

/** Install notification hooks and the separately trusted local cache-command hook.
 * No model work, warming enrollment or native trust writes occur during setup. */
export async function installSyncHooks(options) {
  const config = paths(options);
  const definitions = syncHookDefinitions(options);
  await checkParents(join(config.directory, 'installation.json'));
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const info = await lstat(config.directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077))
    throw new Error('Sync hook recovery directory must be private and owned.');
  return withLock(join(config.directory, 'install.lock'), async () => {
    let journal = await loadJournal(config.directory, definitions);
    if (journal?.status === 'prepared') {
      for (const plan of journal.plans) {
        const current = await readStable(plan.path);
        if (current.digest === plan.afterDigest) continue;
        if (current.digest !== plan.beforeDigest || current.identity !== plan.beforeIdentity)
          throw new Error('Native configuration changed during hook recovery; no user edits were overwritten.');
        const saved = await readStable(plan.afterPath);
        if (saved.digest !== plan.afterDigest) throw new Error('Sync hook recovery payload changed.');
        if (plan.beforeDigest !== null && (await readStable(plan.beforePath)).digest !== plan.beforeDigest)
          throw new Error('Sync hook recovery backup changed.');
        await writeChecked(plan.path, saved.text, current);
      }
      journal.status = 'complete';
      await save(join(config.directory, 'installation.json'), journal);
    }
    // Preflight both native configurations before changing either of them.
    const plans = [];
    for (const [provider, definition] of Object.entries(definitions)) {
      const before = await readStable(definition.path);
      const after = merge(before, definition, journal?.definitions[provider]);
      if (JSON.stringify(decode(before)) === JSON.stringify(after)) continue;
      const id = randomUUID();
      plans.push({ provider, path: definition.path, id, beforeDigest: before.digest, beforeIdentity: before.identity,
        afterDigest: hash(json(after)), beforePath: join(config.directory, `${id}.before.json`),
        afterPath: join(config.directory, `${id}.after.json`), before, after: json(after) });
    }
    if (plans.length) {
      if ((await readdir(config.directory)).filter(name => name.endsWith('.before.json') || name.endsWith('.after.json')).length + plans.length * 2 > 128)
        throw new Error('Sync hook recovery storage limit reached; retain and review old backups before another update.');
      for (const plan of plans) {
        if (plan.before.text !== null) await writeChecked(plan.beforePath, plan.before.text, { digest: null, identity: null });
        await writeChecked(plan.afterPath, plan.after, { digest: null, identity: null });
      }
      journal = { version: 1, status: 'prepared', definitions,
        plans: plans.map(({ before, after, ...plan }) => plan) };
      await save(join(config.directory, 'installation.json'), journal);
      for (const plan of plans) await writeChecked(plan.path, plan.after, plan.before);
      journal.status = 'complete';
      await save(join(config.directory, 'installation.json'), journal);
    }
    return { ...await inspectSyncHooks(options), changed: plans.length > 0,
      journalPath: join(config.directory, 'installation.json') };
  }, { recoverDead: true });
}

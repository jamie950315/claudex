import { constants } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { privateDirectory, withLock, writeJSON } from './storage.mjs';

const name = 'claudex-desktop-wake';
const limit = 16 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = message => { throw new Error(`Claude Desktop wake installation: ${message}`); };
const stable = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode', 'nlink'].every(key => a[key] === b[key]);

async function directoryIdentity(path, privateMode = false) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & (privateMode ? 0o077 : 0o022))) fail('directory must be owned and non-writable by other users.');
  if (await realpath(path) !== resolve(path)) fail('directory path must not traverse symlinks.');
  return stat;
}

async function readOwned(path, privateMode = false) {
  let before;
  try { before = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || before.nlink !== 1
      || (before.mode & (privateMode ? 0o077 : 0o022)) || before.size > limit) fail('configuration evidence must be a bounded owned regular file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!stable(before, await file.stat())) fail('file changed while opening.');
    const bytes = await file.readFile();
    if (!stable(before, await file.stat()) || !stable(before, await lstat(path))) fail('file changed while reading.');
    return { bytes, hash: digest(bytes), stat: before };
  } finally { await file.close(); }
}

function parse(read, label) {
  if (!read) return {};
  try {
    const value = JSON.parse(read.bytes.toString('utf8'));
    if (!object(value)) fail(`${label} must be a JSON object.`);
    return value;
  } catch { fail(`${label} is malformed; existing contents were preserved.`); }
}

function entryOf(config) {
  if (config.mcpServers !== undefined && !object(config.mcpServers)) fail('mcpServers must be an object.');
  if (!Object.hasOwn(config.mcpServers ?? {}, name)) return null;
  if (!object(config.mcpServers[name])) fail('the Desktop MCP name has an invalid existing registration.');
  return config.mcpServers[name];
}

function installedBytes(config, entry) {
  const bytes = `${JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, [name]: entry } }, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > limit) fail('prepared configuration exceeds the bounded size limit.');
  return bytes;
}

async function publishConfig(path, bytes, expected) {
  const temporary = `${path}.claudex-${randomUUID()}`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes); await file.sync();
  } finally { await file.close(); }
  try {
    const current = await readOwned(path);
    if ((current?.hash ?? null) !== (expected?.hash ?? null)
      || (current && expected && !stable(current.stat, expected.stat))) fail('configuration changed before publication.');
    if (expected) await rename(temporary, path);
    else await link(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Add only the owned Desktop connector entry, without restarting native applications. */
export async function installClaudeDesktopWake({ root,
  configPath = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  command = process.execPath, args }) {
  if (![root, configPath, command].every(value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')))
    fail('root, config and command must be absolute paths.');
  root = resolve(root); configPath = resolve(configPath);
  if (!Array.isArray(args) || args.length !== 6 || typeof args[0] !== 'string' || !isAbsolute(args[0])
    || args[0].includes('\0') || !same(args.slice(1), ['desktop-wake-mcp', '--root', root, '--peer', 'claude']))
    fail('arguments must select the exact collaboration root and Claude Desktop wake facade.');
  const parent = dirname(configPath);
  // The vendor's configuration directory must already exist; never invent a Desktop installation.
  const parentBefore = await directoryIdentity(parent);
  await privateDirectory(root);
  await directoryIdentity(root, true);
  const journalPath = join(root, 'claude-desktop-wake-install.json');
  const entry = { command, args: [...args] };
  return withLock(join(root, 'claude-desktop-wake-install.lock'), async () => {
    let current = await readOwned(configPath);
    let config = parse(current, 'Desktop configuration');
    const existing = entryOf(config);
    const journalRead = await readOwned(journalPath, true);
    let journal = journalRead ? parse(journalRead, 'installation journal') : null;
    if (journal) {
      if (journal.version !== 1 || journal.configPath !== configPath || journal.name !== name
        || !['prepared', 'installed'].includes(journal.phase) || !same(journal.installedEntry, entry)
        || !(journal.previousEntry === null || same(journal.previousEntry, entry))
        || !(journal.beforeHash === null || /^[0-9a-f]{64}$/.test(journal.beforeHash))
        || !/^[0-9a-f]{64}$/.test(journal.afterHash)) fail('installation journal differs from the requested registration.');
      if (journal.phase === 'installed') {
        if (!same(existing, entry)) fail('installed entry was changed outside Claudex; no configuration was changed.');
        return { installed: true, changed: false, name, configPath, restartRequired: true };
      }
      if ((current?.hash ?? null) === journal.afterHash && same(existing, entry)) {
        journal.phase = 'installed';
        await writeJSON(journalPath, journal);
        return { installed: true, changed: false, recovered: true, name, configPath, restartRequired: true };
      }
      if ((current?.hash ?? null) !== journal.beforeHash || !same(existing, journal.previousEntry))
        fail('configuration changed after preparation; no configuration was changed.');
    } else {
      if (existing !== null && !same(existing, entry)) fail('the Desktop MCP name belongs to a different registration.');
      const after = existing === null ? installedBytes(config, entry) : current.bytes;
      journal = { version: 1, name, configPath, phase: 'prepared', previousEntry: existing,
        installedEntry: entry, beforeHash: current?.hash ?? null, afterHash: digest(after) };
      await writeJSON(journalPath, journal);
    }
    const after = existing === null ? installedBytes(config, entry) : current.bytes;
    if (digest(after) !== journal.afterHash) fail('prepared output no longer matches its journal.');
    const parentNow = await directoryIdentity(parent);
    if (parentBefore.dev !== parentNow.dev || parentBefore.ino !== parentNow.ino) fail('configuration directory identity changed.');
    const checked = await readOwned(configPath);
    if ((checked?.hash ?? null) !== (current?.hash ?? null)
      || (checked && current && !stable(checked.stat, current.stat))) fail('configuration changed before publication.');
    let changed = false;
    if ((current?.hash ?? null) !== journal.afterHash) {
      await publishConfig(configPath, after, current);
      changed = true;
    }
    current = await readOwned(configPath);
    config = parse(current, 'Desktop configuration');
    if (current?.hash !== journal.afterHash || !same(entryOf(config), entry)) fail('configuration did not retain the prepared registration.');
    journal.phase = 'installed';
    await writeJSON(journalPath, journal);
    return { installed: true, changed, name, configPath, restartRequired: true };
  }, { recoverDead: true });
}

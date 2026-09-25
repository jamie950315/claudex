import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { hash } from './storage.mjs';

const execute = promisify(execFile);
const MANAGED_LIMIT = 2 * 1024 * 1024;
const REMOTE_LIMIT = 8 * 1024 * 1024;
const MAX_DROP_INS = 256;
const fail = reason => new Error(`Cold maintenance policy preflight failed: ${reason}.`);
const identity = info => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
const sameIdentity = (left, right) => hash(identity(left)) === hash(identity(right));

async function inspectPath(path, kind, io) {
  let info;
  try { info = await io.lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('a policy source could not be inspected');
  }
  if (info.isSymbolicLink() || !(kind === 'directory' ? info.isDirectory() : info.isFile()))
    throw fail('policy sources must be regular files and directories without symbolic links');
  return info;
}

async function readBounded(path, initial, limit, io) {
  if (initial.size > limit) throw fail('a policy source exceeds its pinned size limit');
  let file;
  try {
    file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameIdentity(initial, await file.stat())) throw fail('a policy source changed before it was read');
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) throw fail('a policy source exceeds its pinned size limit');
    if (used !== initial.size || !sameIdentity(initial, await file.stat()))
      throw fail('a policy source changed while it was read');
    return buffer.subarray(0, used);
  } catch (error) {
    // Never surface paths, subprocess stderr, policy values, or parse excerpts.
    if (error?.message?.startsWith('Cold maintenance policy preflight failed:')) throw error;
    throw fail('a policy source could not be read');
  } finally {
    try { await file?.close(); }
    catch { throw fail('a policy source could not be closed after reading'); }
  }
}

function parseObject(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
    return value;
  } catch { throw fail('a policy source is not a valid strict JSON object'); }
}

/**
 * Read-only, bounded preflight for the pinned macOS policy sources. The native
 * SDK resolver drops parse/read diagnostics, so a successful empty resolution
 * alone cannot prove these inputs were absent or readable. JSONC is deliberately
 * refused rather than guessed; no policy is rewritten to make it acceptable.
 * Optional paths/io/runner are fixture seams, not automatic fallback sources.
 */
export async function inspectMaintenancePolicy({ claudeHome, platform = process.platform, username = userInfo().username,
  paths, io = { lstat, open, readdir }, runner = execute } = {}) {
  if (platform !== 'darwin') throw fail('this pinned policy preflight supports macOS only');
  if (!isAbsolute(claudeHome ?? '') || typeof username !== 'string' || !username || /[/\\]/.test(username))
    throw fail('the policy namespace is invalid');
  if (paths && ['managedDirectory', 'mdmUserPlist', 'mdmDevicePlist'].some(key => !isAbsolute(paths[key] ?? '')))
    throw fail('fixture policy paths must be complete and absolute');
  paths ??= {
    managedDirectory: '/Library/Application Support/ClaudeCode',
    mdmUserPlist: `/Library/Managed Preferences/${username}/com.anthropic.claudecode.plist`,
    mdmDevicePlist: '/Library/Managed Preferences/com.anthropic.claudecode.plist',
  };
  const sources = [], observations = [];
  const remember = (path, kind, info, extra = {}, enumerate = false) => {
    observations.push({ path, kind, info, enumerate });
    // Parent-directory mtime can change because Claude writes unrelated runtime
    // files. Only a listed drop-in directory needs the full metadata checkpoint.
    const metadata = info && kind === 'directory' && !enumerate ? { dev: info.dev, ino: info.ino } : info ? identity(info) : {};
    sources.push({ path, kind, exists: info !== null, ...metadata, ...extra });
  };
  const directory = async (path, enumerate = false) => {
    const info = await inspectPath(path, 'directory', io);
    remember(path, 'directory', info, {}, enumerate); return info;
  };
  const file = async (path, format, limit) => {
    const info = await inspectPath(path, 'file', io);
    if (!info) { remember(path, format, null); return; }
    const bytes = await readBounded(path, info, limit, io);
    if (format === 'plist') {
      let output;
      try {
        const result = await runner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path],
          { encoding: 'utf8', timeout: 5000, maxBuffer: MANAGED_LIMIT + 1 });
        output = Buffer.from(result.stdout);
      } catch { throw fail('a managed preferences source could not be decoded'); }
      if (output.length > MANAGED_LIMIT) throw fail('decoded managed preferences exceed the pinned size limit');
      parseObject(output);
    } else parseObject(bytes);
    // Only source metadata is returned; no policy values escape this function.
    remember(path, format, info, { sha256: createHash('sha256').update(bytes).digest('hex') });
  };

  await directory(paths.managedDirectory);
  await file(join(paths.managedDirectory, 'managed-settings.json'), 'json', MANAGED_LIMIT);
  const dropIns = join(paths.managedDirectory, 'managed-settings.d');
  if (await directory(dropIns, true)) {
    let entries;
    try { entries = await io.readdir(dropIns, { withFileTypes: true }); }
    catch { throw fail('the managed policy drop-in directory could not be listed'); }
    const selected = entries.filter(entry => !entry.name.startsWith('.') && entry.name.endsWith('.json'))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (selected.length > MAX_DROP_INS) throw fail('there are too many managed policy drop-ins');
    for (const entry of selected) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw fail('a managed policy drop-in is not a regular file');
      await file(join(dropIns, entry.name), 'json', MANAGED_LIMIT);
    }
  }
  for (const path of new Set([dirname(paths.mdmUserPlist), dirname(paths.mdmDevicePlist), claudeHome])) await directory(path);
  await file(paths.mdmUserPlist, 'plist', MANAGED_LIMIT);
  await file(paths.mdmDevicePlist, 'plist', MANAGED_LIMIT);
  await file(join(claudeHome, 'remote-settings.json'), 'remote-json', REMOTE_LIMIT);
  for (const observation of observations) {
    const current = await inspectPath(observation.path, observation.kind === 'directory' ? 'directory' : 'file', io);
    const unchanged = current && observation.info && (observation.kind === 'directory' && !observation.enumerate
      ? current.dev === observation.info.dev && current.ino === observation.info.ino : sameIdentity(current, observation.info));
    if (Boolean(current) !== Boolean(observation.info) || current && !unchanged)
      throw fail('policy sources changed during the read-only preflight');
  }
  return { version: 1, platform, sources };
}

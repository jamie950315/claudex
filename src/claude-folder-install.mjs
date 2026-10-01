import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, link, unlink, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { withLock } from './storage.mjs';
import { buildDynamicFolderSource, FOLDER_SOURCE_SHA256, inspectFolderCache, replaceFolderCacheSource, sha256 } from './claude-folder-cache.mjs';

const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const STAGE = /^\.claudex-folder-[a-f0-9-]{36}\.tmp$/;
const fail = message => { throw new Error(`Claude folder installation: ${message}`); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameSnapshot = (a, b) => sameFile(a, b)
  && ['size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].every(key => a[key] === b[key]);

function canonicalPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path))
    fail('paths must be canonical absolute paths');
}

function checkFile(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid())
      || (info.mode & 0o7777n) !== 0o600n || info.nlink !== 1n) fail('file must be private, owned, regular, and single-linked');
}

async function directory(path, create = false) {
  canonicalPath(path);
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid())
      || (info.mode & 0o7777n) !== 0o700n || await realpath(path) !== path)
    fail('directory must be canonical, private, and owned');
  return info;
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function snapshot(path, maximum = MAX_CACHE_BYTES) {
  const before = await lstat(path, { bigint: true });
  checkFile(before);
  if (before.size <= 0n || before.size > BigInt(maximum)) fail('file size is outside its bound');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat({ bigint: true });
    checkFile(opened);
    if (!sameSnapshot(before, opened)) fail('file changed while opening');
    // Bound allocation even if another process grows the file after stat().
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) fail('file changed while reading');
      offset += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    checkFile(after); checkFile(named);
    if (!sameSnapshot(before, after) || !sameSnapshot(before, named)) fail('file changed while reading');
    return { bytes, hash: sha256(bytes), info: named };
  } finally { await file.close(); }
}

async function optionalSnapshot(path, maximum) {
  try { return await snapshot(path, maximum); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertUnchanged(path, expected, maximum) {
  const current = await optionalSnapshot(path, maximum);
  if (expected === null ? current !== null
    : current === null || current.hash !== expected.hash || !sameSnapshot(current.info, expected.info))
    fail('file changed before publication; external contents were preserved');
}

async function removeStage(path, expected) {
  await assertUnchanged(path, expected);
  await unlink(path);
}

async function stage(path, bytes) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  return snapshot(path, Math.max(bytes.length, 1));
}

function validateManifest(value, { root, cachePath, sourceHash }) {
  const keys = ['version', 'root', 'cachePath', 'sourceHash', 'originalHash', 'patchedHash', 'previousPatchedHash', 'phase', 'action', 'stagingName'];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.version !== 1
      || value.root !== root || value.cachePath !== cachePath || value.sourceHash !== sourceHash
      || typeof value.originalHash !== 'string' || !HEX.test(value.originalHash)
      || typeof value.patchedHash !== 'string' || !HEX.test(value.patchedHash) || value.originalHash === value.patchedHash
      || value.previousPatchedHash !== null && (typeof value.previousPatchedHash !== 'string' || !HEX.test(value.previousPatchedHash))
      || !['prepared', 'installed'].includes(value.phase) || !['install', 'restore'].includes(value.action)
      || value.phase === 'prepared' && (typeof value.stagingName !== 'string' || !STAGE.test(value.stagingName))
      || value.phase === 'installed' && (value.stagingName !== null || value.previousPatchedHash !== null)
      || value.action === 'restore' && value.previousPatchedHash !== null)
    fail('invalid or differently bound manifest');
  return value;
}

function parseManifest(data, bindings) {
  let value;
  try { value = JSON.parse(data.bytes.toString('utf8')); }
  catch { fail('malformed manifest'); }
  return validateManifest(value, bindings);
}

async function writeManifest(path, value, expected) {
  const temporary = join(dirname(path), `.manifest-${randomUUID()}.tmp`);
  const staged = await stage(temporary, Buffer.from(JSON.stringify(value) + '\n'));
  try {
    await assertUnchanged(path, expected, 16 * 1024);
    if (expected === null) { await link(temporary, path); await unlink(temporary); }
    else await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    const remaining = await optionalSnapshot(temporary, 16 * 1024);
    if (remaining) await removeStage(temporary, staged);
  }
  return snapshot(path, 16 * 1024);
}

async function publishOriginal(path, bytes) {
  const temporary = join(dirname(path), `.original-${randomUUID()}.tmp`);
  const staged = await stage(temporary, bytes);
  try { await link(temporary, path); }
  finally {
    // link() temporarily creates two names; the exclusive staging name is ours.
    const named = await lstat(temporary, { bigint: true });
    if (!sameFile(named, staged.info)) fail('backup staging identity changed');
    await unlink(temporary);
  }
  await syncDirectory(dirname(path));
  return snapshot(path);
}

function ownsCurrent(manifest, hash) {
  return hash === manifest.originalHash || hash === manifest.patchedHash
    || manifest.phase === 'prepared' && hash === manifest.previousPatchedHash;
}

export async function buildClaudeFolderCandidate({ original, root, projectionSource, runtimeSource, handoffSource, anchorSource, wakeSource,
  registryRoot = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions') }) {
  const entry = inspectFolderCache(original);
  const projection = projectionSource ?? await readFile(new URL('./claude-folder-projection.mjs', import.meta.url), 'utf8');
  const runtime = runtimeSource ?? await readFile(new URL('./claude-folder-runtime.mjs', import.meta.url), 'utf8');
  const handoff = handoffSource ?? await readFile(new URL('./claude-desktop-handoff-runtime.mjs', import.meta.url), 'utf8');
  const wake = wakeSource ?? await readFile(new URL('./claude-chat-wake-runtime.mjs', import.meta.url), 'utf8');
  const anchor = anchorSource ?? await readFile(new URL('./claude-folder-anchor.mjs', import.meta.url), 'utf8');
  return replaceFolderCacheSource(original, buildDynamicFolderSource(entry.source,
    { root, projectionSource: projection, runtimeSource: runtime, handoffSource: handoff, anchorSource: anchor, wakeSource: wake, registryRoot }));
}

async function operate(action, options, dependencies) {
  const inspectCache = bytes => inspectFolderCache(bytes, { targetURL: dependencies.targetURL });
  const { root, cachePath } = options;
  canonicalPath(root); canonicalPath(cachePath);
  const sourceHash = dependencies.sourceHash ?? FOLDER_SOURCE_SHA256;
  if (typeof sourceHash !== 'string' || !HEX.test(sourceHash)) fail('invalid expected source hash');
  const bindings = { root, cachePath, sourceHash };
  const rootInfo = await directory(root);
  const privatePath = join(root, 'ui-folder-compat');
  if (cachePath === privatePath || cachePath.startsWith(privatePath + '/')) fail('cache target must not be installer state');
  const privateInfo = await directory(privatePath, true);
  const cacheParent = dirname(cachePath), parentInfo = await directory(cacheParent);
  const checkDirectories = async () => {
    if (!sameFile(rootInfo, await directory(root)) || !sameFile(privateInfo, await directory(privatePath))
        || !sameFile(parentInfo, await directory(cacheParent))) fail('directory identity changed');
  };
  return withLock(join(privatePath, 'install.lock'), async () => {
    await checkDirectories();
    // A crash during journal/backup publication cannot accumulate new staging
    // files. Preserve an unjournaled artifact for explicit inspection instead.
    if ((await readdir(privatePath)).some(name => /^\.(?:manifest|original)-.*\.tmp$/.test(name)))
      fail('interrupted private publication needs inspection; staging was preserved');
    const manifestPath = join(privatePath, 'manifest.json'), backupPath = join(privatePath, 'original.cache');
    let manifestSnapshot = await optionalSnapshot(manifestPath, 16 * 1024);
    let manifest = manifestSnapshot ? parseManifest(manifestSnapshot, bindings) : null;
    const current = await snapshot(cachePath);
    const currentEntry = inspectCache(current.bytes);
    let original = await optionalSnapshot(backupPath);
    if (manifest) {
      if (!original || original.hash !== manifest.originalHash) fail('original backup is missing or changed');
      if (!ownsCurrent(manifest, current.hash)) fail('cache changed outside this installer; nothing was overwritten');
    } else {
      if (action === 'restore') fail('no installation manifest exists');
      if (currentEntry.sourceHash !== sourceHash) fail('unvalidated frontend source; nothing was overwritten');
      if (original && original.hash !== current.hash) fail('unjournaled backup does not match the current original');
    }
    if (original && inspectCache(original.bytes).sourceHash !== sourceHash) fail('original source binding changed');
    let candidate;
    if (action === 'install') {
      candidate = await (dependencies.buildCandidate ?? buildClaudeFolderCandidate)({ ...options, original: Buffer.from(original?.bytes ?? current.bytes) });
      inspectCache(candidate);
      if (sha256(candidate) === (original?.hash ?? current.hash)) fail('candidate did not change the original resource');
    } else candidate = original.bytes;
    const candidateHash = sha256(candidate);
    await checkDirectories();
    await assertUnchanged(cachePath, current);
    await assertUnchanged(manifestPath, manifestSnapshot, 16 * 1024);
    if (original) await assertUnchanged(backupPath, original);
    if (manifest?.phase === 'prepared') {
      const oldStagePath = join(cacheParent, manifest.stagingName);
      const oldStage = await optionalSnapshot(oldStagePath);
      if (oldStage) {
        const expected = manifest.action === 'restore' ? manifest.originalHash : manifest.patchedHash;
        inspectCache(oldStage.bytes);
        if (oldStage.hash !== expected) fail('prepared staging contents changed; staging was preserved');
        await removeStage(oldStagePath, oldStage);
      }
    }
    if (!original) original = await publishOriginal(backupPath, current.bytes);
    const next = { version: 1, root, cachePath, sourceHash, originalHash: original.hash,
      // A restore can supersede an interrupted upgrade while the previous
      // installed patch is still current. Retain that exact current owner in
      // the new journal so a pre-publication restore crash remains recoverable.
      patchedHash: action === 'install' ? candidateHash : current.hash === original.hash ? manifest.patchedHash : current.hash,
      previousPatchedHash: null, phase: 'installed', action, stagingName: null };
    if (current.hash === candidateHash) {
      if (!manifest || JSON.stringify(next) !== JSON.stringify(manifest))
        await writeManifest(manifestPath, validateManifest(next, bindings), manifestSnapshot);
      return { status: action === 'restore' ? 'restored' : 'installed', changed: false, recovered: manifest?.phase === 'prepared',
        cacheHash: candidateHash, originalHash: original.hash };
    }
    next.phase = 'prepared'; next.stagingName = `.claudex-folder-${randomUUID()}.tmp`;
    if (action === 'install' && current.hash !== original.hash) next.previousPatchedHash = current.hash;
    manifestSnapshot = await writeManifest(manifestPath, validateManifest(next, bindings), manifestSnapshot);
    const candidatePath = join(cacheParent, next.stagingName);
    let staged;
    try {
      staged = await stage(candidatePath, candidate);
      await dependencies.beforeReplace?.({ action, cachePath, manifestPath });
      await checkDirectories();
      await assertUnchanged(cachePath, current);
      await assertUnchanged(manifestPath, manifestSnapshot, 16 * 1024);
      await assertUnchanged(backupPath, original);
      await assertUnchanged(candidatePath, staged);
      await rename(candidatePath, cachePath);
      await syncDirectory(cacheParent);
      const published = await snapshot(cachePath);
      inspectCache(published.bytes);
      if (published.hash !== candidateHash || !sameFile(published.info, staged.info)) fail('cache changed after publication; manifest remains prepared');
      await dependencies.afterReplace?.({ action, cachePath, manifestPath });
      await checkDirectories();
      await assertUnchanged(cachePath, published);
      next.phase = 'installed'; next.previousPatchedHash = null; next.stagingName = null;
      await writeManifest(manifestPath, validateManifest(next, bindings), manifestSnapshot);
      return { status: action === 'restore' ? 'restored' : 'installed', changed: true, recovered: manifest?.phase === 'prepared',
        cacheHash: candidateHash, originalHash: original.hash };
    } finally {
      const remaining = await optionalSnapshot(candidatePath);
      if (remaining && staged) await removeStage(candidatePath, staged);
    }
  }, { recoverDead: true });
}

/** Install/update only the version-locked static UI resource. Test dependencies
 * supply a synthetic source hash and pure builder; production uses the pinned
 * codec and checked-in projection/runtime sources. Never starts native work.
 */
export function ensureClaudeFolderCache(options, dependencies = {}) {
  return operate('install', options, dependencies);
}

/** Restore the immutable original only while the current cache is an exact
 * installer-owned generation. Foreign cache updates are never overwritten.
 */
export function restoreClaudeFolderCache(options, dependencies = {}) {
  return operate('restore', options, dependencies);
}

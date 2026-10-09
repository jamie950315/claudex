import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { inspectFolderCache, sha256 } from './claude-folder-cache.mjs';
import { snapshotClaudeCache, validateClaudeCacheManifest } from './claude-folder-install.mjs';
import { assetImports, folderAnchors, folderConsumerAnchors, commandCatalogAnchors, chatAnchors, ownerAnchors, unique, syntax } from './claude-frontend-anchors.mjs';

export const FRONTEND_ASSET_ROOT = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/';
export const claudeCacheDirectory = (home = homedir()) => join(home, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data');
const assetURL = value => typeof value === 'string' && value.startsWith(FRONTEND_ASSET_ROOT)
  && /^[A-Za-z0-9_-]+\.js$/.test(value.slice(FRONTEND_ASSET_ROOT.length));
const fileName = value => /^[a-f0-9]{16}_0$/.test(value);
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].every(k => a[k] === b[k]);
const hintIdentity = info => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].map(k => String(info[k])).join(':');
const fail = label => { throw new Error(`Claude frontend graph: ${label}`); };
async function requiredRead(read, code, label) {
  try { return await read(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw Object.assign(new Error(`Claude frontend graph: ${label}`), { code });
  }
}
// Scope missing-file classification to the actual source of the read. A lost
// Chromium resource may settle on another hint; lost recovery evidence cannot.
async function nativeCacheRead(read) {
  try { return await requiredRead(read, 'CLAUDEX_FRONTEND_CACHE_MISSING', 'native cache resource disappeared'); }
  catch (error) {
    if (!['Claude folder installation: file changed while opening',
      'Claude folder installation: file changed while reading'].includes(error.message)) throw error;
    throw Object.assign(new Error('Claude frontend graph: native cache resource changed during snapshot'),
      { code: 'CLAUDEX_FRONTEND_CACHE_CHANGED' });
  }
}
const evidenceRead = read => requiredRead(read, 'CLAUDEX_FRONTEND_EVIDENCE_MISSING', 'required resource recovery evidence disappeared');
export function captureClaudeFrontendHints(graph) {
  return new Map([...graph.modules.values()].map(m => [m.name, hintIdentity(m.identity)]));
}
/** Hints only suppress unchanged assets and unrelated cache keys. They never
 * authorize installation, skip graph proofs or read a transcript/HTTP payload.
 */
export async function changedClaudeFrontendHint({ home = homedir(), filename, observations }) {
  if (!fileName(filename)) return false;
  const directory = claudeCacheDirectory(home); await cacheDirectory(directory);
  const path = join(directory, filename); let info;
  try { info = await lstat(path, { bigint: true }); }
  catch (e) { if (e.code === 'ENOENT') return observations.has(filename); throw e; }
  if (observations.get(filename) === hintIdentity(info)) return false;
  return Boolean(await keyURL(path)) || observations.has(filename);
}
export async function verifyClaudeFrontendGraph(graph) {
  for (const module of graph.modules.values()) {
    if (!same(module.identity, await nativeCacheRead(() => lstat(module.path, { bigint: true })))) fail('graph changed before publication');
  }
}
async function cacheDirectory(path) {
  return nativeCacheRead(async () => {
    const s = await lstat(path, { bigint: true });
    if (resolve(path) !== path || await realpath(path) !== path || !s.isDirectory() || s.isSymbolicLink()
      || s.uid !== BigInt(process.getuid()) || (s.mode & 0o7777n) !== 0o700n) fail('cache directory must be canonical, private and owned');
    return s;
  });
}
async function keyURL(path) {
  return nativeCacheRead(async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await file.stat({ bigint: true });
      if (!s.isFile() || s.uid !== BigInt(process.getuid()) || s.nlink !== 1n || (s.mode & 0o7777n) !== 0o600n)
        fail('cache inventory file must be private, owned, regular and single-linked');
      const header = Buffer.alloc(24); if ((await file.read(header, 0, 24, 0)).bytesRead !== 24) return null;
      if (header.readBigUInt64LE(0) !== 0xfcfb6d1ba7725c30n || header.readUInt32LE(8) !== 5) return null;
      const length = header.readUInt32LE(12); if (length < 1 || length > 4096) return null;
      const key = Buffer.alloc(length); if ((await file.read(key, 0, length, 24)).bytesRead !== length) fail('cache key truncated');
      if (!same(s, await file.stat({ bigint: true })) || !same(s, await lstat(path, { bigint: true }))) fail('cache inventory changed while reading');
      const value = key.toString('utf8'); return value.startsWith('1/0/') && assetURL(value.slice(4)) ? value.slice(4) : null;
    } finally { await file.close(); }
  });
}
function responseTime(metadata) {
  // Observed Chromium HttpResponseInfo pickle: payload length, flags, optional
  // flags word, then request/response/original-response base::Time microseconds.
  // Never use mtime: installing our patch changes mtime, not fetch recency.
  if (metadata.length < 40 || metadata.readUInt32LE(0) !== metadata.length - 4 || (metadata.readUInt32LE(4) & 255) !== 3 || metadata.readUInt32LE(8) !== 6)
    fail('unsupported HTTP response time encoding');
  const request = metadata.readBigInt64LE(12), response = metadata.readBigInt64LE(20), original = metadata.readBigInt64LE(28);
  const epoch = 11644473600000000n;
  if (request < epoch || response < request || original > response || original < epoch
    || response > epoch + BigInt(Date.now() + 86400_000) * 1000n) fail('invalid HTTP response times');
  return response;
}
async function originalEntry(root, name, current, targetURL) {
  // Re-discovery resolves imports and anchors against immutable vendor bytes,
  // including interrupted prepared installs. A missing/foreign journal is never
  // permission to strip an injected patch or adopt another original.
  for (const adapter of ['ui-folders', 'ui-chat-wake', 'ui-owner-wake', 'ui-commands']) {
    const state = join(root, adapter, name, 'ui-folder-compat');
    const manifestPath = join(state, 'manifest.json');
    // An installation need not exist. Once its receipt is observed, however,
    // disappearance during the stable read is missing evidence, not absence.
    try { await lstat(manifestPath, { bigint: true }); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const receipt = await evidenceRead(() => snapshotClaudeCache(manifestPath, 16 * 1024));
    const m = JSON.parse(receipt.bytes.toString());
    validateClaudeCacheManifest(m, { root: join(root, adapter, name), cachePath: current.path, sourceHash: m.sourceHash });
    if (m.version !== 1 || m.root !== join(root, adapter, name) || m.cachePath !== current.path
      || !['prepared', 'installed'].includes(m.phase) || !['install', 'restore'].includes(m.action)
      || ![m.originalHash, m.patchedHash, ...(m.phase === 'prepared' ? [m.previousPatchedHash] : [])].includes(current.hash))
      fail('resource journal or cache ownership changed');
    const original = await evidenceRead(() => snapshotClaudeCache(join(state, 'original.cache')));
    const entry = inspectFolderCache(original.bytes, { targetURL });
    if (sha256(original.bytes) !== m.originalHash || entry.sourceHash !== m.sourceHash) fail('resource original changed');
    const latest = await evidenceRead(() => snapshotClaudeCache(manifestPath, 16 * 1024));
    if (latest.hash !== receipt.hash || !same(latest.info, receipt.info)) fail('resource journal changed during discovery');
    return { ...entry, originalBytes: original.bytes };
  }
  const entry = inspectFolderCache(current.bytes, { targetURL });
  if (entry.source.includes('[Claudex ') || entry.source.includes('__cldx')) fail('unowned patched resource');
  return { ...entry, originalBytes: current.bytes };
}

/** Read-only graph discovery. Cache recency identifies the latest fetched entry,
 * not proof of the graph a live renderer has already evaluated. Missing lazy
 * chunks remain explicit; adapters require their own complete reachable proof.
 */
export async function discoverClaudeFrontend({ root, home = homedir() }) {
  const directory = claudeCacheDirectory(home), before = await cacheDirectory(directory);
  const names = await nativeCacheRead(() => readdir(directory)); if (names.length > 32768) fail('cache inventory exceeds its bound');
  const inventory = new Map();
  for (const name of names.filter(fileName)) {
    const path = join(directory, name);
    // A cache writer can remove an entry while publishing the next graph.
    // Do not choose an older graph after a changed read; retry on a later hint.
    const url = await keyURL(path);
    if (url) { if (inventory.has(url)) fail('duplicate resource URLs'); inventory.set(url, { name, path, url }); }
  }
  const entries = [];
  for (const resource of inventory.values()) if (/^index-[A-Za-z0-9_-]+\.js$/.test(basename(resource.url))) {
    const snapshot = await nativeCacheRead(() => snapshotClaudeCache(resource.path)), entry = inspectFolderCache(snapshot.bytes, { targetURL: resource.url });
    if (!entry.source.includes('document.getElementById("root")')) fail('entry bootstrap anchor changed');
    entries.push({ ...resource, ...entry, snapshot, response: responseTime(entry.metadata) });
  }
  if (!entries.length) fail('entry is not cached');
  const newest = entries.reduce((max, e) => e.response > max ? e.response : max, 0n);
  const entry = unique(entries.filter(e => e.response === newest), 'latest fetched entry');
  const modules = new Map(), missing = new Set(), pending = [entry.url]; let bytes = 0;
  while (pending.length) {
    const url = pending.pop(); if (modules.has(url) || missing.has(url)) continue;
    const resource = inventory.get(url); if (!resource) { missing.add(url); continue; }
    // Observed September entry graphs retain both compiler branches and reach
    // 1,171 cached modules. Keep a finite bound covering those real builds.
    if (modules.size >= 2048 || missing.size > 2048) fail('import graph exceeds its bound');
    const snapshot = await nativeCacheRead(() => snapshotClaudeCache(resource.path));
    bytes += snapshot.bytes.length; if (bytes > 256 * 1024 * 1024) fail('graph bytes exceed their bound');
    const original = await originalEntry(root, resource.name, { ...snapshot, path: resource.path }, url);
    const module = { ...resource, ...original, currentHash: snapshot.hash, identity: snapshot.info };
    modules.set(url, module);
    for (const spec of assetImports(original.source, module)) {
      const target = new URL(spec, url).href;
      if (assetURL(target)) pending.push(target);
    }
  }
  const after = await cacheDirectory(directory);
  // Directory mtime can change while HTTP writes arrive; every participating
  // resource must still be exactly the snapshot that supplied its proof.
  if (before.dev !== after.dev || before.ino !== after.ino) fail('cache directory identity changed');
  for (const module of modules.values()) if (!same(module.identity, await nativeCacheRead(() => lstat(module.path, { bigint: true })))) fail('graph changed during discovery');
  if (!same(entry.snapshot.info, await nativeCacheRead(() => lstat(entry.path, { bigint: true })))) fail('entry changed during discovery');
  const adapters = {};
  for (const [adapter, probe, plausible, byProof] of [
    ['folders', folderAnchors, s => s.includes('disambiguationText') && s.includes('hasActiveSessions') && s.includes('repoInfo') && s.includes('environmentId')],
    ['chatWake', chatAnchors, s => s.includes('forkSession') && s.includes('amber_tributary_lantern_overview_toggle') && s.includes('reopenClosed'),
      // The 2026-10-08 build moved the shortcut and reopen handlers out of the
      // session-action module. When no module carries all three markers, its
      // identity is the structural proof alone: exactly one reachable module
      // may pass it. Builds that still carry the markers keep that selection,
      // because several of their modules pass the proof.
      s => s.includes('forkSession')],
    ['ownerWake', ownerAnchors, s => s.includes('submitMessage') && s.includes('getComposerSnapshot') && s.includes('initialSessionId')],
    ['commands', commandCatalogAnchors, s => s.includes('empty slash-command list (cold CLI bridge)') && s.includes('trustedSelectedFolder') && s.includes('getSupportedCommands')],
  ]) {
    try {
      const imports = module => ({ get: path => modules.get(new URL(path, module.url).href) });
      const proven = module => { try { probe(module.source, imports(module)); return true; } catch { return false; } };
      const marked = [...modules.values()].filter(m => plausible(m.source));
      // Markers shortlist modules. Competing folders and owner components
      // require their complete grouping/key or identity/send/client proof.
      const selected = ['ownerWake', 'folders'].includes(adapter) && marked.length > 1 ? marked.filter(proven) : marked;
      let candidates = marked.length || !byProof ? selected
        : [...modules.values()].filter(m => byProof(m.source) && proven(m));
      if (adapter === 'chatWake' && !marked.length && candidates.length > 1)
        candidates = candidates.filter(m => probe(m.source, imports(m)).forkAction);
      const target = unique(candidates, `${adapter} target module`);
      const graph = imports(target);
      const bindings = probe(target.source, graph);
      if (adapter === 'ownerWake') bindings.search.moduleCandidates = marked.length;
      let consumer;
      if (adapter === 'folders' && bindings.pure) {
        const consumers = [];
        for (const module of modules.values()) {
          if (!module.source.includes(basename(target.url))) continue;
          for (const imp of syntax(module.source).body.filter(n => n.type === 'ImportDeclaration'
            && new URL(n.source.value, module.url).href === target.url
            && n.specifiers.some(s => s.imported?.name === bindings.groupingExport))) {
            consumers.push({ target: module, bindings: folderConsumerAnchors(module.source,
              { get: path => modules.get(new URL(path, module.url).href) }, bindings, imp.source.value) });
          }
        }
        consumer = unique(consumers, 'folder grouping consumer module');
      }
      adapters[adapter] = { status: 'matched', target, bindings, ...(consumer ? { consumer } : {}) };
    } catch (error) { adapters[adapter] = { status: 'skipped', reason: String(error.message).slice(0, 240) }; }
  }
  return { entry: { asset: basename(entry.url), cacheFilename: entry.name, fetchedAt: new Date(Number((newest - 11644473600000000n) / 1000n)).toISOString() },
    modules, missing: missing.size, adapters };
}

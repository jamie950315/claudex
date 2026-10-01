import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { privateDirectory } from './storage.mjs';
import { inspectFolderCache, replaceFolderCacheSource } from './claude-folder-cache.mjs';
import { buildClaudeFolderCandidate, ensureClaudeFolderCache, restoreClaudeFolderCache, snapshotClaudeCache } from './claude-folder-install.mjs';
import { buildClaudeChatWakeSource } from './claude-chat-wake-cache.mjs';
import { buildClaudeOwnerWakeSource } from './claude-owner-wake-cache.mjs';
import { claudeCacheDirectory, discoverClaudeFrontend, verifyClaudeFrontendGraph, captureClaudeFrontendHints } from './claude-frontend-graph.mjs';

const directories = { folders: 'ui-folders', chatWake: 'ui-chat-wake', ownerWake: 'ui-owner-wake' };
const runtime = name => readFile(new URL(`./${name}.mjs`, import.meta.url), 'utf8');
export async function buildClaudeRendererCandidate({ root, home = homedir(), adapter, matched, original,
  registryRoot = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions') }) {
  if (matched?.status !== 'matched') throw new Error(matched?.reason ?? 'Claude renderer adapter has no validated anchors');
  const { target, bindings } = matched, assetName = basename(target.url), options = { targetURL: target.url };
  const entry = inspectFolderCache(original, options);
  if (entry.sourceHash !== target.sourceHash) throw new Error('Claude renderer original changed after graph validation');
  const common = { root, bindings, assetName };
  if (adapter === 'folders') return buildClaudeFolderCandidate({ ...common, original, registryRoot, targetURL: target.url,
    // Chat wake is independent and starts at module load. Folders retain only
    // folder/handoff subscriptions; two consumers must not compete for claims.
    wakeSource: '' });
  const source = adapter === 'chatWake' ? buildClaudeChatWakeSource(entry.source, { ...common, registryRoot,
    wakeSource: await runtime('claude-chat-wake-runtime') }) : buildClaudeOwnerWakeSource(entry.source, { ...common,
    runtimeSource: await runtime('claude-owner-wake-runtime') });
  return replaceFolderCacheSource(original, source, options);
}
export async function ensureClaudeRendererAdapter({ root, home = homedir(), adapter, cachePath, graph, registryRoot }, dependencies = {}) {
  if (!directories[adapter]) throw new Error('Unknown Claude renderer adapter');
  if (![root, home].every(p => typeof p === 'string' && isAbsolute(p) && resolve(p) === p && !/[\x00-\x1f\x7f]/.test(p)))
    throw new Error('Claude renderer paths must be canonical absolute paths');
  if (cachePath !== undefined && (dirname(cachePath) !== claudeCacheDirectory(home) || !/^[a-f0-9]{16}_0$/.test(basename(cachePath))))
    throw new Error('Claude renderer cache path does not match its native resource directory');
  graph ??= await discoverClaudeFrontend({ root, home });
  const matched = graph.adapters[adapter];
  if (matched?.status !== 'matched') return { status: 'skipped', reason: matched?.reason ?? 'Target is unavailable', entry: graph.entry };
  const { target } = matched, stateRoot = join(root, directories[adapter], target.name);
  // Refuse a graph race BEFORE making even a private directory or original.
  const current = await snapshotClaudeCache(target.path);
  if (current.hash !== target.currentHash) throw new Error('Claude renderer cache changed after graph validation');
  await privateDirectory(stateRoot);
  const result = await ensureClaudeFolderCache({ root: stateRoot, cachePath: target.path }, {
    ...dependencies, sourceHash: target.sourceHash, targetURL: target.url,
    beforePublish: async input => { await verifyClaudeFrontendGraph(graph); await dependencies.beforePublish?.(input); },
    buildCandidate: async ({ original }) => {
      const candidate = await buildClaudeRendererCandidate({ root, home, adapter, matched, original, registryRoot });
      await verifyClaudeFrontendGraph(graph); return candidate;
    },
  });
  const installed = await snapshotClaudeCache(target.path);
  if (installed.hash !== result.cacheHash) throw new Error('Claude renderer cache changed after publication');
  target.currentHash = installed.hash; target.identity = installed.info;
  return { ...result, cachePath: target.path, asset: basename(target.url), entry: graph.entry,
    activation: result.changed ? 'restart-required' : 'load-not-verified' };
}
export async function ensureClaudeRendererAdapters({ root, home = homedir(), folders = true, graph }, dependencies = {}) {
  graph ??= await discoverClaudeFrontend({ root, home });
  const adapters = {};
  // Independent transactions are serialized. A refused adapter never partly
  // installs; another fully proved adapter can still install its own journal.
  for (const adapter of Object.keys(directories)) {
    if (adapter === 'folders' && !folders) { adapters[adapter] = { status: 'disabled' }; continue; }
    try { adapters[adapter] = await ensureClaudeRendererAdapter({ root, home, adapter, graph }, dependencies); }
    catch { adapters[adapter] = { status: 'skipped', reason: 'Cache publication or recovery refused; original and journal preserved' }; }
  }
  return { entry: graph.entry, missingChunks: graph.missing, adapters, observations: captureClaudeFrontendHints(graph) };
}
export async function restoreClaudeRendererAdapter({ root, cachePath, adapter }) {
  if (!directories[adapter] || !/^[a-f0-9]{16}_0$/.test(basename(cachePath))) throw new Error('Invalid renderer restore target');
  const stateRoot = join(root, directories[adapter], basename(cachePath)), journal = join(stateRoot, 'ui-folder-compat');
  const original = await snapshotClaudeCache(join(journal, 'original.cache'));
  const keyLength = original.bytes.readUInt32LE(12);
  const targetURL = original.bytes.subarray(24, 24 + keyLength).toString().slice(4);
  const entry = inspectFolderCache(original.bytes, { targetURL });
  return restoreClaudeFolderCache({ root: stateRoot, cachePath }, { targetURL, sourceHash: entry.sourceHash });
}
export async function restoreClaudeFolderGenerations({ root, cachePath }) {
  const resources = await readdir(join(root, directories.folders)).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  if (resources.length > 32768) throw new Error('Claude folder restore inventory exceeds its bound');
  const results = [];
  for (const name of resources.filter(name => /^[a-f0-9]{16}_0$/.test(name))) {
    const path = join(dirname(cachePath), name);
    try { results.push(await restoreClaudeRendererAdapter({ root, cachePath: path, adapter: 'folders' })); }
    catch (e) { if (e.code !== 'ENOENT') throw e; } // Browser eviction retains our recovery evidence.
  }
  return { status: 'restored', changed: results.some(r => r.changed), generations: results.length };
}

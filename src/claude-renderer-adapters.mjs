import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { privateDirectory } from './storage.mjs';
import { inspectFolderCache, replaceFolderCacheSource } from './claude-folder-cache.mjs';
import { buildClaudeFolderCandidate, ensureClaudeFolderCache, restoreClaudeFolderCache, snapshotClaudeCache } from './claude-folder-install.mjs';
import { buildClaudeChatWakeSource } from './claude-chat-wake-cache.mjs';
import { buildClaudeOwnerWakeSource } from './claude-owner-wake-cache.mjs';
import { claudeCacheDirectory, discoverClaudeFrontend, verifyClaudeFrontendGraph, captureClaudeFrontendHints } from './claude-frontend-graph.mjs';
import { transformFolderConsumer, transformCommandCatalog, syntax } from './claude-frontend-anchors.mjs';

const directories = { folders: 'ui-folders', chatWake: 'ui-chat-wake', ownerWake: 'ui-owner-wake', commands: 'ui-commands' };
const runtime = name => readFile(new URL(`./${name}.mjs`, import.meta.url), 'utf8');
function publicationFailure(error, cachePath) {
  if (error?.code === 'CLAUDEX_FRONTEND_CACHE_MISSING') return 'cache-entry-missing';
  if (error?.code === 'CLAUDEX_FRONTEND_CACHE_CHANGED') return 'cache-changed';
  if (error?.code === 'CLAUDEX_FRONTEND_EVIDENCE_MISSING') return 'recovery-evidence-missing';
  // snapshotClaudeCache is shared with private recovery storage. Only the
  // exact validated native target (or its directory) identifies cache eviction.
  if (error?.code === 'ENOENT') return typeof cachePath === 'string'
    && [cachePath, dirname(cachePath)].includes(error.path) ? 'cache-entry-missing' : 'required-file-missing';
  if (['Claude renderer cache changed after graph validation', 'Claude renderer cache changed after publication',
    'Claude frontend graph: graph changed before publication'].includes(error?.message)) return 'cache-changed';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'access-denied';
  return 'validation-refused';
}
export async function buildClaudeRendererCandidate({ root, home = homedir(), adapter, matched, original,
  sharedChatWake,
  registryRoot = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions') }) {
  if (matched?.status !== 'matched') throw new Error(matched?.reason ?? 'Claude renderer adapter has no validated anchors');
  const { target, bindings } = matched, assetName = basename(target.url), options = { targetURL: target.url };
  const entry = inspectFolderCache(original, options);
  if (entry.sourceHash !== target.sourceHash) throw new Error('Claude renderer original changed after graph validation');
  const common = { root, bindings, assetName };
  if (adapter === 'commands') return replaceFolderCacheSource(original, transformCommandCatalog(entry.source, bindings), options);
  if (adapter === 'folders') {
    const candidate = await buildClaudeFolderCandidate({ ...common, original, registryRoot, targetURL: target.url,
    // Chat wake is independent and starts at module load. Folders retain only
    // folder/handoff subscriptions; two consumers must not compete for claims.
      wakeSource: '' });
    if (!sharedChatWake) return candidate;
    if (sharedChatWake.status !== 'matched' || sharedChatWake.target.url !== target.url
      || sharedChatWake.target.sourceHash !== target.sourceHash) throw new Error('Shared renderer resource bindings changed');
    return replaceFolderCacheSource(original, buildClaudeChatWakeSource(inspectFolderCache(candidate, options).source,
      { root, bindings: sharedChatWake.bindings, assetName, registryRoot, wakeSource: await runtime('claude-chat-wake-runtime') }), options);
  }
  const source = adapter === 'chatWake' ? buildClaudeChatWakeSource(entry.source, { ...common, registryRoot,
    wakeSource: await runtime('claude-chat-wake-runtime') }) : buildClaudeOwnerWakeSource(entry.source, { ...common,
    runtimeSource: await runtime('claude-owner-wake-runtime') });
  return replaceFolderCacheSource(original, source, options);
}
export async function ensureClaudeRendererAdapter({ root, home = homedir(), adapter, cachePath, graph, registryRoot, sharedResourceMode }, dependencies = {}) {
  if (!directories[adapter]) throw new Error('Unknown Claude renderer adapter');
  if (![root, home].every(p => typeof p === 'string' && isAbsolute(p) && resolve(p) === p && !/[\x00-\x1f\x7f]/.test(p)))
    throw new Error('Claude renderer paths must be canonical absolute paths');
  if (cachePath !== undefined && (dirname(cachePath) !== claudeCacheDirectory(home) || !/^[a-f0-9]{16}_0$/.test(basename(cachePath))))
    throw new Error('Claude renderer cache path does not match its native resource directory');
  graph ??= await discoverClaudeFrontend({ root, home });
  const matched = graph.adapters[adapter];
  if (matched?.status !== 'matched') return { status: 'skipped', reason: matched?.reason ?? 'Target is unavailable', entry: graph.entry };
  const { target } = matched;
  // Prove/build both resources before publishing either. The helper is safe
  // without a subscriber; publish it first, then the consumer that imports its
  // store. Each keeps an independent recoverable original/journal. Never mark
  // the folder adapter installed until both exact resources have committed.
  let consumerCandidate;
  if (adapter === 'folders' && matched.consumer) {
    await buildClaudeRendererCandidate({ root, home, adapter, matched, original: target.originalBytes, registryRoot });
    const c = matched.consumer;
    consumerCandidate = replaceFolderCacheSource(c.target.originalBytes,
      transformFolderConsumer(c.target.source, c.bindings), { targetURL: c.target.url });
    await verifyClaudeFrontendGraph(graph);
  }
  const shared = ['folders', 'chatWake'].includes(adapter) && graph.adapters.folders?.status === 'matched'
    && graph.adapters.chatWake?.status === 'matched' && graph.adapters.folders.target.url === graph.adapters.chatWake.target.url;
  if (shared && !['combined', 'chat-only'].includes(sharedResourceMode))
    return { status: 'skipped', reason: 'Folders and chat wake share this resource; use the all-adapter installation entry point', entry: graph.entry };
  // Older graphs share a physical resource. One transaction owns both complete
  // transforms and one immutable original/receipt, under the folder resource
  // journal even when the folder choice is disabled. Never layer independent
  // writers or take an injected resource as another adapter's vendor original.
  const stateRoot = join(root, directories[shared ? 'folders' : adapter], target.name);
  // Refuse a graph race BEFORE making even a private directory or original.
  const current = await snapshotClaudeCache(target.path);
  if (current.hash !== target.currentHash) throw new Error('Claude renderer cache changed after graph validation');
  await privateDirectory(stateRoot);
  const result = await ensureClaudeFolderCache({ root: stateRoot, cachePath: target.path }, {
    ...dependencies, sourceHash: target.sourceHash, targetURL: target.url,
    beforePublish: async input => { await verifyClaudeFrontendGraph(graph); await dependencies.beforePublish?.(input); },
    buildCandidate: async ({ original }) => {
      const candidate = await buildClaudeRendererCandidate({ root, home, adapter, matched, original, registryRoot,
        sharedChatWake: shared && sharedResourceMode === 'combined' ? graph.adapters.chatWake : undefined });
      await verifyClaudeFrontendGraph(graph); return candidate;
    },
  });
  const installed = await snapshotClaudeCache(target.path);
  if (installed.hash !== result.cacheHash) throw new Error('Claude renderer cache changed after publication');
  target.currentHash = installed.hash; target.identity = installed.info;
  let consumerResult;
  if (consumerCandidate) {
    const c = matched.consumer.target, consumerRoot = join(root, directories.folders, c.name);
    await verifyClaudeFrontendGraph(graph);
    await privateDirectory(consumerRoot);
    consumerResult = await ensureClaudeFolderCache({ root: consumerRoot, cachePath: c.path }, {
      ...dependencies, sourceHash: c.sourceHash, targetURL: c.url,
      beforePublish: async input => { await verifyClaudeFrontendGraph(graph); await dependencies.beforePublish?.(input); },
      buildCandidate: async ({ original }) => {
        if (inspectFolderCache(original, { targetURL: c.url }).sourceHash !== c.sourceHash)
          throw new Error('Folder consumer original changed after graph validation');
        return consumerCandidate;
      },
    });
    const installedConsumer = await snapshotClaudeCache(c.path);
    if (installedConsumer.hash !== consumerResult.cacheHash) throw new Error('Claude renderer cache changed after publication');
    c.currentHash = installedConsumer.hash; c.identity = installedConsumer.info;
  }
  const changed = result.changed || consumerResult?.changed === true;
  return { ...result, cachePath: target.path, asset: basename(target.url), entry: graph.entry,
    changed, ...(consumerResult ? { consumer: { asset: basename(matched.consumer.target.url), changed: consumerResult.changed } } : {}),
    ...(shared ? { sharedResource: true, journalAdapter: 'folders' } : {}),
    activation: changed ? 'restart-required' : 'load-not-verified' };
}
export async function ensureClaudeRendererAdapters({ root, home = homedir(), folders = true, graph }, dependencies = {}) {
  graph ??= await discoverClaudeFrontend({ root, home });
  const adapters = {};
  const shared = graph.adapters.folders?.status === 'matched' && graph.adapters.chatWake?.status === 'matched'
    && graph.adapters.folders.target.url === graph.adapters.chatWake.target.url;
  // Independent transactions are serialized. A refused adapter never partly
  // installs; another fully proved adapter can still install its own journal.
  for (const adapter of Object.keys(directories)) {
    if (adapter === 'folders' && !folders) { adapters[adapter] = { status: 'disabled' }; continue; }
    if (shared && folders && adapter === 'chatWake') { adapters[adapter] = { ...adapters.folders }; continue; }
    try { adapters[adapter] = await ensureClaudeRendererAdapter({ root, home, adapter, graph,
      ...(shared && ['folders', 'chatWake'].includes(adapter) ? { sharedResourceMode: folders ? 'combined' : 'chat-only' } : {}) }, dependencies); }
    catch (error) { adapters[adapter] = { status: 'skipped', reason: 'Cache publication or recovery refused; original and journal preserved',
      failure: { code: publicationFailure(error, graph.adapters[adapter]?.target?.path) } }; }
  }
  return { entry: graph.entry, missingChunks: graph.missing, adapters, observations: captureClaudeFrontendHints(graph) };
}
export async function restoreClaudeRendererAdapter({ root, cachePath, adapter }) {
  if (!directories[adapter] || !/^[a-f0-9]{16}_0$/.test(basename(cachePath))) throw new Error('Invalid renderer restore target');
  let stateRoot = join(root, directories[adapter], basename(cachePath));
  if (adapter === 'chatWake') {
    try { await snapshotClaudeCache(join(stateRoot, 'ui-folder-compat', 'manifest.json'), 16 * 1024); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const sharedRoot = join(root, directories.folders, basename(cachePath));
      const original = await snapshotClaudeCache(join(sharedRoot, 'ui-folder-compat', 'original.cache'));
      const url = original.bytes.subarray(24, 24 + original.bytes.readUInt32LE(12)).toString().slice(4);
      const { source } = inspectFolderCache(original.bytes, { targetURL: url });
      if (!source.includes('forkSession') || !source.includes('reopenClosed') || !source.includes('amber_tributary_lantern_overview_toggle'))
        throw new Error('Resource is not a shared chat-wake installation');
      stateRoot = sharedRoot;
    }
  }
  const journal = join(stateRoot, 'ui-folder-compat');
  const original = await snapshotClaudeCache(join(journal, 'original.cache'));
  const keyLength = original.bytes.readUInt32LE(12);
  const targetURL = original.bytes.subarray(24, 24 + keyLength).toString().slice(4);
  const entry = inspectFolderCache(original.bytes, { targetURL });
  if (adapter === 'folders') {
    const current = inspectFolderCache((await snapshotClaudeCache(cachePath)).bytes, { targetURL });
    if (current.source.includes('export{__cldx as __cldxFolderStore')) {
      const names = await readdir(join(root, directories.folders));
      if (names.length > 32768) throw new Error('Claude folder restore inventory exceeds its bound');
      for (const name of names.filter(n => /^[a-f0-9]{16}_0$/.test(n) && n !== basename(cachePath))) {
        const path = join(dirname(cachePath), name);
        let bytes;
        try { bytes = (await snapshotClaudeCache(path)).bytes; }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const url = bytes.subarray(24, 24 + bytes.readUInt32LE(12)).toString().slice(4);
        const source = inspectFolderCache(bytes, { targetURL: url }).source;
        if (!source.includes('__cldxFolderStore')) continue;
        if (syntax(source).body.some(n => n.type === 'ImportDeclaration'
          && n.specifiers.some(s => s.imported?.name === '__cldxFolderStore')
          && new URL(n.source.value, url).href === targetURL))
          await restoreClaudeRendererAdapter({ root, cachePath: path, adapter: 'folders' });
      }
    }
  }
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

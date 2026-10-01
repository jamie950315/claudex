import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { FOLDER_CACHE_FILENAME } from './claude-folder-cache.mjs';
import { restoreClaudeFolderCache, snapshotClaudeCache } from './claude-folder-install.mjs';
import { ensureClaudeRendererAdapter, restoreClaudeFolderGenerations } from './claude-renderer-adapters.mjs';

const LEGACY_FILENAME = '15bc54146dcdb4ce_0';
const cacheDirectory = home => join(home, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data');

/** Migrate only the exact previously supported resource path. Unknown custom
 * paths remain explicit errors; earlier originals and journals are untouched.
 */
export function claudeFolderPresentationCachePath(home = homedir(), savedPath) {
  const current = join(cacheDirectory(home), FOLDER_CACHE_FILENAME);
  return savedPath === undefined || savedPath === join(cacheDirectory(home), LEGACY_FILENAME) ? current : savedPath;
}

export function claudeFolderPresentationManifestPath(root, cachePath) {
  const name = basename(cachePath);
  if (name === LEGACY_FILENAME) return join(root, 'ui-folder-compat', 'manifest.json');
  if (!/^[a-f0-9]{16}_0$/.test(name)) throw new Error('Claude folder presentation cache path does not match its native resource');
  return join(root, 'ui-folders', name, 'ui-folder-compat', 'manifest.json');
}

export async function ensureClaudeFolderPresentationCache(options) {
  return ensureClaudeRendererAdapter({ ...options, adapter: 'folders' });
}

export async function restoreClaudeFolderPresentationCache(options) {
  // Restoring a still-configured legacy installation uses its original bindings.
  // Restore all later owned generations even while a legacy hint is configured.
  let legacy;
  if (basename(options.cachePath) === LEGACY_FILENAME) {
    try {
      await snapshotClaudeCache(join(options.root, 'ui-folder-compat', 'manifest.json'), 16 * 1024);
      legacy = await restoreClaudeFolderCache(options, {
        sourceHash: '01bc6cf8d85b25edda8a396f00e664872a03288f6c06aff03d1aa0f2fa466ebf',
        targetURL: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-23-Db0dcGkF.js',
      });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const current = await restoreClaudeFolderGenerations(options);
  return { ...current, changed: current.changed || legacy?.changed === true, ...(legacy ? { legacy } : {}) };
}

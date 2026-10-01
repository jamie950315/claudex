import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { privateDirectory } from './storage.mjs';
import { FOLDER_CACHE_FILENAME, FOLDER_SOURCE_SHA256, FOLDER_TARGET_URL } from './claude-folder-cache.mjs';
import { buildClaudeFolderCandidate, ensureClaudeFolderCache, restoreClaudeFolderCache } from './claude-folder-install.mjs';

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
  if (name !== FOLDER_CACHE_FILENAME) throw new Error('Claude folder presentation cache path does not match its pinned resource');
  return join(root, 'ui-folders', FOLDER_CACHE_FILENAME, 'ui-folder-compat', 'manifest.json');
}

async function resourceOptions(options) {
  const { root, cachePath } = options;
  if (basename(cachePath) !== FOLDER_CACHE_FILENAME) throw new Error('Claude folder presentation cache path does not match its pinned resource');
  const stateRoot = join(root, 'ui-folders', FOLDER_CACHE_FILENAME);
  await privateDirectory(stateRoot);
  return { options: { ...options, root: stateRoot }, dependencies: {
    sourceHash: FOLDER_SOURCE_SHA256, targetURL: FOLDER_TARGET_URL,
    buildCandidate: ({ original }) => buildClaudeFolderCandidate({ ...options, original }),
  } };
}

export async function ensureClaudeFolderPresentationCache(options) {
  const resource = await resourceOptions(options);
  return ensureClaudeFolderCache(resource.options, resource.dependencies);
}

export async function restoreClaudeFolderPresentationCache(options) {
  // Restoring a still-configured legacy installation uses its original bindings.
  // New installs never upgrade or restore that earlier journal.
  if (basename(options.cachePath) === LEGACY_FILENAME) return restoreClaudeFolderCache(options, {
    sourceHash: '01bc6cf8d85b25edda8a396f00e664872a03288f6c06aff03d1aa0f2fa466ebf',
    targetURL: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-23-Db0dcGkF.js',
  });
  const resource = await resourceOptions(options);
  return restoreClaudeFolderCache(resource.options, resource.dependencies);
}

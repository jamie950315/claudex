import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { privateDirectory } from './storage.mjs';
import { inspectFolderCache, replaceFolderCacheSource, sha256 } from './claude-folder-cache.mjs';
import { ensureClaudeFolderCache } from './claude-folder-install.mjs';

export const CHAT_WAKE_TARGET_URL = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-18-BYDVwU8Z.js';
export const CHAT_WAKE_SOURCE_SHA256 = '77c061c3af1c15039fb15f7de316aae4170f7bb17be9827c40a7f8774f2c0091';
export const CHAT_WAKE_CACHE_FILENAME = '3db07192919e9133_0';

function canonical(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value))
    throw new Error('Claude chat wake requires canonical absolute paths');
}

/** The only native object referenced is the observed LocalSessions import Ve.
 * No draft content, message text or credentials are written to console output.
 */
export function buildClaudeChatWakeBootstrap({ root, registryRoot, wakeSource }) {
  canonical(root); canonical(registryRoot);
  if (typeof wakeSource !== 'string' || !wakeSource.includes('export function createClaudeChatWakeRuntime('))
    throw new Error('Claude chat wake runtime source is unavailable');
  const runtime = wakeSource.replace(/^export /gm, '');
  return `\n;(()=>{${runtime}\nconst wake=createClaudeChatWakeRuntime({native:Ve,registryRoot:${JSON.stringify(registryRoot)},readManifest:()=>Ve.readFileAtCwd(${JSON.stringify(root)},"collaboration/chat-mailbox/wake-manifest.json"),hasDraft:()=>Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).some(e=>String(e.value??e.textContent??"").trim()),onError:e=>console.warn("[Claudex chat wake] "+e),onStatus:e=>console.warn("[Claudex chat wake] "+e)});console.warn("[Claudex chat wake] loaded");wake.start();window.addEventListener("beforeunload",()=>wake.stop(),{once:true});})();\n`;
}

/** Strict source pin: a renamed or changed native asset is never guessed. */
export function buildClaudeChatWakeSource(source, options) {
  if (typeof source !== 'string' || sha256(Buffer.from(source)) !== CHAT_WAKE_SOURCE_SHA256)
    throw new Error('Claude chat wake frontend source is unvalidated');
  if (!source.includes('af as Ve') || !source.includes('from"./shared-common-mcp-msg-0-CCfkjLX_.js"')
    || !source.includes('Ve?.forkSession') || !source.includes('Ve?.shareSession'))
    throw new Error('Claude chat wake native binding changed');
  return source + buildClaudeChatWakeBootstrap(options);
}

/** Independent journal and immutable original; does not replace folder-map
 * presentation or depend on a particular sidebar grouping being mounted.
 */
export async function ensureClaudeChatWakeCache({ root, home = homedir(), cachePath,
  registryRoot = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions') }) {
  canonical(root); canonical(home); canonical(registryRoot);
  const expected = join(home, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data', CHAT_WAKE_CACHE_FILENAME);
  const target = cachePath ?? expected;
  if (target !== expected) throw new Error('Claude chat wake cache path does not match the pinned native resource');
  // Resource-specific journals retain prior frontend originals and receipts.
  const stateRoot = join(root, 'ui-chat-wake', CHAT_WAKE_CACHE_FILENAME);
  await privateDirectory(stateRoot);
  const wakeSource = await readFile(new URL('./claude-chat-wake-runtime.mjs', import.meta.url), 'utf8');
  return ensureClaudeFolderCache({ root: stateRoot, cachePath: target }, {
    sourceHash: CHAT_WAKE_SOURCE_SHA256, targetURL: CHAT_WAKE_TARGET_URL,
    buildCandidate: ({ original }) => {
      const options = { targetURL: CHAT_WAKE_TARGET_URL };
      const { source } = inspectFolderCache(original, options);
      return replaceFolderCacheSource(original, buildClaudeChatWakeSource(source, { root, registryRoot, wakeSource }), options);
    },
  });
}

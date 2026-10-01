import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { syntax } from './claude-frontend-anchors.mjs';

export const CHAT_WAKE_TARGET_URL = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-18-C2EdCha1.js';
export const CHAT_WAKE_SOURCE_SHA256 = 'cde0289f1e687e301c1dc7fb8ae632b6591bed5f5a7a5112a84a20797d60affb';
export const CHAT_WAKE_CACHE_FILENAME = '838048883e85ff4b_0';

function canonical(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value))
    throw new Error('Claude chat wake requires canonical absolute paths');
}

/** The native object is the uniquely resolved LocalSessions import.
 * No draft content, message text or credentials are written to console output.
 */
export function buildClaudeChatWakeBootstrap({ root, registryRoot, wakeSource, native = 'Ge', assetName = 'shared-18-C2EdCha1.js' }) {
  canonical(root); canonical(registryRoot);
  if (typeof wakeSource !== 'string' || !wakeSource.includes('export function createClaudeChatWakeRuntime('))
    throw new Error('Claude chat wake runtime source is unavailable');
  const runtime = wakeSource.replace(/^export /gm, '');
  return `\n;(()=>{${runtime}\nconst wake=createClaudeChatWakeRuntime({native:${native},registryRoot:${JSON.stringify(registryRoot)},readManifest:()=>${native}.readFileAtCwd(${JSON.stringify(root)},"collaboration/chat-mailbox/wake-manifest.json"),hasDraft:()=>Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).some(e=>String(e.value??e.textContent??"").trim()),onError:e=>console.warn("[Claudex chat wake] "+e),onStatus:e=>console.warn("[Claudex chat wake] "+e)});console.warn("[Claudex chat wake] loaded "+${JSON.stringify(assetName)});wake.start();window.addEventListener("beforeunload",()=>wake.stop(),{once:true});})();\n`;
}

/** Production bindings come from the validated current import graph. */
export function buildClaudeChatWakeSource(source, options) {
  if (!options?.bindings) throw new Error('Claude chat wake frontend source is unvalidated');
  const result = source + buildClaudeChatWakeBootstrap({ ...options, native: options.bindings.native });
  syntax(result); return result;
}

/** Independent journal and immutable original; does not replace folder-map
 * presentation or depend on a particular sidebar grouping being mounted.
 */
export async function ensureClaudeChatWakeCache({ root, home = homedir(), cachePath, graph,
  folders = false,
  registryRoot = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions') }) {
  canonical(root); canonical(home); canonical(registryRoot);
  graph ??= await (await import('./claude-frontend-graph.mjs')).discoverClaudeFrontend({ root, home });
  const shared = graph.adapters.folders?.status === 'matched' && graph.adapters.chatWake?.status === 'matched'
    && graph.adapters.folders.target.url === graph.adapters.chatWake.target.url;
  return (await import('./claude-renderer-adapters.mjs')).ensureClaudeRendererAdapter({ root, home, cachePath, graph, registryRoot,
    adapter: shared && folders ? 'folders' : 'chatWake',
    ...(shared ? { sharedResourceMode: folders ? 'combined' : 'chat-only' } : {}) });
}

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { privateDirectory } from './storage.mjs';
import { inspectFolderCache, replaceFolderCacheSource, sha256 } from './claude-folder-cache.mjs';
import { ensureClaudeFolderCache } from './claude-folder-install.mjs';

export const OWNER_WAKE_TARGET_URL = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-16-B0kpSitB.js';
export const OWNER_WAKE_SOURCE_SHA256 = 'f5d9a99fb6e529da64678dd22b3220fa205cda58b3a34761bbbf9751c241c6cb';
export const OWNER_WAKE_CACHE_FILENAME = '9b3f1b6cc4f6eba0_0';

function canonical(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Claude owner wake requires canonical absolute paths');
}

export function buildClaudeOwnerWakeBootstrap({ root, runtimeSource }) {
  canonical(root);
  if (!runtimeSource?.includes('export function createClaudeOwnerWakeRuntime(')) throw new Error('Owner wake runtime source is unavailable');
  const runtime = runtimeSource.replace(/^export /gm, '');
  // Sessionless direct MCP is the observed native API with device grant checks.
  // LocalSessions.mcpCallTool requires a Local session and cannot address RC.
  return `\nconst __cldxOwnerWake=(()=>{${runtime}\nconst local=globalThis["claude.web"]?.LocalSessions,direct=globalThis["claude.web"]?.LocalAgentModeSessions;const wake=createClaudeOwnerWakeRuntime({readMap:typeof local?.readFileAtCwd==="function"?()=>local.readFileAtCwd(${JSON.stringify(root)},"folder-map.json"):undefined,callTool:typeof direct?.directMcpCallTool==="function"?(...args)=>direct.directMcpCallTool(...args):undefined,onError:e=>console.warn("[Claudex owner wake] "+e)});console.warn("[Claudex owner wake] loaded shared-16-B0kpSitB.js");wake.start();console.warn("[Claudex owner wake] started");window.addEventListener("beforeunload",()=>wake.stop(),{once:true});return wake})();\n`;
}

export function transformClaudeOwnerWakeSource(source, options) {
  // Exact unique anchors are also exercised with a synthetic component fixture.
  const open = 'function FM(e){', send = 'U=await L.onSend(ee)';
  if (source.split(open).length !== 2 || source.split(send).length !== 2)
    throw new Error('Claude owner wake conversation or submit binding changed');
  return source.replace(open, `${open}h(()=>{void __cldxOwnerWake.signal(e.conversationUuid)},[e.conversationUuid]);`)
    .replace(send, 'void __cldxOwnerWake.signal(c);U=await L.onSend(ee)') + buildClaudeOwnerWakeBootstrap(options);
}

export function buildClaudeOwnerWakeSource(source, options) {
  if (typeof source !== 'string' || sha256(Buffer.from(source)) !== OWNER_WAKE_SOURCE_SHA256)
    throw new Error('Claude owner wake frontend source is unvalidated');
  if (!source.includes('Fa as h') || !source.includes('from"./vendor-frame-DjE7Zk5R.js"')
    || !source.includes('sessionId:$t') || !source.includes('onSend:ne'))
    throw new Error('Claude owner wake native component binding changed');
  return transformClaudeOwnerWakeSource(source, options);
}

/** Independent resource-specific recovery journal; earlier folder/chat resources
 * and their originals and receipts remain untouched. No app restart is performed.
 */
export async function ensureClaudeOwnerWakeCache({ root, home = homedir(), cachePath }) {
  canonical(root); canonical(home);
  const expected = join(home, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data', OWNER_WAKE_CACHE_FILENAME);
  if (cachePath !== undefined && cachePath !== expected) throw new Error('Claude owner wake cache path does not match its pinned resource');
  const stateRoot = join(root, 'ui-owner-wake', OWNER_WAKE_CACHE_FILENAME);
  await privateDirectory(stateRoot);
  const runtimeSource = await readFile(new URL('./claude-owner-wake-runtime.mjs', import.meta.url), 'utf8');
  return ensureClaudeFolderCache({ root: stateRoot, cachePath: expected }, {
    sourceHash: OWNER_WAKE_SOURCE_SHA256, targetURL: OWNER_WAKE_TARGET_URL,
    buildCandidate: ({ original }) => {
      const options = { targetURL: OWNER_WAKE_TARGET_URL };
      const { source } = inspectFolderCache(original, options);
      return replaceFolderCacheSource(original, buildClaudeOwnerWakeSource(source, { root, runtimeSource }), options);
    },
  });
}

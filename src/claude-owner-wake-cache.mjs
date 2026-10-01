import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { privateDirectory } from './storage.mjs';
import { inspectFolderCache, replaceFolderCacheSource, sha256 } from './claude-folder-cache.mjs';
import { ensureClaudeFolderCache } from './claude-folder-install.mjs';

export const OWNER_WAKE_TARGET_URL = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/cc43287c9-6nYyeS-m.js';
export const OWNER_WAKE_SOURCE_SHA256 = '62d14b5c968d83d64bc392656dafa4a5610409ad9757e168be6b7367a466a35a';
export const OWNER_WAKE_CACHE_FILENAME = '6ce7062c8d22ac79_0';

function canonical(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Claude owner wake requires canonical absolute paths');
}

export function buildClaudeOwnerWakeBootstrap({ root, runtimeSource }) {
  canonical(root);
  if (!runtimeSource?.includes('export function createClaudeOwnerWakeRuntime(')) throw new Error('Owner wake runtime source is unavailable');
  const runtime = runtimeSource.replace(/^export /gm, '');
  // Ga is the native lookup of an already attached user-config stdio client by
  // exact UUID. directMcpCallTool addresses the separate managed/builtin pool;
  // LocalSessions.mcpCallTool requires a Local session. Neither addresses RC.
  return `\nimport{Ga as __cldxOwnerWakeClient}from"./shared-common-mcp-msg-4-EwhHCIE8.js";\nconst __cldxOwnerWake=(()=>{${runtime}\nconst local=globalThis["claude.web"]?.LocalSessions;const wake=createClaudeOwnerWakeRuntime({readMap:typeof local?.readFileAtCwd==="function"?()=>local.readFileAtCwd(${JSON.stringify(root)},"folder-map.json"):undefined,getClient:__cldxOwnerWakeClient,onStatus:e=>console.warn("[Claudex owner wake] "+e)});console.warn("[Claudex owner wake] loaded cc43287c9-6nYyeS-m.js");wake.start();window.addEventListener("beforeunload",()=>wake.stop(),{once:true});return wake})();\n`;
}

export function transformClaudeOwnerWakeSource(source, options) {
  // Exact unique anchors are also exercised with a synthetic component fixture.
  // Code/RC renders o8, not the shared Chat/Cowork FM component. X is the
  // current native session reference, including switches within the same pane.
  const open = 'let X=Te,Z=X?.id??null,De;', send = 'fS=async(e,t)=>{';
  if (source.split(open).length !== 2 || source.split(send).length !== 2
    || source.split('let Oe=je(De)').length !== 2 || source.split('let Ge=Oe();').length !== 2)
    throw new Error('Claude owner wake conversation or submit binding changed');
  return source.replace(open, 'let X=Te,Z=X?.id??null;m(()=>{void __cldxOwnerWake.signal(X?.id,"selection",X?.type)},[X?.id,X?.type]);let De;')
    // Signal before native early refusals (including disconnected transports).
    // The original callback still owns input and dispatch; no await or resend.
    // Native send itself reads Oe() after awaited attachment work. je maintains
    // the current reference independently of a retained submit closure's X.
    .replace(send, `${send}{const ref=Oe();void __cldxOwnerWake.signal(ref?.id,"submit",ref?.type);}`) + buildClaudeOwnerWakeBootstrap(options);
}

export function buildClaudeOwnerWakeSource(source, options) {
  if (typeof source !== 'string' || sha256(Buffer.from(source)) !== OWNER_WAKE_SOURCE_SHA256)
    throw new Error('Claude owner wake frontend source is unvalidated');
  if (!source.includes('Fa as m') || !source.includes('from"./vendor-frame-DjE7Zk5R.js"')
    || !source.includes('function o8(e){') || !source.includes('var n9=p(o8)')
    || !source.includes('Br as Et') || !source.includes('from"./shared-common-mcp-msg-4-EwhHCIE8.js"')
    || !source.includes('submitMessage:e=>void pS(e)'))
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

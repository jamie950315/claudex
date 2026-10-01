import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { transformAnchoredOwner } from './claude-frontend-anchors.mjs';

export const OWNER_WAKE_TARGET_URL = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/cc43287c9-6nYyeS-m.js';
export const OWNER_WAKE_SOURCE_SHA256 = '62d14b5c968d83d64bc392656dafa4a5610409ad9757e168be6b7367a466a35a';
export const OWNER_WAKE_CACHE_FILENAME = '6ce7062c8d22ac79_0';

function canonical(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Claude owner wake requires canonical absolute paths');
}

export function buildClaudeOwnerWakeBootstrap({ root, runtimeSource, client = { exported: 'Ga', path: './shared-common-mcp-msg-4-EwhHCIE8.js' }, assetName = 'cc43287c9-6nYyeS-m.js' }) {
  canonical(root);
  if (!runtimeSource?.includes('export function createClaudeOwnerWakeRuntime(')) throw new Error('Owner wake runtime source is unavailable');
  const runtime = runtimeSource.replace(/^export /gm, '');
  // The graph resolves the native lookup of an already attached user-config stdio client by
  // exact UUID. directMcpCallTool addresses the separate managed/builtin pool;
  // LocalSessions.mcpCallTool requires a Local session. Neither addresses RC.
  return `\nimport{${client.exported} as __cldxOwnerWakeClient}from${JSON.stringify(client.path)};\nconst __cldxOwnerWake=(()=>{${runtime}\nconst local=globalThis["claude.web"]?.LocalSessions;const wake=createClaudeOwnerWakeRuntime({readMap:typeof local?.readFileAtCwd==="function"?()=>local.readFileAtCwd(${JSON.stringify(root)},"folder-map.json"):undefined,getClient:__cldxOwnerWakeClient,onStatus:e=>console.warn("[Claudex owner wake] "+e)});console.warn("[Claudex owner wake] loaded "+${JSON.stringify(assetName)});wake.start();window.addEventListener("beforeunload",()=>wake.stop(),{once:true});return wake})();\n`;
}

export function transformClaudeOwnerWakeSource(source, options) {
  if (options?.bindings) return transformAnchoredOwner(source, options.bindings,
    buildClaudeOwnerWakeBootstrap({ ...options, client: options.bindings.client }));
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
  if (!options?.bindings) throw new Error('Claude owner wake frontend source is unvalidated');
  return transformClaudeOwnerWakeSource(source, options);
}

/** Independent resource-specific recovery journal; earlier folder/chat resources
 * and their originals and receipts remain untouched. No app restart is performed.
 */
export async function ensureClaudeOwnerWakeCache({ root, home = homedir(), cachePath, graph }) {
  canonical(root); canonical(home);
  return (await import('./claude-renderer-adapters.mjs')).ensureClaudeRendererAdapter({ root, home, cachePath, graph, adapter: 'ownerWake' });
}

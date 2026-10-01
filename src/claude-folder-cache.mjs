import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { transformAnchoredFolder } from './claude-frontend-anchors.mjs';

const { constants, crc32, zstdCompressSync, zstdDecompressSync } = zlib;

const HEADER_MAGIC = 0xfcfb6d1ba7725c30n;
const FOOTER_MAGIC = 0xf4fa6f45970d41d8n;
export const FOLDER_TARGET_URL = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-19-DDVvTIwQ.js';
export const FOLDER_CACHE_FILENAME = '9cebfb8fc5a9f22f_0';
export const FOLDER_SOURCE_SHA256 = 'c036136315a82ada3fcca90ea62ed77c5696d49c97509b186364cf0ad9713784';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Claude folder resource: ${message}`); };

/** Strict reader for the observed Chromium simple-cache v5 static JS entry.
 * No HTTP metadata, source code, credentials, or session data is executed.
 */
export function inspectFolderCache(bytes, { targetURL = FOLDER_TARGET_URL } = {}) {
  if (typeof crc32 !== 'function' || typeof zstdCompressSync !== 'function' || typeof zstdDecompressSync !== 'function')
    fail('this optional adapter requires Node with Zstandard and CRC32 support');
  if (!Buffer.isBuffer(bytes) || bytes.length < 128 || bytes.length > 2 * 1024 * 1024)
    fail('invalid cache entry size');
  if (bytes.readBigUInt64LE(0) !== HEADER_MAGIC || bytes.readUInt32LE(8) !== 5)
    fail('unsupported cache header');
  const keyLength = bytes.readUInt32LE(12), start = 24 + keyLength;
  if (keyLength < 1 || keyLength > 4096 || start >= bytes.length) fail('invalid cache key');
  const key = bytes.subarray(24, start);
  if (key.toString() !== `1/0/${targetURL}`) fail('unexpected resource URL');
  const eof0 = bytes.length - 24;
  if (bytes.readBigUInt64LE(eof0) !== FOOTER_MAGIC || bytes.readUInt32LE(eof0 + 8) !== 3)
    fail('unsupported metadata footer');
  const metadataSize = Number(bytes.readBigUInt64LE(eof0 + 16));
  const eof1 = eof0 - 32 - metadataSize - 24;
  if (!Number.isSafeInteger(metadataSize) || metadataSize < 1 || eof1 < start
      || bytes.readBigUInt64LE(eof1) !== FOOTER_MAGIC || bytes.readUInt32LE(eof1 + 8) !== 1
      || bytes.readBigUInt64LE(eof1 + 16) !== 0n) fail('unsupported body footer');
  const body = bytes.subarray(start, eof1), metadata = bytes.subarray(eof1 + 24, eof0 - 32);
  if (crc32(body) !== bytes.readUInt32LE(eof1 + 12) || crc32(metadata) !== bytes.readUInt32LE(eof0 + 12)
      || !bytes.subarray(eof0 - 32, eof0).equals(createHash('sha256').update(key).digest()))
    fail('cache checksum mismatch');
  const decoded = zstdDecompressSync(body, { maxOutputLength: 2 * 1024 * 1024 });
  const source = decoded.toString('utf8');
  if (!Buffer.from(source).equals(decoded)) fail('source is not canonical UTF-8');
  return { start, eof1, body, metadata, decoded, source, sourceHash: sha256(decoded) };
}

/** Rebuild the observed cache streams, retaining the key and all unrelated
 * metadata. The two length headers retain their serialized field widths.
 */
export function replaceFolderCacheSource(original, source, options = {}) {
  const entry = inspectFolderCache(original, options), encoded = Buffer.from(source);
  if (encoded.length > 2 * 1024 * 1024) fail('patched source exceeds its bound');
  const compressed = zstdCompressSync(encoded, { params: { [constants.ZSTD_c_compressionLevel]: 19 } });
  if (!zstdDecompressSync(compressed, { maxOutputLength: 2 * 1024 * 1024 }).equals(encoded))
    fail('compressed source did not roundtrip');
  const oldSize = String(entry.body.length), newSize = String(compressed.length);
  if (oldSize.length !== newSize.length) fail('compressed length changes the metadata field width');
  const eof0 = original.length - 24;
  const metadata = Buffer.from(original.subarray(entry.eof1 + 24, eof0 - 32));
  for (const name of ['content-length', 'x-goog-stored-content-length']) {
    const before = Buffer.from(`\0${name}:${oldSize}\0`), after = Buffer.from(`\0${name}:${newSize}\0`);
    const offset = metadata.indexOf(before);
    if (offset < 0 || metadata.indexOf(before, offset + 1) >= 0) fail('response length metadata changed');
    after.copy(metadata, offset);
  }
  const footer1 = Buffer.from(original.subarray(entry.eof1, entry.eof1 + 24));
  const footer0 = Buffer.from(original.subarray(eof0));
  footer1.writeUInt32LE(crc32(compressed), 12);
  footer0.writeUInt32LE(crc32(metadata), 12);
  const candidate = Buffer.concat([original.subarray(0, entry.start), compressed, footer1,
    metadata, original.subarray(eof0 - 32, eof0), footer0]);
  if (inspectFolderCache(candidate, options).source !== source) fail('candidate verification failed');
  return candidate;
}

/** Version-locked, presentation-only proof; input identities are explicit.
 * Does not change native row IDs, types, routes, workers, or session records.
 */
export function buildFolderSourceProof(source, overrides) {
  if (sha256(Buffer.from(source)) !== FOLDER_SOURCE_SHA256) fail('unvalidated frontend source');
  for (const [id, entry] of Object.entries(overrides)) {
    if (!/^session_[A-Za-z0-9]+$/.test(id) || !entry || typeof entry.projectKey !== 'string'
        || !entry.projectKey.startsWith('/') || typeof entry.label !== 'string' || !entry.label.trim())
      fail('invalid exact-session project override');
  }
  const marker = 'function _K(e){';
  if (source.split(marker).length !== 2) fail('project-key function changed');
  const lookup = `const __cldxFolders=Object.freeze(${JSON.stringify(overrides)});function __cldxFolder(e){return e.type==="bridge"?__cldxFolders[String(e.id??"").replace(/^cse_/,"session_")]:void 0}`;
  let result = source.replace(marker, `${lookup}${marker}const f=__cldxFolder(e);if(f)return f.projectKey;`);
  const begin = result.indexOf('var bK=[];'), end = result.indexOf('function SK(', begin);
  if (begin < 0 || end < begin) fail('project-list function changed');
  let list = result.slice(begin, end);
  for (const [before, after] of [
    ['name:a?.name??e', 'name:__cldxFolder(n)?.label??a?.name??e'],
  ]) {
    if (list.split(before).length !== 2) fail('project label expression changed');
    list = list.replace(before, after);
  }
  return result.slice(0, begin) + list + result.slice(end);
}

/** Native readFileAtCwd retains Claude's workspace/path policy. The reader is
 * disabled outside Desktop, and only the exact private JSON map is read.
 */
export function buildDynamicFolderSource(source, options) {
  if (!options?.bindings) fail('unvalidated frontend source anchors');
  return transformDynamicFolderSource(source, options);
}

/** Production uses validated AST bindings. The former exact transform remains
 * available for legacy synthetic hook tests, never for automatic installation.
 */
export function transformDynamicFolderSource(source, { root, bindings, assetName = 'shared-19-DDVvTIwQ.js', projectionSource, runtimeSource, handoffSource = '', anchorSource = '', wakeSource = '', registryRoot }) {
  if (typeof root !== 'string' || !root.startsWith('/') || /[\0\r\n]/.test(root)) fail('invalid mapping root');
  const projection = projectionSource.replace(/^export /gm, '');
  const runtime = runtimeSource.replace(/^import[^\n]+\n/, '').replace(/^export /gm, '');
  const handoff = handoffSource.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  const anchor = anchorSource.replace(/^export /gm, '');
  const wake = wakeSource.replace(/^export /gm, '');
  if ((handoff || wake) && (typeof registryRoot !== 'string' || !registryRoot.startsWith('/') || /[\0\r\n]/.test(registryRoot)))
    fail('native handoffs require a canonical Desktop registry root');
  const begin = source.indexOf('function _K('), end = source.indexOf('function vK(', begin);
  if (!bindings && (begin < 0 || end < begin || source.split('function _K(').length !== 2
    || source.split('function vK(').length !== 2)) fail('project-key function changed');
  const original = source.slice(begin, end).replace('function _K(', 'function __cldxNativeProjectKey(');
  const lifecycle = handoff ? `,createHandoff:o=>createClaudeDesktopHandoffRuntime({...o,registryRoot:${JSON.stringify(registryRoot)},readManifest:typeof Ne?.readFileAtCwd==="function"?()=>Ne.readFileAtCwd(${JSON.stringify(root)},"desktop-handoff.json"):null,native:Ne,normalizeAnchor:typeof normalizeClaudeLocalFolderAnchor==="function"?normalizeClaudeLocalFolderAnchor:undefined,hasDraft:()=>Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).some(e=>String(e.value??e.textContent??"").trim()),onError:e=>console.warn("[Claudex native handoff] "+e)})` : '';
  const wakeLifecycle = wake ? `,createWake:()=>createClaudeChatWakeRuntime({registryRoot:${JSON.stringify(registryRoot)},readManifest:()=>Ne.readFileAtCwd(${JSON.stringify(root)},"collaboration/chat-mailbox/wake-manifest.json"),native:Ne,hasDraft:()=>Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).some(e=>String(e.value??e.textContent??"").trim()),onError:e=>console.warn("[Claudex chat wake] "+e),onStatus:e=>console.warn("[Claudex chat wake status] "+e)})` : '';
  const bootstrap = `const __cldx=(()=>{${projection}\n${anchor}\n${handoff}\n${wake}\n${runtime}\nconst runtime=createClaudeFolderRuntime({readMap:typeof Ne?.readFileAtCwd==="function"?()=>Ne.readFileAtCwd(${JSON.stringify(root)},"folder-map.json"):null,onError:e=>console.warn("[Claudex folder mapping] "+e)${lifecycle}${wakeLifecycle}});console.warn("[Claudex folder mapping] loaded "+${JSON.stringify(assetName)});return runtime})();`;
  if (bindings) return transformAnchoredFolder(source, bindings, bootstrap.replace(/\bNe\b/g, bindings.native));
  let result = source.slice(0, begin) + bootstrap + original
    + 'function _K(e){return __cldx.lookup(e)?.projectKey??__cldxNativeProjectKey(e)}' + source.slice(end);
  const listBegin = result.indexOf('var bK=[];'), listEnd = result.indexOf('function SK(', listBegin);
  if (listBegin < 0 || listEnd < listBegin || result.split('var bK=[];').length !== 2
    || result.split('function SK(').length !== 2) fail('project-list function changed');
  let list = result.slice(listBegin, listEnd);
  const subscribe = 'const __cldxVersion=m(__cldx.subscribe,__cldx.getSnapshot,__cldx.getSnapshot);__cldx.setRows(e,__cldxNativeProjectKey);';
  for (const [before, after] of [
    ['function xK(e,t,n){let r=Q(11)', `function xK(e,t,n){${subscribe}let r=Q(12)`],
    ['if(r[0]!==s||r[1]!==c||r[2]!==e||r[3]!==i)', 'if(r[0]!==s||r[1]!==c||r[2]!==e||r[3]!==i||r[11]!==__cldxVersion)'],
    ['r[0]=s,r[1]=c,r[2]=e,r[3]=i,r[4]=l', 'r[0]=s,r[1]=c,r[2]=e,r[3]=i,r[4]=l,r[11]=__cldxVersion'],
    ['name:a?.name??e', 'name:__cldx.lookup(n)?.label??a?.name??e'],
  ]) {
    if (list.split(before).length !== 2) fail('project hook expression changed');
    list = list.replace(before, after);
  }
  return result.slice(0, listBegin) + list + result.slice(listEnd);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { frontendBuild, writeFrontend } from './fixtures/claude-frontend.mjs';
import { discoverClaudeFrontend } from '../src/claude-frontend-graph.mjs';
import { buildClaudeOwnerWakeSource } from '../src/claude-owner-wake-cache.mjs';
import { buildClaudeChatWakeBootstrap } from '../src/claude-chat-wake-cache.mjs';
import { transformDynamicFolderSource } from '../src/claude-folder-cache.mjs';
import { exposeClaudexCommand } from '../src/claude-frontend-anchors.mjs';

// A wrong anchor or a broken runtime may lose a Claudex signal. It must never
// stop the vendor module from evaluating or change what native code returns.
async function owner(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-failsafe-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state'), home = join(base, 'home');
  await mkdir(root, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFrontend(home, frontendBuild());
  return { root, matched: (await discoverClaudeFrontend({ root, home })).adapters.ownerWake };
}
async function send(source, extra = {}) {
  const effects = [], context = { eventa: callback => callback, effecta: callback => effects.push(callback),
    __cldxOwnerWakeClient() {}, window: { addEventListener() {} }, console: { warn() {} },
    images: { async waitForImagesReady() {} }, nativeSend: (text, options, ref) => ({ text, ref }), ...extra };
  runInNewContext(source.replace(/import[^;]+;/g, '') + ';globalThis.viewa=viewa;', context);
  const view = context.viewa({ initialSessionId: 'session_first', sessionType: 'bridge' });
  for (const effect of effects) effect();
  return view.dispatch('text', {});
}

test('owner wake failures never reach the native send or module evaluation', async t => {
  const { root, matched } = await owner(t);
  assert.equal(matched.status, 'matched', matched.reason);
  const build = (runtimeSource, bindings = matched.bindings) => buildClaudeOwnerWakeSource(matched.target.source, { root, bindings, runtimeSource });
  const expected = { text: 'text', ref: { id: 'session_first', type: 'bridge' } };
  for (const runtimeSource of [
    'export function createClaudeOwnerWakeRuntime(){throw new Error("startup")}',
    'export function createClaudeOwnerWakeRuntime(){return{start(){throw new Error("start")},stop(){},signal(){}}}',
    'export function createClaudeOwnerWakeRuntime(){return{start(){},stop(){},signal(){throw new Error("signal")}}}',
    'export function createClaudeOwnerWakeRuntime(){return{start(){},stop(){},signal(){return Promise.reject(new Error("later"))}}}',
  ]) assert.deepEqual(JSON.parse(JSON.stringify(await send(build(runtimeSource)))), expected);
  // An anchor naming a binding the send cannot read loses only the signal.
  const inert = 'export function createClaudeOwnerWakeRuntime(){return{start(){},stop(){},signal(){}}}';
  const wrong = { ...matched.bindings, variants: matched.bindings.variants.map(v => ({ ...v, getter: 'absentBinding' })) };
  assert.deepEqual(JSON.parse(JSON.stringify(await send(build(inert, wrong)))), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(await send(build(inert), { window: undefined }))), expected);
});

test('a failing folder runtime leaves native keys, labels and subscriptions intact', async () => {
  const fixture = 'function _K(e){return e.type==="local"?e.cwd:e.repoInfo?.name}function vK(e,t){return e+":"+t}'
    + 'var bK=[];function xK(e,t,n){let r=Q(11),i=t===void 0?"recent":t,a=n===void 0?bK:n,{data:o}=Sr(),s=o?.environments,c=Array.isArray(a)?a:bK,l;'
    + 'if(r[0]!==s||r[1]!==c||r[2]!==e||r[3]!==i){l=e.map(n=>{let e=_K(n),a=n.repoInfo;return{key:e,name:a?.name??e}});'
    + 'r[0]=s,r[1]=c,r[2]=e,r[3]=i,r[4]=l}else l=r[4];return l}function SK(e,t){return 0}';
  const projectionSource = await readFile(new URL('../src/claude-folder-projection.mjs', import.meta.url), 'utf8');
  const rows = [{ id: 'session_owned', type: 'bridge', repoInfo: { name: 'remote' } }, { id: 'local_original', type: 'local', cwd: '/project' }];
  for (const runtimeSource of [
    'export function createClaudeFolderRuntime(){throw new Error("startup")}',
    'export function createClaudeFolderRuntime(){const f=()=>{throw new Error("call")};return{getSnapshot:f,subscribe:f,setRows:f,lookup:f}}',
    'export function createClaudeFolderRuntime(){return{getSnapshot:()=>1,subscribe:()=>()=>{throw new Error("unsubscribe")},setRows(){},lookup(){}}}',
  ]) {
    const source = transformDynamicFolderSource(fixture, { root: '/synthetic/state', projectionSource, runtimeSource });
    const context = { Ne: {}, Q: () => [], Sr: () => ({ data: undefined }), console: { warn() {} },
      m: (subscribe, snapshot) => { subscribe(() => {})(); return snapshot(); } };
    runInNewContext(source, context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.xK(rows))), [{ key: 'remote', name: 'remote' }, { key: '/project', name: '/project' }]);
  }
});

test('chat wake startup failures and hostile catalogue rows stay contained', () => {
  const bootstrap = buildClaudeChatWakeBootstrap({ root: '/synthetic/state', registryRoot: '/synthetic/registry', native: 'Na',
    wakeSource: 'export function createClaudeChatWakeRuntime(){throw new Error("startup")}' });
  const context = { Na: {}, console: { warn() {} }, window: { addEventListener() {} }, document: {} };
  runInNewContext(`let loaded=false;${bootstrap};loaded=true;globalThis.loaded=loaded;`, context);
  assert.equal(context.loaded, true);
  const hostile = [{ name: 'claudex:claudex-workflow' }, { get name() { throw new Error('getter'); } }];
  assert.equal(exposeClaudexCommand(hostile, undefined), hostile);
});

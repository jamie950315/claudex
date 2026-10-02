import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile, readdir, writeFile, utimes, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { frontendBuild, writeFrontend, cacheBytes } from './fixtures/claude-frontend.mjs';
import { discoverClaudeFrontend } from '../src/claude-frontend-graph.mjs';
import { syntax, nodes, folderAnchors, chatAnchors, ownerAnchors } from '../src/claude-frontend-anchors.mjs';
import { inspectFolderCache, buildDynamicFolderSource } from '../src/claude-folder-cache.mjs';
import { buildClaudeChatWakeSource, ensureClaudeChatWakeCache } from '../src/claude-chat-wake-cache.mjs';
import { buildClaudeOwnerWakeSource } from '../src/claude-owner-wake-cache.mjs';
import { ensureClaudeRendererAdapters, ensureClaudeRendererAdapter, restoreClaudeRendererAdapter } from '../src/claude-renderer-adapters.mjs';
import { startClaudeRendererMaintenance } from '../src/claude-renderer-maintenance.mjs';
import { ensureClaudeFolderPresentationCache, restoreClaudeFolderPresentationCache } from '../src/claude-folder-presentation-cache.mjs';
import { runDesktopWatch } from '../src/desktop-watch.mjs';
import { patchContracts } from './fixtures/claude-frontend-contracts.mjs';

async function fixture(t, tag = 'a', options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-frontend-')));t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'state'),home=join(base,'home');await mkdir(root,{mode:0o700});await mkdir(home,{mode:0o700});
  const build=frontendBuild(tag, tag === 'b' ? 17 : 11, options),resources=await writeFrontend(home,build);
  return {base,root,home,build,resources};
}
const sourceOf = async resource => inspectFolderCache(await readFile(resource.path),{targetURL:resource.url}).source;
const withoutImports = source => { const imports=syntax(source).body.filter(n=>n.type==='ImportDeclaration');for(const n of imports.reverse())source=source.slice(0,n.start)+source.slice(n.end);return source; };

for (const tag of ['a','b']) test(`renamed build ${tag} preserves folder memo, native API, selection and submit behavior`,async t=>{
  const f=await fixture(t,tag),graph=await discoverClaudeFrontend(f);assert.ok(Object.values(graph.adapters).every(a=>a.status==='matched'));
  const results=await ensureClaudeRendererAdapters({...f,graph});assert.deepEqual(Object.values(results.adapters).map(a=>a.status),['installed','installed','installed']);
  const projectionSource=await readFile(new URL('../src/claude-folder-projection.mjs',import.meta.url),'utf8'),runtimeSource=await readFile(new URL('../src/claude-folder-runtime.mjs',import.meta.url),'utf8');
  const folder=graph.adapters.folders;const transformed=buildDynamicFolderSource(folder.target.source,{root:f.root,bindings:folder.bindings,assetName:f.build.names.folders,projectionSource,runtimeSource});
  let contents=JSON.stringify({version:1,entries:[{remoteId:'cse_owned',canonicalCwd:'/synthetic/project',verified:true}]}),poll;
  const cache=[],context={ [`L${tag}`]:{readFileAtCwd:async()=>({contents})},[`memo${tag}`]:size=>{assert.equal(size,(tag==='b'?17:11)+1);return cache},[`sub${tag}`]:(subscribe,snapshot)=>{subscribe(()=>{});return snapshot()},[`data${tag}`]:()=>({data:null}),setTimeout:fn=>{poll=fn;return 1},clearTimeout(){},console:{warn(){}} };
  runInNewContext(withoutImports(transformed),context);const rows=[{id:'session_owned',type:'bridge',repoInfo:{name:'remote'},sessionStatus:'idle',timestamp:0},{id:'local_original',type:'local',cwd:'/synthetic/project',repoInfo:{name:'project'},sessionStatus:'idle',timestamp:0}],before=structuredClone(rows);
  const original=context[`group${tag}`](rows);await new Promise(r=>setImmediate(r));const mapped=context[`group${tag}`](rows);assert.equal(mapped[0].key,'/synthetic/project');assert.notEqual(mapped,original);assert.equal(context[`group${tag}`](rows),mapped);contents=JSON.stringify({version:1,entries:[]});await poll();assert.equal(context[`group${tag}`](rows)[0].key,'remote');assert.deepEqual(rows,before);
  let chatOptions,started=false;const chat=graph.adapters.chatWake;const chatSource=buildClaudeChatWakeSource(chat.target.source,{root:f.root,registryRoot:'/synthetic/registry',bindings:chat.bindings,assetName:f.build.names.chatWake,wakeSource:'export function createClaudeChatWakeRuntime(o){capture(o);return{start(){started()},stop(){}}}'});
  const native={};runInNewContext(withoutImports(chatSource),{[`L${tag}`]:native,capture:o=>{chatOptions=o},started:()=>{started=true},console:{warn(){}},window:{addEventListener(){}},document:{querySelectorAll:()=>[]}});assert.equal(started,true);assert.equal(chatOptions.native,native);
  const owner=graph.adapters.ownerWake,signals=[],effects=[];const ownerSource=buildClaudeOwnerWakeSource(owner.target.source,{root:f.root,bindings:owner.bindings,assetName:f.build.names.ownerWake,runtimeSource:'export function createClaudeOwnerWakeRuntime(){return{start(){},stop(){},signal(...v){capture(v)}}}'});
  const ownerContext={[`event${tag}`]:callback=>callback,[`effect${tag}`]:fn=>effects.push(fn),__cldxOwnerWakeClient:()=>{},capture:v=>signals.push(v),console:{warn(){}},window:{addEventListener(){}},images:{waitForImagesReady:async()=>{}},nativeSend:(text,options,ref)=>({text,options,ref})};runInNewContext(withoutImports(ownerSource),ownerContext);
  const view=ownerContext[`view${tag}`]({initialSessionId:'session_owned',sessionType:'bridge'});effects[0]();assert.equal(await view.dispatch('private',{blocked:true}),'blocked');assert.deepEqual(JSON.parse(JSON.stringify(signals)),[['session_owned','selection','bridge'],['session_owned','submit','bridge']]);const input={private:true},options={};const sent=await view.dispatch(input,options);assert.equal(sent.text,input);assert.equal(sent.options,options);assert.equal(sent.ref.id,'session_owned');
  for(const adapter of ['folders','chatWake','ownerWake']) {const resource=f.resources[adapter];const saved=await sourceOf(resource);syntax(saved);assert.ok(saved.includes(f.build.names[adapter]));const journal=join(f.root,{folders:'ui-folders',chatWake:'ui-chat-wake',ownerWake:'ui-owner-wake'}[adapter],resource.filename,'ui-folder-compat');assert.deepEqual(await readFile(join(journal,'original.cache')),resource.bytes);}
});

test('each adapter rejects missing and ambiguous anchors; invalid transformed syntax never publishes',async t=>{
  const f=await fixture(t),graph=await discoverClaudeFrontend(f);
  for(const [adapter,probe,anchor]of [['folders',folderAnchors,'isScratchWorkspace'],['chatWake',chatAnchors,'forkSession'],['ownerWake',ownerAnchors,'waitForImagesReady']]){
    const target=graph.adapters[adapter].target,localGraph={get:p=>graph.modules.get(new URL(p,target.url).href)};
    assert.throws(()=>probe(target.source.replaceAll(anchor,'unsupported'),localGraph),/missing or ambiguous/);
    // Repeated declaration identifiers are renamed so ambiguity is structural,
    // not merely the JavaScript parser rejecting a duplicate binding.
    const fn = syntax(target.source).body.find(n => n.type === 'FunctionDeclaration' && n.id.name === (adapter === 'folders' ? 'groupa' : 'viewa'));
    const duplicate = adapter === 'chatWake' ? `import{Nativea as duplicateNative}from"./${f.build.names.native}";let duplicateCapability=duplicateNative?.forkSession!==void 0;`
      : target.source.slice(fn.start,fn.end).replace(fn.id.name,'duplicateComponent');
    assert.throws(()=>probe(target.source+duplicate,localGraph),/missing or ambiguous/);
  }
  const target=graph.adapters.chatWake.target;assert.throws(()=>buildClaudeChatWakeSource(target.source,{root:f.root,registryRoot:'/synthetic/registry',bindings:graph.adapters.chatWake.bindings,wakeSource:'export function createClaudeChatWakeRuntime( broken'}),/syntax rejected/);
  assert.deepEqual(await readFile(f.resources.chatWake.path),f.resources.chatWake.bytes);assert.deepEqual(await readdir(f.root),[]);
});

test('reinstall, prepared recovery, restore and new graphs retain every immutable original',async t=>{
  const f=await fixture(t);let graph=await discoverClaudeFrontend(f);const first=await ensureClaudeRendererAdapters({...f,graph});assert.ok(Object.values(first.adapters).every(a=>a.changed));
  graph=await discoverClaudeFrontend(f);const second=await ensureClaudeRendererAdapters({...f,graph});assert.ok(Object.values(second.adapters).every(a=>!a.changed&&a.status==='installed'));
  for(const adapter of ['folders','chatWake','ownerWake']){
    const resource=f.resources[adapter];await restoreClaudeRendererAdapter({...f,adapter,cachePath:resource.path});assert.deepEqual(await readFile(resource.path),resource.bytes);
    graph=await discoverClaudeFrontend(f);await assert.rejects(ensureClaudeRendererAdapter({...f,adapter,graph},{afterReplace(){throw new Error('synthetic crash')}}),/synthetic crash/);
    graph=await discoverClaudeFrontend(f);assert.equal((await ensureClaudeRendererAdapter({...f,adapter,graph})).recovered,true);
  }
  const newer=await writeFrontend(f.home,frontendBuild('b',17),Date.now());const update=await ensureClaudeRendererAdapters(f);assert.equal(update.entry.asset,'index-b.js');assert.ok(Object.values(update.adapters).every(a=>a.status==='installed'));
  for(const [adapter,resource]of Object.entries(f.resources).filter(([k])=>['folders','chatWake','ownerWake'].includes(k))){const journal=join(f.root,{folders:'ui-folders',chatWake:'ui-chat-wake',ownerWake:'ui-owner-wake'}[adapter],resource.filename,'ui-folder-compat');assert.deepEqual(await readFile(join(journal,'original.cache')),resource.bytes);assert.ok((await sourceOf(newer[adapter])).includes(`[Claudex `));}
  const restored=await restoreClaudeFolderPresentationCache({...f,cachePath:join(f.home,'Library','Application Support','Claude','Cache','Cache_Data','15bc54146dcdb4ce_0')});assert.equal(restored.generations,2);assert.deepEqual(await readFile(f.resources.folders.path),f.resources.folders.bytes);assert.deepEqual(await readFile(newer.folders.path),newer.folders.bytes);
});

test('HTTP recency excludes stale graphs and ambiguous newest entries refuse discovery',async t=>{
  const f=await fixture(t);const later=Date.now();const newer=await writeFrontend(f.home,frontendBuild('b'),later);await utimes(f.resources.entry.path,new Date(later+10000),new Date(later+10000));assert.equal((await discoverClaudeFrontend(f)).entry.asset,'index-b.js');
  await writeFrontend(f.home,frontendBuild('c'),later);await assert.rejects(discoverClaudeFrontend(f),/latest fetched entry missing or ambiguous/);assert.deepEqual(await readFile(newer.folders.path),newer.folders.bytes);
});

test('dependency changes refuse before publication and retain prepared recovery evidence',async t=>{
  const f=await fixture(t),graph=await discoverClaudeFrontend(f);
  const change=()=>writeFile(f.resources.client.path,cacheBytes(f.resources.client.url,f.build.sources.client+';changed;',Date.now()),{mode:0o600});
  await change();await assert.rejects(ensureClaudeRendererAdapter({...f,adapter:'ownerWake',graph}),/graph changed before publication/);assert.deepEqual(await readFile(f.resources.ownerWake.path),f.resources.ownerWake.bytes);
  const resource=f.resources.ownerWake,journal=join(f.root,'ui-owner-wake',resource.filename,'ui-folder-compat');await assert.rejects(readFile(join(journal,'manifest.json')),e=>e.code==='ENOENT');
  let fresh=await discoverClaudeFrontend(f);await assert.rejects(ensureClaudeRendererAdapter({...f,adapter:'ownerWake',graph:fresh},{beforeReplace:change}),/graph changed before publication/);assert.equal(JSON.parse(await readFile(join(journal,'manifest.json'),'utf8')).phase,'prepared');assert.deepEqual(await readFile(resource.path),resource.bytes);
  fresh=await discoverClaudeFrontend(f);await ensureClaudeRendererAdapter({...f,adapter:'ownerWake',graph:fresh});await writeFile(resource.path,cacheBytes(resource.url,f.build.sources.ownerWake+';foreign;',Date.now()),{mode:0o600});await assert.rejects(discoverClaudeFrontend(f),/resource journal or cache ownership changed/);
});

test('cache symlinks refuse before a native resource is read or modified',async t=>{
  const f=await fixture(t);await rm(f.resources.folders.path);await symlink(f.resources.ownerWake.path,f.resources.folders.path);await assert.rejects(discoverClaudeFrontend(f));assert.deepEqual(await readFile(f.resources.ownerWake.path),f.resources.ownerWake.bytes);
});

test('automatic cache notifications reapply all adapters to a new graph, serialize and drain',async t=>{
  const f=await fixture(t);let notify,closed=false,calls=0;const statuses=[];
  const maintenance=await startClaudeRendererMaintenance({...f,settleMs:0,maintain:async(options,deps)=>{calls++;return ensureClaudeRendererAdapters(options,deps)},watchFactory:(_path,listener)=>{notify=listener;const watcher=new EventEmitter;watcher.close=()=>{closed=true};return watcher},writeStatus:async(_path,value)=>statuses.push(value)});
  assert.equal(statuses.at(-1).state,'ready');const unrelated=join(f.home,'Library','Application Support','Claude','Cache','Cache_Data','0000000000000000_0');await writeFile(unrelated,cacheBytes('https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/image.png','synthetic image',Date.now()),{mode:0o600});notify('change','0000000000000000_0');notify('change',f.resources.folders.filename);await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);const newer=await writeFrontend(f.home,frontendBuild('b'),Date.now());notify('rename',newer.entry.filename);notify('change',newer.folders.filename);
  for(let attempts=0;statuses.at(-1).entry?.asset!=='index-b.js'&&attempts<100;attempts++)await new Promise(r=>setTimeout(r,20));
  assert.equal(statuses.at(-1).entry.asset,'index-b.js');assert.ok(Object.values(statuses.at(-1).adapters).every(a=>a.status==='installed'));assert.equal(calls,2);notify('change',null);for(let attempts=0;statuses.length<3&&attempts<100;attempts++)await new Promise(r=>setTimeout(r,20));assert.equal(calls,3);await maintenance.close();assert.equal(closed,true);const count=statuses.length;notify('change',newer.entry.filename);await new Promise(r=>setTimeout(r,10));assert.equal(statuses.length,count);
});

for(const partial of [false,true]) test(`a refused pass is revalidated on unchanged asset hints; partial=${partial}`,async t=>{
  const f=await fixture(t),statuses=[];let notify,calls=0,refuse=false;
  const maintenance=await startClaudeRendererMaintenance({...f,settleMs:0,
    maintain:async(options,deps)=>{calls++;if(refuse&&!partial)throw new Error('Claude frontend graph: graph changed during discovery');const result=await ensureClaudeRendererAdapters(options,deps);if(refuse)result.adapters.ownerWake={status:'skipped'};return result},
    watchFactory:(_path,listener)=>{notify=listener;const e=new EventEmitter;e.close=()=>{};return e},
    writeStatus:async(_path,value)=>statuses.push(value)});
  t.after(()=>maintenance.close());
  const until=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert.ok(predicate())};
  assert.equal(statuses.at(-1).state,'ready');
  refuse=true;notify('change',null);await until(()=>statuses.at(-1).state===(partial?'degraded':'skipped'));
  if(!partial)assert.deepEqual(statuses.at(-1).failure,{phase:'discovery-or-installation',code:'cache-changed'});
  await new Promise(r=>setTimeout(r,30));assert.equal(calls,2);
  refuse=false;notify('change',f.resources.folders.filename);
  await until(()=>statuses.at(-1).state==='ready');assert.equal(calls,3);
  notify('change',f.resources.folders.filename);await new Promise(r=>setTimeout(r,30));assert.equal(calls,3);
});

test('app-stop hold prevents maintenance and pre-publication writes; closing drains an active check',async t=>{
  const f=await fixture(t);let called=0,held=true,release,started,notify;const begun=new Promise(r=>{started=r});const statuses=[];
  const maintenance=await startClaudeRendererMaintenance({...f,settleMs:0,stopState:async()=>({stopped:held}),watchFactory:(_path,listener)=>{notify=listener;const e=new EventEmitter;e.close=()=>{};return e},writeStatus:async(_path,s)=>statuses.push(s),maintain:async(_options,deps)=>{called++;started();await new Promise(r=>{release=r});await deps.beforeReplace();return{entry:{},adapters:{}}}});
  assert.equal(called,0);held=false;notify('change',null);let timeout;try{await Promise.race([begun,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('check did not start')),1000)})])}finally{clearTimeout(timeout)}const closing=maintenance.close();release();await closing;assert.equal(called,1);assert.equal(statuses.length,1);
});

test('normal Desktop watcher owns maintenance and drains it without extra history or heartbeat work',async t=>{
  const f=await fixture(t),order=[];await runDesktopWatch({root:f.root,bridge:{status:async()=>({version:2,conversations:{},records:[],pending:null}),discover:async()=>{},collect:async()=>{}},runtime:{codex:async()=>({request:async()=>({})}),ownedNativeIds:async()=>new Set()},config:{rendererAdapters:{enabled:true}},maxPasses:1,pollMs:0,discover:async()=>[],writeStatus:async()=>{},startRendererMaintenance:async options=>{order.push('start');options.onStatus({state:'ready'});return{close:async()=>order.push('drained')}}});assert.deepEqual(order,['start','drained']);
});

for (const compilerBuild of [true, false]) test(`conditional bindings preserve both branches; active compiler=${compilerBuild}`,async t=>{
  const f=await fixture(t,'a',{variants:true}),graph=await discoverClaudeFrontend(f);
  assert.ok(Object.values(graph.adapters).every(a=>a.status==='matched'));
  assert.equal(graph.adapters.folders.bindings.variants.length,2);assert.equal(graph.adapters.ownerWake.bindings.variants.length,2);
  const result=await ensureClaudeRendererAdapters({...f,graph});assert.ok(Object.values(result.adapters).every(a=>a.status==='installed'));
  for(const adapter of ['folders','chatWake','ownerWake'])patchContracts[adapter](await sourceOf(f.resources[adapter]),graph.adapters[adapter].target.source,graph.adapters[adapter].bindings);
  let contents=JSON.stringify({version:1,entries:[{remoteId:'cse_owned',canonicalCwd:'/synthetic/project',verified:true}]}),poll;
  const cache=[];let deps,saved;const context={compilerBuild,La:{readFileAtCwd:async()=>({contents})},memoa:()=>cache,suba:(subscribe,get)=>{subscribe(()=>{});return get()},dataa:()=>({data:null}),
    useMemoa:(fn,next)=>{if(!deps||next.some((d,i)=>d!==deps[i])){saved=fn();deps=next}return saved},setTimeout:fn=>{poll=fn;return 1},clearTimeout(){},console:{warn(){}}};
  const projectionSource=await readFile(new URL('../src/claude-folder-projection.mjs',import.meta.url),'utf8'),runtimeSource=await readFile(new URL('../src/claude-folder-runtime.mjs',import.meta.url),'utf8');
  const folder=buildDynamicFolderSource(graph.adapters.folders.target.source,{root:f.root,bindings:graph.adapters.folders.bindings,projectionSource,runtimeSource});
  runInNewContext(withoutImports(folder),context);
  const rows=[{id:'session_owned',type:'bridge',repoInfo:{name:'remote'},sessionStatus:'idle',timestamp:0},{id:'local_original',type:'local',cwd:'/synthetic/project',repoInfo:{name:'project'},sessionStatus:'idle',timestamp:0}];context.groupa(rows);await new Promise(r=>setImmediate(r));
  assert.equal(context.groupa(rows)[0].key,'/synthetic/project');contents=JSON.stringify({version:1,entries:[]});await poll();assert.equal(context.groupa(rows)[0].key,'remote');
  const effects=[],signals=[],ownerContext={compilerBuild,eventa:fn=>fn,effecta:fn=>effects.push(fn),__cldxOwnerWakeClient:()=>{},globalThis:{},capture:v=>signals.push(v),
    images:{waitForImagesReady:async()=>{}},nativeSend:(text,options,ref)=>({text,options,ref}),window:{addEventListener(){}},console:{warn(){}}};
  const b=graph.adapters.ownerWake.bindings,owner=buildClaudeOwnerWakeSource(graph.adapters.ownerWake.target.source,{root:f.root,bindings:b,
    runtimeSource:'export function createClaudeOwnerWakeRuntime(){return{start(){},stop(){},signal(...v){capture(v)}}}'});
  runInNewContext(withoutImports(owner),ownerContext);const view=ownerContext.viewa({initialSessionId:'session_owned',sessionType:'bridge'});effects[0]();
  assert.equal(await view.dispatch('private',{blocked:true}),'blocked');assert.deepEqual(JSON.parse(JSON.stringify(signals)),[['session_owned','selection','bridge'],['session_owned','submit','bridge']]);
  const plain=graph.adapters.folders.target.source.replace('return useMemoa(()=>','return unsupportedMemo(()=>');
  assert.throws(()=>folderAnchors(plain,{get:p=>graph.modules.get(new URL(p,graph.adapters.folders.target.url).href)}),/missing or ambiguous/);
});

test('repeated capability reads retain one native binding; another native binding refuses',async t=>{
  const f=await fixture(t),graph=await discoverClaudeFrontend(f),target=graph.adapters.chatWake.target;
  const lookup={get:p=>graph.modules.get(new URL(p,target.url).href)};
  assert.equal(chatAnchors(target.source+';let repeated=La?.forkSession!==void 0;',lookup).native,'La');
  assert.throws(()=>chatAnchors(target.source+`import{Nativea as otherNative}from"./${f.build.names.native}";let second=otherNative?.forkSession!==void 0;`,lookup),/missing or ambiguous/);
});

test('shared folder/chat resources have one atomic journal, recover, disable folders and restore',async t=>{
  const f=await fixture(t,'a',{variants:true,shared:true}),graph=await discoverClaudeFrontend(f);
  assert.ok(Object.values(graph.adapters).every(a=>a.status==='matched'));assert.equal(graph.adapters.folders.target.url,graph.adapters.chatWake.target.url);
  await assert.rejects(ensureClaudeRendererAdapter({...f,adapter:'folders',graph,sharedResourceMode:'combined'},{afterReplace(){throw new Error('synthetic crash')}}),/synthetic crash/);
  let result=await ensureClaudeRendererAdapters(f);assert.equal(result.adapters.folders.recovered,true);assert.equal(result.adapters.chatWake.sharedResource,true);
  let source=await sourceOf(f.resources.folders);assert.equal(source.split('[Claudex chat wake] loaded').length,2);assert.equal(source.split('[Claudex folder mapping] loaded').length,2);
  assert.deepEqual(await readdir(join(f.root,'ui-folders')), [f.resources.folders.filename]);await assert.rejects(readdir(join(f.root,'ui-chat-wake')),e=>e.code==='ENOENT');
  result=await ensureClaudeRendererAdapters(f);assert.ok(Object.values(result.adapters).every(a=>a.status==='installed'&&!a.changed));
  result=await ensureClaudeRendererAdapters({...f,folders:false});assert.equal(result.adapters.folders.status,'disabled');assert.equal(result.adapters.chatWake.status,'installed');
  source=await sourceOf(f.resources.folders);assert.ok(!source.includes('[Claudex folder mapping] loaded'));assert.ok(source.includes('[Claudex chat wake] loaded'));
  await restoreClaudeRendererAdapter({...f,adapter:'chatWake',cachePath:f.resources.chatWake.path});assert.deepEqual(await readFile(f.resources.folders.path),f.resources.folders.bytes);
  await ensureClaudeRendererAdapters(f);await restoreClaudeRendererAdapter({...f,adapter:'folders',cachePath:f.resources.folders.path});assert.deepEqual(await readFile(f.resources.folders.path),f.resources.folders.bytes);
});

test('normal setup entry points compose shared resources and preserve the explicit folder choice',async t=>{
  const f=await fixture(t,'a',{shared:true});
  const enabled=await ensureClaudeChatWakeCache({...f,folders:true});assert.equal(enabled.status,'installed');
  assert.ok((await sourceOf(f.resources.folders)).includes('[Claudex folder mapping] loaded'));
  const folder=await ensureClaudeFolderPresentationCache(f);assert.equal(folder.status,'installed');assert.equal(folder.changed,false);
  const disabled=await ensureClaudeChatWakeCache({...f,folders:false});assert.equal(disabled.status,'installed');
  const source=await sourceOf(f.resources.chatWake);assert.ok(source.includes('[Claudex chat wake] loaded'));assert.ok(!source.includes('[Claudex folder mapping] loaded'));
});

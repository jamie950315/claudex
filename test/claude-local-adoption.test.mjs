import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createClaudeLocalAdoptionRuntime } from '../crates/claudex-app/host/renderer/claude-local-sync-runtime.mjs';
const OP='11111111-1111-4111-8111-111111111111', SESSION='22222222-2222-4222-8222-222222222222';
const SEED='33333333-3333-4333-8333-333333333333', HANDLE='44444444-4444-4444-8444-444444444444';
const CLAIM='55555555-5555-4555-8555-555555555555';
const digest=async v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const flush=async()=>{ for(let n=0;n<25;n++) await new Promise(r=>setImmediate(r)); };
async function fixture({action='resume', fail, draft=false, held=false, connected=true, mismatch=false}={}){
  const content=[{type:'text',text:'Synthetic seed only'}], calls=[], statuses=[];
  const entry={action,opId:OP,sourceOperationId:OP,conversationId:OP,cliSessionId:SESSION,cwd:'/fixture/project',seedUuid:SEED,
    seedContentDigest:await digest(content),expiresAt:10000};
  if(action==='activate') Object.assign(entry,{localSessionId:`local_${SESSION}`,title:'Fixture',lastActivityAt:1,registryPath:`/fixture/registry/local_${SESSION}.json`});
  const row={handle:HANDLE,cwd:entry.cwd,liveness:'not_running',lastActivityAt:1};
  const state={sessionId:entry.localSessionId,cwd:entry.cwd,title:entry.title,lastActivityAt:1,isArchived:false,isRunning:false,turnRunning:false,heldInput:held?{}:undefined};
  const claimed=new Set();
  const native={
    listResumableCliSessions:async()=>{calls.push('list');return[row];},
    readCliTranscript:async()=>({messages:[{uuid:SEED,type:'user',queueTranscriptOnly:true,message:{role:'user',content:mismatch?[{type:'text',text:'changed'}]:content}}],totalMessages:1,transcriptTruncated:false}),
    previewCliResume:async()=>({resumable:true}),
    resumeCliSession:async()=>{calls.push('resume');if(fail==='resume')throw Error('unknown');return{ok:true,sessionId:`local_${SESSION}`};},
    readFileAtCwd:async()=>({contents:JSON.stringify({sessionId:entry.localSessionId,cliSessionId:SESSION,cwd:entry.cwd,title:entry.title,lastActivityAt:1,isArchived:false})}),
    getSession:async()=>state,
    getBusyShellPtyKeys:async()=>({probed:true,busy:[],unknown:[]}),
    getSupportedCommands:async()=>[],
    warmSession:async()=>{calls.push('warm');if(fail==='warm')throw Error('unknown');},
  };
  const client={transport:{_closed:!connected,pid:null,stderr:null,_port:{postMessage(){},close(){}}},getServerVersion:()=>({name:'claudex'}),getServerCapabilities:()=>({tools:{}}),
    callTool:async({name,arguments:a})=>{calls.push([name,a]);if(name.endsWith('_claim')){
      if(claimed.has(name))return{structuredContent:{ready:false}};
      claimed.add(name);return{structuredContent:{ready:true,opId:OP,claimId:CLAIM,handle:HANDLE,cliSessionId:SESSION,localSessionId:entry.localSessionId,lastActivityAt:1}};
    }return{structuredContent:{recorded:true}};}};
  const options={readManifest:async()=>({contents:JSON.stringify({version:1,entries:[entry]})}),native,getClient:()=>client,
    hasDraft:()=>draft,now:()=>1,setTimer:()=>1,clearTimer(){},onStatus:s=>statuses.push(s),digest};
  const create=()=>createClaudeLocalAdoptionRuntime(options);
  return{calls,statuses,entry,state,native,create};
}
test('native picker resumes exact seed once with durable claim and no seed send',async()=>{
  const f=await fixture();const r=f.create();r.start();await flush();await r.poll();r.stop();
  assert.equal(f.calls.filter(x=>x==='resume').length,1);
  assert.ok(f.calls.findIndex(x=>Array.isArray(x)&&x[0]==='claudex_local_adoption_claim')<f.calls.indexOf('resume'));
  const receipt=f.calls.find(x=>Array.isArray(x)&&x[0]==='claudex_local_adoption_receipt')[1];
  assert.equal(receipt.outcome,'resumed');assert.equal(receipt.localSessionId,`local_${SESSION}`);
  assert.ok(!JSON.stringify(f.calls).includes('Synthetic seed only'));
});
test('unknown resume survives renderer restart without native replay',async()=>{
  const f=await fixture({fail:'resume'});let r=f.create();r.start();await flush();r.stop();
  r=f.create();r.start();await flush();r.stop();assert.equal(f.calls.filter(x=>x==='resume').length,1);
  assert.equal(f.calls.find(x=>Array.isArray(x)&&x[0]==='claudex_local_adoption_receipt')[1].outcome,'unknown');
});
test('seed mismatch, composer draft and borrowed/disconnected clients cannot claim',async()=>{
  for(const option of [{mismatch:true},{draft:true},{connected:false}]){
    const f=await fixture(option);const r=f.create();r.start();await flush();r.stop();
    assert.equal(f.calls.filter(x=>Array.isArray(x)).length,0);assert.ok(!f.calls.includes('resume'));
  }
});
test('cold adopted Local activates without prompt once, unknown warm never repeats',async()=>{
  const f=await fixture({action:'activate',fail:'warm'});let r=f.create();r.start();await flush();r.stop();
  r=f.create();r.start();await flush();r.stop();assert.equal(f.calls.filter(x=>x==='warm').length,1);
  assert.equal(f.calls.find(x=>Array.isArray(x)&&x[0]==='claudex_local_activation_receipt')[1].outcome,'unknown');
});
test('held native input and active model work block no-query activation',async()=>{
  for(const mutate of [f=>f.state.heldInput={},f=>f.state.turnRunning=true,f=>f.state.hasBackgroundWork=true]){
    const f=await fixture({action:'activate'});mutate(f);const r=f.create();r.start();await flush();r.stop();
    assert.ok(!f.calls.includes('warm'));assert.equal(f.calls.filter(x=>Array.isArray(x)).length,0);
  }
});
test('an already loaded exact Mod command does not warm again',async()=>{
  const f=await fixture({action:'activate'});f.native.getSupportedCommands=async()=>[{name:'claudex-sync'}];
  const r=f.create();r.start();await flush();r.stop();assert.ok(f.statuses.includes('native-mod-command-ready'));assert.ok(!f.calls.includes('warm'));
});

test('adoption constructor or start failure leaves the existing owner bootstrap working',async()=>{
  const source=await readFile(new URL('../crates/claudex-app/src/frontend_runtime.rs',import.meta.url),'utf8');
  const owner=source.slice(source.indexOf('pub fn owner('));
  const start=owner.indexOf('const __cldxOwnerWake='), end=owner.indexOf('"#;',start);
  assert.ok(start>=0&&end>start);
  const template=owner.slice(start,end);
  for(const fail of ['constructor','start']){
    const script=template.replace('@RUNTIME@',`function createClaudeOwnerWakeRuntime(){return{start(){globalThis.started++},stop(){},signal(){globalThis.signals++}}}`)
      .replace('@LOCAL_SYNC@',fail==='constructor'?`function createClaudeLocalAdoptionRuntime(){throw Error('synthetic constructor')}`
        :`function createClaudeLocalAdoptionRuntime(){return{start(){throw Error('synthetic start')},stop(){}}}`)
      .replaceAll('@ROOT@',JSON.stringify('/fixture/state')).replaceAll('@ASSET@',JSON.stringify('fixture.js'));
    const context={started:0,signals:0,__cldxOwnerWakeClient(){},console:{warn(){}},window:{addEventListener(){}}};
    vm.runInNewContext(`${script};__cldxOwnerWake.signal('synthetic','selection','bridge');`,context);
    assert.equal(context.started,1);assert.equal(context.signals,1);
  }
});

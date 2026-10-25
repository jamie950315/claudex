import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createClaudeLocalStartRuntime } from '../crates/claudex-app/host/renderer/claude-local-sync-runtime.mjs';
const OP='11111111-1111-4111-8111-111111111111', CLI='22222222-2222-4222-8222-222222222222';
const UI='local_33333333-3333-4333-8333-333333333333', CLAIM='55555555-5555-4555-8555-555555555555';
const flush=async()=>{for(let n=0;n<30;n++)await new Promise(r=>setImmediate(r));};
function fixture({stage='prewarm',commands=[{name:'claudex-bootstrap'}],fail,draft=false,connected=true,version=2}={}) {
  const calls=[],statuses=[],claimed=new Set();
  const mapping={sessionId:UI,nativeId:CLI,cwd:'/fixture/scratch',title:'Fixture',lastActivityAt:1,registryPath:`/fixture/registry/${UI}.json`};
  const entry={stage,opId:OP,cwd:'/fixture/project',title:'Fixture',prewarm:{sessionId:UI,cwd:mapping.cwd},
    bootstrap:{sessionId:CLI,cwd:mapping.cwd},mapping,command:'claudex-bootstrap',expiresAt:10000};
  const state={sessionId:UI,cwd:mapping.cwd,title:'Fixture',lastActivityAt:1,isArchived:false,isRunning:false,turnRunning:false};
  const native={
    prewarmFolderless:async args=>{calls.push(['prewarm',args]);if(fail==='prewarm')throw Error('unknown');return entry.prewarm;},
    getSupportedCommands:async args=>{calls.push(['catalogue',args]);return commands;},
    start:async args=>{calls.push(['start',args]);if(fail==='start')throw Error('unknown');return{sessionId:UI};},
    changeCwd:async(...args)=>{calls.push(['move',args]);if(fail==='move')throw Error('unknown');return fail==='trust'?{status:'needs_trust',directory:entry.cwd}:{status:'ok',cwd:entry.cwd,changed:true,transcriptRelocated:true};},
    getSession:async()=>state,getBusyShellPtyKeys:async()=>({probed:true,busy:[],unknown:[]}),
    readFileAtCwd:async()=>({contents:JSON.stringify({...mapping,cliSessionId:CLI,isArchived:false})}),
  };
  const client={transport:{_closed:!connected,pid:null,stderr:null,_port:{postMessage(){},close(){}}},getServerVersion:()=>({name:'claudex'}),getServerCapabilities:()=>({tools:{}}),
    callTool:async({name,arguments:a})=>{calls.push([name,a]);if(name.endsWith('_claim')) {
      if(claimed.has(a.stage))return{structuredContent:{ready:false}};claimed.add(a.stage);
      return{structuredContent:{ready:true,opId:OP,stage:a.stage,claimId:CLAIM}};
    }return{structuredContent:{recorded:true}};}};
  const options={readManifest:async()=>({contents:JSON.stringify({version,entries:[entry]})}),native,getClient:()=>client,
    hasDraft:()=>draft,now:()=>1,setTimer:()=>1,clearTimer(){},onStatus:s=>statuses.push(s)};
  return{entry,state,native,calls,statuses,client,create:()=>createClaudeLocalStartRuntime(options)};
}
async function run(f){const r=f.create();r.start();await flush();r.stop();}
test('folderless prewarm has a durable claim and no input, SDK seed, provider or trust override',async()=>{
  const f=fixture();await run(f);
  const call=f.calls.find(x=>x[0]==='prewarm');assert.deepEqual(call[1],{cwd:'',message:'',useWorktree:false});
  assert.deepEqual(f.calls.find(x=>x[0]==='claudex_local_start_claim')[1].proof,{options:call[1]});
  assert.ok(f.calls.findIndex(x=>x[0]==='claudex_local_start_claim')<f.calls.indexOf(call));
  assert.equal(f.calls.find(x=>x[0]==='claudex_local_start_receipt')[1].outcome,'returned');
  assert.ok(f.statuses.includes('prewarm-returned'));assert.equal(f.calls.filter(x=>['start','move'].includes(x[0])).length,0);
});
test('start claims the exact prewarm only after unique live catalogue and sends only fixed bootstrap',async()=>{
  const f=fixture({stage:'start'});await run(f);
  const start=f.calls.find(x=>x[0]==='start')[1];
  assert.deepEqual(start,{sessionId:UI,cwd:'/fixture/scratch',useWorktree:false,title:'Fixture',message:`/claudex-bootstrap ${OP} ${CLAIM}`});
  assert.equal(f.calls.filter(x=>x[0]==='catalogue').length,2);
  assert.ok(!JSON.stringify(f.calls).includes('history packet'));
});
test('missing, duplicate and unavailable bootstrap catalogues never claim or send input',async()=>{
  for(const commands of [[],[{name:'claudex-bootstrap'},{name:'claudex-bootstrap'}],null]){
    const f=fixture({stage:'start',commands});await run(f);
    assert.equal(f.calls.filter(x=>x[0]==='start'||x[0].endsWith('_claim')).length,0);
  }
});
test('each unknown native action remains single-use across renderer restart',async()=>{
  for(const stage of ['prewarm','start','move']){
    const f=fixture({stage,fail:stage});await run(f);await run(f);
    assert.equal(f.calls.filter(x=>x[0]===stage).length,1);
    assert.equal(f.calls.find(x=>x[0]==='claudex_local_start_receipt')[1].outcome,'unknown');
  }
});
test('cwd move uses exact Local identity and trust=false; needs_trust never retries',async()=>{
  const f=fixture({stage:'move',fail:'trust'});await run(f);await run(f);
  assert.deepEqual(f.calls.find(x=>x[0]==='move')[1],[UI,'/fixture/project',false]);
  assert.equal(f.calls.filter(x=>x[0]==='move').length,1);
  assert.ok(f.statuses.includes('move-needs_trust'));
});
test('composer draft, disconnected or borrowed client and busy native state never dispatch',async()=>{
  for(const options of [{draft:true},{connected:false}]){
    const f=fixture(options);await run(f);assert.equal(f.calls.length,0);
  }
  for(const key of ['turnRunning','heldInput','hasBackgroundWork','pendingCwdTrustPrompt']){
    const f=fixture({stage:'move'});f.state[key]=true;await run(f);
    assert.equal(f.calls.filter(x=>x[0]==='move'||x[0].endsWith('_claim')).length,0);
  }
});
test('catalogue removed after claim consumes rejected receipt without model fallback',async()=>{
  const f=fixture({stage:'start'});let n=0;
  f.native.getSupportedCommands=async()=>++n===1?[{name:'claudex-bootstrap'}]:[];
  await run(f);assert.equal(f.calls.filter(x=>x[0]==='start').length,0);
  assert.equal(f.calls.find(x=>x[0]==='claudex_local_start_receipt')[1].outcome,'rejected');
});

test('native-start constructor or start failure leaves the existing owner bootstrap working',async()=>{
  const source=await readFile(new URL('../crates/claudex-app/src/frontend_runtime.rs',import.meta.url),'utf8');
  const owner=source.slice(source.indexOf('pub fn owner('));
  const start=owner.indexOf('const __cldxOwnerWake='), end=owner.indexOf('"#;',start);
  assert.ok(start>=0&&end>start);
  const template=owner.slice(start,end);
  for(const fail of ['constructor','start']){
    const script=template.replace('@RUNTIME@',`function createClaudeOwnerWakeRuntime(){return{start(){globalThis.started++},stop(){},signal(){globalThis.signals++}}}`)
      .replace('@LOCAL_SYNC@',fail==='constructor'?`function createClaudeLocalStartRuntime(){throw Error('synthetic constructor')}`
        :`function createClaudeLocalStartRuntime(){return{start(){throw Error('synthetic start')},stop(){}}}`)
      .replaceAll('@ROOT@',JSON.stringify('/fixture/state')).replaceAll('@ASSET@',JSON.stringify('fixture.js'));
    const context={started:0,signals:0,__cldxOwnerWakeClient(){},console:{warn(){}},window:{addEventListener(){}}};
    vm.runInNewContext(`${script};__cldxOwnerWake.signal('synthetic','selection','bridge');`,context);
    assert.equal(context.started,1);assert.equal(context.signals,1);
  }
});

test('v1 manifests cannot authorize the corrected runtime',async()=>{
  const f=fixture({version:1});await run(f);assert.equal(f.calls.length,0);
});
test('required message schema rejects legacy options before implementation',async()=>{
  let implementations=0;
  const f=fixture();
  f.native.prewarmFolderless=async options=>{
    // Pure reproduction of the reviewed unconditional IPC argument guard.
    if(!options||typeof options!=='object'||typeof options.cwd!=='string'||typeof options.message!=='string')throw Error('Argument info failed validation');
    implementations++;return f.entry.prewarm;
  };
  await assert.rejects(f.native.prewarmFolderless({cwd:'',useWorktree:false}));
  assert.equal(implementations,0);await run(f);assert.equal(implementations,1);
  assert.equal(f.calls.find(x=>x[0]==='claudex_local_start_receipt')[1].outcome,'returned');
});

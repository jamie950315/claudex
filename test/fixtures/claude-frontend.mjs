import { createHash, randomBytes } from 'node:crypto';
import { crc32, zstdCompressSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FRONTEND_ASSET_ROOT, claudeCacheDirectory } from '../../src/claude-frontend-graph.mjs';

export function frontendBuild(tag = 'a', memoSize = 11, { variants = false, shared = false, split = false } = {}) {
  const names = { entry: `index-${tag}.js`, native: `native-${tag}.js`, react: `vendor-${tag}.js`, client: `mcp-${tag}.js`,
    folders: `sidebar-${tag}.js`, chatWake: `actions-${tag}.js`, ownerWake: `code-${tag}.js` };
  const nativeImport = `import{Native${tag} as L${tag}}from"./${names.native}";`;
  const native = `var A${tag}=globalThis["claude.web"]?.LocalSessions,B${tag}=globalThis["claude.web"]?.LocalAgentModeSessions;export{A${tag} as Native${tag},B${tag} as Agent${tag}};`;
  const react = `var R${tag}={};var E${tag}=R${tag}.useEffect,S${tag}=R${tag}.useSyncExternalStore,U${tag}=R${tag}.useMemo;var getters${tag}={useEffect:()=>E${tag},useSyncExternalStore:()=>S${tag},useMemo:()=>U${tag}};export{E${tag} as Effect${tag},S${tag} as Subscribe${tag},U${tag} as Memo${tag}};`;
  const client = `var M${tag}={};function lookup${tag}(e){let s=M${tag}.getState();for(let[,{uuid:u,client:c}]of Object.entries(s.localClients))if(u===e)return c}export{lookup${tag} as Client${tag}};`;
  let folders = nativeImport + `import{Subscribe${tag} as sub${tag},Memo${tag} as useMemo${tag}}from"./${names.react}";`
    + `function key${tag}(e){if(e.isScratchWorkspace)return;let t=e.repoInfo;if(t)return e.type==="local"?e.cwd:e.type==="bridge"&&e.environmentId?e.environmentId+":"+t.name:t.name}`
    + `var empty${tag}=[];function group${tag}(rows${tag},t,n){let cache${tag}=memo${tag}(${memoSize}),sort${tag}=t===void 0?"recent":t,a=n===void 0?empty${tag}:n,{data:o}=data${tag}(),env${tag}=o?.environments,order${tag}=Array.isArray(a)?a:empty${tag},out${tag};`
    + `if(cache${tag}[0]!==env${tag}||cache${tag}[1]!==order${tag}||cache${tag}[2]!==rows${tag}||cache${tag}[3]!==sort${tag}){let map=new Map;for(let row${tag} of rows${tag}){let k${tag}=key${tag}(row${tag});if(!k${tag})continue;let running=row${tag}.sessionStatus==="running",stamp=new Date(row${tag}.timestamp).getTime(),repo=row${tag}.repoInfo;map.set(k${tag},{name:repo?.name??k${tag},hasActive:running,latestTimestamp:stamp})}out${tag}=[];for(let[k,e]of map)out${tag}.push({key:k,name:e.name,hasActiveSessions:e.hasActive,disambiguationText:null,latestTimestamp:e.latestTimestamp});cache${tag}[0]=env${tag},cache${tag}[1]=order${tag},cache${tag}[2]=rows${tag},cache${tag}[3]=sort${tag},cache${tag}[4]=out${tag}}else out${tag}=cache${tag}[4];return out${tag}}`;
  const chatWake = nativeImport + `function actions${tag}(){let enabled=L${tag}?.forkSession!==void 0;shortcut("amber_tributary_lantern_overview_toggle");return enabled?"reopenClosed":null}`;
  let ownerWake = `import{Effect${tag} as effect${tag}}from"./${names.react}";import{Client${tag}}from"./${names.client}";`
    + `function view${tag}(e){let{initialSessionId:s,sessionType:type}=e;let ref${tag}=s?{id:s,type}:null,id${tag}=ref${tag}?.id??null,reader${tag};reader${tag}=()=>ref${tag};let current${tag}=event${tag}(reader${tag}),send${tag};send${tag}=async(text,options)=>{if(options?.blocked)return "blocked";await images.waitForImagesReady();let selected${tag}=current${tag}();return nativeSend(text,options,selected${tag})};let dispatch${tag}=event${tag}(send${tag});return{submitMessage:e=>void dispatch${tag}(e),getComposerSnapshot:()=>({}),dispatch:dispatch${tag}}}`;
  if (variants) {
    folders = folders.replace(`function group${tag}(`, `var group${tag}=compilerBuild?function(`)
      + `:function(rows${tag},t,n){return useMemo${tag}(()=>{let map=new Map;for(let row${tag} of rows${tag}){let k${tag}=key${tag}(row${tag}),repo=row${tag}.repoInfo;if(!k${tag})continue;map.set(k${tag},{name:repo?.name??k${tag},hasActive:row${tag}.sessionStatus==="running",latestTimestamp:row${tag}.timestamp})}let out=[];for(let[k,e]of map)out.push({key:k,name:e.name,hasActiveSessions:e.hasActive,disambiguationText:null,latestTimestamp:e.latestTimestamp});return out},[rows${tag},t,n])};`;
    ownerWake = ownerWake.replace(`function view${tag}(e){`, `var view${tag}=compilerBuild?function(e){`)
      + `:function(e){let{initialSessionId:s,sessionType:type}=e;let ref${tag}=s?{id:s,type}:null,id${tag}=ref${tag}?.id??null;let current${tag}=event${tag}(()=>ref${tag});let dispatch${tag}=event${tag}(async(text,options)=>{if(options?.blocked)return "blocked";await images.waitForImagesReady();let selected${tag}=current${tag}();return nativeSend(text,options,selected${tag})});return{submitMessage:e=>void dispatch${tag}(e),getComposerSnapshot:()=>({}),dispatch:dispatch${tag}}};`;
  }
  if (shared) { names.chatWake = names.folders; folders += chatWake.replace(nativeImport, ''); }
  let consumer;
  if (split) {
    names.consumer = `sidebar-view-${tag}.js`;
    folders = folders.slice(0, folders.indexOf(`var empty${tag}=[];`))
      + `var empty${tag}=[];function group${tag}(rows${tag},env,sort="recent",order=empty${tag}){let map=new Map;for(let row${tag} of rows${tag}){let k${tag}=key${tag}(row${tag}),repo=row${tag}.repoInfo;if(!k${tag})continue;map.set(k${tag},{name:repo?.name??k${tag},hasActive:row${tag}.sessionStatus==="running",latestTimestamp:row${tag}.timestamp})}let out=[];for(let[k,e]of map)out.push({key:k,name:e.name,hasActiveSessions:e.hasActive,disambiguationText:null,latestTimestamp:e.latestTimestamp});return out}export{group${tag} as Group,key${tag} as Key};`;
    consumer = `import{Group as group${tag},Key as key${tag}}from"./${names.folders}";import{Subscribe${tag} as sub${tag}}from"./${names.react}";`
      + `function section${tag}(rows,env,sort,order){let cache=memo${tag}(${memoSize}),out,before,after;if(cache[5]!==rows){before=[];for(let row of rows)before.push(key${tag}(row));cache[5]=rows;cache[6]=before}else before=cache[6];cache[0]!==rows||cache[1]!==env||cache[2]!==sort||cache[3]!==order?(out=group${tag}(rows,env,sort,order),cache[0]=rows,cache[1]=env,cache[2]=sort,cache[3]=order,cache[4]=out):out=cache[4];if(cache[7]!==rows){after=[];for(let row of rows)after.push(key${tag}(row));cache[7]=rows;cache[8]=after}else after=cache[8];captureKeys(before,after);return out}`;
  }
  const entry = [...new Set(Object.values(names).filter(f => f !== names.entry))].map(f => `import"./${f}";`).join('') + 'document.getElementById("root");';
  const sources = { entry, native, react, client, folders, chatWake: shared ? folders : chatWake, ownerWake, ...(split ? { consumer } : {}) };
  return { names, sources, tag };
}
export function cacheBytes(url, source, fetchedAt) {
  // Incompressible static filler keeps response length fields at the same
  // width as the real chunks after our bounded runtime injection.
  source += `\nconst staticFixture=${JSON.stringify(randomBytes(16000).toString('hex'))};`;
  const key = Buffer.from('1/0/' + url), body = zstdCompressSync(Buffer.from(source));
  const header = Buffer.alloc(24); header.writeBigUInt64LE(0xfcfb6d1ba7725c30n); header.writeUInt32LE(5, 8); header.writeUInt32LE(key.length, 12);
  const headers = Buffer.from(`HTTP/1.1 200 OK\0content-length:${body.length}\0x-goog-stored-content-length:${body.length}\0unrelated:preserved\0`);
  const prefix = Buffer.alloc(36); prefix.writeUInt32LE(prefix.length + headers.length - 4, 0); prefix.writeUInt32LE(0x82476d03, 4); prefix.writeUInt32LE(6, 8);
  const time = 11644473600000000n + BigInt(fetchedAt) * 1000n;
  for (const at of [12, 20, 28]) prefix.writeBigInt64LE(time, at);
  const metadata = Buffer.concat([prefix, headers]);
  const footer = (flags, data, size) => { const b=Buffer.alloc(24);b.writeBigUInt64LE(0xf4fa6f45970d41d8n);b.writeUInt32LE(flags,8);b.writeUInt32LE(crc32(data),12);b.writeBigUInt64LE(BigInt(size),16);return b; };
  return Buffer.concat([header,key,body,footer(1,body,0),metadata,createHash('sha256').update(key).digest(),footer(3,metadata,metadata.length)]);
}
export async function writeFrontend(home, build, fetchedAt = Date.now() - 10000) {
  const directory = claudeCacheDirectory(home); await mkdir(directory, { recursive: true, mode: 0o700 });
  const resources = {};
  for (const [kind, name] of Object.entries(build.names)) {
    const url = FRONTEND_ASSET_ROOT + name, filename = createHash('sha256').update(url).digest('hex').slice(0,16) + '_0',path=join(directory,filename);
    const existing = Object.values(resources).find(r => r.url === url);
    if (existing) { resources[kind] = existing; continue; }
    const bytes = cacheBytes(url, build.sources[kind], fetchedAt);await writeFile(path,bytes,{mode:0o600});resources[kind]={path,bytes,url,filename};
  }
  return resources;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { frontendBuild, writeFrontend } from './fixtures/claude-frontend.mjs';
import { ownerPatchContract } from './fixtures/claude-frontend-contracts.mjs';
import { discoverClaudeFrontend } from '../src/claude-frontend-graph.mjs';
import { ensureClaudeRendererAdapters } from '../src/claude-renderer-adapters.mjs';
import { buildClaudeOwnerWakeSource } from '../src/claude-owner-wake-cache.mjs';

async function fixture(t, build) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-owner-search-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state'), home = join(base, 'home');
  await mkdir(root, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const resources = await writeFrontend(home, build);
  return { root, home, resources };
}
function barrels(build) {
  const { names, sources } = build;
  names.hooks = 'hooks-a.js'; names.clients = 'clients-a.js'; names.clientForward = 'client-forward-a.js';
  sources.hooks = `export{Effecta}from"./${names.react}";`;
  sources.clients = `import{Clienta as forward}from"./${names.client}";export{forward as Clienta};`;
  sources.clientForward = `export*from"./${names.clients}";`;
  sources.ownerWake = sources.ownerWake.replace(`./${names.react}`, `./${names.hooks}`).replace(`./${names.client}`, `./${names.clientForward}`);
  sources.entry += `import"./${names.hooks}";import"./${names.clientForward}";`;
  return build;
}
function retainedRefBuild() {
  const build = frontendBuild();
  build.sources.react += 'var Ref=Ra.useRef;var refGetter={useRef:()=>Ref};export{Ref as RefHook};';
  build.sources.ownerWake = build.sources.ownerWake
    .replace('Effecta as effecta', 'Effecta as effecta,RefHook as useRefa')
    .replace('readera=()=>refa;let currenta=eventa(readera),senda;',
      'let retaineda=useRefa(refa);effecta(()=>{retaineda.current=refa},[refa]);let senda;')
    .replace('selecteda=currenta()', 'selecteda=retaineda.current');
  return build;
}

test('retained React refs require the exact native selection mirror and preserve current send reads', async t => {
  const f = await fixture(t, retainedRefBuild()), graph = await discoverClaudeFrontend(f), matched = graph.adapters.ownerWake;
  assert.equal(matched.status, 'matched', matched.reason);
  assert.equal(matched.bindings.retainedRef, 'retaineda');
  const source = buildClaudeOwnerWakeSource(matched.target.source, { root: f.root, bindings: matched.bindings,
    runtimeSource: 'export function createClaudeOwnerWakeRuntime(){return{start(){},stop(){},signal(...args){capture(args)}}}' });
  ownerPatchContract(source, matched.target.source, matched.bindings);
  const effects = [], signals = [], retained = { current: null }, context = {
    useRefa: ref => { if (!retained.current) retained.current = ref; return retained; },
    eventa: callback => callback, effecta: callback => effects.push(callback),
    __cldxOwnerWakeClient() {}, capture: args => signals.push(args), window: { addEventListener() {} }, console: { warn() {} },
    images: { async waitForImagesReady() {} }, nativeSend: (text, options, ref) => ({ text, options, ref }) };
  runInNewContext(source.replace(/import[^;]+;/g, '') + ';globalThis.viewa=viewa;', context);
  const first = context.viewa({ initialSessionId: 'session_first', sessionType: 'bridge' }); effects.splice(0).forEach(cb => cb());
  assert.equal(await first.dispatch('blocked', { blocked: true }), 'blocked');
  context.viewa({ initialSessionId: 'session_next', sessionType: 'bridge' }); effects.splice(0).forEach(cb => cb());
  const input = { original: true }, options = { native: true }, sent = await first.dispatch(input, options);
  assert.equal(sent.text, input); assert.equal(sent.options, options); assert.equal(sent.ref.id, 'session_next');
  assert.deepEqual(JSON.parse(JSON.stringify(signals)), [
    ['session_first', 'selection', 'bridge'], ['session_first', 'submit', 'bridge'],
    ['session_next', 'selection', 'bridge'], ['session_next', 'submit', 'bridge'],
  ]);
  assert.equal((await ensureClaudeRendererAdapters({ ...f, graph })).adapters.ownerWake.status, 'installed');
});

test('retained ref discovery refuses changed seeds, mirrors, readers, escaped refs and shadows', async t => {
  for (const change of [
    s => s.replace('useRefa(refa)', 'useRefa(other)'),
    s => s.replace('retaineda.current=refa', 'retaineda.current=other'),
    s => s.replace('[refa]', '[other]'),
    s => s.replace('let senda;', 'retaineda.current=other;let senda;'),
    s => s.replace('let senda;', 'escape(retaineda);let senda;'),
    s => s.replace('selecteda=retaineda.current', 'selecteda=other.current'),
    s => s.replace('function viewa(e){', 'function viewa(e){let useRefa=other;'),
    s => s.replace('effecta(()=>{retaineda.current=refa}', 'effecta(()=>{dispatch();retaineda.current=refa}'),
  ]) {
    const build = retainedRefBuild(); build.sources.ownerWake = change(build.sources.ownerWake);
    const f = await fixture(t, build), result = await ensureClaudeRendererAdapters(f);
    assert.equal(result.adapters.ownerWake.status, 'skipped');
    assert.deepEqual(await readFile(f.resources.ownerWake.path), f.resources.ownerWake.bytes);
  }
});

test('semantic discovery survives compiler forms, callback aliases, export forwarding and neighbouring lookalikes', async t => {
  const build = barrels(frontendBuild());
  const decoy = build.sources.ownerWake.replace('()=>refa', '()=>unrelated').replace('function viewa(e)', 'function decoy(e)');
  build.sources.ownerWake = build.sources.ownerWake
    .replace('function viewa(e)', 'export const viewa=(e)=>')
    .replace('refa?.id??null', 'refa&&refa.id')
    .replace('readera=()=>refa;let currenta=eventa(readera)', 'readera=function(){return refa};const readerAlias=readera;let currenta=eventa(readerAlias)')
    .replace('senda=async(text,options)=>', 'senda=async function(text,options)')
    .replace('let dispatcha=eventa(senda)', 'const sendAlias=senda;let dispatcha=eventa(sendAlias)') + ';' + decoy.slice(decoy.indexOf('function decoy'));
  build.names.decoy = 'neighbour-a.js'; build.sources.decoy = decoy; build.sources.entry += 'import"./neighbour-a.js";';
  const f = await fixture(t, build), graph = await discoverClaudeFrontend(f), matched = graph.adapters.ownerWake;
  assert.equal(matched.status, 'matched', matched.reason);
  assert.deepEqual(matched.bindings.search, { method: 'bounded-semantic-bindings', componentCandidates: 2, provenComponents: 1, moduleCandidates: 2 });
  assert.equal(matched.bindings.client.path, './client-forward-a.js');
  const source = buildClaudeOwnerWakeSource(matched.target.source, { root: f.root, bindings: matched.bindings,
    runtimeSource: 'export function createClaudeOwnerWakeRuntime(){return{start(){},stop(){},signal(...args){capture(args)}}}' });
  ownerPatchContract(source, matched.target.source, matched.bindings);
  const effects = [], signals = [], context = { eventa: callback => callback, effecta: callback => effects.push(callback),
    __cldxOwnerWakeClient() {}, capture: args => signals.push(args), window: { addEventListener() {} }, console: { warn() {} },
    images: { async waitForImagesReady() {} }, nativeSend: (text, options, ref) => ({ text, options, ref }) };
  runInNewContext(source.replace(/import[^;]+;/g, '').replace('export const viewa=', 'globalThis.viewa='), context);
  const view = context.viewa({ initialSessionId: 'session_owned', sessionType: 'bridge' }); effects[0]();
  const input = { original: true }, options = { blocked: true };
  assert.equal(await view.dispatch(input, options), 'blocked');
  assert.deepEqual(JSON.parse(JSON.stringify(signals)), [['session_owned', 'selection', 'bridge'], ['session_owned', 'submit', 'bridge']]);
  const sent = await view.dispatch(input, {}); assert.equal(sent.text, input); assert.equal(sent.ref.id, 'session_owned');
  const installed = await ensureClaudeRendererAdapters({ ...f, graph });
  assert.equal(installed.adapters.ownerWake.status, 'installed');
  assert.deepEqual(installed.adapters.ownerWake.search, matched.bindings.search);
});

test('two fully proven modules remain ambiguous and neither is changed', async t => {
  const build = frontendBuild(); build.names.other = 'other-a.js'; build.sources.other = build.sources.ownerWake;
  build.sources.entry += 'import"./other-a.js";';
  const f = await fixture(t, build), result = await ensureClaudeRendererAdapters(f);
  assert.equal(result.adapters.ownerWake.status, 'skipped'); assert.match(result.adapters.ownerWake.reason, /target module missing or ambiguous/);
  for (const key of ['ownerWake', 'other']) assert.deepEqual(await readFile(f.resources[key].path), f.resources[key].bytes);
});

test('the exact attached lookup may be exported by an imported module without being a native component import', async t => {
  const build = frontendBuild();
  build.sources.client += 'function other(){}export{other as Othera};';
  build.sources.ownerWake = build.sources.ownerWake.replace('import{Clienta}', 'import{Othera}');
  const f = await fixture(t, build), graph = await discoverClaudeFrontend(f);
  assert.equal(graph.adapters.ownerWake.status, 'matched', graph.adapters.ownerWake.reason);
  assert.deepEqual(graph.adapters.ownerWake.bindings.client, { path: './mcp-a.js', exported: 'Clienta' });
});

test('memo discovery verifies helper return provenance instead of choosing an arrow by its position', async t => {
  for (const change of [
    s => s.replace('function inner(c,i,v,d){return c[i]=d,c[i+1]=v,v}', 'function inner(c,i,v,d){return c[i]=d,c[i+1]=v,d}'),
    s => s.replace('function inner(c,i,v,d){return c[i]=d,c[i+1]=v,v}', 'function inner(c,i,v,d){dispatch(v);return v}'),
    s => s.replace('function inner(c,i,v,d){return c[i]=d,c[i+1]=v,v}', ''),
  ]) {
    const build = frontendBuild('a', 11, { helpers: true }); build.sources.ownerWake = change(build.sources.ownerWake);
    const f = await fixture(t, build), result = await ensureClaudeRendererAdapters(f);
    assert.equal(result.adapters.ownerWake.status, 'skipped');
    assert.match(result.adapters.ownerWake.reason, /Code retained send callback/);
    assert.deepEqual(await readFile(f.resources.ownerWake.path), f.resources.ownerWake.bytes);
  }
});

test('variadic compiler stores are traced from their real finite memo loop and return expression', async t => {
  const build = frontendBuild('a', 11, { helpers: true });
  build.sources.ownerWake = build.sources.ownerWake
    .replace('function store1(c,i,d,v){return c[i]=d,c[i+1]=v,v}', 'function store1(c,i,...values){for(let n=0;n<values.length;n++)c[i+n]=values[n];return values[values.length-1]}')
    .replace('function inner(c,i,v,d){return c[i]=d,c[i+1]=v,v}', 'function inner(c,i,v,...deps){for(let n=0;n<deps.length;n++)c[i+n]=deps[n];return v}');
  const f = await fixture(t, build), graph = await discoverClaudeFrontend(f);
  assert.equal(graph.adapters.ownerWake.status, 'matched', graph.adapters.ownerWake.reason);
  const changed = frontendBuild('b', 11, { helpers: true });
  changed.sources.ownerWake = changed.sources.ownerWake.replace('function store1(c,i,d,v){return c[i]=d,c[i+1]=v,v}',
    'function store1(c,i,...values){for(let n=0;n<other.length;n++)c[i+n]=values[n];return values[values.length-1]}');
  await writeFrontend(f.home, changed, Date.now());
  const refused = await discoverClaudeFrontend(f); assert.equal(refused.adapters.ownerWake.status, 'skipped');
});

test('inline compiler branches require the exact callback slot and complete dependency stores', async t => {
  const make = () => {
    const build = frontendBuild();
    build.sources.ownerWake = build.sources.ownerWake
      .replace('readera=()=>refa;', 'Ma[0]===refa?readera=Ma[1]:(readera=()=>refa,Ma[0]=refa,Ma[1]=readera);')
      .replace('senda=async(text,options)=>', 'Ma[2]!==refa?(senda=async(text,options)=>')
      .replace('return nativeSend(text,options,selecteda)};', 'return nativeSend(text,options,selecteda)},Ma[2]=refa,Ma[3]=senda):senda=Ma[3];');
    return build;
  };
  const f = await fixture(t, make()), graph = await discoverClaudeFrontend(f);
  assert.equal(graph.adapters.ownerWake.status, 'matched', graph.adapters.ownerWake.reason);
  const source = buildClaudeOwnerWakeSource(graph.adapters.ownerWake.target.source, { root: f.root, bindings: graph.adapters.ownerWake.bindings,
    runtimeSource: 'export function createClaudeOwnerWakeRuntime(){return{start(){},stop(){},signal(){}}}' });
  ownerPatchContract(source, graph.adapters.ownerWake.target.source, graph.adapters.ownerWake.bindings);
  for (const change of [
    s => s.replace('senda=Ma[3]', 'senda=Ma[4]'),
    s => s.replace('Ma[2]=refa', 'Ma[2]=other'),
    s => s.replace('Ma[3]=senda', 'Ma[3]=other'),
    s => s.replace('Ma[2]=refa,', 'dispatch(),Ma[2]=refa,'),
  ]) {
    const build = make(); build.sources.ownerWake = change(build.sources.ownerWake);
    const isolated = await fixture(t, build), result = await ensureClaudeRendererAdapters(isolated);
    assert.equal(result.adapters.ownerWake.status, 'skipped');
    assert.deepEqual(await readFile(isolated.resources.ownerWake.path), isolated.resources.ownerWake.bytes);
  }
});

test('cycles, changing aliases and lexical shadows cannot certify the current native send reference', async t => {
  for (const change of [
    s => s.replace('readera=()=>refa;', 'readera=readerAlias;let readerAlias=readera;'),
    s => s.replace('readera=()=>refa;', 'readera=()=>refa;readera=()=>other;'),
    s => s.replace('readera=()=>refa;', 'function nested(){let readera=()=>refa}'),
  ]) {
    const build = frontendBuild(); build.sources.ownerWake = change(build.sources.ownerWake);
    const f = await fixture(t, build), result = await ensureClaudeRendererAdapters(f);
    assert.equal(result.adapters.ownerWake.status, 'skipped');
    assert.deepEqual(await readFile(f.resources.ownerWake.path), f.resources.ownerWake.bytes);
  }
  const build = barrels(frontendBuild()); build.sources.clients = 'export{Clienta}from"./client-forward-a.js";';
  const f = await fixture(t, build), result = await ensureClaudeRendererAdapters(f);
  assert.equal(result.adapters.ownerWake.status, 'skipped'); assert.match(result.adapters.ownerWake.reason, /attached stdio/);
  assert.deepEqual(await readFile(f.resources.ownerWake.path), f.resources.ownerWake.bytes);
});

test('component bindings cannot shadow a proved module helper or effect import', async t => {
  for (const declaration of ['let store1=()=>other;', 'let effecta=()=>other;', 'let{value:inner}=other;']) {
    const build = frontendBuild('a', 11, { helpers: true });
    build.sources.ownerWake = build.sources.ownerWake.replace('function viewa(e){', `function viewa(e){${declaration}`);
    const f = await fixture(t, build), result = await ensureClaudeRendererAdapters(f);
    assert.equal(result.adapters.ownerWake.status, 'skipped');
    assert.deepEqual(await readFile(f.resources.ownerWake.path), f.resources.ownerWake.bytes);
  }
});

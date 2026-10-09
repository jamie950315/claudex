import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { frontendBuild } from './fixtures/claude-frontend.mjs';
import { ownerAnchors, transformAnchoredOwner, syntax } from '../src/claude-frontend-anchors.mjs';

// Differential mutation testing of the owner-wake proof. Each mutant inserts
// one binding form for one name at one place in a synthetic Code component.
// Whenever the anchors still accept the mutant, the patched module must behave
// exactly like the unpatched mutant, and its signals must never name a session
// other than one the native send could have used. Refusing is always allowed.
const BASE = 'https://assets.invalid/v1/';
function bases() {
  const retained = frontendBuild();
  retained.sources.react += 'var Ref=Ra.useRef;var refGetter={useRef:()=>Ref};export{Ref as RefHook};';
  retained.sources.ownerWake = retained.sources.ownerWake
    .replace('Effecta as effecta', 'Effecta as effecta,RefHook as useRefa')
    .replace('readera=()=>refa;let currenta=eventa(readera),senda;',
      'let retaineda=useRefa(refa);effecta(()=>{retaineda.current=refa},[refa]);let senda;')
    .replace('selecteda=currenta()', 'selecteda=retaineda.current');
  return { getter: frontendBuild(), retained, helpers: frontendBuild('a', 11, { helpers: true }) };
}
const NAMES = ['refa', 'ida', 'readera', 'currenta', 'senda', 'dispatcha', 'selecteda', 'retaineda', 'effecta', 'useRefa', 'eventa',
  's', 'type', 'text', 'options', 'Ma', 'e'];
const FORMS = [n => `let ${n}=other;`, n => `var ${n};`, n => `var ${n}=other;`, n => `{const ${n}=other;use(${n})}`, n => `${n}=other;`,
  n => `escape(${n});`, n => `[${n}]=list;`, n => `({${n}}=bag);`, n => `try{throw other}catch(${n}){use(${n})}`,
  n => `for(const ${n} of list)use(${n});`, n => `later(()=>{${n}=other});`, n => `later(function(${n}){use(${n})});`,
  n => `{function ${n}(){}}`, n => `bag.${n}=1;`, n => `if(flag){var ${n}}`, n => `later(()=>${n});`];
const USES = [n => `escape(${n});`, n => `later(()=>${n});`, n => `${n}=other;`, n => `bag.x=${n};`];
const HIDES = [n => `let ${n}=other;`, n => `var ${n}=other;`, n => `{const ${n}=other;use(${n})}`, n => `for(const ${n} of list)use(${n});`];
// [text to find, insert before (false) or after (true)]
const PLACES = [['function viewa(e){', true], ['let dispatcha=', false], ['async(text,options)=>{', true],
  ['await images.waitForImagesReady();', true], ['return nativeSend(', false]];

const decoy = () => Object.assign(async () => 'decoy-send', { id: 'decoy', type: 'decoy', current: { id: 'decoy', type: 'decoy' } });
async function behave(source) {
  const signals = [], effects = [], slots = []; let slot = 0;
  const other = decoy(), context = { other, list: [other], bag: {}, flag: false, use() {}, escape() {},
    later: fn => { try { fn(other); } catch {} }, Ma: [], changed1: (cache, index, value) => cache[index] !== value,
    eventa: callback => callback,
    images: { async waitForImagesReady() {} }, nativeSend: (text, options, ref) => ({ text, id: ref?.id, type: ref?.type }),
    __cldxSignals: signals, console: { warn() {} } };
  // Vendor chunks are modules: strict code whose imports cannot be reassigned.
  for (const [name, value] of Object.entries({ effecta: callback => { effects.push(callback); }, useRefa: value => slots[slot++] ??= { current: value } }))
    Object.defineProperty(context, name, { value, writable: false, enumerable: true });
  const outcome = {};
  try {
    runInNewContext('"use strict";' + source.replace(/import[^;]+;/g, '') + ';globalThis.viewa=viewa;', context);
    const render = id => { slot = 0; const view = context.viewa({ initialSessionId: id, sessionType: 'bridge' });
      for (const effect of effects.splice(0)) effect(); return view; };
    const first = render('session_first'); render('session_next');
    try { outcome.sent = JSON.parse(JSON.stringify(await first.dispatch('text', {}) ?? null)); }
    catch (error) { outcome.sendError = String(error?.message ?? error); }
  } catch (error) { outcome.renderError = String(error?.message ?? error); }
  return { outcome, signals };
}
const bootstrap = ';const __cldxOwnerWake={signal(...a){__cldxSignals.push(a)}};';

test('accepted owner-wake mutants keep native behaviour and never signal a session the send did not use', async () => {
  const counts = { mutants: 0, invalid: 0, refused: 0, accepted: 0 }, failures = [];
  for (const [kind, build] of Object.entries(bases())) {
    const modules = new Map(Object.keys(build.sources).map(key => [BASE + build.names[key], { url: BASE + build.names[key], source: build.sources[key] }]));
    const url = BASE + build.names.ownerWake, graph = { get: path => modules.get(new URL(path, url).href) };
    const original = build.sources.ownerWake;
    // The unmutated component is accepted and signals the session it sends.
    const baseline = transformAnchoredOwner(original, ownerAnchors(original, graph), bootstrap);
    assert.deepEqual((await behave(baseline)).outcome, (await behave(original)).outcome, kind);
    const position = ([marker, after]) => { const at = original.indexOf(marker);
      return at < 0 || original.indexOf(marker, at + 1) >= 0 ? -1 : after ? at + marker.length : at; };
    const mutants = [];
    for (const place of PLACES) for (const name of NAMES) for (const make of FORMS) {
      const cut = position(place); if (cut < 0) continue;
      mutants.push([`${JSON.stringify(place[0])} ${make(name)}`, original.slice(0, cut) + make(name) + original.slice(cut)]);
    }
    // Second order: a use in the component combined with a binding in the send.
    // A hidden read plus an escape once satisfied a count of three identifiers.
    for (const name of NAMES) for (const outer of PLACES.slice(0, 2)) for (const use of USES)
      for (const inner of PLACES.slice(2)) for (const hide of HIDES) {
        const first = position(outer), second = position(inner); if (first < 0 || second < 0) continue;
        mutants.push([`${JSON.stringify(outer[0])} ${use(name)} + ${JSON.stringify(inner[0])} ${hide(name)}`,
          original.slice(0, first) + use(name) + original.slice(first, second) + hide(name) + original.slice(second)]);
      }
    for (const [description, mutant] of mutants) {
      counts.mutants++;
      try { syntax(mutant); } catch { counts.invalid++; continue; }
      let bindings;
      try { bindings = ownerAnchors(mutant, graph); } catch { counts.refused++; continue; }
      counts.accepted++;
      const label = `${kind} ${description}`;
      const native = await behave(mutant), patched = await behave(transformAnchoredOwner(mutant, bindings, bootstrap));
      if (JSON.stringify(native.outcome) !== JSON.stringify(patched.outcome)) { failures.push(`${label}: native ${JSON.stringify(native.outcome)} patched ${JSON.stringify(patched.outcome)}`); continue; }
      const sent = patched.outcome.sent;
      if (!sent || typeof sent !== 'object') continue;
      const submits = patched.signals.filter(signal => signal[1] === 'submit');
      if (submits.length !== 1) failures.push(`${label}: ${submits.length} submit signals for one native send`);
      else if (submits[0][0] !== sent.id && !['session_first', 'session_next'].includes(submits[0][0]))
        failures.push(`${label}: signalled ${submits[0][0]} while native sent ${sent.id}`);
    }
  }
  assert.deepEqual(failures.slice(0, 12), [], `${failures.length} failing mutants`);
  // The generator must exercise both verdicts, or it proves nothing.
  assert.ok(counts.accepted > 1000 && counts.refused > 300, JSON.stringify(counts));
  console.log(JSON.stringify(counts));
});

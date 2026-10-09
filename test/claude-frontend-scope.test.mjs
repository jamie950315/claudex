import test from 'node:test';
import assert from 'node:assert/strict';
import { syntax, nodes } from '../src/claude-frontend-anchors.mjs';
import { analyzeScopes } from '../src/claude-frontend-scope.mjs';

const named = (root, name) => nodes(root, n => n.type === 'Identifier' && n.name === name);
function component(source) { const ast = syntax(source); return { ast, f: ast.body[0], scopes: analyzeScopes(ast.body[0]) }; }

test('references resolve to their lexical declaration, not to a shared name', () => {
  const { f, scopes } = component(`function view(p){
    let r=useRef(p);
    effect(()=>{r.current=p},[p]);
    const send=async(a)=>{ { const r=other; r.current; } try{}catch(r){r.message} for(let r of a){r.id} return r.current; };
    function inner(r){return r.current}
    const o={r:1,m(){return o.r}}; label: for(;;){break label}
    return send;
  }`);
  const outer = scopes.binding(named(f, 'r')[0]);
  assert.equal(outer.declarations[0].kind, 'let');
  // Declaration, the mirror write and the one send read that no inner binding hides.
  assert.equal(outer.identifiers.length, 3);
  assert.deepEqual(outer.identifiers.map(n => scopes.use(n)?.parent.type ?? 'declaration'),
    ['declaration', 'MemberExpression', 'MemberExpression']);
  const kinds = new Set(named(f, 'r').map(n => scopes.binding(n)).filter(Boolean).map(b => b.declarations[0].kind));
  assert.deepEqual([...kinds].sort(), ['catch', 'const', 'let', 'param']);
  // Property names, method names and labels are not references.
  assert.equal(named(f, 'r').filter(n => !scopes.binding(n)).length, 2);
  assert.equal(scopes.free('r').length, 0); assert.equal(scopes.free('label').length, 0);
  assert.ok(scopes.isFree(named(f, 'useRef')[0])); assert.ok(scopes.isFree(named(f, 'effect')[0]));
  assert.ok(scopes.same(...named(f, 'p').slice(1, 3)));
});

test('var hoists to its function while let, const, class and function stay in their block', () => {
  const { f, scopes } = component(`function view(){
    use(a,b,c,d);
    if(x){ var a=1; let b=2; class c{} function d(){} }
    return ()=>{ var e=a; return e };
  }`);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(name => named(f, name)[0]);
  assert.equal(scopes.binding(a).declarations[0].kind, 'var');
  assert.equal(scopes.binding(a).identifiers.length, 3);
  for (const node of [b, c, d]) assert.ok(scopes.isFree(node));
  assert.equal(scopes.at(f, 'a'), scopes.binding(a)); assert.equal(scopes.at(f, 'b'), null); assert.equal(scopes.at(f, 'e'), null);
});

test('patterns, defaults, named function expressions and writes are classified', () => {
  const { f, scopes } = component(`function view({a,b:[c,...d],...e},f=a){
    let g=function h(){return h}, i; ({i}=f); [g]=d; i++; for(i of e){}
    return {a,c,g,i};
  }`);
  for (const name of ['a', 'c', 'd', 'e', 'f']) assert.equal(named(f, name).map(scopes.binding).find(Boolean).declarations[0].kind, 'param', name);
  const h = named(f, 'h'); assert.equal(scopes.binding(h[0]), scopes.binding(h[1])); assert.equal(scopes.at(f, 'h'), null);
  const i = named(f, 'i').map(scopes.binding).find(Boolean);
  assert.deepEqual(i.references.map(n => `${scopes.use(n).parent.type}.${scopes.use(n).key}`),
    ['Property.value', 'UpdateExpression.argument', 'ForOfStatement.left', 'Property.value']);
  assert.equal(scopes.binding(named(f, 'b')[0]), null);
});

test('a module root declares imports and resolves names for nested owners', () => {
  const ast = syntax('import{x as y}from"./a.js";export{y as z};function f(q){{let y=q;return y}}const g=()=>y;'), scopes = analyzeScopes(ast);
  const ys = named(ast, 'y'), imported = scopes.binding(ys[0]);
  assert.equal(imported.declarations[0].kind, 'import');
  assert.equal(scopes.binding(ys[1]), imported); assert.notEqual(scopes.binding(ys[2]), imported); assert.equal(scopes.binding(ys.at(-1)), imported);
  assert.equal(scopes.at(ast.body[2], 'y'), imported);
  assert.notEqual(scopes.at(ast.body[2].body.body[0], 'y'), imported);
  assert.throws(() => scopes.at({}, 'y'), /unknown scope owner/);
});

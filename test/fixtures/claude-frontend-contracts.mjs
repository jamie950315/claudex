import assert from 'node:assert/strict';
import { syntax, nodes, member } from '../../src/claude-frontend-anchors.mjs';

// This validator parses static vendor bytes. It never evaluates a frontend
// module. Locations, raw literal spellings and harmless empty statements do
// not affect the contract; all other AST nodes remain part of the comparison.
export function astValue(value) {
  if (Array.isArray(value)) return value.filter(n => n?.type !== 'EmptyStatement').map(astValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['start', 'end', 'raw'].includes(k))
    .map(([k, v]) => [k, astValue(v)]));
}
const functionsFor = (ast, name) => {
  const body = ast.body.flatMap(n => n.type === 'ExportNamedDeclaration' && n.declaration ? [n.declaration] : [n]);
  const declared = body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  if (declared) return [declared];
  const d = body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations).find(n => n.id.name === name);
  if (!d) return [];
  if (d.init.type === 'CallExpression' && d.init.arguments.length === 1
    && ['FunctionExpression', 'ArrowFunctionExpression'].includes(d.init.arguments[0].type)) return [d.init.arguments[0]];
  return d.init.type === 'ConditionalExpression' ? [d.init.consequent, d.init.alternate] : [d.init];
};
const only = (values, label) => { assert.equal(values.length, 1, label); return values[0]; };
const isSignal = n => n.type === 'CallExpression' && member(n.callee, 'signal') && n.callee.object.name === '__cldxOwnerWake';
const expression = s => astValue(syntax(s).body[0].expression);
const squashDeclarations = f => {
  const body = [];
  for (const s of f.body.body.filter(n => n.type !== 'EmptyStatement')) {
    if (s.type === 'VariableDeclaration' && body.at(-1)?.type === s.type && body.at(-1).kind === s.kind)
      body.at(-1).declarations.push(...s.declarations);
    else body.push(s);
  }
  f.body.body = body; return astValue(f);
};

export function ownerPatchContract(source, original, b) {
  const ast = syntax(source), orig = syntax(original), patched = functionsFor(ast, b.componentBinding);
  const variants = b.variants ?? [b]; assert.equal(patched.length, variants.length);
  const contract = [];
  for (const [i, v] of variants.entries()) {
    const f = patched[i], signals = nodes(f, isSignal);
    assert.equal(signals.length, 2, 'exact selection and submit calls');
    const select = only(signals.filter(n => n.arguments[1]?.value === 'selection'), 'selection signal');
    const submit = only(signals.filter(n => n.arguments[1]?.value === 'submit'), 'submit signal');
    assert.deepEqual(astValue(select), expression(`__cldxOwnerWake.signal(${v.ref}?.id,"selection",${v.ref}?.type)`));
    assert.deepEqual(astValue(submit), expression('__cldxOwnerWake.signal(ref?.id,"submit",ref?.type)'));
    const effect = only(f.body.body.filter(n => n.type === 'ExpressionStatement'
      && n.expression.type === 'CallExpression' && n.expression.callee.name === b.effect && nodes(n, isSignal).length), 'selection effect');
    assert.deepEqual(astValue(effect.expression.arguments[1]), expression(`[${v.ref}?.id,${v.ref}?.type]`));
    f.body.body.splice(f.body.body.indexOf(effect), 1);
    const send = only(nodes(f, n => ['ArrowFunctionExpression', 'FunctionExpression'].includes(n.type) && n.async && nodes(n, isSignal).includes(submit)), 'native send');
    const first = send.body.body.shift();
    assert.equal(first.type, 'TryStatement', 'guarded submit signals before native early refusals');
    assert.deepEqual(astValue(first), astValue(syntax(`try{const ref=${v.retainedRef ? `${v.retainedRef}.current` : `${v.getter}()`};void __cldxOwnerWake.signal(ref?.id,"submit",ref?.type)}catch{}`).body[0]));
    assert.deepEqual(astValue(effect.expression.arguments[0]), expression(`()=>{try{void __cldxOwnerWake.signal(${v.ref}?.id,"selection",${v.ref}?.type)}catch{}}`), 'guarded selection effect');
    assert.deepEqual(squashDeclarations(f), squashDeclarations(functionsFor(orig, b.componentBinding)[i]), 'all native component AST retained');
    contract.push({ ref: v.ref, getter: v.getter, retainedRef: v.retainedRef, effect: b.effect });
  }
  const binding = tree => tree.body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
    .find(n => n.id.name === b.componentBinding);
  if (binding(orig)?.init.type === 'CallExpression')
    assert.deepEqual(astValue(binding(ast).init), astValue(binding(orig).init), 'all native component wrapper AST retained');
  const client = only(ast.body.filter(n => n.type === 'ImportDeclaration' && n.specifiers.some(s => s.local.name === '__cldxOwnerWakeClient')), 'attached client import');
  assert.equal(client.source.value, b.client.path); assert.equal(client.specifiers[0].imported.name, b.client.exported);
  const options = only(nodes(ast, n => n.type === 'CallExpression' && n.callee.name === 'createClaudeOwnerWakeRuntime'), 'owner runtime').arguments[0];
  assert.equal(only(options.properties.filter(p => p.key.name === 'getClient'), 'getClient').value.name, '__cldxOwnerWakeClient');
  return { variants: contract, client: b.client, options: astValue(options) };
}

export function chatPatchContract(source, original, b) {
  assert.ok(source.startsWith(original), 'all vendor source bytes retained');
  const ast = syntax(source), options = only(nodes(ast, n => n.type === 'CallExpression'
    && n.callee.name === 'createClaudeChatWakeRuntime'), 'chat runtime').arguments[0];
  assert.equal(only(options.properties.filter(p => p.key.name === 'native'), 'native binding').value.name, b.native);
  return astValue(options);
}

export function folderPatchContract(source, original, b) {
  const ast = syntax(source), orig = syntax(original);
  const key = only(ast.body.filter(n => n.type === 'FunctionDeclaration' && n.id.name === '__cldxNativeProjectKey'), 'native key');
  key.id.name = b.key.id.name;
  assert.deepEqual(astValue(key), astValue(only(orig.body.filter(n => n.type === 'FunctionDeclaration' && n.id.name === b.key.id.name), 'original key')));
  const wrapper = only(ast.body.filter(n => n !== key && n.type === 'FunctionDeclaration' && n.id.name === b.key.id.name), 'key wrapper');
  assert.deepEqual(astValue(wrapper.body.body[0].argument), expression(`__cldx.lookup(${b.key.params[0].name})?.projectKey??__cldxNativeProjectKey(${b.key.params[0].name})`));
  const variants = b.variants ?? [b], patched = functionsFor(ast, b.groupingBinding), originalVariants = functionsFor(orig, b.groupingBinding);
  assert.equal(patched.length, variants.length);
  for (const [i, v] of variants.entries()) {
    const f = patched[i];
    if (!v.pure) {
      const version = f.body.body.shift();
      assert.deepEqual(astValue(version), astValue(syntax(`const __cldxVersion=${b.subscribe}(__cldx.subscribe,__cldx.getSnapshot,__cldx.getSnapshot);`).body[0]));
    }
    const rows = f.body.body.shift();
    assert.deepEqual(astValue(rows), astValue(syntax(`__cldx.setRows(${v.rows},__cldxNativeProjectKey);`).body[0]));
    const mappedLabel = n => n.type === 'ChainExpression' && member(n.expression, 'label')
      && n.expression.object.type === 'CallExpression' && n.expression.object.callee.object?.name === '__cldx';
    const label = only(nodes(f, n => n.type === 'Property' && n.key.name === 'name' && nodes(n.value, mappedLabel).length), 'mapped label');
    const terms = n => n.type === 'LogicalExpression' && n.operator === '??' ? [...terms(n.left), ...terms(n.right)] : [n];
    assert.deepEqual(terms(label.value).map(astValue), [expression(`__cldx.lookup(${v.row})?.label`), ...terms(v.label.value).map(astValue)]);
    label.value = structuredClone(v.label.value);
    if (v.plainMemo) {
      const deps = only(nodes(f, n => n.type === 'ArrayExpression' && n.elements.some(e => e?.name === '__cldxVersion')), 'useMemo invalidation');
      assert.equal(deps.elements.pop().name, '__cldxVersion');
    } else if (!v.pure) {
      const memo = only(nodes(f.body.body[0], n => n.type === 'VariableDeclarator' && n.id.name === v.cache), 'compiled cache');
      assert.equal(memo.init.arguments[0].value, v.size + 1); memo.init.arguments[0].value = v.size;
      const condition = only(nodes(f, n => n.type === 'IfStatement' && n.test.type === 'LogicalExpression'
        && n.test.right.type === 'BinaryExpression' && n.test.right.right.name === '__cldxVersion'), 'compiled invalidation');
      assert.deepEqual(astValue(condition.test.right), expression(`${v.cache}[${v.size}]!==__cldxVersion`)); condition.test = condition.test.left;
      const writes = nodes(condition.consequent, n => n.type === 'AssignmentExpression' && n.right.name === '__cldxVersion');
      assert.equal(writes.length, 1); assert.deepEqual(astValue(writes[0].left), expression(`${v.cache}[${v.size}]`));
      for (const seq of nodes(condition.consequent, n => n.type === 'SequenceExpression')) seq.expressions = seq.expressions.filter(n => !writes.includes(n));
      condition.consequent.body = condition.consequent.body.filter(n => n.type !== 'ExpressionStatement' || !writes.includes(n.expression));
    }
    assert.deepEqual(astValue(f), astValue(originalVariants[i]), 'all native aggregation AST retained');
  }
  const opts = only(nodes(ast, n => n.type === 'CallExpression' && n.callee.name === 'createClaudeFolderRuntime'), 'folder runtime').arguments[0];
  // Only folder behavior is compared. Older monolithic bootstraps also hosted
  // chat wake; the new adapter intentionally owns that separate consumer.
  return { wrapper: astValue(wrapper), variants: variants.map(v => ({ rows: v.rows, row: v.row, size: v.size ?? null })),
    readMap: astValue(only(opts.properties.filter(p => p.key.name === 'readMap'), 'readMap').value) };
}

export function folderConsumerPatchContract(source, original, b) {
  const ast = syntax(source), originalAST = syntax(original);
  const imp = ast.body.shift();
  assert.equal(imp.type, 'ImportDeclaration'); assert.equal(imp.source.value, b.importedPath);
  assert.deepEqual(imp.specifiers.map(n => n.imported.name), ['__cldxFolderStore', '__cldxNativeProjectKey']);
  const subscription = ast.body.shift();
  assert.equal(subscription.type, 'ImportDeclaration'); assert.equal(subscription.source.value, b.subscription.path);
  assert.equal(subscription.specifiers.length, 1);
  assert.equal(subscription.specifiers[0].imported.name, b.subscription.exported);
  assert.equal(subscription.specifiers[0].local.name, '__cldxFolderSubscribe');
  const f = only(functionsFor(ast, b.component.id.name), 'consumer component');
  assert.deepEqual(astValue(f.body.body.shift()), astValue(syntax('const __cldxVersion=__cldxFolderSubscribe(__cldxFolderStore.subscribe,__cldxFolderStore.getSnapshot,__cldxFolderStore.getSnapshot);').body[0]));
  const prepare = only(f.body.body.filter(n => n.type === 'ExpressionStatement' && n.expression.callee?.object?.name === '__cldxFolderStore'), 'source rows preparation');
  assert.deepEqual(astValue(prepare.expression), expression(`__cldxFolderStore.setRows(${b.rows},__cldxNativeProjectKey)`));
  f.body.body.splice(f.body.body.indexOf(prepare), 1);
  const memo = only(nodes(f.body.body[0], n => n.type === 'VariableDeclarator' && n.id.name === b.cache), 'consumer cache');
  assert.equal(memo.init.arguments[0].value, b.size + 1); memo.init.arguments[0].value = b.size;
  const guards = nodes(f, n => ['IfStatement', 'ConditionalExpression'].includes(n.type) && n.test.right?.right?.name === '__cldxVersion');
  assert.equal(guards.length, b.guards.length);
  for (const g of guards) {
    assert.deepEqual(astValue(g.test.right), expression(`${b.cache}[${b.size}]!==__cldxVersion`));
    g.test = g.test.left;
  }
  const footer = f.body.body.splice(-2, 1)[0];
  assert.deepEqual(astValue(footer.expression), expression(`${b.cache}[${b.size}]=__cldxVersion`));
  assert.deepEqual(astValue(ast), astValue(originalAST), 'all native consumer AST retained');
}

export function commandCatalogPatchContract(source, original, b) {
  const ast = syntax(source), orig = syntax(original);
  const helper = ast.body.pop();
  assert.equal(helper.type, 'FunctionDeclaration'); assert.equal(helper.id.name, '__cldxCommandCatalog');
  const fn = only(nodes(ast, n => n.type === b.fn.type && n.start === b.fn.start), 'catalogue query');
  const call = fn.body.body[0].argument;
  assert.equal(call.callee.name, '__cldxCommandCatalog'); assert.equal(call.arguments.length, 2);
  assert.equal(call.arguments[0].type, 'AwaitExpression'); assert.equal(call.arguments[1].name, b.session);
  fn.body.body[0].argument = call.arguments[0].argument;
  assert.deepEqual(astValue(ast), astValue(orig), 'native request, routing and validation remain unchanged');
}

export const patchContracts = { folders: folderPatchContract, chatWake: chatPatchContract, ownerWake: ownerPatchContract, commands: commandCatalogPatchContract };

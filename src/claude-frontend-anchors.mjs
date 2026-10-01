import { parse } from 'acorn';

const fail = label => { throw new Error(`Claude frontend anchors: ${label} missing or ambiguous`); };
export function unique(values, label) { if (values.length !== 1) fail(label); return values[0]; }
export function syntax(source) {
  try { return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch { throw new Error('Claude frontend anchors: module syntax rejected'); }
}
export function nodes(root, predicate) {
  const result = [];
  function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (predicate(node)) result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(root); return result;
}
const id = node => node?.type === 'Identifier' ? node.name : null;
const unwrap = node => node?.type === 'ChainExpression' ? node.expression : node;
export const member = (node, key) => {
  node = unwrap(node);
  return node?.type === 'MemberExpression' && !node.computed && id(node.property) === key;
};
const prop = (node, key) => node?.type === 'Property' && !node.computed && (id(node.key) ?? node.key.value) === key;
const nativeObject = node => {
  node = unwrap(node);
  const object = node?.object;
  return node?.optional === true && object?.type === 'MemberExpression' && object.computed
    && id(object.object) === 'globalThis' && object.property?.value === 'claude.web';
};
const hasMember = (node, key) => nodes(node, n => member(n, key)).length > 0;
const functions = ast => ast.body.filter(n => n.type === 'FunctionDeclaration');
// Older real bundles retain compiler and non-compiler implementations under
// one conditional binding. Both branches must validate; never choose a branch
// from the host's feature flags or confuse two independent bindings with one.
function functionBindings(ast) {
  return ast.body.flatMap(n => {
    if (n.type === 'FunctionDeclaration') return [{ name: id(n.id), variants: [n] }];
    if (n.type !== 'VariableDeclaration') return [];
    return n.declarations.flatMap(d => {
      if (!id(d.id)) return [];
      if (d.init?.type === 'FunctionExpression') return [{ name: id(d.id), variants: [d.init] }];
      const v = d.init;
      return v?.type === 'ConditionalExpression' && v.consequent.type === 'FunctionExpression'
        && v.alternate.type === 'FunctionExpression' ? [{ name: id(d.id), variants: [v.consequent, v.alternate] }] : [];
    });
  });
}
const code = (source, n) => source.slice(n.start, n.end);
export function applyEdits(source, edits) {
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let edge = source.length + 1;
  for (const e of edits) {
    if (e.start < 0 || e.end < e.start || e.end > source.length || e.end > edge)
      throw new Error('Claude frontend anchors: overlapping transform refused');
    source = source.slice(0, e.start) + e.text + source.slice(e.end); edge = e.start;
  }
  syntax(source); return source;
}
const insert = (at, text) => ({ start: at, end: at, text });
const replace = (n, text) => ({ start: n.start, end: n.end, text });

export function assetImports(source) {
  const ast = syntax(source);
  return [...new Set(nodes(ast, n => n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' && n.source
    || n.type === 'ExportAllDeclaration' || n.type === 'ImportExpression')
    .map(n => n.source?.value).filter(v => typeof v === 'string'))];
}
function exportedName(ast, local) {
  return unique(nodes(ast, n => n.type === 'ExportSpecifier' && id(n.local) === local).map(n => id(n.exported)), 'exported binding');
}
function importedAPI(source, graph, property, native = false) {
  const ast = syntax(source), matches = [];
  for (const imp of ast.body.filter(n => n.type === 'ImportDeclaration')) {
    const dependency = graph.get(imp.source.value);
    if (!dependency) continue;
    // Only the defining native API/React module is eligible, never arbitrary
    // lookalikes or a transitive guess about a minified symbol.
    if (!dependency.source.includes(native ? 'claude.web' : `.${property}`)) continue;
    const depAST = syntax(dependency.source);
    const publicGetters = native ? [] : nodes(depAST, n => prop(n, property)
      && n.value.type === 'ArrowFunctionExpression' && !n.value.params.length && id(n.value.body));
    if (!native && !publicGetters.length) continue;
    const publicGetter = native ? null : unique(publicGetters, `React ${property} public binding`);
    const definitions = nodes(depAST, n => n.type === 'VariableDeclarator' && id(n.id) && member(n.init, property)
      && (native ? nativeObject(n.init)
        : id(n.id) === id(publicGetter.value.body)));
    if (!definitions.length) continue;
    const definition = unique(definitions, property);
    const exported = exportedName(depAST, id(definition.id));
    for (const spec of imp.specifiers) if (spec.type === 'ImportSpecifier' && id(spec.imported) === exported)
      matches.push({ local: id(spec.local), exported, path: imp.source.value });
  }
  return unique(matches, `${property} import`);
}

export function folderAnchors(source, graph) {
  const ast = syntax(source);
  const plausible = f => hasMember(f, 'latestTimestamp') && hasMember(f, 'sessionStatus')
    && nodes(f, n => prop(n, 'hasActiveSessions')).length && nodes(f, n => prop(n, 'disambiguationText')).length;
  const binding = unique(functionBindings(ast).filter(b => b.variants.some(plausible)), 'sidebar grouping binding');
  if (!binding.variants.every(plausible)) fail('sidebar grouping branches');
  const variants = binding.variants.map(grouping => {
    const label = unique(nodes(grouping, n => prop(n, 'name') && n.value.type === 'LogicalExpression'
      && n.value.operator === '??' && member(n.value.left, 'name')), 'sidebar label');
    const rows = id(grouping.params[0]); if (!rows) fail('sidebar rows');
    const loop = unique(nodes(grouping, n => n.type === 'ForOfStatement' && id(n.right) === rows), 'sidebar row loop');
    const row = id(loop.left?.declarations?.[0]?.id); if (!row) fail('sidebar row binding');
    const keyCall = unique(nodes(loop.body, n => n.type === 'VariableDeclarator' && n.init?.type === 'CallExpression'
      && id(n.init.callee) && n.init.arguments.length === 1 && id(n.init.arguments[0]) === row
      && id(n.id) === id(label.value.right)), 'sidebar project key call');
    const key = unique(functions(ast).filter(f => id(f.id) === id(keyCall.init.callee)
      && hasMember(f, 'repoInfo') && hasMember(f, 'isScratchWorkspace') && hasMember(f, 'environmentId')
      && nodes(f, n => n.type === 'Literal' && n.value === 'bridge').length), 'native project key');
    const memos = nodes(grouping.body.body[0], n => n.type === 'VariableDeclarator'
      && n.init?.type === 'CallExpression' && n.init.arguments.length === 1
      && Number.isInteger(n.init.arguments[0]?.value));
    if (!memos.length) {
      // The uncompiled implementation has one useMemo callback over the exact
      // rows/environment/sort/order dependencies. Add the subscription version
      // there too, otherwise a map change can leave useMemo's result stale.
      const memo = unique(nodes(grouping, n => n.type === 'CallExpression' && id(n.callee)
        && n.arguments.length === 2 && n.arguments[0].type === 'ArrowFunctionExpression'
        && n.arguments[0].body.type === 'BlockStatement' && n.arguments[0].start < loop.start
        && n.arguments[0].end > loop.end && n.arguments[1].type === 'ArrayExpression'
        && n.arguments[1].elements.some(e => id(e) === rows)), 'sidebar uncompiled memo');
      if (importedAPI(source, graph, 'useMemo').local !== id(memo.callee)) fail('sidebar useMemo binding');
      return { key, grouping, label, rows, row, plainMemo: memo.arguments[1] };
    }
    const memo = unique(memos, 'sidebar memo cache');
    const cache = id(memo.id), size = memo.init.arguments[0].value;
    if (!cache || size < 1 || size > 4096) fail('sidebar memo bound');
    const store = unique(nodes(grouping, n => n.type === 'AssignmentExpression' && n.operator === '='
      && n.left.type === 'MemberExpression' && id(n.left.object) === cache && n.left.computed
      && n.left.property.value === 4), 'sidebar memo result store');
    const condition = unique(nodes(grouping, n => n.type === 'IfStatement' && n.consequent.type === 'BlockStatement'
      && n.consequent.start < store.start && n.consequent.end > store.end
      && [0, 1, 2, 3].every(index => nodes(n.test, t => t.type === 'BinaryExpression' && t.operator === '!=='
        && t.left.type === 'MemberExpression' && id(t.left.object) === cache && t.left.property.value === index).length === 1)), 'sidebar memo invalidation');
    if (nodes(key.body, n => n.type === 'CallExpression' && id(n.callee) === id(key.id)).length) fail('recursive project key');
    return { key, grouping, label, rows, row, memo, cache, size, condition };
  });
  const key = unique([...new Set(variants.map(v => v.key))], 'sidebar shared native key');
  return { ...variants[0], key, variants, groupingBinding: binding.name,
    native: importedAPI(source, graph, 'LocalSessions', true).local,
    subscribe: importedAPI(source, graph, 'useSyncExternalStore').local };
}

export function chatAnchors(source, graph) {
  const native = importedAPI(source, graph, 'LocalSessions', true);
  // The mount-independent wake belongs to the session-action module, not an
  // arbitrary module that happens to read a file. The native capability check
  // uses one uniquely imported native binding. Older compiler/non-compiler
  // action branches repeat the capability read; no patch targets that read.
  const ast = syntax(source);
  const capabilities = nodes(ast, n => n.type === 'BinaryExpression' && n.operator === '!=='
    && n.right.type === 'UnaryExpression' && n.right.operator === 'void' && n.right.argument.value === 0
    && member(n.left, 'forkSession') && unwrap(n.left).optional === true).map(n => id(unwrap(n.left).object));
  if (unique([...new Set(capabilities)], 'native fork capability binding') !== native.local) fail('native fork capability import');
  return { native: native.local };
}

function attachedClientExport(module) {
  const ast = syntax(module.source);
  const lookups = functions(ast).filter(f => f.params.length === 1 && id(f.params[0])
    && nodes(f, n => n.type === 'ForOfStatement' && n.right.type === 'CallExpression'
      && member(n.right.callee, 'entries') && id(n.right.callee.object) === 'Object'
      && member(n.right.arguments[0], 'localClients')).length);
  if (!lookups.length) return null;
  const lookup = unique(lookups, 'attached stdio client lookup');
  const loop = unique(nodes(lookup, n => n.type === 'ForOfStatement'), 'stdio client loop');
  const declaration = unique(nodes(loop.left, n => n.type === 'ObjectPattern'), 'stdio client record');
  const uuid = id(unique(declaration.properties.filter(n => prop(n, 'uuid')), 'stdio UUID').value);
  const client = id(unique(declaration.properties.filter(n => prop(n, 'client')), 'stdio client').value);
  const test = loop.body;
  if (!uuid || !client || test.type !== 'IfStatement' || test.test.type !== 'BinaryExpression' || test.test.operator !== '==='
    || id(test.test.left) !== uuid || id(test.test.right) !== id(lookup.params[0])
    || test.consequent.type !== 'ReturnStatement' || id(test.consequent.argument) !== client
    || nodes(lookup, n => n.type === 'ReturnStatement').length !== 1) fail('stdio exact UUID return');
  // The lookup must only read getState and Object.entries; it cannot attach,
  // open, close or create any native transport.
  if (nodes(lookup, n => n.type === 'CallExpression').some(n => !member(n.callee, 'getState') && !member(n.callee, 'entries')))
    fail('stdio read-only lookup');
  return exportedName(ast, id(lookup.id));
}

export function ownerAnchors(source, graph) {
  const ast = syntax(source);
  const plausible = f => nodes(f, n => prop(n, 'submitMessage')).length
    && nodes(f, n => prop(n, 'getComposerSnapshot')).length && nodes(f, n => prop(n, 'sessionType')).length
    && nodes(f, n => prop(n, 'initialSessionId')).length && hasMember(f, 'waitForImagesReady');
  const binding = unique(functionBindings(ast).filter(b => b.variants.some(plausible)), 'Code session component binding');
  if (!binding.variants.every(plausible)) fail('Code session component branches');
  const variants = binding.variants.map(component => {
    const selections = nodes(component, n => n.type === 'VariableDeclarator' && n.init?.type === 'LogicalExpression'
      && n.init.operator === '??' && n.init.right.type === 'Literal' && n.init.right.value === null
      && member(n.init.left, 'id') && id(unwrap(n.init.left).object));
    const submit = unique(nodes(component, n => prop(n, 'submitMessage')), 'Code imperative submit');
    const submitCall = unique(nodes(submit.value, n => n.type === 'CallExpression' && id(n.callee)), 'Code submit callback');
    const wrapper = unique(nodes(component, n => n.type === 'VariableDeclarator' && id(n.id) === id(submitCall.callee)
      && n.init?.type === 'CallExpression' && id(n.init.callee)
      && n.init.arguments.length === 1), 'Code retained submit wrapper');
    const callbacks = arg => {
      if (arg?.type === 'ArrowFunctionExpression') return [arg];
      if (!id(arg)) return [];
      return nodes(component, n => n.type === 'AssignmentExpression' && id(n.left) === id(arg)
        || n.type === 'VariableDeclarator' && id(n.id) === id(arg))
        .map(n => n.right ?? n.init).filter(n => n?.type === 'ArrowFunctionExpression');
    };
    const send = unique(callbacks(wrapper.init.arguments[0]), 'Code retained send callback');
    if (!send.async || send.body.type !== 'BlockStatement' || !hasMember(send, 'waitForImagesReady')) fail('Code async send');
    const identities = [];
    for (const selection of selections) {
      const ref = id(unwrap(selection.init.left).object);
      for (const getter of nodes(component, n => n.type === 'VariableDeclarator' && id(n.id)
        && n.init?.type === 'CallExpression' && id(n.init.callee) === id(wrapper.init.callee) && n.init.arguments.length === 1
        && (n.init.arguments[0].type === 'ArrowFunctionExpression' || id(n.init.arguments[0])))) {
        const readers = callbacks(getter.init.arguments[0]).filter(cb => !cb.async && !cb.params.length && id(cb.body) === ref);
        if (!readers.length) continue;
        unique(readers, 'Code reference reader callback');
        if (nodes(send.body, n => n.type === 'VariableDeclarator' && n.init?.type === 'CallExpression'
          && id(n.init.callee) === id(getter.id) && !n.init.arguments.length).length === 1) identities.push({ ref, getter });
      }
    }
    const { ref, getter } = unique(identities, 'Code selection and native send identity');
    return { component, ref, getter: id(getter.id), send,
      selectionEnd: unique(component.body.body.filter(n => n.type === 'VariableDeclaration'
        && n.declarations.includes(getter)), 'Code getter declaration').end };
  });
  const lookupMatches = [];
  for (const imp of ast.body.filter(n => n.type === 'ImportDeclaration')) {
    const module = graph.get(imp.source.value);
    if (!module?.source.includes('localClients') || !module.source.includes('Object.entries')) continue;
    const exported = attachedClientExport(module);
    if (exported) lookupMatches.push({ path: imp.source.value, exported });
  }
  return { ...variants[0], variants, componentBinding: binding.name,
    effect: importedAPI(source, graph, 'useEffect').local,
    client: unique(lookupMatches, 'Code attached stdio lookup module') };
}

export function transformAnchoredFolder(source, b, bootstrap) {
  const name = id(b.key.id), param = id(b.key.params[0]); if (!param) fail('native key argument');
  const variants = b.variants ?? [b];
  return applyEdits(source, [
    insert(b.key.start, bootstrap), replace(b.key.id, '__cldxNativeProjectKey'),
    insert(b.key.end, `function ${name}(${param}){return __cldx.lookup(${param})?.projectKey??__cldxNativeProjectKey(${param})}`),
    ...variants.flatMap(v => [
      insert(v.grouping.body.start + 1, `const __cldxVersion=${b.subscribe}(__cldx.subscribe,__cldx.getSnapshot,__cldx.getSnapshot);__cldx.setRows(${v.rows},__cldxNativeProjectKey);`),
      ...(v.plainMemo ? [insert(v.plainMemo.end - 1, ',__cldxVersion')] : [
        replace(v.memo.init.arguments[0], String(v.size + 1)),
        replace(v.condition.test, `(${code(source, v.condition.test)})||${v.cache}[${v.size}]!==__cldxVersion`),
        insert(v.condition.consequent.end - 1, `;${v.cache}[${v.size}]=__cldxVersion;`),
      ]),
      replace(v.label.value, `__cldx.lookup(${v.row})?.label??${code(source, v.label.value)}`),
    ]),
  ]);
}
export function transformAnchoredOwner(source, b, bootstrap) {
  return applyEdits(source, [...(b.variants ?? [b]).flatMap(v => [insert(v.selectionEnd,
    `;${b.effect}(()=>{void __cldxOwnerWake.signal(${v.ref}?.id,"selection",${v.ref}?.type)},[${v.ref}?.id,${v.ref}?.type]);`),
  insert(v.send.body.start + 1, `{const ref=${v.getter}();void __cldxOwnerWake.signal(ref?.id,"submit",ref?.type);}`)]),
  insert(source.length, bootstrap)]);
}

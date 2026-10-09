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
function functionBindings(ast, { arrows = false } = {}) {
  const callable = n => n?.type === 'FunctionExpression' || arrows && n?.type === 'ArrowFunctionExpression' && n.body.type === 'BlockStatement';
  return ast.body.flatMap(n => {
    if (arrows && n.type === 'ExportNamedDeclaration') n = n.declaration;
    if (!n) return [];
    if (n.type === 'FunctionDeclaration') return [{ name: id(n.id), variants: [n] }];
    if (n.type !== 'VariableDeclaration') return [];
    return n.declarations.flatMap(d => {
      if (!id(d.id)) return [];
      if (callable(d.init)) return [{ name: id(d.id), variants: [d.init] }];
      const v = d.init;
      return v?.type === 'ConditionalExpression' && callable(v.consequent)
        && callable(v.alternate) ? [{ name: id(d.id), variants: [v.consequent, v.alternate] }] : [];
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

const dependencyIndexes = new WeakMap();
const publicGetter = n => n.type === 'Property' && n.value.type === 'ArrowFunctionExpression'
  && !n.value.params.length && id(n.value.body);
const apiExpression = n => !n ? null : n.type === 'Identifier' ? { type: n.type, name: n.name }
  : n.type === 'Literal' ? { type: n.type, value: n.value }
    : n.type === 'ChainExpression' ? { type: n.type, expression: apiExpression(n.expression) }
      : n.type === 'MemberExpression' ? { type: n.type, computed: n.computed, optional: n.optional,
        object: apiExpression(n.object), property: apiExpression(n.property) } : { type: n.type };
function bindingIndex(ast, { full = false, getters = nodes(ast, publicGetter) } = {}) {
  const locals = new Map(), statements = ast.body.flatMap(n => n.type === 'ExportNamedDeclaration' && n.declaration ? [n.declaration] : [n]);
  const exports = ast.body.filter(n => ['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(n.type)).map(n => ({
    type: n.type, source: n.source, specifiers: n.specifiers, exported: n.exported,
    names: n.declaration?.type === 'VariableDeclaration' ? n.declaration.declarations.map(d => id(d.id)) : [id(n.declaration?.id)],
  }));
  const exportedLocals = new Set(exports.flatMap(n => [...n.names,
    ...(n.type === 'ExportNamedDeclaration' && !n.source ? n.specifiers.map(s => id(s.local)) : [])]));
  for (const statement of statements) for (const node of statement.type === 'FunctionDeclaration' ? [statement]
    : statement.type === 'VariableDeclaration' ? statement.declarations : []) {
    if (!id(node.id) || !full && !exportedLocals.has(id(node.id))) continue;
    const api = ['LocalSessions', 'useEffect', 'useSyncExternalStore', 'useMemo'].some(p => member(node.init, p));
    const entry = full ? node : { type: node.type, id: node.id, start: node.start, end: node.end,
      ...(node.type === 'VariableDeclarator' ? { init: api ? apiExpression(node.init) : null } : {}) };
    const rows = locals.get(id(node.id)) ?? []; rows.push(entry); locals.set(id(node.id), rows);
  }
  return { locals, getters, exports, imports: ast.body.filter(n => n.type === 'ImportDeclaration') };
}

export function assetImports(source, module) {
  const ast = syntax(source);
  const discovered = nodes(ast, n => n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' && n.source
    || n.type === 'ExportAllDeclaration' || n.type === 'ImportExpression' || module && publicGetter(n));
  // Reuse the syntax pass already required for graph discovery, retaining only
  // compact binding provenance. The weak key and exact source bind its lifetime
  // to this immutable module snapshot; there is no cross-generation AST cache.
  if (module && module.source === source) dependencyIndexes.set(module, { source,
    index: bindingIndex(ast, { getters: discovered.filter(publicGetter) }) });
  return [...new Set(discovered.map(n => n.source?.value).filter(v => typeof v === 'string'))];
}
function exportedName(ast, local) {
  return unique(nodes(ast, n => n.type === 'ExportSpecifier' && id(n.local) === local).map(n => id(n.exported)), 'exported binding');
}
// Trace named exports rather than guessing a minified name or a chunk name.
// This is a bounded static search; a cycle, missing chunk or ambiguous binding
// supplies no proof. Nothing from the vendor modules is evaluated.
function bindingResolver(source, graph) {
  const root = { source, ast: syntax(source) }, indexes = new WeakMap(), definitions = new WeakMap();
  // Dependency bodies can be enormous. Retain only import/export provenance,
  // binding positions and the fields actually checked by importedAPI. Parse a
  // helper's exact defining slice only when its body supplies semantic proof.
  const indexOf = module => {
    if (indexes.has(module)) return indexes.get(module);
    const observed = dependencyIndexes.get(module);
    const value = module === root ? bindingIndex(root.ast, { full: true })
      : observed?.source === module.source ? observed.index : bindingIndex(syntax(module.source));
    indexes.set(module, value); return value;
  };
  const definition = resolved => {
    if (resolved.module === root) return resolved.node;
    if (!definitions.has(resolved.node)) {
      const raw = code(resolved.module.source, resolved.node);
      const ast = syntax(resolved.node.type === 'VariableDeclarator' ? `let ${raw};` : raw);
      definitions.set(resolved.node, resolved.node.type === 'VariableDeclarator' ? ast.body[0].declarations[0] : ast.body[0]);
    }
    return definitions.get(resolved.node);
  };
  const follow = (module, path) => module === root ? graph.get(path)
    : module.url ? graph.get(new URL(path, module.url).href) : null;
  function local(module, name, seen) {
    const index = indexOf(module), rows = index.locals.get(name) ?? [];
    if (rows.length > 1) fail('static local binding');
    if (rows.length) return { module, getters: index.getters, local: name, node: rows[0] };
    const imports = index.imports.flatMap(n =>
      n.specifiers.filter(s => s.type === 'ImportSpecifier' && id(s.local) === name).map(s => ({ declaration: n, spec: s })));
    if (imports.length !== 1) return null;
    const dependency = follow(module, imports[0].declaration.source.value);
    return dependency ? exported(dependency, id(imports[0].spec.imported), seen) : null;
  }
  function exported(module, name, seen = []) {
    if (seen.length >= 8 || seen.some(([m, n]) => m === module && n === name)) return null;
    seen = [...seen, [module, name]];
    const matches = [];
    for (const statement of indexOf(module).exports) {
      if (statement.type === 'ExportNamedDeclaration') {
        for (const spec of statement.specifiers) if (id(spec.exported) === name) {
          const dependency = statement.source && follow(module, statement.source.value);
          const resolved = statement.source ? dependency && exported(dependency, id(spec.local), seen) : local(module, id(spec.local), seen);
          if (resolved) matches.push(resolved);
        }
        if (statement.names.includes(name)) {
          const resolved = local(module, name, seen); if (resolved) matches.push(resolved);
        }
      } else if (statement.type === 'ExportAllDeclaration' && !statement.exported) {
        const dependency = follow(module, statement.source.value), resolved = dependency && exported(dependency, name, seen);
        if (resolved) matches.push(resolved);
      }
    }
    const distinct = matches.filter((m, i) => matches.findIndex(n => m.module === n.module
      && m.node.type === n.node.type && m.node.start === n.node.start && m.node.end === n.node.end) === i);
    if (distinct.length > 1) fail('static exported binding');
    return distinct[0] ?? null;
  }
  const imported = (declaration, spec) => {
    const dependency = follow(root, declaration.source.value);
    return dependency && spec.type === 'ImportSpecifier' ? exported(dependency, id(spec.imported)) : null;
  };
  function exportNames(module, seen = []) {
    if (seen.length >= 8 || seen.includes(module)) return [];
    seen = [...seen, module];
    return [...new Set(indexOf(module).exports.flatMap(n => {
      if (n.type === 'ExportNamedDeclaration') return [
        ...n.specifiers.map(s => id(s.exported)),
        ...n.names,
      ].filter(Boolean);
      const dependency = n.type === 'ExportAllDeclaration' && !n.exported && follow(module, n.source.value);
      return dependency ? exportNames(dependency, seen) : [];
    }))];
  }
  return { root, imported, exported, exportNames, definition, dependency: imp => follow(root, imp.source.value), local: name => local(root, name, []) };
}
function importedAPI(source, graph, property, native = false, resolver = bindingResolver(source, graph)) {
  const matches = [];
  for (const imp of resolver.root.ast.body.filter(n => n.type === 'ImportDeclaration')) for (const spec of imp.specifiers) {
    const resolved = resolver.imported(imp, spec);
    if (!resolved || resolved.node.type !== 'VariableDeclarator' || !member(resolved.node.init, property)) continue;
    if (native) { if (!nativeObject(resolved.node.init)) continue; }
    else {
      const getters = resolved.getters.filter(n => prop(n, property));
      if (!getters.length || id(unique(getters, `React ${property} public binding`).value.body) !== resolved.local) continue;
    }
    matches.push({ local: id(spec.local), exported: id(spec.imported), path: imp.source.value });
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
      const plainMemos = nodes(grouping, n => n.type === 'CallExpression' && id(n.callee)
        && n.arguments.length === 2 && n.arguments[0].type === 'ArrowFunctionExpression'
        && n.arguments[0].body.type === 'BlockStatement' && n.arguments[0].start < loop.start
        && n.arguments[0].end > loop.end && n.arguments[1].type === 'ArrayExpression'
        && n.arguments[1].elements.some(e => id(e) === rows));
      // Newer bundles export a pure aggregation helper. Hooks belong in its
      // separately validated React consumer, never inside this conditional call.
      if (!plainMemos.length && binding.variants.length === 1
        && grouping.type === 'FunctionDeclaration' && grouping.body.body.includes(loop)
        && grouping.params.length === 4 && grouping.params.slice(2).every(p => p.type === 'AssignmentPattern')
        && grouping.body.body.at(-1)?.type === 'ReturnStatement') {
        if (nodes(key.body, n => n.type === 'CallExpression' && id(n.callee) === id(key.id)).length) fail('recursive project key');
        return { key, grouping, label, rows, row, pure: true,
          groupingExport: exportedName(ast, binding.name), keyExport: exportedName(ast, id(key.id)) };
      }
      const memo = unique(plainMemos, 'sidebar uncompiled memo');
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
    subscribe: variants[0].pure ? null : importedAPI(source, graph, 'useSyncExternalStore').local };
}

/** Resolve the sole reachable caller of a split pure grouping export. All
 * native data dependencies and the actual result cache must remain connected. */
export function folderConsumerAnchors(source, graph, helper, importedPath) {
  const ast = syntax(source);
  const imp = unique(ast.body.filter(n => n.type === 'ImportDeclaration' && n.source.value === importedPath), 'folder helper import');
  const grouping = unique(imp.specifiers.filter(n => id(n.imported) === helper.groupingExport), 'folder grouping import');
  const key = unique(imp.specifiers.filter(n => id(n.imported) === helper.keyExport), 'folder key import');
  const calls = nodes(ast, n => n.type === 'CallExpression' && id(n.callee) === id(grouping.local));
  const call = unique(calls, 'folder grouping consumer');
  if (call.arguments.length !== 4 || !call.arguments.every(id)) fail('folder grouping arguments');
  const component = unique(functions(ast).filter(n => n.start < call.start && n.end > call.end), 'folder consumer component');
  const memo = unique(nodes(component.body.body[0], n => n.type === 'VariableDeclarator'
    && n.init?.type === 'CallExpression' && n.init.arguments.length === 1
    && Number.isInteger(n.init.arguments[0]?.value)), 'folder consumer cache');
  const cache = id(memo.id), size = memo.init.arguments[0].value;
  if (!cache || size < 1 || size > 4096) fail('folder consumer cache bound');
  const condition = unique(nodes(component, n => n.type === 'ConditionalExpression'
    && n.consequent.start < call.start && n.consequent.end > call.end), 'folder consumer invalidation');
  // Builds fetched from 2026-10-09 call compiler memo helpers instead of
  // spelling out each cache slot: changed(cache, i, ...deps) compares the slots
  // from i and store(cache, i, ...deps, value) writes them and the value after.
  const memoCall = n => n?.type === 'CallExpression' && id(n.callee) && id(n.arguments[0]) === cache
    && Number.isInteger(n.arguments[1]?.value);
  let result;
  if (memoCall(condition.test)) {
    const compared = condition.test.arguments.slice(2), stored = condition.consequent, first = condition.test.arguments[1].value;
    const slot = condition.alternate;
    if (compared.length !== 4 || !compared.every(id) || !call.arguments.every(arg => compared.some(n => id(n) === id(arg)))) fail('folder consumer dependencies');
    if (!memoCall(stored) || stored.arguments[1].value !== first || stored.arguments.length !== compared.length + 3
      || stored.arguments.at(-1) !== call || compared.some((n, index) => id(stored.arguments[index + 2]) !== id(n))
      || slot.type !== 'MemberExpression' || id(slot.object) !== cache || !slot.computed
      || slot.property.value !== first + compared.length) fail('folder consumer result');
    if (first < 0 || first + compared.length >= size) fail('folder consumer cache writes');
  } else {
  const tests = nodes(condition.test, n => n.type === 'BinaryExpression' && n.operator === '!=='
    && n.left.type === 'MemberExpression' && id(n.left.object) === cache && n.left.computed
    && Number.isInteger(n.left.property.value) && id(n.right));
  if (tests.length !== 4 || nodes(condition.test, n => n.type === 'CallExpression').length
    || new Set(tests.map(n => n.left.property.value)).size !== 4
    || !call.arguments.every(arg => tests.some(n => id(n.right) === id(arg)))) fail('folder consumer dependencies');
  if (condition.consequent.type !== 'SequenceExpression') fail('folder consumer stores');
  const expressions = condition.consequent.expressions; result = expressions.at(-1);
  if (result?.type !== 'AssignmentExpression' || result.operator !== '='
    || result.left.type !== 'MemberExpression' || id(result.left.object) !== cache || !result.left.computed
    || !Number.isInteger(result.left.property.value) || !id(result.right)
    || code(source, result.left) !== code(source, condition.alternate.right)
    || condition.alternate.type !== 'AssignmentExpression' || id(condition.alternate.left) !== id(result.right)
    || expressions[0]?.type !== 'AssignmentExpression' || id(expressions[0].left) !== id(result.right)
    || expressions[0].right !== call) fail('folder consumer result');
  if (expressions.length !== 6 || tests.some(test => !expressions.slice(1, -1).some(n =>
    n.type === 'AssignmentExpression' && n.operator === '=' && code(source, n.left) === code(source, test.left)
    && id(n.right) === id(test.right))) || [...tests.map(n => n.left.property.value), result.left.property.value]
    .some(index => index < 0 || index >= size)) fail('folder consumer cache writes');
  }
  const keyCalls = nodes(component, n => n.type === 'CallExpression' && id(n.callee) === id(key.local));
  const guards = [condition];
  let prepareAt = condition.start, rows = id(call.arguments[0]);
  if (keyCalls.length) {
    const first = keyCalls[0];
    const rowLoop = unique(nodes(component, n => n.type === 'ForOfStatement' && id(n.right)
      && n.body.start < first.start && n.body.end > first.end), 'folder consumer source rows');
    rows = id(rowLoop.right);
    if (id(call.arguments[0]) !== rows) {
      unique(nodes(component, n => n.type === 'VariableDeclarator' && id(n.id) === id(call.arguments[0])
        && n.init?.type === 'ConditionalExpression' && id(n.init.alternate) === rows), 'folder consumer grouping rows');
    }
    for (const keyCall of keyCalls) {
      const candidates = nodes(component, n => ['IfStatement', 'ConditionalExpression'].includes(n.type)
        && n.consequent.start < keyCall.start && n.consequent.end > keyCall.end
        && (memoCall(n.test) || nodes(n.test, x => x.type === 'MemberExpression' && id(x.object) === cache && x.computed).length));
      const guard = unique(candidates, 'folder key memo guard');
      if (!nodes(guard.consequent, n => n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression'
        && id(n.left.object) === cache || memoCall(guard.test) && memoCall(n) && n.arguments[1].value === guard.test.arguments[1].value).length)
        fail('folder key memo store');
      if (!guards.includes(guard)) guards.push(guard);
    }
    prepareAt = unique(component.body.body.filter(n => n.start <= rowLoop.start && n.end >= rowLoop.end), 'folder rows preparation').start;
  }
  const last = component.body.body.at(-1);
  if (last?.type !== 'ReturnStatement' || guards.some(g => g.end > last.start)) fail('folder consumer return boundary');
  return { component, memo, condition, guards, prepareAt, rows, last, cache, size, result, importedPath,
    subscription: importedAPI(source, graph, 'useSyncExternalStore') };
}

export function transformFolderConsumer(source, b) {
  return applyEdits(source, [
    // A native import alias can be shadowed by parameters or later let/const
    // declarations inside the component. Import the proved export under our
    // reserved namespace instead of borrowing its minified local spelling.
    insert(0, `import{__cldxFolderStore,__cldxNativeProjectKey}from${JSON.stringify(b.importedPath)};import{${b.subscription.exported} as __cldxFolderSubscribe}from${JSON.stringify(b.subscription.path)};`),
    insert(b.component.body.start + 1, 'const __cldxVersion=__cldxFolderSubscribe(__cldxFolderStore.subscribe,__cldxFolderStore.getSnapshot,__cldxFolderStore.getSnapshot);'),
    replace(b.memo.init.arguments[0], String(b.size + 1)),
    insert(b.prepareAt, `__cldxFolderStore.setRows(${b.rows},__cldxNativeProjectKey);`),
    ...b.guards.map(g => replace(g.test, `(${code(source, g.test)})||${b.cache}[${b.size}]!==__cldxVersion`)),
    insert(b.last.start, `${b.cache}[${b.size}]=__cldxVersion;`),
  ]);
}

/** Presentation only: the native cold catalogue disables hooks, but advertises
 * the enabled companion's shipped workflow. Its panel command is dispatched by
 * the ordinary native session, never by this catalogue or by a prompt skill. */
export function exposeClaudexCommand(commands, sessionId) {
  if (sessionId != null || !Array.isArray(commands)
    || commands.some(c => c?.name === 'claudex' || Array.isArray(c?.aliases) && c.aliases.includes('claudex'))
    || !commands.some(c => c?.name === 'claudex:claudex-workflow')) return commands;
  return [{ name: 'claudex', description: 'Open the Claudex control pane.', argumentHint: '[receipt UUID]' }, ...commands];
}

export function commandCatalogAnchors(source, graph) {
  const ast = syntax(source), native = importedAPI(source, graph, 'LocalSessions', true).local;
  const call = unique(nodes(ast, n => n.type === 'CallExpression' && member(n.callee, 'getSupportedCommands')
    && id(n.callee.object) === native), 'local command catalogue call');
  const fn = unique(functions(ast).filter(f => f.async && f.start < call.start && f.end > call.end), 'local command catalogue function');
  if (fn.params.length !== 2 || !fn.params.every(id) || fn.body.body.length !== 1
    || fn.body.body[0].type !== 'ReturnStatement' || fn.params.some(p => id(p) === native)) fail('command catalogue scope');
  const result = fn.body.body[0].argument, [cwd, session] = fn.params.map(id);
  const voidZero = n => n?.type === 'UnaryExpression' && n.operator === 'void' && n.argument.value === 0;
  const fallback = (n, name) => n?.type === 'LogicalExpression' && n.operator === '??' && id(n.left) === name && voidZero(n.right);
  if (result?.type !== 'ConditionalExpression' || result.consequent !== call
    || !member(result.test, 'getSupportedCommands') || id(unwrap(result.test).object) !== native
    || result.alternate.type !== 'ArrayExpression' || result.alternate.elements.length
    || call.arguments.length !== 1 || call.arguments[0].type !== 'ObjectExpression') fail('command catalogue native branch');
  const fields = call.arguments[0].properties;
  if (fields.length !== 2) fail('command catalogue request fields');
  const project = unique(fields.filter(n => prop(n, 'cwd')), 'command catalogue cwd').value;
  const target = unique(fields.filter(n => prop(n, 'sessionId')), 'command catalogue session').value;
  if (!fallback(target, session) || project.type !== 'ConditionalExpression' || id(project.test) !== session
    || !voidZero(project.consequent) || !fallback(project.alternate, cwd)) fail('command catalogue target routing');
  return { fn, result, session, native };
}

export function transformCommandCatalog(source, b) {
  return applyEdits(source, [
    replace(b.result, `__cldxCommandCatalog(await (${code(source, b.result)}),${b.session})`),
    insert(source.length, `\n;${exposeClaudexCommand.toString().replace('exposeClaudexCommand', '__cldxCommandCatalog')}\n`),
  ]);
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

const callbackFunction = node => ['ArrowFunctionExpression', 'FunctionExpression'].includes(node?.type);
// Visit the component's lexical scope, never declarations in another callback.
function scopeNodes(component, predicate) {
  const result = [];
  function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (predicate(node)) result.push(node);
    if (node !== component && /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) return;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(component); return result;
}
function callbackResolver(component, resolver) {
  const bindings = scopeNodes(component, n => n.type === 'VariableDeclarator' || n.type === 'AssignmentExpression');
  const definitions = name => bindings.filter(n => id(n.id ?? n.left) === name);
  const patterns = [...component.params, ...scopeNodes(component, n => n.type === 'VariableDeclarator'
    || n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration' || n.type === 'CatchClause').map(n => n.id ?? n.param)];
  const shadowed = name => patterns.some(pattern => nodes(pattern, n => id(n) === name).length);
  function inlineMemo(name, rows) {
    const assignments = rows.filter(n => n.type === 'AssignmentExpression');
    if (rows.length !== 3 || assignments.length !== 2 || rows.some(n => n.type === 'VariableDeclarator' && n.init)
      || assignments.some(n => n.operator !== '=')) return null;
    const conditions = scopeNodes(component, n => ['ConditionalExpression', 'IfStatement'].includes(n.type)
      && assignments.every(a => n.start < a.start && n.end >= a.end));
    if (conditions.length !== 1) return null;
    const condition = conditions[0];
    const expressions = branch => branch?.type === 'BlockStatement' ? branch.body.flatMap(expressions)
      : branch?.type === 'ExpressionStatement' ? expressions(branch.expression)
        : branch?.type === 'SequenceExpression' ? branch.expressions : branch ? [branch] : [];
    const cacheSlot = n => n?.type === 'MemberExpression' && n.computed && id(n.object)
      && Number.isInteger(n.property.value) && n.property.value >= 0 && n.property.value < 4096;
    const consequent = expressions(condition.consequent), alternate = expressions(condition.alternate);
    const reversed = consequent.length === 1 && cacheSlot(consequent[0]?.right);
    const writes = reversed ? alternate : consequent, cached = reversed ? consequent : alternate;
    const create = writes[0], store = writes.at(-1), slot = cached[0]?.right;
    if (cached.length !== 1 || !assignments.includes(cached[0]) || !cacheSlot(slot)
      || !assignments.includes(create) || !callbackFunction(create.right) || writes.length < 2
      || !writes.slice(1).every(n => n.type === 'AssignmentExpression' && n.operator === '='
        && cacheSlot(n.left) && id(n.left.object) === id(slot.object))
      || code(resolver.root.source, store.left) !== code(resolver.root.source, slot) || id(store.right) !== name
      || new Set(writes.slice(1).map(n => n.left.property.value)).size !== writes.length - 1) return null;
    const dependencies = writes.slice(1, -1);
    const tests = n => n.type === 'LogicalExpression' && n.operator === (reversed ? '&&' : '||') ? [...tests(n.left), ...tests(n.right)] : [n];
    const compared = tests(condition.test);
    if (dependencies.length) {
      if (compared.length !== dependencies.length || compared.some((n, i) => n.type !== 'BinaryExpression' || n.operator !== (reversed ? '===' : '!==')
        || code(resolver.root.source, n.left) !== code(resolver.root.source, dependencies[i].left)
        || code(resolver.root.source, n.right) !== code(resolver.root.source, dependencies[i].right))) return null;
    } else {
      const test = condition.test, sentinel = test.right;
      if (test.type !== 'BinaryExpression' || test.operator !== (reversed ? '!==' : '===') || code(resolver.root.source, test.left) !== code(resolver.root.source, slot)
        || sentinel?.type !== 'CallExpression' || !member(sentinel.callee, 'for') || id(sentinel.callee.object) !== 'Symbol'
        || sentinel.arguments.length !== 1 || sentinel.arguments[0].value !== 'react.memo_cache_sentinel') return null;
    }
    return create.right;
  }
  function helperArgument(call) {
    if (shadowed(id(call.callee))) return null;
    const resolved = resolver.local(id(call.callee));
    let f = resolved && resolver.definition(resolved);
    if (f?.type === 'VariableDeclarator') f = f.init;
    if (!f || !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(f.type)
      || f.async || f.generator || f.params.some((p, i) => !id(p) && !(i === f.params.length - 1 && p.type === 'RestElement' && id(p.argument)))) return null;
    const returns = f.body.type === 'BlockStatement' ? nodes(f.body, n => n.type === 'ReturnStatement').map(n => n.argument) : [f.body];
    if (returns.length !== 1 || nodes(f.body, n => callbackFunction(n) || n.type === 'FunctionDeclaration'
      || n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'AwaitExpression').length) return null;
    const expression = returns[0], result = expression?.type === 'SequenceExpression' ? expression.expressions.at(-1) : expression;
    const rest = f.params.at(-1)?.type === 'RestElement' ? id(f.params.at(-1).argument) : null;
    let index = id(result) ? f.params.findIndex(p => id(p) === id(result)) : -1;
    if (rest && result?.type === 'MemberExpression' && result.computed && id(result.object) === rest
      && result.property.type === 'BinaryExpression' && result.property.operator === '-'
      && member(result.property.left, 'length') && id(result.property.left.object) === rest && result.property.right.value === 1)
      index = call.arguments.length - 1;
    if (index < 0) return null;
    // Only memo writes through the first parameter are permitted. Returning a
    // callback argument is not proof if the helper also dispatches or rewrites it.
    if (nodes(f.body, n => n.type === 'AssignmentExpression').some(n => n.operator !== '='
      || n.left.type !== 'MemberExpression' || !n.left.computed || id(n.left.object) !== id(f.params[0]))) return null;
    const updates = new Set();
    if (f.body.type === 'BlockStatement') for (const statement of f.body.body) {
      if (['ReturnStatement', 'ExpressionStatement', 'EmptyStatement'].includes(statement.type)) continue;
      // The variadic native compiler helper stores rest[i] in cache[slot+i].
      // Prove that exact finite loop, its local counter and its returned value;
      // a loop over another object or arbitrary helper body is never evaluated.
      if (!rest || statement.type !== 'ForStatement' || statement.init?.type !== 'VariableDeclaration'
        || statement.init.declarations.length !== 1) return null;
      const counter = statement.init.declarations[0], loop = id(counter.id), test = statement.test, update = statement.update;
      const body = statement.body.type === 'BlockStatement' && statement.body.body.length === 1 ? statement.body.body[0] : statement.body;
      const write = body?.type === 'ExpressionStatement' ? body.expression : null;
      if (!loop || counter.init?.value !== 0 || test?.type !== 'BinaryExpression' || test.operator !== '<'
        || id(test.left) !== loop || !member(test.right, 'length') || id(test.right.object) !== rest
        || update?.type !== 'UpdateExpression' || update.operator !== '++' || id(update.argument) !== loop
        || write?.type !== 'AssignmentExpression' || write.operator !== '=' || write.left.type !== 'MemberExpression'
        || !write.left.computed || id(write.left.object) !== id(f.params[0])
        || write.left.property.type !== 'BinaryExpression' || write.left.property.operator !== '+'
        || id(write.left.property.left) !== id(f.params[1]) || id(write.left.property.right) !== loop
        || write.right.type !== 'MemberExpression' || !write.right.computed || id(write.right.object) !== rest
        || id(write.right.property) !== loop) return null;
      updates.add(update);
    }
    if (nodes(f.body, n => n.type === 'UpdateExpression' && !updates.has(n)
      || n.type === 'UnaryExpression' && n.operator === 'delete').length) return null;
    return index;
  }
  function resolve(value, seen = [], cache = null) {
    if (!value || seen.length >= 12 || seen.includes(value)) return [];
    seen = [...seen, value];
    if (callbackFunction(value)) return [value];
    if (id(value)) {
      const rows = definitions(id(value));
      // The older compiler assigns a fresh callback or its exact cached slot.
      // Validate both branches and every dependency store before accepting it.
      const values = rows.map(n => n.init ?? n.right).filter(Boolean);
      if (values.length === 2) {
        const callback = inlineMemo(id(value), rows); return callback ? [callback] : [];
      }
      if (rows.some(n => n.type === 'AssignmentExpression' && n.operator !== '=') || values.length !== 1) return [];
      return resolve(values[0], seen, cache);
    }
    if (value.type === 'SequenceExpression') return resolve(value.expressions.at(-1), seen, cache);
    if (value.type === 'ConditionalExpression') {
      const slot = value.alternate;
      if (slot.type !== 'MemberExpression' || !slot.computed || !id(slot.object) || typeof slot.property.value !== 'number') return [];
      return resolve(value.consequent, seen, id(slot.object));
    }
    if (value.type !== 'CallExpression' || !id(value.callee) || !cache || id(value.arguments[0]) !== cache
      || typeof value.arguments[1]?.value !== 'number' || value.arguments.some(n => n.type === 'SpreadElement')) return [];
    const index = helperArgument(value);
    if (index === null) return [];
    const returned = resolve(value.arguments[index], seen, cache);
    const candidates = value.arguments.slice(2).filter(n => callbackFunction(n) || n.type === 'CallExpression').flatMap(n => resolve(n, seen, cache));
    if (returned.length === 1 && !candidates.includes(returned[0])) candidates.push(returned[0]);
    return candidates.length === 1 && returned.length === 1 && returned[0] === candidates[0] ? returned : [];
  }
  return { resolve, definitions, shadowed };
}

function attachedClientLookup(lookup) {
  if (lookup?.type !== 'FunctionDeclaration' || lookup.params.length !== 1 || !id(lookup.params[0])
    || !nodes(lookup, n => n.type === 'ForOfStatement' && n.right.type === 'CallExpression'
      && member(n.right.callee, 'entries') && id(n.right.callee.object) === 'Object'
      && member(n.right.arguments[0], 'localClients')).length) return false;
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
  return true;
}

export function ownerAnchors(source, graph) {
  const resolver = bindingResolver(source, graph), ast = resolver.root.ast;
  const effect = importedAPI(source, graph, 'useEffect', false, resolver).local;
  const plausible = f => nodes(f, n => prop(n, 'submitMessage')).length
    && nodes(f, n => prop(n, 'getComposerSnapshot')).length && nodes(f, n => prop(n, 'sessionType')).length
    && nodes(f, n => prop(n, 'initialSessionId')).length && hasMember(f, 'waitForImagesReady');
  const candidates = functionBindings(ast, { arrows: true }).filter(b => b.variants.some(plausible));
  function proveComponent(component) {
    const callbacks = callbackResolver(component, resolver);
    if (callbacks.shadowed(effect)) fail('Code effect lexical binding');
    const selections = scopeNodes(component, n => member(n, 'id') && id(unwrap(n).object));
    const submit = unique(nodes(component, n => prop(n, 'submitMessage')), 'Code imperative submit');
    const submitCall = unique(nodes(submit.value, n => n.type === 'CallExpression' && id(n.callee)), 'Code submit callback');
    const wrapper = unique(scopeNodes(component, n => n.type === 'VariableDeclarator' && id(n.id) === id(submitCall.callee)
      && n.init?.type === 'CallExpression' && id(n.init.callee)
      && n.init.arguments.length === 1), 'Code retained submit wrapper');
    const send = unique(callbacks.resolve(wrapper.init.arguments[0]), 'Code retained send callback');
    if (!send.async || send.body.type !== 'BlockStatement' || !hasMember(send, 'waitForImagesReady')) fail('Code async send');
    const identities = [], selectedRefs = new Set(selections.map(n => id(unwrap(n).object)));
    // Resolve each getter once. Trying every getter again for every .id reader
    // multiplies parsing on large components without adding identity evidence.
    for (const getter of scopeNodes(component, n => n.type === 'VariableDeclarator' && id(n.id)
      && n.init?.type === 'CallExpression' && id(n.init.callee) === id(wrapper.init.callee) && n.init.arguments.length === 1
      && (callbackFunction(n.init.arguments[0]) || id(n.init.arguments[0])))) {
      const readers = callbacks.resolve(getter.init.arguments[0]).filter(cb => !cb.async && !cb.params.length);
      if (!readers.length) continue;
      const reader = unique(readers, 'Code reference reader callback');
      const ref = id(reader.body) ?? (reader.body.type === 'BlockStatement' && reader.body.body.length === 1
        && reader.body.body[0].type === 'ReturnStatement' ? id(reader.body.body[0].argument) : null);
      if (!ref || !selectedRefs.has(ref) || !callbacks.definitions(ref).some(n => n.type === 'VariableDeclarator')) continue;
      if (nodes(send.body, n => n.type === 'VariableDeclarator' && n.init?.type === 'CallExpression'
        && id(n.init.callee) === id(getter.id) && !n.init.arguments.length).length === 1) identities.push({ ref, getter });
    }
    const { ref, getter } = unique(identities, 'Code selection and native send identity');
    return { component, ref, getter: id(getter.id), send,
      selectionEnd: unique(component.body.body.filter(n => n.type === 'VariableDeclaration'
        && n.declarations.includes(getter)), 'Code getter declaration').end };
  }
  const proven = [], refused = [];
  for (const candidate of candidates) {
    try {
      if (!candidate.variants.every(plausible)) fail('Code session component branches');
      proven.push({ binding: candidate, variants: candidate.variants.map(proveComponent) });
    } catch (error) { refused.push(error); }
  }
  if (!proven.length && candidates.length === 1) throw refused[0];
  const { binding, variants } = unique(proven, 'Code session component binding');
  const lookupMatches = [];
  for (const imp of ast.body.filter(n => n.type === 'ImportDeclaration')) {
    const dependency = resolver.dependency(imp);
    if (!dependency) continue;
    for (const exported of resolver.exportNames(dependency)) {
      const resolved = resolver.exported(dependency, exported);
      const body = resolved && code(resolved.module.source, resolved.node);
      if (body?.includes('localClients') && body.includes('Object.entries')
        && attachedClientLookup(resolver.definition(resolved))) lookupMatches.push({ path: imp.source.value, exported });
    }
  }
  return { ...variants[0], variants, componentBinding: binding.name,
    effect,
    client: unique(lookupMatches, 'Code attached stdio lookup module'),
    search: { method: 'bounded-semantic-bindings', componentCandidates: candidates.length, provenComponents: proven.length } };
}

export function transformAnchoredFolder(source, b, bootstrap) {
  const name = id(b.key.id), param = id(b.key.params[0]); if (!param) fail('native key argument');
  const variants = b.variants ?? [b];
  return applyEdits(source, [
    insert(b.key.start, bootstrap), replace(b.key.id, '__cldxNativeProjectKey'),
    insert(b.key.end, `function ${name}(${param}){return __cldx.lookup(${param})?.projectKey??__cldxNativeProjectKey(${param})}`),
    ...variants.flatMap(v => [
      insert(v.grouping.body.start + 1, `${v.pure ? '' : `const __cldxVersion=${b.subscribe}(__cldx.subscribe,__cldx.getSnapshot,__cldx.getSnapshot);`}__cldx.setRows(${v.rows},__cldxNativeProjectKey);`),
      ...(v.pure ? [] : v.plainMemo ? [insert(v.plainMemo.end - 1, ',__cldxVersion')] : [
        replace(v.memo.init.arguments[0], String(v.size + 1)),
        replace(v.condition.test, `(${code(source, v.condition.test)})||${v.cache}[${v.size}]!==__cldxVersion`),
        insert(v.condition.consequent.end - 1, `;${v.cache}[${v.size}]=__cldxVersion;`),
      ]),
      replace(v.label.value, `__cldx.lookup(${v.row})?.label??${code(source, v.label.value)}`),
    ]),
    ...(b.pure ? [insert(source.length, ';export{__cldx as __cldxFolderStore,__cldxNativeProjectKey};')] : []),
  ]);
}
export function transformAnchoredOwner(source, b, bootstrap) {
  return applyEdits(source, [...(b.variants ?? [b]).flatMap(v => [insert(v.selectionEnd,
    `;${b.effect}(()=>{void __cldxOwnerWake.signal(${v.ref}?.id,"selection",${v.ref}?.type)},[${v.ref}?.id,${v.ref}?.type]);`),
  insert(v.send.body.start + 1, `{const ref=${v.getter}();void __cldxOwnerWake.signal(ref?.id,"submit",ref?.type);}`)]),
  insert(source.length, bootstrap)]);
}

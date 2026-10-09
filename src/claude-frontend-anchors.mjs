import { parse } from 'acorn';
import { analyzeScopes } from './claude-frontend-scope.mjs';

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
const nativeHost = node => node?.type === 'MemberExpression' && node.computed
  && id(node.object) === 'globalThis' && node.property?.value === 'claude.web';
function nativeAPIExpression(node) {
  if (node?.type !== 'SequenceExpression') return node;
  // August bundles retain an otherwise unused host read before the actual API
  // access. Only this exact two-expression native prelude has been observed.
  return Array.isArray(node.expressions) && node.expressions.length === 2 && nativeHost(node.expressions[0])
    ? node.expressions[1] : null;
}
const nativeObject = node => {
  node = unwrap(nativeAPIExpression(node));
  const object = node?.object;
  return node?.optional === true && nativeHost(object);
};
const hasMember = (node, key) => nodes(node, n => member(n, key)).length > 0;
const functions = ast => ast.body.filter(n => n.type === 'FunctionDeclaration');
// Older real bundles retain compiler and non-compiler implementations under
// one conditional binding. Both branches must validate; never choose a branch
// from the host's feature flags or confuse two independent bindings with one.
function functionBindings(ast, { arrows = false, wrapper = null } = {}) {
  const callable = n => n?.type === 'FunctionExpression' || arrows && n?.type === 'ArrowFunctionExpression' && n.body.type === 'BlockStatement';
  return ast.body.flatMap(n => {
    if (arrows && n.type === 'ExportNamedDeclaration') n = n.declaration;
    if (!n) return [];
    if (n.type === 'FunctionDeclaration') return [{ name: id(n.id), variants: [n] }];
    if (n.type !== 'VariableDeclaration') return [];
    return n.declarations.flatMap(d => {
      if (!id(d.id)) return [];
      if (callable(d.init)) return [{ name: id(d.id), variants: [d.init] }];
      if (wrapper && d.init?.type === 'CallExpression' && id(d.init.callee) === wrapper
        && d.init.arguments.length === 1 && callable(d.init.arguments[0]))
        return [{ name: id(d.id), variants: [d.init.arguments[0]] }];
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
        object: apiExpression(n.object), property: apiExpression(n.property) }
      : n.type === 'SequenceExpression' && n.expressions.length === 2
        ? { type: n.type, expressions: n.expressions.map(apiExpression) } : { type: n.type };
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
    const api = ['LocalSessions', 'useEffect', 'useRef', 'useSyncExternalStore', 'useMemo', 'memo'].some(p => member(node.init, p))
      || member(nativeAPIExpression(node.init), 'LocalSessions');
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
    if (!resolved || resolved.node.type !== 'VariableDeclarator'
      || !member(native ? nativeAPIExpression(resolved.node.init) : resolved.node.init, property)) continue;
    if (native) { if (!nativeObject(resolved.node.init)) continue; }
    else {
      const getters = resolved.getters.filter(n => prop(n, property));
      if (!getters.length || id(unique(getters, `React ${property} public binding`).value.body) !== resolved.local) continue;
    }
    matches.push({ local: id(spec.local), exported: id(spec.imported), path: imp.source.value });
  }
  return unique(matches, `${property} import`);
}

function legacyLocalCLIKey(key, ast) {
  const parameter = key.params.length === 1 && id(key.params[0]);
  if (!parameter || !hasMember(key, 'cwd')) return false;
  const calls = nodes(key, n => n.type === 'CallExpression' && id(n.callee)
    && n.arguments.length === 1 && id(n.arguments[0]) === parameter);
  return calls.some(call => {
    // Preserve the older native key, including its local/CLI cwd branch. A
    // changed helper, a shadowed binding or an arbitrary call is no proof.
    if (!analyzeScopes(key).isFree(call.callee)) return false;
    const helpers = functions(ast).filter(f => id(f.id) === id(call.callee));
    if (helpers.length !== 1) return false;
    const helper = helpers[0], ref = !helper.async && !helper.generator && helper.params.length === 1 && id(helper.params[0]);
    const value = helper.body.body.length === 1 && helper.body.body[0].type === 'ReturnStatement'
      && helper.body.body[0].argument;
    const type = (test, literal) => test?.type === 'BinaryExpression' && test.operator === '==='
      && ((member(test.left, 'type') && id(test.left.object) === ref && test.right.value === literal)
        || (member(test.right, 'type') && id(test.right.object) === ref && test.left.value === literal));
    return ref && value?.type === 'LogicalExpression' && value.operator === '||'
      && ((type(value.left, 'local') && type(value.right, 'cli'))
        || (type(value.left, 'cli') && type(value.right, 'local')));
  });
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
      && hasMember(f, 'repoInfo') && (hasMember(f, 'isScratchWorkspace') || legacyLocalCLIKey(f, ast)) && hasMember(f, 'environmentId')
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
  const subscribe = variants[0].pure ? null : importedAPI(source, graph, 'useSyncExternalStore').local;
  // The subscription is injected at the top of each grouping function, where
  // the hook's module name must not denote a parameter or local.
  if (subscribe && variants.some(v => analyzeScopes(v.grouping).at(v.grouping, subscribe))) fail('sidebar subscription lexical binding');
  return { ...variants[0], key, variants, groupingBinding: binding.name,
    native: importedAPI(source, graph, 'LocalSessions', true).local, subscribe };
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
  // Any unexpected native value returns the catalogue exactly as received.
  try {
    if (sessionId != null || !Array.isArray(commands)
      || commands.some(c => c?.name === 'claudex' || Array.isArray(c?.aliases) && c.aliases.includes('claudex'))
      || !commands.some(c => c?.name === 'claudex:claudex-workflow')) return commands;
    return [{ name: 'claudex', description: 'Open the Claudex control pane.', argumentHint: '[receipt UUID]' }, ...commands];
  } catch { return commands; }
}

export function commandCatalogAnchors(source, graph) {
  const ast = syntax(source), native = importedAPI(source, graph, 'LocalSessions', true).local;
  const call = unique(nodes(ast, n => n.type === 'CallExpression' && member(n.callee, 'getSupportedCommands')
    && id(n.callee.object) === native), 'local command catalogue call');
  const scopes = nodes(ast, n => /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type)
    && n.start < call.start && n.end > call.end);
  const fn = unique(scopes.filter(f => f.async && f.body.type === 'BlockStatement' && f.body.body.length === 1
    && f.body.body[0].type === 'ReturnStatement' && f.body.body[0].argument?.type === 'ConditionalExpression'
    && f.body.body[0].argument.consequent === call), 'local command catalogue function');
  // Both native reads must denote the module import from every enclosing scope.
  const lexical = analyzeScopes(scopes.reduce((outer, f) => f.start < outer.start ? f : outer));
  if (!lexical.isFree(call.callee.object) || !lexical.isFree(unwrap(fn.body.body[0].argument.test)?.object))
    fail('command catalogue native lexical binding');
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
  const voidZero = n => n?.type === 'UnaryExpression' && n.operator === 'void' && n.argument.value === 0;
  const capabilities = nodes(ast, n => n.type === 'BinaryExpression' && n.operator === '!=='
    && ((voidZero(n.right) && member(n.left, 'forkSession') && unwrap(n.left).optional === true)
      || (voidZero(n.left) && member(n.right, 'forkSession') && unwrap(n.right).optional === true)))
    .map(n => id(unwrap(voidZero(n.right) ? n.left : n.right).object));
  if (unique([...new Set(capabilities)], 'native fork capability binding') !== native.local) fail('native fork capability import');
  // August also reads the capability in its shortcut help. When such reads
  // compete, the actual action has this exact native alias, null guard and
  // awaited four-argument fork call. Never choose a mere capability display.
  const actions = nodes(ast, n => n.type === 'FunctionExpression' && n.async && !n.generator
    && n.params.length === 2 && n.params.every(id) && n.body.type === 'BlockStatement').filter(fn => {
    const first = fn.body.body[0], guard = fn.body.body[1];
    if (first?.type !== 'VariableDeclaration' || first.kind !== 'const' || first.declarations.length !== 1) return false;
    const alias = first.declarations[0], name = id(alias.id), init = unwrap(alias.init), request = id(fn.params[0]);
    if (!name || !member(init, 'forkSession') || !init.optional || id(init.object) !== native.local
      || nodes(fn, n => id(n) === native.local).length !== 1
      || fn.params.some(p => id(p) === name)
      || guard?.type !== 'IfStatement' || guard.alternate || guard.test.type !== 'UnaryExpression'
      || guard.test.operator !== '!' || id(guard.test.argument) !== name
      || guard.consequent.type !== 'ReturnStatement' || guard.consequent.argument?.value !== null) return false;
    const calls = nodes(fn, n => n.type === 'AwaitExpression' && n.argument.type === 'CallExpression'
      && id(n.argument.callee) === name);
    if (calls.length !== 1) return false;
    const branch = fn.body.body[3], firstCall = branch?.type === 'TryStatement' && branch.block.body[0];
    if (fn.body.body[2]?.type !== 'VariableDeclaration'
      || fn.body.body[2].declarations.some(d => id(d.id) === name)
      || firstCall?.type !== 'VariableDeclaration' || firstCall.declarations.length !== 1
      || id(firstCall.declarations[0].id) === name || firstCall.declarations[0].init !== calls[0]
      || nodes(fn, n => n.type === 'CallExpression' && id(n.callee) === name).length !== 1) return false;
    const args = calls[0].argument.arguments;
    if (args.length !== 4 || !member(args[0], 'id') || !member(args[0].object, 'ref')
      || id(args[0].object.object) !== request || !id(args[1])
      || !member(args[2], 'forkAtMessageUuid') || id(args[2].object) !== request
      || !member(args[3], 'targetCwd') || id(args[3].object) !== request) return false;
    const seeds = scopeNodes(fn, n => n.type === 'VariableDeclarator' && id(n.id) === id(args[1]));
    const seed = seeds.length === 1 && seeds[0].init;
    return seed?.type === 'TemplateLiteral' && seed.quasis.length === 2 && seed.expressions.length === 1
      && seed.quasis[0].value.cooked === 'local_' && seed.quasis[1].value.cooked === ''
      && seed.expressions[0].type === 'CallExpression' && member(seed.expressions[0].callee, 'randomUUID')
      && id(seed.expressions[0].callee.object) === 'crypto' && !seed.expressions[0].arguments.length;
  });
  return { native: native.local, forkAction: actions.length === 1 };
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
// What a module-level helper does with its arguments, decided from its body
// alone: it returns one argument unchanged and writes only into its first
// (the compiler's memo cache). Loops, branches and locals are free to vary;
// calls, closures, free names and any other write are not.
function identityHelper(f) {
  if (f?.type === 'VariableDeclarator') f = f.init;
  if (!f || !/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(f.type) || f.async || f.generator) return null;
  const rest = f.params.at(-1)?.type === 'RestElement' ? f.params.at(-1).argument : null;
  const fixed = rest ? f.params.slice(0, -1) : f.params;
  if (!fixed.every(id) || rest && !id(rest) || !fixed.length) return null;
  const scopes = analyzeScopes(f), parameter = node => scopes.binding(node)?.declarations.some(d => d.kind === 'param');
  const all = nodes(f.body, () => true);
  if (all.some(n => /^(?:CallExpression|NewExpression|AwaitExpression|YieldExpression|TaggedTemplateExpression|ImportExpression|ThrowStatement|ClassExpression|ClassDeclaration|FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ThisExpression|MetaProperty|WithStatement)$/.test(n.type)
    || n.type === 'UnaryExpression' && n.operator === 'delete' || id(n) && scopes.isFree(n) && scopes.use(n))) return null;
  for (const n of all) {
    const target = n.type === 'AssignmentExpression' ? n.left : n.type === 'UpdateExpression' ? n.argument
      : /^For(?:In|Of)Statement$/.test(n.type) && n.left.type !== 'VariableDeclaration' ? n.left : null;
    if (!target) continue;
    if (id(target)) { if (parameter(target)) return null; }
    else if (target.type !== 'MemberExpression' || !target.computed || !id(target.object)
      || scopes.binding(target.object) !== scopes.binding(fixed[0])) return null;
  }
  const returned = f.body.type === 'BlockStatement' ? nodes(f.body, n => n.type === 'ReturnStatement').map(n => n.argument) : [f.body];
  const results = new Set(returned.map(value => {
    const result = value?.type === 'SequenceExpression' ? value.expressions.at(-1) : value;
    if (id(result) && parameter(result) && !(rest && scopes.binding(result) === scopes.binding(rest)))
      return fixed.findIndex(p => scopes.binding(p) === scopes.binding(result));
    return rest && result?.type === 'MemberExpression' && result.computed && scopes.same(result.object, rest)
      && result.property.type === 'BinaryExpression' && result.property.operator === '-'
      && member(result.property.left, 'length') && scopes.same(result.property.left.object, rest)
      && result.property.right.value === 1 ? 'last' : null;
  }));
  const result = results.size === 1 ? [...results][0] : null;
  return result === null || result === -1 ? null : { returns: result };
}

function callbackResolver(component, resolver) {
  const scopes = analyzeScopes(component);
  // Identifiers written through a pattern, a loop head or an update have no
  // single assigned value; a binding with such a write is never followed.
  const targets = new Set();
  const target = n => {
    if (id(n)) targets.add(n);
    else if (n?.type === 'ObjectPattern') n.properties.forEach(p => target(p.type === 'RestElement' ? p.argument : p.value));
    else if (n?.type === 'ArrayPattern') n.elements.forEach(target);
    else if (n?.type === 'AssignmentPattern') target(n.left);
    else if (n?.type === 'RestElement') target(n.argument);
  };
  const writes = nodes(component, n => /^(?:AssignmentExpression|ForInStatement|ForOfStatement|UpdateExpression)$/.test(n.type));
  for (const n of writes) target(n.type === 'UpdateExpression' ? n.argument : n.left);
  // Every row that gives the denoted component binding a value: its simple
  // declarators and plain assignments, wherever they are written.
  const definitions = node => {
    const binding = scopes.binding(node), rows = [];
    if (!binding) return rows;
    for (const d of binding.declarations) {
      if (d.node.type !== 'VariableDeclarator' || d.node.id !== d.id) return [];
      rows.push(d.node);
    }
    for (const reference of binding.references) {
      if (!targets.has(reference)) continue;
      const use = scopes.use(reference);
      if (use.parent.type !== 'AssignmentExpression' || use.key !== 'left' || use.parent.operator !== '=') return [];
      rows.push(use.parent);
    }
    return rows.sort((a, b) => a.start - b.start);
  };
  const slot = n => n?.type === 'MemberExpression' && n.computed && id(n.object)
    && Number.isInteger(n.property.value) && n.property.value >= 0 && n.property.value < 4096;
  const helpers = new Map();
  function helper(call) {
    if (!id(call.callee) || !scopes.isFree(call.callee) || call.arguments.some(n => n.type === 'SpreadElement')) return null;
    const name = call.callee.name;
    if (!helpers.has(name)) {
      let summary = null;
      try { const resolved = resolver.local(name); summary = resolved && identityHelper(resolver.definition(resolved)); } catch { summary = null; }
      helpers.set(name, summary);
    }
    return helpers.get(name);
  }
  // Follow a value to every function it can be. The compiler's memo forms are
  // transparent: a cached slot is the function its own store wrote, and an
  // identity helper is the argument it returns. Anything else is unknown.
  function flow(node, state) {
    if (!node || state.unknown || ++state.steps > 96) { state.unknown = true; return; }
    if (callbackFunction(node)) { state.functions.add(node); return; }
    if (id(node)) {
      const binding = scopes.binding(node);
      if (!binding) { state.unknown = true; return; }
      if (state.active.has(binding)) return;
      const rows = definitions(node), values = rows.map(n => n.init ?? n.right).filter(Boolean);
      if (!values.length || state.depth >= 12) { state.unknown = true; return; }
      state.active.add(binding); state.depth++;
      for (const value of values) flow(value, state);
      state.depth--; state.active.delete(binding); return;
    }
    if (node.type === 'SequenceExpression') return flow(node.expressions.at(-1), state);
    if (node.type === 'ConditionalExpression') { flow(node.consequent, state); return flow(node.alternate, state); }
    if (slot(node)) { state.slots.push(node); return; }
    if (node.type === 'CallExpression') {
      const summary = helper(node), cache = node.arguments[0], first = node.arguments[1];
      if (!summary || !id(cache) || !Number.isInteger(first?.value)) { state.unknown = true; return; }
      const index = summary.returns === 'last' ? node.arguments.length - 1 : summary.returns;
      if (index < 2 || index >= node.arguments.length) { state.unknown = true; return; }
      state.stores.push({ cache, first: first.value, last: first.value + node.arguments.length - 3 });
      return flow(node.arguments[index], state);
    }
    state.unknown = true;
  }
  const fresh = active => ({ functions: new Set(), slots: [], stores: [], active: new Set(active), steps: 0, depth: 0, unknown: false });
  function resolve(value) {
    const state = fresh([]); flow(value, state);
    if (state.unknown || state.functions.size !== 1) return [];
    const [callback] = state.functions, self = id(value) ? scopes.binding(value) : null;
    // A cached slot proves nothing by itself. Its writes in this component
    // must all store this callback, directly or through an identity helper.
    for (const read of state.slots) {
      const direct = writes.filter(n => n.type === 'AssignmentExpression' && slot(n.left)
        && scopes.same(n.left.object, read.object) && n.left.property.value === read.property.value);
      if (direct.some(n => {
        if (n.operator !== '=') return true;
        const stored = fresh(self ? [self] : []); flow(n.right, stored);
        return stored.unknown || stored.slots.length || [...stored.functions].some(f => f !== callback)
          || !stored.functions.size && !(self && scopes.binding(n.right) === self);
      })) return [];
      if (!direct.length && !state.stores.some(store => scopes.same(store.cache, read.object)
        && store.first <= read.property.value && read.property.value <= store.last)) return [];
    }
    return [callback];
  }
  return { resolve, definitions, scopes };
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
  const wrapped = ast.body.flatMap(n => n.type === 'VariableDeclaration' ? n.declarations : [])
    .some(d => d.init?.type === 'CallExpression' && id(d.init.callee) && d.init.arguments.length === 1
      && callbackFunction(d.init.arguments[0]) && plausible(d.init.arguments[0]));
  // The observed August component is memo(component), with no comparator.
  // Only the public React.memo import authorizes looking through that wrapper;
  // arbitrary helpers and forwarding shells retain the complete send guards.
  const wrapper = wrapped ? importedAPI(source, graph, 'memo', false, resolver).local : null;
  const candidates = functionBindings(ast, { arrows: true, wrapper }).filter(b => b.variants.some(plausible));
  function proveComponent(component) {
    const callbacks = callbackResolver(component, resolver), { scopes } = callbacks;
    // The selection effect is injected at the component's top level, where the
    // hook's module name and the session reference must denote these bindings.
    if (scopes.at(component, effect)) fail('Code effect lexical binding');
    const declared = node => callbacks.definitions(node).some(n => n.type === 'VariableDeclarator');
    const statementOf = node => component.body.body.find(n => n.start <= node.start && n.end >= node.end);
    const selections = scopeNodes(component, n => member(n, 'id') && id(unwrap(n).object));
    const submit = unique(nodes(component, n => prop(n, 'submitMessage')), 'Code imperative submit');
    const submitCall = unique(nodes(submit.value, n => n.type === 'CallExpression' && id(n.callee)), 'Code submit callback');
    const wrapper = unique(callbacks.definitions(submitCall.callee).filter(n => n.type === 'VariableDeclarator'
      && n.init?.type === 'CallExpression' && id(n.init.callee)
      && n.init.arguments.length === 1), 'Code retained submit wrapper');
    const send = unique(callbacks.resolve(wrapper.init.arguments[0]), 'Code retained send callback');
    if (!send.async || send.body.type !== 'BlockStatement' || !hasMember(send, 'waitForImagesReady')) fail('Code async send');
    const selectedRefs = new Set(selections.map(n => scopes.key(unwrap(n).object)));
    const selection = node => id(node) && selectedRefs.has(scopes.key(node)) && declared(node)
      && scopes.owns(component, scopes.binding(node)) ? node : null;
    // Early September Code builds keep the session in a React ref. It carries
    // the current session only with the public useRef import, a selection
    // seed, an effect that mirrors that selection into it, and no other use
    // than reading .current: a bare use is an escape, another write a rival.
    let useRef;
    const retained = new Map();
    function retainedRef(node) {
      const binding = scopes.binding(node);
      if (!binding) return null;
      if (retained.has(binding)) return retained.get(binding);
      retained.set(binding, null);
      const rows = callbacks.definitions(node), declaration = rows[0], init = declaration?.init, seed = selection(init?.arguments?.[0]);
      if (rows.length !== 1 || declaration.type !== 'VariableDeclarator' || init?.type !== 'CallExpression'
        || init.arguments.length !== 1 || !seed || !scopes.isFree(init.callee)) return null;
      try { useRef ??= importedAPI(source, graph, 'useRef', false, resolver).local; } catch { return null; }
      if (id(init.callee) !== useRef) return null;
      const members = binding.identifiers.filter(n => n !== declaration.id).map(n => scopes.use(n));
      if (members.some(use => use?.parent.type !== 'MemberExpression' || use.key !== 'object' || !member(use.parent, 'current'))) return null;
      const mirrors = scopeNodes(component, n => n.type === 'CallExpression' && id(n.callee) === effect && scopes.isFree(n.callee)
        && n.arguments.length === 2 && n.arguments[1].type === 'ArrayExpression' && n.arguments[1].elements.length === 1
        && scopes.same(n.arguments[1].elements[0], seed)).flatMap(call => callbacks.resolve(call.arguments[0]).flatMap(cb => {
        const statement = cb.body.type === 'BlockStatement' && cb.body.body.length === 1 ? cb.body.body[0] : null;
        const write = cb.body.type === 'BlockStatement' ? statement?.type === 'ExpressionStatement' && statement.expression : cb.body;
        return !cb.async && !cb.params.length && write?.type === 'AssignmentExpression' && write.operator === '='
          && member(write.left, 'current') && scopes.binding(write.left.object) === binding && scopes.same(write.right, seed)
          ? [{ call, write: write.left }] : [];
      }));
      const written = nodes(component, n => n.type === 'AssignmentExpression' || n.type === 'UpdateExpression'
        || n.type === 'UnaryExpression' && n.operator === 'delete').map(n => unwrap(n.left ?? n.argument))
        .filter(n => n?.type === 'MemberExpression' && scopes.binding(n.object) === binding);
      const boundaries = mirrors.map(m => statementOf(m.call)).filter(n => n?.type === 'ExpressionStatement' && n.start > declaration.end);
      if (!boundaries.length || written.some(n => !mirrors.some(m => m.write === n))) return null;
      const value = { seed, end: boundaries[0].end, name: binding.name };
      retained.set(binding, value); return value;
    }
    // The expression through which the send reads the session it will use:
    // a retained ref's .current, or a call of a getter whose stored reader
    // returns the selection or such a ref. Forms compose; each link is proved.
    function sessionRead(node, depth = 0) {
      node = unwrap(node);
      if (!node || depth > 4) return null;
      if (member(node, 'current') && !node.optional && id(node.object)) {
        const ref = retainedRef(node.object);
        return ref && { seed: ref.seed, end: ref.end, names: [node.object], retainedRef: depth ? undefined : ref.name };
      }
      if (node.type !== 'CallExpression' || node.arguments.length || !id(node.callee)) return null;
      const rows = callbacks.definitions(node.callee), getter = rows[0];
      if (rows.length !== 1 || getter.type !== 'VariableDeclarator' || getter.init?.type !== 'CallExpression'
        || !scopes.same(getter.init.callee, wrapper.init.callee) || getter.init.arguments.length !== 1) return null;
      const readers = callbacks.resolve(getter.init.arguments[0]).filter(cb => !cb.async && !cb.params.length);
      if (readers.length !== 1) return null;
      const body = readers[0].body, value = body.type !== 'BlockStatement' ? body
        : body.body.length === 1 && body.body[0].type === 'ReturnStatement' ? body.body[0].argument : null;
      const statement = statementOf(getter), inner = selection(value) ? { seed: value, end: 0, names: [] } : sessionRead(value, depth + 1);
      if (!inner || statement?.type !== 'VariableDeclaration') return null;
      return { seed: inner.seed, end: Math.max(inner.end, statement.end), names: [node.callee, ...inner.names], getter: depth || inner.names.length ? undefined : getter.id.name };
    }
    const identities = [];
    for (const read of scopeNodes(send, n => n.type === 'VariableDeclarator' && n.init)) {
      const proof = sessionRead(read.init), binding = proof && scopes.binding(proof.seed);
      // The read is injected at the top of the send and the seed after `end`
      // at the component's top level; both must denote the proved bindings there.
      if (!proof || !binding.declarations.every(d => d.node.end <= proof.end)
        || scopes.at(send, proof.names[0].name) !== scopes.binding(proof.names[0])) continue;
      identities.push({ binding, ref: proof.seed.name, read: code(source, unwrap(read.init)), selectionEnd: proof.end,
        ...(proof.getter ? { getter: proof.getter } : {}), ...(proof.retainedRef ? { retainedRef: proof.retainedRef } : {}) });
    }
    // Several reads of one selection agree; reads of different ones do not.
    if (new Set(identities.map(n => n.binding)).size !== 1) fail('Code selection and native send identity');
    const { binding: _, ...identity } = identities[0];
    return { component, send, ...identity, selectionEnd: Math.max(...identities.map(n => n.selectionEnd)) };
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
// Injected statements never propagate a failure into native code: a wrong
// anchor or a broken runtime loses the wake signal, not the user's send.
export const ownerSelectionSignal = ref => `{try{void __cldxOwnerWake.signal(${ref}?.id,"selection",${ref}?.type)}catch{}}`;
export const ownerSubmitSignal = read => `try{const ref=${read};void __cldxOwnerWake.signal(ref?.id,"submit",ref?.type)}catch{}`;
export function transformAnchoredOwner(source, b, bootstrap) {
  return applyEdits(source, [...(b.variants ?? [b]).flatMap(v => [insert(v.selectionEnd,
    `;${b.effect}(()=>${ownerSelectionSignal(v.ref)},[${v.ref}?.id,${v.ref}?.type]);`),
  insert(v.send.body.start + 1, ownerSubmitSignal(v.read))]),
  insert(source.length, bootstrap)]);
}

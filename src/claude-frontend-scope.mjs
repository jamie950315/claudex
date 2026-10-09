// Lexical scope analysis for one parsed vendor function or module. Anchors ask
// which declaration an identifier denotes instead of comparing minified names,
// so parameters, block bindings, hoisted vars and catch bindings all shadow
// exactly as the language defines. Nothing here evaluates vendor code.

const FUNCTION = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;
const identifier = node => node?.type === 'Identifier';

/** Analyze `root` (a function or Program). Identifiers that no scope inside the
 * root declares are free: they belong to the enclosing module or the host. */
export function analyzeScopes(root) {
  const scopes = new Map(), resolved = new Map(), parents = new Map(), pending = [], free = new Map();
  const scope = (node, parent, functionScope) => {
    const value = { node, parent, bindings: new Map() };
    value.functionScope = functionScope ? value : parent?.functionScope ?? value;
    scopes.set(node, value); return value;
  };
  function declare(target, id, kind, declaration) {
    let binding = target.bindings.get(id.name);
    if (!binding) target.bindings.set(id.name, binding = { name: id.name, scope: target, declarations: [], identifiers: [], references: [] });
    binding.declarations.push({ id, kind, node: declaration });
    binding.identifiers.push(id); resolved.set(id, binding);
  }
  // Binding patterns declare their identifiers; default values and computed
  // keys inside them are ordinary expressions of the current scope.
  function pattern(node, current, target, kind, declaration) {
    if (!node) return;
    if (identifier(node)) declare(target, node, kind, declaration);
    else if (node.type === 'ObjectPattern') for (const property of node.properties) {
      if (property.type === 'RestElement') pattern(property.argument, current, target, kind, declaration);
      else { if (property.computed) walk(property.key, current, property, 'key'); pattern(property.value, current, target, kind, declaration); }
    } else if (node.type === 'ArrayPattern') for (const element of node.elements) pattern(element, current, target, kind, declaration);
    else if (node.type === 'AssignmentPattern') { pattern(node.left, current, target, kind, declaration); walk(node.right, current, node, 'right'); }
    else if (node.type === 'RestElement') pattern(node.argument, current, target, kind, declaration);
    else walk(node, current, null, null);
  }
  const reference = (parent, key) => !parent || !(
    (parent.type === 'MemberExpression' && key === 'property' && !parent.computed)
    || (/^(?:Property|MethodDefinition|PropertyDefinition)$/.test(parent.type) && key === 'key' && !parent.computed)
    || (/^(?:LabeledStatement|BreakStatement|ContinueStatement)$/.test(parent.type) && key === 'label')
    || (parent.type === 'ExportSpecifier' && key === 'exported')
    || /^(?:ImportSpecifier|ImportDefaultSpecifier|ImportNamespaceSpecifier|MetaProperty|ImportAttribute)$/.test(parent.type));
  function children(node, current) {
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) for (const item of value) walk(item, current, node, key);
      else if (value && typeof value.type === 'string') walk(value, current, node, key);
    }
  }
  function functionScope(node, current) {
    // A named function expression can refer to itself through its own name.
    const outer = node.type === 'FunctionExpression' && node.id ? scope(node.id, current, false) : current;
    if (outer !== current) declare(outer, node.id, 'function', node);
    const inner = scope(node, outer, true);
    for (const parameter of node.params) pattern(parameter, inner, inner, 'param', node);
    if (node.body.type === 'BlockStatement') for (const statement of node.body.body) walk(statement, inner, node.body, 'body');
    else walk(node.body, inner, node, 'body');
  }
  function walk(node, current, parent, key) {
    if (!node || typeof node.type !== 'string') return;
    if (identifier(node)) {
      if (reference(parent, key)) { parents.set(node, { parent, key }); pending.push({ node, scope: current }); }
      return;
    }
    switch (node.type) {
      case 'FunctionDeclaration':
        if (node.id) declare(current, node.id, 'function', node);
        return functionScope(node, current);
      case 'FunctionExpression': case 'ArrowFunctionExpression': return functionScope(node, current);
      case 'ClassDeclaration': case 'ClassExpression': {
        let inner = current;
        if (node.id && node.type === 'ClassDeclaration') declare(current, node.id, 'class', node);
        else if (node.id) { inner = scope(node, current, false); declare(inner, node.id, 'class', node); }
        walk(node.superClass, inner, node, 'superClass'); return walk(node.body, inner, node, 'body');
      }
      case 'VariableDeclaration': {
        const target = node.kind === 'var' ? current.functionScope : current;
        for (const declarator of node.declarations) {
          pattern(declarator.id, current, target, node.kind, declarator);
          walk(declarator.init, current, declarator, 'init');
        }
        return;
      }
      case 'BlockStatement': case 'StaticBlock': case 'SwitchStatement': {
        const inner = scope(node, current, node.type === 'StaticBlock');
        if (node.type === 'SwitchStatement') { walk(node.discriminant, current, node, 'discriminant'); for (const item of node.cases) walk(item, inner, node, 'cases'); return; }
        for (const statement of node.body) walk(statement, inner, node, 'body');
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': return children(node, scope(node, current, false));
      case 'CatchClause': {
        const inner = scope(node, current, false);
        pattern(node.param, inner, inner, 'catch', node);
        return walk(node.body, inner, node, 'body');
      }
      case 'ImportDeclaration':
        for (const specifier of node.specifiers) declare(current, specifier.local, 'import', specifier);
        return;
      case 'ExportNamedDeclaration':
        if (node.source) return;
        return children(node, current);
      case 'ExportAllDeclaration': return;
      default: return children(node, current);
    }
  }
  const top = scope(root, null, true);
  if (FUNCTION.test(root.type)) {
    for (const parameter of root.params) pattern(parameter, top, top, 'param', root);
    if (root.body.type === 'BlockStatement') for (const statement of root.body.body) walk(statement, top, root.body, 'body');
    else walk(root.body, top, root, 'body');
  } else if (root.type === 'Program') for (const statement of root.body) walk(statement, top, root, 'body');
  else walk(root, top, null, null);
  const lookup = (name, from) => {
    for (let current = from; current; current = current.parent) if (current.bindings.has(name)) return current.bindings.get(name);
    return null;
  };
  for (const { node, scope: current } of pending) {
    const binding = lookup(node.name, current);
    if (binding) { binding.identifiers.push(node); binding.references.push(node); resolved.set(node, binding); }
    else { const rows = free.get(node.name) ?? []; rows.push(node); free.set(node.name, rows); }
  }
  for (const value of scopes.values()) for (const binding of value.bindings.values())
    binding.identifiers.sort((a, b) => a.start - b.start);
  const binding = node => resolved.get(node) ?? null;
  return {
    root, binding,
    /** Parent node and property through which a reference is used. */
    use: node => parents.get(node) ?? null,
    /** One identity for set membership: a declaration, or a free name. */
    key: node => identifier(node) ? binding(node) ?? `free:${node.name}` : null,
    same: (a, b) => identifier(a) && identifier(b) && a.name === b.name && binding(a) === binding(b),
    /** True when the identifier denotes nothing declared inside the root. */
    isFree: node => identifier(node) && !resolved.has(node),
    free: name => free.get(name) ?? [],
    /** What `name` denotes for code placed directly in the scope owned by
     * `owner` (the root, a nested function, a block, a loop or a catch). */
    at: (owner, name) => { const from = scopes.get(owner); if (!from) throw new Error('Claude frontend scope: unknown scope owner'); return lookup(name, from); },
    owns: (owner, value) => scopes.get(owner) === value?.scope,
  };
}

// Developer/test syntax utilities only. Selection and transforms belong to Rust.
import { parse } from 'acorn';
import { join } from 'node:path';

export const FRONTEND_ASSET_ROOT = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/';
export const claudeCacheDirectory = home => join(home, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data');
export const syntax = source => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
export function nodes(root, predicate) {
  const result = [], pending = [root];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (typeof value.type === 'string' && predicate(value)) result.push(value);
    for (const value_ of Object.values(value)) if (value_ && typeof value_ === 'object') pending.push(value_);
  }
  return result;
}
export function member(node, name) {
  while (node?.type === 'ChainExpression') node = node.expression;
  return node?.type === 'MemberExpression' && !node.computed && node.property?.name === name;
}
export function assetImports(source) {
  return nodes(syntax(source), node => ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type))
    .map(node => node.source?.value).filter(value => typeof value === 'string');
}

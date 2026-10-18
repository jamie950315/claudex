// Thin developer bridge to the production Rust frontend engine. Acorn is an
// independent static acceptance oracle, not a second selector or transformer.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { syntax, nodes } from '../test/fixtures/frontend-static.mjs';
import { patchContracts, folderConsumerPatchContract } from '../test/fixtures/claude-frontend-contracts.mjs';

const run = promisify(execFile);
export const adapters = ['folders', 'chatWake', 'ownerWake', 'commands'];
export const buildInstruction = 'cargo build --locked -p claudex-app --example frontend-check';
export async function rustChecker(override) {
  if (override && !isAbsolute(override)) throw new Error('Rust frontend checker override must be absolute');
  const path = override ?? fileURLToPath(new URL('../target/debug/examples/frontend-check', import.meta.url));
  try { await access(path, constants.X_OK); }
  catch { throw new Error(`Rust frontend checker is unavailable: ${path}. Build it explicitly with: ${buildInstruction}`); }
  return path;
}
export async function invokeChecker(checker, options) {
  const args = Object.entries(options).flatMap(([key, value]) => [`--${key}`, String(value)]);
  const { stdout } = await run(checker, args, { timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}
// Rust proves byte offsets; Acorn uses UTF-16 offsets. Reattach only the exact
// AST coordinates the Rust proof supplied, never rediscover native bindings.
function contractBindings(source, bindings) {
  const ast = syntax(source), index = new Map(), all = nodes(ast, () => true);
  const offsets = new Map(); let previous = 0, bytes = 0;
  for (const offset of [...new Set(all.flatMap(node => [node.start, node.end]))].sort((a, b) => a - b)) {
    bytes += Buffer.byteLength(source.slice(previous, offset)); offsets.set(offset, bytes); previous = offset;
  }
  for (const node of all) index.set(`${node.type}:${offsets.get(node.start)}:${offsets.get(node.end)}`, node);
  function materialize(value) {
    if (Array.isArray(value)) return value.map(materialize);
    if (!value || typeof value !== 'object') return value;
    if (value.type && Number.isInteger(value.start) && Number.isInteger(value.end)) {
      const node = index.get(`${value.type}:${value.start}:${value.end}`);
      assert.ok(node, `Rust proof coordinates must name the exact ${value.type}`);
      return structuredClone(node);
    }
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, materialize(v)]));
  }
  return materialize(bindings);
}
export async function validateSources(result) {
  const rows = {};
  for (const adapter of adapters) {
    const actual = result.adapters[adapter];
    if (actual.status !== 'matched') {
      rows[adapter] = { status: 'failed', phase: actual.status === 'skipped' ? 'selection' : 'transform', reason: actual.reason,
        ...(actual.url ? { asset: basename(actual.url) } : {}) };
      continue;
    }
    try {
      assert.ok(actual.sources.length === 1 || adapter === 'folders' && actual.sources.length === 2, 'complete helper/consumer preparation');
      for (const [index, item] of actual.sources.entries()) {
        await run(process.execPath, ['--check', item.path], { maxBuffer: 4096 });
        const source = await readFile(item.path, 'utf8'), original = await readFile(item.original, 'utf8');
        const proof = contractBindings(original, item.bindings);
        (index === 0 ? patchContracts[adapter] : folderConsumerPatchContract)(source, original, proof);
      }
      const [target, consumer] = actual.sources;
      rows[adapter] = { status: 'passed', asset: basename(actual.url), sourceSHA256: target.sourceSHA256,
        nodeCheck: 'passed', vendorASTAndWiring: 'passed', ...(consumer ? { consumer: {
          asset: basename(consumer.url), sourceSHA256: consumer.sourceSHA256, nodeCheck: 'passed', vendorASTAndWiring: 'passed' } } : {}) };
    } catch (error) {
      rows[adapter] = { status: 'failed', phase: 'transform', asset: basename(actual.url), reason: error.message.slice(0, 400) };
    }
  }
  return rows;
}
export async function sandboxDirectories(base) {
  const home = join(base, 'home'), root = join(base, 'state');
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(base, '.frontend-check-sandbox'), 'claudex-static-frontend\n', { mode: 0o600 });
  return { base, root, home };
}
export async function checkStaticGraph({ checker, root, home, output, published, entry }) {
  const result = await invokeChecker(checker, { root, home, output, ...(published ? { published, entry } : {}) });
  return { result, adapters: await validateSources(result) };
}

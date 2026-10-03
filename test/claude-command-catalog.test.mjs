import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { exposeClaudexCommand, commandCatalogAnchors, syntax } from '../src/claude-frontend-anchors.mjs';
import { discoverClaudeFrontend } from '../src/claude-frontend-graph.mjs';
import { inspectFolderCache } from '../src/claude-folder-cache.mjs';
import { ensureClaudeRendererAdapter, restoreClaudeRendererAdapter } from '../src/claude-renderer-adapters.mjs';
import { frontendBuild, writeFrontend } from './fixtures/claude-frontend.mjs';
import { commandCatalogPatchContract } from './fixtures/claude-frontend-contracts.mjs';

const workflow = Object.freeze({ name: 'claudex:claudex-workflow', description: 'Existing workflow' });

test('cold catalogues advertise the exact enabled companion without mutating native entries', () => {
  const rows = Object.freeze([Object.freeze({ name: 'help' }), workflow]);
  for (const session of [undefined, null]) {
    const result = exposeClaudexCommand(rows, session);
    assert.equal(result[0].name, 'claudex');
    assert.deepEqual(result.slice(1), rows); assert.equal(result[2], workflow);
  }
  for (const session of ['', 'local_session', 'remote_session']) assert.equal(exposeClaudexCommand(rows, session), rows);
  for (const rows of [[], null, {}, [null], [{ name: 'other:claudex-workflow' }], [{ name: 'claudex-workflow' }],
    [workflow, { name: 'claudex' }], [workflow, { name: 'other', aliases: ['claudex'] }]])
    assert.equal(exposeClaudexCommand(rows), rows);
});

for (const tag of ['a', 'b']) test(`native catalogue ${tag}: first-use entry, exact routing, failure propagation and restoration`, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-command-catalog-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state'), home = join(base, 'home');
  await mkdir(root, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const resources = await writeFrontend(home, frontendBuild(tag)), graph = await discoverClaudeFrontend({ root, home });
  const matched = graph.adapters.commands;
  assert.equal(matched.status, 'matched');
  await ensureClaudeRendererAdapter({ root, home, graph, adapter: 'commands' });
  const source = inspectFolderCache(await readFile(resources.commands.path), { targetURL: resources.commands.url }).source;
  commandCatalogPatchContract(source, matched.target.source, matched.bindings);
  let executable = source;
  for (const n of syntax(source).body.filter(n => n.type === 'ImportDeclaration').reverse())
    executable = executable.slice(0, n.start) + executable.slice(n.end);
  const calls = [], nativeRows = Object.freeze([workflow]);
  const context = { [`L${tag}`]: { getSupportedCommands: async args => { calls.push(args); return nativeRows; } } };
  runInNewContext(executable, context);
  const query = context[`commands${tag}`];
  assert.equal((await query('/selected-project', null))[0].name, 'claudex');
  assert.equal(calls.length, 1); assert.equal(calls[0].cwd, '/selected-project'); assert.equal(calls[0].sessionId, undefined);
  assert.equal(await query('/ignored-project', 'local_session'), nativeRows);
  assert.equal(calls[1].cwd, undefined); assert.equal(calls[1].sessionId, 'local_session');
  const failure = new Error('Native catalogue refused');
  context[`L${tag}`].getSupportedCommands = async () => { throw failure; };
  await assert.rejects(query('/selected-project'), e => e === failure);
  context[`L${tag}`] = null;
  assert.equal((await query('/selected-project')).length, 0);
  assert.equal((await ensureClaudeRendererAdapter({ root, home, adapter: 'commands' })).changed, false);
  await restoreClaudeRendererAdapter({ root, cachePath: resources.commands.path, adapter: 'commands' });
  assert.deepEqual(await readFile(resources.commands.path), resources.commands.bytes);
  const lookup = { get: path => graph.modules.get(new URL(path, matched.target.url).href) };
  for (const modified of [matched.target.source.replace('sessionId:session', 'sessionId:cwd'),
    matched.target.source.replace('.getSupportedCommands(', '.dispatchCommand('),
    matched.target.source + `async function duplicate(cwd,session){return L${tag}.getSupportedCommands({cwd,sessionId:session})}`])
    assert.throws(() => commandCatalogAnchors(modified, lookup), /missing or ambiguous/);
});

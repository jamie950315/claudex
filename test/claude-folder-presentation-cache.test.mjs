import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { transformDynamicFolderSource, FOLDER_CACHE_FILENAME } from '../src/claude-folder-cache.mjs';
import { claudeFolderPresentationCachePath, claudeFolderPresentationManifestPath, ensureClaudeFolderPresentationCache } from '../src/claude-folder-presentation-cache.mjs';

test('only the known legacy folder path advances to the new pinned resource', async () => {
  const home = '/synthetic/home', directory = join(home, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data');
  const current = join(directory, FOLDER_CACHE_FILENAME);
  assert.equal(claudeFolderPresentationCachePath(home), current);
  assert.equal(claudeFolderPresentationCachePath(home, join(directory, '15bc54146dcdb4ce_0')), current);
  assert.equal(claudeFolderPresentationCachePath(home, current), current);
  assert.equal(claudeFolderPresentationCachePath(home, '/unknown/cache'), '/unknown/cache');
  await assert.rejects(ensureClaudeFolderPresentationCache({ root: '/synthetic/state', cachePath: '/unknown/cache' }), /pinned resource/);
});

test('CLI folder status reads the configured resource journal without hiding the legacy receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-folder-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = '/synthetic/cache/15bc54146dcdb4ce_0', current = join('/synthetic/cache', FOLDER_CACHE_FILENAME);
  for (const [path, generation] of [[legacy, 'legacy'], [current, 'current']]) {
    const manifest = claudeFolderPresentationManifestPath(root, path);
    await mkdir(join(manifest, '..'), { recursive: true, mode: 0o700 });
    await writeFile(manifest, JSON.stringify({ phase: 'installed', generation }), { mode: 0o600 });
  }
  for (const [cachePath, expected] of [[current, 'current'], [legacy, 'legacy']]) {
    await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, mode: 'desktop', folderProjection: { enabled: true, cachePath } }), { mode: 0o600 });
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../bin/claudex.mjs', import.meta.url)), 'desktop', 'folders', 'status', '--root', root]);
    assert.equal(JSON.parse(stdout).installation.generation, expected);
  }
  assert.equal(JSON.parse(await readFile(claudeFolderPresentationManifestPath(root, legacy), 'utf8')).generation, 'legacy');
});

test('the pinned compiled folder hook invalidates its cache on map changes while retaining native rows', async () => {
  // Minimal compiled-hook shape; no vendor source or native session data.
  const fixture = 'function _K(e){return e.type==="local"?e.cwd:e.repoInfo?.name}function vK(e,t){return e+":"+t}'
    + 'var bK=[];function xK(e,t,n){let r=Q(11),i=t===void 0?"recent":t,a=n===void 0?bK:n,{data:o}=Sr(),s=o?.environments,c=Array.isArray(a)?a:bK,l;'
    + 'if(r[0]!==s||r[1]!==c||r[2]!==e||r[3]!==i){l=e.map(n=>{let e=_K(n),a=n.repoInfo;return{key:e,name:a?.name??e}});'
    + 'r[0]=s,r[1]=c,r[2]=e,r[3]=i,r[4]=l}else l=r[4];return l}function SK(e,t){return 0}';
  const projectionSource = await readFile(new URL('../src/claude-folder-projection.mjs', import.meta.url), 'utf8');
  const runtimeSource = await readFile(new URL('../src/claude-folder-runtime.mjs', import.meta.url), 'utf8');
  const source = transformDynamicFolderSource(fixture, { root: '/synthetic/state', projectionSource, runtimeSource });
  let contents = JSON.stringify({ version: 1, entries: [{ remoteId: 'cse_owned', canonicalCwd: '/project', verified: true }] });
  const cache = [], logs = [], reads = [];
  let poll, unsubscribe;
  const context = { Ne: { readFileAtCwd: async (...args) => { reads.push(args); return { contents }; } },
    Q: size => { assert.equal(size, 12); return cache; }, Sr: () => ({ data: undefined }),
    m: (subscribe, snapshot) => { unsubscribe ??= subscribe(() => {}); return snapshot(); },
    setTimeout: fn => { poll = fn; return 1; }, clearTimeout: () => { poll = undefined; },
    console: { warn: line => logs.push(line) } };
  runInNewContext(source, context);
  const rows = [{ id: 'session_owned', type: 'bridge', repoInfo: { name: 'remote' }, route: '/code/session_owned' },
    { id: 'local_original', type: 'local', cwd: '/project', repoInfo: { name: 'project' } }];
  const before = structuredClone(rows);
  const first = context.xK(rows);
  await new Promise(resolve => setImmediate(resolve));
  const mapped = context.xK(rows);
  assert.equal(mapped[0].key, '/project'); assert.equal(mapped[0].name, 'project');
  assert.notEqual(mapped, first); assert.equal(context.xK(rows), mapped);
  contents = JSON.stringify({ version: 1, entries: [] }); await poll();
  const unmapped = context.xK(rows);
  assert.equal(unmapped[0].key, 'remote'); assert.equal(unmapped[0].name, 'remote');
  assert.notEqual(unmapped, mapped); assert.deepEqual(rows, before);
  assert.ok(reads.every(args => args.join(',') === '/synthetic/state,folder-map.json'));
  assert.deepEqual(logs, ['[Claudex folder mapping] loaded shared-19-DDVvTIwQ.js']);
  unsubscribe(); assert.equal(poll, undefined);
  assert.throws(() => transformDynamicFolderSource(fixture + fixture, { root: '/synthetic/state', projectionSource, runtimeSource }), /function changed/);
});

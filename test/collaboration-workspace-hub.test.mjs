import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rename, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { readJSON, writeJSON } from '../src/storage.mjs';

async function until(check) {
  for (let i = 0; i < 400; i++) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw new Error('Timed out waiting for synthetic workspace work');
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cldx-workspace-hub-')));
  const paths = Object.fromEntries(['repo', 'reference', 'extra', 'other'].map(name => [name, join(base, name)]));
  await Promise.all(Object.values(paths).map(path => mkdir(path)));
  execFileSync('git', ['init', '-q', paths.repo]);
  paths.sub = join(paths.repo, 'sub');
  await mkdir(paths.sub);
  const calls = [], releases = [];
  const hub = await new CollaborationHub({ root: join(base, 'broker'), allowWrite: true, maxWorkers: 8,
    mcp: async ({ token }) => ({ token }),
    run: async args => {
      calls.push(args);
      return new Promise(resolve => releases.push(() => resolve({ text: 'synthetic complete' })));
    } }).initialize();
  t.after(async () => {
    const closing = hub.close();
    releases.forEach(release => release());
    await closing;
    await rm(base, { recursive: true, force: true });
  });
  const request = (method, params, token = hub.controllerToken, peer = 'codex') => hub.dispatch({ method, params, token, peer });
  let sequence = 0;
  const start = (params = {}, token) => request('start', { provider: 'codex', cwd: paths.repo,
    permission: 'workspace-write', prompt: 'Synthetic workspace validation', requestId: `start-${++sequence}`, ...params }, token);
  const status = id => request('status', { taskId: id });
  return { base, paths, calls, releases, hub, request, start, status };
}

test('root work expands nested cwd to the Git root, while explicit projectRoot narrows it', async t => {
  const f = await fixture(t);
  const root = await f.start({ cwd: f.paths.sub });
  await until(() => f.calls.length === 1);
  assert.equal((await f.status(root.taskId)).cwd, f.paths.repo);
  assert.equal(f.calls[0].projectRoot, f.paths.repo);
  f.releases[0]();
  await until(async () => (await f.status(root.taskId)).status === 'completed');
  const narrow = await f.start({ cwd: f.paths.sub, projectRoot: f.paths.sub });
  await until(() => f.calls.length === 2);
  assert.equal((await f.status(narrow.taskId)).cwd, f.paths.sub);
  assert.equal(f.calls[1].projectRoot, f.paths.sub);
});

test('extra grants persist and handoff preserves scope while capturing destination model and effort', async t => {
  const f = await fixture(t);
  const scope = { readOnlyDirs: [f.paths.reference], writableDirs: [f.paths.extra] };
  const started = await f.start({ ...scope, model: 'first', effort: 'low' });
  await until(() => f.calls.length === 1);
  for (const key of Object.keys(scope)) {
    assert.deepEqual((await f.status(started.taskId))[key], scope[key]);
    assert.deepEqual(f.calls[0][key], scope[key]);
  }
  const running = await f.status(started.taskId);
  await f.request('handoff', { taskId: started.taskId, provider: 'claude', model: 'opus', effort: 'medium',
    revision: running.revision, message: 'Continue with the same directories', requestId: 'transfer' });
  f.releases[0]();
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].cwd, f.paths.repo);
  assert.equal(f.calls[1].model, 'opus');
  assert.equal(f.calls[1].effort, 'medium');
  for (const key of Object.keys(scope)) assert.deepEqual(f.calls[1][key], scope[key]);
  const stored = await readJSON(join(f.base, 'broker', 'work.json'));
  assert.deepEqual(stored.tasks[started.taskId].writableDirs, scope.writableDirs);
});

test('children cannot widen grants or promote references and can downgrade to read-only', async t => {
  const f = await fixture(t);
  await f.start({ readOnlyDirs: [f.paths.reference], writableDirs: [f.paths.extra] });
  await until(() => f.calls.length === 1);
  const token = f.calls[0].mcp.token;
  await assert.rejects(f.start({ cwd: f.paths.other }, token), /exceeds parent/);
  await assert.rejects(f.start({ writableDirs: [f.paths.reference], readOnlyDirs: [] }, token), /exceed parent/);
  await assert.rejects(f.start({ readOnlyDirs: [f.paths.other] }, token), /exceed parent/);
  const child = await f.start({ permission: 'read-only' }, token);
  const state = await f.status(child.taskId);
  assert.equal(state.permission, 'read-only');
  assert.deepEqual(state.writableDirs, []);
  assert.deepEqual(state.readOnlyDirs, [f.paths.extra, f.paths.reference].sort());
  await until(() => f.calls.length === 2);
  assert.equal((await f.status(child.taskId)).status, 'running');
});

test('ancestor writes and descendant reads run concurrently with distinct explicit project roots', async t => {
  const f = await fixture(t);
  const writer = await f.start();
  await until(() => f.calls.length === 1);
  const reader = await f.start({ cwd: f.paths.sub, projectRoot: f.paths.sub, permission: 'read-only' });
  await until(() => f.calls.length === 2);
  assert.equal((await f.status(reader.taskId)).status, 'running');
  assert.equal((await f.status(writer.taskId)).status, 'running');
});

test('extra-root readers and writers run concurrently alongside disjoint work', async t => {
  const f = await fixture(t);
  await f.start({ writableDirs: [f.paths.extra] });
  await until(() => f.calls.length === 1);
  const reader = await f.start({ cwd: f.paths.other, permission: 'read-only', readOnlyDirs: [f.paths.extra] });
  const disjoint = await f.start({ cwd: f.paths.reference });
  await until(() => f.calls.length === 3);
  assert.equal((await f.status(reader.taskId)).status, 'running');
  assert.equal((await f.status(disjoint.taskId)).status, 'running');
});

test('eight writable tasks in one canonical workspace all start without a directory lock', async t => {
  const f = await fixture(t);
  const tasks = [];
  for (let i = 0; i < 8; i++) tasks.push(await f.start());
  await until(() => f.calls.length === 8);
  for (const task of tasks) assert.equal((await f.status(task.taskId)).status, 'running');
  assert.ok(f.calls.every(call => call.cwd === f.paths.repo));
});

test('read-only root requests reject write grants and overlapping read/write grants', async t => {
  const f = await fixture(t);
  await assert.rejects(f.start({ permission: 'read-only', writableDirs: [f.paths.extra] }), /read-only/);
  await assert.rejects(f.start({ readOnlyDirs: [f.paths.sub] }), /overlap/);
  await assert.rejects(f.start({ readOnlyDirs: Array(17).fill(f.paths.reference) }), /at most 16/);
  assert.equal(f.calls.length, 0);
});

test('legacy saved tasks retain exact nested cwd instead of discovering a broader Git root', async t => {
  const f = await fixture(t);
  f.hub.schedule = () => {};
  const created = await f.start({ cwd: f.paths.sub, projectRoot: f.paths.sub });
  await f.hub.close();
  const file = join(f.base, 'broker', 'work.json');
  const ledger = await readJSON(file);
  for (const key of ['projectRoot', 'readOnlyDirs', 'writableDirs']) delete ledger.tasks[created.taskId][key];
  await writeJSON(file, ledger);
  const calls = [];
  const reopened = await new CollaborationHub({ root: join(f.base, 'broker'), allowWrite: true,
    run: async args => { calls.push(args); return { text: 'legacy complete' }; } }).initialize();
  t.after(() => reopened.close());
  reopened.schedule();
  await until(() => calls.length === 1);
  assert.equal(calls[0].cwd, f.paths.sub);
  assert.equal(calls[0].projectRoot, f.paths.sub);
  await reopened.close();
});

test('dispatch rejects a saved directory replaced by a symlink before invoking a worker', async t => {
  const f = await fixture(t);
  f.hub.schedule = () => {};
  const created = await f.start({ cwd: f.paths.other });
  await rename(f.paths.other, `${f.paths.other}-original`);
  await symlink(f.paths.reference, f.paths.other);
  await f.hub.pump();
  const state = await f.status(created.taskId);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /canonical identity/);
  assert.equal(f.calls.length, 0);
});

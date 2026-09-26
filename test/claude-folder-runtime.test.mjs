import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeFolderRuntime } from '../src/claude-folder-runtime.mjs';
import { claudeFolderProjectKey } from '../src/claude-folder-projection.mjs';

const rows = Object.freeze([Object.freeze({ type: 'local', id: 'local_original', cwd: '/project',
  repoInfo: Object.freeze({ owner: '', name: 'project' }) })]);
const map = entries => ({ contents: JSON.stringify({ version: 1, entries }) });
const entry = id => ({ remoteId: `cse_${id}`, canonicalCwd: '/project', verified: true });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const tasks = new Map(), errors = [];
  let next = 0, notifications = 0, reads = 0;
  const f = { value: map([entry('one')]), tasks, errors, reads: () => reads, notices: () => notifications };
  f.runtime = createClaudeFolderRuntime({ readMap: async () => { reads++; return f.value; },
    setTimer: fn => { tasks.set(++next, fn); return next; }, clearTimer: id => tasks.delete(id), onError: e => errors.push(e) });
  f.subscribe = () => f.runtime.subscribe(() => notifications++);
  f.poll = async () => { const [id, fn] = [...tasks][0]; tasks.delete(id); await fn(); };
  return f;
}

test('new remote mappings update existing folder keys without reload or row mutations', async () => {
  const f = fixture(), stop = f.subscribe();
  await flush(); f.runtime.setRows(rows, claudeFolderProjectKey);
  assert.deepEqual(f.runtime.lookup({ type: 'bridge', id: 'session_one' }), { projectKey: '/project', label: 'project' });
  const first = f.runtime.getSnapshot();
  await f.poll();
  assert.equal(f.runtime.getSnapshot(), first);
  f.value = map([entry('one'), entry('two')]); await f.poll();
  f.runtime.setRows(rows, claudeFolderProjectKey);
  assert.equal(f.runtime.lookup({ type: 'bridge', id: 'cse_two' }).projectKey, '/project');
  assert.equal(f.runtime.lookup({ type: 'local', id: 'cse_two' }), undefined);
  assert.equal(f.notices(), 2);
  stop(); assert.equal(f.tasks.size, 0);
});

test('missing, invalid or truncated maps clear overrides and report bounded errors', async () => {
  const f = fixture(), stop = f.subscribe(); await flush();
  f.runtime.setRows(rows, claudeFolderProjectKey);
  f.value = null; await f.poll(); f.runtime.setRows(rows, claudeFolderProjectKey);
  assert.equal(f.runtime.lookup({ type: 'bridge', id: 'cse_one' }), undefined);
  await f.poll(); assert.equal(f.errors.length, 1);
  f.value = { contents: '{bad' }; await f.poll();
  assert.equal(f.errors.length, 2);
  f.value = { ...map([entry('one')]), isTail: true }; await f.poll();
  assert.equal(f.errors.length, 3);
  f.value = map([entry('one')]); await f.poll(); f.runtime.setRows(rows, claudeFolderProjectKey);
  assert.equal(f.runtime.lookup({ type: 'bridge', id: 'cse_one' }).projectKey, '/project');
  stop();
});

test('an unsubscribed in-flight read cannot publish late data or keep polling', async () => {
  let finish, scheduled = 0, notified = 0;
  const runtime = createClaudeFolderRuntime({ readMap: () => new Promise(resolve => { finish = resolve; }),
    setTimer: () => { scheduled++; } });
  const stop = runtime.subscribe(() => notified++); stop();
  finish(map([entry('one')])); await flush();
  runtime.setRows(rows, claudeFolderProjectKey);
  assert.equal(runtime.lookup({ type: 'bridge', id: 'cse_one' }), undefined);
  assert.equal(notified, 0); assert.equal(scheduled, 0);
});

test('without the native reader no alternative I/O or worker is started', async () => {
  let scheduled = 0;
  const runtime = createClaudeFolderRuntime({ setTimer: () => { scheduled++; } });
  const stop = runtime.subscribe(() => {}); await flush();
  runtime.setRows(rows, claudeFolderProjectKey);
  assert.equal(runtime.getSnapshot(), 0); assert.equal(scheduled, 0);
  stop();
});

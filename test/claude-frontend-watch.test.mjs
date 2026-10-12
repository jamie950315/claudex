import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openState, regress, runQueue, submit } from '../dev/frontend-watch/watch.mjs';

const passed = (asset, hash = 'a'.repeat(64)) => ({ status: 'passed', asset, sourceSHA256: hash });
const report = (entry, overrides = {}) => ({ version: 1, entry, passed: true, adapters: { folders: passed('f.js'), chatWake: passed('c.js'),
  ownerWake: passed('o.js'), commands: passed('k.js'), ...overrides } });
async function state(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-frontend-watch-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  return openState(join(base, 'state'));
}

test('an entry is queued once, checked once and never queued again after its report', async t => {
  const paths = await state(t); let checks = 0;
  assert.deepEqual(await submit(paths, { entry: 'index-aaa.js', source: 'mac' }), { entry: 'index-aaa.js', state: 'queued', added: true });
  assert.deepEqual(await submit(paths, { entry: 'index-aaa.js', source: 'windows' }), { entry: 'index-aaa.js', state: 'queued' });
  const results = await runQueue(paths, { check: async ({ entry }) => { checks++; return report(entry); } });
  assert.deepEqual(results, [{ entry: 'index-aaa.js', state: 'passed' }]);
  assert.deepEqual(await readdir(paths.queue), []);
  assert.equal(JSON.parse(await readFile(join(paths.reports, 'index-aaa.js.json'), 'utf8')).source, 'mac');
  assert.deepEqual(await submit(paths, { entry: 'index-aaa.js', source: 'mac' }), { entry: 'index-aaa.js', state: 'passed' });
  assert.deepEqual(await runQueue(paths, { check: async () => { checks++; } }), []);
  assert.equal(checks, 1);
});

test('names that are not entry files, and unsafe source names, are refused', async t => {
  const paths = await state(t);
  for (const entry of ['shared-1-abc.js', '../index-a.js', 'index-a.js/..', 'index-.js', 'index-a.mjs'])
    await assert.rejects(submit(paths, { entry, source: 'mac' }));
  await assert.rejects(submit(paths, { entry: 'index-aaa.js', source: 'a b' }));
  assert.deepEqual(await readdir(paths.queue), []);
});

test('an unavailable graph stays queued; a failed adapter is reported and told once', async t => {
  const paths = await state(t), told = [];
  await submit(paths, { entry: 'index-net.js', source: 'mac' }); await submit(paths, { entry: 'index-bad.js', source: 'mac' });
  const check = async ({ entry }) => entry === 'index-net.js' ? { entry, unavailable: 'Download failed', passed: false }
    : { ...report(entry, { chatWake: { status: 'failed', phase: 'selection', reason: 'missing' } }), passed: false };
  const onFailure = async failure => { told.push(failure.entry); throw new Error('notifier offline'); };
  const first = await runQueue(paths, { check, onFailure });
  assert.deepEqual(first.map(r => [r.entry, r.state]), [['index-bad.js', 'failed'], ['index-net.js', 'unavailable']]);
  assert.deepEqual(first[0].failed, ['chatWake']);
  assert.match(first[0].hook, /^failed: notifier offline/);
  assert.deepEqual(await readdir(paths.queue), ['index-net.js.json']);
  assert.equal(JSON.parse(await readFile(join(paths.queue, 'index-net.js.json'), 'utf8')).attempts, 1);
  const second = await runQueue(paths, { check, onFailure });
  assert.deepEqual(second.map(r => r.entry), ['index-net.js']);
  assert.deepEqual(told, ['index-bad.js']);
  const status = JSON.parse(await readFile(join(paths.root, 'status.json'), 'utf8'));
  assert.equal(status.queued, 1); assert.equal(status.reported, 1);
});

test('regression accepts a repaired entry and refuses a changed or lost passing adapter', async t => {
  const paths = await state(t);
  await submit(paths, { entry: 'index-old.js', source: 'mac' }); await submit(paths, { entry: 'index-new.js', source: 'mac' });
  const broken = { ...report('index-new.js', { commands: { status: 'failed', phase: 'selection', reason: 'missing' } }), passed: false };
  await runQueue(paths, { check: async ({ entry }) => entry === 'index-new.js' ? broken : report(entry) });
  const repaired = await regress(paths, { check: async ({ entry }) => report(entry) });
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.rows.map(r => [r.entry, r.state]), [['index-new.js', 'passed'], ['index-old.js', 'passed']]);
  const stillBroken = await regress(paths, { check: async ({ entry }) => entry === 'index-new.js' ? broken : report(entry) });
  assert.equal(stillBroken.ok, true);
  assert.deepEqual(stillBroken.rows[0].failed, ['commands']);
  const moved = await regress(paths, { check: async ({ entry }) => report(entry, { chatWake: passed('other.js') }) });
  assert.equal(moved.ok, false);
  assert.deepEqual(moved.rows.find(r => r.entry === 'index-old.js').changed, ['chatWake']);
  const lost = await regress(paths, { check: async ({ entry }) => ({ ...report(entry, { folders: { status: 'failed' } }), passed: false }) });
  assert.equal(lost.ok, false);
  const offline = await regress(paths, { check: async ({ entry }) => ({ entry, unavailable: 'Download failed', passed: false }) });
  assert.equal(offline.ok, false);
});

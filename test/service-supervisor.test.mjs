import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, unlink, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectServiceStart, runServiceSupervisor, serviceRestartDelay } from '../src/service-supervisor.mjs';
import { writeJSON } from '../src/storage.mjs';

const fresh = () => mkdtemp(join(tmpdir(), 'claudex-supervisor-test-'));
const readStatus = async root => JSON.parse(await readFile(join(root, 'service-status.json'), 'utf8'));
async function until(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(10); }
  throw new Error('Timed out waiting for the synthetic service.');
}

test('bounded crash backoff resets only after a stable watcher run', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 100].map(serviceRestartDelay), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
});

test('read-only preflight blocks a live native child and malformed locks without reclaiming anything', async () => {
  const root = await fresh(), owners = join(root, 'owners'); await mkdir(owners, { mode: 0o700 });
  const path = join(owners, `${'a'.repeat(64)}.json.lock`);
  await writeJSON(path, { pid: 100, childPid: 200, nonce: randomUUID() });
  const before = await readFile(path, 'utf8');
  const check = await inspectServiceStart(root, { alive: pid => pid === 200 });
  assert.equal(check.allowed, false); assert.equal(check.blockers[0].code, 'live-native-child');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await inspectServiceStart(root, { alive: () => false })).allowed, true);
  assert.equal(await readFile(path, 'utf8'), before, 'dead locks remain for native exclusive acquisition');
  await writeJSON(path, { pid: 100, childPid: null, nonce: randomUUID() });
  const orphan = [{ pid: 300, startedAt: Date.now(), command: '/synthetic/claude' }];
  assert.equal((await inspectServiceStart(root, { alive: () => false, orphans: async () => orphan })).blockers[0].code, 'unrecorded-native-child');
  // No parentless Claude process was born with this lock, so native acquisition may reclaim it.
  assert.equal((await inspectServiceStart(root, { alive: () => false, orphans: async () => [] })).allowed, true);
  assert.equal((await inspectServiceStart(root, { alive: () => false,
    orphans: async () => [{ ...orphan[0], startedAt: Date.now() - 3_600_000 }, { ...orphan[0], command: '/bin/zsh' }] })).allowed, true);
  await writeJSON(path, { pid: 100, childPid: 200 });
  assert.equal((await inspectServiceStart(root, { alive: () => false })).blockers[0].code, 'malformed-lock');
  await unlink(path); await symlink(join(root, 'missing'), path);
  assert.equal((await inspectServiceStart(root)).allowed, false);
});

test('a prepared transaction survives reported watcher failure and process recovery byte-for-byte', async () => {
  const root = await fresh(), pendingPath = join(root, 'desktop-state.json');
  await writeJSON(pendingPath, { pending: { phase: 'prepared', operationId: randomUUID(), record: { nativeId: randomUUID() } } });
  const before = await readFile(pendingPath, 'utf8');
  let launches = 0;
  const result = await runServiceSupervisor({ root, cli: '/synthetic/cli', heartbeatMs: 1, restartDelay: () => 1,
    launch() {
      const attempt = ++launches;
      return { pid: 43210, stop() {}, done: (async () => {
        if (attempt === 1) await writeJSON(join(root, 'watcher-status.json'), { pid: 43210, running: false, error: 'Synthetic failure with pending recovery.' });
        else assert.equal((await readStatus(root)).lastExit.error, 'Synthetic failure with pending recovery.');
        return { code: attempt === 1 ? 1 : 0, signal: null, error: null };
      })() };
    } });
  assert.equal(launches, 2); assert.equal(result.restartCount, 1); assert.equal(result.state, 'stopped');
  assert.equal(await readFile(pendingPath, 'utf8'), before);
});

test('consecutive failure pacing resets after a stable process, not merely after spawn', async () => {
  const root = await fresh(); let clock = 10000, launches = 0; const counts = [];
  await runServiceSupervisor({ root, cli: '/synthetic/cli', now: () => clock, stableMs: 100, heartbeatMs: 1,
    restartDelay(failures) { counts.push(failures); return 1; },
    launch() {
      const attempt = ++launches;
      if (attempt === 3) clock += 101;
      return { pid: 43213, done: Promise.resolve({ code: attempt === 4 ? 0 : 1, signal: null, error: null }), stop() {} };
    } });
  assert.deepEqual(counts, [1, 2, 1]);
});

test('graceful stop waits for a busy synthetic owner and never respawns or force-kills it', async () => {
  const root = await fresh(), controller = new AbortController();
  let finish, stops = 0, launches = 0;
  const done = new Promise(resolve => { finish = resolve; });
  const running = runServiceSupervisor({ root, cli: '/synthetic/cli', signal: controller.signal, heartbeatMs: 5,
    launch() { launches++; return { pid: 43211, done, stop() { stops++; } }; } });
  await until(async () => (await readStatus(root).catch(() => ({}))).state === 'running');
  controller.abort();
  await until(async () => (await readStatus(root)).state === 'stopping');
  assert.equal(stops, 1); assert.equal(launches, 1);
  finish({ code: 0, signal: null, error: null });
  assert.equal((await running).state, 'stopped');
});

test('live watcher blocks supervisor allocation until that exact lock disappears', async () => {
  const root = await fresh(), lock = join(root, 'watch.lock');
  await writeJSON(lock, { pid: process.pid, started: new Date().toISOString() });
  const before = await readFile(lock, 'utf8'); let launches = 0;
  const running = runServiceSupervisor({ root, cli: '/synthetic/cli', checkMs: 5, heartbeatMs: 1,
    launch() { launches++; return { pid: 43212, done: Promise.resolve({ code: 0, signal: null, error: null }), stop() {} }; } });
  await until(async () => (await readStatus(root).catch(() => ({}))).state === 'blocked');
  assert.equal(launches, 0); assert.equal(await readFile(lock, 'utf8'), before);
  await unlink(lock);
  await running; assert.equal(launches, 1);
});

test('real synthetic process crash restarts once, preserving a sole watcher lease', async t => {
  const root = await fresh(), controller = new AbortController();
  const storage = new URL('../src/storage.mjs', import.meta.url).href;
  let launches = 0, firstPid, secondPid, child;
  const running = runServiceSupervisor({ root, cli: '/synthetic/cli', signal: controller.signal,
    heartbeatMs: 5, restartDelay: () => 5, launch() {
      launches++;
      child = spawn(process.execPath, ['--input-type=module', '-e', `
        import {withLock,writeJSON} from ${JSON.stringify(storage)};
        import {setTimeout as delay} from 'node:timers/promises';
        await withLock(${JSON.stringify(join(root, 'watch.lock'))}, async()=>{
          let stopped=false; process.on('SIGTERM',()=>{stopped=true});
          await writeJSON(${JSON.stringify(join(root, 'fixture-ready.json'))},{pid:process.pid});
          while(!stopped) await delay(10);
        },{recoverDead:true});
      `], { stdio: 'ignore' });
      if (launches === 1) firstPid = child.pid; else secondPid = child.pid;
      const current = child;
      return { pid: current.pid, done: new Promise(resolve => current.once('exit', (code, signal) => resolve({ code, signal, error: null }))), stop() { current.kill('SIGTERM'); } };
    } });
  t.after(async () => { controller.abort(); await running; });
  await until(async () => JSON.parse(await readFile(join(root, 'fixture-ready.json'), 'utf8').catch(() => '{}')).pid === firstPid && Boolean(firstPid));
  child.kill('SIGKILL');
  await until(async () => JSON.parse(await readFile(join(root, 'fixture-ready.json'), 'utf8').catch(() => '{}')).pid === secondPid && Boolean(secondPid));
  assert.notEqual(firstPid, secondPid); assert.equal(launches, 2);
  assert.equal(JSON.parse(await readFile(join(root, 'watch.lock'))).pid, secondPid);
  controller.abort(); await running;
  assert.equal((await readStatus(root)).restartCount, 1);
  assert.equal(await readFile(join(root, 'watch.lock')).catch(error => error.code), 'ENOENT');
});

test('locks naming a reused PID, old empty locks and abandoned claims do not block a start', async () => {
  const root = await fresh(), written = Date.now() - 86_400_000;
  await writeJSON(join(root, 'watch.lock'), { pid: 4242, started: new Date(written).toISOString() });
  const reused = { alive: () => true, startedAt: async () => written + 3_600_000 };
  assert.equal((await inspectServiceStart(root, reused)).allowed, true);
  // The same PID born before the lock was written is still its holder; unreadable start times stay conservative.
  assert.equal((await inspectServiceStart(root, { alive: () => true, startedAt: async () => written - 5000 })).blockers[0].code, 'live-owner');
  assert.equal((await inspectServiceStart(root, { alive: () => true, startedAt: async () => null })).blockers[0].code, 'live-owner');
  await writeFile(join(root, 'watch.lock'), '', { mode: 0o600 });
  assert.equal((await inspectServiceStart(root, reused)).blockers[0].code, 'unverified-lock');
  assert.equal((await inspectServiceStart(root, { ...reused, now: () => Date.now() + 61_000 })).allowed, true);
  await unlink(join(root, 'watch.lock'));
  await writeFile(join(root, 'watch.lock.reclaim'), 'claim', { mode: 0o600 });
  assert.equal((await inspectServiceStart(root, reused)).blockers[0].code, 'recovery-claim-present');
  assert.equal((await inspectServiceStart(root, { ...reused, now: () => Date.now() + 61_000 })).allowed, true);
});

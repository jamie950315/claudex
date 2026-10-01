import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedProcessTracker, inspectOwnedProcesses, readCollaborationProcessTable, signalOwnedProcesses } from '../src/collaboration-processes.mjs';

const row = (pid, ppid, pgid = pid, startedAt = 'Wed Sep 30 20:00:00 2026') =>
  ({ pid, ppid, pgid, uid: process.getuid(), startedAt });

test('native process metadata contains identity fields without arguments or environment', async () => {
  const rows = await readCollaborationProcessTable();
  const current = rows.find(row => row.pid === process.pid);
  assert.ok(current);
  assert.deepEqual(Object.keys(current), ['pid', 'ppid', 'pgid', 'uid', 'startedAt']);
});

test('separate process groups are owned only through exact native ancestry and drained after reparenting', async () => {
  let table = [row(42, 10), row(43, 42), row(44, 43), row(99, 10)];
  const saved = [], signals = [];
  const tracker = await createOwnedProcessTracker({ pid: 42, monitor: false, readTable: async () => table,
    onChange: records => saved.push(records), signalProcess: (pid, signal) => {
      signals.push({ pid, signal }); table = table.filter(row => row.pid !== pid);
    } });
  assert.deepEqual(tracker.records.map(row => row.pid), [42, 43, 44]);
  assert.equal(saved.length, 1);
  table = [row(43, 1), row(44, 43), row(99, 10)];
  assert.equal(await tracker.stopped(), false);
  await tracker.signal('SIGTERM');
  assert.deepEqual(signals, [{ pid: 44, signal: 'SIGTERM' }, { pid: 43, signal: 'SIGTERM' }]);
  assert.equal(await tracker.stopped(), true);
  assert.deepEqual(table.map(row => row.pid), [99]);
  await tracker.close();
});

test('PID reuse never signals a different process start identity or process group', async () => {
  let table = [row(42, 10), row(43, 42)];
  const signals = [];
  const tracker = await createOwnedProcessTracker({ pid: 42, monitor: false, readTable: async () => table,
    signalProcess: pid => signals.push(pid) });
  table = [row(43, 1, 43, 'Wed Sep 30 20:00:01 2026')];
  assert.equal(await tracker.stopped(), true);
  await tracker.signal('SIGKILL');
  assert.deepEqual(signals, []);
  assert.equal((await inspectOwnedProcesses(tracker.records, async () => table)).processes.every(row => row.absent), true);
  await tracker.close();
});

test('inventory failure cannot prove that recorded native descendants stopped', async () => {
  let failure;
  const tracker = await createOwnedProcessTracker({ pid: 42, monitor: false,
    readTable: async () => { if (failure) throw failure; return [row(42, 10)]; } });
  failure = new Error('Metadata permission denied');
  await assert.rejects(tracker.stopped(), /Metadata permission denied/);
  await assert.rejects(tracker.signal('SIGTERM'), /Metadata permission denied/);
  await tracker.close();
});

test('a reused descendant PID is a new birth identity after the recorded one is proven absent', async () => {
  let table = [row(42, 10), row(43, 42)];
  const saved = [];
  const tracker = await createOwnedProcessTracker({ pid: 42, monitor: false, readTable: async () => table,
    onChange: records => saved.push(records) });
  table = [row(42, 10), row(43, 42, 43, 'Wed Sep 30 20:00:01 2026')];
  await tracker.refresh();
  assert.deepEqual(tracker.records.map(row => row.startedAt),
    ['Wed Sep 30 20:00:00 2026', 'Wed Sep 30 20:00:01 2026']);
  assert.equal(saved.length, 2);
  await tracker.close();
});

test('a reused leader PID under the owned tree remains an explicit ownership failure', async () => {
  let table = [row(42, 10, 42), row(43, 42, 42)];
  const tracker = await createOwnedProcessTracker({ pid: 42, monitor: false, readTable: async () => table });
  table = [row(43, 1, 42), row(42, 43, 42, 'Wed Sep 30 20:00:01 2026')];
  await assert.rejects(tracker.refresh(), /identity changed/);
  await assert.rejects(tracker.close(), /identity changed/);
});

test('exited descendants retire so a long invocation can exceed the bound sequentially', async () => {
  // Test runners and tools spawn many short-lived children over one invocation.
  let table = [row(42, 10)];
  const saved = [];
  const tracker = await createOwnedProcessTracker({ pid: 42, monitor: false, readTable: async () => table,
    onChange: records => saved.push(records) });
  for (let pid = 1000; pid < 1600; pid++) {
    table = [row(42, 10), row(pid, 42), row(pid + 10000, pid, pid + 10000)];
    await tracker.refresh();
  }
  assert.deepEqual(tracker.records.map(row => row.pid), [42, 1599, 11599]);
  assert.ok(saved.every(records => records.length <= 3 && records[0].pid === 42));
  table = [row(42, 10), row(11599, 1, 11599)];
  assert.equal(await tracker.stopped(), false);
  table = [];
  assert.equal(await tracker.stopped(), true);
  assert.deepEqual(tracker.records.map(row => row.pid), [42]);
  await tracker.close();
});

test('concurrently unresolved descendants remain bounded', async () => {
  let table = [row(42, 10)];
  const tracker = await createOwnedProcessTracker({ pid: 42, monitor: false, readTable: async () => table });
  table = [row(42, 10), ...Array.from({ length: 256 }, (_, index) => row(1000 + index, 42))];
  await assert.rejects(tracker.refresh(), /exceeded its bound/);
  await assert.rejects(tracker.close(), /exceeded its bound/);
});

test('a live recorded identity that changes process group cannot become absence or a new signal target', async () => {
  const records = [row(42, 10), row(43, 42)];
  const table = [row(43, 1, 99)];
  await assert.rejects(inspectOwnedProcesses(records, async () => table), /changed its process group/);
  const signals = [];
  await assert.rejects(signalOwnedProcesses(records, 'SIGTERM', async () => table, pid => signals.push(pid)), /changed its process group/);
  assert.deepEqual(signals, []);
});

test('process birth metadata is stable when the caller changes its timezone environment', async () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const first = (await readCollaborationProcessTable()).find(row => row.pid === process.pid);
    process.env.TZ = 'Asia/Taipei';
    const second = (await readCollaborationProcessTable()).find(row => row.pid === process.pid);
    assert.equal(first.startedAt, second.startedAt);
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDesktopSafely } from '../src/desktop-shutdown.mjs';

test('safe shutdown keeps a native owner until its own busy guard clears', async () => {
  let closes = 0, waits = 0;
  const periods = [];
  await closeDesktopSafely({ async close() {
    closes++;
    if (closes < 3) throw new Error('Claude owner is busy; refusing to interrupt user work.');
  } }, { sleep: async ms => { periods.push(ms); }, onWaiting: async () => { waits++; } });
  assert.equal(closes, 3); assert.equal(waits, 2); assert.deepEqual(periods, [5000, 5000]);
});

test('unknown shutdown errors are not relabeled as safe busy retries', async () => {
  await assert.rejects(closeDesktopSafely({ async close() { throw new Error('Unexpected close failure'); } }, {
    sleep: async () => assert.fail('Unknown failures must not retry'),
  }), /Unexpected close failure/);
});

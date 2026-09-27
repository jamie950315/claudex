import { setTimeout as delay } from 'node:timers/promises';

/** A stop request must not become a timer-based kill of a live native turn.
 * Retry only the owner's explicit busy refusal; unknown close failures remain
 * errors. The native owner rechecks its complete lifecycle on every attempt.
 */
export async function closeDesktopSafely(runtime, { sleep = delay, onWaiting = async () => {} } = {}) {
  while (true) {
    try { await runtime.close(); return; }
    catch (error) {
      if (error.message !== 'Claude owner is busy; refusing to interrupt user work.') throw error;
      await onWaiting(error);
      await sleep(5000);
    }
  }
}

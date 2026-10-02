import { readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir, privateJSON, writeReceipt, syncDir } from './claude-mod-storage.mjs';
import { validateRequest, insist, sameContext } from './claude-mod-protocol.mjs';

/** Only receipt publication is retried. A native send is never repeated here. */
export function createWakeOutbox(root, publish) {
  const directory = join(root, 'mod-wake-receipts');
  function checked(value) {
    insist(value?.version === 1 && value.request?.op === 'wake-receipt', 'INVALID_RECEIPT');
    return validateRequest(value.request);
  }
  async function flush(path, request) {
    const result = await publish(request);
    insist(result?.messageId === request.messageId && result.targetProvider === 'claude'
      && result.targetSessionId === request.target.sessionId && result.wakeRoute === 'mod'
      && ['offered', 'acknowledged'].includes(result.state)
      && result.wake?.claimId === request.claimId && result.wake.state === request.status
      && result.wake.source && sameContext(result.wake.source, request.context),
    'INVALID_RECEIPT', 'The broker did not confirm this exact native delivery outcome. Pending evidence was retained.');
    const done = join(directory, `${request.claimId}.done.json`);
    const completed = await privateJSON(done, { optional: true });
    if (completed) insist(JSON.stringify(checked(completed)) === JSON.stringify(request), 'INVALID_RECEIPT');
    try { await rename(path, done); await syncDir(directory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const saved = checked(await privateJSON(done));
      insist(JSON.stringify(saved) === JSON.stringify(request), 'INVALID_RECEIPT');
    }
    return result;
  }
  return {
    async record(request) {
      await privateDir(directory, true);
      request = checked({ version: 1, request });
      const path = join(directory, `${request.claimId}.pending.json`);
      const done = join(directory, `${request.claimId}.done.json`);
      const completed = await privateJSON(done, { optional: true });
      if (completed) { insist(JSON.stringify(checked(completed)) === JSON.stringify(request), 'INVALID_RECEIPT'); return { recorded: true }; }
      const saved = await privateJSON(path, { optional: true });
      if (saved) insist(JSON.stringify(checked(saved)) === JSON.stringify(request), 'INVALID_RECEIPT');
      else {
        insist((await readdir(directory)).filter(name => name.endsWith('.json')).length < 2048, 'JOURNAL_FULL');
        try { await writeReceipt(path, { version: 1, request }, { exclusive: true }); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          insist(JSON.stringify(checked(await privateJSON(path))) === JSON.stringify(request), 'INVALID_RECEIPT');
        }
      }
      return flush(path, request);
    },
    async recover() {
      await privateDir(directory, true);
      const names = (await readdir(directory)).filter(name => /^[a-f0-9-]{36}\.pending\.json$/.test(name));
      insist(names.length <= 2048, 'JOURNAL_FULL');
      for (const name of names.slice(0, 4)) {
        const path = join(directory, name), saved = await privateJSON(path, { optional: true });
        if (!saved) continue;
        const request = checked(saved);
        insist(name === `${request.claimId}.pending.json`, 'INVALID_RECEIPT');
        if (await privateJSON(path, { optional: true })) await flush(path, request);
      }
      return { remaining: Math.max(0, names.length - 4) };
    },
  };
}

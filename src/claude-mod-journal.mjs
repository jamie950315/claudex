import { lstat, opendir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateDir, privateJSON, privateRead, writeReceipt, syncDir, exclusiveAction } from './claude-mod-storage.mjs';
import { insist, validateRequest, sameContext } from './claude-mod-protocol.mjs';

export const MOD_JOURNAL_LIMIT = 2048;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const kinds = {
  actions: { directory: 'mod-companion', pattern: new RegExp(`^(${uuid})\\.json$`) },
  selfDispatch: { directory: 'mod-self-dispatch', pattern: new RegExp(`^(${uuid})\\.json$`) },
  wakeOutbox: { directory: 'mod-wake-receipts', pattern: new RegExp(`^(${uuid})\\.(pending|done)\\.json$`) },
};
async function existsDirectory(directory) {
  try { await privateDir(directory); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
/** Archives use exact filenames, never a scan or an expiry-based replay rule. */
export async function readModJournal(directory, name, { optional = false, maxBytes = 2 * 1024 * 1024 } = {}) {
  await privateDir(directory);
  const active = await privateJSON(join(directory, name), { optional: true, maxBytes });
  if (active !== null) return active;
  const archive = join(directory, 'archive');
  const saved = await existsDirectory(archive) ? await privateJSON(join(archive, name), { optional: true, maxBytes }) : null;
  insist(optional || saved !== null, 'INVALID_RECEIPT', 'The exact receipt is unavailable; preserve storage for inspection.');
  return saved;
}
async function entries(directory, pattern) {
  const names = [];
  let count = 0;
  for await (const entry of await opendir(directory)) {
    // Legacy action intent pointers remain readable in the root. New pointers
    // live in intents/, so retention never scans an ever-growing index/archive.
    insist(++count <= MOD_JOURNAL_LIMIT * 4 + 32, 'JOURNAL_CAPACITY_EXHAUSTED', 'Receipt storage has too many active entries. Inspect its private journal.');
    if (pattern.test(entry.name)) names.push(entry.name);
  }
  insist(names.length <= MOD_JOURNAL_LIMIT, 'JOURNAL_CAPACITY_EXHAUSTED', 'Receipt storage exceeds its active-record bound.');
  return names.sort();
}
async function settled(root, kind, value, name, now) {
  insist(value?.version === 1, 'INVALID_RECEIPT');
  if (kind === 'actions') {
    insist(name === `${value.id}.json` && ['prepared', 'dispatching', 'completed', 'uncertain'].includes(value.state)
      && Number.isSafeInteger(value.preparedAt) && Number.isSafeInteger(value.expiresAt), 'INVALID_RECEIPT');
    return value.state === 'completed' ? value.finishedAt ?? value.preparedAt
      : value.state === 'prepared' && value.expiresAt <= now ? value.expiresAt : null;
  }
  if (kind === 'wakeOutbox') {
    const request = validateRequest(value.request);
    insist(request.op === 'wake-receipt' && name === `${request.claimId}.${name.endsWith('.done.json') ? 'done' : 'pending'}.json`, 'INVALID_RECEIPT');
    return name.endsWith('.done.json') && request.status !== 'uncertain' ? 0 : null;
  }
  const id = value.identity;
  // Reuse the native request validator, including exact self-context and route.
  validateRequest({ version: 1, op: 'wake-self-send', ...id });
  insist(name === `${id.claimId}.json`, 'INVALID_RECEIPT');
  if (value.outcome?.state === 'rejected') return 0; // Proven pre-write refusal.
  if (value.outcome?.state !== 'submitted') return null;
  const outbox = join(root, kinds.wakeOutbox.directory);
  if (!await existsDirectory(outbox)) return null;
  const done = await readModJournal(outbox, `${id.claimId}.done.json`, { optional: true });
  if (!done) return null;
  const request = validateRequest(done.request);
  insist(done.version === 1 && request.op === 'wake-receipt' && request.claimId === id.claimId && request.messageId === id.messageId
    && request.route === id.route && sameContext(request.context, id.context) && sameContext(request.target, id.target), 'INVALID_RECEIPT');
  return request.status === 'submitted' ? 0 : null;
}
async function archiveReceipt(directory, name, expected) {
  const path = join(directory, name), archive = join(directory, 'archive');
  await privateDir(archive, true);
  const before = await lstat(path, { bigint: true });
  const raw = await privateRead(path, { maxBytes: 2 * 1024 * 1024 });
  insist(JSON.stringify(JSON.parse(raw)) === JSON.stringify(expected), 'FILE_CHANGED');
  const destination = join(archive, name);
  const old = await privateJSON(destination, { optional: true, maxBytes: 2 * 1024 * 1024 });
  if (old === null) {
    // The journal lock serializes archive publishers. Keep an incomplete write
    // under a temporary name, never at the exact lookup pathname.
    const temporary = join(archive, `.archive-${randomUUID()}.tmp`);
    await writeReceipt(temporary, expected, { exclusive: true });
    await rename(temporary, destination); await syncDir(archive);
  }
  else insist(JSON.stringify(old) === JSON.stringify(expected), 'INVALID_RECEIPT', 'Archived and active receipts disagree. Preserve both.');
  // Publication and directory sync precede removal. An interrupted duplicate is
  // verified again on the next capacity request; lookup works on either side.
  const current = await lstat(path, { bigint: true });
  insist(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].every(key => current[key] === before[key]), 'FILE_CHANGED');
  await unlink(path); await syncDir(directory);
}
export function createModJournal(root, kind, { now = Date.now, validate = value => value } = {}) {
  const spec = kinds[kind], directory = join(root, spec.directory);
  const names = () => entries(directory, spec.pattern);
  const locked = operation => exclusiveAction(join(directory, '.journal.lock'), operation, { recoverDead: true });
  return {
    directory,
    read: (name, options) => readModJournal(directory, name, options),
    async transaction(operation) { await privateDir(directory, true); return locked(operation); },
    /** Call inside transaction, before publishing exactly one new active file. */
    async reserve() {
      const active = await names();
      if (active.length < MOD_JOURNAL_LIMIT) return;
      const candidates = [];
      for (const name of active) {
        const value = await privateJSON(join(directory, name), { maxBytes: 2 * 1024 * 1024 });
        validate(value, name);
        const at = await settled(root, kind, value, name, now());
        if (at !== null) candidates.push({ name, at });
      }
      candidates.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
      for (const candidate of candidates) {
        const id = candidate.name.match(spec.pattern)[1];
        const retired = await exclusiveAction(join(directory, `${id}.lock`), async () => {
          const value = await privateJSON(join(directory, candidate.name), { optional: true, maxBytes: 2 * 1024 * 1024 });
          if (!value) return false;
          validate(value, candidate.name);
          if (await settled(root, kind, value, candidate.name, now()) === null) return false;
          await archiveReceipt(directory, candidate.name, value); return true;
        });
        if (retired === true) return;
      }
      insist(false, 'JOURNAL_CAPACITY_EXHAUSTED', 'Receipt storage is full with pending, uncertain or locked records. Preserve them; inspect journal capacity.');
    },
    async inspect() {
      if (!await existsDirectory(directory)) return { state: 'available', active: 0, limit: MOD_JOURNAL_LIMIT, remaining: MOD_JOURNAL_LIMIT, settled: 0, protected: 0 };
      const active = await names(); let removable = 0;
      for (const name of active) {
        const value = await privateJSON(join(directory, name), { maxBytes: 2 * 1024 * 1024 });
        validate(value, name);
        const lock = await lstat(join(directory, `${name.match(spec.pattern)[1]}.lock`)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (!lock && await settled(root, kind, value, name, now()) !== null) removable++;
      }
      return { state: active.length < MOD_JOURNAL_LIMIT ? 'available' : removable ? 'retention-available' : 'capacity-exhausted',
        active: active.length, limit: MOD_JOURNAL_LIMIT, remaining: MOD_JOURNAL_LIMIT - active.length,
        settled: removable, protected: active.length - removable, archiveLookup: 'exact', automaticReplay: false };
    },
  };
}
export async function inspectModJournals(root, options) {
  const journals = {};
  for (const kind of Object.keys(kinds)) {
    try { journals[kind] = await createModJournal(root, kind, options).inspect(); }
    catch (error) { journals[kind] = { state: 'unavailable', reason: ['UNSAFE_ROOT', 'UNSAFE_FILE', 'FILE_CHANGED', 'JOURNAL_CAPACITY_EXHAUSTED'].includes(error.code)
      ? error.code : 'INVALID_RECEIPT' }; }
  }
  return { diagnosticOnly: true, ...journals };
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_OWNED = 256;
const sameBirth = (left, right) => left && right && left.pid === right.pid && left.uid === right.uid
  && left.startedAt === right.startedAt;
const same = (left, right) => {
  if (sameBirth(left, right) && left.pgid !== right.pgid)
    throw new Error('Owned native process changed its process group; its exit cannot be established.');
  return sameBirth(left, right);
};

/** Metadata only: never inspect process arguments, environment or native input. */
export async function readCollaborationProcessTable() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Native process inspection is unsupported.');
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart='],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 1024 * 1024, timeout: 5000 });
  const rows = stdout.trim().split('\n');
  if (rows.length > 16384) throw new Error('Native process inventory exceeded its bound.');
  return rows.filter(row => row.trim()).map(row => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(row);
    if (!match) throw new Error('Native process inventory contains malformed metadata.');
    const [pid, ppid, pgid, uid] = match.slice(1, 5).map(Number);
    if (![pid, ppid, pgid, uid].every(Number.isSafeInteger) || pid < 1 || ppid < 0 || pgid < 0 || uid < 0)
      throw new Error('Native process inventory contains invalid identities.');
    return { pid, ppid, pgid, uid, startedAt: match[5].replace(/\s+/g, ' ') };
  });
}

export function validateOwnedProcesses(records) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_OWNED)
    throw new Error('Recorded native process identities are missing or exceed their bound.');
  const pids = new Set();
  for (const row of records) {
    if (!row || !['pid', 'ppid', 'pgid', 'uid'].every(key => Number.isSafeInteger(row[key]))
      || row.pid <= 1 || row.ppid < 0 || row.pgid < 1 || row.uid !== process.getuid()
      || typeof row.startedAt !== 'string' || !/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(row.startedAt)
      || pids.has(row.pid)) throw new Error('Recorded native process identities are unsafe.');
    pids.add(row.pid);
  }
  return records;
}

export async function inspectOwnedProcesses(records, readTable = readCollaborationProcessTable) {
  validateOwnedProcesses(records);
  const table = new Map((await readTable()).map(row => [row.pid, row]));
  return { inspectedAt: Date.now(), processes: records.map(record => ({ ...record, absent: !same(record, table.get(record.pid)),
    // A process-group identifier reserves its leader PID while that group
    // exists. A different birth at the leader PID proves reuse, not survival
    // of the old owned group (including reuse by a system process after reboot).
    ...(record.pid === record.pgid ? { groupAbsent: ![...table.values()].some(row => row.pgid === record.pgid)
      || Boolean(table.get(record.pid) && !sameBirth(record, table.get(record.pid))) } : {}),
  })) };
}

export async function signalOwnedProcesses(records, signal, readTable = readCollaborationProcessTable,
  signalProcess = (pid, signal) => process.kill(pid, signal)) {
  validateOwnedProcesses(records);
  for (const saved of [...records].reverse()) {
    const current = new Map((await readTable()).map(row => [row.pid, row]));
    if (!same(saved, current.get(saved.pid))) continue;
    try { signalProcess(saved.pid, signal); }
    catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
  }
}

// One metadata sampler per broker process, including when many workers are active.
const subscribers = new Set();
let samplerTimer, sampling = false, unreadableSince = null;
const UNREADABLE_TABLE_MS = 10_000;
/** One unreadable process table is not evidence about any worker. Only a
 * table that stays unreadable ends tracking; each tracker's own identity
 * checks still fail immediately on a readable table. */
export async function sampleOwnedProcesses({ read = readCollaborationProcessTable, now = Date.now } = {}) {
  if (sampling || !subscribers.size) return;
  sampling = true;
  try {
    let table;
    try { table = await read(); unreadableSince = null; }
    catch (error) {
      unreadableSince ??= now();
      if (now() - unreadableSince >= UNREADABLE_TABLE_MS) for (const subscriber of subscribers) subscriber.fail(error);
      return;
    }
    await Promise.allSettled([...subscribers].map(subscriber => subscriber.accept(table)));
  } finally { sampling = false; }
}
function subscribe(subscriber) {
  subscribers.add(subscriber);
  if (subscribers.size === 1) unreadableSince = null;
  samplerTimer ??= setInterval(() => sampleOwnedProcesses(), 250);
  samplerTimer.unref();
  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) { clearInterval(samplerTimer); samplerTimer = null; }
  };
}

/** Track only descendants of an exact owned native identity, including other PGIDs. */
export async function createOwnedProcessTracker({ pid, onChange, onError,
  readTable = readCollaborationProcessTable, signalProcess = (pid, signal) => process.kill(pid, signal),
  monitor = true } = {}) {
  let records = [], serial = Promise.resolve(), error, disposed = false, published = false;
  const fail = cause => { if (!error) { error = cause; onError?.(cause); } };
  const accept = table => {
    const operation = serial.then(async () => {
      if (disposed || error) return;
      const current = new Map(table.map(row => [row.pid, row]));
      if (!records.length) {
        const root = current.get(pid);
        if (!root || root.uid !== process.getuid() || root.pgid !== pid)
          throw new Error('Native leader identity could not be verified.');
        records.push(root);
      }
      const live = new Set(records.filter(row => same(row, current.get(row.pid))).map(row => row.pid));
      // A descendant whose birth identity is absent from a complete sample has
      // exited; retire it so the bound covers unresolved processes, not every
      // short-lived test or tool process of a long invocation. The leader stays.
      const retained = records.filter((row, index) => index === 0 || live.has(row.pid));
      const retired = records.length - retained.length;
      records = retained;
      const added = [];
      for (let changed = true; changed;) {
        changed = false;
        for (const row of table) if (!live.has(row.pid) && row.uid === process.getuid() && live.has(row.ppid)) {
          if (records.some(saved => saved.pid === row.pid))
            throw new Error('Owned native process identity changed before its descendants were inspected.');
          if (records.length >= MAX_OWNED) throw new Error('Owned native process inventory exceeded its bound.');
          records.push(row); added.push(row); live.add(row.pid); changed = true;
        }
      }
      if (added.length || retired || !published) { await onChange?.(structuredClone(records)); published = true; }
    });
    serial = operation.catch(fail);
    return operation;
  };
  await accept(await readTable());
  let unsubscribe = monitor ? subscribe({ accept, fail }) : () => {};
  const refresh = async () => {
    if (error) throw error;
    await accept(await readTable());
    if (error) throw error;
  };
  return {
    get records() { return structuredClone(records); },
    refresh,
    signal: async signal => {
      await refresh();
      // Children first: each individual signal requires freshly matching PID/start/PGID/UID.
      await signalOwnedProcesses(records, signal, readTable, signalProcess);
    },
    stopped: async () => {
      await refresh();
      return (await inspectOwnedProcesses(records, readTable)).processes.every(row => row.absent);
    },
    close: async () => {
      unsubscribe(); disposed = true; await serial;
      if (error) throw error;
    },
  };
}

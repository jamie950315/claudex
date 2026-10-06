import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, processStartedAt, withLock, writeDiagnosticJSON } from './storage.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OWNER_LOCK = /^[a-f0-9]{64}\.json\.lock$/;
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;

export function processAlive(pid) {
  if (!validPid(pid)) throw new Error('Invalid service process identity.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

/** Metadata of processes that lost their parent: PID, start time and executable name. */
export async function orphanedProcesses() {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart=,comm='],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
  return stdout.split('\n').flatMap(row => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/.exec(row);
    return match && Number(match[2]) === 1 && Number(match[3]) === process.getuid()
      ? [{ pid: Number(match[1]), startedAt: Date.parse(`${match[4]} UTC`), command: match[5] }] : [];
  });
}

// This is a read-only prerequisite, not a writer lease. Native acquisition
// must still win its own exclusive lock and recheck all durable pending work.
async function privateJSON(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077)
        || before.nlink !== 1 || before.size > 65536) throw new Error('Unverified service state file.');
    const text = await file.readFile('utf8');
    const after = await file.stat(), current = await lstat(path);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])
        || after.ino !== current.ino || after.dev !== current.dev) throw new Error('Service state changed during inspection.');
    return JSON.parse(text);
  } finally { await file.close(); }
}

export async function inspectServiceStart(root, { alive = processAlive, startedAt = processStartedAt, orphans = orphanedProcesses, includeSupervisor = false, now = Date.now } = {}) {
  const blockers = [];
  const add = (kind, code, extra = {}) => blockers.push({ kind, code, ...extra });
  // A PID is reused after its process exits, typically after a restart. A
  // process born after the lock was last written cannot be its holder.
  const holds = async (pid, writtenAt) => {
    if (!alive(pid)) return false;
    const born = await startedAt(pid);
    return !(born !== null && Number.isFinite(writtenAt) && born > writtenAt + 2000);
  };
  const inspect = async (path, kind, owner = false) => {
    try {
      const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      // The holder publishes itself right after exclusive creation. A lock
      // still empty after a minute was left by a process that died in
      // between, and exclusive acquisition reclaims it.
      if (!owner && info?.isFile() && info.size === 0 && now() - Math.floor(info.mtimeMs) >= 60_000) return;
      const value = await privateJSON(path);
      if (value === null) return;
      const writtenAt = owner ? Math.floor(info?.mtimeMs ?? NaN) : Date.parse(value.started);
      if (!validPid(value.pid) || (owner
        ? !UUID.test(value.nonce ?? '') || (value.childPid !== null && !validPid(value.childPid))
        : typeof value.started !== 'string' || !Number.isFinite(Date.parse(value.started)))) {
        add(kind, 'malformed-lock'); return;
      }
      if (await holds(value.pid, writtenAt)) add(kind, 'live-owner', { pid: value.pid });
      else if (owner && value.childPid !== null && await holds(value.childPid, writtenAt)) add(kind, 'live-native-child', { childPid: value.childPid });
      // The former parent can die between spawn() and persisting childPid.
      // An absent child identity is not proof that no native writer exists,
      // but such a child would now be a parentless process under a Claude
      // path (the CLI binary itself is named by its version) born right
      // after this lock. Without one, native acquisition reclaims the lock.
      else if (owner && value.childPid === null) {
        const created = Math.floor(info.birthtimeMs);
        if ((await orphans()).some(row => /claude/i.test(row.command) && row.startedAt >= created - 2000 && row.startedAt <= writtenAt + 120_000))
          add(kind, 'unrecorded-native-child');
      }
    } catch { add(kind, 'unverified-lock'); }
  };
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()
      || (directory.mode & 0o077)) return { allowed: false, blockerCount: 1, blockers: [{ kind: 'ownership', code: 'unverified-root' }] };
  const roots = [['watch.lock', 'watcher'], ['desktop-operation.lock', 'operation'], ['operation.lock', 'operation']];
  if (includeSupervisor) roots.push(['service-supervisor.lock', 'supervisor']);
  for (const [name, kind] of roots) {
    await inspect(join(root, name), kind);
    // Recovery takes milliseconds; a claim left for a minute was abandoned
    // and exclusive acquisition removes it.
    try { if (now() - Math.floor((await lstat(join(root, `${name}.reclaim`))).ctimeMs) < 60_000) add(kind, 'recovery-claim-present'); }
    catch (error) { if (error.code !== 'ENOENT') add(kind, 'unverified-recovery-claim'); }
  }
  const ownerRoot = join(root, 'owners');
  try {
    const ownerDirectory = await lstat(ownerRoot);
    if (!ownerDirectory.isDirectory() || ownerDirectory.isSymbolicLink() || ownerDirectory.uid !== process.getuid()
        || (ownerDirectory.mode & 0o077)) throw new Error('Unverified native owner directory.');
    const entries = await readdir(ownerRoot);
    if (entries.length > 16384) throw new Error('Native owner directory exceeds the inspection bound.');
    for (const name of entries) {
      if (OWNER_LOCK.test(name)) await inspect(join(ownerRoot, name), 'claude-owner', true);
      else if (name.endsWith('.lock') || name.endsWith('.lock.reap')) add('claude-owner', 'unverified-lock-name-or-recovery-claim');
    }
  } catch (error) { if (error.code !== 'ENOENT') add('ownership', 'unverified-owner-directory'); }
  return { allowed: blockers.length === 0, blockerCount: blockers.length, blockers: blockers.slice(0, 20) };
}

export function serviceRestartDelay(failures) {
  return Math.min(60000, 5000 * (2 ** Math.min(4, Math.max(0, failures - 1))));
}

function startWatcher({ node, cli, root }) {
  // A launchd supervisor crash must not sweep up an active native writer's
  // process group. AbandonProcessGroup in the plist is the matching policy.
  const child = spawn(node, [cli, 'watch', '--root', root], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  const done = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
  return { get pid() { return child.pid ?? null; }, done, stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); } };
}

export async function runServiceSupervisor({ root, cli, node = process.execPath, signal,
  now = Date.now, sleep = delay, launch = startWatcher, inspect = inspectServiceStart,
  heartbeatMs = 5000, checkMs = 5000, stableMs = 120000, restartDelay = serviceRestartDelay } = {}) {
  root = await privateDirectory(root);
  return withLock(join(root, 'service-supervisor.lock'), async () => {
    const statusPath = join(root, 'service-status.json');
    const status = { version: 1, kind: 'claudex-service', pid: process.pid, startedAt: now(), updatedAt: now(),
      state: 'starting', watcherPid: null, restartCount: 0, consecutiveFailures: 0, autoRestart: true,
      nextAttemptAt: null, lastExit: null, blockerCount: 0, blockers: [] };
    const publish = async fields => { Object.assign(status, fields, { updatedAt: now() }); await writeDiagnosticJSON(statusPath, status); };
    const wait = async ms => {
      try { await sleep(ms, undefined, { signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    };
    let child = null;
    const stop = () => child?.stop();
    signal?.addEventListener('abort', stop);
    try {
      await publish({});
      while (!signal?.aborted) {
        const check = await inspect(root);
        if (!check.allowed) {
          await publish({ state: 'blocked', watcherPid: null, blockerCount: check.blockerCount,
            blockers: check.blockers, nextAttemptAt: now() + checkMs });
          await wait(checkMs); continue;
        }
        await publish({ state: 'starting', blockerCount: 0, blockers: [], nextAttemptAt: null });
        if (signal?.aborted) break;
        const launchedAt = now();
        try { child = launch({ root, cli, node }); }
        catch (error) { child = { pid: null, done: Promise.resolve({ code: null, signal: null, error: error.message }), stop() {} }; }
        const watched = child;
        if (signal?.aborted) watched.stop();
        let outcome;
        const completed = watched.done.then(result => { outcome = result; });
        await publish({ state: signal?.aborted ? 'stopping' : 'running', watcherPid: watched.pid });
        while (!outcome) {
          // Do not abort this wait during graceful shutdown: a busy native
          // owner may legitimately keep the watcher alive until it is idle.
          const heartbeat = new AbortController();
          try {
            await Promise.race([completed, sleep(heartbeatMs, undefined, { signal: heartbeat.signal })]);
          } finally { heartbeat.abort(); }
          if (!outcome) await publish({ state: signal?.aborted ? 'stopping' : 'running' });
        }
        child = null;
        let error = outcome.error;
        try {
          const watcher = await privateJSON(join(root, 'watcher-status.json'));
          if (watcher?.pid === watched.pid && typeof watcher.error === 'string') error = watcher.error.slice(0, 2000);
        } catch { /* A malformed diagnostic cannot authorize writes or alter pending recovery. */ }
        const lastExit = { pid: watched.pid, code: outcome.code, signal: outcome.signal, at: now(), runtimeMs: now() - launchedAt, error };
        await publish({ watcherPid: null, lastExit });
        if (signal?.aborted || outcome.code === 0) break;
        status.consecutiveFailures = lastExit.runtimeMs >= stableMs ? 1 : status.consecutiveFailures + 1;
        status.restartCount++;
        const backoff = restartDelay(status.consecutiveFailures);
        await publish({ state: 'backoff', nextAttemptAt: now() + backoff });
        await wait(backoff);
        // Restart the process only. It must recover its existing durable
        // transaction normally; no pending state or lock is cleared here.
      }
      await publish({ state: 'stopped', watcherPid: null, nextAttemptAt: null });
      return status;
    } finally { signal?.removeEventListener('abort', stop); }
  }, { recoverDead: true });
}

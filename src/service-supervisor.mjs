import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, withLock, writeDiagnosticJSON } from './storage.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OWNER_LOCK = /^[a-f0-9]{64}\.json\.lock$/;
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;

export function processAlive(pid) {
  if (!validPid(pid)) throw new Error('Invalid service process identity.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

// This is a read-only prerequisite, not a writer lease. Native acquisition
// must still win its own exclusive lock and recheck all durable pending work.
async function privateJSON(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
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

export async function inspectServiceStart(root, { alive = processAlive, includeSupervisor = false } = {}) {
  const blockers = [];
  const add = (kind, code, extra = {}) => blockers.push({ kind, code, ...extra });
  const inspect = async (path, kind, owner = false) => {
    try {
      const value = await privateJSON(path);
      if (value === null) return;
      if (!validPid(value.pid) || (owner
        ? !UUID.test(value.nonce ?? '') || (value.childPid !== null && !validPid(value.childPid))
        : typeof value.started !== 'string' || !Number.isFinite(Date.parse(value.started)))) {
        add(kind, 'malformed-lock'); return;
      }
      if (alive(value.pid)) add(kind, 'live-owner', { pid: value.pid });
      else if (owner && value.childPid !== null && alive(value.childPid)) add(kind, 'live-native-child', { childPid: value.childPid });
      // The former parent can die between spawn() and persisting childPid.
      // An absent child identity is not proof that no native writer exists.
      else if (owner && value.childPid === null) add(kind, 'unrecorded-native-child');
    } catch { add(kind, 'unverified-lock'); }
  };
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()
      || (directory.mode & 0o077)) return { allowed: false, blockerCount: 1, blockers: [{ kind: 'ownership', code: 'unverified-root' }] };
  const roots = [['watch.lock', 'watcher'], ['desktop-operation.lock', 'operation'], ['operation.lock', 'operation']];
  if (includeSupervisor) roots.push(['service-supervisor.lock', 'supervisor']);
  for (const [name, kind] of roots) {
    await inspect(join(root, name), kind);
    try { await lstat(join(root, `${name}.reclaim`)); add(kind, 'recovery-claim-present'); }
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

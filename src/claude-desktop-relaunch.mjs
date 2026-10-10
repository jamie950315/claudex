import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readAppStopState } from './app-stop-state.mjs';
import { readJSON, writeJSON, writeDiagnosticJSON } from './storage.mjs';
import { parseProcesses } from './codex-desktop-relaunch.mjs';

const execute = promisify(execFile);
export const CLAUDE_DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop';

/** A Claude Desktop start that fetches a new frontend evaluates it before the
 * cache watcher can patch it, so the adapters stay unloaded until the next
 * start. By user decision that next start is made automatically, once, while
 * the application has only just been opened: nothing has been sent and the
 * process is younger than `windowMs`. Outside
 * that window the resource stays restart-required and nothing is restarted;
 * that decision carries the time of the last write, so a reader can tell the
 * user to restart and stop saying so once Desktop has been started after it.
 * It never force-quits, restarts at most twice in ten minutes, never asks again
 * after a declined quit and never touches native histories or sessions.
 */
export function createClaudeDesktopRelaunch({ root, run = execute, now = () => Date.now(), windowMs = 60_000,
  quitTimeoutMs = 60_000, sleep = delay, stopState = readAppStopState, alive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  } } = {}) {
  if (!root || !Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 600_000) throw new Error('Invalid Claude relaunch configuration.');
  const recordPath = join(root, 'claude-relaunch.json'), statusPath = join(root, 'claude-relaunch-status.json');
  // Adapters newly written for one entry and the time of the last write. A
  // resource found already installed may have been loaded and proves nothing to
  // repair. The record keeps them, so a watcher restart before the Desktop
  // restart neither forgets the request nor the automatic restart.
  let pending = null, loaded = false;
  let last = null;
  const report = async value => {
    const key = JSON.stringify(value);
    if (key !== last) { last = key; await writeDiagnosticJSON(statusPath, { ...value, updatedAt: now() }); }
    return value;
  };
  const text = async (command, args) => (await run(command, args)).stdout.trim();

  async function consider(summary, { automatic = true } = {}) {
    const entry = summary?.entry?.asset, adapters = Object.entries(summary?.adapters ?? {});
    if (typeof entry !== 'string' || !adapters.length) return null;
    const record = await readJSON(recordPath, { version: 1, attempts: [] });
    let attempts = Array.isArray(record?.attempts) ? record.attempts : [];
    if (!loaded) {
      loaded = true;
      const saved = record?.pending;
      if (typeof saved?.entry === 'string' && Array.isArray(saved.adapters) && Number.isFinite(saved.writtenAt))
        pending = { entry: saved.entry, adapters: new Set(saved.adapters.filter(name => typeof name === 'string')), writtenAt: saved.writtenAt };
    }
    const save = () => writeJSON(recordPath, { version: 1, attempts,
      ...(pending?.adapters.size ? { pending: { entry: pending.entry, adapters: [...pending.adapters], writtenAt: pending.writtenAt } } : {}) });
    const settle = async () => { pending = null; await save(); };
    // Writes are remembered from every pass of this entry, including a pass
    // still waiting for a late chunk; only a coherent pass may act on them.
    let changed = false;
    if (pending?.entry !== entry) { changed = Boolean(pending?.adapters.size); pending = { entry, adapters: new Set(), writtenAt: 0 }; }
    for (const [name, adapter] of adapters) if (adapter.status === 'installed' && adapter.changed === true) {
      pending.adapters.add(name); pending.writtenAt = now(); changed = true;
    }
    if (changed) await save();
    const writtenAt = pending.writtenAt;
    const manual = reason => report({ state: 'restart-required', entry, reason, requiredSince: writtenAt });
    if (summary.state !== 'ready' || !pending.adapters.size) return null;
    if ((await stopState(root))?.stopped) return report({ state: 'waiting', entry, waiting: 'Claudex is stopped' });

    const processes = parseProcesses(await text('/bin/ps', ['-axo', 'pid=,ppid=,command=']));
    const mains = processes.filter(item => item.ppid === 1 && /\.app\/Contents\/MacOS\/Claude$/.test(item.command));
    if (mains.length !== 1) return mains.length ? manual('multiple Desktop processes') : report({ state: 'not-running', entry });
    const main = mains[0], bundle = main.command.slice(0, main.command.indexOf('.app/Contents/') + 4);
    if (await text('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(bundle, 'Contents', 'Info.plist')]) !== CLAUDE_DESKTOP_BUNDLE_ID)
      return manual('unrecognized Desktop application');
    const startedAt = Date.parse(await text('/bin/ps', ['-o', 'lstart=', '-p', String(main.pid)]));
    if (!Number.isFinite(startedAt)) return manual('Desktop start time unavailable');
    // A Desktop started after the last write has loaded the written files.
    if (startedAt > writtenAt) { await settle(); return report({ state: 'current', entry }); }
    // Lazy chunks arrive over the first seconds. Restarting before every
    // adapter is written would load the late ones unpatched again. Should one
    // never arrive, the user is asked once Desktop is no longer newly started.
    if (adapters.some(([, adapter]) => adapter.status !== 'installed'))
      return report({ state: 'restart-required', entry, reason: 'adapters still incomplete', requiredSince: writtenAt, notBefore: startedAt + windowMs });
    if (!automatic) return manual('automatic restart is disabled');
    // Each restart answers one write and Desktop must be newly started, so the
    // limit below already ends any loop after two restarts. Only a refusal, or
    // a quit whose outcome was never recorded, is final for its frontend.
    if (attempts.some(attempt => attempt.entry === entry && attempt.outcome !== 'relaunched')) return manual('Desktop declined an earlier restart');
    if (attempts.filter(attempt => attempt.at >= now() - 600_000).length >= 2) return manual('restart limit reached');
    if (now() - startedAt > windowMs) return manual('Desktop is no longer newly started');
    // A prompt submitted since it started is work a restart could interrupt.
    // A Code session process is not: Desktop starts one for the session it
    // reopens, before the user has done anything.
    const inbox = await readJSON(join(root, 'sync-events', 'inbox.json'), { entries: {} });
    if (Object.values(inbox.entries ?? {}).some(event => event.side === 'claude' && event.kind === 'started' && event.at >= startedAt))
      return manual('Claude activity since start');

    const earlier = attempts, attempt = { entry, pid: main.pid, startedAt, at: now() };
    const outcome = value => { attempts = [...earlier, { ...attempt, outcome: value }].slice(-8); return save(); };
    await outcome('quitting');
    await report({ state: 'relaunching', entry, pid: main.pid });
    await run('/usr/bin/osascript', ['-e', `tell application id ${JSON.stringify(CLAUDE_DESKTOP_BUNDLE_ID)} to quit`]).catch(() => {});
    for (const deadline = now() + quitTimeoutMs; now() < deadline && alive(main.pid);) await sleep(1000);
    if (alive(main.pid)) { await outcome('quit-declined'); return manual('Desktop declined to quit'); }
    await run('/usr/bin/open', ['-b', CLAUDE_DESKTOP_BUNDLE_ID]);
    pending = null;
    await outcome('relaunched');
    return report({ state: 'relaunched', entry, previousPid: main.pid });
  }
  return { consider };
}

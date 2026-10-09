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
 * the application has only just been opened: nothing has been sent, no Code
 * session process exists and the process is younger than `windowMs`. Outside
 * that window the resource stays restart-required and nothing is restarted.
 * It never force-quits, never repeats for the same frontend entry and never
 * touches native histories or sessions.
 */
export function createClaudeDesktopRelaunch({ root, run = execute, now = () => Date.now(), windowMs = 60_000,
  quitTimeoutMs = 60_000, sleep = delay, stopState = readAppStopState, alive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  } } = {}) {
  if (!root || !Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 600_000) throw new Error('Invalid Claude relaunch configuration.');
  const recordPath = join(root, 'claude-relaunch.json'), statusPath = join(root, 'claude-relaunch-status.json');
  // Adapters newly written for an entry since this watcher started. A resource
  // found already installed may have been loaded and proves nothing to repair.
  const written = new Map();
  let last = null;
  const report = async value => {
    const key = JSON.stringify(value);
    if (key !== last) { last = key; await writeDiagnosticJSON(statusPath, { ...value, updatedAt: now() }); }
    return value;
  };
  const text = async (command, args) => (await run(command, args)).stdout.trim();

  async function consider(summary) {
    const entry = summary?.entry?.asset, adapters = Object.entries(summary?.adapters ?? {});
    if (typeof entry !== 'string' || !adapters.length) return null;
    // Writes are remembered from every pass of this entry, including a pass
    // still waiting for a late chunk; only a coherent pass may act on them.
    const pending = written.get(entry) ?? new Set();
    for (const [name, adapter] of adapters) if (adapter.status === 'installed' && adapter.changed === true) pending.add(name);
    written.clear(); written.set(entry, pending);
    if (summary.state !== 'ready' || !pending.size) return null;
    // Lazy chunks arrive over the first seconds. Restarting before every
    // adapter is written would load the late ones unpatched again.
    if (adapters.some(([, adapter]) => adapter.status !== 'installed')) return report({ state: 'waiting', entry, waiting: 'adapters still incomplete' });
    if ((await stopState(root))?.stopped) return report({ state: 'waiting', entry, waiting: 'Claudex is stopped' });
    const record = await readJSON(recordPath, { version: 1, attempts: [] });
    const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
    if (attempts.some(attempt => attempt.entry === entry)) return report({ state: 'restart-required', entry, reason: 'already restarted for this frontend' });
    if (attempts.filter(attempt => attempt.at >= now() - 600_000).length >= 2) return report({ state: 'restart-required', entry, reason: 'restart limit reached' });

    const processes = parseProcesses(await text('/bin/ps', ['-axo', 'pid=,ppid=,command=']));
    const mains = processes.filter(item => item.ppid === 1 && /\.app\/Contents\/MacOS\/Claude$/.test(item.command));
    if (mains.length !== 1) return report({ state: mains.length ? 'restart-required' : 'not-running', entry, ...(mains.length ? { reason: 'multiple Desktop processes' } : {}) });
    const main = mains[0], bundle = main.command.slice(0, main.command.indexOf('.app/Contents/') + 4);
    if (await text('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(bundle, 'Contents', 'Info.plist')]) !== CLAUDE_DESKTOP_BUNDLE_ID)
      return report({ state: 'restart-required', entry, reason: 'unrecognized Desktop application' });
    const startedAt = Date.parse(await text('/bin/ps', ['-o', 'lstart=', '-p', String(main.pid)]));
    if (!Number.isFinite(startedAt)) return report({ state: 'restart-required', entry, reason: 'Desktop start time unavailable' });
    if (now() - startedAt > windowMs || now() < startedAt) return report({ state: 'restart-required', entry, reason: 'Desktop is no longer newly started' });
    // Any Code session process under this Desktop, or any prompt submitted
    // since it started, is work that a restart could interrupt.
    const family = new Set([main.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const item of processes) if (family.has(item.ppid) && !family.has(item.pid)) { family.add(item.pid); grew = true; }
    }
    if (processes.some(item => item.pid !== main.pid && family.has(item.pid) && item.command.includes('/claude-code/')))
      return report({ state: 'restart-required', entry, reason: 'a Code session is running' });
    const inbox = await readJSON(join(root, 'sync-events', 'inbox.json'), { entries: {} });
    if (Object.values(inbox.entries ?? {}).some(event => event.side === 'claude' && event.kind === 'started' && event.at >= startedAt))
      return report({ state: 'restart-required', entry, reason: 'Claude activity since start' });

    const attempt = { entry, pid: main.pid, startedAt, at: now(), outcome: 'quitting' };
    const save = outcome => writeJSON(recordPath, { version: 1, attempts: [...attempts, { ...attempt, outcome }].slice(-8) });
    await save('quitting');
    await report({ state: 'relaunching', entry, pid: main.pid });
    await run('/usr/bin/osascript', ['-e', `tell application id ${JSON.stringify(CLAUDE_DESKTOP_BUNDLE_ID)} to quit`]).catch(() => {});
    for (const deadline = now() + quitTimeoutMs; now() < deadline && alive(main.pid);) await sleep(1000);
    if (alive(main.pid)) { await save('quit-declined'); return report({ state: 'restart-required', entry, reason: 'Desktop declined to quit' }); }
    await run('/usr/bin/open', ['-b', CLAUDE_DESKTOP_BUNDLE_ID]);
    await save('relaunched');
    written.delete(entry);
    return report({ state: 'relaunched', entry, previousPid: main.pid });
  }
  return { consider };
}

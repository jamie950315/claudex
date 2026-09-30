import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readJSON, writeJSON, writeDiagnosticJSON } from './storage.mjs';

const execute = promisify(execFile);

/** macOS may restore Codex Desktop before login releases LaunchAgents, so it
 * starts without the Claudex CODEX_CLI_PATH launcher and never reads it later.
 * This repair restarts that exact Desktop process once as soon as no Codex turn
 * is running. It never force-quits, never retries the same process and never
 * touches native histories; synchronization resumes via the launcher.
 */
export function bundleOf(binary) {
  const index = typeof binary === 'string' ? binary.indexOf('.app/Contents/') : -1;
  if (index < 0) throw new Error('Codex binary is not inside an application bundle.');
  return binary.slice(0, index + 4);
}

export function classifyDesktop(processes, { executable, binary }) {
  const mains = processes.filter(item => item.command === executable);
  if (!mains.length) return { state: 'not-running' };
  if (mains.length > 1) return { state: 'unknown', reason: 'multiple Desktop processes' };
  const main = mains[0], children = processes.filter(item => item.ppid === main.pid);
  const primary = command => / app-server(?: |$)/.test(command) && !/ --listen(?: |=)/.test(command);
  if (children.some(item => item.command.includes('/claudex-codex.mjs ') && primary(item.command)))
    return { state: 'shared', pid: main.pid };
  if (children.some(item => item.command.startsWith(`${binary} `) && primary(item.command)))
    return { state: 'bypassed', pid: main.pid };
  return { state: 'unknown', pid: main.pid, reason: 'Desktop backend not started yet' };
}

export function parseProcesses(text) {
  return text.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
}

async function recentRollout(codexHome, since, now) {
  // Active turns stream into today's or yesterday's rollout directory.
  for (const offset of [0, 1]) {
    const day = new Date(now - offset * 86_400_000);
    const dir = join(codexHome, 'sessions', String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names;
    try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const info = await stat(join(dir, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info?.mtimeMs >= since) return true;
    }
  }
  return false;
}

export function createDesktopRelaunch({ root, codexHome, run = execute, now = () => Date.now(),
  codexQuietMs = 60_000, intervalMs = 15_000, quitTimeoutMs = 60_000, sleep = delay }) {
  const recordPath = join(root, 'desktop-relaunch.json'), statusPath = join(root, 'desktop-relaunch-status.json');
  let last = null;
  const report = async value => {
    const key = JSON.stringify(value);
    if (key !== last) { last = key; await writeDiagnosticJSON(statusPath, { ...value, updatedAt: now() }); }
    return value;
  };
  const text = async (command, args) => (await run(command, args)).stdout.trim();

  const check = async () => {
    const launcher = await readJSON(join(root, 'desktop-launcher.json'), null);
    if (!launcher?.shim || !launcher.binary) return report({ state: 'not-installed' });
    const bundle = bundleOf(launcher.binary), info = join(bundle, 'Contents', 'Info.plist');
    const [bundleId, name] = await Promise.all([
      text('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', info]),
      text('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', info])]);
    const desktop = classifyDesktop(parseProcesses(await text('/bin/ps', ['-axo', 'pid=,ppid=,command='])),
      { executable: join(bundle, 'Contents', 'MacOS', name), binary: launcher.binary });
    if (desktop.state !== 'bypassed') return report(desktop);
    if (await text('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH']) !== launcher.shim)
      return report({ ...desktop, waiting: 'launcher override is not active' });
    const startedAt = Date.parse(await text('/bin/ps', ['-o', 'lstart=', '-p', String(desktop.pid)]));
    if (!Number.isFinite(startedAt)) return report({ ...desktop, waiting: 'Desktop start time unavailable' });
    const record = await readJSON(recordPath, null);
    if (record?.pid === desktop.pid && record.startedAt === startedAt)
      return report({ ...desktop, state: 'relaunch-failed', outcome: record.outcome });
    // Hook phases older than this Desktop process cannot describe a live turn.
    const inbox = await readJSON(join(root, 'sync-events', 'inbox.json'), { entries: {} });
    if (Object.values(inbox.entries ?? {}).some(entry => entry.side === 'codex' && entry.kind === 'started' && entry.at >= startedAt)
        || await recentRollout(codexHome, now() - codexQuietMs, now()))
      return report({ ...desktop, waiting: 'Codex activity' });

    await writeJSON(recordPath, { pid: desktop.pid, startedAt, at: now(), outcome: 'quitting' });
    await report({ ...desktop, state: 'relaunching' });
    await run('/usr/bin/osascript', ['-e', `tell application id ${JSON.stringify(bundleId)} to quit`]).catch(() => {});
    const deadline = now() + quitTimeoutMs;
    while (now() < deadline) {
      try { process.kill(desktop.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await sleep(1000);
    }
    try {
      process.kill(desktop.pid, 0);
      await writeJSON(recordPath, { pid: desktop.pid, startedAt, at: now(), outcome: 'quit-declined' });
      return report({ ...desktop, state: 'relaunch-failed', outcome: 'quit-declined' });
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await run('/usr/bin/open', ['-g', '-b', bundleId]);
    await writeJSON(recordPath, { pid: desktop.pid, startedAt, at: now(), outcome: 'relaunched' });
    return report({ state: 'relaunched', previousPid: desktop.pid });
  };

  return {
    check,
    async run(signal) {
      while (!signal?.aborted) {
        try { await check(); }
        catch (error) { await report({ state: 'error', error: String(error.message).slice(0, 500) }).catch(() => {}); }
        try { await sleep(intervalMs, undefined, { signal }); }
        catch (error) { if (error.name === 'AbortError') return; throw error; }
      }
    },
  };
}

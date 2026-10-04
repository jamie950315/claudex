import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { publishExclusive, withLock, writeJSON } from './storage.mjs';
import { statusAppPaths, statusLaunchDefinition, statusStatusApp } from './status-app-install.mjs';

const execute = promisify(execFile);
const identifier = 'dev.0ruka.claudex.app';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const missingJob = error => /Could not find|No such process|No such file|service not found/i.test(error.stderr ?? error.message ?? '');

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('Application paths must be absolute single-line paths.');
  return resolve(path);
}

export function appLaunchDefinition({ root, home = homedir(), appPath }) {
  root = absolute(root); home = absolute(home); appPath = absolute(appPath);
  const label = `${identifier}.${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  const executable = join(appPath, 'Contents', 'MacOS', 'ClaudexApp');
  const args = [executable, '--background', '--root', root];
  return { label, executable, args, path: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    plist: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Interactive</string>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n` };
}

async function ownedText(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 256 * 1024)
      throw new Error('Application login file is not private and owned.');
    const content = await handle.readFile('utf8'), after = await handle.stat(), named = await lstat(path);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => info[key] !== after[key]) || named.isSymbolicLink()
      || named.dev !== after.dev || named.ino !== after.ino) throw new Error('Application login file changed during inspection.');
    return content;
  } finally { await handle.close(); }
}

async function loadedJob(definition, run) {
  try {
    const { stdout } = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${definition.label}`]);
    const value = key => stdout.match(new RegExp(`^\\s*${key} = (.+)$`, 'm'))?.[1];
    const block = stdout.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m)?.[1];
    const args = block?.split('\n').map(line => line.trim()).filter(Boolean);
    if (value('path') !== definition.path || value('program') !== definition.executable || JSON.stringify(args) !== JSON.stringify(definition.args))
      throw new Error('Loaded application LaunchAgent differs; it was preserved.');
    return true;
  } catch (error) { if (missingJob(error)) return false; throw error; }
}

async function verifyApp(appPath, run) {
  const info = await lstat(appPath), executable = await lstat(join(appPath, 'Contents', 'MacOS', 'ClaudexApp'));
  if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== process.getuid() && info.uid !== 0) || (info.mode & 0o022)
    || !executable.isFile() || executable.isSymbolicLink() || (executable.uid !== process.getuid() && executable.uid !== 0) || (executable.mode & 0o022))
    throw new Error('The unified application is not an owned bundle.');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const signed = await run('/usr/bin/codesign', ['-d', '--verbose=2', appPath]);
  if (!signed.stderr.split('\n').includes(`Identifier=${identifier}`) || !/^Authority=Apple Development: /m.test(signed.stderr)
    || !/^TeamIdentifier=[A-Z0-9]{10}$/m.test(signed.stderr)) throw new Error('The unified application signature could not be verified.');
}

async function quitLegacy(paths, run) {
  // NSRunningApplication.terminate asks only the exact verified display app to quit.
  // It does not address synchronization workers or native model applications.
  // JXA bridges NSArray.count as a string on the supported macOS runtime.
  const script = `ObjC.import('Cocoa');\nconst apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(paths.label)});\nfor (let i = 0; i < Number(apps.count); i++) {\n  const app = apps.objectAtIndex(i);\n  if (ObjC.unwrap(app.bundleURL.path) !== ${JSON.stringify(paths.app)}) throw Error('Legacy display bundle path differs.');\n}\nfor (let i = 0; i < Number(apps.count); i++) if (!apps.objectAtIndex(i).terminate) throw Error('Legacy display refused to quit.');\nfor (let attempt = 0; attempt < 30; attempt++) {\n  if (Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(paths.label)}).count) === 0) break;\n  delay(0.1);\n}\nif (Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(paths.label)}).count) !== 0) throw Error('Legacy display is still running.');`;
  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
  try {
    const result = await run('/usr/sbin/lsof', ['-t', paths.executable]);
    if (result.stdout.trim()) throw new Error('The legacy display executable is still in use.');
  } catch (error) { if (!(error.code === 1 && !(error.stdout ?? '').trim() && !(error.stderr ?? '').trim())) throw error; }
}

/** One user-facing app and login entry. Native histories and services are untouched. */
export async function installAppLogin({ root, home = homedir(), appPath, run = execute, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('The unified application requires macOS.');
  root = absolute(root); home = absolute(home); appPath = absolute(appPath);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Application state must be private and owned.');
  root = await realpath(root);
  const definition = appLaunchDefinition({ root, home, appPath });
  return withLock(join(root, 'app-login.lock'), async () => {
    await verifyApp(appPath, run);
    const previous = await ownedText(definition.path);
    if (previous !== null && previous !== definition.plist) throw new Error('Existing application LaunchAgent differs; it was preserved.');
    await loadedJob(definition, run);
    const legacyPaths = statusAppPaths(root, home), legacyDefinition = statusLaunchDefinition({ root, home });
    const legacyPlist = await ownedText(legacyPaths.launchAgent);
    if (legacyPlist !== null && legacyPlist !== legacyDefinition.plist) throw new Error('Existing legacy display LaunchAgent differs; it was preserved.');
    const legacy = await statusStatusApp({ root, home, run, platform });
    if (legacy.recoveryRequired) throw new Error('Legacy display upgrade requires recovery before integration.');
    if (legacyPlist !== null && !legacy.installed) throw new Error('Legacy display installation could not be verified.');
    const backup = join(legacyPaths.directory, 'login-disabled.plist');
    if (legacy.installed) {
      const saved = await ownedText(backup);
      if (saved !== null && saved !== legacyDefinition.plist) throw new Error('Legacy login backup differs; it was preserved.');
    }
    await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(definition.path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o022))
      throw new Error('LaunchAgents directory ownership could not be verified.');
    if (previous === null) await publishExclusive(definition.path, definition.plist);
    if (await ownedText(definition.path) !== definition.plist) throw new Error('Application LaunchAgent changed during integration.');
    await run('/usr/bin/plutil', ['-lint', definition.path]);
    if (legacy.installed) {
      await quitLegacy(legacyPaths, run);
      // Reread ownership after native termination and before unloading the display job.
      const current = await statusStatusApp({ root, home, run, platform });
      if (current.running) throw new Error('Legacy display is still running; integration is incomplete.');
      if (current.loaded) await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${legacyPaths.label}`]);
      if ((await statusStatusApp({ root, home, run, platform })).loaded) throw new Error('Legacy display login job is still loaded.');
      if (legacyPlist !== null) {
        if (await ownedText(legacyPaths.launchAgent) !== legacyDefinition.plist) throw new Error('Legacy display LaunchAgent changed during integration.');
        if (await ownedText(backup) !== null) throw new Error('Legacy login backup already exists; the current entry was preserved.');
        await rename(legacyPaths.launchAgent, backup);
      }
    }
    const result = { version: 1, root, app: appPath, label: definition.label, launchAgent: definition.path,
      loginStart: true, legacyDisplayDisabled: legacy.installed, synchronizationRestarted: false };
    await writeJSON(join(root, 'app-login.json'), result);
    return result;
  }, { recoverDead: true });
}

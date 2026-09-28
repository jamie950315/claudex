import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { publishExclusive, withLock, writeJSON } from './storage.mjs';

const execute = promisify(execFile);
const sourceDirectory = fileURLToPath(new URL('../native/ClaudexStatus/', import.meta.url));
const names = ['StatusModel.swift', 'main.swift'];
const digest = value => createHash('sha256').update(value).digest('hex');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const plist = body => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
const absent = error => error.code === 'ENOENT';
const missingJob = error => /Could not find|No such process|No such file|service not found/i.test(error.stderr ?? error.message ?? '');

function absolute(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n\0]/.test(path)) throw new Error('Status application paths must be absolute single-line paths.');
  return resolve(path);
}

export function statusAppPaths(root, home = homedir()) {
  root = absolute(root); home = absolute(home);
  const directory = join(root, 'status-ui');
  const label = `dev.0ruka.claudex.status.${digest(root).slice(0, 12)}`;
  const app = join(directory, 'Claudex Status.app');
  return { root, directory, app, executable: join(app, 'Contents', 'MacOS', 'ClaudexStatus'),
    previous: join(directory, 'previous.app'), journal: join(directory, 'install.json'),
    artifacts: join(directory, 'artifacts'), lock: join(directory, 'install.lock'), label,
    launchAgent: join(home, 'Library', 'LaunchAgents', `${label}.plist`) };
}

export function statusLaunchDefinition({ root, home = homedir() }) {
  const paths = statusAppPaths(root, home);
  return { label: paths.label, path: paths.launchAgent, plist: plist(`
<key>Label</key><string>${xml(paths.label)}</string>
<key>ProgramArguments</key><array><string>${xml(paths.executable)}</string><string>--root</string><string>${xml(paths.root)}</string></array>
<key>WorkingDirectory</key><string>${xml(paths.root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Interactive</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
`) };
}

async function directory(path, create = false) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077))
    throw new Error('Status application directory is not private and owned.');
}

async function readOwned(path, maxBytes = 128 * 1024 * 1024, mode) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o077)
        || before.size > maxBytes || (mode !== undefined && (before.mode & 0o777) !== mode))
      throw new Error('Status application file ownership changed.');
    const value = await file.readFile();
    const after = await file.stat(), current = await lstat(path);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode'].some(key => before[key] !== after[key])
        || current.dev !== after.dev || current.ino !== after.ino || current.isSymbolicLink())
      throw new Error('Status application file changed during inspection.');
    return value;
  } finally { await file.close(); }
}

async function readState(path) {
  try { return JSON.parse(await readOwned(path, 256 * 1024, 0o600)); }
  catch (error) { if (absent(error)) return null; throw error; }
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (absent(error)) return false; throw error; }
}

async function sources(path) {
  // Source files are repository inputs, not private runtime state.
  const result = [];
  for (const name of names) {
    const file = await open(join(path, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 2 * 1024 * 1024) throw new Error('Unverified status application source.');
      const content = await file.readFile();
      const after = await file.stat();
      if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw new Error('Status application source changed during inspection.');
      result.push({ name, sha256: digest(content) });
    } finally { await file.close(); }
  }
  return result;
}

async function signingIdentity(identity, run) {
  const { stdout } = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = [...stdout.matchAll(/^\s*\d+\) ([A-F0-9]{40}) "Apple Development: [^"\r\n]+"\s*$/gm)].map(match => match[1]);
  if (identity !== undefined) {
    if (!/^[A-F0-9]{40}$/.test(identity) || !identities.includes(identity)) throw new Error('Requested valid Apple Development signing identity was not found.');
    return identity;
  }
  if (identities.length !== 1) throw new Error('Specify one valid Apple Development signing identity for the status application.');
  return identities[0];
}

async function tree(app) {
  const files = [], directories = []; let bytes = 0;
  const visit = async relative => {
    const path = relative ? join(app, relative) : app;
    await directory(path);
    directories.push(relative);
    const entries = (await readdir(path)).sort();
    for (const name of entries) {
      const next = relative ? `${relative}/${name}` : name, full = join(app, next);
      const info = await lstat(full);
      if (info.isDirectory() && !info.isSymbolicLink()) await visit(next);
      else {
        const content = await readOwned(full);
        bytes += content.length;
        files.push({ path: next, sha256: digest(content), mode: info.mode & 0o777 });
      }
      if (files.length + directories.length > 64 || bytes > 128 * 1024 * 1024) throw new Error('Status application exceeds its artifact bound.');
    }
  };
  await visit('');
  return { directories, files };
}

async function verifyBundle(app, artifact, run) {
  if (JSON.stringify(await tree(app)) !== JSON.stringify(artifact.tree)) throw new Error('Status application bundle ownership changed; it was not replaced.');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

/** Build a signed generated artifact; never starts the UI or a synchronization worker. */
export async function buildStatusApp({ root, appPath, identity, run = execute, sourcesPath = sourceDirectory, platform = process.platform }) {
  if (platform !== 'darwin') throw new Error('The status application requires macOS.');
  root = absolute(root); appPath = absolute(appPath);
  await directory(dirname(appPath));
  if (await exists(appPath)) throw new Error('Status application build destination already exists.');
  const input = await sources(sourcesPath), signer = await signingIdentity(identity, run), paths = statusAppPaths(root);
  await directory(appPath, true);
  await directory(join(appPath, 'Contents'), true);
  await directory(join(appPath, 'Contents', 'MacOS'), true);
  const executable = join(appPath, 'Contents', 'MacOS', 'ClaudexStatus');
  const metadata = plist(`
<key>CFBundleIdentifier</key><string>${xml(paths.label)}</string>
<key>CFBundleExecutable</key><string>ClaudexStatus</string>
<key>CFBundleName</key><string>Claudex Status</string>
<key>CFBundleDisplayName</key><string>Claudex Status</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string><key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/><key>ClaudexRoot</key><string>${xml(root)}</string>
`);
  await publishExclusive(join(appPath, 'Contents', 'Info.plist'), metadata);
  await run('/usr/bin/xcrun', ['swiftc', ...names.map(name => join(sourcesPath, name)), '-O', '-framework', 'Cocoa', '-framework', 'UserNotifications', '-o', executable], { maxBuffer: 1024 * 1024 });
  await chmod(executable, 0o700);
  if (JSON.stringify(await sources(sourcesPath)) !== JSON.stringify(input)) throw new Error('Status application sources changed during the build.');
  await run('/usr/bin/codesign', ['--force', '--sign', signer, '--options', 'runtime', '--timestamp=none', appPath]);
  // codesign creates generated signature resources using the process umask.
  const signatureDirectory = join(appPath, 'Contents', '_CodeSignature');
  if (await exists(signatureDirectory)) {
    const info = await lstat(signatureDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unverified generated signature resource.');
    await chmod(signatureDirectory, 0o700);
    for (const name of await readdir(signatureDirectory)) {
      const path = join(signatureDirectory, name), item = await lstat(path);
      if (!item.isFile() || item.isSymbolicLink() || item.uid !== process.getuid() || item.nlink !== 1) throw new Error('Unverified generated signature resource.');
      await chmod(path, 0o600);
    }
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const details = await run('/usr/bin/codesign', ['-d', '--verbose=2', appPath]);
  if (!details.stderr.split('\n').includes(`Identifier=${paths.label}`) || !/^Authority=Apple Development: /m.test(details.stderr)
      || !/^TeamIdentifier=[A-Z0-9]{10}$/m.test(details.stderr)) throw new Error('Status application signing identity could not be verified.');
  return { version: 1, root, bundleId: paths.label, identity: signer, sources: input, tree: await tree(appPath) };
}

async function job(paths, run) {
  try {
    const { stdout } = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${paths.label}`]);
    const value = key => stdout.match(new RegExp(`^\\s*${key} = (.+)$`, 'm'))?.[1];
    const argumentsBlock = stdout.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m)?.[1];
    const args = argumentsBlock?.split('\n').map(line => line.trim()).filter(Boolean);
    if (value('path') !== paths.launchAgent || value('program') !== paths.executable
        || JSON.stringify(args) !== JSON.stringify([paths.executable, '--root', paths.root]))
      throw new Error('Loaded status LaunchAgent ownership differs; it was not changed.');
    return { loaded: true, running: /\bstate = running\b/.test(stdout) };
  } catch (error) { if (missingJob(error)) return { loaded: false, running: false }; throw error; }
}

async function assertExited(paths, run) {
  if ((await job(paths, run)).running) throw new Error('Quit Claudex Status before upgrading it; synchronization does not need to stop.');
  if (!await exists(paths.executable)) return;
  try {
    const result = await run('/usr/sbin/lsof', ['-t', paths.executable]);
    if (result.stdout.trim()) throw new Error('Quit Claudex Status before upgrading it; its executable is still in use.');
  } catch (error) {
    if (error.code === 1 && !(error.stdout ?? '').trim() && !(error.stderr ?? '').trim()) return;
    throw error;
  }
}

async function artifact(paths, id) {
  if (!/^[a-f0-9]{64}$/.test(id ?? '')) throw new Error('Invalid status application artifact identity.');
  const bytes = await readOwned(join(paths.artifacts, `${id}.json`), 256 * 1024, 0o600);
  if (digest(bytes) !== id) throw new Error('Status application artifact manifest changed.');
  const value = JSON.parse(bytes);
  if (value.version !== 1 || value.root !== paths.root || value.bundleId !== paths.label || !value.tree)
    throw new Error('Status application artifact belongs to another installation.');
  return value;
}

async function validateState(paths, state) {
  if (state.version !== 1 || state.root !== paths.root || state.app !== paths.app || state.label !== paths.label
      || state.launchAgent !== paths.launchAgent || (state.current !== null && !/^[a-f0-9]{64}$/.test(state.current))
      || (state.previous !== null && !/^[a-f0-9]{64}$/.test(state.previous))) throw new Error('Unverified status application installation journal.');
  if (state.pending && (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(state.pending.stage ?? '') || !/^[a-f0-9]{64}$/.test(state.pending.artifact ?? '')))
    throw new Error('Unverified status application upgrade intent.');
}

async function recover(paths, state, run) {
  if (!state.pending) return state;
  await assertExited(paths, run);
  const candidate = await artifact(paths, state.pending.artifact);
  const stageRoot = join(paths.directory, `stage-${state.pending.stage}`), stage = join(stageRoot, 'Claudex Status.app');
  const current = state.current ? await artifact(paths, state.current) : null;
  // Every move is recoverable from the immutable artifact hashes. Unknown
  // contents fail closed, including an app launched outside launchd.
  if (await exists(stage)) {
    await directory(stageRoot); await verifyBundle(stage, candidate, run);
    if (await exists(paths.app)) {
      if (!current) throw new Error('An unowned status application occupies the installation path.');
      await verifyBundle(paths.app, current, run);
      if (await exists(paths.previous)) {
        if (!state.previous) throw new Error('Unowned previous status application was preserved.');
        await verifyBundle(paths.previous, await artifact(paths, state.previous), run);
        await rm(paths.previous, { recursive: true });
      }
      await assertExited(paths, run);
      await rename(paths.app, paths.previous);
    } else if (current) await verifyBundle(paths.previous, current, run);
    await rename(stage, paths.app);
  }
  await verifyBundle(paths.app, candidate, run);
  if (current) await verifyBundle(paths.previous, current, run);
  const complete = { ...state, previous: state.current, current: state.pending.artifact, pending: null };
  await writeJSON(paths.journal, complete);
  // Only an empty, exact generated staging directory is removed.
  if (await exists(stageRoot)) { await directory(stageRoot); if ((await readdir(stageRoot)).length === 0) await rm(stageRoot, { recursive: true }); }
  return complete;
}

async function canonicalRoot(root, create = false) {
  root = absolute(root);
  if (create && !await exists(root)) {
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  await directory(root);
  return realpath(root);
}

async function discardFailedBuild(stageRoot) {
  const directories = new Set(['', 'Claudex Status.app', 'Claudex Status.app/Contents',
    'Claudex Status.app/Contents/MacOS', 'Claudex Status.app/Contents/_CodeSignature']);
  const files = new Set(['Claudex Status.app/Contents/Info.plist', 'Claudex Status.app/Contents/MacOS/ClaudexStatus',
    'Claudex Status.app/Contents/_CodeSignature/CodeResources']);
  const check = async relative => {
    const path = relative ? join(stageRoot, relative) : stageRoot, info = await lstat(path);
    if (info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error('Failed status build contains unverified files and was preserved.');
    if (info.isDirectory() && directories.has(relative)) {
      for (const name of await readdir(path)) await check(relative ? `${relative}/${name}` : name);
    } else if (!info.isFile() || info.nlink !== 1 || !files.has(relative)) throw new Error('Failed status build contains unverified files and was preserved.');
  };
  await check('');
  await rm(stageRoot, { recursive: true });
}

/** Installs only the independent read-only menu app, never the sync worker. */
async function installLegacyStatusApp({ root, identity, run = execute, sourcesPath = sourceDirectory,
  home = homedir(), start = true, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('The status application requires macOS.');
  root = await canonicalRoot(root, true);
  const unified = await readState(join(root, 'app-login.json'));
  if (unified?.version === 1 && unified.root === root && unified.loginStart === true)
    throw new Error('The unified Claudex app already provides status and login startup. Open Claudex to manage it.');
  const paths = statusAppPaths(root, home), definition = statusLaunchDefinition({ root, home });
  await directory(paths.directory, true); await directory(paths.artifacts, true);
  const installed = await withLock(paths.lock, async () => {
    let state = await readState(paths.journal);
    if (state) { await validateState(paths, state); state = await recover(paths, state, run); }
    else {
      if (await exists(paths.app) || await exists(paths.previous)) throw new Error('An unowned status application occupies the installation path.');
      state = { version: 1, root, app: paths.app, label: paths.label, launchAgent: paths.launchAgent, current: null, previous: null, pending: null };
    }
    const existingPlist = await readStateText(paths.launchAgent);
    if (existingPlist !== null && existingPlist !== definition.plist) throw new Error('Existing status LaunchAgent differs; it was not overwritten.');
    const input = await sources(sourcesPath);
    const current = state.current ? await artifact(paths, state.current) : null;
    if (current) await verifyBundle(paths.app, current, run);
    if (!current || JSON.stringify(input) !== JSON.stringify(current.sources) || (identity && identity !== current.identity)) {
      await assertExited(paths, run);
      if ((await readdir(paths.directory)).some(name => name.startsWith('stage-')))
        throw new Error('An interrupted status application build remains; inspect the preserved staging directory before another build.');
      const stageId = randomUUID(), stageRoot = join(paths.directory, `stage-${stageId}`);
      await directory(stageRoot, true);
      let built;
      try { built = await buildStatusApp({ root, appPath: join(stageRoot, 'Claudex Status.app'), identity, run, sourcesPath, platform }); }
      catch (error) { await discardFailedBuild(stageRoot); throw error; }
      const bytes = `${JSON.stringify(built, null, 2)}\n`, id = digest(bytes), path = join(paths.artifacts, `${id}.json`);
      if (await exists(path)) {
        if (!(await readOwned(path, 256 * 1024, 0o600)).equals(Buffer.from(bytes))) throw new Error('Existing status artifact manifest changed.');
      } else await publishExclusive(path, bytes);
      state = { ...state, pending: { stage: stageId, artifact: id } };
      await writeJSON(paths.journal, state);
      state = await recover(paths, state, run);
    }
    await mkdir(dirname(paths.launchAgent), { recursive: true, mode: 0o700 });
    const agentDirectory = await lstat(dirname(paths.launchAgent));
    if (!agentDirectory.isDirectory() || agentDirectory.isSymbolicLink() || agentDirectory.uid !== process.getuid() || (agentDirectory.mode & 0o022))
      throw new Error('LaunchAgents directory is not owned or is writable by others.');
    if (await readStateText(paths.launchAgent) === null) await publishExclusive(paths.launchAgent, definition.plist);
    if (await readStateText(paths.launchAgent) !== definition.plist) throw new Error('Status LaunchAgent changed during installation.');
    await run('/usr/bin/plutil', ['-lint', paths.launchAgent]);
    return { installed: true, root, app: paths.app, label: paths.label, launchAgent: paths.launchAgent, artifact: state.current };
  }, { recoverDead: true });
  // The app refuses a new launch while install.lock exists, so launch only
  // after the transaction has released that lock.
  if (start) {
    const live = await job(paths, run);
    if (!live.loaded) await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.launchAgent]);
    else if (!live.running) await run('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${paths.label}`]);
  }
  return { ...installed, ...(await job(paths, run)), synchronizationRestarted: false };
}

export async function installStatusApp(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('The status application requires macOS.');
  const root = await canonicalRoot(options.root, true);
  // Share the integration lock through the final launch, so a concurrent CLI
  // installer cannot recreate the retired login entry or display process.
  return withLock(join(root, 'app-login.lock'), () => installLegacyStatusApp({ ...options, root }), { recoverDead: true });
}

async function readStateText(path) {
  try { return (await readOwned(path, 256 * 1024, 0o600)).toString('utf8'); }
  catch (error) { if (absent(error)) return null; throw error; }
}

export async function statusStatusApp({ root, home = homedir(), run = execute, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('The status application requires macOS.');
  root = await canonicalRoot(root);
  const paths = statusAppPaths(root, home);
  if (!await exists(paths.directory)) return { installed: false, root };
  await directory(paths.directory); await directory(paths.artifacts);
  const state = await readState(paths.journal);
  if (!state) return { installed: false, root };
  await validateState(paths, state);
  if (state.pending) return { installed: false, root, recoveryRequired: true };
  await verifyBundle(paths.app, await artifact(paths, state.current), run);
  const loginStart = await readStateText(paths.launchAgent) === statusLaunchDefinition({ root, home }).plist;
  return { installed: true, root, app: paths.app, label: paths.label, launchAgent: paths.launchAgent,
    loginStart, ...(await job(paths, run)), synchronizationRestarted: false };
}

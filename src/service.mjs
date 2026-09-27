import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, unlink, lstat } from 'node:fs/promises';
import { atomicWrite, hash, publishExclusive, privateDirectory, readJSON, withLock, writeJSON } from './storage.mjs';
import { inspectServiceStart } from './service-supervisor.mjs';

const execute = promisify(execFile);
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unxml = text => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]);

export function serviceDefinition({ root, node = process.execPath, cli, path = process.env.PATH,
  home = homedir(), legacy = false }) {
  const label = `dev.0ruka.claudex.${hash(resolve(root)).slice(0, 12)}`;
  const supervisor = fileURLToPath(new URL('../bin/claudex-service.mjs', import.meta.url));
  const args = legacy ? [node, cli, 'watch', '--root', root] : [node, supervisor, '--cli', cli, '--root', root];
  const lifecycle = legacy ? '<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>'
    : '<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>AbandonProcessGroup</key><true/>';
  return { label, path: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    plist: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>WorkingDirectory</key><string>${xml(root)}</string>
${lifecycle}
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n` };
}

function ownedDefinition(contents, options) {
  const args = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(contents)?.[1];
  const values = [...(args ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml(match[1]));
  const path = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(contents)?.[1];
  if (!values.length || path === undefined) return false;
  // Reproduce only an exact known generator. Mere presence of our root/CLI
  // text is insufficient proof of ownership of an arbitrary launchd job.
  return [true, false].some(legacy => serviceDefinition({ ...options, node: values[0], path: unxml(path), legacy }).plist === contents);
}

async function definitionContents(path) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== 1
      || (info.mode & 0o022) || info.size > 65536) throw new Error('Service definition is not an owned regular file.');
  const text = await readFile(path, 'utf8');
  const after = await lstat(path);
  if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => info[key] !== after[key])) throw new Error('Service definition changed during inspection.');
  return text;
}

async function nativeStatus(run, target) {
  try {
    const result = await run('launchctl', ['print', target]);
    return { loaded: true, running: /state = running/.test(result.stdout) };
  } catch (error) {
    if (/Could not find|No such process|No such file/i.test(error.stderr ?? '')) return { loaded: false, running: false };
    throw error;
  }
}

function platformCheck(platform) {
  if (platform !== 'darwin') throw new Error('Background service installation currently supports macOS only.');
}

export async function installService(options, { run = execute, platform = process.platform, inspect = inspectServiceStart } = {}) {
  platformCheck(platform);
  const root = await privateDirectory(options.root);
  const definition = serviceDefinition({ ...options, root });
  const target = `gui/${process.getuid()}/${definition.label}`;
  return withLock(join(root, 'service-install.lock'), async () => {
    const journalPath = join(root, 'service-install.json');
    let journal = await readJSON(journalPath, null);
    let contents = await definitionContents(definition.path);
    const loaded = await nativeStatus(run, target);
    if (journal && (journal.version !== 1 || journal.label !== definition.label || journal.path !== definition.path
      || journal.cli !== options.cli || !['prepared', 'installed'].includes(journal.phase)
      || typeof journal.after !== 'string' || hash(journal.after) !== journal.afterHash
      || (journal.before !== null && (typeof journal.before !== 'string' || hash(journal.before) !== journal.beforeHash)))) {
      throw new Error('Service installation journal is invalid; no definition was changed.');
    }
    if (journal?.phase === 'prepared') {
      if (journal.after !== definition.plist || (contents !== journal.before && contents !== journal.after))
        throw new Error('Service definition changed during a prepared upgrade; it was not overwritten.');
    } else if (contents !== null && !ownedDefinition(contents, { ...options, root })) {
      throw new Error('Existing service definition differs; it was not overwritten.');
    }
    if (contents !== definition.plist) {
      if (loaded.loaded) throw new Error('Stop the loaded service safely before upgrading its definition.');
      const check = await inspect(root, { includeSupervisor: true });
      if (!check.allowed) throw new Error('Stop the watcher and all native owners safely before upgrading the service.');
      if (journal?.phase !== 'prepared') {
        journal = { version: 1, phase: 'prepared', label: definition.label, path: definition.path,
          cli: options.cli, before: contents, beforeHash: contents === null ? null : hash(contents),
          after: definition.plist, afterHash: hash(definition.plist), preparedAt: Date.now() };
        await writeJSON(journalPath, journal);
      }
      if (await definitionContents(definition.path) !== contents) throw new Error('Service definition changed before publication.');
      if (contents === null) await publishExclusive(definition.path, definition.plist);
      else await atomicWrite(definition.path, definition.plist);
      contents = definition.plist;
    }
    await run('plutil', ['-lint', definition.path]);
    // A published definition and a loaded job are different states. Replaying
    // a prepared journal can safely complete this last step without replacing
    // native conversation files or restarting a running watcher.
    if (!loaded.loaded) await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, definition.path]);
    journal = journal?.after === definition.plist ? journal : {
      version: 1, label: definition.label, path: definition.path, cli: options.cli,
      before: contents, beforeHash: hash(contents), after: definition.plist, afterHash: hash(definition.plist), preparedAt: Date.now(),
    };
    await writeJSON(journalPath, { ...journal, phase: 'installed', installedAt: Date.now() });
    return { label: definition.label, installed: definition.path, autoRestart: true,
      note: 'Starts at login. Unexpected watcher exits recover with bounded backoff; native owner locks and pending transactions remain authoritative.' };
  }, { recoverDead: true });
}

export async function controlService(action, options, { run = execute, platform = process.platform, inspect = inspectServiceStart } = {}) {
  platformCheck(platform);
  const { label, path } = serviceDefinition(options);
  const target = `gui/${process.getuid()}/${label}`;
  if (action === 'status') return { label, ...await nativeStatus(run, target), supervisor: await readJSON(join(options.root, 'service-status.json'), null) };
  const contents = await definitionContents(path);
  if (contents === null || !ownedDefinition(contents, options)) throw new Error('Service ownership could not be verified.');
  if (action === 'uninstall' || action === 'stop') {
    if ((await nativeStatus(run, target)).loaded) await run('launchctl', ['bootout', target]);
    if (action === 'uninstall') {
      const check = await inspect(options.root, { includeSupervisor: true });
      if (!check.allowed) throw new Error('Service shutdown is still waiting for native owners; the installed definition was preserved.');
      if (await definitionContents(path) !== contents) throw new Error('Service definition changed before removal.');
      await unlink(path);
      return { label, removed: path, conversationDataPreserved: true };
    }
    return { label, action, shutdownRequested: true, note: 'Native busy owners are allowed to finish. No forced termination is requested.' };
  }
  if (action === 'start') {
    if (!(await nativeStatus(run, target)).loaded) await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, path]);
  } else throw new Error('Unknown service action.');
  return { label, action };
}

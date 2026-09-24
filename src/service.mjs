import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, lstat } from 'node:fs/promises';
import { hash, publishExclusive } from './storage.mjs';

const execute = promisify(execFile);
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function serviceDefinition({ root, node = process.execPath, cli, path = process.env.PATH }) {
  const label = `dev.0ruka.claudex.${hash(resolve(root)).slice(0, 12)}`;
  return { label, path: join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
    plist: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>watch</string><string>--root</string><string>${xml(root)}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n` };
}

export async function installService(options) {
  if (process.platform !== 'darwin') throw new Error('Background service installation currently supports macOS only.');
  const definition = serviceDefinition(options);
  try {
    if ((await lstat(definition.path)).isSymbolicLink() || await readFile(definition.path, 'utf8') !== definition.plist) throw new Error('Existing service definition differs; it was not overwritten.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await publishExclusive(definition.path, definition.plist);
  }
  await execute('plutil', ['-lint', definition.path]);
  await execute('launchctl', ['bootstrap', `gui/${process.getuid()}`, definition.path]);
  return { label: definition.label, installed: definition.path, note: 'The service stops on unsafe errors; it does not retry ambiguous writes.' };
}

export async function controlService(action, options) {
  if (process.platform !== 'darwin') throw new Error('macOS service control is unavailable on this platform.');
  const { label, path } = serviceDefinition(options);
  const domain = `gui/${process.getuid()}`;
  if (action === 'uninstall') {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Service definition must not be a symlink.');
    const text = await readFile(path, 'utf8');
    if (!text.includes(`<string>${xml(options.root)}</string>`) || !text.includes(`<string>${xml(options.cli)}</string>`) || !text.includes(`<string>${xml(label)}</string>`)) throw new Error('Service ownership could not be verified.');
    try { await execute('launchctl', ['bootout', `${domain}/${label}`]); }
    catch (error) { if (!/Could not find|No such process|No such file/i.test(error.stderr ?? '')) throw error; }
    await unlink(path);
    return { label, removed: path, conversationDataPreserved: true };
  }
  if (action === 'stop') await execute('launchctl', ['bootout', `${domain}/${label}`]);
  else if (action === 'start') await execute('launchctl', ['bootstrap', domain, path]);
  else if (action === 'status') {
    const result = await execute('launchctl', ['print', `${domain}/${label}`]);
    return { label, loaded: true, running: /state = running/.test(result.stdout) };
  } else throw new Error('Unknown service action.');
  return { label, action };
}

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite, privateDirectory, publishExclusive, readJSON, withLock, writeJSON } from './storage.mjs';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function collaborationDefinition({ root, cli, node = process.execPath, home = homedir(),
  environmentPath = process.env.PATH ?? '/usr/bin:/bin', allowWrite = false, defaultPermission = 'read-only', codexBinary, claudeBinary }) {
  if (![root, cli, node, home].every(value => typeof value === 'string' && isAbsolute(value)))
    throw new Error('Collaboration root, CLI, Node and home must be absolute paths.');
  if (typeof allowWrite !== 'boolean' || typeof environmentPath !== 'string' || environmentPath.includes('\0'))
    throw new Error('Collaboration write access or PATH is invalid.');
  const label = `dev.0ruka.claudex.collaboration.${digest(resolve(root)).slice(0, 12)}`;
  if (!['read-only', 'workspace-write'].includes(defaultPermission) || defaultPermission === 'workspace-write' && !allowWrite)
    throw new Error('Default permission exceeds installation authorization.');
  for (const binary of [codexBinary, claudeBinary]) if (binary !== undefined && !isAbsolute(binary)) throw new Error('Provider executables must be absolute.');
  const args = [node, cli, 'serve', '--root', root, ...(allowWrite ? ['--allow-write'] : []),
    ...(defaultPermission !== 'read-only' ? ['--default-permission', defaultPermission] : []),
    ...(codexBinary ? ['--codex-binary', codexBinary] : []), ...(claudeBinary ? ['--claude-binary', claudeBinary] : [])];
  const path = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(environmentPath)}</string></dict>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
  return { label, path, plist, args };
}

export function collaborationMcpRegistration({ root, cli, node = process.execPath }) {
  if (![root, cli, node].every(value => typeof value === 'string' && isAbsolute(value)))
    throw new Error('MCP root, CLI and Node must be absolute paths.');
  const command = [node, cli, 'mcp', '--root', root];
  return {
    name: 'claudex-work',
    codex: ['codex', 'mcp', 'add', 'claudex-work', '--', ...command, '--peer', 'codex'],
    claude: ['claude', 'mcp', 'add', '--scope', 'user', 'claudex-work', '--', ...command, '--peer', 'claude'],
  };
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactStdio(value, command, args) {
  return value && (value.type === undefined || value.type === 'stdio')
    && value.command === command && sameArray(value.args ?? [], args)
    && (value.env === undefined || value.env === null
      || (typeof value.env === 'object' && !Array.isArray(value.env) && Object.keys(value.env).length === 0))
    && value.url === undefined;
}

async function getCodexMcp(run) {
  let result;
  try { result = await run('codex', ['mcp', 'get', 'claudex-work', '--json']); }
  catch (error) {
    if (/^Error: No MCP server named 'claudex-work' found\.\s*$/.test((error.stderr || error.stdout) ?? '')) return null;
    throw new Error('Could not inspect the Codex MCP registration.');
  }
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error('Codex returned an invalid MCP registration.'); }
  return value;
}

async function getClaudeMcp(run) {
  try {
    const { stdout } = await run('claude', ['mcp', 'get', 'claudex-work']);
    if (!/^\s*Scope: User config\b/m.test(stdout ?? ''))
      throw new Error('Claude MCP name is shadowed by a non-user registration.');
    return true;
  }
  catch (error) {
    if (/shadowed by a non-user registration/.test(error.message ?? '')) throw error;
    if (/^No MCP server named "claudex-work"(?:\.|\s)/.test((error.stdout || error.stderr) ?? '')) return false;
    throw new Error('Could not inspect the Claude MCP registration.');
  }
}

async function getClaudeUserMcp(configDirectory) {
  const path = join(configDirectory, '.claude.json');
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== 1
      || info.size > 16 * 1024 * 1024) throw new Error('Claude MCP configuration is not a bounded owned file.');
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Claude MCP configuration could not be parsed.'); }
  return config?.mcpServers?.['claudex-work'] ?? null;
}

function checkCodexRegistration(value, command, args) {
  if (value === null) return false;
  if (value.name !== 'claudex-work' || value.enabled === false
      || !exactStdio(value.transport, command, args)
      || (value.transport.cwd !== undefined && value.transport.cwd !== null)
      || (value.transport.env_vars !== undefined && !sameArray(value.transport.env_vars, [])))
    throw new Error('Existing Codex MCP name belongs to a different registration.');
  return true;
}

function checkClaudeRegistration(visible, value, command, args) {
  if (visible !== (value !== null))
    throw new Error('Claude MCP visibility differs from its user registration; no configuration was changed.');
  if (!visible) return false;
  if (!exactStdio(value, command, args))
    throw new Error('Existing Claude MCP name belongs to a different registration.');
  return true;
}

export async function registerCollaboration(options, { run = execute } = {}) {
  const root = await privateDirectory(options.root);
  const home = options.home ?? homedir();
  const claudeConfigDirectory = options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? home;
  const registration = collaborationMcpRegistration({ ...options, root });
  const codexArgs = registration.codex.slice(5);
  const claudeArgs = registration.claude.slice(7);
  return withLock(join(root, 'collaboration-mcp.lock'), async () => {
    // Both names are checked before either native CLI is allowed to write.
    const [codex, claudeVisible, claudeUser] = await Promise.all([
      getCodexMcp(run), getClaudeMcp(run), getClaudeUserMcp(claudeConfigDirectory),
    ]);
    const codexPresent = checkCodexRegistration(codex, codexArgs[0], codexArgs.slice(1));
    const claudePresent = checkClaudeRegistration(claudeVisible, claudeUser, claudeArgs[0], claudeArgs.slice(1));
    if (!codexPresent) {
      try { await run(registration.codex[0], registration.codex.slice(1)); }
      catch { throw new Error('Codex MCP add failed; any existing native configuration was preserved.'); }
      if (!checkCodexRegistration(await getCodexMcp(run), codexArgs[0], codexArgs.slice(1)))
        throw new Error('Codex did not retain the MCP registration.');
    }
    if (!claudePresent) {
      try { await run(registration.claude[0], registration.claude.slice(1)); }
      catch { throw new Error('Claude MCP add failed; the verified Codex registration was preserved.'); }
      if (!checkClaudeRegistration(await getClaudeMcp(run), await getClaudeUserMcp(claudeConfigDirectory), claudeArgs[0], claudeArgs.slice(1)))
        throw new Error('Claude did not retain the MCP registration.');
    }
    return { codex: true, claude: true, name: registration.name };
  }, { recoverDead: true });
}

async function readOwnedDefinition(path) {
  let before;
  try { before = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid()
      || before.nlink !== 1 || (before.mode & 0o022) || before.size > 65536)
    throw new Error('Collaboration LaunchAgent is not an owned regular file.');
  const contents = await readFile(path, 'utf8');
  const after = await lstat(path);
  if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key]))
    throw new Error('Collaboration LaunchAgent changed during inspection.');
  return contents;
}

async function loadedStatus(run, label) {
  try {
    const { stdout } = await run('launchctl', ['print', `gui/${process.getuid()}/${label}`]);
    return { loaded: true, running: /state = running/.test(stdout ?? '') };
  } catch (error) {
    if (/Could not find|No such process|No such file/i.test(error.stderr ?? ''))
      return { loaded: false, running: false };
    throw error;
  }
}

function validJournal(journal, definition) {
  return journal && journal.version === 1 && journal.label === definition.label && journal.path === definition.path
    && ['prepared', 'installed'].includes(journal.phase)
    && (journal.before === null || (typeof journal.before === 'string' && digest(journal.before) === journal.beforeHash))
    && typeof journal.after === 'string' && digest(journal.after) === journal.afterHash;
}

async function privateControlJSON(path, limit = 131072) {
  let before;
  try { before = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid()
      || before.nlink !== 1 || (before.mode & 0o077) || before.size > limit)
    throw new Error('Collaboration control evidence is not a bounded private owned file.');
  const contents = await readFile(path, 'utf8');
  const after = await lstat(path);
  if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key]))
    throw new Error('Collaboration control evidence changed during inspection.');
  return JSON.parse(contents);
}

function processAbsent(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

function savedControlDefinition(journal, options) {
  const saved = journal?.after;
  if (typeof saved !== 'string') return collaborationDefinition(options);
  const unxml = value => value.replaceAll('&apos;', "'").replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
  const array = saved.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s)?.[1];
  const args = [...(array ?? '').matchAll(/<string>(.*?)<\/string>/gs)].map(match => unxml(match[1]));
  if (args[0] !== options.node || args[1] !== options.cli || args[2] !== 'serve'
      || args[3] !== '--root' || args[4] !== options.root)
    throw new Error('Collaboration executable or root differs from the requested installation.');
  const parsed = { ...options, allowWrite: false, defaultPermission: 'read-only' };
  const seen = new Set();
  for (let index = 5; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('Duplicate collaboration launch option.');
    seen.add(flag);
    if (flag === '--allow-write') parsed.allowWrite = true;
    else if (flag === '--default-permission') parsed.defaultPermission = args[++index];
    else if (flag === '--codex-binary') parsed.codexBinary = args[++index];
    else if (flag === '--claude-binary') parsed.claudeBinary = args[++index];
    else throw new Error('Unknown collaboration launch option.');
  }
  const path = saved.match(/<key>EnvironmentVariables<\/key><dict><key>PATH<\/key><string>(.*?)<\/string><\/dict>/s)?.[1];
  if (path === undefined) throw new Error('Collaboration launch environment is invalid.');
  parsed.environmentPath = unxml(path);
  const definition = collaborationDefinition(parsed);
  if (definition.plist !== saved) throw new Error('Collaboration launch definition is not a recognized artifact.');
  return definition;
}

async function collaborationProcessesStopped(root, absent) {
  const lock = await privateControlJSON(join(root, 'broker.lock'));
  const endpoint = await privateControlJSON(join(root, 'endpoint.json'));
  const pids = new Set();
  for (const record of [lock, endpoint]) {
    if (record === null) continue;
    if (!Number.isSafeInteger(record.pid) || record.pid <= 1)
      throw new Error('Collaboration broker process identity is invalid.');
    pids.add(record.pid);
  }
  if (lock && (typeof lock.started !== 'string' || !Number.isFinite(Date.parse(lock.started))))
    throw new Error('Collaboration broker lock is malformed.');
  if (endpoint && endpoint.version !== 1) throw new Error('Collaboration endpoint is malformed.');
  let socket;
  try { socket = await lstat(join(root, 'rpc.sock')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (socket && (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid()
      || (socket.mode & 0o777) !== 0o600 || !endpoint || endpoint.dev !== socket.dev || endpoint.ino !== socket.ino))
    throw new Error('Collaboration socket has no matching owned endpoint evidence.');
  const work = await privateControlJSON(join(root, 'work.json'), 128 * 1024 * 1024);
  if (work && (work.version !== 1 || !work.tasks || typeof work.tasks !== 'object' || Array.isArray(work.tasks)))
    throw new Error('Collaboration work evidence is malformed.');
  for (const task of Object.values(work?.tasks ?? {})) {
    if (!task || typeof task !== 'object') throw new Error('Collaboration work evidence is malformed.');
    const execution = task.active ?? (task.status === 'uncertain' ? task.lastExecution : null);
    if (!execution) {
      if (task.status === 'running' || task.status === 'uncertain') throw new Error('Cannot verify collaboration shutdown: native process identity is missing.');
      continue;
    }
    if (!Number.isSafeInteger(execution.pid) || execution.pid <= 1) throw new Error('Cannot verify collaboration shutdown: native process identity is missing.');
    pids.add(execution.pid);
  }
  for (const pid of pids) if (!await absent(pid) || !await absent(-pid)) return false;
  return true;
}

// Control only an exact installed artifact, never paths supplied by its journal.
// Bootout requests graceful shutdown; detached native groups can outlive launchd.
export async function controlCollaboration(action, options,
  { run = execute, platform = process.platform, absent = processAbsent } = {}) {
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('Unknown collaboration control action.');
  if (platform !== 'darwin') throw new Error('Collaboration LaunchAgent control supports macOS only.');
  const requestedRoot = resolve(options.root);
  let root;
  try { root = await realpath(requestedRoot); }
  catch (error) {
    if (error.code === 'ENOENT' && action !== 'start') {
      const definition = collaborationDefinition({ ...options, root: requestedRoot });
      const status = await loadedStatus(run, definition.label);
      if (status.loaded) throw new Error('Loaded collaboration job has no owned installation root; it was preserved.');
      return { installed: false, ...status, stopped: true, shutdownRequested: false };
    }
    throw error;
  }
  const info = await lstat(requestedRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077))
    throw new Error('Collaboration root must be private and owned by the current user.');
  let definition = collaborationDefinition({ ...options, root });
  const inspect = async () => {
    const journal = await privateControlJSON(join(root, 'collaboration-install.json'));
    definition = savedControlDefinition(journal, { ...options, root, node: options.node ?? process.execPath });
    const contents = await readOwnedDefinition(definition.path);
    const loaded = await loadedStatus(run, definition.label);
    if (!journal && contents === null && !loaded.loaded) return { installed: false, ...loaded };
    const directory = await lstat(dirname(definition.path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o022)
        || !validJournal(journal, definition) || journal.after !== definition.plist || contents !== definition.plist)
      throw new Error('Collaboration control requires the exact owned installation; existing artifacts were preserved.');
    return { installed: true, ...loaded };
  };
  const control = async () => {
    let status = await inspect();
    const base = { label: definition.label, launchAgent: definition.path };
    if (action === 'start') {
      if (!status.installed) throw new Error('Collaboration is not installed.');
      if (!status.loaded) {
        if (!await collaborationProcessesStopped(root, absent))
          throw new Error('Prior collaboration broker or native process group has not safely stopped.');
        // Recheck artifact ownership immediately before launchd mutation.
        status = await inspect();
        if (!status.loaded) await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, definition.path]);
      }
      return { ...base, installed: true, ...await loadedStatus(run, definition.label), stopped: false, shutdownRequested: false };
    }
    let shutdownRequested = false;
    if (action === 'stop' && status.loaded) {
      await run('launchctl', ['bootout', `gui/${process.getuid()}/${definition.label}`]);
      shutdownRequested = true;
      status = { ...status, ...await loadedStatus(run, definition.label) };
    }
    const stopped = !status.loaded && await collaborationProcessesStopped(root, absent);
    return { ...base, ...status, stopped, shutdownRequested };
  };
  return action === 'status' ? control()
    : withLock(join(root, 'collaboration-install.lock'), control, { recoverDead: true });
}

export async function installCollaboration(options, { run = execute, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('Collaboration LaunchAgent installation supports macOS only.');
  const root = await privateDirectory(options.root);
  const rootStat = await lstat(root);
  if (rootStat.uid !== process.getuid() || (rootStat.mode & 0o077))
    throw new Error('Collaboration root must be private and owned by the current user.');
  const definition = collaborationDefinition({ ...options, root });
  const service = await withLock(join(root, 'collaboration-install.lock'), async () => {
    const agentDirectory = dirname(definition.path);
    await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
    const agentDirectoryStat = await lstat(agentDirectory);
    if (!agentDirectoryStat.isDirectory() || agentDirectoryStat.isSymbolicLink()
        || agentDirectoryStat.uid !== process.getuid() || (agentDirectoryStat.mode & 0o022))
      throw new Error('LaunchAgents directory is not owned or is writable by others.');
    const journalPath = join(root, 'collaboration-install.json');
    let journal = await readJSON(journalPath, null);
    let contents = await readOwnedDefinition(definition.path);
    const loaded = await loadedStatus(run, definition.label);
    if (journal !== null && !validJournal(journal, definition))
      throw new Error('Collaboration installation journal is invalid.');
    if (journal === null && contents !== null)
      throw new Error('Existing collaboration LaunchAgent has no ownership journal; it was preserved.');
    if (journal === null && loaded.loaded)
      throw new Error('A loaded collaboration job already uses this label; it was preserved.');
    if (journal?.phase === 'prepared') {
      if (journal.after !== definition.plist || (contents !== journal.before && contents !== journal.after))
        throw new Error('Prepared collaboration upgrade differs from its journal; it was preserved.');
    } else if (journal && contents !== journal.after) {
      throw new Error('Existing collaboration LaunchAgent differs from its ownership journal; it was preserved.');
    }
    if (contents !== definition.plist) {
      if (loaded.loaded) throw new Error('Stop the loaded collaboration job before upgrading its LaunchAgent.');
      if (journal?.phase !== 'prepared') {
        journal = { version: 1, phase: 'prepared', label: definition.label, path: definition.path,
          before: contents, beforeHash: contents === null ? null : digest(contents),
          after: definition.plist, afterHash: digest(definition.plist), preparedAt: Date.now() };
        await writeJSON(journalPath, journal);
      }
      if (await readOwnedDefinition(definition.path) !== contents)
        throw new Error('Collaboration LaunchAgent changed before publication.');
      if (contents === null) await publishExclusive(definition.path, definition.plist);
      else await atomicWrite(definition.path, definition.plist);
      contents = definition.plist;
    }
    await run('plutil', ['-lint', definition.path]);
    if (!loaded.loaded) await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, definition.path]);
    await writeJSON(journalPath, { ...journal, phase: 'installed', installedAt: Date.now() });
    return { installed: true, label: definition.label, launchAgent: definition.path, loaded: true };
  }, { recoverDead: true });
  let mcp;
  try { mcp = await registerCollaboration({ ...options, root }, { run }); }
  catch (error) { throw new Error(`Collaboration broker is installed; MCP registration stopped: ${error.message}`); }
  return { ...service, mcpRegistered: true, mcp };
}

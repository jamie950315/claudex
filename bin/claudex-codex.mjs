#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { access, chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCodexSocket, inspectCodexSocket, MAX_FRAME_BYTES } from '../src/codex-websocket.mjs';

const execFileAsync = promisify(execFile);
export const SUPPORTED_CODEX_VERSION = 'codex-cli 0.155.0-alpha.16.3';
const ownPath = fileURLToPath(import.meta.url);
const owns = stat => stat.uid === process.getuid?.() && !stat.isSymbolicLink();
const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; }
};
const maybeStat = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** Replace transport options only; leave every other original argument intact. */
export function sharedServerArguments(args, socketPath) {
  const valueOptions = new Set(['-c', '--config', '--enable', '--disable', '-C', '--cd', '-p', '--profile']);
  const serverValueOptions = new Set(['--code-mode-host', '--ws-auth', '--ws-token-file', '--ws-token-sha256', '--ws-shared-secret-file', '--ws-issuer', '--ws-audience', '--ws-max-clock-skew-seconds']);
  let command = -1;
  for (let i = 0; i < args.length; i++) {
    if (valueOptions.has(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    command = i;
    break;
  }
  if (command < 0 || args[command] !== 'app-server') return null;
  const result = args.slice(0, command + 1);
  for (let i = command + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdio') continue;
    if (arg === '--listen') { if (++i >= args.length) throw new Error('Missing app-server transport argument'); continue; }
    if (arg.startsWith('--listen=')) continue;
    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V') return null;
    if (valueOptions.has(arg) || serverValueOptions.has(arg)) {
      if (i + 1 >= args.length) throw new Error('Missing app-server option argument');
      result.push(arg, args[++i]);
      continue;
    }
    // Subcommands such as proxy and generate-json-schema are not server owners.
    if (!arg.startsWith('-')) return null;
    result.push(arg);
  }
  return [...result, '--listen', `unix://${socketPath}`];
}

async function resolveBinary(value, env) {
  const candidates = value.includes('/') ? [resolve(value)] : (env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(directory, value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const binary = await realpath(candidate);
      if (binary === await realpath(ownPath)) continue;
      return binary;
    } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('A separate executable Codex CLI was not found');
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || !owns(stat) || (stat.mode & 0o777) !== 0o700) throw new Error('The shared transport directory must be owner-only and not a symlink');
}

async function verifiedRecord(path) {
  const stat = await maybeStat(path);
  if (!stat) return null;
  if (!stat.isFile() || !owns(stat) || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error('Invalid shared transport ownership record');
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Incomplete shared transport ownership record; refusing recovery'); }
  if (data.version !== 1 || !Number.isInteger(data.pid) || data.pid <= 0 || !(data.childPid === null || (Number.isInteger(data.childPid) && data.childPid > 0))) throw new Error('Invalid shared transport ownership record');
  return { data, stat };
}

async function unlinkSame(path, expected, allowLink = false) {
  const actual = await maybeStat(path);
  if (!actual) return;
  if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.uid !== process.getuid?.() || (!allowLink && actual.isSymbolicLink())) throw new Error('Shared transport ownership changed; refusing cleanup');
  await unlink(path);
}

async function requireDeadSocket(path) {
  await new Promise((resolveDead, reject) => {
    const probe = net.createConnection({ path });
    const fail = () => { probe.destroy(); reject(new Error('The recorded socket may still have a live listener; refusing recovery')); };
    probe.setTimeout(1000, fail);
    probe.once('connect', fail);
    probe.once('error', error => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED') resolveDead();
      else reject(new Error('Could not verify that the recorded listener is dead'));
    });
  });
}

async function claimOwner(directory, socketPath, binary, cliVersion) {
  const manifestPath = join(directory, 'owner.json');
  if (await maybeStat(join(directory, 'owner.next'))) throw new Error('An interrupted owner checkpoint requires verification before restart');
  const existing = await verifiedRecord(manifestPath);
  if (existing) {
    const { data } = existing;
    if (alive(data.pid) || (data.childPid !== null && alive(data.childPid))) throw new Error('A live process already owns the shared Codex transport');
    if (data.listenerPath !== socketPath || data.binary !== binary || data.cliVersion !== cliVersion) throw new Error('Stale shared transport identity does not match; refusing recovery');
    const socket = await maybeStat(socketPath);
    if (socket) {
      if (data.childPid === null || !data.listenerIdentity || socket.uid !== process.getuid?.() || socket.dev !== data.listenerIdentity.dev || socket.ino !== data.listenerIdentity.ino) throw new Error('Unproven stale socket ownership; refusing recovery');
      const target = data.socketPath && await maybeStat(data.socketPath);
      if (target) {
        const verified = await inspectCodexSocket(socketPath);
        if (verified.socketPath !== data.socketPath || target.dev !== data.socketIdentity?.dev || target.ino !== data.socketIdentity?.ino) throw new Error('The stale socket identity changed');
        await requireDeadSocket(verified.socketPath);
      } else if (!socket.isSymbolicLink() || await readlink(socketPath) !== data.socketPath) throw new Error('Unproven stale socket alias; refusing recovery');
      await unlinkSame(socketPath, socket, true);
    }
    await unlinkSame(manifestPath, existing.stat);
  } else if (await maybeStat(socketPath)) throw new Error('A socket exists without an ownership record; refusing replacement');
  const handle = await open(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const record = { version: 1, pid: process.pid, childPid: null, listenerPath: socketPath, listenerIdentity: null, socketPath: null, socketIdentity: null, binary, cliVersion };
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
  let manifestStat = await lstat(manifestPath);
  let stagedStat;
  const save = async patch => {
    Object.assign(record, patch);
    const stagedPath = join(directory, 'owner.next');
    const staged = await open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { stagedStat = await staged.stat(); await staged.writeFile(`${JSON.stringify(record)}\n`); await staged.sync(); } finally { await staged.close(); }
    const current = await lstat(manifestPath);
    if (current.ino !== manifestStat.ino || current.dev !== manifestStat.dev) throw new Error('Shared owner record changed');
    await rename(stagedPath, manifestPath);
    stagedStat = null;
    manifestStat = await lstat(manifestPath);
  };
  return {
    childStarted: pid => save({ childPid: pid }),
    listenerReady: endpoint => save({
      listenerIdentity: { dev: endpoint.listenerStat.dev, ino: endpoint.listenerStat.ino },
      socketPath: endpoint.socketPath,
      socketIdentity: { dev: endpoint.socketStat.dev, ino: endpoint.socketStat.ino },
    }),
    async cleanup(socketStat) {
      if (record.childPid !== null && alive(record.childPid)) throw new Error('The owned backend has not exited; keeping its ownership record');
      await unlinkSame(socketPath, socketStat, true);
      if (stagedStat) await unlinkSame(join(directory, 'owner.next'), stagedStat);
      await unlinkSame(manifestPath, manifestStat);
    },
  };
}

function waitChild(child) {
  return new Promise(resolveExit => {
    child.once('error', () => resolveExit({ code: 1, signal: null }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function passthrough(binary, args, env) {
  const child = spawn(binary, args, { env, stdio: 'inherit' });
  const result = waitChild(child);
  const term = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  const interrupt = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT'); };
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  let outcome;
  try { outcome = await result; }
  finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
  if (outcome.signal) process.kill(process.pid, outcome.signal);
  return outcome.code ?? 1;
}

/** Framing adapter only: it neither initializes nor modifies Desktop requests. */
export async function runCodexLauncher(args = process.argv.slice(2), env = process.env) {
  const binary = await resolveBinary(env.CLAUDEX_CODEX_BINARY || 'codex', env);
  // CUA and Browser Use launch this exact standalone stdio helper. Browser Use
  // deliberately omits the app-tools pipe; neither helper is the Desktop owner.
  if (args.length === 3 && args[0] === 'app-server' && args[1] === '--listen' && args[2] === 'stdio://') {
    return passthrough(binary, args, env);
  }
  const root = resolve(env.CLAUDEX_HOME || join(homedir(), '.local', 'share', 'claudex'));
  const directory = join(root, 'codex-shared');
  const socketPath = join(directory, 'app.sock');
  const serverArgs = sharedServerArguments(args, socketPath);
  if (!serverArgs) return passthrough(binary, args, env);
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103) throw new Error('The shared Codex socket path is too long');
  const version = (await execFileAsync(binary, ['--version'], { env, timeout: 5000, maxBuffer: 4096 })).stdout.trim();
  if (version !== SUPPORTED_CODEX_VERSION) throw new Error('Unsupported Codex version for shared transport');
  await privateDirectory(root);
  await privateDirectory(directory);
  const owner = await claimOwner(directory, socketPath, binary, version);
  let child;
  let childDone;
  let socketStat;
  let resolvedSocketPath;
  let ws;
  let stopped = false;
  let failure = false;
  const stop = () => {
    stopped = true;
    process.stdin.pause();
    ws?.terminate();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const onOutputError = () => { failure = true; stop(); };
  process.stdout.on('error', onOutputError);
  try {
    const previousMask = process.umask(0o077);
    try { child = spawn(binary, serverArgs, { env, stdio: ['pipe', 'ignore', 'ignore'] }); }
    finally { process.umask(previousMask); }
    childDone = waitChild(child);
    if (!child.pid) throw new Error('Could not start shared Codex backend');
    await owner.childStarted(child.pid);
    childDone.then(() => { if (!stopped) failure = true; stopped = true; process.stdin.destroy(); ws?.terminate(); });
    const deadline = Date.now() + 30000;
    while (!stopped) {
      const stat = await maybeStat(socketPath);
      if (stat) {
        if ((!stat.isSocket() && !stat.isSymbolicLink()) || stat.uid !== process.getuid?.()) throw new Error('The created Codex listener is not an owned socket');
        socketStat = stat;
        if (!stat.isSymbolicLink()) await chmod(socketPath, 0o600);
        const endpoint = await inspectCodexSocket(socketPath);
        resolvedSocketPath = endpoint.socketPath;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Codex backend exited during listener validation');
        await owner.listenerReady(endpoint);
        break;
      }
      if (Date.now() >= deadline) throw new Error('Timed out starting the shared Codex listener');
      await delay(25);
    }
    if (stopped) throw new Error('Codex backend exited before transport was ready');
    ws = await connectCodexSocket(resolvedSocketPath);
    ws.on('error', () => { failure = true; stop(); });
    ws.on('close', () => { if (!stopped) { failure = true; stop(); } });
    ws.on('message', (data, binaryFrame) => {
      if (binaryFrame || process.stdout.writableLength + data.length + 1 > MAX_FRAME_BYTES) { failure = true; stop(); return; }
      if (!process.stdout.write(Buffer.concat([data, Buffer.from('\n')]))) {
        ws.pause();
        process.stdout.once('drain', () => { if (!stopped) ws.resume(); });
      }
    });
    let tail = Buffer.alloc(0);
    try {
      for await (const chunk of process.stdin) {
        if (stopped) break;
        tail = Buffer.concat([tail, chunk]);
        let start = 0;
        let end;
        while ((end = tail.indexOf(0x0a, start)) >= 0) {
          const line = tail.subarray(start, end);
          if (line.length > MAX_FRAME_BYTES) throw new Error('Desktop JSONL frame exceeds the transport size limit');
          if (line.length) await new Promise((resolveSend, reject) => ws.send(line, { binary: false }, error => error ? reject(new Error('Desktop transport send failed')) : resolveSend()));
          start = end + 1;
        }
        tail = tail.subarray(start);
        if (tail.length > MAX_FRAME_BYTES) throw new Error('Desktop JSONL frame exceeds the transport size limit');
      }
    } catch (error) { if (!stopped) throw error; }
    // EOF is the end of Desktop ownership. A partial final frame is never sent.
    if (tail.length) failure = true;
    stop();
    const result = await childDone;
    return failure ? 1 : result.code ?? (result.signal === 'SIGTERM' ? 0 : 1);
  } finally {
    stop();
    if (childDone) await childDone;
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.stdout.off('error', onOutputError);
    await owner.cleanup(socketStat);
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === ownPath) {
  runCodexLauncher().then(code => { process.exitCode = code; }).catch(() => {
    // Do not print native arguments, private environment values, or RPC content.
    process.stderr.write('Claudex could not establish the shared Codex transport; no automatic fallback was started.\n');
    process.exitCode = 1;
  });
}

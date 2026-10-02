import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, basename, isAbsolute, normalize, sep } from 'node:path';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_WIRE_BYTES = 512 * 1024;
const identityKeys = ['dev', 'ino', 'uid', 'mode', 'nlink', 'ctimeNs', 'mtimeNs'];
const sameStat = (a, b) => identityKeys.every(key => a[key] === b[key]);
const failure = code => Object.assign(new Error(`Own-inbox inspection failed: ${code}.`), { code });
const requireValue = (value, code) => { if (!value) throw failure(code); };

function configuration(options) {
  const env = options.env ?? process.env;
  const uid = options.uid ?? process.getuid?.();
  const platform = options.platform ?? process.platform;
  requireValue(platform === 'darwin', 'unsupported-platform');
  requireValue(Number.isSafeInteger(uid) && uid >= 0, 'invalid-owner');
  const path = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  requireValue(typeof path === 'string' && path.length > 1 && path.length <= 1024
    && isAbsolute(path) && normalize(path) === path && !/[\u0000\r\n]/u.test(path), 'missing-native-inbox');
  requireValue(typeof token === 'string' && token.length > 0 && token.length <= 4096
    && !/[\u0000\r\n]/u.test(token), 'missing-native-token');
  const pending = new Set();
  const execute = options.execute ?? run;
  return { path, token, uid, pending, abort: new AbortController(),
    execute: (...args) => {
      const task = Promise.resolve().then(() => execute(...args));
      pending.add(task);
      task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    }, getParentPid: options.getParentPid ?? (() => process.ppid) };
}

async function fileProof(config) {
  // Darwin's system /var and /tmp aliases are the only permitted symlinks.
  // All user-controlled components, including the inbox and private parent,
  // must be inspected without following a link.
  const components = config.path.split(sep).filter(Boolean);
  let current = '';
  for (let index = 0; index < components.length; index++) {
    current += `${sep}${components[index]}`;
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      requireValue(index === 0 && ['/var', '/tmp'].includes(current) && stat.uid === 0n
        && await realpath(current) === `/private${current}`, 'unsafe-inbox-link');
    } else if (index < components.length - 1) {
      requireValue(stat.isDirectory() && (stat.uid === 0n || stat.uid === BigInt(config.uid))
        && ((stat.mode & 0o022n) === 0n || (stat.uid === 0n && (stat.mode & 0o1000n) !== 0n)),
      'unsafe-inbox-ancestor');
    }
  }
  const canonical = await realpath(config.path);
  const pathStat = await lstat(config.path, { bigint: true });
  const socket = await lstat(canonical, { bigint: true });
  const parentPath = dirname(canonical);
  const parent = await lstat(parentPath, { bigint: true });
  requireValue(socket.isSocket() && !pathStat.isSymbolicLink() && sameStat(pathStat, socket)
    && socket.uid === BigInt(config.uid) && socket.nlink === 1n && (socket.mode & 0o777n) === 0o600n,
  'unsafe-inbox-socket');
  requireValue(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === BigInt(config.uid)
    && (parent.mode & 0o777n) === 0o700n && await realpath(parentPath) === parentPath,
  'unsafe-inbox-parent');
  return { canonical, socket, parent };
}

async function parentProof(config, socketPaths) {
  const pid = config.getParentPid();
  requireValue(Number.isSafeInteger(pid) && pid > 1, 'invalid-native-parent');
  // Fixed system executables, no shell, no inherited credential environment.
  // execFile bounds and reaps each short-lived metadata process on failure.
  const settings = { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' },
    timeout: 2000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL', signal: config.abort.signal };
  const { stdout: processOutput } = await config.execute('/bin/ps',
    ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,comm='], settings);
  requireValue(typeof processOutput === 'string' && processOutput.length <= 8192, 'invalid-native-parent');
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+([^\r\n]+)\s*$/u.exec(processOutput);
  requireValue(match && Number(match[1]) === pid && Number(match[3]) === config.uid
    && basename(match[5].trim()) === 'claude', 'invalid-native-parent');
  const { stdout: socketOutput } = await config.execute('/usr/sbin/lsof',
    ['-a', '-p', String(pid), '-U', '-F', 'pftn'], settings);
  requireValue(typeof socketOutput === 'string' && socketOutput.length <= 256 * 1024, 'invalid-socket-owner');
  let currentPid, file, matches = 0;
  const flush = () => {
    if (file && currentPid === pid && file.type === 'unix' && socketPaths.includes(file.name)) matches++;
  };
  for (const row of socketOutput.split('\n')) {
    if (!row) continue;
    if (row.startsWith('p')) { flush(); file = null; currentPid = Number(row.slice(1)); }
    else if (row.startsWith('f')) { flush(); file = {}; }
    else if (row.startsWith('t') && file) file.type = row.slice(1);
    else if (row.startsWith('n') && file) file.name = row.slice(1);
  }
  flush();
  // Darwin lsof names both the listening FD and an accepted connection with
  // the same pathname. Every counted FD still belongs to this exact parent;
  // socket identity and private ownership are checked independently above.
  requireValue(matches >= 1 && config.getParentPid() === pid, 'invalid-socket-owner');
  return { pid, birth: match[4].replace(/\s+/gu, ' '), executable: match[5].trim() };
}

const sameProof = (a, b) => a.files.canonical === b.files.canonical
  && sameStat(a.files.socket, b.files.socket) && sameStat(a.files.parent, b.files.parent)
  && a.parent.pid === b.parent.pid && a.parent.birth === b.parent.birth
  && a.parent.executable === b.parent.executable;

async function inspect(config) {
  const files = await fileProof(config);
  const parent = await parentProof(config, [config.path, files.canonical]);
  const after = await fileProof(config);
  requireValue(after.canonical === files.canonical && sameStat(files.socket, after.socket)
    && sameStat(files.parent, after.parent), 'inbox-changed');
  return { files, parent };
}

/** Read-only capability inspection. Never expose the native path or token. */
export async function inspectSelfInbox(options = {}) {
  try {
    await inspect(configuration(options));
    return { ready: true, transport: 'own-inbox', platform: 'darwin' };
  } catch (error) { throw failure(safeCode(error)); }
}

const errorCodes = new Set(['unsupported-platform', 'invalid-owner', 'missing-native-inbox', 'missing-native-token',
  'unsafe-inbox-link', 'unsafe-inbox-ancestor', 'unsafe-inbox-socket', 'unsafe-inbox-parent', 'invalid-native-parent',
  'invalid-socket-owner', 'inbox-changed', 'invalid-text', 'invalid-timeout', 'before-write-refused']);
const safeCode = error => errorCodes.has(error?.code) ? error.code : 'inspection-failed';

/**
 * One authorized own-child submission, never a send retry. Native 2.1.286's
 * inbox provides no delivery receipt. A completed socket flush is only
 * `submitted`; native policy can hold/refuse it and only a real Stop ACK proves
 * reception. The caller owns the durable claim and no-replay journal.
 */
export async function submitSelfInbox(text, options = {}) {
  const outcome = (state, reason) => ({ state, reason, automaticReplay: false });
  let config, initial, userLine;
  try {
    requireValue(typeof text === 'string' && text.length > 0 && Buffer.byteLength(text) <= MAX_TEXT_BYTES, 'invalid-text');
    requireValue(typeof options.beforeWrite === 'function', 'before-write-refused');
    requireValue(options.timeoutMs === undefined || (Number.isInteger(options.timeoutMs)
      && options.timeoutMs >= 1 && options.timeoutMs <= 30000), 'invalid-timeout');
    config = configuration(options);
    userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    requireValue(Buffer.byteLength(userLine) + Buffer.byteLength(JSON.stringify({ type: 'auth', token: config.token }))
      + 2 <= MAX_WIRE_BYTES, 'invalid-text');
    initial = await inspect(config);
  } catch (error) { return outcome('rejected', safeCode(error)); }

  return new Promise(resolve => {
    let socket, finished = false, mayHaveWritten = false, receivedBytes = 0;
    const finish = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      config.abort.abort();
      // Drain the exact metadata children started by this invocation. A timeout
      // cannot leave a live ps/lsof child or allow a late validation to write.
      Promise.allSettled([...config.pending]).then(() =>
        resolve(outcome(mayHaveWritten ? 'uncertain' : 'rejected', reason)));
    };
    const timer = setTimeout(() => finish('socket-timeout'), options.timeoutMs ?? 5000);
    const connected = async () => {
      try {
        requireValue(sameProof(initial, await inspect(config)), 'inbox-changed');
        if (finished) return;
        requireValue(await options.beforeWrite() === true, 'before-write-refused');
        if (finished) return;
        // Recheck after the caller's awaited claim/app-stop/context validation.
        requireValue(sameProof(initial, await inspect(config)), 'inbox-changed');
        if (finished) return;
        const payload = `${JSON.stringify({ type: 'auth', token: config.token })}\n${userLine}\n`;
        mayHaveWritten = true;
        socket.end(payload, () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(outcome('submitted', 'socket-written'));
        });
      } catch (error) { finish(safeCode(error)); }
    };
    try {
      socket = (options.connect ?? createConnection)({ path: initial.files.canonical });
      socket.once('connect', connected);
      socket.once('error', () => finish('socket-error'));
      socket.once('close', () => finish('socket-closed'));
      // No native ACK is defined. Never parse arbitrary reply bytes or retain
      // them in a result; the local writer only waits for its flush callback.
      socket.on('data', chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes > 4096) finish('socket-response-bound');
      });
    } catch { finish('socket-connect-failed'); }
  });
}

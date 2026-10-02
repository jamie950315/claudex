import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inspectSelfInbox, submitSelfInbox } from '../src/claude-mod-self-inbox.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-own-inbox-')));
  await chmod(root, 0o700);
  const path = join(root, 'native.sock');
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(path, resolve).once('error', reject));
  await chmod(path, 0o600);
  const connections = new Set();
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
  });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const uid = process.getuid();
  const pid = 42424;
  const calls = [];
  const execute = async (command, args, settings) => {
    calls.push({ command, args, settings });
    if (command === '/bin/ps') return { stdout: `${pid} 1 ${uid} Fri Oct  2 00:00:00 2026 /Applications/Claude.app/Contents/MacOS/claude\n` };
    assert.equal(command, '/usr/sbin/lsof');
    return { stdout: `p${pid}\nf12\ntunix\nn${path}\n` };
  };
  const options = { platform: 'darwin', uid, getParentPid: () => pid, execute,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: path, CLAUDE_CODE_MESSAGING_TOKEN: 'synthetic-own-token' },
    beforeWrite: async () => true };
  return { root, path, server, calls, execute, options };
}

test('read-only inspection checks native parent and private socket without disclosing native configuration', async t => {
  const f = await fixture(t);
  assert.deepEqual(await inspectSelfInbox(f.options), { ready: true, transport: 'own-inbox', platform: 'darwin' });
  assert.equal(f.calls.length, 2);
  for (const { command, args, settings } of f.calls) {
    assert.ok(['/bin/ps', '/usr/sbin/lsof'].includes(command));
    assert.ok(!JSON.stringify(args).includes('token'));
    assert.equal(settings.env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
    assert.equal(settings.killSignal, 'SIGKILL');
    assert.equal(settings.timeout, 2000);
  }
});

test('single native write reports submitted only, using auth and user lines with no invented provenance', async t => {
  const f = await fixture(t);
  let connections = 0;
  const received = new Promise(resolve => f.server.on('connection', socket => {
    connections++;
    let content = '';
    socket.on('data', chunk => content += chunk);
    socket.on('end', () => resolve(content));
  }));
  const result = await submitSelfInbox('quoted peer text', f.options);
  assert.deepEqual(result, { state: 'submitted', reason: 'socket-written', automaticReplay: false });
  const lines = (await received).trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [{ type: 'auth', token: 'synthetic-own-token' },
    { type: 'user', message: { role: 'user', content: 'quoted peer text' } }]);
  assert.equal(connections, 1);
  assert.ok(!JSON.stringify(result).includes(f.path));
  assert.equal(f.calls.length, 6);
});

test('Darwin listener and accepted connection may share the exact parent-owned socket pathname', async t => {
  const f = await fixture(t);
  let inspections = 0;
  const received = new Promise(resolve => f.server.on('connection', socket => {
    let bytes = 0;
    socket.on('data', chunk => bytes += chunk.length);
    socket.on('end', () => resolve(bytes));
  }));
  const result = await submitSelfInbox('self delivery', { ...f.options,
    execute: async (command, ...args) => {
      const result = await f.execute(command, ...args);
      if (command === '/usr/sbin/lsof' && ++inspections > 1)
        return { stdout: `${result.stdout}f23\ntunix\nn${f.path}\n` };
      return result;
    } });
  assert.equal(result.state, 'submitted');
  assert.ok(await received > 0);
  assert.equal(inspections, 3);
});

test('missing native token and unsupported platform fail closed without connecting', async t => {
  const f = await fixture(t);
  let connected = false;
  const connect = () => { connected = true; throw Error('must not connect'); };
  assert.equal((await submitSelfInbox('text', { ...f.options, connect, platform: 'linux' })).reason, 'unsupported-platform');
  assert.equal((await submitSelfInbox('text', { ...f.options, connect,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: f.path } })).reason, 'missing-native-token');
  assert.equal(connected, false);
});

test('socket symlinks, private-parent symlinks and non-private parent are rejected', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias.sock');
  await symlink(f.path, alias);
  await assert.rejects(inspectSelfInbox({ ...f.options, env: { ...f.options.env,
    CLAUDE_CODE_MESSAGING_SOCKET: alias } }), { code: 'unsafe-inbox-link' });
  const parentAlias = `${f.root}-alias`;
  await symlink(f.root, parentAlias);
  t.after(() => rm(parentAlias));
  await assert.rejects(inspectSelfInbox({ ...f.options, env: { ...f.options.env,
    CLAUDE_CODE_MESSAGING_SOCKET: join(parentAlias, 'native.sock') } }), { code: 'unsafe-inbox-link' });
  await chmod(f.root, 0o755);
  await assert.rejects(inspectSelfInbox(f.options), { code: 'unsafe-inbox-parent' });
});

test('regular files and foreign socket ownership are not native inboxes', async t => {
  const f = await fixture(t);
  const file = join(f.root, 'not-socket');
  await writeFile(file, '', { mode: 0o600 });
  await assert.rejects(inspectSelfInbox({ ...f.options, env: { ...f.options.env,
    CLAUDE_CODE_MESSAGING_SOCKET: file } }), { code: 'unsafe-inbox-socket' });
  await assert.rejects(inspectSelfInbox({ ...f.options, uid: process.getuid() + 1 }));
});

test('parent process must be Claude and own this exact socket', async t => {
  const f = await fixture(t);
  await assert.rejects(inspectSelfInbox({ ...f.options, execute: async (command, ...args) => {
    const result = await f.execute(command, ...args);
    return { stdout: command === '/bin/ps' ? result.stdout.replace('/MacOS/claude', '/MacOS/not-claude') : result.stdout };
  } }), { code: 'invalid-native-parent' });
  await assert.rejects(inspectSelfInbox({ ...f.options, execute: async (command, ...args) => {
    const result = await f.execute(command, ...args);
    return { stdout: command === '/usr/sbin/lsof' ? result.stdout.replace(f.path, '/another/native.sock') : result.stdout };
  } }), { code: 'invalid-socket-owner' });
});

test('parent birth change and socket permission change during claim validation prevent any payload', async t => {
  const f = await fixture(t);
  let bytes = 0;
  f.server.on('connection', socket => socket.on('data', chunk => bytes += chunk.length));
  let changed = false;
  const result = await submitSelfInbox('text', { ...f.options,
    beforeWrite: async () => { changed = true; return true; },
    execute: async (command, ...args) => {
      const result = await f.execute(command, ...args);
      return { stdout: changed && command === '/bin/ps' ? result.stdout.replace('00:00:00', '00:00:01') : result.stdout };
    } });
  assert.equal(result.state, 'rejected');
  assert.equal(result.reason, 'inbox-changed');
  assert.equal(bytes, 0);
  const modeResult = await submitSelfInbox('text', { ...f.options,
    beforeWrite: async () => { await chmod(f.path, 0o666); return true; } });
  assert.equal(modeResult.state, 'rejected');
  assert.equal(modeResult.reason, 'unsafe-inbox-socket');
  assert.equal(bytes, 0);
});

test('claim refusal or thrown private error sends nothing and exposes only fixed reasons', async t => {
  const f = await fixture(t);
  const no = await submitSelfInbox('text', { ...f.options, beforeWrite: async () => false });
  assert.equal(no.reason, 'before-write-refused');
  const thrown = await submitSelfInbox('text', { ...f.options,
    beforeWrite: async () => { throw Error('SECRET private token/path'); } });
  assert.equal(thrown.state, 'rejected');
  assert.equal(thrown.reason, 'inspection-failed');
  assert.ok(!JSON.stringify(thrown).includes('SECRET'));
});

function fakeSocket(behavior) {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.end = behavior;
  return socket;
}

test('connection timeout is pre-dispatch rejected, with one connect and no retry', async t => {
  const f = await fixture(t);
  let connects = 0;
  const result = await submitSelfInbox('text', { ...f.options, timeoutMs: 10,
    connect: () => { connects++; return fakeSocket(() => assert.fail('must not write')); } });
  assert.deepEqual(result, { state: 'rejected', reason: 'socket-timeout', automaticReplay: false });
  assert.equal(connects, 1);
});

test('write timeout or thrown write remains uncertain and never reconnects', async t => {
  const f = await fixture(t);
  for (const shouldThrow of [false, true]) {
    let writes = 0, connects = 0;
    const result = await submitSelfInbox('text', { ...f.options, timeoutMs: 50,
      connect: () => {
        connects++;
        const socket = fakeSocket(() => { writes++; if (shouldThrow) throw Error('private failure'); });
        setImmediate(() => socket.emit('connect'));
        return socket;
      } });
    assert.equal(result.state, 'uncertain');
    assert.equal(result.automaticReplay, false);
    assert.equal(connects, 1);
    assert.equal(writes, 1);
  }
});

test('late claim validation after timeout cannot write', async t => {
  const f = await fixture(t);
  let release, writes = 0;
  const held = new Promise(resolve => release = resolve);
  const result = await submitSelfInbox('text', { ...f.options, timeoutMs: 20,
    beforeWrite: () => held,
    connect: () => {
      const socket = fakeSocket(() => writes++);
      setImmediate(() => socket.emit('connect'));
      return socket;
    } });
  assert.equal(result.state, 'rejected');
  release(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});

test('bounded text and timeout validation run before any socket connection', async t => {
  const f = await fixture(t);
  const connect = () => assert.fail('must not connect');
  for (const text of ['', 'x'.repeat(256 * 1024 + 1), '\u0001'.repeat(100000), null]) {
    assert.equal((await submitSelfInbox(text, { ...f.options, connect })).reason, 'invalid-text');
  }
  assert.equal((await submitSelfInbox('text', { ...f.options, connect, timeoutMs: 30001 })).reason, 'invalid-timeout');
});

test('timeout aborts and drains the exact in-flight metadata child before returning', async t => {
  const f = await fixture(t);
  let queries = 0, drained = false, aborted = false;
  const result = await submitSelfInbox('text', { ...f.options, timeoutMs: 15,
    execute: async (command, args, settings) => {
      queries++;
      if (queries > 2) {
        await new Promise((resolve, reject) => settings.signal.addEventListener('abort', () => {
          aborted = true;
          setImmediate(() => { drained = true; reject(Error('aborted child')); });
        }, { once: true }));
      }
      return f.execute(command, args, settings);
    },
    connect: () => {
      const socket = fakeSocket(() => assert.fail('must not write'));
      setImmediate(() => socket.emit('connect'));
      return socket;
    } });
  assert.equal(result.reason, 'socket-timeout');
  assert.equal(result.state, 'rejected');
  assert.equal(aborted, true);
  assert.equal(drained, true);
});

test('unexpected socket response is bounded and never treated as a delivery acknowledgement', async t => {
  const f = await fixture(t);
  const result = await submitSelfInbox('text', { ...f.options,
    connect: () => {
      const socket = fakeSocket(() => {});
      setImmediate(() => socket.emit('data', Buffer.alloc(4097)));
      return socket;
    } });
  assert.equal(result.reason, 'socket-response-bound');
  assert.equal(result.state, 'rejected');
});

test('Darwin root-owned /tmp alias can address a canonical private socket', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp('/tmp/claudex-native-alias-');
  await chmod(root, 0o700);
  const path = join(root, 'native.sock');
  const canonical = await realpath(root);
  const server = createServer();
  await new Promise(resolve => server.listen(path, resolve));
  await chmod(path, 0o600);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true }); });
  const uid = process.getuid();
  const result = await inspectSelfInbox({ env: { CLAUDE_CODE_MESSAGING_SOCKET: path, CLAUDE_CODE_MESSAGING_TOKEN: 'test' },
    platform: 'darwin', getParentPid: () => 42424,
    execute: async command => ({ stdout: command === '/bin/ps'
      ? `42424 1 ${uid} Fri Oct  2 00:00:00 2026 /native/claude\n`
      : `p42424\nf9\ntunix\nn${join(canonical, 'native.sock')}\n` }) });
  assert.equal(result.ready, true);
  assert.equal(dirname(path), root);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, access, symlink, realpath, chmod } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexWebSocketClient } from '../src/codex-websocket.mjs';
import { sharedServerArguments, SUPPORTED_CODEX_VERSION } from '../bin/claudex-codex.mjs';

const launcher = fileURLToPath(new URL('../bin/claudex-codex.mjs', import.meta.url));
const wsModule = new URL('../node_modules/ws/wrapper.mjs', import.meta.url).href;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cldx-launch-'));
  const binary = join(root, 'fake-codex.mjs');
  await writeFile(binary, `#!${process.execPath}\nimport http from 'node:http';
import { WebSocketServer } from ${JSON.stringify(wsModule)};
const args = process.argv.slice(2);
if(args[0] === '--version') { console.log(process.env.CLAUDEX_SYNTHETIC_CODEX_VERSION || ${JSON.stringify(SUPPORTED_CODEX_VERSION)}); process.exit(0); }
if(!args.includes('app-server')) { console.log(JSON.stringify({args, inherited:process.env.CLAUDEX_SYNTHETIC_VALUE==='synthetic inherited'})); process.exit(7); }
if(!args.some(arg=>arg.startsWith('unix://'))) {
  process.stdin.setEncoding('utf8');
  let tail='';
  process.stdin.on('data', chunk => {
    tail+=chunk;
    let end;
    while((end=tail.indexOf('\\n'))>=0) {
      const line=tail.slice(0,end); tail=tail.slice(end+1);
      const request=JSON.parse(line);
      console.log(JSON.stringify({id:request.id,result:{args,pid:process.pid,appPipeInherited:process.env.CODEX_APP_TOOLS_PIPE_PATH==='synthetic-pipe'}}));
    }
  });
  await new Promise(resolveEnd => process.stdin.on('end', resolveEnd));
  process.exit(0);
}
const address = args[args.indexOf('--listen')+1];
const server = http.createServer();
const wss = new WebSocketServer({server,path:'/rpc'});
wss.on('connection', socket => socket.on('message', data => {
  const m=JSON.parse(data);
  if(m.id===undefined)return;
  const result=m.method==='initialize'?{userAgent:'synthetic'}:m.method==='probe'?{args,inherited:process.env.CLAUDEX_SYNTHETIC_VALUE==='synthetic inherited',appPipeInherited:process.env.CODEX_APP_TOOLS_PIPE_PATH==='synthetic-pipe',pid:process.pid}:{echo:m};
  socket.send(JSON.stringify({id:m.id,result}));
}));
server.listen(address.slice('unix://'.length));
process.on('SIGTERM',()=>{ for(const socket of wss.clients)socket.terminate(); server.close(()=>process.exit(0)); });
`, { mode: 0o700 });
  const state = join(root, 'state');
  const env = { ...process.env, CLAUDEX_CODEX_BINARY: binary, CLAUDEX_HOME: state, CLAUDEX_SYNTHETIC_VALUE: 'synthetic inherited', CODEX_APP_TOOLS_PIPE_PATH: 'synthetic-pipe' };
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await child.done; }
    await rm(root, { recursive: true, force: true });
  });
  const start = (args, entry = launcher) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.done = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    child.errors = '';
    child.stderr.on('data', data => { child.errors += data; });
    child.lines = createInterface({ input: child.stdout });
    children.push(child);
    return child;
  };
  return { root, state, binary, env, start };
}

async function ready(state) {
  const manifest = join(state, 'codex-shared', 'owner.json');
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const record = JSON.parse(await readFile(manifest));
      if (!record.socketPath) { await delay(10); continue; }
      const stat = await lstat(record.socketPath);
      if (record.childPid && stat.isSocket() && (stat.mode & 0o777) === 0o600) return record;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(10);
  }
  throw new Error('Synthetic listener did not start');
}

function request(child, value) {
  const result = new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { child.lines.off('line', listener); reject(new Error('Synthetic launcher response timed out')); }, 3000);
    const listener = line => { const response = JSON.parse(line); if (response.id === value.id) { clearTimeout(timer); child.lines.off('line', listener); resolveResult(response); } };
    child.lines.on('line', listener);
  });
  child.stdin.write(`${JSON.stringify(value)}\n`);
  return result;
}

test('only app-server listener flags change and nonserver commands pass through', () => {
  assert.deepEqual(sharedServerArguments(['-c', 'foo="app-server"', 'app-server', '--stdio', '-c', 'plugins.codex-app-tools.enabled=true'], '/private/socket'), ['-c', 'foo="app-server"', 'app-server', '-c', 'plugins.codex-app-tools.enabled=true', '--listen', 'unix:///private/socket']);
  assert.deepEqual(sharedServerArguments(['app-server', '--listen=stdio://', '--analytics-default-enabled'], '/private/socket'), ['app-server', '--analytics-default-enabled', '--listen', 'unix:///private/socket']);
  assert.equal(sharedServerArguments(['app-server', 'proxy', '--sock', '/somewhere'], '/private/socket'), null);
  assert.equal(sharedServerArguments(['app-server', '--help'], '/private/socket'), null);
  assert.equal(sharedServerArguments(['exec', 'app-server'], '/private/socket'), null);
  assert.deepEqual(sharedServerArguments(['app-server', '--ws-auth', 'capability-token', '--ws-token-file', '/synthetic/token', '--stdio'], '/private/socket'), ['app-server', '--ws-auth', 'capability-token', '--ws-token-file', '/synthetic/token', '--listen', 'unix:///private/socket']);
});

test('a verified patch update shares the backend using its exact runtime version', { timeout: 10000 }, async t => {
  const { state, start, env } = await fixture(t);
  env.CLAUDEX_SYNTHETIC_CODEX_VERSION = 'codex-cli 0.155.0-alpha.16.4';
  const child = start(['app-server', '--analytics-default-enabled']);
  const record = await ready(state);
  assert.equal(record.cliVersion, env.CLAUDEX_SYNTHETIC_CODEX_VERSION);
  assert.ok(record.socketPath);
  child.stdin.end();
  assert.equal((await child.done).code, 0);
});

test('an unvalidated app update starts the original native transport without enabling sync', { timeout: 10000 }, async t => {
  const { state, start, env } = await fixture(t);
  env.CLAUDEX_SYNTHETIC_CODEX_VERSION = 'codex-cli 99.0.0';
  const args = ['app-server', '--analytics-default-enabled', '-c', 'synthetic="exact value"'];
  const child = start(args);
  const response = (await request(child, { id: 'native', method: 'probe' })).result;
  assert.deepEqual(response.args, args);
  assert.equal(response.appPipeInherited, true);
  assert.match(child.errors, /synchronization is paused.*original native transport/);
  const manifest = JSON.parse(await readFile(join(state, 'codex-shared', 'owner.json')));
  assert.equal(manifest.transportMode, 'native');
  assert.equal(manifest.childPid, response.pid);
  assert.equal(manifest.socketPath, null);
  await assert.rejects(access(join(state, 'codex-shared', 'app.sock')), { code: 'ENOENT' });
  const contender = start(args);
  assert.equal((await contender.done).code, 1);
  assert.equal((await request(child, { id: 'still-native', method: 'probe' })).result.pid, response.pid);
  child.stdin.end();
  assert.equal((await child.done).code, 0);
  await assert.rejects(access(join(state, 'codex-shared', 'owner.json')), { code: 'ENOENT' });
});

test('an unknown version never bypasses an existing shared writer', { timeout: 10000 }, async t => {
  const { state, start, env } = await fixture(t);
  const first = start(['app-server']);
  const record = await ready(state);
  env.CLAUDEX_SYNTHETIC_CODEX_VERSION = 'codex-cli 99.0.0';
  const contender = start(['app-server']);
  assert.equal((await contender.done).code, 1);
  assert.equal((await request(first, { id: 1, method: 'probe' })).result.pid, record.childPid);
  first.stdin.end();
  assert.equal((await first.done).code, 0);
});

test('native-only shutdown releases its lease before propagating termination', { timeout: 10000 }, async t => {
  const { state, start, env } = await fixture(t);
  env.CLAUDEX_SYNTHETIC_CODEX_VERSION = 'codex-cli 99.0.0';
  const child = start(['app-server']);
  const response = (await request(child, { id: 'native', method: 'probe' })).result;
  child.kill('SIGTERM');
  assert.equal((await child.done).signal, 'SIGTERM');
  assert.throws(() => process.kill(response.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(join(state, 'codex-shared', 'owner.json')), { code: 'ENOENT' });
});

test('launcher preserves app configuration and environment, bridges unchanged JSONL, and shares its backend', { timeout: 10000 }, async t => {
  const { state, start } = await fixture(t);
  const args = ['app-server', '--stdio', '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'];
  const child = start(args);
  const record = await ready(state);
  assert.equal((await lstat(dirname(record.socketPath))).mode & 0o777, 0o700);
  assert.equal((await lstat(record.socketPath)).mode & 0o777, 0o600);
  const result = (await request(child, { id: 'desktop', method: 'probe', params: { exact: 'text with whitespace' } })).result;
  assert.deepEqual(result.args, [args[0], ...args.slice(2), '--listen', `unix://${record.socketPath}`]);
  assert.equal(result.inherited, true);
  assert.equal(result.appPipeInherited, true);
  const second = new CodexWebSocketClient({ socketPath: record.socketPath });
  await second.initialize();
  assert.equal((await second.request('probe')).pid, result.pid);
  await second.close();
  assert.equal((await request(child, { id: 2, method: 'probe' })).result.pid, result.pid);
  const manifest = await readFile(join(state, 'codex-shared', 'owner.json'), 'utf8');
  assert.equal(manifest.includes('synthetic-pipe'), false);
  assert.deepEqual(Object.keys(JSON.parse(manifest)).sort(), ['binary', 'childPid', 'cliVersion', 'listenerIdentity', 'listenerPath', 'pid', 'socketIdentity', 'socketPath', 'version']);
  child.stdin.end();
  assert.equal((await child.done).code, 0);
  await assert.rejects(access(record.socketPath), { code: 'ENOENT' });
  await assert.rejects(access(join(state, 'codex-shared', 'owner.json')), { code: 'ENOENT' });
});

test('live ownership is never stolen and SIGTERM stops only the owned child', { timeout: 10000 }, async t => {
  const { state, start } = await fixture(t);
  const original = start(['app-server']);
  const record = await ready(state);
  const contender = start(['app-server']);
  assert.equal((await contender.done).code, 1);
  assert.equal((await request(original, { id: 1, method: 'probe' })).result.pid, record.childPid);
  original.kill('SIGTERM');
  assert.equal((await original.done).code, 0);
  assert.throws(() => process.kill(record.childPid, 0), { code: 'ESRCH' });
});

for (const withAppPipe of [true, false]) test(`observed auxiliary stdio app-server preserves its pipe with app-tools environment ${withAppPipe}`, { timeout: 10000 }, async t => {
  const { state, start, env } = await fixture(t);
  const original = start(['app-server']);
  const record = await ready(state);
  if (!withAppPipe) delete env.CODEX_APP_TOOLS_PIPE_PATH;
  const helper = start(['app-server', '--listen', 'stdio://']);
  const reply = (await request(helper, { id: 1, method: 'probe' })).result;
  assert.deepEqual(reply.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(reply.appPipeInherited, withAppPipe);
  assert.notEqual(reply.pid, record.childPid);
  assert.equal((await request(original, { id: 2, method: 'probe' })).result.pid, record.childPid);
  helper.stdin.end();
  assert.equal((await helper.done).code, 0);
  original.stdin.end();
  assert.equal((await original.done).code, 0);
});

test('non-app-server commands preserve args, exit code, and environment; symlink entry executes', { timeout: 10000 }, async t => {
  const { root, state, start } = await fixture(t);
  const link = join(root, 'launcher-link');
  await symlink(launcher, link);
  const child = start(['features', 'list', '--json'], link);
  const line = new Promise(resolveLine => child.lines.once('line', resolveLine));
  assert.deepEqual(JSON.parse(await line), { args: ['features', 'list', '--json'], inherited: true });
  assert.equal((await child.done).code, 7);
  await assert.rejects(access(state), { code: 'ENOENT' });
});

test('stale records without a socket recover only with exact identity; unknown files are preserved', { timeout: 10000 }, async t => {
  const { state, binary, start } = await fixture(t);
  const directory = join(state, 'codex-shared');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const record = { version: 1, pid: 2147483647, childPid: 2147483646, socketPath: join(directory, 'app.sock'), listenerPath: join(directory, 'app.sock'), listenerIdentity: null, socketIdentity: null, binary: await realpath(binary), cliVersion: SUPPORTED_CODEX_VERSION };
  const manifest = join(directory, 'owner.json');
  const unknownMode = JSON.stringify({ ...record, transportMode: 'unknown-mode' });
  await writeFile(manifest, unknownMode, { mode: 0o600 });
  const unknown = start(['app-server']);
  assert.equal((await unknown.done).code, 1);
  assert.equal(await readFile(manifest, 'utf8'), unknownMode);
  await writeFile(manifest, JSON.stringify(record), { mode: 0o600 });
  const child = start(['app-server']);
  await ready(state);
  await request(child, { id: 1, method: 'probe' });
  child.stdin.end();
  assert.equal((await child.done).code, 0);
  await writeFile(record.socketPath, 'not a socket', { mode: 0o600 });
  const refused = start(['app-server']);
  assert.equal((await refused.done).code, 1);
  assert.equal(await readFile(record.socketPath, 'utf8'), 'not a socket');
});

test('a stale PID record never authorizes stealing a currently listening socket', { timeout: 10000 }, async t => {
  const { state, binary, start } = await fixture(t);
  const directory = join(state, 'codex-shared');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const socketPath = join(directory, 'app.sock');
  const server = net.createServer(socket => socket.end());
  await new Promise(resolveListening => server.listen(socketPath, resolveListening));
  await chmod(socketPath, 0o600);
  t.after(() => new Promise(resolveClosed => server.close(resolveClosed)));
  const manifest = join(directory, 'owner.json');
  const st = await lstat(socketPath);
  const identity = { dev: st.dev, ino: st.ino };
  const original = JSON.stringify({ version: 1, pid: 2147483647, childPid: 2147483646, socketPath, listenerPath: socketPath, listenerIdentity: identity, socketIdentity: identity, binary: await realpath(binary), cliVersion: SUPPORTED_CODEX_VERSION });
  await writeFile(manifest, original, { mode: 0o600 });
  const child = start(['app-server']);
  assert.equal((await child.done).code, 1);
  assert.equal(await readFile(manifest, 'utf8'), original);
  assert.equal((await lstat(socketPath)).isSocket(), true);
});

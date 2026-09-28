import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collaborationDefinition, collaborationMcpRegistration, controlCollaboration, installCollaboration, registerCollaboration } from '../src/collaboration-install.mjs';
import { atomicWrite, publishExclusive, readJSON } from '../src/storage.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-collaboration-install-')));
  const options = { root, home: root, node: process.execPath,
    cli: resolve('bin/claudex-collaboration.mjs') };
  const calls = [];
  let loaded = false;
  let failBootstrap = false;
  let codex = null, claude = null, claudeScope = 'User config';
  return { options, calls, set loaded(value) { loaded = value; }, set failBootstrap(value) { failBootstrap = value; },
    set codex(value) { codex = value; }, set claude(value) { claude = value; },
    set claudeScope(value) { claudeScope = value; },
    deps: { platform: 'darwin', async run(command, args) {
      calls.push([command, ...args]);
      if (command === 'codex' && args[0] === 'mcp' && args[1] === 'get') {
        if (!codex) throw Object.assign(new Error('Missing'), { stderr: "Error: No MCP server named 'claudex-work' found.\n" });
        return { stdout: JSON.stringify(codex) };
      }
      if (command === 'claude' && args[0] === 'mcp' && args[1] === 'get') {
        if (!claude) throw Object.assign(new Error('Missing'), { stdout: 'No MCP server named "claudex-work". Configured servers: none\n' });
        return { stdout: `claudex-work:\n  Scope: ${claudeScope} (available in all your projects)\n  Type: stdio\n` };
      }
      if (command === 'codex' && args[0] === 'mcp' && args[1] === 'add') {
        const commandArgs = args.slice(args.indexOf('--') + 1);
        codex = { name: 'claudex-work', enabled: true,
          transport: { type: 'stdio', command: commandArgs[0], args: commandArgs.slice(1), env: {} } };
      }
      if (command === 'claude' && args[0] === 'mcp' && args[1] === 'add') {
        const commandArgs = args.slice(args.indexOf('--') + 1);
        claude = { type: 'stdio', command: commandArgs[0], args: commandArgs.slice(1) };
        await writeFile(join(root, '.claude.json'), JSON.stringify({ mcpServers: { 'claudex-work': claude } }));
      }
      if (command === 'launchctl' && args[0] === 'print') {
        if (!loaded) throw Object.assign(new Error('Absent job'), { stderr: 'Could not find service' });
        return { stdout: 'state = running' };
      }
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        if (failBootstrap) throw new Error('Synthetic bootstrap interruption');
        loaded = true;
      }
      if (command === 'launchctl' && args[0] === 'bootout') loaded = false;
      return { stdout: '' };
    } } };
}

test('definition isolates root, escapes paths, and exposes separate native MCP commands', () => {
  const options = { root: '/private/bridge & <scope>', cli: '/private/cli & <entry>.mjs',
    node: '/private/node', home: '/private/home', allowWrite: true };
  const definition = collaborationDefinition(options);
  assert.match(definition.label, /^dev\.0ruka\.claudex\.collaboration\.[a-f0-9]{12}$/);
  assert.match(definition.plist, /bridge &amp; &lt;scope&gt;/);
  assert.match(definition.plist, /cli &amp; &lt;entry&gt;\.mjs/);
  assert.match(definition.plist, /<string>--allow-write<\/string>/);
  assert.match(definition.plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(definition.plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(definition.plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(definition.plist, /<key>StandardOutPath<\/key><string>\/dev\/null<\/string>/);
  assert.match(definition.plist, /<key>StandardErrorPath<\/key><string>\/dev\/null<\/string>/);
  assert.match(definition.plist, /<key>EnvironmentVariables<\/key><dict><key>PATH<\/key><string>/);
  assert.match(collaborationDefinition({ ...options, environmentPath: '/usr/bin:/opt/a&b' }).plist,
    /<key>PATH<\/key><string>\/usr\/bin:\/opt\/a&amp;b<\/string>/);
  const mcp = collaborationMcpRegistration(options);
  assert.deepEqual(mcp.codex, ['codex', 'mcp', 'add', 'claudex-work', '--', options.node,
    options.cli, 'mcp', '--root', options.root, '--peer', 'codex']);
  assert.deepEqual(mcp.claude, ['claude', 'mcp', 'add', '--scope', 'user', 'claudex-work', '--', options.node,
    options.cli, 'mcp', '--root', options.root, '--peer', 'claude']);
  assert.doesNotMatch(definition.plist, /claudex-work|--peer|packet-key/);
});

test('control preserves installed options and stops only the exact owned label', async () => {
  const f = await fixture();
  await installCollaboration({ ...f.options, allowWrite: true, defaultPermission: 'workspace-write',
    codexBinary: '/private/codex', claudeBinary: '/private/claude', environmentPath: '/private/a&b:/usr/bin' }, f.deps);
  const definition = collaborationDefinition(f.options);
  const before = await readFile(definition.path, 'utf8');
  const status = await controlCollaboration('status', f.options, f.deps);
  assert.equal(status.running, true);
  const stopped = await controlCollaboration('stop', f.options, f.deps);
  assert.equal(stopped.shutdownRequested, true);
  assert.equal(stopped.stopped, true);
  assert.deepEqual(f.calls.find(call => call[1] === 'bootout'),
    ['launchctl', 'bootout', `gui/${process.getuid()}/${definition.label}`]);
  assert.equal(await readFile(definition.path, 'utf8'), before);
  assert.equal((await controlCollaboration('start', f.options, f.deps)).running, true);
});

test('bootout does not claim native groups stopped and restart waits for absence', async () => {
  const f = await fixture();
  await installCollaboration(f.options, f.deps);
  await atomicWrite(join(f.options.root, 'endpoint.json'), JSON.stringify({ version: 1, pid: 12345 }));
  const deps = { ...f.deps, absent: pid => pid !== -12345 };
  const stopped = await controlCollaboration('stop', f.options, deps);
  assert.equal(stopped.loaded, false);
  assert.equal(stopped.stopped, false);
  await assert.rejects(controlCollaboration('start', f.options, deps), /has not safely stopped/);
  assert.equal((await controlCollaboration('start', f.options, { ...f.deps, absent: () => true })).running, true);
});

test('control rejects changed artifacts, foreign executable identity and unsafe journals', async () => {
  const f = await fixture();
  await installCollaboration(f.options, f.deps);
  await assert.rejects(controlCollaboration('stop', { ...f.options, cli: '/foreign/cli' }, f.deps), /executable or root/);
  await atomicWrite(collaborationDefinition(f.options).path, 'foreign');
  await assert.rejects(controlCollaboration('stop', f.options, f.deps), /exact owned installation/);
  assert.equal(f.calls.some(call => call[1] === 'bootout'), false);
  const g = await fixture();
  await installCollaboration(g.options, g.deps);
  await writeFile(join(g.options.root, 'collaboration-install.json'), '{"version":1}');
  await assert.rejects(controlCollaboration('stop', g.options, g.deps), /exact owned installation/);
});

test('restart preserves unresolved native worker evidence and never signals it', async () => {
  const f = await fixture();
  await installCollaboration(f.options, f.deps);
  f.loaded = false;
  await atomicWrite(join(f.options.root, 'work.json'), JSON.stringify({ version: 1,
    tasks: { worker: { status: 'uncertain', active: { pid: 54321 } } } }));
  await assert.rejects(controlCollaboration('start', f.options,
    { ...f.deps, absent: pid => pid !== -54321 }), /has not safely stopped/);
  assert.equal((await controlCollaboration('status', f.options,
    { ...f.deps, absent: () => true })).stopped, true);
  await atomicWrite(join(f.options.root, 'work.json'), JSON.stringify({ version: 1,
    tasks: { worker: { status: 'running', active: {} } } }));
  await assert.rejects(controlCollaboration('status', f.options, f.deps), /native process identity is missing/);
});

test('new installation journals exact artifact and does not bootstrap again', async () => {
  const f = await fixture();
  const result = await installCollaboration(f.options, f.deps);
  assert.equal(result.installed, true);
  assert.equal(result.mcpRegistered, true);
  const definition = collaborationDefinition(f.options);
  assert.equal(await readFile(definition.path, 'utf8'), definition.plist);
  const journal = await readJSON(join(f.options.root, 'collaboration-install.json'));
  assert.equal(journal.phase, 'installed');
  assert.equal(journal.before, null);
  assert.equal(journal.after, definition.plist);
  await installCollaboration(f.options, f.deps);
  assert.equal(f.calls.filter(call => call[1] === 'bootstrap').length, 1);
  assert.equal(f.calls.some(call => call[1] === 'bootout' || call[1] === 'kickstart'), false);
});

test('interrupted bootstrap resumes from prepared journal', async () => {
  const f = await fixture();
  f.failBootstrap = true;
  await assert.rejects(installCollaboration(f.options, f.deps), /Synthetic bootstrap/);
  assert.equal((await readJSON(join(f.options.root, 'collaboration-install.json'))).phase, 'prepared');
  f.failBootstrap = false;
  await installCollaboration(f.options, f.deps);
  assert.equal((await readJSON(join(f.options.root, 'collaboration-install.json'))).phase, 'installed');
});

test('foreign definitions and loaded label collisions remain untouched', async () => {
  const f = await fixture();
  const definition = collaborationDefinition(f.options);
  const foreign = definition.plist.replace('<key>RunAtLoad</key><true/>', '<key>RunAtLoad</key><false/>');
  await publishExclusive(definition.path, foreign);
  await assert.rejects(installCollaboration(f.options, f.deps), /no ownership journal/);
  assert.equal(await readFile(definition.path, 'utf8'), foreign);
  const g = await fixture();
  g.loaded = true;
  await assert.rejects(installCollaboration(g.options, g.deps), /already uses this label/);
  assert.equal(g.calls.some(call => call[1] === 'bootstrap'), false);
});

test('loaded upgrade is refused; unloaded exact journal upgrade succeeds', async () => {
  const f = await fixture();
  await installCollaboration(f.options, f.deps);
  const changed = { ...f.options, allowWrite: true };
  await assert.rejects(installCollaboration(changed, f.deps), /Stop the loaded collaboration job/);
  assert.equal(await readFile(collaborationDefinition(f.options).path, 'utf8'), collaborationDefinition(f.options).plist);
  f.loaded = false;
  await installCollaboration(changed, f.deps);
  assert.equal(await readFile(collaborationDefinition(changed).path, 'utf8'), collaborationDefinition(changed).plist);
  const journal = await readJSON(join(f.options.root, 'collaboration-install.json'));
  assert.equal(journal.before, collaborationDefinition(f.options).plist);
});

test('modified owned definition and changed prepared publication are refused', async () => {
  const f = await fixture();
  await installCollaboration(f.options, f.deps);
  const definition = collaborationDefinition(f.options);
  const foreign = `${definition.plist}<!-- foreign -->`;
  await atomicWrite(definition.path, foreign);
  await assert.rejects(installCollaboration(f.options, f.deps), /ownership journal/);
  assert.equal(await readFile(definition.path, 'utf8'), foreign);
  const g = await fixture();
  g.failBootstrap = true;
  await assert.rejects(installCollaboration(g.options, g.deps), /Synthetic bootstrap/);
  await atomicWrite(collaborationDefinition(g.options).path, foreign);
  await assert.rejects(installCollaboration(g.options, g.deps), /Prepared collaboration upgrade/);
});

test('foreign Codex registration blocks both native config writes', async () => {
  const f = await fixture();
  f.codex = { name: 'claudex-work', transport: { type: 'stdio', command: '/foreign/agent', args: [], env: {} } };
  await assert.rejects(registerCollaboration(f.options, f.deps), /Existing Codex MCP name/);
  assert.equal(f.calls.some(call => call[2] === 'add'), false);
});

test('foreign Claude registration blocks both native config writes', async () => {
  const f = await fixture();
  const foreign = { type: 'stdio', command: '/foreign/agent', args: [] };
  f.claude = foreign;
  await writeFile(join(f.options.home, '.claude.json'),
    JSON.stringify({ mcpServers: { 'claudex-work': foreign } }));
  await assert.rejects(registerCollaboration(f.options, f.deps), /Existing Claude MCP name/);
  assert.equal(f.calls.some(call => call[2] === 'add'), false);
});

test('a project-scoped Claude name cannot shadow the user connection', async () => {
  const f = await fixture();
  f.claude = { type: 'stdio', command: f.options.node,
    args: [f.options.cli, 'mcp', '--root', f.options.root, '--peer', 'claude'] };
  f.claudeScope = 'Project config';
  await writeFile(join(f.options.home, '.claude.json'),
    JSON.stringify({ mcpServers: { 'claudex-work': { type: 'stdio', command: f.options.node,
      args: [f.options.cli, 'mcp', '--root', f.options.root, '--peer', 'claude'] } } }));
  await assert.rejects(registerCollaboration(f.options, f.deps), /shadowed/);
  assert.equal(f.calls.some(call => call[2] === 'add'), false);
});

test('partial native registration resumes without replacing the first connection', async () => {
  const f = await fixture();
  let failClaude = true;
  const run = async (command, args) => {
    if (command === 'claude' && args[1] === 'add' && failClaude) {
      failClaude = false;
      throw new Error('Synthetic Claude add interruption');
    }
    return f.deps.run(command, args);
  };
  await assert.rejects(registerCollaboration(f.options, { run }), /Claude MCP add failed/);
  const before = f.calls.filter(call => call[0] === 'codex' && call[2] === 'add').length;
  assert.equal(before, 1);
  assert.deepEqual(await registerCollaboration(f.options, { run }),
    { codex: true, claude: true, name: 'claudex-work' });
  assert.equal(f.calls.filter(call => call[0] === 'codex' && call[2] === 'add').length, 1);
});

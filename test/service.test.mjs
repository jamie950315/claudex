import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { controlService, installService, serviceDefinition } from '../src/service.mjs';
import { atomicWrite, publishExclusive, readJSON } from '../src/storage.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-service-test-')));
  const options = { root, cli: resolve('bin/claudex.mjs'), node: process.execPath, path: '/bin:/usr/bin', home: root };
  const calls = []; let loaded = false, failBootstrap = false, loadedOutput = null, ignoreBootstrap = false;
  return { options, calls, set loaded(value) { loaded = value; }, set failBootstrap(value) { failBootstrap = value; },
    set loadedOutput(value) { loadedOutput = value; },
    set ignoreBootstrap(value) { ignoreBootstrap = value; },
    dependencies: { platform: 'darwin', async run(binary, args) {
      calls.push([binary, ...args]);
      if (args[0] === 'print') {
        if (!loaded) throw Object.assign(new Error('Absent test job'), { stderr: 'Could not find service' });
        if (loadedOutput !== null) return { stdout: loadedOutput };
        const definition = serviceDefinition(options);
        const contents = await readFile(definition.path, 'utf8');
        const argumentBlock = contents.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s)[1];
        const argumentsList = [...argumentBlock.matchAll(/<string>(.*?)<\/string>/gs)].map(match => match[1]);
        return { stdout: `path = ${definition.path}\nprogram = ${argumentsList[0]}\narguments = {\n${argumentsList.join('\n')}\n}\nstate = running` };
      }
      if (args[0] === 'bootstrap') {
        if (failBootstrap) throw new Error('Synthetic bootstrap interruption');
        if (!ignoreBootstrap) loaded = true;
      }
      if (args[0] === 'bootout') loaded = false;
      return { stdout: '' };
    } } };
}

test('launchd supervises unexpected exits while preserving native process groups', () => {
  const { plist } = serviceDefinition({ root: '/private/root & quoted', cli: '/private/cli' });
  assert.match(plist, /claudex-service\.mjs/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /root &amp; quoted/);
});

test('exact legacy definition upgrades through a bounded recovery journal and installs once', async () => {
  const f = await fixture();
  const legacy = serviceDefinition({ ...f.options, legacy: true, path: '/different/old/bin:/usr/bin', node: '/old/node' });
  await publishExclusive(legacy.path, legacy.plist);
  assert.equal((await installService(f.options, f.dependencies)).autoRestart, true);
  const journal = await readJSON(join(f.options.root, 'service-install.json'));
  assert.equal(journal.phase, 'installed'); assert.equal(journal.before, legacy.plist);
  assert.equal(await readFile(legacy.path, 'utf8'), serviceDefinition(f.options).plist);
  await installService(f.options, f.dependencies);
  assert.equal(f.calls.filter(call => call[1] === 'bootstrap').length, 1);
});

test('prepared upgrade resumes after publication without another native shutdown', async () => {
  const f = await fixture(); f.failBootstrap = true;
  await assert.rejects(installService(f.options, f.dependencies), /Synthetic bootstrap interruption/);
  assert.equal((await readJSON(join(f.options.root, 'service-install.json'))).phase, 'prepared');
  f.failBootstrap = false;
  await installService(f.options, f.dependencies);
  assert.equal((await readJSON(join(f.options.root, 'service-install.json'))).phase, 'installed');
  assert.equal(f.calls.some(call => call[1] === 'bootout'), false);
});

test('foreign definitions and a changed prepared definition remain untouched', async () => {
  const f = await fixture(), definition = serviceDefinition(f.options);
  const foreign = definition.plist.replace('<key>RunAtLoad</key><true/>', '<key>RunAtLoad</key><false/>');
  await publishExclusive(definition.path, foreign);
  await assert.rejects(installService(f.options, f.dependencies), /differs/);
  assert.equal(await readFile(definition.path, 'utf8'), foreign);
  await assert.rejects(controlService('uninstall', f.options, f.dependencies), /ownership/);
  const g = await fixture(); g.failBootstrap = true;
  await assert.rejects(installService(g.options, g.dependencies), /Synthetic/);
  const changed = `${serviceDefinition(g.options).plist}<!-- foreign -->`;
  await atomicWrite(serviceDefinition(g.options).path, changed);
  await assert.rejects(installService(g.options, g.dependencies), /prepared upgrade/);
  assert.equal(await readFile(serviceDefinition(g.options).path, 'utf8'), changed);
});

test('installation will not unload an active job or replace live native owners', async () => {
  const f = await fixture(), legacy = serviceDefinition({ ...f.options, legacy: true });
  await publishExclusive(legacy.path, legacy.plist); f.loaded = true;
  await assert.rejects(installService(f.options, f.dependencies), /Stop the loaded service/);
  assert.equal(await readFile(legacy.path, 'utf8'), legacy.plist);
  assert.equal(f.calls.some(call => call[1] === 'bootout'), false);
  f.loaded = false;
  await assert.rejects(installService(f.options, { ...f.dependencies, inspect: async () => ({ allowed: false }) }), /native owners/);
  assert.equal(await readFile(legacy.path, 'utf8'), legacy.plist);
});

test('explicit stop is bootout rather than kill/restart and preserves installation for next login', async () => {
  const f = await fixture(); await installService(f.options, f.dependencies);
  assert.equal((await controlService('stop', f.options, f.dependencies)).shutdownRequested, true);
  assert.equal((await controlService('status', f.options, f.dependencies)).loaded, false);
  assert.equal(await readFile(serviceDefinition(f.options).path, 'utf8'), serviceDefinition(f.options).plist);
  assert.equal(f.calls.filter(call => call[1] === 'bootout').length, 1);
  assert.equal(f.calls.some(call => call.includes('kill') || call.includes('kickstart')), false);
});

test('loaded label collisions are refused before stop, start or status can claim an owned service', async () => {
  for (const kind of ['path', 'program', 'arguments']) {
    const f = await fixture(); await installService(f.options, f.dependencies);
    const definition = serviceDefinition(f.options);
    f.loadedOutput = `path = ${kind === 'path' ? '/foreign/job.plist' : definition.path}\nprogram = ${kind === 'program' ? '/bin/sleep' : definition.args[0]}\narguments = {\n${(kind === 'arguments' ? ['/bin/sleep', '300'] : definition.args).join('\n')}\n}\nstate = running`;
    for (const action of ['stop', 'start', 'status'])
      await assert.rejects(controlService(action, f.options, f.dependencies), /Loaded service LaunchAgent differs/);
    await assert.rejects(installService(f.options, f.dependencies), /Loaded service LaunchAgent differs/);
    assert.equal(f.calls.some(call => call[1] === 'bootout'), false);
    assert.equal(await readFile(definition.path, 'utf8'), definition.plist);
  }
});

test('successful bootstrap output without a loaded job leaves installation recoverable', async () => {
  const f = await fixture(); f.ignoreBootstrap = true;
  await assert.rejects(installService(f.options, f.dependencies), /did not become loaded/);
  assert.equal((await readJSON(join(f.options.root, 'service-install.json'))).phase, 'prepared');
  await assert.rejects(controlService('start', f.options, f.dependencies), /did not become loaded/);
  f.ignoreBootstrap = false;
  await installService(f.options, f.dependencies);
  assert.equal((await readJSON(join(f.options.root, 'service-install.json'))).phase, 'installed');
});

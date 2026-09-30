import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppSetup } from '../src/app-setup.mjs';
import { appLaunchDefinition } from '../src/app-login.mjs';

const run = promisify(execFile);
const moduleUrl = file => new URL(`../src/${file}.mjs`, import.meta.url).href;

test('private app state inspections reject real FIFOs without waiting for a writer',
  { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 10000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-app-state-fifo-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'collaboration'), { mode: 0o700 });
    const home = join(root, 'home'), appPath = join(root, 'Fixture.app');
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(appPath, 'Contents', 'MacOS', 'ClaudexApp'), '', { mode: 0o700 });
    const login = appLaunchDefinition({ root, home, appPath });
    const cases = [
      ['app-stop.json', `const { readAppStopState } = await import(${JSON.stringify(moduleUrl('app-stop-state'))}); await readAppStopState(root);`, true],
      ['setup.json', `const { appPrivateJSON } = await import(${JSON.stringify(moduleUrl('app-setup'))}); await appPrivateJSON(root + '/setup.json');`, true],
      ['collaboration/controller-key', `const { AppSetup } = await import(${JSON.stringify(moduleUrl('app-setup'))}); await new AppSetup({ root }).models();`, true],
      ['app-signatures.json', `const { AppSignatureCache } = await import(${JSON.stringify(moduleUrl('app-signature-cache'))}); if (Object.keys(await new AppSignatureCache({ root }).load()).length) throw Error('FIFO was trusted');`, false],
      ['watch.lock', `const { inspectServiceStart } = await import(${JSON.stringify(moduleUrl('service-supervisor'))}); const result = await inspectServiceStart(root); if (result.allowed || result.blockers[0]?.code !== 'unverified-lock') throw Error('FIFO was trusted');`, false],
      [login.path.slice(root.length + 1), `const { installAppLogin } = await import(${JSON.stringify(moduleUrl('app-login'))}); await installAppLogin({ root, home: ${JSON.stringify(home)}, appPath: ${JSON.stringify(appPath)}, platform: 'darwin', run: async () => ({ stdout: '', stderr: 'Identifier=dev.0ruka.claudex.app\\nAuthority=Apple Development: Fixture\\nTeamIdentifier=TESTTEAM00\\n' }) });`, true],
    ];
    for (const [name, operation, mustReject] of cases) {
      await run('/usr/bin/mkfifo', [join(root, name)]);
      const code = `const root = ${JSON.stringify(root)}; let rejected = false; try { ${operation} } catch { rejected = true; } if (rejected !== ${mustReject}) throw Error('Private state contract failed'); console.log('bounded-inspection-passed');`;
      const result = await run(process.execPath, ['--input-type=module', '-e', code], { timeout: 2000 });
      assert.match(result.stdout, /bounded-inspection-passed/, name);
    }
  });

test('read-only app inspection refuses mutations before creating files or calling native tools', async t => {
  const base = await mkdtemp(join(tmpdir(), 'claudex-app-readonly-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'absent'), home = join(base, 'home');
  let calls = 0;
  const app = new AppSetup({ root, home, readOnly: true, run: async () => { calls++; throw Error('Unexpected native mutation'); } });
  const operations = [() => app.setup(), () => app.startup(), () => app.prepareInterface(), () => app.stop(),
    () => app.resumeStoppedServices(), () => app.login('codex'), () => app.providers(true),
    () => app.configureSynchronization({}), () => app.models({ codex: null, claude: null }),
    () => app.models(undefined, { codex: null, claude: null }), () => app.collaborationRequest('start'),
    () => app.collaborationRequest('send'), () => app.collaborationRequest('models', { defaultModels: { codex: null, claude: null } }),
    () => app.collaborationRequest('models', { defaultEfforts: { codex: null, claude: null } })];
  for (const operation of operations) await assert.rejects(operation(), /Read-only application inspection/);
  assert.equal(await app.collaborationRequest('list'), null);
  await assert.rejects(app.collaborationRequest('models'), { code: 'ENOENT' });
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(base), []);
});

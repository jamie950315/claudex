import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyDesktop, createDesktopRelaunch, parseProcesses } from '../src/codex-desktop-relaunch.mjs';

const BUNDLE = '/Applications/Example.app';
const MAIN = `${BUNDLE}/Contents/MacOS/Example`;
const BINARY = `${BUNDLE}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const START = 'Wed Sep 30 01:12:44 2026';
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

async function fixture(t, { pid = deadPid(), shim, children = 'native', entries = {} } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-relaunch-')));
  const codexHome = join(root, 'codex');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'desktop-launcher.json'), JSON.stringify({ shim: join(root, 'codex-launcher'), binary: BINARY }));
  await mkdir(join(root, 'sync-events'));
  await writeFile(join(root, 'sync-events', 'inbox.json'), JSON.stringify({ version: 1, entries }));
  const calls = [];
  const child = children === 'native' ? `${BINARY} -c features.code_mode_host=true app-server --analytics-default-enabled`
    : children === 'shared' ? '/x/node /Applications/Claudex.app/Contents/Resources/engine/bin/claudex-codex.mjs -c a app-server --analytics-default-enabled'
      : `${BINARY} app-server --listen stdio://`;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const out = stdout => ({ stdout, stderr: '' });
    if (command === '/usr/bin/plutil') return out(args[1] === 'CFBundleIdentifier' ? 'com.example.codex' : 'Example');
    if (command === '/bin/ps' && args[0] === '-axo') return out(`  ${pid}     1 ${MAIN}\n  999 ${pid} ${child}\n`);
    if (command === '/bin/ps') return out(START);
    if (command === '/bin/launchctl') return out(shim ?? join(root, 'codex-launcher'));
    return out('');
  };
  let clock = Date.parse('2026-09-30T02:00:00Z');
  const relaunch = createDesktopRelaunch({ root, codexHome, run, now: () => (clock += 1000), sleep: async () => {} });
  return { root, codexHome, calls, relaunch, quits: () => calls.filter(call => call[0] === '/usr/bin/osascript').length,
    opens: () => calls.filter(call => call[0] === '/usr/bin/open') };
}

test('classifies launcher, bypassed, helper-only and absent Desktop process trees', () => {
  const tree = child => parseProcesses(`  10     1 ${MAIN}\n  11    10 ${child}\n`);
  const options = { executable: MAIN, binary: BINARY };
  assert.equal(classifyDesktop(tree('/n /a/claudex-codex.mjs app-server --x'), options).state, 'shared');
  assert.equal(classifyDesktop(tree(`${BINARY} app-server --analytics-default-enabled`), options).state, 'bypassed');
  assert.equal(classifyDesktop(tree(`${BINARY} app-server --listen stdio://`), options).state, 'unknown');
  assert.equal(classifyDesktop([], options).state, 'not-running');
});

test('a bypassed Desktop is quit gracefully once and reopened in the background without waiting for user idleness', async t => {
  const f = await fixture(t);
  assert.equal((await f.relaunch.check()).state, 'relaunched');
  assert.equal(f.quits(), 1);
  assert.deepEqual(f.opens(), [['/usr/bin/open', '-g', '-b', 'com.example.codex']]);
});

test('a Desktop that declines to quit is never force-killed or retried', async t => {
  const f = await fixture(t, { pid: process.pid });
  assert.equal((await f.relaunch.check()).outcome, 'quit-declined');
  assert.equal((await f.relaunch.check()).state, 'relaunch-failed');
  assert.equal(f.quits(), 1); assert.equal(f.opens().length, 0);
});

test('live Codex turns, recent rollouts and a missing override defer the relaunch; user activity does not', async t => {
  const started = Date.parse(START);
  const cases = [
    [{ entries: { a: { side: 'codex', kind: 'started', at: started + 1 } } }, 'Codex activity'],
    [{ shim: '/elsewhere' }, 'launcher override is not active'],
  ];
  for (const [options, waiting] of cases) {
    const f = await fixture(t, options);
    assert.equal((await f.relaunch.check()).waiting, waiting);
    assert.equal(f.quits(), 0);
  }
  const stale = await fixture(t, { entries: { a: { side: 'codex', kind: 'started', at: started - 1 } } });
  assert.equal((await stale.relaunch.check()).state, 'relaunched');

  const f = await fixture(t);
  const day = new Date(Date.parse('2026-09-30T02:00:00Z'));
  const dir = join(f.codexHome, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  await mkdir(dir, { recursive: true });
  const rollout = join(dir, 'rollout-x.jsonl');
  await writeFile(rollout, '{}\n');
  const recent = new Date(day.getTime() - 10_000);
  await utimes(rollout, recent, recent);
  assert.equal((await f.relaunch.check()).waiting, 'Codex activity');
  assert.equal(f.quits(), 0);
});

test('launcher-mode and absent Desktop processes need no action', async t => {
  for (const children of ['shared', 'helper']) {
    const f = await fixture(t, { children });
    assert.notEqual((await f.relaunch.check()).state, 'relaunched');
    assert.equal(f.quits(), 0);
  }
});

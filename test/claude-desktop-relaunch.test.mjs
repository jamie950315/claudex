import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeDesktopRelaunch, CLAUDE_DESKTOP_BUNDLE_ID } from '../src/claude-desktop-relaunch.mjs';
import { startClaudeRendererMaintenance } from '../src/claude-renderer-maintenance.mjs';

const MAIN = '/Applications/Claude.app/Contents/MacOS/Claude';
const HELPER = '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=renderer';
const SESSION = '/Users/example/Library/Application Support/Claude/claude-code/2.1.0/abc/claude.app/Contents/MacOS/claude --output-format stream-json';
const NOW = Date.parse('2026-10-10T03:00:00Z');
const installed = (changed, names = ['folders', 'chatWake', 'ownerWake', 'commands']) =>
  Object.fromEntries(names.map(name => [name, { status: 'installed', asset: `${name}.js`, changed }]));
const pass = (entry, adapters, state = 'ready') => ({ state, entry: { asset: entry }, adapters });

async function fixture(t, { age = 20_000, extra = [], bundleId = CLAUDE_DESKTOP_BUNDLE_ID, entries = {}, mains = 1, quits = true, stopped } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-claude-relaunch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sync-events'));
  await writeFile(join(root, 'sync-events', 'inbox.json'), JSON.stringify({ version: 1, entries }));
  const calls = []; let running = true, clock = NOW;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const out = stdout => ({ stdout, stderr: '' });
    if (command === '/bin/ps' && args[0] === '-axo') return out([...Array.from({ length: mains }, (_, index) => `  ${100 + index}     1 ${MAIN}`),
      `  200   100 ${HELPER}`, ...extra.map(([pid, ppid, text]) => `  ${pid} ${ppid} ${text}`)].join('\n'));
    if (command === '/bin/ps') return out(new Date(NOW - age).toString().slice(0, 24));
    if (command === '/usr/bin/plutil') return out(bundleId);
    if (command === '/usr/bin/osascript' && quits) running = false;
    return out('');
  };
  const relaunch = createClaudeDesktopRelaunch({ root, run, now: () => (clock += 100), sleep: async () => { clock += 1000; },
    alive: () => running, stopState: async () => stopped ? { version: 1, stopped: true } : null });
  const count = command => calls.filter(call => call[0] === command).length;
  return { root, relaunch, calls, count, advance: ms => { clock += ms; },
    record: async () => JSON.parse(await readFile(join(root, 'claude-relaunch.json'), 'utf8')) };
}

test('a newly started idle Desktop is restarted once after every adapter is written for a new frontend', async t => {
  const f = await fixture(t);
  // The lazy command chunk is not cached yet: three adapters are written, one is missing.
  const partial = { ...installed(true, ['folders', 'chatWake', 'ownerWake']), commands: { status: 'skipped' } };
  assert.equal((await f.relaunch.consider(pass('index-new.js', partial, 'degraded'))), null);
  assert.equal((await f.relaunch.consider(pass('index-new.js', partial))).waiting, 'adapters still incomplete');
  assert.equal(f.count('/usr/bin/osascript'), 0);
  // The late chunk arrives; earlier writes for this entry are remembered.
  const complete = installed(false);
  const result = await f.relaunch.consider(pass('index-new.js', complete));
  assert.deepEqual({ state: result.state, entry: result.entry, previousPid: result.previousPid }, { state: 'relaunched', entry: 'index-new.js', previousPid: 100 });
  assert.deepEqual(f.calls.filter(call => call[0] === '/usr/bin/osascript'), [['/usr/bin/osascript', '-e', `tell application id "${CLAUDE_DESKTOP_BUNDLE_ID}" to quit`]]);
  assert.deepEqual(f.calls.at(-1), ['/usr/bin/open', '-b', CLAUDE_DESKTOP_BUNDLE_ID]);
  assert.equal((await f.record()).attempts.at(-1).outcome, 'relaunched');
  // The restarted Desktop loads the patched files; nothing is written, nothing repeats.
  assert.equal(await f.relaunch.consider(pass('index-new.js', installed(false))), null);
  assert.equal((await f.relaunch.consider(pass('index-new.js', installed(true)))).reason, 'already restarted for this frontend');
  assert.equal(f.count('/usr/bin/osascript'), 1);
});

test('nothing is restarted when adapters were already installed or the pass is not coherent', async t => {
  const f = await fixture(t);
  assert.equal(await f.relaunch.consider(pass('index-a.js', installed(false))), null);
  assert.equal(await f.relaunch.consider(pass('index-a.js', installed(true), 'checking')), null);
  assert.equal(await f.relaunch.consider(pass('index-a.js', installed(true), 'held')), null);
  assert.equal(await f.relaunch.consider(null), null);
  assert.equal(f.calls.length, 0);
});

test('work, age, identity and lifecycle each keep the resource restart-required without quitting', async t => {
  for (const [options, reason, state = 'restart-required'] of [
    [{ age: 121_000 }, 'Desktop is no longer newly started'],
    [{ age: -5_000 }, 'Desktop is no longer newly started'],
    [{ extra: [[300, 100, '/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup --'], [301, 300, SESSION]] }, 'a Code session is running'],
    [{ entries: { a: { side: 'claude', kind: 'started', at: NOW - 5_000 } } }, 'Claude activity since start'],
    [{ bundleId: 'com.example.other' }, 'unrecognized Desktop application'],
    [{ mains: 2 }, 'multiple Desktop processes'],
    [{ mains: 0 }, undefined, 'not-running'],
    [{ stopped: true }, undefined, 'waiting'],
  ]) {
    const f = await fixture(t, options), result = await f.relaunch.consider(pass('index-b.js', installed(true)));
    assert.equal(result.state, state, JSON.stringify(options)); assert.equal(result.reason, reason);
    assert.equal(f.count('/usr/bin/osascript'), 0); assert.equal(f.count('/usr/bin/open'), 0);
  }
  // A session elsewhere on the machine and a prompt from before this start are not this Desktop's work.
  const f = await fixture(t, { extra: [[400, 1, SESSION]], entries: { a: { side: 'claude', kind: 'started', at: NOW - 60_000 },
    b: { side: 'codex', kind: 'started', at: NOW } } });
  assert.equal((await f.relaunch.consider(pass('index-b.js', installed(true)))).state, 'relaunched');
});

test('a declined quit is never forced or repeated, and restarts are bounded across frontends', async t => {
  const declined = await fixture(t, { quits: false });
  const result = await declined.relaunch.consider(pass('index-c.js', installed(true)));
  assert.equal(result.reason, 'Desktop declined to quit'); assert.equal(declined.count('/usr/bin/open'), 0);
  assert.equal((await declined.record()).attempts[0].outcome, 'quit-declined');
  assert.equal((await declined.relaunch.consider(pass('index-c.js', installed(true)))).reason, 'already restarted for this frontend');
  assert.equal(declined.count('/usr/bin/osascript'), 1);

  const f = await fixture(t);
  for (const entry of ['index-1.js', 'index-2.js']) assert.equal((await f.relaunch.consider(pass(entry, installed(true)))).state, 'relaunched');
  assert.equal((await f.relaunch.consider(pass('index-3.js', installed(true)))).reason, 'restart limit reached');
  assert.equal(f.count('/usr/bin/osascript'), 2);
});

test('renderer maintenance hands each coherent pass to its consumer and survives that consumer failing', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-claude-relaunch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [], statuses = []; let notify;
  const maintenance = await startClaudeRendererMaintenance({ root, home: root, settleMs: 0, stopState: async () => null,
    watchFactory: (_path, listener) => { notify = listener; return { on() {}, close() {} }; },
    maintain: async () => ({ entry: { asset: 'index-new.js' }, missingChunks: 0, adapters: installed(true) }),
    onStatus: value => statuses.push(value.state),
    afterPass: summary => { seen.push(summary); throw new Error('consumer failure'); } });
  notify('change', null); await new Promise(resolve => setTimeout(resolve, 20)); await maintenance.close();
  assert.equal(seen.length, 2); assert.equal(seen[0].entry.asset, 'index-new.js'); assert.equal(seen[0].adapters.commands.changed, true);
  assert.deepEqual(statuses, ['ready', 'ready']);
});

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

async function fixture(t, { age = 20_000, extra = [], bundleId = CLAUDE_DESKTOP_BUNDLE_ID, entries = {}, mains = 1, quits = true, stopped, root } = {}) {
  if (!root) {
    root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-claude-relaunch-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'sync-events'));
  }
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
  const waiting = await f.relaunch.consider(pass('index-new.js', partial));
  assert.equal(waiting.reason, 'adapters still incomplete'); assert.equal(waiting.notBefore, NOW - 20_000 + 60_000);
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
  // A manual restart after a later write is recognized without another automatic one.
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
    [{ age: 61_000 }, 'Desktop is no longer newly started'],
    [{ age: -5_000 }, undefined, 'current'],
    [{ entries: { a: { side: 'claude', kind: 'started', at: NOW - 5_000 } } }, 'Claude activity since start'],
    [{ bundleId: 'com.example.other' }, 'unrecognized Desktop application'],
    [{ mains: 2 }, 'multiple Desktop processes'],
    [{ mains: 0 }, undefined, 'not-running'],
    [{ stopped: true }, undefined, 'waiting'],
  ]) {
    const f = await fixture(t, options), result = await f.relaunch.consider(pass('index-b.js', installed(true)));
    assert.equal(result.state, state, JSON.stringify(options)); assert.equal(result.reason, reason);
    assert.equal(f.count('/usr/bin/osascript'), 0); assert.equal(f.count('/usr/bin/open'), 0);
    // A restart the user must make names the write it has to follow.
    assert.equal(Number.isFinite(result.requiredSince), state === 'restart-required', JSON.stringify(options));
  }
  const disabled = await fixture(t), manual = await disabled.relaunch.consider(pass('index-b.js', installed(true)), { automatic: false });
  assert.equal(manual.reason, 'automatic restart is disabled'); assert.equal(disabled.count('/usr/bin/osascript'), 0);
  assert.equal((await (await fixture(t, { age: 58_000 })).relaunch.consider(pass('index-b.js', installed(true)))).state, 'relaunched');
  // Desktop starts a Code session process for the session it reopens; that process, a session
  // elsewhere on the machine and a prompt from before this start are not work to protect.
  const f = await fixture(t, { extra: [[300, 100, '/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup --'], [301, 300, SESSION],
    [400, 1, SESSION]], entries: { a: { side: 'claude', kind: 'started', at: NOW - 60_000 },
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

test('a restart request survives a watcher restart and ends once Desktop was started after the write', async t => {
  const first = await fixture(t, { age: 61_000 });
  const asked = await first.relaunch.consider(pass('index-p.js', installed(true)));
  assert.equal(asked.reason, 'Desktop is no longer newly started');
  assert.deepEqual((await first.record()).pending, { entry: 'index-p.js', adapters: ['folders', 'chatWake', 'ownerWake', 'commands'], writtenAt: asked.requiredSince });
  // A new watcher finds everything already installed; the saved write still asks.
  const second = await fixture(t, { age: 61_000, root: first.root });
  const again = await second.relaunch.consider(pass('index-p.js', installed(false)));
  assert.equal(again.state, 'restart-required'); assert.equal(again.requiredSince, asked.requiredSince);
  const third = await fixture(t, { age: -5_000, root: first.root });
  assert.equal((await third.relaunch.consider(pass('index-p.js', installed(false)))).state, 'current');
  assert.equal((await third.record()).pending, undefined);
  assert.equal(await (await fixture(t, { age: 61_000, root: first.root })).relaunch.consider(pass('index-p.js', installed(false))), null);
  assert.equal([first, second, third].reduce((sum, f) => sum + f.count('/usr/bin/osascript'), 0), 0);

  // A write saved while Claudex was stopped still earns the automatic restart, and another frontend drops it.
  const held = await fixture(t, { stopped: true });
  assert.equal((await held.relaunch.consider(pass('index-q.js', installed(true)))).state, 'waiting');
  const resumed = await fixture(t, { root: held.root });
  assert.equal((await resumed.relaunch.consider(pass('index-q.js', installed(false)))).state, 'relaunched');
  const record = await resumed.record();
  assert.equal(record.pending, undefined); assert.equal(record.attempts.at(-1).outcome, 'relaunched');
  const other = await fixture(t, { age: 61_000 });
  await other.relaunch.consider(pass('index-r.js', installed(true)));
  assert.equal(await (await fixture(t, { age: 61_000, root: other.root })).relaunch.consider(pass('index-s.js', installed(false))), null);
  assert.equal((await other.record()).pending, undefined);
});

test('restart-required labels end when the consumer reports that Desktop loaded the written files', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-claude-relaunch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data'), { recursive: true, mode: 0o700 });
  const required = Object.fromEntries(Object.entries(installed(true)).map(([name, adapter]) => [name, { ...adapter, activation: 'restart-required' }]));
  const labels = status => Object.values(status.adapters).map(adapter => `${adapter.changed}/${adapter.activation}`);
  for (const immediate of [true, false]) {
    const seen = [], statuses = []; let notify, calls = 0, loaded = immediate;
    const maintenance = await startClaudeRendererMaintenance({ root, home: root, settleMs: 0, refreshMs: 0, stopState: async () => null,
      watchFactory: (_path, listener) => { notify = listener; return { on() {}, close() {} }; },
      maintain: async () => { calls++; return { entry: { asset: 'index-new.js' }, missingChunks: 0, adapters: structuredClone(required) }; },
      onStatus: value => statuses.push(value),
      afterPass: summary => { seen.push(summary); return { loaded }; } });
    if (immediate) {
      // The automatic restart was made within the pass.
      assert.deepEqual(labels(statuses.at(-1)), Array(4).fill('false/load-not-verified')); assert.equal(statuses.length, 2);
    } else {
      assert.deepEqual(labels(statuses.at(-1)), Array(4).fill('true/restart-required'));
      // The user restarts Desktop: no frontend file changes, only unrelated cache writes arrive.
      notify('change', '0000000000000000_0'); await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(labels(statuses.at(-1)), Array(4).fill('true/restart-required'));
      assert.equal(seen.at(-1).adapters.commands.changed, false, 'a refresh never reports another write');
      loaded = true;
      notify('change', '0000000000000000_0'); await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(labels(statuses.at(-1)), Array(4).fill('false/load-not-verified')); assert.equal(statuses.at(-1).state, 'ready');
      const count = seen.length;
      notify('change', '0000000000000000_0'); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(seen.length, count, 'settled labels ask nothing further');
    }
    assert.equal(calls, 1, 'no cache inspection is added');
    await maintenance.close();
  }
});

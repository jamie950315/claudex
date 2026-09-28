import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SyncEventInbox } from '../src/sync-events.mjs';
import { ChatMailbox } from '../src/chat-mailbox.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'claudex-events-'));
  // macOS /var is an alias; production roots and the inbox require canonical paths.
  const { realpath } = await import('node:fs/promises');
  const inbox = await new SyncEventInbox({ root: await realpath(root) }).initialize();
  t.after(async () => { await inbox.close(); await rm(root, { recursive: true, force: true }); });
  return inbox;
}
const event = (extra = {}) => ({ side: 'claude', nativeId: randomUUID(), kind: 'completed', ...extra });

test('events survive restart, coalesce, and exact acknowledgements retain newer revisions', async t => {
  const inbox = await fixture(t), first = await inbox.publish(event({ turnId: 'one', prompt: 'PRIVATE' }));
  const reopened = await new SyncEventInbox({ root: inbox.root }).initialize();
  assert.equal((await reopened.list())[0].revision, first.revision);
  const newer = await reopened.publish({ ...first, turnId: 'two' });
  await inbox.acknowledge([first]);
  assert.equal((await inbox.list())[0].revision, newer.revision);
  await inbox.acknowledge([newer]);
  assert.deepEqual(await inbox.list(), []);
  const repeated = await inbox.publish({ ...newer });
  assert.notEqual(repeated.revision, newer.revision);
  assert.equal((await inbox.list())[0].revision, repeated.revision);
  assert.doesNotMatch(await readFile(inbox.path, 'utf8'), /PRIVATE|prompt/);
});

test('a repeated completion for the same turn arriving during inspection survives its old acknowledgement', async t => {
  const inbox = await fixture(t), value = event({ turnId: 'same-turn' });
  const beforeCommit = await inbox.publish(value);
  const afterCommit = await inbox.publish(value);
  assert.notEqual(afterCommit.revision, beforeCommit.revision);
  await inbox.acknowledge([beforeCommit]);
  assert.equal((await inbox.list())[0].revision, afterCommit.revision);
  await inbox.acknowledge([afterCommit]);
  const nextCompletion = await inbox.publish(value);
  assert.equal((await inbox.list())[0].revision, nextCompletion.revision);
});

test('same kind without a turn identity produces a fresh wake after acknowledgement', async t => {
  const inbox = await fixture(t), value = event();
  const first = await inbox.publish(value);
  await inbox.acknowledge([first]);
  assert.notEqual((await inbox.publish(value)).revision, first.revision);
});

test('late filesystem changes cannot override a consumed started phase', async t => {
  const inbox = await fixture(t), value = event({ kind: 'started' });
  const started = await inbox.publish(value);
  await inbox.acknowledge([started]);
  const ignored = await inbox.publish({ ...value, kind: 'changed' });
  assert.equal(ignored.revision, started.revision);
  assert.deepEqual(await inbox.list(), []);
  const completed = await inbox.publish({ ...value, kind: 'completed' });
  assert.notEqual(completed.revision, started.revision);
  assert.equal((await inbox.list())[0].kind, 'completed');
});

test('internal configuration hints use durable exact-revision acknowledgement', async t => {
  const inbox = await fixture(t);
  const value = event({ nativeId: '00000000-0000-0000-0000-000000000002', kind: 'configuration' });
  const first = await inbox.publish(value);
  const latest = await inbox.publish(value);
  await inbox.acknowledge([first]);
  assert.equal((await inbox.list())[0].revision, latest.revision);
  await inbox.acknowledge([latest]);
  assert.deepEqual(await inbox.list(), []);
});

test('filesystem notification wakes a sleeping inbox without polling and abort removes listener', async t => {
  const inbox = await fixture(t);
  const pending = inbox.wait();
  await inbox.publish(event());
  const batch = await pending;
  assert.equal(batch.length, 1);
  await inbox.acknowledge(batch);
  const abort = new AbortController(), aborted = inbox.wait({ signal: abort.signal });
  abort.abort();
  assert.deepEqual(await aborted, []);
  assert.deepEqual(await inbox.wait({ timeoutMs: 5 }), []);
});

test('private socket wakes immediately after listener readiness even without filesystem notifications', async t => {
  const inbox = await fixture(t);
  await inbox.startListening();
  inbox.fileWatcher.close();
  const waiting = inbox.wait({ timeoutMs: 2000 });
  assert.deepEqual(await hook(inbox, { hook_event_name: 'Stop', session_id: randomUUID() }), { code: 0, stdout: '', stderr: '' });
  assert.equal((await waiting).length, 1);
  await inbox.acknowledge(await inbox.list());
  const next = inbox.wait({ timeoutMs: 2000 });
  await inbox.publish(event());
  assert.equal((await next).length, 1);
});

test('listener ownership prevents a second consumer and teardown preserves foreign evidence', async t => {
  const inbox = await fixture(t);
  await inbox.startListening();
  const other = await new SyncEventInbox({ root: inbox.root }).initialize();
  await assert.rejects(other.startListening(), /consumer is active/);
  await inbox.close();
  await assert.rejects(readFile(inbox.listenerPath), { code: 'ENOENT' });
  await other.startListening();
  await other.close();
});

test('a new consumer recovers only the exact socket of a confirmed dead listener', async t => {
  const inbox = await fixture(t);
  const script = `import { SyncEventInbox } from './src/sync-events.mjs'; const inbox = await new SyncEventInbox({root:${JSON.stringify(inbox.root)}}).initialize(); await inbox.startListening(); inbox.server.ref(); console.log('ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => child.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
    child.once('exit', () => reject(new Error('Fixture listener exited before readiness.')));
  });
  child.kill('SIGTERM');
  await exited;
  await inbox.startListening();
  assert.equal((await inbox.readListener()).pid, process.pid);
  assert.equal((await inbox.readListener()).revision, inbox.listenerOwner.revision);
});

test('concurrent publishers retain every distinct native identity', async t => {
  const inbox = await fixture(t);
  const second = await new SyncEventInbox({ root: inbox.root }).initialize();
  await Promise.all(Array.from({ length: 15 }, (_, index) => (index % 2 ? inbox : second).publish(event())));
  assert.equal((await inbox.list()).length, 15);
});

test('unsafe files and invalid identity hints fail explicitly', async t => {
  const inbox = await fixture(t);
  await assert.rejects(inbox.publish(event({ nativeId: '../other' })), /identity/);
  await symlink('/etc/passwd', inbox.path);
  await assert.rejects(inbox.list());
});

test('malformed lock evidence remains untouched rather than being retried or removed', async t => {
  const inbox = await fixture(t);
  await writeFile(inbox.lock, 'malformed', { mode: 0o600 });
  await assert.rejects(inbox.publish(event()), /Malformed lock owner/);
  assert.equal(await readFile(inbox.lock, 'utf8'), 'malformed');
});

async function hook(inbox, payload, provider = 'claude') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/claudex-sync-hook.mjs', '--root', inbox.root, '--provider', provider]);
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('coordination Stop continues the exact chat without publishing a completed sync hint', async t => {
  for (const provider of ['codex', 'claude']) {
    const inbox = await fixture(t), session_id = randomUUID(), mailbox = new ChatMailbox({ root: join(inbox.root, 'collaboration', 'chat-mailbox') });
    const base = { session_id, cwd: inbox.root };
    assert.equal((await hook(inbox, { ...base, hook_event_name: 'SessionStart' }, provider)).stdout, '');
    const sent = await mailbox.send({ fromProvider: provider === 'codex' ? 'claude' : 'codex', targetProvider: provider,
      targetSessionId: session_id, message: 'Please stop creating new work and report your status.', requestId: 'coordination-1' });
    const stopped = await hook(inbox, { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: null }, provider);
    assert.equal(stopped.code, 0, stopped.stderr);
    const output = JSON.parse(stopped.stdout);
    const context = provider === 'codex' ? output.reason : output.hookSpecificOutput.additionalContext;
    if (provider === 'codex') assert.equal(output.decision, 'block');
    assert.match(context, new RegExp(`CLAUDEX_ACK:${sent.messageId}`));
    assert.equal((await inbox.list()).find(event => event.nativeId === session_id).kind, 'started');
    assert.equal((await mailbox.status(sent.messageId)).state, 'offered');
    const ack = await hook(inbox, { ...base, hook_event_name: 'Stop', stop_hook_active: true,
      last_assistant_message: `Received.\nCLAUDEX_ACK:${sent.messageId}` }, provider);
    assert.equal(ack.stdout, '');
    assert.equal((await mailbox.status(sent.messageId)).state, 'acknowledged');
    assert.equal((await inbox.list()).find(event => event.nativeId === session_id).kind, 'completed');
  }
});

test('Quit suppresses hook writes until explicit application resume', async t => {
  const inbox = await fixture(t);
  const path = join(inbox.root, 'app-stop.json');
  await writeFile(path, JSON.stringify({ version: 1, stopped: true }), { mode: 0o600 });
  const payload = { hook_event_name: 'Stop', session_id: randomUUID() };
  assert.deepEqual(await hook(inbox, payload), { code: 0, stdout: '', stderr: '' });
  assert.equal((await inbox.list()).length, 0);
  await writeFile(path, JSON.stringify({ version: 1, stopped: false }), { mode: 0o600 });
  assert.equal((await hook(inbox, payload)).code, 0);
  assert.equal((await inbox.list()).length, 1);
});

test('concurrent hook processes preserve every distinct wake event', async t => {
  const inbox = await fixture(t);
  const results = await Promise.all(Array.from({ length: 24 }, () => hook(inbox, { hook_event_name: 'Stop', session_id: randomUUID() })));
  for (const result of results) assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  assert.equal((await inbox.list()).length, 24);
});

test('hook ignores subagents and unknown hooks; completed native input stores no private content', async t => {
  const inbox = await fixture(t), session_id = randomUUID();
  for (const extra of [{ agent_id: 'child' }, { hook_event_name: 'SubagentStop' }, { hook_event_name: 'Other' }]) {
    assert.equal((await hook(inbox, { hook_event_name: 'Stop', session_id, ...extra })).code, 0);
  }
  assert.deepEqual(await inbox.list(), []);
  const result = await hook(inbox, { hook_event_name: 'Stop', session_id, last_assistant_message: 'secret'.repeat(20000) });
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  assert.equal((await inbox.list())[0].nativeId, session_id);
  assert.doesNotMatch(await readFile(inbox.path, 'utf8'), /secret/);
  assert.equal((await hook(inbox, { hook_event_name: 'UserPromptSubmit', session_id })).code, 0);
  assert.equal((await inbox.list())[0].kind, 'started');
});

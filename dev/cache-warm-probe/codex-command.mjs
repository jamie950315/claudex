// Authorized native local-command acceptance. Never part of automated tests.
import assert from 'node:assert/strict';
import { lstat, realpath, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { CodexWebSocketClient } from '../../src/codex-websocket.mjs';
import { codexChatSocket } from '../../src/native-chat-catalog.mjs';
import { preflightCodexChatWake } from '../../src/codex-chat-wake.mjs';
import { privateRead } from '../../src/claude-mod-storage.mjs';
import { callCollaboration } from '../../src/collaboration-transport.mjs';
import { exportNativeHistory } from '../../src/native-history.mjs';
import { createNativeEmptyTurnResolver } from '../../src/native-empty-turn.mjs';
import { fingerprint } from '../../src/history.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'status-only': { type: 'boolean' },
  root: { type: 'string' }, session: { type: 'string' }, cwd: { type: 'string' } } });
assert(values.run && values.root && values.session && values.cwd, 'Explicit --run, new private --root, exact --session and --cwd required.');
const root = await realpath(values.root), stat = await lstat(root);
assert(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077) && !(await readdir(root)).length);
const client = new CodexWebSocketClient({ socketPath: await codexChatSocket(), timeoutMs: 35000 });
const id = values.session, report = { phase: 'starting', sessionId: id, commands: [], unexpectedModelActivity: false };
const file = join(root, 'report.json'), save = () => writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const rows = new Map(); let current, enrollmentRequested = false;
async function policyStatus() {
  const root = join(process.env.HOME, '.local/share/claudex/collaboration');
  const token = (await privateRead(join(root, 'controller-key'), { maxBytes: 65 })).trim();
  return callCollaboration({ root, peer: 'codex', token, method: 'codex_cache_warm_list', params: { sessionId: id, cwd: values.cwd } });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = turnId => {
  if (!rows.has(turnId)) rows.set(turnId, { turnId, hooks: [], completed: null, usage: null, modelItems: [] });
  return rows.get(turnId);
};
client.on('notification', e => {
  const p = e.params;
  if (p?.threadId !== id) return;
  const turnId = p.turnId ?? p.turn?.id;
  if (!turnId) return;
  const row = record(turnId);
  if (e.method === 'hook/completed' && p.run?.statusMessage === 'Handle explicit Claudex cache commands in this Codex chat')
    row.hooks.push({ status: p.run.status, durationMs: p.run.durationMs, entries: p.run.entries });
  if (e.method === 'turn/completed') row.completed = p.turn.status;
  if (e.method === 'thread/tokenUsage/updated') row.usage = p.tokenUsage;
  if (e.method === 'item/started' && !['userMessage', 'plan'].includes(p.item?.type)) {
    row.modelItems.push(p.item?.type); report.unexpectedModelActivity = true;
  }
});
async function send(text) {
  assert(report.commands.length < 6 && !report.unexpectedModelActivity);
  assert(/^\/claudex:warm (?:status|on|off|confirm [a-f0-9-]{36} accept-best-effort)$/.test(text));
  const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
  assert.equal(thread.cwd, values.cwd); assert.equal(thread.status.type, 'idle');
  const entry = { action: text.split(' ')[1], submitted: false }; report.commands.push(entry); await save();
  // Literal native user input is essential: the app-origin wake envelope is
  // deliberately untrusted tool context and is NOT this command's ingress.
  const response = await client.request('turn/start', { threadId: id, clientUserMessageId: randomUUID(),
    input: [{ type: 'text', text, text_elements: [] }] });
  assert(response.turn?.id, 'No native turn receipt; do not replay.');
  current = response.turn.id; entry.submitted = true; entry.turnId = current; await save();
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const row = record(current);
    if (report.unexpectedModelActivity) throw new Error('Unexpected model activity; stop without another submission.');
    if (row.completed && row.hooks.length) {
      entry.result = structuredClone(row); current = null; await save();
      assert.equal(row.hooks.length, 1, 'Exactly one warm hook must run.');
      assert.equal(row.hooks[0].status, 'blocked', 'Native execution must confirm the blocking decision.');
      assert(!row.usage || row.usage.last?.totalTokens === 0, 'Control command consumed model tokens.');
      assert.equal(row.modelItems.length, 0);
      const text = row.hooks[0].entries.find(e => e.kind === 'warning' && e.text.split('\n').length === 4)?.text;
      assert(text, 'Native hook did not surface its local result.');
      assert(!/"sessionId"|"policy"|confirmationId/.test(text), 'Internal JSON leaked into the summary.');
      entry.displayText = text; await save();
      return policyStatus();
    }
    await delay(50);
  }
  throw new Error('No exact local completion; do not replay.');
}
try {
  report.nativeVersion = (await client.initialize()).userAgent;
  const account = await client.request('account/read', { refreshToken: false });
  assert.equal(account.account?.type, 'chatgpt');
  const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
  assert.equal(thread.cwd, values.cwd); assert.equal(thread.ephemeral, false);
  assert.equal(thread.parentThreadId, null); assert.equal(thread.forkedFromId, null);
  const owner = await preflightCodexChatWake({ sessionId: id });
  assert.equal(owner.status, 'ready'); owner.close();
  const inventory = await client.request('hooks/list', { cwds: [values.cwd] });
  const hooks = inventory.data[0].hooks.filter(h => h.eventName === 'userPromptSubmit'
    && h.command.includes('/Applications/Claudex.app/Contents/Resources/engine/bin/claudex-codex-warm-hook.mjs'));
  assert.equal(hooks.length, 1); assert(hooks[0].enabled && hooks[0].trustStatus === 'trusted');
  report.nativeHookTrusted = true;
  await client.request('thread/resume', { threadId: id, excludeTurns: true });
  const initial = await send('/claudex:warm status');
  assert(initial.policies.every(p => !p.enabled));
  if (!values['status-only']) {
    enrollmentRequested = true;
    const enabled = await send('/claudex:warm on');
    assert.equal(enabled.policies[0].enabled, true);
    assert.equal(enabled.policies[0].sessionId, id); assert.equal(enabled.policies[0].refreshMinutes, 25);
    assert.equal(enabled.policies[0].maxReadTokens, null);
    const status = await send('/claudex:warm status'); assert.equal(status.policies[0].enabled, true);
    const stopped = await send('/claudex:warm off'); assert.equal(stopped.policies[0].enabled, false);
    const final = await send('/claudex:warm status'); assert(final.policies.every(p => !p.enabled));
    enrollmentRequested = false;
  }
  const completed = await client.request('thread/turns/list', { threadId: id,
    limit: report.commands.length, itemsView: 'full', sortDirection: 'desc' });
  const expected = new Set(report.commands.map(entry => entry.turnId));
  assert.equal(completed.data.length, expected.size);
  for (const turn of completed.data) {
    assert(expected.has(turn.id) && turn.status === 'completed');
    assert(turn.items.every(item => item.type === 'userMessage'), 'Unexpected persisted assistant/tool item.');
  }
  report.nativeHistoryAudit = { exactCompletedTurns: expected.size, assistantOrToolItems: 0 };
  // Control delivery alone is insufficient: these turns must remain exportable
  // through synchronization's independently proven empty-lifecycle handling.
  const metadata = (await client.request('thread/read', { threadId: id, includeTurns: false })).thread;
  const exported = await exportNativeHistory({ client, threadId: id, cwd: values.cwd, completedPrefix: true,
    resolveEmptyTurns: createNativeEmptyTurnResolver({ path: metadata.path, threadId: id, cwd: values.cwd }) });
  report.synchronizationAudit = { messages: exported.common.messages.length, digest: fingerprint(exported.common),
    emptyControlTurnCount: exported.emptyControlTurnCount, incompleteTail: exported.incompleteTail };
  assert.equal(exported.incompleteTail, false);
  report.phase = 'native-local-command-verified';
} catch (error) {
  report.phase = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  if (current && !record(current).completed)
    await client.request('turn/interrupt', { threadId: id, turnId: current }).catch(() => {});
  if (enrollmentRequested) {
    const collaboration = join(process.env.HOME, '.local/share/claudex/collaboration');
    const token = (await privateRead(join(collaboration, 'controller-key'), { maxBytes: 65 })).trim();
    report.cleanup = await callCollaboration({ root: collaboration, peer: 'codex', token,
      method: 'codex_cache_warm_off', params: { sessionId: id, cwd: values.cwd } });
  }
  await save(); await client.close();
  console.log(JSON.stringify({ phase: report.phase, error: report.error, commands: report.commands.length,
    unexpectedModelActivity: report.unexpectedModelActivity, report: file }));
}

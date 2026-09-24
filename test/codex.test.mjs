import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient } from '../src/codex.mjs';

test('invalid transport is rejected', () => {
  assert.throws(() => new CodexClient({ mode: 'invalid' }), /transport/);
});

for (const targetState of ['unloaded', 'loaded', 'modified', 'loaded-restart', 'modified-restart']) test(`native importer repeated source behavior (${targetState})`, { skip: process.env.CLAUDEX_NATIVE_TEST !== '1' }, async t => {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'claudex-import-test-'));
  const codexHome = join(isolatedRoot, '.codex');
  const cwd = join(isolatedRoot, 'project');
  const sourceDir = join(isolatedRoot, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(codexHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  const sessionId = randomUUID();
  const sourcePath = join(sourceDir, `${sessionId}.jsonl`);
  let parentUuid = null;
  function row(role, text) {
    const uuid = randomUUID();
    const value = { type: role, uuid, parentUuid, sessionId, cwd, isSidechain: false, userType: 'external', version: '2.1.210', timestamp: new Date().toISOString(),
      message: role === 'user' ? { role, content: text } : { id: `msg_${uuid}`, type: 'message', role, model: 'claudex-test', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
    parentUuid = uuid;
    return `${JSON.stringify(value)}\n`;
  }
  await writeFile(sourcePath, row('user', 'import first user') + row('assistant', 'import first assistant'));
  const options = { binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd, env: { HOME: isolatedRoot } };
  let client = new CodexClient(options);
  t.after(() => client.close());
  await client.initialize();
  async function importSource() {
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.off('notification', listener); reject(new Error('Import completion timeout')); }, 10000);
      const listener = message => {
        if (message.method === 'externalAgentConfig/import/completed') { clearTimeout(timer); client.off('notification', listener); resolve(message.params); }
      };
      client.on('notification', listener);
    });
    await client.request('externalAgentConfig/import', { migrationSource: 'claude', migrationItems: [{ itemType: 'SESSIONS', cwd, description: 'Isolated import test', details: { sessions: [{ cwd, path: sourcePath, title: 'Claudex isolated import' }] } }] });
    return completed;
  }
  t.diagnostic(`Isolated importer evidence: ${isolatedRoot}`);
  t.diagnostic(`First import: ${JSON.stringify(await importSource())}`);
  const first = await client.request('thread/list', { limit: 100 });
  t.diagnostic(`First IDs: ${JSON.stringify(first.data?.map(thread => thread.id))}`);
  for (const thread of first.data ?? []) t.diagnostic(`First turns: ${JSON.stringify((await client.readThread(thread.id)).thread.turns)}`);
  assert.equal(first.data.length, 1);
  const targetId = first.data[0].id;
  assert.equal((await client.readThread(targetId)).thread.turns.length, 1);
  if (targetState !== 'unloaded') await client.resumeThread(targetId);
  if (targetState.startsWith('modified')) await client.injectItems(targetId, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex-native-preservation-marker' }] }]);
  if (targetState.endsWith('restart')) { await client.close(); client = new CodexClient(options); await client.initialize(); }
  await appendFile(sourcePath, row('user', 'import second user') + row('assistant', 'import second assistant'));
  t.diagnostic(`Second import: ${JSON.stringify(await importSource())}`);
  const second = await client.request('thread/list', { limit: 100 });
  t.diagnostic(`Second IDs: ${JSON.stringify(second.data?.map(thread => thread.id))}`);
  for (const thread of second.data ?? []) t.diagnostic(`Second turns: ${JSON.stringify((await client.readThread(thread.id)).thread.turns)}`);
  assert.deepEqual(second.data.map(thread => thread.id), [targetId]);
  const after = await client.readThread(targetId);
  t.diagnostic(`Loaded target visible turns after reimport: ${after.thread.turns.length}`);
  const sessions = await readdir(join(codexHome, 'sessions'), { recursive: true });
  const rollout = sessions.find(file => file.endsWith('.jsonl'));
  const raw = await readFile(join(codexHome, 'sessions', rollout), 'utf8');
  t.diagnostic(`Native injected marker preserved after reimport: ${raw.includes('codex-native-preservation-marker')}`);
  await client.close();
  const reader = new CodexClient({ binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd, env: { HOME: isolatedRoot } });
  t.after(() => reader.close());
  await reader.initialize();
  const restarted = await reader.readThread(targetId);
  t.diagnostic(`Restarted target turns: ${JSON.stringify(restarted.thread.turns)}`);
  assert.equal(restarted.thread.turns.length, targetState === 'unloaded' || targetState === 'loaded-restart' ? 2 : 1);
  if (targetState.startsWith('modified')) assert.ok(raw.includes('codex-native-preservation-marker'));
});

test('uninitialized requests fail closed', async () => {
  await assert.rejects(new CodexClient().readThread('missing'), /not running/);
});

for (const historyMode of ['legacy', 'paginated']) test(`native isolated ${historyMode} injection persists without creating visible turns`, {
  skip: process.env.CLAUDEX_NATIVE_TEST !== '1',
}, async t => {
  const codexHome = await mkdtemp(join(tmpdir(), 'claudex-native-test-'));
  t.diagnostic(`Isolated evidence directory: ${codexHome}`);
  const options = { binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd: codexHome };
  let client = new CodexClient(options);
  t.after(() => client.close());
  await client.initialize();
  const { thread } = await client.createThread({ cwd: codexHome, historyMode });
  await client.injectItems(thread.id, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Claudex isolated user marker' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Claudex isolated assistant marker' }] },
  ]);
  const live = await client.readThread(thread.id);
  t.diagnostic(`Live visible turns: ${JSON.stringify(live.thread.turns)}`);
  await client.close();
  client = new CodexClient(options);
  await client.initialize();
  await client.resumeThread(thread.id);
  const restored = await client.readThread(thread.id);
  t.diagnostic(`Restored visible turns: ${JSON.stringify(restored.thread.turns)}`);
  const files = await readdir(join(codexHome, 'sessions'), { recursive: true });
  const rollout = files.find(file => file.endsWith('.jsonl'));
  assert.ok(rollout, 'a native rollout was persisted');
  const text = await readFile(join(codexHome, 'sessions', rollout), 'utf8');
  assert.ok(text.includes('Claudex isolated user marker'));
  assert.ok(text.includes('Claudex isolated assistant marker'));
  assert.deepEqual(live.thread.turns, []);
  assert.deepEqual(restored.thread.turns, []);
});

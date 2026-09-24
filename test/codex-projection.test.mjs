import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toCommon } from 'txcript';
import { CodexClient } from '../src/codex.mjs';
import { encodeCodexProjection, createCodexProjection } from '../src/codex-projection.mjs';

const common = cwd => ({ meta: { cwd, id: 'synthetic', timestamp: '2026-09-24T00:00:00Z' }, messages: [1, 2].flatMap(n => [
  { role: 'user', content: [{ type: 'text', text: `Synthetic question ${n}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Synthetic answer ${n}` }] },
]) });

const toolCommon = cwd => ({ meta: { cwd, timestamp: '2026-09-24T00:00:00Z' }, messages: [
  { role: 'user', content: [{ type: 'text', text: 'Show synthetic command output' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call1', tool: { name: 'Bash', command: 'echo ok' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'ok' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'The output is ok.' }] },
] });

test('tool calls and results roundtrip without creating extra turns', () => {
  const encoded = encodeCodexProjection(toolCommon('/tmp'), randomUUID());
  const rows = encoded.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.payload.type === 'task_started').length, 1);
  const decoded = JSON.parse(toCommon(encoded, 'codex'));
  assert.deepEqual(decoded.messages.map(message => [message.role, message.content]), toolCommon('/tmp').messages.map(message => [message.role, message.content]));
});

test('native writer ownership across separate app-server processes', { skip: process.env.CLAUDEX_NATIVE_TEST !== '1' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-writer-test-'));
  const codexHome = join(root, 'codex'); const cwd = join(root, 'project');
  await mkdir(cwd); await mkdir(codexHome);
  const options = { binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd, env: { HOME: root } };
  const first = new CodexClient(options); const second = new CodexClient(options);
  t.after(async () => { await second.close(); await first.close(); });
  await first.initialize();
  const projection = await createCodexProjection({ client: first, codexHome, common: toolCommon(cwd), id: randomUUID(), title: 'Synthetic tool handoff' });
  const original = (await first.readThread(projection.id)).thread;
  assert.equal(original.turns.length, 1);
  assert.match(JSON.stringify(original.turns), /The output is ok/);
  const raw = await readFile(projection.path, 'utf8');
  const decoded = JSON.parse(toCommon(raw.trim().split('\n').map(JSON.parse).filter(row => row.type === 'session_meta' || (row.type === 'response_item' && row.payload.role !== 'developer' && row.payload.role !== 'system')).map(row => JSON.stringify(row)).join('\n'), 'codex'));
  assert.deepEqual(decoded.messages.map(message => [message.role, message.content]), toolCommon(cwd).messages.map(message => [message.role, message.content]));
  await second.initialize();
  assert.equal((await second.readThread(projection.id)).thread.turns.length, 1);
  await assert.rejects(second.resumeThread(projection.id), /active writer/);
  for (const method of ['thread/archive', 'thread/delete']) {
    await assert.rejects(second.request(method, { threadId: projection.id }), /active writer/);
  }
  await first.close();
  assert.equal((await second.resumeThread(projection.id)).thread.turns.length, 1);
  t.diagnostic(`Writer evidence: ${root}`);
});

test('projection has independent identity and complete turn boundaries', () => {
  const id = randomUUID();
  const rows = encodeCodexProjection(common('/tmp'), id).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].payload.id, id);
  assert.equal(rows.filter(row => row.payload.type === 'task_started').length, 2);
  assert.equal(rows.filter(row => row.payload.type === 'task_complete').length, 2);
  assert.equal(rows.filter(row => row.type === 'turn_context').length, 0);
  assert.throws(() => encodeCodexProjection(common('/tmp'), '../bad'), /identifier/);
  const partial = common('/tmp'); partial.messages.pop();
  assert.throws(() => encodeCodexProjection(partial, id), /complete/);
});

test('native projection is listed, restart-resumable and independent of deleted predecessor', { skip: process.env.CLAUDEX_NATIVE_TEST !== '1' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-projection-test-'));
  const codexHome = join(root, 'codex');
  const cwd = join(root, 'project');
  await mkdir(cwd); await mkdir(codexHome);
  const options = { binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd, env: { HOME: root } };
  let client = new CodexClient(options);
  t.after(() => client.close());
  await client.initialize();
  const first = await createCodexProjection({ client, codexHome, common: common(cwd), id: randomUUID(), title: 'Synthetic first' });
  const second = await createCodexProjection({ client, codexHome, common: common(cwd), id: randomUUID(), title: 'Synthetic latest' });
  assert.equal((await client.readThread(second.id)).thread.turns.length, 2);
  const listed = await client.request('thread/list', { limit: 100 });
  assert.ok(listed.data.some(thread => thread.id === second.id));
  const original = await readFile(second.path, 'utf8');
  await assert.rejects(createCodexProjection({ client, codexHome, common: common(cwd), id: second.id }), { code: 'EEXIST' });
  assert.equal(await readFile(second.path, 'utf8'), original);
  await client.request('thread/archive', { threadId: first.id });
  await client.request('thread/delete', { threadId: first.id });
  await client.close(); client = new CodexClient(options); await client.initialize();
  await client.resumeThread(second.id);
  const latest = (await client.readThread(second.id)).thread;
  assert.equal(latest.turns.length, 2);
  assert.match(JSON.stringify(latest.turns), /Synthetic answer 2/);
  const restoredRows = (await readFile(second.path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!restoredRows[0].payload.forked_from_id);
  const restored = JSON.parse(toCommon(restoredRows.filter(row => row.type === 'session_meta' || (row.type === 'response_item' && ['user', 'assistant'].includes(row.payload.role))).map(row => JSON.stringify(row)).join('\n'), 'codex'));
  assert.deepEqual(restored.messages.map(message => [message.role, message.content]), common(cwd).messages.map(message => [message.role, message.content]));
  const files = await readdir(codexHome, { recursive: true });
  assert.ok(!files.some(path => path.includes('external_agent')));
  const counts = await promisify(execFile)('sqlite3', ['-readonly', join(codexHome, 'state_5.sqlite'), 'select count(*) from external_agent_config_imports; select count(*) from threads;']);
  assert.equal(counts.stdout.trim(), '0\n1');
  const index = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8');
  assert.equal(index.trim().split('\n').length, 1);
  assert.ok(index.includes(second.id));
  assert.ok(!index.includes(first.id));
  t.diagnostic(`Native projection evidence: ${root}`);
});

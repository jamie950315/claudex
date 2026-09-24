import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, appendFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Bridge } from '../src/bridge.mjs';
import { nativeDrivers } from '../src/native-drivers.mjs';
import { createClaudeSession, appendClaudeSession } from '../src/claude.mjs';
import { encodeCodexProjection } from '../src/codex-projection.mjs';
import { snapshot, publishExclusive } from '../src/storage.mjs';
import { CodexClient } from '../src/codex.mjs';

test('native six alternating turns retire old projections and do not accumulate import metadata', { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 120000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-roundtrip-test-')));
  const cwd = join(root, 'project');
  const codexHome = join(root, 'codex');
  const claudeHome = join(root, 'claude');
  const stateRoot = join(root, 'bridge');
  await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path, { recursive: true })));
  const options = { root: stateRoot, codexHome, claudeHome, binary: process.env.CLAUDEX_CODEX_BINARY || 'codex' };
  const common = number => ({ meta: { id: '', cwd, timestamp: new Date().toISOString() }, messages: [
    { role: 'user', content: [{ type: 'text', text: `Native question ${number}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `Native answer ${number}` }] },
  ] });
  const original = await createClaudeSession({ claudeHome, common: common(0), title: 'Original fixture' });
  const originalBytes = await readFile(original.path, 'utf8');
  let conversationId;
  for (let round = 0; round < 6; round++) {
    const side = round % 2 ? 'codex' : 'claude';
    const native = await nativeDrivers(options);
    try {
      const bridge = new Bridge({ root: stateRoot, drivers: native.drivers });
      if (!conversationId) ({ conversationId } = await bridge.track({ side, path: original.path, title: 'Native bridge roundtrip' }));
      if (round) {
        const record = bridge.current(await bridge.status(), conversationId, side);
        if (side === 'claude') await appendClaudeSession({ path: record.path, id: record.nativeId, common: common(round), expectedHash: (await snapshot(record.path)).hash });
        else {
          const turnId = randomUUID();
          const rows = encodeCodexProjection(common(round), record.nativeId).trim().split('\n').map(JSON.parse).filter(row => row.type !== 'session_meta');
          for (const row of rows) if (row.payload?.turn_id) row.payload.turn_id = turnId;
          await appendFile(record.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        }
      }
      const result = await bridge.sync(conversationId, side);
      assert.equal(result.changed, true);
      const state = await bridge.status();
      assert.equal(state.pending, null);
      assert.ok(state.records.filter(record => record.managed).length <= 4);
      const current = bridge.current(state, conversationId, result.side);
      const parsed = await native.drivers[result.side].inspect(current);
      assert.equal(parsed.common.messages.length, (round + 1) * 2);
    } finally { await native.close(); }
  }
  assert.equal(await readFile(original.path, 'utf8'), originalBytes);
  const client = new CodexClient({ binary: options.binary, codexHome });
  try {
    await client.initialize();
    const active = await client.request('thread/list', { limit: 100 });
    const archived = await client.request('thread/list', { limit: 100, archived: true });
    assert.equal(active.data.length, 1);
    assert.equal(archived.data.length, 1);
    const current = await client.readThread(active.data[0].id);
    assert.equal(current.thread.turns.length, 6);
  } finally { await client.close(); }
  const files = await readdir(claudeHome, { recursive: true });
  assert.equal(files.filter(file => file.endsWith('.jsonl')).length, 2, 'original + one current Claude projection');
  assert.equal((await readdir(join(stateRoot, 'rollback'))).length, 1);
  const imports = execFileSync('sqlite3', ['-readonly', join(codexHome, 'state_5.sqlite'), 'SELECT COUNT(*) FROM external_agent_config_imports;'], { encoding: 'utf8' }).trim();
  assert.equal(imports, '0');
  assert.ok(!(await readdir(codexHome)).includes('external_agent_session_imports.json'));
  t.diagnostic(`Native integration evidence: ${root}`);
});

test('native recovery registers a fully published candidate after a pre-registration crash', { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 30000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-registration-test-')));
  const cwd = join(root, 'project'); const codexHome = join(root, 'codex'); const claudeHome = join(root, 'claude'); const stateRoot = join(root, 'state');
  await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path)));
  const common = { meta: { id: '', cwd, timestamp: new Date().toISOString() }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Registration crash fixture' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Ready' }] },
  ] };
  const source = await createClaudeSession({ claudeHome, common });
  const native = await nativeDrivers({ root: stateRoot, codexHome, claudeHome, binary: process.env.CLAUDEX_CODEX_BINARY || 'codex' });
  try {
    const bridge = new Bridge({ root: stateRoot, drivers: native.drivers });
    const { conversationId } = await bridge.track({ side: 'claude', path: source.path });
    const original = native.drivers.codex.materialize;
    native.drivers.codex.materialize = async (record, history) => {
      await publishExclusive(record.path, encodeCodexProjection(history, record.nativeId));
      throw new Error('Synthetic crash before registration');
    };
    await assert.rejects(bridge.sync(conversationId, 'claude'), /before registration/);
    const id = (await bridge.status()).pending.record.nativeId;
    native.drivers.codex.materialize = original;
    assert.equal((await bridge.recover()).nativeId, id);
    const state = await bridge.status();
    assert.equal(state.pending, null);
    assert.equal(state.records.filter(record => record.managed).length, 1);
    t.diagnostic(`Registration recovery evidence: ${root}`);
  } finally { await native.close(); }
});

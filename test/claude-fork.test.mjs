import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { createClaudeSession, encodeClaude } from '../src/claude.mjs';
import { fingerprint } from '../src/history.mjs';

const pair = label => [{ role: 'user', content: [{ type: 'text', text: `Question ${label}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${label}` }] }];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

// Mirrors the observed Claude Desktop fork file: the parent's rows copied
// byte-for-byte under the parent's session ID, an identity-free trailing
// bridge row, then new rows under the fork's own file identity.
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-fork-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path, { mode: 0o700 })));
  const parentId = randomUUID(), forkId = randomUUID(), meta = { id: parentId, cwd, timestamp: '2026-09-29T00:00:00Z' };
  const parent = await createClaudeSession({ claudeHome, id: parentId, common: { meta, messages: [...pair('one'), ...pair('two')] } });
  const parentText = await readFile(parent.path, 'utf8');
  const parentRows = parentText.trim().split('\n').map(JSON.parse);
  const anchor = parentRows.filter(row => row.type === 'assistant').at(-1).uuid;
  const copied = parentText + JSON.stringify({ type: 'bridge-session', sessionId: parentId }) + '\n';
  const own = encodeClaude({ meta: { ...meta, id: forkId }, messages: pair('fork') }, forkId, anchor).rows;
  const forkPath = join(claudeHome, 'projects', parent.path.split('/').at(-2), `${forkId}.jsonl`);
  const write = async (text = copied + jsonl(own)) => { await writeFile(forkPath, text, { mode: 0o600 }); return text; };
  const runtime = await new DesktopRuntime({ root: join(root, 'state'), codexHome, claudeHome,
    ownerFactory() { throw new Error('Fork inspection must not start a Claude owner.'); },
    clientFactory() { throw new Error('Fork inspection must not start a Codex client.'); },
  }).initialize();
  t.after(() => runtime.close());
  const record = (nativeId = forkId) => ({ side: 'claude', path: forkPath, cwd, managed: false, kind: 'original',
    ...(nativeId ? { nativeId } : {}) });
  return { runtime, record, write, parent, parentId, forkId, parentText, copied, own, meta, cwd };
}

test('a Desktop fork enrolls under its own file identity after its copied prefix matches the parent', async t => {
  const f = await fixture(t);
  const text = await f.write();
  for (const nativeId of [f.forkId, undefined]) {
    const data = await f.runtime.inspect(f.record(nativeId));
    assert.equal(data.nativeId, f.forkId);
    assert.equal(data.forkedFrom, f.parentId);
    assert.equal(data.common.messages.length, 6);
    const parent = await f.runtime.inspect({ ...f.record(f.parentId), path: f.parent.path });
    assert.equal(fingerprint(data.common, 4), fingerprint(parent.common));
    assert.equal(data.common.messages.at(-1).content[0].text, 'Answer fork');
  }
  assert.equal(await readFile(f.parent.path, 'utf8'), f.parentText);
  assert.equal(await readFile(f.record().path, 'utf8'), text);
});

test('the parent may keep growing after the fork without invalidating its copied prefix', async t => {
  const f = await fixture(t);
  await f.write();
  const later = encodeClaude({ meta: f.meta, messages: pair('parent later') }, f.parentId,
    f.parentText.trim().split('\n').map(JSON.parse).filter(row => row.uuid).at(-1).uuid).rows;
  await writeFile(f.parent.path, f.parentText + jsonl(later));
  assert.equal((await f.runtime.inspect(f.record())).nativeId, f.forkId);
});

test('a fork without its own completed reply waits instead of duplicating the parent', async t => {
  const f = await fixture(t);
  await f.write(f.copied + jsonl(f.own.filter(row => row.type !== 'assistant')));
  await assert.rejects(f.runtime.inspect(f.record(undefined)), /^Error: Wait for a complete assistant turn\.$/);
});

test('unproven fork prefixes remain unsupported sources', async t => {
  const mutations = {
    'missing parent': async f => { await rm(f.parent.path); },
    'edited copied row': async f => { await f.write(f.copied.replace('Answer one', 'Answer 1') + jsonl(f.own)); },
    'extra copied authored row': async f => {
      const extra = encodeClaude({ meta: f.meta, messages: pair('not in parent') }, f.parentId).rows;
      await f.write(f.copied + jsonl(extra) + jsonl(f.own));
    },
    'third session': async f => { await f.write(f.copied + jsonl([{ type: 'bridge-session', sessionId: randomUUID() }]) + jsonl(f.own)); },
    'parent rows after own rows': async f => { await f.write(f.copied + jsonl(f.own) + jsonl([{ type: 'bridge-session', sessionId: f.parentId }])); },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = await fixture(t);
    await f.write();
    await mutate(f);
    await assert.rejects(f.runtime.inspect(f.record()), /Forked Claude history belongs to another native session/, name);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { decodeClaude, encodeClaude, sessionPath } from '../src/claude.mjs';
import { fingerprint, portableMessages } from '../src/history.mjs';

const turn = label => [
  { role: 'user', content: [{ type: 'text', text: `Question ${label}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${label}` }] },
];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-runtime-relocation-')));
  const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude'), desktopHome = join(root, 'desktop');
  const originCwd = join(root, 'scratch'), cwd = join(root, 'project');
  for (const path of [codexHome, claudeHome, desktopHome, originCwd, cwd]) await mkdir(path);
  const nativeId = randomUUID(), conversationId = randomUUID(), uiId = `local_${randomUUID()}`;
  const runtime = await new DesktopRuntime({ root: join(root, 'state'), codexHome, claudeHome, desktopHome,
    ownerFactory() { throw new Error('Relocation must not activate a native writer.'); },
    clientFactory() { throw new Error('Relocation must not activate a Codex backend.'); },
  }).initialize();
  const rows = encodeClaude({ meta: { id: nativeId, cwd: originCwd, timestamp: '2026-09-28T00:00:00.000Z' },
    messages: [...turn('original'), ...turn('relocated')] }, nativeId).rows;
  for (const row of rows.slice(2)) row.cwd = cwd;
  const oldText = rows.slice(0, 2).map(JSON.stringify).join('\n') + '\n';
  const common = decodeClaude(oldText);
  const record = { id: randomUUID(), conversationId, side: 'claude', kind: 'original', managed: false,
    verified: true, nativeId, cwd: originCwd, path: sessionPath(claudeHome, originCwd, nativeId),
    checkpoint: { count: common.messages.length, digest: fingerprint({ ...common, messages: portableMessages(common.messages) }) } };
  let path = sessionPath(claudeHome, cwd, nativeId);
  const mapping = { sessionId: uiId, cliSessionId: nativeId, cwd, title: 'Moved project', isArchived: false, lastActivityAt: 1000 };
  const registryPath = join(desktopHome, `${uiId}.json`);
  await mkdir(dirname(path), { recursive: true });
  const saveRows = () => writeFile(path, rows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  const saveMapping = () => writeFile(registryPath, JSON.stringify(mapping), { mode: 0o600 });
  await saveRows(); await saveMapping();
  return { root, runtime, claudeHome, record, rows, mapping, registryPath, saveRows, saveMapping, path: () => path,
    async move(nextCwd) {
      await mkdir(nextCwd); const next = sessionPath(claudeHome, nextCwd, nativeId);
      await mkdir(dirname(next), { recursive: true }); await rename(path, next); path = next;
      const batch = encodeClaude({ meta: { id: nativeId, cwd: nextCwd, timestamp: '2026-09-28T00:01:00.000Z' },
        messages: turn('moved again') }, nativeId, rows.at(-1).uuid).rows;
      rows.push(...batch); mapping.cwd = nextCwd; await saveRows(); await saveMapping();
    },
  };
}

test('runtime proves the saved portable prefix and returns a relocation without mutating the original record', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.record), native = await readFile(f.path()), registry = await readFile(f.registryPath);
    const proof = await f.runtime.adapters.claude.reconcileRelocation(f.record);
    assert.equal(proof.record.cwd, f.mapping.cwd); assert.equal(proof.path, f.path());
    assert.equal(proof.common.meta.cwd, f.mapping.cwd); assert.equal(proof.nativeId, f.record.nativeId);
    assert.equal(proof.common.messages.length, 4); assert.equal(proof.incompleteTail, false);
    assert.equal(fingerprint({ messages: portableMessages(proof.common.messages) }, 2), f.record.checkpoint.digest);
    assert.deepEqual(proof.record.relocation, { version: 1, originPath: f.record.path,
      originCwd: f.record.cwd, historicalCwds: [f.record.cwd] });
    assert.match(proof.relocationProof.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.record, before); assert.deepEqual(await readFile(f.path()), native);
    assert.deepEqual(await readFile(f.registryPath), registry); assert.equal(f.runtime.owners.size, 0);
  } finally { await f.runtime.close(); }
});

test('later inspection retains historical native cwd while reporting the verified current cwd', async () => {
  const f = await fixture();
  try {
    const proof = await f.runtime.reconcileClaudeRelocation(f.record), before = await readFile(f.path());
    const inspected = await f.runtime.inspect(proof.record);
    assert.equal(inspected.common.meta.cwd, f.mapping.cwd); assert.equal(inspected.digest, proof.digest);
    assert.equal(inspected.path, f.path()); assert.equal(await f.runtime.reconcileClaudeRelocation(proof.record), null);
    assert.deepEqual(await readFile(f.path()), before);
    assert.equal(JSON.parse(before.toString().split('\n')[0]).cwd, f.record.cwd);
    assert.equal(f.runtime.owners.size, 0);
  } finally { await f.runtime.close(); }
});

test('changed and truncated checkpoint prefixes block adoption rather than weakening the saved proof', async () => {
  for (const change of ['edited', 'truncated']) {
    const f = await fixture();
    try {
      if (change === 'edited') f.rows[0].message.content[0].text += ' changed';
      else f.record.checkpoint.count = 20;
      await f.saveRows();
      await assert.rejects(f.runtime.reconcileClaudeRelocation(f.record), error => {
        assert.equal(error.code, 'CLAUDEX_CLAUDE_RELOCATION_BLOCKED');
        return /does not preserve the synchronized prefix/.test(error.message);
      });
    } finally { await f.runtime.close(); }
  }
});

test('another move requires reconciliation and retains bounded historical project evidence', async () => {
  const f = await fixture();
  try {
    const first = await f.runtime.reconcileClaudeRelocation(f.record), middleCwd = first.record.cwd;
    await f.move(join(f.root, 'second-project'));
    await assert.rejects(f.runtime.inspect(first.record), /project moved again/);
    const second = await f.runtime.reconcileClaudeRelocation(first.record);
    assert.equal(second.common.messages.length, 6); assert.equal(second.record.cwd, f.mapping.cwd);
    assert.equal(second.record.relocation.originPath, f.record.path);
    assert.deepEqual(second.record.relocation.historicalCwds, [f.record.cwd, middleCwd]);
    assert.equal((await f.runtime.inspect(second.record)).common.meta.cwd, f.mapping.cwd);
    const excessive = { ...second.record, cwd: join(f.root, 'new-unrecorded-root'), relocation: {
      ...second.record.relocation, historicalCwds: Array.from({ length: 16 }, (_, i) => join(f.root, `project-${i}`)) } };
    await assert.rejects(f.runtime.reconcileClaudeRelocation(excessive), /project history limit/);
  } finally { await f.runtime.close(); }
});

test('imported originals and unverified records cannot enter native relocation', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runtime.reconcileClaudeRelocation({ ...f.record, importPacket: true }), /without an imported bootstrap/);
    assert.equal(await f.runtime.reconcileClaudeRelocation({ ...f.record, verified: false }), null);
    assert.equal(await f.runtime.reconcileClaudeRelocation({ ...f.record, managed: true }), null);
    assert.equal(f.runtime.owners.size, 0);
  } finally { await f.runtime.close(); }
});

test('a repeated move cannot adopt another transcript while the saved current path survives', async () => {
  const f = await fixture();
  try {
    const first = await f.runtime.reconcileClaudeRelocation(f.record);
    const previous = await readFile(first.path);
    await f.move(join(f.root, 'second-project'));
    await writeFile(first.path, previous);
    await assert.rejects(f.runtime.reconcileClaudeRelocation(first.record), /saved current transcript still exists/);
  } finally { await f.runtime.close(); }
});

test('an incomplete authored tail remains withheld after relocation', async () => {
  const f = await fixture();
  try {
    f.rows.pop(); await f.saveRows();
    const proof = await f.runtime.reconcileClaudeRelocation(f.record);
    assert.equal(proof.incompleteTail, true); assert.equal(proof.common.messages.length, 2);
    assert.equal(proof.record.cwd, f.mapping.cwd);
  } finally { await f.runtime.close(); }
});

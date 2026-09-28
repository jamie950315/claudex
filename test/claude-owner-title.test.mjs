import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeOwner } from '../src/claude-owner.mjs';

function fixture(actual = '[Claudex] Ping') {
  const calls = [], sessionId = '00000000-0000-4000-8000-000000000098';
  const owner = Object.assign(Object.create(ClaudeOwner.prototype), {
    state: { sessionId, displayTitle: '[Claudex] Ping' }, nativeState: 'idle', backgroundTasks: [],
    async inspectTranscript() { return { rows: actual === undefined ? [] : [{ type: 'custom-title', sessionId, customTitle: actual }] }; },
    async save() { calls.push({ save: structuredClone(this.state) }); },
    query: { async renameSession(title, id) { calls.push({ title, id }); actual = title; } },
  });
  return { owner, calls, sessionId, renameCount: () => calls.filter(c => c.title).length };
}

test('the exact former display prefix is removed by the identity-bound live native writer', async () => {
  const f = fixture();
  assert.equal(await f.owner.reconcileDisplayTitle('Ping'), true);
  assert.deepEqual(f.calls.find(c => c.title), { title: 'Ping', id: f.sessionId });
  assert.equal(f.owner.state.displayTitle, 'Ping');
  assert.equal(f.owner.state.displayTitleMigration, undefined);
  assert.equal(await f.owner.reconcileDisplayTitle('Ping'), false);
  assert.equal(f.renameCount(), 1);
});

test('a native manual title is preserved without reapplying a saved creation title', async () => {
  const f = fixture('My custom title');
  assert.equal(await f.owner.reconcileDisplayTitle('Ping'), false);
  assert.equal(f.owner.state.displayTitle, 'My custom title');
  assert.equal(f.renameCount(), 0);
});

test('a legacy registered owner without saved displayTitle removes only the exact native prefix', async () => {
  const f = fixture(); delete f.owner.state.displayTitle; f.owner.state.remoteId = 'cse_legacy';
  assert.equal(await f.owner.reconcileDisplayTitle('Ping'), true);
  assert.equal(f.owner.state.displayTitle, 'Ping'); assert.equal(f.renameCount(), 1);
});

test('native title recovery accepts durable completion but never resends an uncertain request', async () => {
  const f = fixture('Ping');
  f.owner.state.displayTitleMigration = { sessionId: f.sessionId, from: '[Claudex] Ping', to: 'Ping', phase: 'sent' };
  assert.equal(await f.owner.reconcileDisplayTitle('Ping'), true);
  assert.equal(f.renameCount(), 0);
  const uncertain = fixture();
  uncertain.owner.state.displayTitleMigration = { sessionId: uncertain.sessionId, from: '[Claudex] Ping', to: 'Ping', phase: 'sent' };
  await assert.rejects(uncertain.owner.reconcileDisplayTitle('Ping'), /uncertain/);
  assert.equal(uncertain.renameCount(), 0);
});

test('busy owners and pending history operations defer title changes', async () => {
  for (const field of ['pending', 'reset']) {
    const f = fixture(); f.owner.state[field] = {};
    assert.equal(await f.owner.reconcileDisplayTitle('Ping'), false);
    assert.equal(f.renameCount(), 0);
  }
  const f = fixture(); f.owner.nativeState = 'running';
  assert.equal(await f.owner.reconcileDisplayTitle('Ping'), false);
  assert.equal(f.renameCount(), 0);
});

test('unsupported native rename and wrong session migration fail without a standalone write', async () => {
  const f = fixture(); f.owner.query = {};
  await assert.rejects(f.owner.reconcileDisplayTitle('Ping'), /identity-bound/);
  f.owner.state.displayTitleMigration = { sessionId: 'another-session', from: '[Claudex] Ping', to: 'Ping', phase: 'sent' };
  await assert.rejects(f.owner.reconcileDisplayTitle('Ping'), /identity changed/);
});

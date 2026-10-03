import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeWorkEvents, appendWorkEvent, queryWorkEvents, validateWorkEvents, projectNativeWorkEvents, WORK_EVENT_LIMITS } from '../src/collaboration-events.mjs';

const task = (publicContent = true) => { const value = { id: 'task-a', generation: 1, revision: 8, seenChildren: {} };
  initializeWorkEvents(value, { timeline: publicContent ? 'public' : 'off' }); return value; };
const message = (nativeId, text = 'Working') => ({ generation: 1, kind: 'assistant-message', source: 'native:codex', nativeId, text, at: 100 });

test('work events are opt-in and queries preserve revisions and child acknowledgements', () => {
  const value = task(false);
  assert.equal(appendWorkEvent(value, message('a')), false);
  assert.equal(appendWorkEvent(value, { generation: 1, kind: 'report', source: 'worker-self-reported', summary: 'Started', phase: 'started' }), true);
  const before = structuredClone(value);
  assert.equal(queryWorkEvents(value, { generation: 1 }).events.length, 1);
  assert.deepEqual(value, before);
  assert.equal(queryWorkEvents({ id: 'legacy', generation: 1 }, { generation: 1 }).collection.status, 'not-collected');
  validateWorkEvents(value);
});

test('stable ids deduplicate across restart; cursors bind task and generation', () => {
  let value = task();
  for (let i = 0; i < 5; i++) appendWorkEvent(value, message(`item-${i}`));
  value = JSON.parse(JSON.stringify(value)); validateWorkEvents(value);
  assert.equal(appendWorkEvent(value, message('item-1', 'Repeated changed content')), false);
  const first = queryWorkEvents(value, { generation: 1, limit: 2 });
  assert.deepEqual(first.events.map(e => e.sequence), [1, 2]); assert.equal(first.hasMore, true);
  const second = queryWorkEvents(value, { generation: 1, limit: 2, cursor: first.cursor });
  assert.deepEqual(second.events.map(e => e.sequence), [3, 4]);
  assert.deepEqual(queryWorkEvents(value, { generation: 1, recent: true, limit: 2 }).events.map(e => e.sequence), [4, 5]);
  assert.throws(() => queryWorkEvents({ ...value, id: 'other' }, { generation: 1, cursor: first.cursor }), /another task/);
  assert.throws(() => queryWorkEvents({ ...value, generation: 2 }, { generation: 2, cursor: first.cursor }), /another task/);
  assert.equal(appendWorkEvent(value, { ...message('late'), generation: 0 }), false);
});

test('capacity advertises gaps, oversize omission and paused collection without deleting source state', () => {
  const value = task();
  const first = queryWorkEvents(value, { generation: 1 }).cursor;
  appendWorkEvent(value, message('oversize', 'x'.repeat(WORK_EVENT_LIMITS.textBytes + 1)));
  assert.equal(value.workEvents.events[0].omitted.reason, 'field-size-limit');
  assert.equal(value.workEvents.events[0].text, undefined);
  for (let i = 1; i < WORK_EVENT_LIMITS.seen + 2; i++) appendWorkEvent(value, message(`item-${i}`));
  validateWorkEvents(value);
  const page = queryWorkEvents(value, { generation: 1, cursor: first });
  assert.equal(page.collection.status, 'paused-capacity');
  assert.equal(page.gap.affectsCursor, true);
  assert.equal(value.workEvents.events.length, WORK_EVENT_LIMITS.events);
  assert.equal(value.revision, 8);
});

test('native projections expose messages and tool metadata, never reasoning, payload or output', () => {
  assert.deepEqual(projectNativeWorkEvents('codex', { type: 'item.completed', item: { type: 'reasoning', id: 'secret', text: 'hidden' } }), []);
  assert.deepEqual(projectNativeWorkEvents('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'missing native identity' } }), []);
  const codex = projectNativeWorkEvents('codex', { type: 'item.completed', prompt: 'secret', item: {
    type: 'command_execution', id: 'tool-1', command: 'secret', aggregated_output: 'secret', exit_code: 0, status: 'completed' } });
  assert.equal(codex[0].exitCode, 0); assert.equal(codex[0].granularity, 'item');
  assert.ok(!JSON.stringify(codex).includes('secret'));
  const claude = projectNativeWorkEvents('claude', { type: 'assistant', uuid: 'msg-1', message: { content: [
    { type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Progress' },
    { type: 'tool_use', id: 'tool-2', name: 'Read', input: { path: 'secret' } },
  ] } });
  assert.equal(claude.length, 2); assert.equal(claude[0].granularity, 'message');
  assert.ok(!JSON.stringify(claude).includes('secret')); assert.ok(!JSON.stringify(claude).includes('hidden'));
  assert.deepEqual(projectNativeWorkEvents('claude', { type: 'assistant', parent_tool_use_id: 'parent', message: { content: [{ type: 'text', text: 'auxiliary' }] } }), []);
  const end = projectNativeWorkEvents('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'secret', is_error: true }] } });
  assert.equal(end[0].status, 'failed'); assert.ok(!JSON.stringify(end).includes('secret'));
});

test('allowlisted public text receives supplemental credential redaction and no unknown fields', () => {
  const value = task();
  appendWorkEvent(value, { ...message('a', 'api_key=PRIVATE sk-proj-abcdefghijklmnopqrstuvwxyz'), reasoning: 'hidden', prompt: 'hidden', output: 'hidden' });
  const serialized = JSON.stringify(queryWorkEvents(value, { generation: 1 }));
  assert.ok(!serialized.includes('PRIVATE')); assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz')); assert.ok(!serialized.includes('hidden'));
});

test('escaped large pages stop at a byte boundary and incremental reads retain complete events', () => {
  const value = task();
  for (let i = 0; i < 35; i++) appendWorkEvent(value, message(`long-${i}`, '"'.repeat(7000)));
  const first = queryWorkEvents(value, { generation: 1, limit: 64 });
  assert.ok(first.events.length < 35); assert.equal(first.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(first.events))) <= WORK_EVENT_LIMITS.pageBytes);
  const next = queryWorkEvents(value, { generation: 1, cursor: first.cursor, limit: 64 });
  assert.equal(next.events[0].sequence, first.events.at(-1).sequence + 1);
  assert.equal(next.events[0].text.length, 7000);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { convertNativeTurns, exportNativeHistory } from '../src/native-history.mjs';
import { encodeClaude, decodeClaude } from '../src/claude.mjs';
import { fingerprint } from '../src/history.mjs';

const user = (text = 'Question', id = 'u') => ({ type: 'userMessage', id, content: [{ type: 'text', text }] });
const answer = (text = 'Answer', id = 'a') => ({ type: 'agentMessage', id, text, phase: 'final_answer' });
const turn = (id = 't1', items = [user(), answer()], startedAt = 100) => ({ id, status: 'completed', itemsView: 'full', startedAt, completedAt: startedAt + 1, items });
const page = (data, nextCursor = null) => ({ data, nextCursor });
function client(responses) {
  const calls = [];
  return { calls, async request(method, params) {
    calls.push({ method, params });
    const response = responses[(calls.length - 1) % responses.length];
    if (response instanceof Error) throw response;
    return structuredClone(response);
  } };
}
const run = (native, options = {}) => exportNativeHistory({ client: native, threadId: 'thread', cwd: '/tmp/project', ...options });

test('two complete ascending native reads preserve all pages and explicit provenance', async () => {
  const native = client([page([turn()], 'second'), page([turn('t2', [user('Next'), answer('Done')], 200)])]);
  const exported = await run(native);
  assert.equal(native.calls.length, 4);
  assert.equal(exported.turnCount, 2);
  assert.equal(exported.itemCount, 4);
  assert.equal(exported.pages, 2);
  assert.equal(exported.common.messages.length, 4);
  assert.equal(exported.common.messages[2].content[0].text, 'Next');
  assert.equal(exported.common.meta.nativeHistory.representation, 'native-persisted-display-history');
  assert.equal(exported.common.meta.nativeHistory.encryptedReasoningRecovered, false);
  assert.deepEqual(native.calls.map(x => x.params.cursor), [undefined, 'second', undefined, 'second']);
  assert.ok(native.calls.every(x => x.method === 'thread/turns/list' && x.params.itemsView === 'full' && x.params.sortDirection === 'asc'));
});

test('visible text, inline images, metadata and unknown events survive the Claude codec as inert content', async () => {
  const image = { type: 'image', url: 'data:image/png;base64,aGVsbG8=', detail: 'original' };
  const input = user(); input.content.push(image);
  input.content[0].text_elements = [{ byteRange: { start: 0, end: 8 }, placeholder: 'Question' }];
  const event = { type: 'futureTool', id: 'event', arguments: { command: 'echo synthetic' }, output: ['literal output', { retained: true }] };
  const response = answer(); response.memoryCitation = { entries: [{ path: 'notes', line: 7 }] };
  const exported = await run(client([page([turn('t', [input, event, response])])]));
  const common = exported.common;
  assert.deepEqual(common.messages[0].content.find(x => x.type === 'image').source, { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' });
  assert.match(common.messages[1].content[0].text, /historical data only/);
  assert.deepEqual(JSON.parse(common.messages[1].content[0].text.split('\n').slice(1).join('\n')), event);
  assert.match(common.messages[2].content[1].text, /memoryCitation/);
  assert.ok(common.messages.every(message => message.content.every(block => ['text', 'image'].includes(block.type))));
  const encoded = encodeClaude(common, '00000000-0000-4000-8000-000000000001');
  assert.equal(fingerprint(decodeClaude(encoded.text)), fingerprint(common));
});

test('source mutation between passes fails without retrying', async () => {
  const native = client([page([turn()]), page([turn('t1', [user(), answer('Changed')])])]);
  await assert.rejects(run(native), /source history changed/);
  assert.equal(native.calls.length, 2);
});

test('native assistant-only continuation turns retain their prior user context without fabricated prompts', async () => {
  const continued = turn('t2', [{ ...answer('Continuing', 'a2-commentary'), phase: 'commentary' },
    { type: 'commandExecution', id: 'tool-2', command: 'historical command', status: 'completed' }, answer('Finished continuation', 'a2')], 200);
  const exported = await run(client([page([turn()], 'next'), page([continued])]));
  assert.equal(exported.turnCount, 2);
  assert.equal(exported.common.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(exported.common.messages.at(-1).content[0].text, 'Finished continuation');
  await assert.rejects(run(client([page([continued])])), /precedes/);
  const steered = await run(client([page([turn(), turn('steered', [answer('Before steering'), user('Late steering'), answer('Done')], 200)])]));
  assert.equal(steered.common.messages[2].content[0].text, 'Before steering');
  assert.equal(steered.common.messages[3].content[0].text, 'Late steering');
  await assert.rejects(run(client([page([turn(), { ...continued, items: continued.items.slice(0, 2) }])])), /final assistant/);
  const active = { ...continued, status: 'inProgress', completedAt: null };
  const prefix = await run(client([page([turn(), active])]), { completedPrefix: true });
  assert.equal(prefix.turnCount, 1);
  assert.equal(prefix.incompleteTail, true);
});

test('completed-prefix mode ignores a growing active tail across full reads', async () => {
  const active = { id: 't2', status: 'inProgress', itemsView: 'full', startedAt: 200, completedAt: null,
    items: [user('Next', 'u2')] };
  const growing = { ...active, items: [...active.items, { type: 'agentMessage', id: 'a2', text: 'Working', phase: 'commentary', status: 'inProgress' }] };
  const native = client([page([turn(), active]), page([turn(), growing])]);
  const exported = await run(native, { completedPrefix: true });
  assert.equal(native.calls.length, 2);
  assert.equal(exported.turnCount, 1);
  assert.equal(exported.itemCount, 2);
  assert.equal(exported.incompleteTail, true);
  assert.equal(exported.incompleteTailCount, 1);
  assert.equal(exported.common.messages.length, 2);
  const notice = exported.common.messages[0].content[0].text;
  const settled = await run(client([page([turn()])]), { completedPrefix: true });
  assert.equal(settled.common.messages[0].content[0].text, notice);
  await assert.rejects(run(client([page([active])]), { completedPrefix: true }), /no completed persisted history/);
  await assert.rejects(run(client([page([active, turn('t3', [user('Later'), answer('Done')], 300)])]), { completedPrefix: true }), /in-progress turn precedes completed history/);
});

test('closed interrupted history before a completed turn remains explicit inert data', async () => {
  const interrupted = { id: 't1', status: 'interrupted', itemsView: 'full', startedAt: 100, completedAt: 101,
    error: { message: 'Synthetic interruption' }, items: [user('Earlier', 'u1'), { type: 'commandExecution', id: 'tool-1', status: 'inProgress', command: 'synthetic' }] };
  const completed = turn('t2', [user('Continue', 'u2'), answer('Done', 'a2')], 200);
  const exported = await run(client([page([interrupted, completed])]), { completedPrefix: true });
  assert.equal(exported.turnCount, 2);
  assert.equal(exported.incompleteTail, false);
  assert.equal(exported.common.messages.length, 5);
  assert.match(exported.common.messages[1].content[0].text, /commandExecution/);
  assert.match(exported.common.messages[2].content[0].text, /interrupted/);
  assert.match(exported.common.messages[2].content[0].text, /Synthetic interruption/);
  assert.equal(exported.common.messages.at(-1).content[0].text, 'Done');
  const snapshot = { threadId: 'thread', turns: [interrupted, completed] };
  assert.throws(() => convertNativeTurns(snapshot, { threadId: 'thread', cwd: '/tmp/project' }), /only completed/);
  assert.doesNotThrow(() => convertNativeTurns({ ...snapshot, completedPrefix: true }, { threadId: 'thread', cwd: '/tmp/project' }));
});

test('duplicate turn IDs, cursor cycles, and incomplete pagination fail explicitly', async () => {
  await assert.rejects(run(client([page([turn()], 'next'), page([turn()])])), /duplicate turn/);
  await assert.rejects(run(client([page([turn()], 'next'), page([turn('t2')], 'next')])), /cursor cycle/);
  await assert.rejects(run(client([page([], 'next')])), /empty page/);
  await assert.rejects(run(client([page([turn()], 3)])), /invalid pagination cursor/);
});

test('summary views, active/failed turns, reversed ordering and malformed completion boundaries are refused', async () => {
  for (const status of ['inProgress', 'failed', 'interrupted']) {
    await assert.rejects(run(client([page([{ ...turn(), status }])])), /in-progress|only completed/);
  }
  await assert.rejects(run(client([page([{ ...turn(), itemsView: 'summary' }])])), /full turn items/);
  await assert.rejects(run(client([page([{ ...turn(), itemsView: undefined }])])), /full turn items/);
  await assert.rejects(run(client([page([turn('t1', undefined, 200), turn('t2', undefined, 100)])])), /ascending order/);
  for (const items of [[user()], [answer()], [user(), { ...answer(), phase: 'commentary' }], [user(), answer('')], [user(), answer(), user('Unanswered')]]) {
    await assert.rejects(run(client([page([turn('t', items)])])), /final assistant|precedes/);
  }
  await assert.rejects(run(client([page([{ ...turn(), completedAt: 1 }])])), /completion precedes/);
  await assert.rejects(run(client([page([turn('t', [user(), { type: 'commandExecution', id: 'tool', status: 'inProgress' }, answer()])])])), /item is still in progress/);
});

test('external and unknown user inputs are rejected instead of omitted', async () => {
  for (const block of [{ type: 'image', url: 'https://example.invalid/img' }, { type: 'image', fileId: 'file-1' },
    { type: 'image', url: 'data:image/png;base64,broken' }, { type: 'localImage', path: '/tmp/image.png' },
    { type: 'audio', url: 'data:audio/wav;base64,aGVsbG8=' }, { type: 'futureInput', text: 'Do not omit me' }]) {
    await assert.rejects(run(client([page([turn('t', [{ ...user(), content: [block] }, answer()])])])), /image|unsupported user input/);
  }
});

test('byte, item and page caps never return truncated histories', async () => {
  await assert.rejects(run(client([page([turn()])]), { limits: { maxBytes: 5 } }), /byte limit exceeded/);
  await assert.rejects(run(client([page([turn()])]), { limits: { maxItems: 1 } }), /item limit exceeded/);
  await assert.rejects(run(client([page([turn()], 'next')]), { limits: { maxPages: 1 } }), /page limit exceeded/);
  await assert.rejects(run(client([page([turn()])]), { limits: { maxItems: 0 } }), /invalid export limit/);
  const nativeBytes = Buffer.byteLength(JSON.stringify(page([turn()])));
  await assert.rejects(run(client([page([turn()])]), { limits: { maxBytes: nativeBytes + 10 } }), /converted byte limit/);
});

test('API availability errors are explicit and do not echo private server messages', async () => {
  const error = Object.assign(new Error('private transcript text'), { code: -32601 });
  await assert.rejects(run(client([error])), error => error.message.includes('thread/turns/list is unavailable') && error.message.includes('-32601') && !error.message.includes('private'));
});

test('a known closed transport remains a transient read failure without exposing server text', async () => {
  let calls = 0;
  const source = { closed: false, async request() { calls++; this.closed = true; throw new Error('private connection detail'); } };
  await assert.rejects(run(source), error => /native transport unavailable/.test(error.message) && !error.message.includes('private'));
  assert.equal(calls, 1);
});

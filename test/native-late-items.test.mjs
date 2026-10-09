import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeLateItemResolver } from '../src/native-late-items.mjs';
import { nativeHistoryEntries, nativeItemDigest } from '../src/native-history-order.mjs';
import { convertNativeTurns, exportNativeHistory } from '../src/native-history.mjs';
import { fingerprint } from '../src/history.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const turnId = '00000000-0000-4000-8000-000000000002';
const afterId = '00000000-0000-4000-8000-000000000003';
const cwd = '/tmp/synthetic project';
const script = 'printf \'%s\' "synthetic"';
const user = id => ({ type: 'userMessage', id, content: [{ type: 'text', text: 'Synthetic input.' }] });
const agent = id => ({ type: 'agentMessage', id, text: 'Synthetic completed reply.', phase: 'final_answer' });
function rawCommand() {
  return { type: 'CommandExecution', id: 'exec-synthetic', command: ['/bin/zsh', '-lc', script],
    cwd: pathToFileURL(cwd).href, process_id: '12345', source: 'unified_exec_startup', status: 'failed',
    parsed_cmd: [{ type: 'unknown', cmd: script }], aggregated_output: 'Synthetic output.\n',
    stdout: 'Synthetic output.\n', stderr: '', formatted_output: 'Synthetic output.\n', exit_code: -1,
    duration: { secs: 101, nanos: 499999999 } };
}
function apiCommand() {
  return { type: 'commandExecution', id: 'exec-synthetic', command: '/bin/zsh -lc "printf \'%s\' \\"synthetic\\""',
    cwd, processId: '12345', source: 'unifiedExecStartup', status: 'failed',
    commandActions: [{ type: 'unknown', command: script }], aggregatedOutput: 'Synthetic output.\n',
    exitCode: -1, durationMs: 101499, pluginId: null, scriptPath: null };
}
function snapshot() {
  return { turns: [
    { id: turnId, status: 'completed', error: null, itemsView: 'full', startedAt: 100, completedAt: 101,
      items: [user('user-one'), agent('agent-one'), apiCommand()] },
    { id: afterId, status: 'completed', error: null, itemsView: 'full', startedAt: 200, completedAt: 201,
      items: [user('user-two'), agent('agent-two')] },
  ] };
}
const frame = (type, payload, ms) => ({ timestamp: new Date(ms).toISOString(), type, payload });
const start = (id, seconds) => frame('event_msg', { type: 'task_started', turn_id: id, root_turn_id: id,
  started_at: seconds, model_context_window: 100000, collaboration_mode_kind: 'default' }, seconds * 1000 + 100);
const context = (id, seconds) => frame('turn_context', { turn_id: id, root_turn_id: id, cwd }, seconds * 1000 + 200);
const stop = (id, seconds) => frame('event_msg', { type: 'task_complete', turn_id: id, started_at: seconds,
  completed_at: seconds + 1, duration_ms: 900, last_agent_message: 'Synthetic completed reply.',
  time_to_first_token_ms: 50 }, (seconds + 1) * 1000);
const completion = (item = rawCommand(), owner = turnId, ms = 202000) => frame('event_msg', {
  type: 'item_completed', thread_id: threadId, turn_id: owner, item, started_at_ms: 100500, completed_at_ms: ms,
}, ms);
function rows() {
  return [frame('session_meta', { id: threadId, session_id: threadId, cwd, history_mode: 'paginated',
    originator: 'Codex Desktop', cli_version: '0.160.0', source: 'vscode', thread_source: 'user' }, 99000),
  start(turnId, 100), context(turnId, 100), stop(turnId, 100),
  start(afterId, 200), context(afterId, 200), stop(afterId, 200), completion()];
}
const encode = source => source.map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join('\n') + '\n';
async function fixture(t, mutate = () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-native-late-')));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'synthetic.jsonl'), source = rows(), native = snapshot();
  mutate(source, native); const text = encode(source);
  await writeFile(path, text, { mode: 0o600 }); await chmod(path, 0o600);
  return { root, path, source, native, text, resolver: createNativeLateItemResolver({ path, threadId, cwd }) };
}
const prove = source => source.resolver(source.native, { threadId });
const client = (native, before = async () => {}) => {
  let calls = 0;
  return { async request(method, params) { assert.equal(method, 'thread/turns/list'); assert.equal(params.threadId, threadId);
    await before(++calls); return { data: structuredClone(native.turns), nextCursor: null }; } };
};

test('exact late completion preserves every item and the complete earlier checkpoint', async t => {
  const source = await fixture(t), proof = await prove(source);
  assert.deepEqual(proof.placements, [{ turnId, itemId: 'exec-synthetic', afterTurnId: afterId,
    itemDigest: nativeItemDigest(apiCommand()) }]);
  for (const key of ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.match(proof.sourceIdentity[key], /^\d+$/);
  assert.match(proof.evidenceDigest, /^[a-f0-9]{64}$/);
  const initial = snapshot(); initial.turns[0].items.pop();
  const previous = convertNativeTurns(initial, { threadId, cwd });
  const checkpoint = { count: previous.messages.length, digest: fingerprint(previous) };
  const exported = await exportNativeHistory({ client: client(source.native), threadId, cwd, completedPrefix: true,
    resolveLateItems: source.resolver, checkpoint });
  assert.equal(exported.common.messages.length, 5);
  assert.equal(fingerprint(exported.common, checkpoint.count), checkpoint.digest);
  assert.match(exported.common.messages.at(-1).content[0].text, /historical data only/);
  assert.match(exported.common.messages.at(-1).content[0].text, /Synthetic output/);
  assert.equal(nativeHistoryEntries({ ...source.native, lateItemEvidence: proof }).at(-1).item.id, 'exec-synthetic');
  assert.deepEqual(source.native, snapshot());
  assert.equal(await readFile(source.path, 'utf8'), source.text);
});

test('native shell quoting and file URI conversion are exact historical projections', async t => {
  const source = await fixture(t, (raw, native) => {
    raw.at(-1).payload.item.command = ['safe', 'two words', "can't", '$literal', 'a\\b', '^caret', '', '非 ASCII'];
    native.turns[0].items.at(-1).command = 'safe \'two words\' "can\'t" \'$literal\' "a\\\\b" \'^caret\' \'\' \'非 ASCII\'';
  });
  assert.equal((await prove(source)).placements.length, 1);
});

test('no command or no late completion returns no provenance and keeps ordinary native order', async t => {
  const absent = createNativeLateItemResolver({ path: '/tmp/nonexistent-native-late-source', threadId, cwd });
  assert.equal(await absent({ turns: [] }, { threadId }), null);
  const source = await fixture(t, raw => {
    const late = raw.pop(); late.timestamp = new Date(100700).toISOString(); late.payload.completed_at_ms = 100700;
    raw.splice(3, 0, late);
  });
  assert.equal(await prove(source), null);
  assert.equal(nativeHistoryEntries(source.native)[2].item.id, 'exec-synthetic');
});

test('ordinary interrupted command history still exports its completed continuation', async t => {
  const source = await fixture(t, (raw, native) => {
    raw.pop(); raw[3] = frame('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }, 101000);
    native.turns[0].status = 'interrupted'; native.turns[0].items.at(-1).status = 'inProgress';
  });
  assert.equal(await prove(source), null);
  const result = await exportNativeHistory({ client: client(source.native), threadId, cwd, completedPrefix: true,
    resolveLateItems: source.resolver });
  assert.equal(result.turnCount, 2); assert.equal(result.incompleteTail, false);
  assert.match(result.common.messages[3].content[0].text, /closed turn status/);
});

test('no late item leaves unrelated native lifecycle schemas to the normal API reader', async t => {
  const source = await fixture(t, raw => {
    raw.pop(); raw.push(frame('event_msg', { type: 'task_started', turn_id: null }, 202000));
  });
  assert.equal(await prove(source), null);
});

const laterId = '00000000-0000-4000-8000-000000000004';
const laterTurn = () => [start(laterId, 300), context(laterId, 300)];
const lateAt = (ms, mutate = () => {}) => { const row = completion(rawCommand(), turnId, ms); mutate(row); return row; };

test('a command that finishes while a later turn runs is placed after the newest closed turn', async t => {
  const source = await fixture(t, raw => {
    raw.pop();
    raw.push(frame('event_msg', { type: 'thread_settings_applied' }, 299000), frame('event_msg', { type: 'thread_settings_applied' }, 299500),
      ...laterTurn(), frame('response_item', { type: 'message', role: 'user', content: [] }, 300300), lateAt(300500));
  });
  const proof = await prove(source);
  assert.deepEqual(proof.placements.map(placement => placement.afterTurnId), [afterId]);
  assert.equal(proof.withheld, undefined);
  assert.equal(nativeHistoryEntries({ ...source.native, lateItemEvidence: proof }).at(-1).item.id, 'exec-synthetic');
});

test('observed native variants of one late completion are the same proof', async t => {
  for (const mutate of [
    raw => { raw.at(-1).timestamp = new Date(202014).toISOString(); },
    raw => { delete raw.at(-1).payload.started_at_ms; },
    raw => { raw[0].payload.dynamic_tools = []; raw[2].payload.cyber_access_program = null; raw.splice(3, 0, structuredClone(raw[2])); },
    raw => { delete raw[1].payload.root_turn_id; raw[1].payload.turn_attribution = 'user'; raw[3].payload.root_turn_id = turnId; },
    (raw, native) => { const item = raw.at(-1).payload.item; item.aggregated_output = item.stdout = item.formatted_output = '';
      native.turns[0].items.at(-1).aggregatedOutput = null; },
    (raw, native) => { raw.at(-1).payload.item.cwd = pathToFileURL('/tmp/other project').href; native.turns[0].items.at(-1).cwd = '/tmp/other project'; },
  ]) {
    const source = await fixture(t, mutate);
    assert.deepEqual((await prove(source)).placements.map(placement => placement.afterTurnId), [afterId]);
  }
});

test('interrupted and failed turns are closed boundaries with their exact native stop', async t => {
  const aborted = (id, seconds) => frame('event_msg', { type: 'turn_aborted', turn_id: id, reason: 'interrupted',
    started_at: seconds, completed_at: seconds + 1, duration_ms: 900 }, (seconds + 1) * 1000);
  const interrupted = await fixture(t, (raw, native) => { raw[3] = aborted(turnId, 100); raw[6] = aborted(afterId, 200);
    native.turns[0].status = native.turns[1].status = 'interrupted'; });
  const proof = await prove(interrupted);
  assert.equal(proof.placements.length, 1);
  // The closed status of the boundary still precedes the late command.
  assert.deepEqual(nativeHistoryEntries({ ...interrupted.native, lateItemEvidence: proof }).slice(-2).map(entry => entry.kind), ['closedTurnStatus', 'item']);
  const failed = await fixture(t, (raw, native) => { raw[6].payload.error = { message: 'Synthetic failure.' };
    raw[6].payload.last_agent_message = null; native.turns[1].status = 'failed'; native.turns[1].error = { message: 'Synthetic failure.' }; });
  assert.equal((await prove(failed)).placements.length, 1);
});

test('a command arriving after a boundary that is not exported yet waits for that boundary', async t => {
  const finalId = '00000000-0000-4000-8000-000000000005';
  const compaction = { id: laterId, status: 'completed', error: null, itemsView: 'full', startedAt: 300, completedAt: 301,
    items: [{ type: 'contextCompaction', id: 'compaction-synthetic' }] };
  // A compaction-only turn has no context, reply or first-token time.
  const control = () => { const row = stop(laterId, 300); delete row.payload.time_to_first_token_ms; row.payload.last_agent_message = null;
    return [start(laterId, 300), row]; };
  const trailing = await fixture(t, raw => { raw.pop(); raw.push(...control(), lateAt(302000)); });
  const proof = await prove(trailing);
  assert.deepEqual(proof.placements, []);
  assert.deepEqual(proof.withheld.map(placement => placement.afterTurnId), [laterId]);
  assert.deepEqual(nativeHistoryEntries({ ...trailing.native, lateItemEvidence: proof }).map(entry => entry.item.id),
    ['user-one', 'agent-one', 'user-two', 'agent-two']);
  const initial = snapshot(); initial.turns[0].items.pop();
  const previous = convertNativeTurns(initial, { threadId, cwd }), checkpoint = { count: previous.messages.length, digest: fingerprint(previous) };
  const exported = await exportNativeHistory({ client: client({ turns: [...trailing.native.turns, compaction] }), threadId, cwd,
    completedPrefix: true, resolveLateItems: trailing.resolver, checkpoint });
  assert.equal(exported.common.messages.length, 4);
  assert.equal(fingerprint(exported.common), checkpoint.digest);
  // Once a real reply follows, the boundary and then the command are exported.
  const published = await fixture(t, (raw, native) => {
    raw.pop(); raw.push(...control(), lateAt(302000), start(finalId, 400), context(finalId, 400), stop(finalId, 400));
    native.turns.push(compaction, { id: finalId, status: 'completed', error: null, itemsView: 'full', startedAt: 400, completedAt: 401,
      items: [user('user-three'), agent('agent-three')] });
  });
  const later = await prove(published);
  assert.equal(later.withheld, undefined);
  assert.deepEqual(nativeHistoryEntries({ ...published.native, lateItemEvidence: later }).map(entry => entry.item.id),
    ['user-one', 'agent-one', 'user-two', 'agent-two', 'compaction-synthetic', 'exec-synthetic', 'user-three', 'agent-three']);
  const continued = await exportNativeHistory({ client: client(published.native), threadId, cwd, completedPrefix: true,
    resolveLateItems: published.resolver, checkpoint });
  assert.equal(fingerprint(continued.common, checkpoint.count), checkpoint.digest);
  assert.equal(continued.common.messages.length, 8);
});

test('a checkpoint that already holds earlier late commands in native order still authenticates', async t => {
  const second = () => ({ ...rawCommand(), id: 'exec-second' });
  const source = await fixture(t, (raw, native) => {
    raw.push(...laterTurn(), stop(laterId, 300), completion(second(), afterId, 302000));
    raw.at(-1).payload.started_at_ms = 200500;
    native.turns[1].items.push({ ...apiCommand(), id: 'exec-second' });
    native.turns.push({ id: laterId, status: 'completed', error: null, itemsView: 'full', startedAt: 300, completedAt: 301,
      items: [user('user-three'), agent('agent-three')] });
  });
  // Saved while the first late command was already listed in its own turn and
  // before the second one arrived.
  const saved = structuredClone(source.native); saved.turns[1].items.pop();
  const previous = convertNativeTurns(saved, { threadId, cwd }), checkpoint = { count: previous.messages.length, digest: fingerprint(previous) };
  const exported = await exportNativeHistory({ client: client(source.native), threadId, cwd, completedPrefix: true,
    resolveLateItems: source.resolver, checkpoint });
  assert.equal(fingerprint(exported.common, checkpoint.count), checkpoint.digest);
  assert.equal(exported.common.messages.length, checkpoint.count + 1);
  assert.match(exported.common.messages.at(-1).content[0].text, /exec-second/);
  assert.match(exported.common.messages[2].content[0].text, /exec-synthetic/);
});

const invalid = [
  ['actual command change', (_raw, native) => { native.turns[0].items.at(-1).command += ' changed'; }],
  ['actual output change', (_raw, native) => { native.turns[0].items.at(-1).aggregatedOutput += ' changed'; }],
  ['unknown API field', (_raw, native) => { native.turns[0].items.at(-1).newMetadata = null; }],
  ['unknown raw field', raw => { raw.at(-1).payload.item.new_metadata = null; }],
  ['unknown completion field', raw => { raw.at(-1).payload.new_metadata = null; }],
  ['unknown source', raw => { raw.at(-1).payload.item.source = 'agent'; }],
  ['unknown parsed action', raw => { raw.at(-1).payload.item.parsed_cmd[0].type = 'read'; }],
  ['unretained stderr', raw => { raw.at(-1).payload.item.stderr = 'Additional native output.'; }],
  ['unretained formatted output', raw => { raw.at(-1).payload.item.formatted_output += ' extra'; }],
  ['wrong file URI', raw => { raw.at(-1).payload.item.cwd = 'file://foreign-host/tmp/synthetic%20project'; }],
  ['wrong process binding', (_raw, native) => { native.turns[0].items.at(-1).processId = 'other'; }],
  ['unsafe duration', raw => { raw.at(-1).payload.item.duration.nanos = 1e9; }],
  ['actual assistant late item', raw => { raw.at(-1).payload.item = { type: 'AgentMessage', id: 'agent-late', content: [] }; }],
  ['wrong thread', raw => { raw.at(-1).payload.thread_id = afterId; }],
  ['unknown late parent', raw => { raw.at(-1).payload.turn_id = '00000000-0000-4000-8000-000000000099'; }],
  ['wrong header', raw => { raw[0].payload.id = afterId; }],
  ['wrong parent API time', (_raw, native) => { native.turns[0].startedAt++; }],
  ['wrong native start second', raw => { raw[1].payload.started_at++; }],
  ['wrong context cwd', raw => { raw[2].payload.cwd = '/tmp/foreign'; }],
  ['wrong exact final reply', raw => { raw[3].payload.last_agent_message += ' changed'; }],
  ['malformed start cannot prove idle', raw => { raw.splice(7, 0, frame('event_msg', { type: 'task_started', turn_id: null }, 201500)); }],
  ['ambiguous activity before arrival', raw => { raw.splice(7, 0, frame('response_item', { type: 'message', role: 'user', content: [] }, 201500)); }],
  ['completion recorded after its row', raw => { raw.at(-1).payload.completed_at_ms++; }],
  ['missing parent context', raw => { raw.splice(2, 1); }],
  ['context of another turn identity', raw => { raw[2].payload.root_turn_id = afterId; }],
  ['command outside a file path', raw => { raw.at(-1).payload.item.cwd = 'relative/project'; }],
  ['command directory differs from the API', raw => { raw.at(-1).payload.item.cwd = pathToFileURL('/tmp/other project').href; }],
  ['unrecognized activity before the running turn', raw => { raw.push(frame('response_item', { type: 'message' }, 250000), ...laterTurn(), raw.splice(7, 1)[0]); }],
  ['failed stop without an API error', raw => { raw[6].payload.error = { message: 'Synthetic.' }; }],
  ['start after parent stop', raw => { raw.at(-1).payload.started_at_ms = 150000; }],
  ['prior same item', raw => { const prior = structuredClone(raw.at(-1)); prior.timestamp = new Date(100500).toISOString(); prior.payload.type = 'item_started'; raw.splice(3, 0, prior); }],
  ['duplicate late item', raw => { raw.push(structuredClone(raw.at(-1))); }],
  ['duplicate API item', (_raw, native) => { native.turns[0].items.push(apiCommand()); }],
  ['same item in another turn', (_raw, native) => { native.turns[1].items.push(apiCommand()); }],
  ['aborted arrival boundary', (raw, native) => { raw[6] = frame('event_msg', { type: 'turn_aborted', turn_id: afterId, reason: 'interrupted' }, 201000); native.turns[1].status = 'interrupted'; }],
  ['aborted source parent', (raw, native) => { raw[3] = frame('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }, 101000); native.turns[0].status = 'interrupted'; }],
  ['failed arrival boundary', (_raw, native) => { native.turns[1].status = 'failed'; }],
  ['summarized parent items', (_raw, native) => { native.turns[0].itemsView = 'summary'; }],
];
for (const [name, mutate] of invalid) test(`late provenance rejects ${name}`, async t => {
  const source = await fixture(t, mutate); await assert.rejects(prove(source), /Native Codex late item:/);
});

test('source aliases, foreign permissions, bounds and ambiguous serialized frames refuse before provenance', async t => {
  const source = await fixture(t), alias = join(source.root, 'alias');
  await symlink(source.path, alias);
  await assert.rejects(createNativeLateItemResolver({ path: alias, threadId, cwd })(source.native, { threadId }), /regular file/);
  await rm(alias); await link(source.path, alias); await assert.rejects(prove(source), /single-link/); await rm(alias);
  // Native writes rollouts readable by others; only write access is refused.
  await chmod(source.path, 0o644); assert.equal((await prove(source)).placements.length, 1);
  for (const mode of [0o660, 0o602]) { await chmod(source.path, mode); await assert.rejects(prove(source), /group or world write/); }
  await chmod(source.path, 0o600);
  await assert.rejects(createNativeLateItemResolver({ path: source.path, threadId, cwd, maxBytes: 16 })(source.native, { threadId }), /bounded/);
  await writeFile(source.path, source.text.trimEnd()); await assert.rejects(prove(source), /incomplete final/);
  await writeFile(source.path, source.text.replace('"ordinal":7', '"ordinal":6')); await assert.rejects(prove(source), /ordinal chain/);
  await writeFile(source.path, source.text.replace('"completed_at_ms":202000', '"completed_at_ms":0,"completed_at_ms":202000'));
  await assert.rejects(prove(source), /ambiguous serialization/);
});

test('stable source provenance is independently compared across both native API reads', async t => {
  const source = await fixture(t);
  await assert.rejects(exportNativeHistory({ client: client(source.native, async count => {
    if (count === 2) await writeFile(source.path, source.text.replace('"source":"vscode"', '"source":"terminal"'));
  }), threadId, cwd, completedPrefix: true, resolveLateItems: source.resolver }), /source history changed between complete reads/);
});

test('a real earlier prefix change remains a conflict even with exact late provenance', async t => {
  const source = await fixture(t), initial = snapshot(); initial.turns[0].items.pop();
  const old = convertNativeTurns(initial, { threadId, cwd }), checkpoint = { count: old.messages.length, digest: fingerprint(old) };
  source.native.turns[0].items[0].content[0].text = 'Changed real earlier user input.';
  await assert.rejects(exportNativeHistory({ client: client(source.native), threadId, cwd, completedPrefix: true,
    resolveLateItems: source.resolver, checkpoint }), /does not match the verified canonical checkpoint/);
});

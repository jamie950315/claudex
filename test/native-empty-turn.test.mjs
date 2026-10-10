import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, link, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeEmptyTurnResolver } from '../src/native-empty-turn.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const turnId = '00000000-0000-4000-8000-000000000002';
const nextId = '00000000-0000-4000-8000-000000000003';
const cwd = '/tmp/synthetic-project';
const turn = (id = turnId, start = 100) => ({ id, status: 'completed', error: null, itemsView: 'full',
  items: [], startedAt: start, completedAt: start, durationMs: 140 });
const segment = (id = turnId, start = 100) => [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: id, root_turn_id: id, started_at: start } },
  { type: 'turn_context', payload: { turn_id: id, root_turn_id: id, cwd, model: 'synthetic-model' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: null,
    started_at: start, completed_at: start, duration_ms: 140 } },
];
const rows = () => [{ type: 'session_meta', payload: { id: threadId, cwd } }, ...segment()];
const settings = () => ({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: threadId, model: 'synthetic-model' } });
const encode = value => value.map(row => JSON.stringify(row)).join('\n') + '\n';
const developerBlocks = [
  ['generic.developer_instructions', '<app-context>\nSynthetic app context.</app-context>'],
  ['memories.instructions', '## Memory\nSynthetic memory context.'],
  ['host_skills.instructions', '<skills_instructions>Synthetic skills.</skills_instructions>'],
  ['permissions.instructions', '<permissions instructions>Synthetic permissions.</permissions instructions>'],
  ['collaboration_mode.instructions', '<collaboration_mode>Synthetic mode.</collaboration_mode>'],
  ['plugins.recommendations', '<recommended_plugins>Synthetic recommendations.</recommended_plugins>'],
  ['multi_agent.role_instructions', '<multi_agent_role>Synthetic role.</multi_agent_role>'],
  ['multi_agent.mode_instructions', '<multi_agent_mode>Synthetic mode.</multi_agent_mode>'],
];
const worldKeys = ['agents_md', 'apps_instructions', 'collaboration_mode', 'context_window_guidance', 'environments',
  'environments_instructions', 'git_attribution', 'host_skills', 'managed_developer_instructions', 'model',
  'multi_agent_mode', 'multi_agent_usage_hint', 'permissions', 'persistent_mode', 'plugins_instructions', 'realtime', 'skills'];
const contextMessage = (serial, role, blocks) => ({ type: 'response_item', payload: { type: 'message',
  id: `msg_00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`, role,
  content: blocks.map(([, text]) => ({ type: 'input_text', text })),
  internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: 100.5, content_item_kinds: blocks.map(([kind]) => kind) },
} });
function withBootstrap(source) {
  source.splice(2, 0,
    contextMessage(1, 'developer', developerBlocks),
    contextMessage(2, 'user', [
      ['agents_md.instructions', `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>Synthetic rules.</INSTRUCTIONS>`],
      ['environments.environment_context', `<environment_context><cwd>${cwd}</cwd></environment_context>`],
    ]),
    { type: 'world_state', payload: { full: true, state: Object.fromEntries(worldKeys.map(key => [key, null])) } });
  source.splice(6, 0,
    contextMessage(3, 'developer', [['additional_content.codex_apps_client_time_context', '<codex_apps_client_time_context>Synthetic time.</codex_apps_client_time_context>']]),
    contextMessage(4, 'user', [['additional_content.codex_apps_open_page', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>']]),
    contextMessage(5, 'developer', [['additional_content.codex_apps_open_page_instructions', '<codex_apps_open_page_instructions>Synthetic instructions.</codex_apps_open_page_instructions>']]));
}
function withResumeDelta(source) {
  const state = {
    agents_md: { directory: cwd, text: 'Synthetic project instructions.' },
    environments: { environments: { local: { cwd, status: 'available', shell: 'zsh' } },
      filesystem: '<filesystem><workspace_roots><root>/tmp/synthetic-project</root></workspace_roots></filesystem>' },
    permissions: { instructions: 'a'.repeat(40) },
  };
  source.splice(2, 0,
    contextMessage(1, 'user', [['agents_md.instructions', `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nThese AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n${state.agents_md.text}\n</INSTRUCTIONS>`]]),
    contextMessage(2, 'developer', [['permissions.instructions', '<permissions instructions>Synthetic permissions.</permissions instructions>']]),
    contextMessage(3, 'user', [['environments.environment_context', `<environment_context><cwd>${cwd}</cwd>${state.environments.filesystem}</environment_context>`]]),
    { type: 'world_state', payload: { full: false, state } });
}
async function fixture(t, mutate = () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-empty-turn-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'rollout.jsonl');
  const source = rows(); mutate(source);
  await writeFile(path, encode(source), { mode: 0o600 });
  return { root, path, source, resolve: createNativeEmptyTurnResolver({ path, threadId, cwd }) };
}
const run = (source, turns = [turn()]) => source.resolve(turns, { threadId });

test('proves one exact empty lifecycle without inventing a hook or changing native data', async t => {
  const source = await fixture(t);
  const original = await readFile(source.path);
  const result = await run(source);
  assert.deepEqual(result.turnIds, [turnId]);
  assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(result.sourceIdentity), ['dev', 'ino', 'uid', 'mode', 'nlink']);
  assert.equal(Object.hasOwn(result, 'hook'), false);
  assert.deepEqual(await readFile(source.path), original);
});

test('loaded-chat environment-only world-state deltas are context, never a general delta exemption', async t => {
  const source = await fixture(t, source => {
    source.splice(2, 0, { type: 'world_state', payload: { full: false, state: { environments: [] } } });
  });
  const proof = await run(source);
  assert.deepEqual(proof.turnIds, [turnId]);
  source.source[2].payload.state.environments = [{ id: 'synthetic-local' }];
  await writeFile(source.path, encode(source.source));
  assert.notEqual((await run(source)).evidenceDigest, proof.evidenceDigest);
  source.source[2].payload.state.user_message = 'Not native environment context';
  await writeFile(source.path, encode(source.source));
  await assert.rejects(run(source), /unrecognized native world state/);
});

test('loaded-chat resume context delta proves the exact empty segment and preserves all native bytes', async t => {
  const source = await fixture(t, withResumeDelta), original = await readFile(source.path);
  const proof = await run(source);
  assert.deepEqual(proof.turnIds, [turnId]);
  assert.deepEqual(await readFile(source.path), original);
  source.source[5].payload.state.permissions.instructions = 'b'.repeat(40);
  await writeFile(source.path, encode(source.source));
  assert.notEqual((await run(source)).evidenceDigest, proof.evidenceDigest);
});

const resumeMutations = [
  ['unknown state field', source => { source[5].payload.state.user_message = 'An ordinary request.'; }],
  ['foreign instruction directory', source => { source[5].payload.state.agents_md.directory = '/tmp/another-project'; }],
  ['extra instruction field', source => { source[5].payload.state.agents_md.output = 'Authored output.'; }],
  ['changed instruction text', source => { source[5].payload.state.agents_md.text += ' Unbound context.'; }],
  ['missing typed permissions', source => { source.splice(3, 1); }],
  ['foreign environment cwd', source => { source[5].payload.state.environments.environments.local.cwd = '/tmp/another-project'; }],
  ['additional environment', source => { source[5].payload.state.environments.environments.remote = { cwd }; }],
  ['unknown environment field', source => { source[5].payload.state.environments.command = 'Run a tool.'; }],
  ['unknown local field', source => { source[5].payload.state.environments.environments.local.output = 'Tool output.'; }],
  ['unknown environment state', source => { source[5].payload.state.environments.environments.local.status = 'running'; }],
  ['invalid native shell', source => { source[5].payload.state.environments.environments.local.shell = null; }],
  ['unbound filesystem', source => { source[5].payload.state.environments.filesystem = '<filesystem>Unbound permissions.</filesystem>'; }],
  ['unknown permission field', source => { source[5].payload.state.permissions.approved_command_prefixes = []; }],
  ['invalid permission hash', source => { source[5].payload.state.permissions.instructions = 'Run arbitrary work.'; }],
  ['world after context', source => { [source[5], source[6]] = [source[6], source[5]]; }],
  ['ordinary user input', source => { source.splice(6, 0, contextMessage(4, 'user', [['user.text', 'Do real work.']])); }],
  ['token usage', source => { source.splice(6, 0, { type: 'token_usage_record', payload: { thread_id: threadId, turn_id: turnId, usage: {} } }); }],
  ['tool activity', source => { source.splice(6, 0, { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}' } }); }],
];
for (const [name, mutate] of resumeMutations) test(`loaded-chat resume context delta refuses ${name}`, async t => {
  const source = await fixture(t, source => { withResumeDelta(source); mutate(source); });
  await assert.rejects(run(source), /Native Codex empty turn:/);
});

test('one batch proves separated empty segments and accepts exact outside settings events', async t => {
  const source = await fixture(t, source => source.push(settings(), ...segment(nextId, 200), settings()));
  const proof = await run(source, [turn(), turn(nextId, 200)]);
  assert.deepEqual(proof.turnIds, [turnId, nextId]);
});

test('fresh blocked native turns allow only typed bootstrap and null-page context, all covered by digest', async t => {
  const source = await fixture(t, withBootstrap);
  const proof = await run(source);
  assert.deepEqual(proof.turnIds, [turnId]);
  source.source[2].payload.content[1].text += ' Changed instructions.';
  await writeFile(source.path, encode(source.source));
  assert.notEqual((await run(source)).evidenceDigest, proof.evidenceDigest);
});

const contextMutations = [
  ['ordinary user prompt', source => { source[3].payload.internal_chat_message_metadata_passthrough.content_item_kinds[0] = 'text'; }],
  ['assistant role', source => { source[2].payload.role = 'assistant'; }],
  ['wrong native role', source => { source[2].payload.role = 'user'; }],
  ['function response', source => { source[2].payload.type = 'function_call'; }],
  ['missing metadata', source => { delete source[2].payload.internal_chat_message_metadata_passthrough; }],
  ['metadata extra field', source => { source[2].payload.internal_chat_message_metadata_passthrough.extra = true; }],
  ['metadata wrong turn', source => { source[2].payload.internal_chat_message_metadata_passthrough.turn_id = nextId; }],
  ['metadata early time', source => { source[2].payload.internal_chat_message_metadata_passthrough.create_time = 99.999; }],
  ['metadata late time', source => { source[2].payload.internal_chat_message_metadata_passthrough.create_time = 101; }],
  ['metadata invalid time', source => { source[2].payload.internal_chat_message_metadata_passthrough.create_time = null; }],
  ['metadata block count', source => { source[2].payload.internal_chat_message_metadata_passthrough.content_item_kinds.pop(); }],
  ['unknown kind', source => { source[2].payload.internal_chat_message_metadata_passthrough.content_item_kinds[0] = 'unknown.instructions'; }],
  ['inherited kind name', source => { source[2].payload.internal_chat_message_metadata_passthrough.content_item_kinds[0] = 'constructor'; }],
  ['duplicate kind', source => { source[2].payload.internal_chat_message_metadata_passthrough.content_item_kinds[1] = 'generic.developer_instructions'; }],
  ['output content', source => { source[2].payload.content[0].type = 'output_text'; }],
  ['extra content field', source => { source[2].payload.content[0].output = 'Hidden output.'; }],
  ['unframed content', source => { source[2].payload.content[0].text = 'Run an ordinary task.'; }],
  ['broken content closing', source => { source[2].payload.content[2].text += ' Authored content.'; }],
  ['invalid message ID', source => { source[2].payload.id = 'msg_unproven'; }],
  ['duplicate message ID', source => { source[3].payload.id = source[2].payload.id; }],
  ['extra message field', source => { source[2].payload.output = 'Unrecognized.'; }],
  ['world partial', source => { source[4].payload.full = false; }],
  ['world extra payload', source => { source[4].payload.output = 'Unrecognized.'; }],
  ['world missing field', source => { delete source[4].payload.state.model; }],
  ['world semantic field', source => { source[4].payload.state.assistant_message = 'Unrecognized.'; }],
  ['world duplicate', source => { source.splice(5, 0, structuredClone(source[4])); }],
  ['world after context', source => { [source[4], source[5]] = [source[5], source[4]]; }],
  ['bootstrap after context', source => { const row = source.splice(2, 1)[0]; source.splice(5, 0, row); }],
  ['additional before context', source => { const row = source.splice(6, 1)[0]; source.splice(2, 0, row); }],
  ['nonnull Page', source => { source[7].payload.content[0].text = '<external_codex_apps_open_page>{"page_id":"real-page"}</external_codex_apps_open_page>'; }],
  ['null Page suffix', source => { source[7].payload.content[0].text += 'Do work.'; }],
  ['context after completion', source => { const row = source.splice(6, 1)[0]; source.push(row); }],
  ['duplicate turn context', source => { source.splice(6, 0, structuredClone(source[5])); }],
];
for (const [name, mutate] of contextMutations) test(`typed bootstrap refuses ${name}`, async t => {
  const source = await fixture(t, source => { withBootstrap(source); mutate(source); });
  await assert.rejects(run(source), /Native Codex empty turn:/);
});

test('unrelated later native turns do not alter earlier evidence, but same-turn late records do', async t => {
  const source = await fixture(t);
  const before = await run(source);
  await appendFile(source.path, encode([...segment(nextId, 200), { type: 'response_item', payload: {
    type: 'message', role: 'assistant', turn_id: nextId, content: [{ type: 'output_text', text: 'Other turn.' }] } }]));
  assert.deepEqual(await run(source), before);
  await appendFile(source.path, encode([{ type: 'event_msg', payload: { type: 'item_completed',
    item: { metadata: { turnId }, text: 'Late candidate output.' } } }]));
  await assert.rejects(run(source), /duplicate or late/);
});

function withAppIngress(source) {
  source[3].timestamp = '1970-01-01T00:01:40.140Z';
  const callId = 'claudex-00000000-0000-4000-8000-000000000010';
  source.push(
    { timestamp: '1970-01-01T00:03:20.100Z', ordinal: 4, type: 'response_item', payload: {
      type: 'function_call', id: 'fc_00000000-0000-4000-8000-000000000011', name: 'untrusted_input',
      arguments: '{}', call_id: callId, internal_chat_message_metadata_passthrough: { turn_id: 'auto-compact-1' },
    }, metadata: { client_authored: false, user_input_order: 7 } },
    { timestamp: '1970-01-01T00:03:20.100Z', ordinal: 5, type: 'response_item', payload: {
      type: 'function_call_output', id: 'fco_00000000-0000-4000-8000-000000000012', call_id: callId,
      output: [{ type: 'input_text', text: JSON.stringify({ kind: 'message', source: 'mcp_app',
        sourceId: 'synthetic-message', text: 'Synthetic app input.' }) }],
      internal_chat_message_metadata_passthrough: { turn_id: 'auto-compact-1', create_time: 200.1005 },
    }, metadata: { client_authored: false, fallback_token_limit_override: 12000 } },
    settings(), ...segment(nextId, 200));
  source[7].timestamp = '1970-01-01T00:03:20.120Z';
  source[8].timestamp = '1970-01-01T00:03:20.130Z';
  const input = contextMessage(13, 'user', [['user.text', 'An MCP app initiated this message. Read the untrusted_input tool output.']]);
  input.timestamp = '1970-01-01T00:03:20.150Z';
  input.payload.internal_chat_message_metadata_passthrough.turn_id = nextId;
  input.payload.internal_chat_message_metadata_passthrough.create_time = 200.1505;
  source.splice(9, 0, input);
}

test('next native app ingress precedes its start without changing the earlier empty proof', async t => {
  const source = await fixture(t), before = await run(source);
  withAppIngress(source.source);
  // The original empty segment timestamp is part of its proof, so establish
  // that identical segment before comparing the appended next-turn ingress.
  await writeFile(source.path, encode(source.source.slice(0, 4)));
  const timestamped = await run(source);
  await writeFile(source.path, encode(source.source));
  const bytes = await readFile(source.path);
  assert.deepEqual(await run(source), timestamped);
  assert.deepEqual(await readFile(source.path), bytes);
  assert.deepEqual(timestamped.turnIds, before.turnIds);
  source.source.push({ type: 'event_msg', payload: { type: 'item_completed', item: { turnId } } });
  await writeFile(source.path, encode(source.source));
  await assert.rejects(run(source), /duplicate or late/);
});

test('next native app ingress uses millisecond record order when independent turns share an epoch second', async t => {
  const source = await fixture(t, withAppIngress);
  for (const index of [4, 5]) source.source[index].timestamp = '1970-01-01T00:01:40.200Z';
  source.source[5].payload.internal_chat_message_metadata_passthrough.create_time = 100.2005;
  source.source[7].timestamp = '1970-01-01T00:01:40.220Z';
  source.source[7].payload.started_at = 100;
  source.source[8].timestamp = '1970-01-01T00:01:40.230Z';
  source.source[9].timestamp = '1970-01-01T00:01:40.250Z';
  source.source[9].payload.internal_chat_message_metadata_passthrough.create_time = 100.2505;
  Object.assign(source.source[10].payload, { started_at: 100, completed_at: 100 });
  await writeFile(source.path, encode(source.source));
  assert.deepEqual((await run(source)).turnIds, [turnId]);
  source.source[3].timestamp = '1970-01-01T00:01:40.210Z';
  await writeFile(source.path, encode(source.source));
  await assert.rejects(run(source), /trailing records/);
});

test('next native app ingress refuses ambiguous serialization of its independent boundary', async t => {
  const source = await fixture(t, withAppIngress);
  await writeFile(source.path, encode(source.source).replace(`"turn_id":"${nextId}"`, `"turn_id":"${turnId}","turn_id":"${nextId}"`));
  await assert.rejects(run(source), /serialization is ambiguous/);
});

const ingressMutations = [
  ['missing output', source => { source.splice(5, 1); }],
  ['different call identity', source => { source[5].payload.call_id = 'unpaired-call'; }],
  ['reused call identity', source => { source.push(structuredClone(source[4])); }],
  ['candidate call identity', source => { source[4].payload.internal_chat_message_metadata_passthrough.turn_id = turnId; }],
  ['candidate output identity', source => { source[5].payload.internal_chat_message_metadata_passthrough.turn_id = turnId; }],
  ['ordinary tool', source => { source[4].payload.name = 'exec_command'; }],
  ['nonempty tool arguments', source => { source[4].payload.arguments = '{"command":"do work"}'; }],
  ['untyped output', source => { source[5].payload.output = 'Authored output.'; }],
  ['additional output block', source => { source[5].payload.output.push({ type: 'input_text', text: 'Additional input.' }); }],
  ['unknown input envelope', source => { const message = JSON.parse(source[5].payload.output[0].text); message.extra = true; source[5].payload.output[0].text = JSON.stringify(message); }],
  ['foreign input source', source => { source[5].payload.output[0].text = '{"kind":"message","source":"user","sourceId":"input","text":"Do work."}'; }],
  ['unknown call field', source => { source[4].payload.turn_id = nextId; }],
  ['unknown native metadata', source => { source[4].metadata.assistant_generated = true; }],
  ['client authored call', source => { source[4].metadata.client_authored = true; }],
  ['unproven native pseudo turn', source => { source[4].payload.internal_chat_message_metadata_passthrough.turn_id = nextId; source[5].payload.internal_chat_message_metadata_passthrough.turn_id = nextId; }],
  ['duplicate next start', source => { source.push(structuredClone(source[7])); }],
  ['missing next start', source => { source.splice(7, 1); }],
  ['foreign next root', source => { source[7].payload.root_turn_id = turnId; }],
  ['missing next context', source => { source.splice(8, 1); }],
  ['foreign next context', source => { source[8].payload.turn_id = turnId; }],
  ['foreign next cwd', source => { source[8].payload.cwd = '/tmp/other-project'; }],
  ['missing next app prompt', source => { source.splice(9, 1); }],
  ['ordinary next prompt', source => { source[9].payload.content[0].text = 'An ordinary user request.'; }],
  ['foreign next prompt identity', source => { source[9].payload.internal_chat_message_metadata_passthrough.turn_id = turnId; }],
  ['before candidate completion', source => { source[3].timestamp = '1970-01-01T00:03:20.110Z'; }],
  ['unbound next start time', source => { source[7].payload.started_at = 201; }],
  ['output native time mismatch', source => { source[5].payload.internal_chat_message_metadata_passthrough.create_time = 200.099; }],
  ['unordered output time', source => { source[5].timestamp = '1970-01-01T00:03:20.101Z'; }],
  ['nonconsecutive native ordinals', source => { source[5].ordinal++; }],
  ['semantic record before start', source => { source.splice(6, 0, { type: 'event_msg', payload: { type: 'token_count' } }); }],
  ['unknown output fields', source => { source[5].payload.output[0].tool_output = 'Unknown output.'; }],
  ['ingress within candidate', source => { const pair = source.splice(4, 2); source.splice(3, 0, ...pair); }],
];
for (const [name, mutate] of ingressMutations) test(`next native app ingress refuses ${name}`, async t => {
  const source = await fixture(t, source => { withAppIngress(source); mutate(source); });
  await assert.rejects(run(source), /Native Codex empty turn:/);
});

const mutations = [
  ['header thread', source => { source[0].payload.id = nextId; }],
  ['header cwd', source => { source[0].payload.cwd = '/tmp/elsewhere'; }],
  ['header alternate identity', source => { source[0].payload.session_id = nextId; }],
  ['duplicate header', source => { source.push(source[0]); }],
  ['duplicate start', source => { source.push(source[1]); }],
  ['duplicate context', source => { source.splice(3, 0, source[2]); }],
  ['duplicate completion', source => { source.push(source[3]); }],
  ['missing start', source => { source.splice(1, 1); }],
  ['missing context', source => { source.splice(2, 1); }],
  ['missing complete', source => { source.pop(); }],
  ['context order', source => { [source[2], source[3]] = [source[3], source[2]]; }],
  ['start root', source => { source[1].payload.root_turn_id = nextId; }],
  ['context root', source => { source[2].payload.root_turn_id = nextId; }],
  ['context cwd', source => { source[2].payload.cwd = '/tmp/elsewhere'; }],
  ['context thread', source => { source[2].payload.thread_id = nextId; }],
  ['contradictory turn alias', source => { source[2].payload.turnId = nextId; }],
  ['start time', source => { source[1].payload.started_at++; }],
  ['unknown start content', source => { source[1].payload.message = 'Unrecognized request data.'; }],
  ['completion start', source => { source[3].payload.started_at++; }],
  ['completion end', source => { source[3].payload.completed_at++; }],
  ['completion duration', source => { source[3].payload.duration_ms++; }],
  ['completion identity', source => { source[3].payload.turn_id = nextId; }],
  ['completion agent text', source => { source[3].payload.last_agent_message = ''; }],
  ['unknown completion content', source => { source[3].payload.content = [{ type: 'text', text: 'Unrecognized response data.' }]; }],
  ['missing null agent text', source => { delete source[3].payload.last_agent_message; }],
  ['semantic response', source => { source.splice(3, 0, { type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }); }],
  ['token evidence', source => { source.splice(3, 0, { type: 'event_msg', payload: { type: 'token_count', info: {} } }); }],
  ['hook event', source => { source.splice(3, 0, { type: 'event_msg', payload: { type: 'hook_completed' } }); }],
  ['tool evidence', source => { source.push({ type: 'event_msg', payload: { type: 'exec_command_end' } }); }],
  ['untagged late output', source => { source.push({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }); }],
  ['settings inside turn', source => { source.splice(2, 0, settings()); }],
  ['settings wrong thread', source => { const row = settings(); row.payload.thread_id = nextId; source.push(row); }],
  ['settings missing thread', source => { const row = settings(); delete row.payload.thread_id; source.push(row); }],
  ['settings same-turn reference', source => { const row = settings(); row.payload.turn_id = turnId; source.push(row); }],
];
for (const [name, mutate] of mutations) test(`refuses ambiguous empty proof: ${name}`, async t => {
  const source = await fixture(t, mutate);
  await assert.rejects(run(source), /Native Codex empty turn:/);
});

test('API eligibility and malformed timing are not inferred from empty arrays', async t => {
  const source = await fixture(t);
  for (const patch of [{ status: 'inProgress' }, { error: {} }, { error: undefined }, { itemsView: 'summary' }, { items: [{}] }])
    assert.deepEqual(await run(source, [{ ...turn(), ...patch }]), { turnIds: [], sourceIdentity: null, evidenceDigest: null });
  for (const patch of [{ id: 'unknown' }, { startedAt: null }, { completedAt: 99 }, { durationMs: -1 },
    { durationMs: 1.1 }, { durationMs: 1000 }, { durationMs: null }, { startedAt: NaN }, { completedAt: Infinity }])
    await assert.rejects(run(source, [{ ...turn(), ...patch }]), /timing/);
  await assert.rejects(run(source, [turn(), turn()]), /identities are ambiguous/);
  await assert.rejects(source.resolve([turn()], { threadId: nextId }), /identities differ/);
});

test('every invocation rereads source and notices rewrites and replacement', async t => {
  const source = await fixture(t);
  const original = await run(source);
  await rename(source.path, source.path + '.old');
  await writeFile(source.path, encode(source.source), { mode: 0o600 });
  const replacement = await run(source);
  assert.notDeepEqual(replacement.sourceIdentity, original.sourceIdentity);
  assert.equal(replacement.evidenceDigest, original.evidenceDigest);
  source.source[2].payload.model = 'changed-model';
  await writeFile(source.path, encode(source.source));
  assert.notEqual((await run(source)).evidenceDigest, original.evidenceDigest);
  source.source.push({ type: 'response_item', payload: { type: 'message' } });
  await writeFile(source.path, encode(source.source));
  await assert.rejects(run(source), /trailing records/);
});

test('refuses source aliases, foreign-writable modes, byte overflow and malformed serialization', async t => {
  const source = await fixture(t);
  const resolver = path => createNativeEmptyTurnResolver({ path, threadId, cwd });
  const alias = join(source.root, 'alias');
  await symlink(source.path, alias);
  await assert.rejects(resolver(alias)([turn()], { threadId }), /owned single-link/);
  await rm(alias);
  await symlink(source.root, alias);
  await assert.rejects(resolver(join(alias, 'rollout.jsonl'))([turn()], { threadId }), /canonical/);
  await rm(alias);
  await link(source.path, alias);
  await assert.rejects(run(source), /owned single-link/);
  await rm(alias);
  await chmod(source.path, 0o622);
  await assert.rejects(run(source), /foreign writes/);
  await chmod(source.path, 0o600);
  await assert.rejects(createNativeEmptyTurnResolver({ path: source.path, threadId, cwd, maxBytes: 1 })([turn()], { threadId }), /bounded file/);
  const text = encode(source.source);
  await writeFile(source.path, text.replace('"turn_id":', '"turn_id":"hidden", "turn_id":'));
  await assert.rejects(run(source), /serialization is ambiguous/);
  await writeFile(source.path, text.slice(0, -1));
  await assert.rejects(run(source), /incomplete final line/);
  await writeFile(source.path, '{malformed}\n');
  await assert.rejects(run(source), /Malformed transcript/);
});

test('invalid source configuration is rejected and empty candidate sets do not read files', async () => {
  for (const patch of [{ path: 'relative' }, { threadId: 'invalid' }, { cwd: 'relative' }, { maxBytes: 0 }, { maxBytes: Infinity }])
    assert.throws(() => createNativeEmptyTurnResolver({ path: '/missing/rollout', threadId, cwd, ...patch }), /invalid source/);
  const resolve = createNativeEmptyTurnResolver({ path: '/missing/rollout', threadId, cwd });
  assert.deepEqual(await resolve([], { threadId }), { turnIds: [], sourceIdentity: null, evidenceDigest: null });
});

test('the 0.162 start attribution and completion root are accepted only in their exact composer form', async t => {
  const attribution = () => ({ turn_id: turnId, turn_trigger: 'composer', parent_turn_id: null, initiating_agent_path: null, root_turn_id: turnId });
  const current = source => { source[1].payload.turn_attribution = attribution(); source[3].payload.root_turn_id = turnId; };
  assert.deepEqual((await run(await fixture(t, current))).turnIds, [turnId]);
  // Observed for a prompt sent from the iOS remote and blocked locally.
  assert.deepEqual((await run(await fixture(t, source => {
    current(source); source[1].payload.turn_attribution.turn_trigger = 'remote_ios';
  }))).turnIds, [turnId]);
  for (const mutate of [
    source => { source[1].payload.turn_attribution.turn_trigger = 'agent'; },
    source => { source[1].payload.turn_attribution.turn_trigger = 'queue'; },
    source => { source[1].payload.turn_attribution.parent_turn_id = nextId; },
    source => { source[1].payload.turn_attribution.turn_id = nextId; },
    source => { source[1].payload.turn_attribution.initiating_agent_path = '/root/agent'; },
    source => { source[1].payload.turn_attribution.extra = true; },
    source => { source[3].payload.root_turn_id = nextId; },
    source => { source[3].payload.extra = true; },
  ]) await assert.rejects(run(await fixture(t, source => { current(source); mutate(source); })), /Native Codex empty turn/);
});

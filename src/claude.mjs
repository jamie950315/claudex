import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, lstat } from 'node:fs/promises';
import { fromCommon, toCommon } from 'txcript';
import { hash, snapshot, publishExclusive } from './storage.mjs';
import { portableMessages } from './history.mjs';
import { claudeCompaction, claudeCompactionHistory, withoutRepersistedRows } from './compaction.mjs';
import { parallelToolGraphParents } from './claude-parallel-tools.mjs';

export function projectDirectory(claudeHome, cwd) {
  return join(claudeHome, 'projects', resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

export function sessionPath(claudeHome, cwd, id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid Claude session identifier.');
  return join(projectDirectory(claudeHome, cwd), `${id}.jsonl`);
}

export function encodeClaude(common, id, parentUuid = null) {
  const normalized = {
    ...common,
    meta: { ...common.meta, id },
    messages: portableMessages(common.messages).map(message => ({ ...message, timestamp: message.timestamp ?? common.meta.timestamp })),
  };
  const rows = fromCommon(JSON.stringify(normalized), 'claude_code').trim().split('\n').filter(Boolean).map(JSON.parse);
  // A fresh identifier for each appended record avoids codec-generated collisions
  // when a new batch starts at canonical message zero.
  let parent = parentUuid;
  const ids = new Map(rows.filter(row => row.uuid).map(row => [row.uuid, randomUUID()]));
  for (const row of rows) {
    if (row.leafUuid) row.leafUuid = ids.get(row.leafUuid) ?? row.leafUuid;
    if (!row.uuid) continue;
    row.uuid = ids.get(row.uuid);
    row.parentUuid = parent;
    row.sessionId = id;
    row.isSidechain = false;
    row.userType = 'external';
    row.version = '2.1.210';
    if (row.type === 'assistant') {
      row.message.id ??= `msg_${randomUUID().replaceAll('-', '')}`;
      // Cross-provider source model names are not valid Claude launch settings.
      // Attribution stays in the bridge's canonical history, not this setting.
      delete row.message.model;
      row.message.type ??= 'message';
      row.message.stop_reason ??= row.message.content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
      row.message.stop_sequence ??= null;
      row.message.usage ??= { input_tokens: 0, output_tokens: 0 };
    }
    parent = row.uuid;
  }
  return { rows, text: rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '') };
}

export async function createClaudeSession({ claudeHome, common, id = randomUUID(), title, owner }) {
  const path = sessionPath(claudeHome, common.meta.cwd, id);
  await mkdir(projectDirectory(claudeHome, common.meta.cwd), { recursive: true, mode: 0o700 });
  const encoded = encodeClaude(common, id);
  const titleRow = { type: 'custom-title', customTitle: title || 'Claudex conversation', sessionId: id };
  const text = encoded.text + JSON.stringify(titleRow) + '\n' + (owner ? JSON.stringify({ type: 'claudex-owner', sessionId: id, owner }) + '\n' : '');
  await publishExclusive(path, text);
  return { id, path, hash: hash(text), lastUuid: encoded.rows.at(-1)?.uuid ?? null };
}

export async function appendClaudeSession({ path, common, id, expectedHash }) {
  const source = await snapshot(path);
  if (source.hash !== expectedHash) throw new Error('Claude transcript diverged; refusing to overwrite it.');
  const lastUuid = source.rows.filter(row => row.uuid && !row.isSidechain).at(-1)?.uuid ?? null;
  const batch = encodeClaude(common, id, lastUuid);
  // The coordinator must hold the ownership lease before calling this adapter.
  // Append-only writes preserve every byte of the original transcript.
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (!current.isFile() || !named.isFile() || named.isSymbolicLink()
        || Object.entries(source.fileIdentity).some(([key, value]) => String(current[key]) !== value || String(named[key]) !== value))
      throw new Error('Claude transcript changed before append.');
    await file.writeFile(batch.text); await file.sync();
  } finally { await file.close(); }
  return { hash: hash(source.text + batch.text), lastUuid: batch.rows.at(-1)?.uuid ?? lastUuid };
}

function preserveUnpairedLocalCommands(common, rows) {
  // txcript represents native slash-command UI records as Command tool calls.
  // Local UI and skill commands can omit stdout. Keep those invocation records
  // as inert text, not an unfinished model call or a fake result.
  // Paired commands retain their historical codec representation and digest.
  const results = new Set();
  const calls = new Map();
  for (const message of common.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') results.add(block.tool_use_id ?? block.id);
      if (block.type === 'tool_use') calls.set(block.id, (calls.get(block.id) ?? 0) + 1);
    }
  }
  const identities = new Map();
  for (const row of rows) if (row.uuid) identities.set(row.uuid, (identities.get(row.uuid) ?? 0) + 1);
  const commands = new Map();
  for (const row of rows) {
    if (row.type !== 'user' || row.message?.role !== 'user'
        || typeof row.message.content !== 'string' || !row.uuid || identities.get(row.uuid) !== 1) continue;
    // Native UI commands put the name first; skill invocations may put the
    // message first. Both envelopes retain their exact original bytes.
    const match = /^<command-name>(\/[^\s<>]+)<\/command-name>\r?\n[\t ]*<command-message>[^<>]*<\/command-message>(?:\r?\n[\t ]*<command-args>[\s\S]*<\/command-args>)?$/.exec(row.message.content)
      ?? /^<command-message>[^<>]*<\/command-message>\r?\n[\t ]*<command-name>(\/[^\s<>]+)<\/command-name>(?:\r?\n[\t ]*<command-args>[\s\S]*<\/command-args>)?$/.exec(row.message.content);
    if (match) commands.set(row.uuid, { name: match[1], text: row.message.content });
  }
  for (const message of common.messages) {
    if (message.role !== 'user' || message.content.length !== 1) continue;
    const block = message.content[0], command = commands.get(block.id);
    if (block.type !== 'tool_use' || block.tool?.name !== 'Command'
        || !command || block.tool.command !== command.name || calls.get(block.id) !== 1 || results.has(block.id)) continue;
    message.content = [{ type: 'text', text: `[Native local command]\n${command.text}` }];
  }
}

// The native CLI can persist a tool result one row before the assistant row
// that issued the call (observed 11 ms apart with a coherent parent chain).
// Decode such a result directly after its exact parent call. Every other row
// keeps its physical position, so existing digests are unchanged.
function resultsAfterTheirCalls(rows) {
  const index = new Map(rows.map((row, position) => [row.uuid, position]));
  const late = new Map();
  rows.forEach((row, position) => {
    const call = rows[index.get(row.parentUuid)], content = row.message?.content;
    if (row.type !== 'user' || !row.uuid || !Array.isArray(content) || call?.type !== 'assistant' || index.get(call.uuid) < position
        || row.sourceToolAssistantUUID !== call.uuid || !Array.isArray(call.message?.content)) return;
    const calls = new Set(call.message.content.filter(block => block.type === 'tool_use').map(block => block.id));
    const results = content.filter(block => block.type === 'tool_result');
    if (!results.length || !results.every(block => calls.has(block.tool_use_id))) return;
    late.set(call.uuid, [...late.get(call.uuid) ?? [], row]);
  });
  if (!late.size) return rows;
  const moved = new Set([...late.values()].flat());
  return rows.flatMap(row => moved.has(row) ? [] : [row, ...late.get(row.uuid) ?? []]);
}

// Native keeps every branch in the file. The conversation is the branch that
// ends at the last authored row. Where it forks:
// - the active child is a real user prompt: a rewind (or an edited prompt).
//   Every sibling branch was replaced and is left out;
// - otherwise a sibling that is a tool result, or another block of a response
//   on the active branch, belongs to the same wave of work and is kept at its
//   physical position; any other sibling (another reply to the same input, an
//   abandoned prompt) was replaced and is left out.
// By user decision no fork shape is refused for being unfamiliar: nothing that
// belongs to the active conversation is dropped, and a replaced branch that
// held already synchronized turns still fails the saved prefix check.
function withoutReplacedBranches(rows, parallelParents, children) {
  const authored = row => row.type === 'user' || row.type === 'assistant';
  const byId = new Map(rows.filter(row => row.uuid).map(row => [row.uuid, row]));
  const parentOf = row => authored(row) ? parallelParents.get(row.uuid) ?? row.parentUuid : row.parentUuid;
  const parents = new Set(rows.filter(row => row.uuid).map(parentOf).filter(Boolean));
  const leaf = rows.findLast(row => authored(row) && row.uuid && !parents.has(row.uuid));
  if (!leaf) return rows;
  const ancestors = start => {
    const chain = new Set();
    for (let row = start; row && !chain.has(row.uuid); row = byId.get(parentOf(row))) chain.add(row.uuid);
    return chain;
  };
  const active = ancestors(leaf), replaced = new Set();
  const prompt = row => row.type === 'user' && !row.isMeta && (typeof row.message?.content === 'string'
    || Array.isArray(row.message?.content) && row.message.content.length > 0 && row.message.content.every(block => block.type !== 'tool_result'));
  const response = row => row.type === 'assistant' ? row.message?.id ?? row.requestId ?? null : null;
  const activeResponses = new Set([...active].map(uuid => response(byId.get(uuid))).filter(Boolean));
  const sameWave = row => row.type === 'user' ? !prompt(row) : activeResponses.has(response(row));
  for (const siblings of children.values()) {
    if (siblings.size < 2) continue;
    const kept = [...siblings].filter(uuid => active.has(uuid));
    const rewound = kept.length === 1 && prompt(byId.get(kept[0]));
    for (const uuid of siblings) if (!active.has(uuid) && (rewound || !sameWave(byId.get(uuid)))) replaced.add(uuid);
  }
  if (!replaced.size) return rows;
  return rows.filter(row => !authored(row) || !row.uuid || active.has(row.uuid)
    || ![...ancestors(row)].some(uuid => replaced.has(uuid)));
}

export function decodeClaude(text, { preserveCompactionHistory = false, authenticatePreservedPacket } = {}) {
  const parsed = text.split('\n').filter(Boolean).map(JSON.parse);
  const rows = typeof authenticatePreservedPacket === 'function' ? parsed : withoutRepersistedRows(parsed);
  const compact = preserveCompactionHistory ? claudeCompactionHistory(text, rows, authenticatePreservedPacket) : claudeCompaction(text, rows);
  const main = (compact?.rows ?? rows).filter(row => !row.isSidechain);
  const ids = new Set(main.filter(row => row.uuid).map(row => row.uuid));
  const parallelParents = parallelToolGraphParents(main);
  const children = new Map();
  let forked = false;
  for (const row of main.filter(row => row.type === 'user' || row.type === 'assistant')) {
    if (row.parentUuid && !ids.has(row.parentUuid)) throw new Error('Dependent Claude history is missing its parent; automatic handoff paused.');
    const parentUuid = parallelParents.get(row.uuid) ?? row.parentUuid;
    if (parentUuid) {
      const siblings = children.get(parentUuid) ?? new Set();
      siblings.add(row.uuid);
      if (siblings.size > 1) forked = true;
      children.set(parentUuid, siblings);
    }
  }
  const current = forked ? withoutReplacedBranches(main, parallelParents, children) : main;
  const common = JSON.parse(toCommon(resultsAfterTheirCalls(current).map(row => JSON.stringify(row)).join('\n'), 'claude_code'));
  preserveUnpairedLocalCommands(common, main);
  if (compact) common.meta.compaction = compact.metadata;
  return common;
}

export async function claudeExists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

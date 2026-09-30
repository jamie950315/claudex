import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, lstat } from 'node:fs/promises';
import { fromCommon, toCommon } from 'txcript';
import { hash, snapshot, publishExclusive } from './storage.mjs';
import { portableMessages } from './history.mjs';
import { claudeCompaction, claudeCompactionHistory } from './compaction.mjs';
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

export function decodeClaude(text, { preserveCompactionHistory = false, authenticatePreservedPacket } = {}) {
  const rows = text.split('\n').filter(Boolean).map(JSON.parse);
  const compact = preserveCompactionHistory ? claudeCompactionHistory(text, rows, authenticatePreservedPacket) : claudeCompaction(text, rows);
  const main = (compact?.rows ?? rows).filter(row => !row.isSidechain);
  const ids = new Set(main.filter(row => row.uuid).map(row => row.uuid));
  const parallelParents = parallelToolGraphParents(main);
  const children = new Map();
  for (const row of main.filter(row => row.type === 'user' || row.type === 'assistant')) {
    if (row.parentUuid && !ids.has(row.parentUuid)) throw new Error('Dependent Claude history is missing its parent; automatic handoff paused.');
    const parentUuid = parallelParents.get(row.uuid) ?? row.parentUuid;
    if (parentUuid) {
      const siblings = children.get(parentUuid) ?? new Set();
      siblings.add(row.uuid);
      if (siblings.size > 1) throw new Error('Nonlinear Claude history requires an explicit branch selection.');
      children.set(parentUuid, siblings);
    }
  }
  const common = JSON.parse(toCommon(main.map(row => JSON.stringify(row)).join('\n'), 'claude_code'));
  if (compact) common.meta.compaction = compact.metadata;
  return common;
}

export async function claudeExists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open } from 'node:fs/promises';
import { fromCommon, toCommon } from 'txcript';
import { hash, snapshot } from './storage.mjs';

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
    messages: common.messages.map(message => ({ ...message, timestamp: message.timestamp ?? common.meta.timestamp })),
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

export async function createClaudeSession({ claudeHome, common, id = randomUUID(), title }) {
  const path = sessionPath(claudeHome, common.meta.cwd, id);
  await mkdir(projectDirectory(claudeHome, common.meta.cwd), { recursive: true, mode: 0o700 });
  const encoded = encodeClaude(common, id);
  const titleRow = { type: 'custom-title', customTitle: title || 'Claudex conversation', sessionId: id };
  const text = encoded.text + JSON.stringify(titleRow) + '\n';
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  return { id, path, hash: hash(text), lastUuid: encoded.rows.at(-1)?.uuid ?? null };
}

export async function appendClaudeSession({ path, common, id, expectedHash }) {
  const source = await snapshot(path);
  if (source.hash !== expectedHash) throw new Error('Claude transcript diverged; refusing to overwrite it.');
  const lastUuid = source.rows.filter(row => row.uuid && !row.isSidechain).at(-1)?.uuid ?? null;
  const batch = encodeClaude(common, id, lastUuid);
  // The coordinator must hold the ownership lease before calling this adapter.
  // Append-only writes preserve every byte of the original transcript.
  const file = await open(path, 'a', 0o600);
  try {
    const current = await file.stat();
    if (current.size !== source.bytes || current.mtimeMs !== source.mtimeMs) throw new Error('Claude transcript changed before append.');
    await file.writeFile(batch.text); await file.sync();
  } finally { await file.close(); }
  return { hash: hash(source.text + batch.text), lastUuid: batch.rows.at(-1)?.uuid ?? lastUuid };
}

export function decodeClaude(text) {
  const rows = text.split('\n').filter(Boolean).map(JSON.parse);
  const compact = rows.some(row => row.type === 'system' && row.subtype === 'compact_boundary');
  if (compact) throw new Error('Claude compaction requires a new explicit handoff; automatic replay is paused.');
  const main = rows.filter(row => !row.isSidechain);
  return JSON.parse(toCommon(main.map(row => JSON.stringify(row)).join('\n'), 'claude_code'));
}

export async function claudeExists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

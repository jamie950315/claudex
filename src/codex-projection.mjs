import { mkdir } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import { fromCommon } from 'txcript';
import { publishExclusive } from './storage.mjs';
import { portableMessages } from './history.mjs';

// Pinned native rollout contract verified with 0.155.0-alpha.16.3.
export function encodeCodexProjection(common, id) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid Codex projection identifier');
  if (!isAbsolute(common.meta.cwd)) throw new Error('Codex project path must be absolute');
  if (!common.messages.length || common.messages[0].role !== 'user' || common.messages.at(-1).role !== 'assistant') throw new Error('Codex projection requires complete user/assistant turns');
  const normalized = { ...common, meta: { ...common.meta, id }, messages: portableMessages(common.messages).map(message => ({ ...message, timestamp: message.timestamp ?? common.meta.timestamp })) };
  const native = fromCommon(JSON.stringify(normalized), 'codex').trim().split('\n').filter(Boolean).map(JSON.parse);
  const rows = [];
  let turn = null;
  let index = 0;
  const event = (timestamp, payload) => ({ timestamp, type: 'event_msg', payload });
  const finish = timestamp => { if (turn) rows.push(event(timestamp, { type: 'task_complete', turn_id: turn, last_agent_message: null })); };
  for (const row of native) {
    // txcript emits an incomplete turn_context that native readers reject.
    // Imported history does not require historical execution settings.
    if (row.type === 'turn_context') continue;
    if (row.type === 'session_meta') Object.assign(row.payload, { originator: 'claudex', cli_version: '0.155.0-alpha.16.3', history_mode: 'legacy' });
    if (row.type === 'response_item' && row.payload.type === 'message' && row.payload.role === 'user') {
      finish(row.timestamp);
      turn = `claudex-${id}-${++index}`;
      rows.push(event(row.timestamp, { type: 'task_started', turn_id: turn, model_context_window: null, collaboration_mode_kind: 'default' }));
    }
    rows.push(row);
  }
  finish(rows.at(-1)?.timestamp ?? common.meta.timestamp);
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

export async function createCodexProjection({ client, codexHome, common, id, title }) {
  const text = encodeCodexProjection(common, id);
  const path = codexProjectionPath(codexHome, common, id);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await publishExclusive(path, text);
  return registerCodexProjection({ client, path, id, cwd: common.meta.cwd, title });
}

export function codexProjectionPath(codexHome, common, id) {
  if (!isAbsolute(codexHome)) throw new Error('Codex home must be absolute');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid Codex projection identifier');
  const stamp = new Date(common.meta.timestamp).toISOString();
  const directory = join(codexHome, 'sessions', ...stamp.slice(0, 10).split('-'));
  return join(directory, `rollout-${stamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
}

export async function registerCodexProjection({ client, path, id, cwd, title }) {
  const result = await client.resumeThread(id, { path, cwd });
  if (result.thread?.id !== id) throw new Error('Codex resumed an unexpected projection identity');
  if (title) await client.request('thread/name/set', { threadId: id, name: title });
  return { id, path };
}

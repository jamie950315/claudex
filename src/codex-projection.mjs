import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, isAbsolute, dirname } from 'node:path';
import { fromCommon } from 'txcript';
import { publishExclusive } from './storage.mjs';
import { portableMessages } from './history.mjs';

// Pinned native rollout contract verified with 0.155.0-alpha.16.3.
export function encodeCodexProjection(common, id, { historyMode = 'legacy' } = {}) {
  if (!['legacy', 'paginated'].includes(historyMode)) throw new Error('Unsupported Codex projection history mode');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid Codex projection identifier');
  if (!isAbsolute(common.meta.cwd)) throw new Error('Codex project path must be absolute');
  if (!common.messages.length || common.messages[0].role !== 'user' || common.messages.at(-1).role !== 'assistant') throw new Error('Codex projection requires complete user/assistant turns');
  const normalized = { ...common, meta: { ...common.meta, id }, messages: portableMessages(common.messages).map(message => ({ ...message, timestamp: message.timestamp ?? common.meta.timestamp })) };
  if (historyMode === 'paginated') validatePaginatedMessages(normalized.messages);
  const native = fromCommon(JSON.stringify(normalized), 'codex').trim().split('\n').filter(Boolean).map(JSON.parse);
  const rows = [];
  let turn = null;
  let index = 0;
  let displayIndex = 0;
  const event = (timestamp, payload) => ({ timestamp, type: 'event_msg', payload });
  const finish = timestamp => { if (turn) rows.push(event(timestamp, { type: 'task_complete', turn_id: turn, last_agent_message: null })); };
  for (const row of native) {
    // txcript emits an incomplete turn_context that native readers reject.
    // Imported history does not require historical execution settings.
    if (row.type === 'turn_context') continue;
    if (row.type === 'session_meta') Object.assign(row.payload, { originator: 'claudex', cli_version: '0.155.0-alpha.16.3', history_mode: historyMode });
    if (row.type === 'response_item' && row.payload.type === 'message' && row.payload.role === 'user') {
      finish(row.timestamp);
      turn = `claudex-${id}-${++index}`;
      rows.push(event(row.timestamp, { type: 'task_started', turn_id: turn, model_context_window: null, collaboration_mode_kind: 'default' }));
    }
    if (historyMode === 'paginated' && row.type === 'event_msg' && ['user_message', 'agent_message'].includes(row.payload.type)) {
      const message = normalized.messages[displayIndex];
      const role = row.payload.type === 'user_message' ? 'user' : 'assistant';
      if (message?.role !== role || !turn) throw new Error('Codex projection display events do not match source messages');
      const itemId = projectionItemId(id, displayIndex++);
      // Persisted rollout images use image_url. The app-server projects this
      // field to API UserInput.url; using url here silently drops the item.
      const item = role === 'user' ? {
        type: 'UserMessage', id: itemId, client_id: itemId,
        content: message.content.map(block => block.type === 'text'
          ? { type: 'text', text: block.text, text_elements: [] }
          : { type: 'image', image_url: `data:${block.source.media_type};base64,${block.source.data}` }),
      } : {
        type: 'AgentMessage', id: itemId,
        content: message.content.map(block => ({ type: 'Text', text: block.text })),
        phase: 'final_answer',
      };
      rows.push(event(row.timestamp, { type: 'item_completed', thread_id: id, turn_id: turn, item, started_at_ms: Date.parse(row.timestamp), completed_at_ms: Date.parse(row.timestamp) }));
    } else rows.push(row);
  }
  finish(rows.at(-1)?.timestamp ?? common.meta.timestamp);
  if (historyMode === 'paginated' && displayIndex !== normalized.messages.length) throw new Error('Codex projection omitted a display message');
  return rows.map((row, ordinal) => JSON.stringify(historyMode === 'paginated' ? { ...row, ordinal } : row)).join('\n') + '\n';
}

function projectionItemId(threadId, index) {
  const hex = createHash('sha256').update(`claudex-projection:${threadId}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function validatePaginatedMessages(messages) {
  for (const message of messages) {
    if (!['user', 'assistant'].includes(message.role) || !message.content.length) throw new Error('Paginated projection requires nonempty user/assistant messages');
    if (message.role === 'assistant' && (message.content.length !== 1 || message.content[0].type !== 'text')) throw new Error('Paginated projection requires one explicit assistant text block');
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') continue;
      if (message.role === 'user' && block.type === 'image' && block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string' && block.source.data) continue;
      throw new Error('Paginated projection supports text and inline user images only; historical tools must be inert packet text');
    }
  }
}

export async function createCodexProjection({ client, codexHome, common, id, title, historyMode = 'legacy' }) {
  const text = encodeCodexProjection(common, id, { historyMode });
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

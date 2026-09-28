import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { CodexWebSocketClient } from './codex-websocket.mjs';

/** Metadata only. Never resumes a thread or infers ownership from stored status. */
export async function discoverCodexChats({ query, sessionId } = {}, {
  clientFactory = () => new CodexWebSocketClient({
    socketPath: join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock'), timeoutMs: 5000,
  }),
} = {}) {
  const client = clientFactory();
  try {
    await client.initialize();
    const target = sessionId ? (await client.request('thread/read', { threadId: sessionId, includeTurns: false })).thread : null;
    if (sessionId && (target?.id !== sessionId || typeof target.name !== 'string' || !target.name.trim())) return [];
    const result = await client.request('thread/list', { limit: 100, archived: false, useStateDbOnly: true,
      ...((target?.name || query) ? { searchTerm: target?.name || query } : {}) });
    if (result.nextCursor) throw new Error('Native chat discovery is incomplete; narrow the title search before sending.');
    return result.data.filter(t => t && (!sessionId || t.id === sessionId) && typeof t.id === 'string' && typeof t.name === 'string'
      && t.name.trim() && typeof t.cwd === 'string' && isAbsolute(t.cwd) && !t.archived)
      .map(t => ({ provider: 'codex', nativeId: t.id, sessionId: t.id, chatId: `codex:${t.id}`,
        cwd: t.cwd, title: t.name, titleSource: 'codex-native-metadata', phase: 'unregistered',
        registeredByHook: false }));
  } finally { await client.close(); }
}

import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { CodexWebSocketClient } from './codex-websocket.mjs';

/** Select the installed listener before connecting. A configured launcher never
 * falls back to another backend when its shared listener is unavailable. */
export async function codexChatSocket({
  syncRoot = resolve(process.env.CLAUDEX_HOME ?? join(homedir(), '.local', 'share', 'claudex')),
  codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
} = {}) {
  if (![syncRoot, codexHome].every(isAbsolute)) throw new Error('Native chat discovery paths must be absolute.');
  const path = join(syncRoot, 'desktop-launcher.json');
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return join(codexHome, 'app-server-control', 'app-server-control.sock');
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n
        || (before.mode & 0o077n) || before.size > 65536n)
      throw new Error('Native chat launcher configuration is not a bounded private owned file.');
    const data = await handle.readFile('utf8');
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    const same = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].every(key => before[key] === stat[key]);
    if (!same(after) || !same(named)) throw new Error('Native chat launcher configuration changed during inspection.');
    const launcher = JSON.parse(data);
    if (launcher.version !== 1 || launcher.shim !== join(syncRoot, 'codex-launcher')
        || !/^[a-f0-9]{64}$/.test(launcher.shimHash ?? '') || launcher.pendingRuntime)
      throw new Error('Native chat launcher configuration is incomplete or has an invalid identity.');
    return join(syncRoot, 'codex-shared', 'app.sock');
  } finally { await handle.close(); }
}

/** Metadata only. Never resumes a thread or infers ownership from stored status. */
export async function discoverCodexChats({ query, sessionId } = {}, {
  syncRoot, codexHome,
  clientFactory,
} = {}) {
  const client = clientFactory ? clientFactory() : new CodexWebSocketClient({
    socketPath: await codexChatSocket({ syncRoot, codexHome }), timeoutMs: 5000,
  });
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

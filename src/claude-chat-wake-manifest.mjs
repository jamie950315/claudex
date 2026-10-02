import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDesktopSessionMappings } from './desktop.mjs';
import { privateDirectory, writeJSON } from './storage.mjs';

export function createClaudeChatWakeManifest({ root,
  registryRoot = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
  mappings = readDesktopSessionMappings,
}) {
  const descriptor = entry => {
    if (!entry || entry.isArchived) throw new Error('Exact Claude Desktop chat is unavailable or archived.');
    return { localSessionId: entry.sessionId, cwd: entry.cwd, title: entry.title, registryPath: entry.registryPath };
  };
  let publication = Promise.resolve();
  return {
    async verify(sessionId) { return descriptor((await mappings(registryRoot, [sessionId])).get(sessionId)); },
    publish(mailbox) {
      // Read the queue inside the publication chain: a slower metadata lookup
      // must not overwrite a newer send or receipt with its older snapshot.
      const operation = publication.then(async () => {
        const pending = (await mailbox.pendingWakes()).filter(message => !['mod', 'mod-self'].includes(message.wakeRoute));
        const native = await mappings(registryRoot, [...new Set(pending.map(message => message.targetSessionId))]);
        const candidates = pending.filter(message => native.has(message.targetSessionId) && !native.get(message.targetSessionId).isArchived)
          .map(message => ({ messageId: message.messageId, sessionId: message.targetSessionId, expiresAt: message.expiresAt,
            ...descriptor(native.get(message.targetSessionId)) }));
        const messages = []; let size = 64;
        for (const candidate of candidates) {
          const bytes = Buffer.byteLength(JSON.stringify(candidate));
          if (messages.length >= 64 || size + bytes > 240 * 1024) break;
          messages.push(candidate); size += bytes + 1;
        }
        const directory = await privateDirectory(join(root, 'chat-mailbox'));
        await writeJSON(join(directory, 'wake-manifest.json'), { version: 1, messages });
        return { count: messages.length };
      });
      publication = operation.catch(() => {});
      return operation;
    },
  };
}

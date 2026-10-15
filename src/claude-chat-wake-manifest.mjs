import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDesktopSessionMappings } from './desktop.mjs';
import { privateDirectory, writeJSON } from './storage.mjs';

const MAX_MESSAGES = 64;
const MAX_BYTES = 240 * 1024;
const ROTATION_MS = 5000;
const rendererMessage = message => message.targetProvider === 'claude' && message.state === 'queued'
  && message.wakeRequested === true && !['mod', 'mod-self'].includes(message.wakeRoute);
const size = value => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);

export function createClaudeChatWakeManifest({ root,
  registryRoot = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
  mappings = readDesktopSessionMappings, now = Date.now,
}) {
  const descriptor = entry => {
    if (!entry || entry.isArchived) throw new Error('Exact Claude Desktop chat is unavailable or archived.');
    return { localSessionId: entry.sessionId, cwd: entry.cwd, title: entry.title, registryPath: entry.registryPath };
  };
  let publication = Promise.resolve(), nextMessageId, diagnostics = null;
  return {
    async verify(sessionId) { return descriptor((await mappings(registryRoot, [sessionId])).get(sessionId)); },
    diagnostics() { return diagnostics && { ...diagnostics }; },
    publish(mailbox, { beforePublish } = {}) {
      // Read the queue inside the publication chain: a slower metadata lookup
      // must not overwrite a newer send or receipt with its older snapshot.
      const operation = publication.then(async () => {
        const pending = (await mailbox.pendingWakes()).filter(message => !['mod', 'mod-self'].includes(message.wakeRoute));
        const native = await mappings(registryRoot, [...new Set(pending.map(message => message.targetSessionId))]);
        const candidates = pending.filter(message => native.has(message.targetSessionId) && !native.get(message.targetSessionId).isArchived)
          .map(message => ({ messageId: message.messageId, sessionId: message.targetSessionId, expiresAt: message.expiresAt,
            ...descriptor(native.get(message.targetSessionId)) }));
        return mailbox.transaction(true, async state => {
          // Retention, claims and publication share one lock. A metadata read
          // that outlives an ACK must not republish a now-retired recipient.
          const at = now();
          const queued = state.messages.filter(message => rendererMessage(message) && message.expiresAt > at);
          const identities = new Map(queued.map(message => [message.messageId, message]));
          const current = candidates.filter(candidate => {
            const message = identities.get(candidate.messageId);
            return message?.targetSessionId === candidate.sessionId && message.expiresAt === candidate.expiresAt;
          });
          const total = queued.length, eligible = current.length, unavailable = total - eligible;
          const expiresAt = total ? Math.min(...queued.map(message => message.expiresAt)) : null;
          const metadata = count => ({ count, total, eligible, omitted: total - count, unavailable, byteLimit: MAX_BYTES,
            nextPublicationAt: total ? Math.min(expiresAt, total > count ? at + ROTATION_MS : expiresAt) : null });
          const snapshot = messages => ({ version: 1, messages, ...metadata(messages.length) });
          const start = Math.max(0, current.findIndex(candidate => candidate.messageId === nextMessageId));
          const ordered = [...current.slice(start), ...current.slice(0, start)];
          const messages = []; let deferred;
          for (const candidate of ordered) {
            if (messages.length >= MAX_MESSAGES) { deferred ??= candidate.messageId; break; }
            // Account for the actual pretty-serialized file, including metadata.
            // A large first candidate must not hide smaller later recipients.
            if (size(snapshot([...messages, candidate])) <= MAX_BYTES) messages.push(candidate);
            else if (size(snapshot([candidate])) <= MAX_BYTES) deferred ??= candidate.messageId;
          }
          await beforePublish?.();
          const directory = await privateDirectory(join(root, 'chat-mailbox'));
          const value = snapshot(messages);
          await writeJSON(join(directory, 'wake-manifest.json'), value);
          // Resume at the first capacity-omitted candidate, not after a smaller
          // later candidate that fitted. Otherwise large recipients can starve.
          nextMessageId = deferred;
          diagnostics = { ...metadata(messages.length), bytes: size(value) };
          return { ...diagnostics };
        });
      });
      publication = operation.catch(() => {});
      return operation;
    },
  };
}

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { createClaudeSession, sessionPath } from './claude.mjs';
import { encodeArchivedContextPacket } from './context-archive.mjs';
import { fingerprint } from './history.mjs';
import { desktopOwnsSession } from './desktop.mjs';
import { readJSON, writeJSON, withLock } from './storage.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function validateEntry(entry, nativeId, claudeHome) {
  if (!['prepared', 'paired', 'adopted'].includes(entry.phase) || entry.sourceNativeId !== nativeId
      || !UUID.test(entry.conversationId) || !UUID.test(entry.operationId) || !UUID.test(entry.target?.nativeId)
      || !/^[a-f0-9]{64}$/.test(entry.digest ?? '') || !Number.isSafeInteger(entry.count) || entry.count < 1
      || typeof entry.cwd !== 'string' || !entry.cwd
      || entry.target.side !== 'claude' || entry.target.kind !== 'original' || entry.target.managed !== false
      || entry.target.importPacket !== true || entry.target.packetVersion !== 2
      || entry.target.conversationId !== entry.conversationId || entry.target.cwd !== entry.cwd
      || entry.target.path !== sessionPath(claudeHome, entry.cwd, entry.target.nativeId))
    throw new Error('Invalid cold-import journal entry; existing evidence was preserved.');
}
function assertPairedLedger(state, nativeId, entry) {
  const tracked = state.records.find(record => record.side === 'codex' && record.nativeId === nativeId);
  const target = state.records.find(record => record.side === 'claude' && record.nativeId === entry.target.nativeId);
  if (tracked?.conversationId !== entry.conversationId || tracked.managed !== false || tracked.kind !== 'original'
      || tracked.cwd !== entry.cwd || target?.conversationId !== entry.conversationId || target.managed !== false
      || target.kind !== 'original' || target.importPacket !== true || target.packetVersion !== 2
      || target.cwd !== entry.cwd || target.path !== entry.target.path
      || state.conversations[entry.conversationId]?.discoveryMode !== 'cold-import')
    throw new Error('Cold-import journal does not match the paired ledger.');
}
async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** One-time Local imports. Native Desktop adoption is deliberately separate:
 * files in the CLI store are not evidence that an entry is visible in Desktop.
 * The journal reserves one target per source before publication; re-runs never
 * allocate another copy or overwrite a Desktop-owned file.
 */
export class ColdImporter {
  constructor({ root, runtime, bridge }) {
    this.root = root; this.runtime = runtime; this.bridge = bridge;
    this.path = join(root, 'cold-imports.json');
  }
  async status() {
    const state = await readJSON(this.path, { version: 1, sources: {} });
    if (state.version !== 1 || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources))
      throw new Error('Unsupported cold-import journal.');
    return state;
  }
  async publish({ nativeId, path, title, expectedDigest, expectedCount }) {
    if (!UUID.test(nativeId)) throw new Error('Invalid cold-import source identity.');
    return withLock(join(this.root, 'cold-import.lock'), async () => {
      const journal = await this.status(), state = await this.bridge.status();
      let entry = journal.sources[nativeId];
      const tracked = state.records.find(record => record.side === 'codex' && record.nativeId === nativeId);
      if (tracked && !entry) return { status: 'already-tracked', conversationId: tracked.conversationId };
      if (entry) {
        validateEntry(entry, nativeId, this.runtime.claudeHome);
        const target = state.records.find(record => record.side === 'claude' && record.nativeId === entry.target.nativeId);
        if (entry.phase !== 'prepared' || tracked || target || state.conversations[entry.conversationId]) {
          assertPairedLedger(state, nativeId, entry);
          // Pairing is durable before this journal advances. Recover that exact
          // committed pair even if legitimate work has continued since then;
          // it must not be re-published or compared to the stale initial count.
          if (entry.phase === 'prepared') {
            entry.phase = 'paired'; entry.pairedAt = Date.now();
            await writeJSON(this.path, journal);
          }
          return entry;
        }
      }
      if (state.pending) throw new Error('An unfinished desktop handoff must be recovered before allocating a cold import.');
      const source = { side: 'codex', nativeId, path, managed: false, kind: 'original' };
      const data = await this.runtime.inspect(source);
      const digest = fingerprint(data.common), count = data.common.messages.length;
      if (expectedDigest && (digest !== expectedDigest || count !== expectedCount))
        throw new Error('Source changed since preflight; refresh its export before importing.');
      if (entry && (entry.digest !== digest || entry.count !== count || entry.cwd !== data.common.meta.cwd))
        throw new Error('Source changed after cold-import allocation; prior evidence was preserved.');
      if (!entry) {
        const conversationId = randomUUID(), targetId = randomUUID();
        entry = { phase: 'prepared', conversationId, sourceNativeId: nativeId, digest, count,
          cwd: data.common.meta.cwd, title: title || data.common.meta.title || 'Claudex conversation',
          createdAt: Date.now(), operationId: randomUUID(),
          target: { side: 'claude', nativeId: targetId, conversationId, cwd: data.common.meta.cwd,
            path: sessionPath(this.runtime.claudeHome, data.common.meta.cwd, targetId),
            managed: false, kind: 'original', importPacket: true, packetVersion: 2 } };
        journal.sources[nativeId] = entry;
        await writeJSON(this.path, journal);
      }
      if (!await exists(entry.target.path)) {
        const content = await encodeArchivedContextPacket({ root: this.root, common: data.common,
          conversationId: entry.conversationId, targetSessionId: entry.target.nativeId,
          sourceSide: 'codex', operationId: entry.operationId, key: this.runtime.key, archiveVersion: 2 });
        // The authenticated packet itself is a complete import boundary. Do not
        // fabricate an assistant answer or ask a model to summarize history.
        await createClaudeSession({ claudeHome: this.runtime.claudeHome, id: entry.target.nativeId,
          title: entry.title, owner: { root: this.root, conversationId: entry.conversationId, kind: 'cold-import' },
          common: { meta: { ...data.common.meta, timestamp: new Date(entry.createdAt).toISOString() },
            messages: [{ role: 'user', content }] } });
      }
      const target = await this.runtime.inspect(entry.target);
      if (target.digest !== entry.digest || target.common.messages.length !== entry.count || target.incompleteTail)
        throw new Error('Published cold import changed or failed authentication; it was not replaced.');
      await this.bridge.trackImportedPair({ conversationId: entry.conversationId,
        source: { ...source, path: data.path, cwd: entry.cwd }, target: entry.target, title: entry.title });
      entry.phase = 'paired'; entry.pairedAt = Date.now();
      await writeJSON(this.path, journal);
      return entry;
    }, { recoverDead: true });
  }
  async verifyAdopted(nativeId, desktopHome) {
    return withLock(join(this.root, 'cold-import.lock'), async () => {
      const journal = await this.status(), entry = journal.sources[nativeId];
      if (!entry || !['paired', 'adopted'].includes(entry.phase)) throw new Error('Cold import is not paired.');
      validateEntry(entry, nativeId, this.runtime.claudeHome);
      assertPairedLedger(await this.bridge.status(), nativeId, entry);
      if (!await desktopOwnsSession(desktopHome, entry.target.nativeId))
        throw new Error('The native Desktop registry has not adopted this cold import.');
      entry.phase = 'adopted'; entry.adoptedAt ??= Date.now();
      await writeJSON(this.path, journal);
      return entry;
    }, { recoverDead: true });
  }
}

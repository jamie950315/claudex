import { access, readFile, rename, unlink, readdir, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { toCommon } from 'txcript';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { desktopOwnsSession } from './desktop.mjs';
import { CodexClient } from './codex.mjs';
import { createCodexProjection, codexProjectionPath, encodeCodexProjection, registerCodexProjection } from './codex-projection.mjs';
import { createClaudeSession, decodeClaude, encodeClaude, sessionPath } from './claude.mjs';
import { snapshot, privateDirectory } from './storage.mjs';
import { assertComplete, fingerprint } from './history.mjs';
import { codexCompaction, provenance } from './compaction.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const execute = promisify(execFile);
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function safePath(path, root) {
  const parent = await realpath(dirname(path));
  const base = await realpath(root);
  if (parent !== base && !parent.startsWith(base + sep)) throw new Error('Native path is outside its configured store.');
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Symlinked native sessions are not managed.');
  return join(parent, basename(path));
}

export function decodeCodex(text) {
  const rows = text.trim().split('\n').filter(Boolean).map(JSON.parse);
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  if (!meta || meta.forked_from_id || meta.parent_thread_id) throw new Error('Missing or dependent Codex history; independent transcript required.');
  if (rows.some(row => row.type === 'turn_context' && row.payload.cwd && row.payload.cwd !== meta.cwd)) throw new Error('Codex working directory changed; automatic handoff paused.');
  const compacted = codexCompaction(text, rows);
  let running = false;
  let aborted = false;
  for (const row of rows) {
    if (row.type !== 'event_msg') continue;
    if (row.payload.type === 'task_started') { running = true; aborted = false; }
    if (row.payload.type === 'task_complete') running = false;
    if (row.payload.type === 'turn_aborted') { running = false; aborted = true; }
  }
  if (running) throw new Error('Codex turn is still running.');
  if (aborted) throw new Error('Codex turn was interrupted; automatic handoff paused.');
  const common = JSON.parse(toCommon(compacted ? compacted.rows.map(row => JSON.stringify(row)).join('\n') : text, 'codex'));
  if (compacted) common.meta.compaction = compacted.metadata;
  assertComplete(common);
  return { common, nativeId: meta.id, originator: meta.originator };
}

/** No import API and no direct SQLite changes. All removals require a managed record. */
export async function nativeDrivers({ root, codexHome, claudeHome, binary = 'codex', claudeBinary = 'claude', desktopHome = claudeHome === join(homedir(), '.claude') ? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions') : null }) {
  root = await privateDirectory(root);
  const vault = join(root, 'rollback');
  if (await privateDirectory(vault) !== vault) throw new Error('Rollback directory must remain inside bridge state.');
  const [codexVersion, claudeVersion] = await Promise.all([
    execute(binary, ['--version'], { timeout: 10000 }), execute(claudeBinary, ['--version'], { timeout: 10000 }),
  ]);
  if (codexVersion.stdout.trim() !== 'codex-cli 0.155.0-alpha.16.3' || !['2.1.210 ', '2.1.281 '].some(version => claudeVersion.stdout.trim().startsWith(version))) {
    throw new Error('Native version changed; run compatibility validation before enabling synchronization.');
  }
  const clients = new Set();
  let cachedClient;
  async function codexClient() {
    if (!cachedClient) {
      cachedClient = new CodexClient({ binary, codexHome });
      clients.add(cachedClient);
      await cachedClient.initialize();
    }
    return cachedClient;
  }
  async function located(record) {
    if (await exists(record.path)) return record.path;
    const alternative = record.side === 'codex' ? join(codexHome, 'archived_sessions', basename(record.path)) : join(vault, `${record.nativeId}.jsonl`);
    return await exists(alternative) ? alternative : record.path;
  }
  async function inspect(record) {
    const path = await located(record);
    const allowedRoot = record.side === 'codex' ? codexHome : path.startsWith(vault + sep) ? vault : claudeHome;
    await safePath(path, allowedRoot);
    const data = await snapshot(path);
    if (record.side === 'claude') {
      if (new Set(data.rows.filter(row => row.cwd).map(row => row.cwd)).size > 1) throw new Error('Claude working directory changed; automatic handoff paused.');
      const last = data.rows.filter(row => row.type === 'assistant' || row.type === 'user').at(-1);
      if (last?.type !== 'assistant' || !['end_turn', 'stop_sequence'].includes(last.message?.stop_reason)) throw new Error('Wait for a complete assistant turn with a terminal stop reason.');
    }
    const parsed = record.side === 'codex' ? decodeCodex(data.text) : { common: decodeClaude(data.text) };
    parsed.nativeId ??= parsed.common.meta.id;
    assertComplete(parsed.common);
    parsed.common.meta.cwd = await realpath(parsed.common.meta.cwd);
    if (record.nativeId && parsed.nativeId !== record.nativeId) throw new Error('Native session identity changed.');
    if (!uuid.test(parsed.nativeId)) throw new Error('Invalid native session identity.');
    return { ...parsed, path, digest: fingerprint(parsed.common), bytes: data.bytes, ...provenance(data.text, record, parsed.common.meta.compaction) };
  }
  async function assertOwned(record) {
    if (!record.managed || !uuid.test(record.nativeId)) throw new Error('Refusing to modify an unmanaged session.');
    const data = await inspect(record);
    if (record.side === 'codex' && data.originator !== 'claudex') throw new Error('Codex projection ownership marker is missing.');
    if (record.side === 'codex') {
      const client = await codexClient();
      for (const archived of [false, true]) {
        const descendants = await client.request('thread/list', { ancestorThreadId: record.nativeId, archived, sourceKinds, limit: 1 });
        if (descendants.data.length) throw new Error('Codex projection has dependent threads; retirement paused.');
        let cursor;
        do {
          const page = await client.request('thread/list', { archived, sourceKinds, limit: 100, ...(cursor ? { cursor } : {}) });
          for (const thread of page.data) {
            if (thread.id === record.nativeId) continue;
            // This native version can omit fork ancestry from list responses.
            const detail = await client.request('thread/read', { threadId: thread.id, includeTurns: false });
            if (detail.thread.forkedFromId === record.nativeId) throw new Error('Codex projection has a dependent fork; retirement paused.');
          }
          cursor = page.nextCursor;
        } while (cursor);
      }
    }
    if (record.side === 'claude') {
      const raw = await readFile(data.path, 'utf8');
      if (!raw.split('\n').filter(Boolean).map(JSON.parse).some(row => row.type === 'claudex-owner' && row.sessionId === record.nativeId && row.owner === root)) throw new Error('Claude projection ownership marker is missing.');
    }
    // Auxiliary data may be referenced by newer sessions. Do not orphan assets,
    // checkpoint trees, or subagent state through transcript-only collection.
    const companionPaths = record.side === 'claude'
      ? [join(claudeHome, 'projects', basename(dirname(record.originalPath ?? record.path)), record.nativeId), ...['file-history', 'tasks', 'image-cache', 'session-env'].map(name => join(claudeHome, name, record.nativeId))]
      : [join(codexHome, 'sessions', record.nativeId)];
    for (const path of companionPaths) if (await exists(path)) throw new Error('Session has auxiliary data; automatic retirement is paused until dependencies are verified.');
    return data;
  }
  async function claudeIdle(record) {
    if (await desktopOwnsSession(desktopHome, record.nativeId)) throw new Error('Claude Desktop owns this session; automatic replacement and retirement are paused.');
    let files;
    try { files = await readdir(join(claudeHome, 'sessions')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const value = JSON.parse(await readFile(join(claudeHome, 'sessions', file), 'utf8'));
      const pid = value.pid;
      if (!Number.isInteger(pid)) throw new Error('Unknown Claude activity marker; refusing to retire a possibly active session.');
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
      if (!uuid.test(value.sessionId)) throw new Error('Unknown Claude session identity; retirement paused.');
      if (value.sessionId !== record.nativeId) continue;
      throw new Error('Claude Code is open; close the destination before switching to it.');
    }
  }
  async function codexIdle(record) {
    if (!record.managed) return; // Originals are read, never retired or rewritten.
    const client = await codexClient();
    const result = await client.readThread(record.nativeId).catch(error => {
      if (/not found|no rollout/i.test(error.message)) return null;
      throw error;
    });
    if (result?.thread?.status?.type === 'active') throw new Error('Codex destination is active.');
    const data = await inspect(record);
    if (data.path.includes(`${sep}archived_sessions${sep}`)) return;
    // Native resume acquires Codex's cross-process writer ownership. Failure is
    // surfaced, never worked around with a second file writer.
    await client.resumeThread(record.nativeId);
  }
  const drivers = {};
  for (const side of ['codex', 'claude']) {
    drivers[side] = {
      inspect,
      exists: async record => exists(await located(record)),
      assertReadable: async record => { await inspect(record); },
      assertIdle: side === 'codex' ? codexIdle : claudeIdle,
      async plan({ nativeId, common }) {
        return { path: side === 'codex' ? codexProjectionPath(codexHome, common, nativeId) : sessionPath(claudeHome, common.meta.cwd, nativeId) };
      },
      expected(common, nativeId) {
        return side === 'codex' ? decodeCodex(encodeCodexProjection(common, nativeId)).common : decodeClaude(encodeClaude(common, nativeId).text);
      },
      async materialize(record, common, title) {
        if (await exists(record.path)) {
          const actual = await inspect(record);
          if (actual.digest !== fingerprint(this.expected(common, record.nativeId))) throw new Error('Existing projection differs from the pending transaction.');
          if (side === 'codex' && actual.originator !== 'claudex') throw new Error('Unexpected Codex projection owner.');
          if (side === 'codex') await registerCodexProjection({ client: await codexClient(), path: record.path, id: record.nativeId, cwd: record.cwd, title });
          return;
        }
        if (side === 'codex') await createCodexProjection({ client: await codexClient(), codexHome, common, id: record.nativeId, title });
        else await createClaudeSession({ claudeHome, common, id: record.nativeId, title, owner: root });
      },
      async verify(record, common) {
        const actual = await inspect(record);
        if (actual.originator !== undefined && actual.originator !== 'claudex') throw new Error('Unexpected Codex projection owner.');
        if (actual.digest !== fingerprint(this.expected(common, record.nativeId))) throw new Error('Native projection verification failed.');
        if (side === 'codex') {
          const visible = await (await codexClient()).readThread(record.nativeId);
          if (!visible.thread.turns?.length) throw new Error('Codex projection has no visible turns.');
        }
        return actual;
      },
      async hide(record) {
        await this.assertIdle(record);
        const data = await assertOwned(record);
        if (side === 'codex') {
          if (!data.path.includes(`${sep}archived_sessions${sep}`)) await (await codexClient()).request('thread/archive', { threadId: record.nativeId });
          return { path: join(codexHome, 'archived_sessions', basename(record.path)), originalPath: record.originalPath ?? record.path };
        }
        const path = join(vault, `${record.nativeId}.jsonl`);
        if (data.path !== path) {
          if (await exists(path)) throw new Error('Rollback slot already exists.');
          await rename(data.path, path);
        }
        return { path, originalPath: record.originalPath ?? record.path };
      },
      async remove(record) {
        await this.assertIdle(record);
        const data = await assertOwned(record);
        if (side === 'codex') await (await codexClient()).request('thread/delete', { threadId: record.nativeId });
        else await unlink(data.path);
      },
    };
  }
  return { drivers, close: async () => { for (const client of clients) await client.close(); } };
}

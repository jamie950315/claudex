import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createLargeAttachmentAssets, digest } from './helpers/large-attachments.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';
import { encodeArchivedContextPacket, inspectArchivedContextPacket, loadContextArchive, decodeArchivedContextPacket } from '../src/context-archive.mjs';
import { captureImageAssets, restoreImageAssets } from '../src/claude-image-assets.mjs';
import { decodeCompletedOwnedClaudeHistory } from '../src/owned-claude-history.mjs';
import { sessionPath } from '../src/claude.mjs';
import { fingerprint } from '../src/history.mjs';
import { hash, snapshot } from '../src/storage.mjs';

const normalizeContent = content => content.map(block => block.type === 'image'
  ? { type: 'image', source: { type: block.source.type, media_type: block.source.media_type, data: block.source.data } }
  : block.type === 'text' ? { type: 'text', text: block.text } : block);

async function worker({ cwd, claudeHome, temporary, sessionId, resume }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const queue = []; let wake, ended = false, child, pending;
  const receipts = [];
  const prompt = { async *[Symbol.asyncIterator]() {
    while (!ended || queue.length) {
      if (queue.length) yield queue.shift();
      else await new Promise(resolve => { wake = resolve; });
    }
  } };
  const active = query({ prompt, options: { cwd, settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [], tools: [], hooks: {},
    settings: { remoteControlAtStartup: false, crossSessionInbound: 'refuse', disableAllHooks: true, enabledPlugins: {} },
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_TMPDIR: temporary, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
    pathToClaudeCodeExecutable: process.env.CLAUDEX_CLAUDE_BINARY ?? 'claude',
    persistSession: true, ...(resume ? { resume: sessionId } : { sessionId }),
    spawnClaudeCodeProcess: options => (child = spawn(options.command, options.args,
      { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'ignore'] })),
  } });
  let consumeError;
  const consumer = (async () => {
    try {
      for await (const event of active) {
        if (event.session_id) assert.equal(event.session_id, sessionId);
        if (event.type !== 'result') continue;
        assert.equal(event.subtype, 'success'); assert.equal(event.is_error, false);
        assert.equal(event.num_turns, 0); assert.equal(event.duration_api_ms, 0); assert.equal(event.total_cost_usd, 0);
        const uuids = [...new Set([event.user_message_uuid, ...(event.user_message_uuids ?? [])].filter(Boolean))];
        assert.deepEqual(uuids, [pending?.uuid]);
        receipts.push({ uuid: uuids[0], numTurns: event.num_turns, apiMs: event.duration_api_ms, cumulativeCost: event.total_cost_usd });
        pending.resolve(); pending = null;
      }
    } catch (error) { consumeError = error; pending?.reject(error); }
  })();
  try { await active.initializationResult(); }
  catch (error) { ended = true; wake?.(); active.close(); await consumer; if (child?.exitCode === null && child.signalCode === null) await once(child, 'exit'); throw error; }
  return {
    receipts,
    async append(content) {
      if (consumeError) throw consumeError;
      const uuid = randomUUID(); let timeout;
      const done = new Promise((resolve, reject) => { pending = { uuid, resolve, reject }; });
      queue.push({ type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null,
        message: { role: 'user', content }, shouldQuery: false, client_composed: true }); wake?.();
      try { await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Isolated no-query receipt timeout')), 30_000); })]); }
      finally { clearTimeout(timeout); }
      return uuid;
    },
    async close() { ended = true; wake?.(); active.close(); await consumer;
      if (child?.exitCode === null && child.signalCode === null) await once(child, 'exit'); if (consumeError) throw consumeError; },
  };
}

test('isolated real SDK preserves large PNG/JPEG originals through previewing, next deltas, restart, and archive',
  { skip: process.env.CLAUDEX_LARGE_ATTACHMENT_NATIVE_TEST !== '1', timeout: 120_000 }, async t => {
    const provided = process.env.CLAUDEX_ATTACHMENT_PROOF_ROOT;
    const base = provided ? await realpath(provided) : await realpath(await mkdtemp(join(tmpdir(), 'cldx-large-attachment-proof-')));
    const assets = provided ? JSON.parse(await readFile(join(base, 'asset-manifest.json'), 'utf8')).assets
      : await createLargeAttachmentAssets(join(base, 'assets'));
    const workspace = await mkdtemp(join(base, 'native-'));
    const root = join(workspace, 'state'), cwd = join(workspace, 'project'), claudeHome = join(workspace, 'claude'), temporary = join(workspace, 'temporary');
    await Promise.all([root, cwd, claudeHome, temporary].map(path => mkdir(path, { mode: 0o700 })));
    const sessionId = randomUUID(), conversationId = randomUUID(), key = randomBytes(32);
    const options = { cwd, claudeHome, temporary, sessionId };
    const path = sessionPath(claudeHome, cwd, sessionId);
    const bindings = {}, receipts = [], previews = [], messages = [];
    const bindingsPath = join(root, 'image-bindings.json');
    let active;
    const inspect = async () => {
      const native = await snapshot(path);
      const restored = await restoreImageAssets({ root, rows: native.rows, bindings: JSON.parse(await readFile(bindingsPath, 'utf8')) });
      const decoded = decodeCompletedOwnedClaudeHistory({ text: restored.map(row => JSON.stringify(row)).join('\n') + '\n',
        conversationId, sessionId, key });
      assert.equal(decoded.digest, fingerprint({ messages }));
      return decoded;
    };
    try {
      for (const [index, asset] of assets.entries()) {
        active = await worker({ ...options, resume: index > 0 });
        const bytes = await readFile(asset.path);
        assert.equal(digest(bytes), asset.sha256); assert.ok(bytes.length > 5 * 1024 * 1024);
        const delta = [{ role: 'user', content: [{ type: 'text', text: `Synthetic large ${asset.mediaType} attachment.` },
          { type: 'image', source: { type: 'base64', media_type: asset.mediaType, data: bytes.toString('base64') } }] },
        { role: 'assistant', content: [{ type: 'text', text: `Synthetic completed attachment fixture ${index}.` }] }];
        const content = encodeContextPacket({ messages: delta, conversationId, targetSessionId: sessionId, sourceSide: 'codex',
          operationId: `image-${index}`, previousDigest: messages.length ? fingerprint({ messages }) : null, key });
        const uuid = await active.append(content);
        const raw = await snapshot(path), rows = raw.rows.filter(row => row.uuid === uuid);
        assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, sessionId);
        const captured = await captureImageAssets({ root, claudeTempRoot: join(temporary, `claude-${process.getuid()}`), cwd, sessionId,
          row: rows[0], expectedContent: content, expectedHash: hash(normalizeContent(content)), normalizeContent });
        if (Object.keys(captured.bindings).length) bindings[uuid] = captured.bindings;
        await writeFile(bindingsPath, JSON.stringify(bindings), { mode: 0o600 });
        messages.push(...delta);
        const rawImages = rows[0].message.content.filter(block => block.type === 'image');
        previews.push({ mediaType: asset.mediaType, originalBytes: bytes.length, originalHash: asset.sha256,
          renderedBytes: rawImages.map(block => Buffer.from(block.source.data, 'base64').length), boundImages: Object.keys(captured.bindings).length });
        await inspect(); receipts.push(...active.receipts); await active.close(); active = null;
      }
      // Native cache is recoverably moved after the writer exits: logical reads
      // must now use only the durable image asset bindings, not temporary files.
      await rename(temporary, temporary + '-retained'); await mkdir(temporary, { mode: 0o700 });
      active = await worker({ ...options, resume: true });
      const delta = [{ role: 'user', content: [{ type: 'text', text: 'Next synthetic text-only delta after both images and restart.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Synthetic completed text-only fixture response.' }] }];
      const content = encodeContextPacket({ messages: delta, conversationId, targetSessionId: sessionId, sourceSide: 'codex',
        operationId: 'text-after-restart', previousDigest: fingerprint({ messages }), key });
      await active.append(content); messages.push(...delta);
      const decoded = await inspect(); receipts.push(...active.receipts); await active.close(); active = null;
      const archiveContent = await encodeArchivedContextPacket({ root, messages, conversationId, targetSessionId: sessionId,
        sourceSide: 'codex', operationId: 'archive-proof', key, maxViewBytes: 1024 });
      const archive = inspectArchivedContextPacket({ content: archiveContent, conversationId, targetSessionId: sessionId, key }).archive;
      const loaded = await loadContextArchive({ root, archive });
      const archived = decodeArchivedContextPacket({ content: archiveContent, conversationId, targetSessionId: sessionId, key, resolveArchive: () => loaded });
      assert.equal(archived.digest, decoded.digest);
      assert.deepEqual(archived.messages.flatMap(message => message.content.filter(block => block.type === 'image'))
        .map(block => digest(Buffer.from(block.source.data, 'base64'))), assets.map(asset => asset.sha256));
      assert.equal(receipts.length, 3);
      const evidence = { workspace, assets, sessionId, messages: messages.length, digest: decoded.digest, previews, receipts,
        isolatedHome: true, remoteControlCreated: false, inference: false };
      await writeFile(join(workspace, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      t.diagnostic(JSON.stringify(evidence));
    } finally { await active?.close(); }
  });

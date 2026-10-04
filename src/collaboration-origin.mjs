import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { CodexWebSocketClient } from './codex-websocket.mjs';
import { codexChatSocket } from './native-chat-catalog.mjs';
import { sessionPath } from './claude.mjs';
import { privateRead } from './claude-mod-storage.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code = 'ORIGIN_PROOF_INVALID') => { throw Object.assign(new Error({
  ORIGIN_PROOF_INVALID: 'Native origin evidence does not match the original task request and receipt.',
  ORIGIN_PROOF_UNAVAILABLE: 'Exact native origin evidence is unavailable; no notification is authorized.',
  ORIGIN_PROOF_BOUND_EXCEEDED: 'Native origin inspection exceeded its bounded scope.',
}[code]), { code }); };
const requireValue = (value, code) => { if (!value) fail(code); };
const boundedJSON = (value, maximum) => {
  const text = JSON.stringify(value);
  requireValue(typeof text === 'string' && Buffer.byteLength(text) <= maximum, 'ORIGIN_PROOF_BOUND_EXCEEDED');
  return text;
};

function receiptFromContent(content) {
  requireValue(Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
    && typeof content[0].text === 'string');
  requireValue(Buffer.byteLength(content[0].text) <= MAX_RESULT_BYTES, 'ORIGIN_PROOF_BOUND_EXCEEDED');
  return JSON.parse(content[0].text);
}

function verifyCall(input, receipt, expected) {
  requireValue(object(input) && object(receipt) && receipt.replayed !== true && receipt.isError !== true);
  requireValue(digest(boundedJSON({ method: 'start', params: input }, MAX_RESULT_BYTES)) === expected.expectedFingerprint);
  requireValue(isDeepStrictEqual(receipt, expected.expectedReceipt));
}

function desktopNullPrimary(thread) {
  // Observed Desktop 0.160 primary threads report null instead of "user".
  // Missing fields or explicit auxiliary identities do not prove this schema.
  return thread.threadSource === null && thread.cliVersion === '0.160.0'
    && thread.originator === 'Codex Desktop' && thread.source === 'vscode'
    && thread.canAcceptDirectInput === true && thread.forkedFromId === null
    && thread.agentNickname === null && thread.agentRole === null;
}

async function readClaudeSource(path, home) {
  requireValue(await realpath(home) === home, 'ORIGIN_PROOF_UNAVAILABLE');
  // Native Claude creates project directories with 0755 under the user's
  // ordinary umask, while transcript files remain private 0600. These are not
  // broker-owned state directories: require ownership/canonicality and reject
  // foreign writes without chmodding native storage or demanding 0700.
  const directories = [home, join(home, 'projects'), dirname(path)];
  const identities = [];
  for (const directory of directories) {
    const stat = await lstat(directory);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
      && (stat.mode & 0o022) === 0 && await realpath(directory) === directory, 'ORIGIN_PROOF_UNAVAILABLE');
    identities.push(stat);
  }
  requireValue(await realpath(path) === path, 'ORIGIN_PROOF_UNAVAILABLE');
  const source = await privateRead(path, { maxBytes: MAX_SOURCE_BYTES });
  for (const [index, directory] of directories.entries()) {
    const after = await lstat(directory), before = identities[index];
    requireValue(['dev', 'ino', 'uid', 'mode'].every(key => before[key] === after[key])
      && await realpath(directory) === directory, 'ORIGIN_PROOF_UNAVAILABLE');
  }
  return source;
}

/** Hook fields are only lookup hints. Authority comes from a bounded independent
 * native call/result read matched to the broker's original one-use receipt.
 * This does not defend against a hostile same-UID process rewriting native data.
 * It never resumes a session, starts inference, writes native data, or scans
 * transcript directories. Claude proof uses the native primary transcript, not
 * Desktop registry membership or the UI through which the session is accessed.
 */
export function createOriginVerifier({ syncRoot,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  claudeHome = join(homedir(), '.claude'),
  clientFactory, readClaude = readClaudeSource,
  now = Date.now,
} = {}) {
  return async function verify(input) {
    const started = now();
    const checkTime = () => requireValue(now() - started <= 1800, 'ORIGIN_PROOF_UNAVAILABLE');
    try {
      requireValue(object(input) && ['codex', 'claude'].includes(input.provider) && UUID.test(input.sessionId ?? '')
        && typeof input.cwd === 'string' && isAbsolute(input.cwd) && resolve(input.cwd) === input.cwd
        && !/[\0\r\n]/u.test(input.cwd) && typeof input.toolUseId === 'string'
        && /^[A-Za-z0-9_.:-]{1,256}$/u.test(input.toolUseId) && HEX.test(input.expectedFingerprint ?? '')
        && object(input.expectedReceipt) && UUID.test(input.expectedReceipt.taskId ?? '')
        && HEX.test(input.expectedReceipt.originChallenge ?? '')
        && input.expectedReceipt.replayed !== true && input.expectedReceipt.isError !== true);
      boundedJSON(input.expectedReceipt, MAX_RESULT_BYTES);
      if (input.provider === 'codex') {
        requireValue(typeof input.turnId === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(input.turnId),
          'ORIGIN_PROOF_UNAVAILABLE');
        const client = clientFactory ? await clientFactory() : new CodexWebSocketClient({
          socketPath: await codexChatSocket({ syncRoot, codexHome }), timeoutMs: 1500,
        });
        try {
          await client.initialize(); checkTime();
          const metadata = async () => {
            const thread = (await client.request('thread/read', { threadId: input.sessionId, includeTurns: false }))?.thread;
            checkTime();
            requireValue(thread?.id === input.sessionId && thread.sessionId === input.sessionId && thread.cwd === input.cwd
              && thread.parentThreadId === null && thread.ephemeral === false
              && (thread.threadSource === 'user' || desktopNullPrimary(thread))
              && ['cli', 'vscode', 'exec'].includes(thread.source), 'ORIGIN_PROOF_UNAVAILABLE');
            return thread;
          };
          await metadata();
          let cursor, found = null, finished = false;
          const cursors = new Set();
          for (let index = 0; index < 4; index++) {
            const page = await client.request('thread/items/list', { threadId: input.sessionId, turnId: input.turnId,
              limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
            checkTime(); boundedJSON(page, MAX_PAGE_BYTES);
            requireValue(Array.isArray(page?.data) && page.data.length <= 100);
            for (const entry of page.data) {
              requireValue(entry?.turnId === input.turnId && object(entry.item));
              const item = entry.item;
              if (item.id !== input.toolUseId) continue;
              requireValue(found === null && item.type === 'mcpToolCall' && item.server === 'claudex-work'
                && item.tool === 'claudex_start');
              // Native lifecycle hooks can precede result persistence. This is
              // missing evidence, not permission to bind or resend the call.
              requireValue(item.status !== 'inProgress', 'ORIGIN_PROOF_UNAVAILABLE');
              requireValue(item.status === 'completed' && item.error === null);
              requireValue(item.result !== null && item.result !== undefined, 'ORIGIN_PROOF_UNAVAILABLE');
              requireValue(object(item.result) && item.result.isError !== true);
              const receipt = receiptFromContent(item.result.content);
              if (item.result.structuredContent != null) requireValue(isDeepStrictEqual(item.result.structuredContent, receipt));
              verifyCall(item.arguments, receipt, input);
              found = item;
            }
            if (page.nextCursor === null) { finished = true; break; }
            requireValue(typeof page.nextCursor === 'string' && page.nextCursor.length <= 4096
              && !cursors.has(page.nextCursor));
            cursors.add(page.nextCursor); cursor = page.nextCursor;
          }
          requireValue(finished, 'ORIGIN_PROOF_BOUND_EXCEEDED');
          requireValue(found !== null, 'ORIGIN_PROOF_UNAVAILABLE');
          await metadata(); checkTime();
        } finally { await client.close(); }
      } else {
        requireValue(isAbsolute(claudeHome) && resolve(claudeHome) === claudeHome, 'ORIGIN_PROOF_UNAVAILABLE');
        // cwd/sessionId only locate one candidate. Its independently read native
        // call/result must prove both identities and the broker's one-use receipt.
        // No Desktop registry, title lookup, directory scan or substitute path.
        const path = sessionPath(claudeHome, input.cwd, input.sessionId);
        const source = await readClaude(path, claudeHome);
        checkTime();
        requireValue(typeof source === 'string' && Buffer.byteLength(source) <= MAX_SOURCE_BYTES,
          'ORIGIN_PROOF_BOUND_EXCEEDED');
        requireValue(source.endsWith('\n'), 'ORIGIN_PROOF_UNAVAILABLE');
        const rows = source.split('\n').filter(Boolean).map(line => JSON.parse(line));
        const projectionEnd = rows.findLastIndex(row => row?.type === 'claudex-owner');
        const calls = [], results = [], byId = new Map();
        for (const [index, row] of rows.entries()) {
          requireValue(object(row));
          if (typeof row.uuid === 'string') {
            requireValue(!byId.has(row.uuid)); byId.set(row.uuid, row);
          }
          for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
            if (block?.type === 'tool_use' && block.id === input.toolUseId) calls.push({ row, block, index });
            if (block?.type === 'tool_result' && block.tool_use_id === input.toolUseId) results.push({ row, block, index });
          }
        }
        requireValue(calls.length === 1 && results.length === 1, 'ORIGIN_PROOF_UNAVAILABLE');
        const call = calls[0], result = results[0];
        // A managed/Remote Control session may author new native calls after its
        // bootstrap. Imported history is not origin proof; native tool-result
        // provenance and the exact parent chain remain mandatory below.
        requireValue(call.index > projectionEnd && result.index > call.index);
        for (const entry of [call, result]) requireValue(entry.row.sessionId === input.sessionId
          && entry.row.cwd === input.cwd && entry.row.isSidechain === false && !entry.row.agentId
          && typeof entry.row.uuid === 'string');
        requireValue(call.row.type === 'assistant' && call.row.message.role === 'assistant'
          && call.block.name === 'mcp__claudex-work__claudex_start'
          && result.row.type === 'user' && result.row.message.role === 'user' && result.block.is_error !== true
          && result.row.sourceToolAssistantUUID === call.row.uuid);
        let parent = result.row.parentUuid, linked = false;
        const seen = new Set();
        for (let depth = 0; depth < 128 && typeof parent === 'string'; depth++) {
          requireValue(!seen.has(parent)); seen.add(parent);
          if (parent === call.row.uuid) { linked = true; break; }
          const row = byId.get(parent);
          requireValue(row?.sessionId === input.sessionId && row.cwd === input.cwd && row.isSidechain === false && !row.agentId);
          parent = row.parentUuid;
        }
        requireValue(linked);
        verifyCall(call.block.input, receiptFromContent(result.block.content), input);
      }
      checkTime();
      return { provider: input.provider, sessionId: input.sessionId, cwd: input.cwd, toolUseId: input.toolUseId,
        ...(input.provider === 'codex' ? { turnId: input.turnId } : {}),
        source: input.provider === 'codex' ? 'codex-native-mcp-result' : 'claude-native-mcp-result', verifiedAt: now() };
    } catch (error) {
      if (['ORIGIN_PROOF_INVALID', 'ORIGIN_PROOF_UNAVAILABLE', 'ORIGIN_PROOF_BOUND_EXCEEDED'].includes(error?.code)) throw error;
      // Never expose private transcript text, native transport errors or paths.
      fail('ORIGIN_PROOF_UNAVAILABLE');
    }
  };
}

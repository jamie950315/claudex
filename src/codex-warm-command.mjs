import { isAbsolute, join, resolve } from 'node:path';
import { readAppStopState } from './app-stop-state.mjs';
import { privateDir, privateRead } from './claude-mod-storage.mjs';
import { callCollaboration } from './collaboration-transport.mjs';
import { createCodexCacheNative } from './codex-cache-native.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PREFIX = '/claudex:warm';
const HELP = 'Use /claudex:warm on, off, status, or confirm TOKEN accept-best-effort. Codex has no configurable 5m/1h TTL. The default refresh interval is 25 minutes.';
const block = text => {
  const message = `Claudex cache warming (local command; no model request):\n${text}`;
  return { decision: 'block', reason: message, systemMessage: message };
};

export function parseCodexWarmCommand(prompt) {
  if (typeof prompt !== 'string' || !/^\/claudex:warm(?:\s|$)/u.test(prompt.trim())) return null;
  if (prompt.length > 1024 || /[\r\n\0]/u.test(prompt.trim())) throw new Error(HELP);
  const [, action = 'status', ...args] = prompt.trim().split(/\s+/u);
  if (['on', 'off', 'status'].includes(action) && !args.length) return { action };
  if (action === 'confirm' && args.length === 2 && UUID.test(args[0]) && args[1] === 'accept-best-effort')
    return { action, confirmationId: args[0] };
  throw new Error(HELP);
}

async function rpc(root, method, params) {
  await privateDir(root);
  const directory = join(root, 'collaboration');
  await privateDir(directory);
  const secret = await privateRead(join(directory, 'controller-key'), { maxBytes: 65 });
  if (!/^[a-f0-9]{64}\n$/.test(secret)) throw new Error('Invalid controller capability.');
  return callCollaboration({ root: directory, peer: 'codex', token: secret.trim(), method, params, timeoutMs: 20000 });
}

/** Native hook input binds the shortcut, never a caller-supplied target argument.
 * The broker independently verifies the loaded native owner on prepare/confirm.
 * Recognized commands always block model submission, including failures. */
export async function handleCodexWarmCommand(input, { root, worker = false, call = rpc, stopped = readAppStopState,
  verify = context => createCodexCacheNative({ syncRoot: root }).verifyCommand(context) } = {}) {
  if (input?.hook_event_name !== 'UserPromptSubmit') return null;
  let command;
  try { command = parseCodexWarmCommand(input.prompt); }
  catch (error) { return block(error.message); }
  if (!command) return null;
  try {
    if (worker || input.agent_id || input.agentId || input.agent_type)
      throw new Error('Managed workers and subagents cannot use this controller command.');
    if (!UUID.test(input.session_id ?? '') || typeof input.turn_id !== 'string' || !input.turn_id || input.turn_id.length > 200
      || typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || resolve(input.cwd) !== input.cwd
      || input.cwd.length > 4096 || /[\x00-\x1f\x7f]/u.test(input.cwd))
      throw new Error('Exact native chat context is unavailable; no change was requested.');
    const hold = await stopped(root);
    if (hold?.stopped || hold?.resuming) throw new Error('Claudex is stopped or resuming; no change was requested.');
    const { action } = command;
    const params = { sessionId: input.session_id, cwd: input.cwd };
    if (await verify({ ...params, turnId: input.turn_id, transcriptPath: input.transcript_path }) !== true)
      throw new Error('Native primary command context could not be verified; no change was requested.');
    // Preparing is read-only native inspection, not opt-in. The printed confirm
    // explicitly accepts the complete best-effort limitations before enrollment.
    if (action === 'on' || action === 'confirm') params.bestEffort = true;
    if (action === 'confirm') params.confirmationId = command.confirmationId;
    const method = `codex_cache_warm_${action === 'on' ? 'prepare' : action === 'status' ? 'list' : action}`;
    let result = await call(root, method, params);
    if (action === 'on') {
      if (!UUID.test(result?.confirmationId ?? '') || result.sessionId !== params.sessionId || result.cwd !== params.cwd)
        throw new Error('The preview did not match this chat; no confirmation was issued.');
      result = { ...result, confirm: `${PREFIX} confirm ${result.confirmationId} accept-best-effort` };
    } else if (action === 'status') {
      // Status stays session-scoped and bounded; attempt history remains in CLI diagnostics.
      result = { sessionId: params.sessionId, cwd: params.cwd, policies: result.policies,
        bestEffort: result.bestEffort, limitations: result.limitations };
    }
    const text = JSON.stringify(result, null, 2);
    if (typeof text !== 'string' || text.length > 30000) throw new Error('The local result exceeded its display bound; inspect status.');
    return block(text);
  } catch (error) {
    // A lost response may follow a successful enrollment. Do not retry or claim
    // rollback; a separately requested status/off can resolve the uncertainty.
    return block(`Operation not confirmed: ${error.message}\nDo not replay a confirmation after an uncertain result. Use ${PREFIX} status or ${PREFIX} off.`);
  }
}

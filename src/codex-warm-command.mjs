import { isAbsolute, join, resolve } from 'node:path';
import { readAppStopState } from './app-stop-state.mjs';
import { privateDir, privateRead } from './claude-mod-storage.mjs';
import { callCollaboration } from './collaboration-transport.mjs';
import { createCodexCacheNative } from './codex-cache-native.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatWarmSummary } from '../plugins/claudex/hooks/cache-warm-display.mjs';
import { createLocalization } from '../plugins/claudex/hooks/localization.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PREFIX = '/claudex:warm';
const HELP = 'Use /claudex:warm on, off, or status. On enables warming for this chat and accepts its best-effort limits. Codex has no configurable 5m/1h TTL. The default refresh interval is 25 minutes.';
const block = text => {
  return { decision: 'block', reason: text, systemMessage: text };
};

async function systemTranslator() {
  const localization = createLocalization();
  await localization.load({ readLanguage: async () => 'system', preferredLanguages: async () => {
    const result = await promisify(execFile)('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { timeout: 2000, maxBuffer: 8192 });
    return { ...result, exitCode: 0 };
  } });
  return localization.t;
}

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
  getTranslator = systemTranslator,
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
    const context = { ...params, turnId: input.turn_id, transcriptPath: input.transcript_path };
    if (await verify(context) !== true)
      throw new Error('Native primary command context could not be verified; no change was requested.');
    // The explicit user on command is enrollment consent. Keep the broker's
    // one-use prepare/confirm transaction internal, with a fresh context fence.
    if (action === 'on' || action === 'confirm') params.bestEffort = true;
    if (action === 'confirm') params.confirmationId = command.confirmationId;
    const method = `codex_cache_warm_${action === 'on' ? 'prepare' : action === 'status' ? 'list' : action}`;
    let result = await call(root, method, params);
    if (action === 'on') {
      if (!UUID.test(result?.confirmationId ?? '') || result.sessionId !== params.sessionId || result.cwd !== params.cwd)
        throw new Error('The prepared settings did not match this chat; warming was not enabled.');
      if (await verify(context) !== true)
        throw new Error('Native command context changed before enabling warming.');
      result = await call(root, 'codex_cache_warm_confirm', { ...params, confirmationId: result.confirmationId });
      if (result?.policy?.enabled !== true) throw new Error('Warming activation was not verified; inspect status.');
      result = { state: 'enabled', ...result };
    } else if (action === 'status') {
      // Status stays session-scoped and bounded; attempt history remains in CLI diagnostics.
      result = { sessionId: params.sessionId, cwd: params.cwd, policies: result.policies,
        bestEffort: result.bestEffort, limitations: result.limitations };
    }
    return block(formatWarmSummary(result, { provider: 'codex', ...params, t: await getTranslator() }));
  } catch (error) {
    // A lost response may follow a successful enrollment. Do not retry or claim
    // rollback; a separately requested status/off can resolve the uncertainty.
    return block(`Operation not confirmed: ${error.message}\nDo not repeat an uncertain enable request. Use ${PREFIX} status or ${PREFIX} off.`);
  }
}

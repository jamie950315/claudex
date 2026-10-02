#!/usr/bin/env node
import { SyncEventInbox } from '../src/sync-events.mjs';
import { readAppStopState } from '../src/app-stop-state.mjs';
import { ChatMailbox } from '../src/chat-mailbox.mjs';
import { isAbsolute, join } from 'node:path';

const startTool = /^mcp__claudex[-_]work__claudex_start$/;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const sourceHint = input => identifier(input.session_id) && typeof input.cwd === 'string' && isAbsolute(input.cwd)
  && input.cwd.length <= 4096 && !/[\0\r\n]/.test(input.cwd);
async function originRpc(options, method, params) {
  const { privateDir, privateRead } = await import('../src/claude-mod-storage.mjs');
  const { callCollaboration } = await import('../src/collaboration-transport.mjs');
  await privateDir(options['--root']);
  const root = join(options['--root'], 'collaboration');
  await privateDir(root);
  const token = await privateRead(join(root, 'controller-key'), { maxBytes: 65 });
  if (!/^[a-f0-9]{64}\n$/.test(token)) throw new Error('Invalid origin controller capability.');
  const stopped = await readAppStopState(options['--root']);
  if (stopped?.stopped || stopped?.resuming) return;
  await callCollaboration({ root, peer: options['--provider'], token: token.trim(), method, timeoutMs: 2500, params });
}
async function bindOrigin(options, input) {
  if (!startTool.test(input.tool_name ?? '') || !sourceHint(input) || !identifier(input.tool_use_id)
    || input.turn_id !== undefined && !identifier(input.turn_id)) return;
  if (options['--provider'] === 'codex' && !identifier(input.turn_id)) return;
  let response = input.tool_response;
  if (typeof response === 'string') { try { response = JSON.parse(response); } catch { return; } }
  if (!response || response.isError === true || !Array.isArray(response.content) || response.content.length !== 1
    || response.content[0]?.type !== 'text' || typeof response.content[0].text !== 'string') return;
  let receipt;
  try { receipt = JSON.parse(response.content[0].text); } catch { return; }
  if (!receipt || receipt.replayed === true || receipt.isError === true || !identifier(receipt.taskId)
    || typeof receipt.originChallenge !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.originChallenge)) return;
  // These fields are hints only. The broker independently reads the exact native
  // tool call/result and verifies its arguments fingerprint and one-time challenge.
  await originRpc(options, 'origin_bind', { taskId: receipt.taskId, sessionId: input.session_id, cwd: input.cwd,
    toolUseId: input.tool_use_id, ...(input.turn_id === undefined ? {} : { turnId: input.turn_id }) });
}

// Hook input can contain private prompts. Parse only bounded input; persist identity hints only.
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--root', '--provider'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid hook arguments.');
    options[args[i]] = args[i + 1];
  }
  if (!['codex', 'claude'].includes(options['--provider'])) throw new Error('Invalid hook provider.');
  // Delegated collaboration workers load the user's hooks but are not ordinary
  // conversations: never enroll, wake or message them. Drain input and stop.
  if (process.env.CLAUDEX_COLLABORATION_WORKER === '1') { for await (const _ of process.stdin); return; }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Hook input exceeds its bound.');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object') throw new Error('Invalid hook input.');
  if (input.agent_id || input.agentId || input.agent_type || input.hook_event_name === 'SubagentStop') return;
  if (input.hook_event_name === 'PostToolUse') {
    try {
      const stopped = await readAppStopState(options['--root']);
      if (stopped?.stopped || stopped?.resuming) return;
      await bindOrigin(options, input);
    }
    catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'ORIGIN_UNVERIFIED';
      process.stderr.write(`Claudex origin binding was not confirmed (${code}); no retry or fallback was attempted.\n`);
    }
    return;
  }
  let kind = { Stop: 'completed', UserPromptSubmit: 'started', SessionStart: 'session', Interrupt: 'interrupted', StopFailure: 'interrupted', SessionEnd: 'interrupted' }[input.hook_event_name];
  if (!kind) return;
  const stopped = await readAppStopState(options['--root']);
  if (stopped?.stopped || stopped?.resuming) return;
  if (['SessionStart', 'UserPromptSubmit', 'Stop'].includes(input.hook_event_name) && sourceHint(input)) {
    try {
      await originRpc(options, 'origin_recheck', { sessionId: input.session_id, cwd: input.cwd, event: input.hook_event_name });
    } catch {
      // Native transcripts may flush after PostToolUse. This exact-session event
      // is a bounded reread hint, not permission to retry work or notifications.
      // An unavailable broker must not suppress ordinary mailbox/sync handling.
    }
    const currentStop = await readAppStopState(options['--root']);
    if (currentStop?.stopped || currentStop?.resuming) return;
  }
  let output;
  if (['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].includes(input.hook_event_name)
    && typeof input.cwd === 'string' && isAbsolute(input.cwd)) {
    try {
      const mailbox = new ChatMailbox({ root: join(options['--root'], 'collaboration', 'chat-mailbox') });
      const receipt = await mailbox.hook({ provider: options['--provider'], sessionId: input.session_id,
        cwd: input.cwd, event: input.hook_event_name, stopHookActive: input.stop_hook_active === true,
        lastAssistantMessage: typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '' });
      if (receipt.context) {
        if (input.hook_event_name === 'Stop') kind = 'started';
        output = options['--provider'] === 'codex' && input.hook_event_name === 'Stop'
          ? { decision: 'block', reason: receipt.context }
          : { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: receipt.context } };
      }
    } catch {
      // A coordination error must not suppress ordinary synchronization hints.
      process.stderr.write('Claudex native-chat coordination could not be verified; inspect the message receipt before retrying.\n');
    }
  }
  const inbox = await new SyncEventInbox({ root: options['--root'] }).initialize();
  await inbox.publish({ side: options['--provider'], nativeId: input.session_id, kind,
    ...(typeof input.turn_id === 'string' ? { turnId: input.turn_id } : {}) });
  if (output) process.stdout.write(JSON.stringify(output) + '\n');
}

main().catch(() => { process.stderr.write('Claudex could not record the synchronization wake event.\n'); process.exitCode = 1; });

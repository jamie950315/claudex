#!/usr/bin/env node
import { SyncEventInbox } from '../src/sync-events.mjs';
import { readAppStopState } from '../src/app-stop-state.mjs';
import { ChatMailbox } from '../src/chat-mailbox.mjs';
import { isAbsolute, join } from 'node:path';

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
  if (input.agent_id || input.hook_event_name === 'SubagentStop') return;
  let kind = { Stop: 'completed', UserPromptSubmit: 'started', SessionStart: 'session', Interrupt: 'interrupted', StopFailure: 'interrupted', SessionEnd: 'interrupted' }[input.hook_event_name];
  if (!kind) return;
  if ((await readAppStopState(options['--root']))?.stopped) return;
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

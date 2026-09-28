#!/usr/bin/env node
import { SyncEventInbox } from '../src/sync-events.mjs';
import { readAppStopState } from '../src/app-stop-state.mjs';

// Hook input can contain private prompts. Parse only bounded input; persist identity hints only.
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--root', '--provider'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid hook arguments.');
    options[args[i]] = args[i + 1];
  }
  if (!['codex', 'claude'].includes(options['--provider'])) throw new Error('Invalid hook provider.');
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
  const kind = { Stop: 'completed', UserPromptSubmit: 'started', SessionStart: 'session', Interrupt: 'interrupted', StopFailure: 'interrupted', SessionEnd: 'interrupted' }[input.hook_event_name];
  if (!kind) return;
  if ((await readAppStopState(options['--root']))?.stopped) return;
  const inbox = await new SyncEventInbox({ root: options['--root'] }).initialize();
  await inbox.publish({ side: options['--provider'], nativeId: input.session_id, kind,
    ...(typeof input.turn_id === 'string' ? { turnId: input.turn_id } : {}) });
}

main().catch(() => { process.stderr.write('Claudex could not record the synchronization wake event.\n'); process.exitCode = 1; });

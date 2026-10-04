#!/usr/bin/env node
import { handleCodexWarmCommand } from '../src/codex-warm-command.mjs';
import { isAbsolute } from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--root' || !isAbsolute(args[1]) || /[\0\r\n]/.test(args[1]))
    throw new Error('Invalid cache command hook configuration.');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Native hook input exceeded its bound.');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  let timer;
  const output = await Promise.race([
    handleCodexWarmCommand(input, { root: args[1],
      worker: process.env.CLAUDEX_COLLABORATION_WORKER === '1' || Boolean(process.env.CLAUDEX_WORK_TOKEN) }),
    new Promise(resolve => { timer = setTimeout(() => resolve({ decision: 'block',
      reason: 'Claudex cache command timed out. The operation is not confirmed. Do not retry confirm; inspect /claudex:warm status or use /claudex:warm off.' }), 25000); }),
  ]);
  clearTimeout(timer);
  // Finish before the native 30-second hook deadline, even if a timed-out RPC
  // still has a socket. A submitted mutation remains explicitly uncertain.
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}

main().catch(() => {
  // Malformed input has no trustworthy prompt to classify. Report only a fixed
  // diagnostic, never echo private prompts, credentials or raw native input.
  process.stderr.write('Claudex could not inspect the local cache command.\n');
  process.exitCode = 1;
});

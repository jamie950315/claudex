#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createModBridge } from '../src/claude-mod-bridge.mjs';
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, ModError, insist } from '../src/claude-mod-protocol.mjs';
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, 'native-wake': { type: 'boolean', default: false },
  } });
  insist(positionals.length === 0 && typeof values.root === 'string');
  // Refuse before consuming untrusted worker input or reading a controller capability.
  insist(process.env.CLAUDEX_COLLABORATION_WORKER !== '1', 'MANAGED_WORKER', 'Managed worker controller access is disabled.');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    insist(size <= MAX_REQUEST_BYTES, 'INPUT_BOUND', 'Companion input exceeds 96 KiB.');
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = await createModBridge({ root: values.root, allowNativeWake: values['native-wake'] })(request);
  const output = `${JSON.stringify({ ok: true, result })}\n`;
  insist(Buffer.byteLength(output) <= MAX_RESPONSE_BYTES, 'OUTPUT_BOUND', 'Response exceeds the UI bound. Inspect the durable action receipt or use the existing operator CLI.');
  process.stdout.write(output);
}
main().catch(error => {
  const known = error instanceof ModError;
  process.stdout.write(`${JSON.stringify({ ok: false, error: {
    code: known ? error.code : 'COMPANION_UNAVAILABLE',
    message: known ? error.message : 'The local companion could not verify or complete this operation. Preserve its receipt; inspect setup and broker status.',
  } })}\n`);
  process.exitCode = 1;
});

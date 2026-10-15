#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { stageClaudeMod } from '../src/claude-mod-install.mjs';
const help = `Claudex native Mod staging (no installation or service changes)

node bin/claudex-mod.mjs stage --root /absolute/claudex-root --output /new/stage-directory
  [--node /absolute/node] [--no-native-wake] [--no-self-wake]

The parent of --output must exist; the output itself must be new.
--root is the synchronization root, with collaboration/ beneath it.
Receiver defaults are enabled; replies may consume model allowance.
Explicit --no-native-wake/--no-self-wake stage a disabled receiver.
Native delivery still requires the documented Desktop acceptance plan.
After staging, run the native validate/test commands in docs/claude-mod.md.
`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, allowNegative: true, options: {
    root: { type: 'string' }, output: { type: 'string' }, node: { type: 'string' },
    'native-wake': { type: 'boolean', default: true }, 'self-wake': { type: 'boolean', default: true }, help: { type: 'boolean' },
  } });
  if (values.help || positionals.length === 0) console.log(help);
  else if (positionals.length === 1 && positionals[0] === 'stage') {
    console.log(JSON.stringify(await stageClaudeMod({ output: values.output, stateRoot: values.root,
      ...(values.node ? { nodeBinary: values.node } : {}), nativeWake: values['native-wake'], selfWake: values['self-wake'] }), null, 2));
  } else throw new Error('Use stage or --help.');
} catch (error) { console.error(`Claudex Mod: ${error.message}`); process.exitCode = 1; }

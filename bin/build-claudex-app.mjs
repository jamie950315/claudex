#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildClaudexApp } from '../src/app-bundle.mjs';

function usage() {
  return 'Usage: node bin/build-claudex-app.mjs --output /absolute/Claudex.app --node-distribution /absolute/node-vXX-darwin-arm64 [--identity SIGNING_IDENTITY] [--arch arm64|x86_64] [--zip /absolute/Claudex.zip]';
}

const options = {};
const keys = new Map([['--output', 'destination'], ['--node-distribution', 'nodeDistribution'], ['--identity', 'identity'], ['--arch', 'arch'], ['--zip', 'zip']]);
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--help' || flag === '-h') { console.log(usage()); process.exit(0); }
  if (!keys.has(flag) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    console.error(usage());
    process.exit(2);
  }
  options[keys.get(flag)] = process.argv[++index];
}
options.identity ||= process.env.CLAUDEX_SIGNING_IDENTITY;
options.sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  console.log(JSON.stringify(await buildClaudexApp(options), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

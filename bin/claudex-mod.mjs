#!/usr/bin/env node
import { runRust, sourceRoot } from './rust-entry.mjs';
const args = process.argv.slice(2);
const source = args.some(arg => arg === '--source-root' || arg.startsWith('--source-root='))
  ? [] : ['--source-root', sourceRoot];
runRust(['mod', ...source], args);

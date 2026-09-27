#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { runServiceSupervisor } from '../src/service-supervisor.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, cli: { type: 'string' } } });
if (!values.root || !values.cli) throw new Error('The service supervisor requires explicit root and CLI paths.');
const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try { await runServiceSupervisor({ root: resolve(values.root), cli: resolve(values.cli), signal: controller.signal }); }
catch (error) { console.error(`Claudex service: ${error.message}`); process.exitCode = 1; }
finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }

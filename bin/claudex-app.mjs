#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AppSetup } from '../src/app-setup.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, provider: { type: 'string' }, 'runtime-directory': { type: 'string' },
} });
try {
  const app = new AppSetup({ ...(values.root ? { root: values.root } : {}), ...(values['runtime-directory'] ? { runtimeDirectory: values['runtime-directory'] } : {}) });
  const action = positionals[0] ?? 'inspect';
  let result;
  if (action === 'inspect') result = await app.inspect();
  else if (action === 'startup') result = await app.startup();
  else if (action === 'setup') result = await app.setup();
  else if (action === 'login') result = await app.login(values.provider);
  else throw new Error('Unsupported setup action.');
  console.log(JSON.stringify(result));
} catch {
  console.log(JSON.stringify({ version: 1, phase: 'blocked', allProjects: true, allowWrite: true,
    components: [{ id: 'setup', label: 'Application setup', state: 'blocked', detail: 'Setup could not be verified. Existing native work and account data were preserved.', action: 'retry' }] }));
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AppSetup } from '../src/app-setup.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, provider: { type: 'string' }, 'runtime-directory': { type: 'string' },
  'codex-model': { type: 'string' }, 'claude-model': { type: 'string' },
  'codex-effort': { type: 'string' }, 'claude-effort': { type: 'string' },
  'default-permission': { type: 'string' }, 'default-limit': { type: 'string' }, 'ttl-mode': { type: 'string' }, 'on-message': { type: 'string' }, ttl: { type: 'string' },
  session: { type: 'string' }, cwd: { type: 'string' }, 'read-only': { type: 'boolean' },
  receiver: { type: 'string' }, enable: { type: 'boolean' },
} });
try {
  const app = new AppSetup({ ...(values.root ? { root: values.root } : {}), ...(values['runtime-directory'] ? { runtimeDirectory: values['runtime-directory'] } : {}),
    readOnly: values['read-only'] === true });
  const action = positionals[0] ?? 'inspect';
  let result;
  if (action === 'inspect') result = await app.inspect();
  else if (action === 'startup') result = await app.startup();
  else if (action === 'setup') result = await app.setup();
  else if (action === 'mod-setup') result = await app.modSetup({ receiver: values.receiver, enable: values.enable === true });
  else if (action === 'login') result = await app.login(values.provider);
  else if (action === 'stop') result = await app.stop();
  else if (action === 'stop-status') result = await app.stopStatus();
  else if (action === 'models') {
    const updating = values['codex-model'] !== undefined || values['claude-model'] !== undefined;
    if (updating && (values['codex-model'] === undefined || values['claude-model'] === undefined))
      throw new Error('Both provider model settings are required.');
    const updatingEffort = values['codex-effort'] !== undefined || values['claude-effort'] !== undefined;
    if (updatingEffort && (values['codex-effort'] === undefined || values['claude-effort'] === undefined))
      throw new Error('Both provider effort settings are required.');
    result = await app.models(updating ? {
      codex: values['codex-model'].trim() || null,
      claude: values['claude-model'].trim() || null,
    } : undefined, updatingEffort ? {
      codex: values['codex-effort'].trim() || null,
      claude: values['claude-effort'].trim() || null,
    } : undefined, values['default-permission']);
  }
  else if (action === 'warm-settings') result = await app.warmSettings({ defaultLimit: values['default-limit'], ttlMode: values['ttl-mode'], ttl: values.ttl, onUserMessage: values['on-message'] });
  else if (action === 'warm-stop') result = await app.warmStop({ provider: values.provider, sessionId: values.session, cwd: values.cwd });
  else if (action === 'resolve-uncertain') result = await app.resolveUncertain();
  else throw new Error('Unsupported setup action.');
  console.log(JSON.stringify(result));
} catch (error) {
  if (['models', 'warm-settings', 'warm-stop', 'stop', 'stop-status', 'resolve-uncertain'].includes(positionals[0])) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  } else {
  console.log(JSON.stringify({ version: 1, phase: 'blocked', allProjects: true, allowWrite: true,
    components: [{ id: 'setup', label: 'Application setup', state: 'blocked', detail: 'Setup could not be verified. Existing native work and account data were preserved.', action: 'retry' }] }));
  }
}

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveBundledCodex } from './codex-app-layout.mjs';

const execute = promisify(execFile);
const expected = {
  codex: { names: ['ChatGPT.app', 'Codex.app'], id: 'com.openai.codex', team: '2DC432GLL2' },
  claude: { names: ['Claude.app'], id: 'com.anthropic.claudefordesktop', team: 'Q6L2SF6YDW' },
};
const absent = error => error?.code === 'ENOENT';
const absolute = path => typeof path === 'string' && path.startsWith('/') && resolve(path) === path;
const exists = async path => {
  try { await lstat(path); return true; }
  catch (error) { if (absent(error)) return false; throw error; }
};

async function signedApp(path, spec, run) {
  if (!await exists(path)) return false;
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Untrusted app at ${path}`);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
  const { stderr = '' } = await run('/usr/bin/codesign', ['-d', '--verbose=2', path]);
  if (!stderr.split('\n').includes(`Identifier=${spec.id}`)
      || !stderr.split('\n').includes(`TeamIdentifier=${spec.team}`))
    throw Object.assign(new Error(`Unexpected publisher for ${path}`), { code: 'CLAUDEX_UNEXPECTED_PUBLISHER' });
  return true;
}

// A re-signed or third-party bundle is never accepted or skipped in favor of
// another copy. It blocks only its own provider, so unrelated prerequisites
// keep reporting their real state instead of appearing uninstalled.
async function findApp(home, spec, run, systemApplications) {
  for (const directory of [join(home, 'Applications'), systemApplications]) {
    for (const name of spec.names) {
      const path = join(directory, name);
      try { if (await signedApp(path, spec, run)) return { app: path }; }
      catch (error) { if (error.code === 'CLAUDEX_UNEXPECTED_PUBLISHER') return { app: null, appIssue: error.message }; throw error; }
    }
  }
  return { app: null };
}

async function versionOf(binary, run, env) {
  if (!absolute(binary)) return null;
  try {
    await access(binary, constants.X_OK);
    const { stdout = '' } = await run(binary, ['--version'], { env });
    return stdout.trim().slice(0, 128) || null;
  } catch { return null; }
}

async function commandOnPath(command, env) {
  for (const directory of (env.PATH || '').split(delimiter)) {
    if (!directory?.startsWith('/')) continue;
    const candidate = join(directory, command);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export async function discoverProviders({ root, home = process.env.HOME, runtime, env = process.env,
  run = execute, systemApplications = '/Applications' } = {}) {
  if (!absolute(home)) throw new Error('An absolute home directory is required.');
  const cliEnv = { HOME: home, LANG: env.LANG || 'C.UTF-8',
    PATH: absolute(runtime) ? `${join(runtime, 'bin')}${delimiter}${env.PATH || ''}` : env.PATH || '' };
  const codexFound = await findApp(home, expected.codex, run, systemApplications);
  const claudeFound = await findApp(home, expected.claude, run, systemApplications);
  const codexApp = codexFound.app, claudeApp = claudeFound.app;
  let codexBinary = null;
  if (codexApp) {
    const packaged = join(codexApp, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
    const flat = join(codexApp, 'Contents', 'Resources', 'codex');
    const bundled = await exists(packaged) ? packaged : flat;
    if (await exists(bundled)) codexBinary = await resolveBundledCodex(bundled, {
      verify: async file => {
        await run('/usr/bin/codesign', ['--verify', '--strict', file]);
        const { stderr = '' } = await run('/usr/bin/codesign', ['-d', '--verbose=2', file]);
        if (!stderr.split('\n').includes('Identifier=codex') || !stderr.split('\n').includes('TeamIdentifier=2DC432GLL2'))
          throw new Error('Bundled Codex CLI has an unexpected publisher.');
      },
    });
  }
  if (!codexBinary || !await versionOf(codexBinary, run, cliEnv)) {
    codexBinary = join(root || '', 'providers', 'codex-cli', 'node_modules', '.bin', 'codex');
    if (!await versionOf(codexBinary, run, cliEnv)) codexBinary = await commandOnPath('codex', env);
  }
  let claudeBinary = join(home, '.local', 'bin', 'claude');
  if (!await versionOf(claudeBinary, run, cliEnv)) {
    claudeBinary = join(root || '', 'providers', 'claude-cli', 'node_modules', '.bin', 'claude');
    if (!await versionOf(claudeBinary, run, cliEnv)) claudeBinary = await commandOnPath('claude', env);
  }
  const codexVersion = await versionOf(codexBinary, run, cliEnv);
  const claudeVersion = await versionOf(claudeBinary, run, cliEnv);
  return {
    codex: { app: codexApp, binary: codexVersion ? codexBinary : null, version: codexVersion,
      ...(codexFound.appIssue ? { appIssue: codexFound.appIssue } : {}) },
    claude: { app: claudeApp, binary: claudeVersion ? claudeBinary : null, version: claudeVersion,
      ...(claudeFound.appIssue ? { appIssue: claudeFound.appIssue } : {}) },
  };
}

async function installCli(name, root, runtime, home, run) {
  if (!absolute(root) || !absolute(runtime)) throw new Error('Private root and runtime paths are required to install a CLI.');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Private root has an untrusted identity.');
  const npm = join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const node = join(runtime, 'bin', 'node');
  await access(npm);
  await access(node, constants.X_OK);
  const providers = join(root, 'providers');
  const prefix = join(providers, `${name}-cli`);
  const cache = join(providers, 'npm-cache');
  for (const path of [providers, prefix, cache]) if (await exists(path)) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private provider directory has an untrusted identity.');
  }
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  const packageName = name === 'codex' ? '@openai/codex@0.158.0-alpha.2.1' : '@anthropic-ai/claude-code@2.1.283';
  const cliEnv = { HOME: home, LANG: process.env.LANG || 'C.UTF-8',
    PATH: `${join(runtime, 'bin')}${delimiter}${process.env.PATH || ''}`,
    npm_config_cache: cache, npm_config_registry: 'https://registry.npmjs.org',
    npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null' };
  await run(node, [npm, 'install', '--prefix', prefix, '--no-audit', '--no-fund', packageName], { cwd: prefix, env: cliEnv });
  const binary = join(prefix, 'node_modules', '.bin', name);
  if (!await versionOf(binary, run, cliEnv)) throw new Error(`Official ${name} CLI package did not provide a working binary.`);
}

export async function ensureProviders(options = {}) {
  let found = await discoverProviders(options);
  if (!found.codex.app || !found.claude.app) {
    for (const name of ['codex', 'claude']) if (!found[name].app)
      found[name].issue = found[name].appIssue
        ?? `${name === 'codex' ? 'ChatGPT/Codex' : 'Claude'} Desktop app is required; install and sign in to the official app before setup.`;
    return found;
  }
  const { root, runtime, home = process.env.HOME, run = execute } = options;
  const issues = {};
  for (const name of ['codex', 'claude']) if (!found[name].binary) {
    try { await installCli(name, root, runtime, home, run); }
    catch (error) { issues[name] = `CLI installation failed: ${error.message}`; }
  }
  found = await discoverProviders(options);
  for (const name of ['codex', 'claude']) if (issues[name]) found[name].issue = issues[name];
  return found;
}

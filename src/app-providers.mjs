import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveBundledCodex } from './codex-app-layout.mjs';

const execute = promisify(execFile);
const expected = {
  codex: { names: ['ChatGPT.app', 'Codex.app'], id: 'com.openai.codex', team: '2DC432GLL2' },
  // Users may run a locally patched Claude build (for example a translation)
  // that keeps the official bundle identifier with a valid ad-hoc seal.
  claude: { names: ['Claude.app'], id: 'com.anthropic.claudefordesktop', team: 'Q6L2SF6YDW', allowLocalResign: true },
};
const absent = error => error?.code === 'ENOENT';
const absolute = path => typeof path === 'string' && path.startsWith('/') && resolve(path) === path;
const exists = async path => {
  try { await lstat(path); return true; }
  catch (error) { if (absent(error)) return false; throw error; }
};

async function signedApp(path, spec, run, signatures) {
  if (!await exists(path)) return false;
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Untrusted app at ${path}`);
  const identity = signatures ? await signatures.identity(path) : null;
  const cached = signatures ? await signatures.lookup(path, spec, identity) : null;
  if (cached) return cached;
  const signature = await verifiedSignature(path, spec, run);
  if (signatures) await signatures.record(path, spec, signature, identity);
  return signature;
}

async function verifiedSignature(path, spec, run) {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
  const { stderr = '' } = await run('/usr/bin/codesign', ['-d', '--verbose=2', path]);
  const lines = stderr.split('\n');
  if (!lines.includes(`Identifier=${spec.id}`)) throw unexpectedPublisher(path);
  if (lines.includes(`TeamIdentifier=${spec.team}`)) return 'vendor';
  // The strict --verify above still proves the local seal covers every file.
  if (spec.allowLocalResign && lines.includes('Signature=adhoc') && lines.includes('TeamIdentifier=not set')) return 'local';
  throw unexpectedPublisher(path);
}
const unexpectedPublisher = path => Object.assign(new Error(`Unexpected publisher for ${path}`), { code: 'CLAUDEX_UNEXPECTED_PUBLISHER' });

// An unaccepted bundle is never skipped in favor of another copy. It blocks
// only its own provider, so unrelated prerequisites keep reporting their real
// state instead of appearing uninstalled.
async function findApp(home, spec, run, systemApplications, signatures) {
  for (const directory of [join(home, 'Applications'), systemApplications]) {
    for (const name of spec.names) {
      const path = join(directory, name);
      try {
        const signature = await signedApp(path, spec, run, signatures);
        if (signature) return { app: path, ...(signature === 'local' ? { appSignature: 'local' } : {}) };
      }
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
  run = execute, systemApplications = '/Applications', signatures = null } = {}) {
  if (!absolute(home)) throw new Error('An absolute home directory is required.');
  const cliEnv = { HOME: home, LANG: env.LANG || 'C.UTF-8',
    PATH: absolute(runtime) ? `${join(runtime, 'bin')}${delimiter}${env.PATH || ''}` : env.PATH || '' };
  // The two bundles are independent; verify them concurrently but report
  // failures in the same provider order as a sequential inspection.
  const found = await Promise.allSettled([findApp(home, expected.codex, run, systemApplications, signatures),
    findApp(home, expected.claude, run, systemApplications, signatures)]);
  for (const result of found) if (result.status === 'rejected') throw result.reason;
  if (signatures) await signatures.save();
  const [codexFound, claudeFound] = found.map(result => result.value);
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
  // Each candidate's --version result selects it and is reported directly,
  // instead of starting the selected native CLI a second time.
  const select = async (candidates, command) => {
    for (const binary of candidates) {
      const version = binary ? await versionOf(binary, run, cliEnv) : null;
      if (version) return [binary, version];
    }
    const binary = await commandOnPath(command, env);
    return [binary, await versionOf(binary, run, cliEnv)];
  };
  const [[codexSelected, codexVersion], [claudeSelected, claudeVersion]] = await Promise.all([
    select([codexBinary, join(root || '', 'providers', 'codex-cli', 'node_modules', '.bin', 'codex')], 'codex'),
    select([join(home, '.local', 'bin', 'claude'), join(root || '', 'providers', 'claude-cli', 'node_modules', '.bin', 'claude')], 'claude'),
  ]);
  codexBinary = codexSelected;
  const claudeBinary = claudeSelected;
  return {
    codex: { app: codexApp, binary: codexVersion ? codexBinary : null, version: codexVersion,
      ...(codexFound.appIssue ? { appIssue: codexFound.appIssue } : {}) },
    claude: { app: claudeApp, binary: claudeVersion ? claudeBinary : null, version: claudeVersion,
      ...(claudeFound.appIssue ? { appIssue: claudeFound.appIssue } : {}),
      ...(claudeFound.appSignature ? { appSignature: claudeFound.appSignature } : {}) },
  };
}

async function installCli(name, root, runtime, home, run) {
  if (!absolute(root) || !absolute(runtime)) throw new Error('Private root and runtime paths are required to install a CLI.');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o022))
    throw new Error('Private root has an untrusted identity.');
  const npm = join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const node = join(runtime, 'bin', 'node');
  await access(npm);
  await access(node, constants.X_OK);
  const providers = join(root, 'providers');
  const prefix = join(providers, `${name}-cli`);
  const cache = join(providers, 'npm-cache');
  for (const path of [providers, prefix, cache]) if (await exists(path)) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022))
      throw new Error('Private provider directory has an untrusted identity.');
  }
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  // npm rejects a file loaded as both user and global configuration. Keep two
  // different empty files instead of /dev/null, without inheriting ~/.npmrc or
  // any credentials, scripts, or settings from an existing provider directory.
  const configDirectory = join(providers, 'npm-config');
  try { await mkdir(configDirectory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const configStat = await lstat(configDirectory);
  if (!configStat.isDirectory() || configStat.isSymbolicLink() || configStat.uid !== process.getuid() || (configStat.mode & 0o077))
    throw new Error('Private npm configuration directory has an untrusted identity.');
  const userconfig = join(configDirectory, 'user.npmrc'), globalconfig = join(configDirectory, 'global.npmrc');
  await emptyNpmConfig(userconfig);
  await emptyNpmConfig(globalconfig);
  await emptyNpmConfig(join(prefix, '.npmrc'));
  const packageName = name === 'codex' ? '@openai/codex@0.158.0-alpha.2.1' : '@anthropic-ai/claude-code@2.1.283';
  const cliEnv = { HOME: home, LANG: process.env.LANG || 'C.UTF-8',
    PATH: `${join(runtime, 'bin')}${delimiter}${process.env.PATH || ''}`,
    npm_config_cache: cache, npm_config_registry: 'https://registry.npmjs.org',
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig };
  await run(node, [npm, 'install', '--prefix', prefix, '--no-audit', '--no-fund', packageName], { cwd: prefix, env: cliEnv });
  const binary = join(prefix, 'node_modules', '.bin', name);
  if (!await versionOf(binary, run, cliEnv)) throw new Error(`Official ${name} CLI package did not provide a working binary.`);
}

async function emptyNpmConfig(path) {
  let file;
  try { file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n
      || (before.mode & 0o777n) !== 0o600n || before.size !== 0n)
      throw new Error('Private npm configuration must be an empty owned regular file with mode 0600 and one link.');
    const contents = await file.readFile(), after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (contents.length || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'].some(key => before[key] !== after[key] || after[key] !== named[key]))
      throw new Error('Private npm configuration changed during verification.');
  } finally { await file.close(); }
}

export async function ensureProviders(options = {}) {
  let found = await discoverProviders(options);
  if (!found.codex.app || !found.claude.app) {
    for (const name of ['codex', 'claude']) if (!found[name].app)
      found[name].issue = found[name].appIssue
        ?? `${name === 'codex' ? 'ChatGPT/Codex' : 'Claude'} Desktop app is required; install and sign in to the official app before setup.`;
    return found;
  }
  if (found.codex.binary && found.claude.binary) return found;
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

import { mkdir, readFile, writeFile, copyFile, lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { absolute, insist } from './claude-mod-protocol.mjs';
const SOURCE = fileURLToPath(new URL('..', import.meta.url));
export const MOD_STAGE_FILES = [
  'plugins/claudex/.claude-plugin/plugin.json', 'plugins/claudex/hooks/hooks.json',
  'plugins/claudex/hooks/register.mjs', 'plugins/claudex/hooks/controller.mjs',
  'plugins/claudex/hooks/panel.mjs', 'plugins/claudex/hooks/localization.mjs',
  'plugins/claudex/hooks/locales.mjs',
  'plugins/claudex/hooks/delivery.mjs',
  'plugins/claudex/hooks/cache-warm.mjs',
  'plugins/claudex/tests/native.test.ts', 'plugins/claudex/README.md',
  'plugins/claudex/skills/claudex-workflow/SKILL.md',
  'plugins/claudex/skills/warm/SKILL.md',
  'bin/claudex-mod-bridge.mjs', 'src/claude-mod-bridge.mjs',
  'src/claude-mod-storage.mjs', 'src/claude-mod-protocol.mjs',
  'src/claude-mod-wake-outbox.mjs', 'src/claude-mod-self-inbox.mjs',
  'src/collaboration-transport.mjs', 'src/collaboration-effort.mjs', 'src/collaboration-outcome.mjs',
  'src/collaboration-notification-policy.mjs', 'src/collaboration-wait.mjs', 'src/collaboration-worker-boundary.mjs', 'src/app-stop-state.mjs',
];
function targetOf(file) { return file.startsWith('plugins/claudex/') ? file.slice('plugins/claudex/'.length) : `runtime/${file}`; }
/** Validate the data literal without evaluating a candidate's JavaScript. */
export function validateModCatalogSource(source) {
  insist(typeof source === 'string' && source.length <= 1024 * 1024,
    'MOD_LOCALES', 'Mod catalogs exceed the source bound.');
  const literal = source.match(/const rows = (\{[\s\S]*\});\n\nconst languages/);
  let rows;
  try { rows = JSON.parse(literal?.[1] ?? ''); } catch {
    insist(false, 'MOD_LOCALES', 'Mod catalogs must contain the complete static translation table.');
  }
  insist(rows && !Array.isArray(rows) && Object.keys(rows).length > 0,
    'MOD_LOCALES', 'Mod catalogs must not be empty.');
  const placeholders = value => JSON.stringify((value.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g) ?? []).sort());
  for (const [key, values] of Object.entries(rows)) {
    insist(key.trim() && Array.isArray(values) && values.length === 8,
      'MOD_LOCALES', `Mod catalog requires all eight translations: ${key}`);
    for (const value of values) insist(typeof value === 'string' && value.trim()
      && placeholders(value) === placeholders(key), 'MOD_LOCALES', `Invalid Mod translation or placeholder: ${key}`);
  }
  return rows;
}
/** Stage only into a new user-selected directory. No settings, services or apps are modified. */
export async function stageClaudeMod({ output, stateRoot, nodeBinary = process.execPath,
  repoRoot = SOURCE, nativeWake = false, selfWake = false } = {}) {
  absolute(output); absolute(stateRoot); absolute(nodeBinary);
  output = resolve(output);
  const parent = await realpath(dirname(output));
  insist(join(parent, output.slice(output.lastIndexOf('/') + 1)) === output, 'STAGE_PATH', 'Use a canonical stage parent directory.');
  const root = await realpath(stateRoot), node = await realpath(nodeBinary);
  insist(root === stateRoot, 'STAGE_PATH', 'Use the canonical state root shown by realpath.');
  const stateInfo = await lstat(root);
  insist(stateInfo.isDirectory() && stateInfo.uid === process.getuid() && (stateInfo.mode & 0o777) === 0o700,
    'UNSAFE_ROOT', 'The existing Claudex root must be owner-private 0700.');
  const nodeInfo = await lstat(node);
  insist(nodeInfo.isFile() && (nodeInfo.mode & 0o022) === 0, 'UNSAFE_RUNTIME', 'Select a trusted regular Node executable without group/world write permission.');
  await access(node, constants.X_OK);
  // Validate every source before creating a destination; never follow source symlinks.
  const sources = [];
  for (const file of MOD_STAGE_FILES) {
    let parent = repoRoot;
    for (const part of file.split('/').slice(0, -1)) {
      parent = join(parent, part);
      const info = await lstat(parent);
      insist(info.isDirectory() && !info.isSymbolicLink(), 'STAGE_SOURCE', `Unsafe stage source directory: ${parent}`);
    }
    const path = join(repoRoot, file), stat = await lstat(path);
    insist(stat.isFile() && !stat.isSymbolicLink(), 'STAGE_SOURCE', `Missing or unsafe stage source: ${file}`);
    sources.push({ file, path });
  }
  validateModCatalogSource(await readFile(join(repoRoot, 'plugins/claudex/hooks/locales.mjs'), 'utf8'));
  await mkdir(output, { mode: 0o700 }); // EEXIST intentionally refuses replacement.
  const plugin = join(output, 'plugins', 'claudex');
  const hashes = {};
  for (const { file, path } of sources) {
    const relative = targetOf(file), destination = join(plugin, relative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(path, destination, constants.COPYFILE_EXCL);
  }
  const manifestPath = join(plugin, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.userConfig.stateRoot.default = root;
  manifest.userConfig.nodeBinary.default = node;
  manifest.userConfig.nativeWake.default = nativeWake === true;
  manifest.userConfig.selfWake.default = selfWake === true;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  for (const { file } of sources) {
    const relative = targetOf(file);
    hashes[relative] = createHash('sha256').update(await readFile(join(plugin, relative))).digest('hex');
  }
  await mkdir(join(output, '.claude-plugin'), { mode: 0o700 });
  await writeFile(join(output, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({
    name: 'claudex-local', owner: { name: 'Claudex local installation' },
    plugins: [{ name: 'claudex', source: './plugins/claudex', description: manifest.description, version: manifest.version }],
  }, null, 2)}\n`, { mode: 0o600 });
  const report = { version: 1, plugin, marketplace: output, stateRoot: root, nodeBinary: node,
    documentedModBaseline: '2.1.287', versionLoadGate: false, nativeWake: nativeWake === true, selfWake: selfWake === true, hashes,
    nativeValidation: 'required', synchronizationPolicy: 'unchanged', automaticInstallation: false };
  await writeFile(join(output, 'stage-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

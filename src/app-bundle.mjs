import { spawn } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { validateModCatalogSource } from './claude-mod-install.mjs';

export const APP_IDENTIFIER = 'dev.0ruka.claudex.app';
export const APP_ICON_FILE = 'Claudex.icns';
export const APP_LOCALES = Object.freeze(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'es', 'de', 'fr', 'it']);
export const ENGINE_BIN = Object.freeze([
  'claudex-app.mjs', 'claudex-codex.mjs', 'claudex-collaboration.mjs', 'claudex-service.mjs', 'claudex.mjs',
  'claudex-sync-hook.mjs', 'claudex-mod.mjs', 'claudex-mod-bridge.mjs',
  'claudex-codex-warm-hook.mjs',
]);
export const ENGINE_PLUGIN_FILES = Object.freeze([
  'plugins/claudex/.claude-plugin/plugin.json',
  'plugins/claudex/hooks/hooks.json',
  'plugins/claudex/hooks/register.mjs',
  'plugins/claudex/hooks/controller.mjs',
  'plugins/claudex/hooks/panel.mjs',
  'plugins/claudex/hooks/localization.mjs',
  'plugins/claudex/hooks/locales.mjs',
  'plugins/claudex/hooks/delivery.mjs',
  'plugins/claudex/hooks/cache-warm.mjs',
  'plugins/claudex/hooks/cache-warm-display.mjs',
  'plugins/claudex/tests/native.test.ts',
  'plugins/claudex/README.md',
  'plugins/claudex/skills/claudex-workflow/SKILL.md',
  'plugins/claudex/skills/warm/SKILL.md',
]);
export const ENGINE_SRC = Object.freeze([
  'cache-warm.mjs',
  'codex-cache-warm.mjs', 'codex-cache-native.mjs', 'codex-cache-usage.mjs',
  'codex-warm-command.mjs',
  'claude-mod-bridge.mjs', 'claude-mod-install.mjs', 'claude-mod-protocol.mjs', 'claude-mod-storage.mjs',
  'claude-mod-wake-outbox.mjs', 'claude-mod-self-inbox.mjs', 'mod-wake-broker.mjs',
  'app-setup.mjs', 'app-providers.mjs', 'app-signature-cache.mjs', 'app-login.mjs',
  'app-mod.mjs', 'app-mod-runtime.mjs',
  'base64.mjs', 'bridge.mjs', 'chat-mailbox.mjs', 'chat-titles.mjs', 'claude-desktop-handoff-runtime.mjs', 'claude-desktop-handoff.mjs',
  'codex-chat-wake.mjs', 'native-chat-catalog.mjs', 'claude-chat-wake-manifest.mjs',
  'claude-chat-wake-runtime.mjs', 'claude-desktop-wake-install.mjs', 'claude-chat-wake-cache.mjs',
  'claude-owner-wake.mjs', 'claude-owner-wake-runtime.mjs', 'claude-owner-wake-cache.mjs',
  'claude-frontend-anchors.mjs', 'claude-frontend-scope.mjs', 'claude-frontend-graph.mjs', 'claude-renderer-adapters.mjs', 'claude-renderer-maintenance.mjs',
  'claude-folder-anchor.mjs', 'claude-folder-cache.mjs', 'claude-folder-install.mjs',
  'claude-folder-map.mjs', 'claude-folder-projection.mjs', 'claude-folder-runtime.mjs', 'claude-folder-presentation-cache.mjs',
  'claude-fork.mjs', 'claude-image-assets.mjs', 'claude-owner.mjs', 'claude-parallel-tools.mjs', 'claude-relocation.mjs', 'claude.mjs',
  'codex-app-layout.mjs', 'codex-delegation.mjs', 'codex-desktop-relaunch.mjs', 'claude-desktop-relaunch.mjs', 'codex-dependencies.mjs', 'codex-original-archive-tree.mjs',
  'codex-projection.mjs', 'codex-versions.mjs', 'codex-websocket.mjs', 'codex.mjs',
  'cold-import.mjs', 'cold-verification-cache.mjs', 'collaboration-hub.mjs', 'collaboration-install.mjs',
  'collaboration-events.mjs', 'collaboration-artifacts.mjs', 'collaboration-progress.mjs',
  'collaboration-notification-policy.mjs', 'collaboration-worker-boundary.mjs',
  'collaboration-native.mjs', 'collaboration-activity.mjs', 'collaboration-outcome.mjs', 'collaboration-origin.mjs', 'collaboration-notifications.mjs', 'collaboration-processes.mjs', 'collaboration-transport.mjs', 'collaboration-wait.mjs', 'collaboration-effort.mjs', 'collaboration-workspace.mjs', 'app-stop-state.mjs', 'compaction.mjs',
  'context-archive.mjs', 'context-packet-reader.mjs', 'context-packet.mjs',
  'desktop-bridge.mjs', 'desktop-enrollment.mjs', 'desktop-install.mjs', 'desktop-original-split.mjs', 'desktop-runtime.mjs',
  'desktop-shutdown.mjs', 'desktop-watch-hints.mjs', 'desktop-watch.mjs',
  'desktop.mjs', 'discovery.mjs', 'history.mjs', 'maintenance-policy.mjs',
  'native-drivers.mjs', 'native-history.mjs', 'native-history-order.mjs', 'native-late-items.mjs',
  'native-local-images.mjs', 'native-goal-request.mjs', 'native-empty-turn.mjs',
  'owned-claude-history.mjs', 'owned-codex-history.mjs', 'retention.mjs',
  'runtime-version-policy.mjs', 'service-supervisor.mjs', 'service.mjs',
  'status-app-install.mjs', 'storage.mjs', 'verification-observations.mjs',
  'sync-events.mjs', 'sync-event-source.mjs', 'sync-hook-install.mjs',
]);

export async function runCommand(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? done({ stdout, stderr }) : fail(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`)));
  });
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function requireRegular(path) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Expected regular file: ${path}`);
}

async function ensureAbsent(path) {
  try { await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Destination already exists: ${path}`);
}

export async function buildAppIcon(sourceRoot, resources, stageRoot, run = runCommand) {
  const source = join(sourceRoot, 'native', 'ClaudexApp', 'Assets', 'AppIcon.png');
  await requireRegular(source);
  const iconset = join(stageRoot, 'Claudex.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      await run('/usr/bin/sips', ['-z', pixels, pixels, source, '--out',
        join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
    }
  }
  const destination = join(resources, APP_ICON_FILE);
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', destination]);
  await requireRegular(destination);
  return destination;
}

function plist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key><string>${APP_IDENTIFIER}</string>\n<key>CFBundleExecutable</key><string>ClaudexApp</string>\n<key>CFBundleName</key><string>Claudex</string>\n<key>CFBundleDisplayName</key><string>Claudex</string>\n<key>CFBundleIconFile</key><string>${APP_ICON_FILE}</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>${xml(version)}</string>\n<key>CFBundleVersion</key><string>${xml(version)}</string>\n<key>LSMinimumSystemVersion</key><string>13.0</string>\n<key>NSHighResolutionCapable</key><true/>\n</dict></plist>\n`;
}

export async function copyAllowed(sourceRoot, engine) {
  for (const group of [['bin', ENGINE_BIN], ['src', ENGINE_SRC]]) {
    const [folder, names] = group;
    await mkdir(join(engine, folder), { recursive: true });
    for (const name of names) {
      const source = join(sourceRoot, folder, name);
      await requireRegular(source);
      await copyFile(source, join(engine, folder, name));
    }
  }
  // Keep plugin templates and their validation fixtures with the packaged
  // engine so its standalone Mod stager works after the checkout is removed.
  // This copies a fixed allowlist; it never installs or enables the plugin.
  for (const name of ENGINE_PLUGIN_FILES) {
    const source = join(sourceRoot, name);
    let parent = sourceRoot;
    for (const part of name.split('/').slice(0, -1)) {
      parent = join(parent, part);
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Unsafe plugin source directory: ${parent}`);
    }
    await requireRegular(source);
    const destination = join(engine, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  for (const name of ['package.json', 'package-lock.json']) {
    const source = join(sourceRoot, name);
    await requireRegular(source);
    await copyFile(source, join(engine, name));
  }
  validateModCatalogSource(await readFile(join(engine, 'plugins/claudex/hooks/locales.mjs'), 'utf8'));
}

async function nativeObjects(root) {
  const results = [];
  async function isMachO(path) {
    const file = await open(path, 'r');
    try {
      const magic = Buffer.alloc(4);
      const { bytesRead } = await file.read(magic, 0, 4, 0);
      return bytesRead === 4 && ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic.toString('hex'));
    } finally { await file.close(); }
  }
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === '.bin' && directory === root && entry.isDirectory()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink()) throw new Error(`Symlink in installed dependencies: ${path}`);
      else if (entry.isFile() && await isMachO(path)) results.push(path);
    }
  }
  await visit(root);
  return results;
}

async function verifyPortableBinary(binary, arch, run) {
  const architecture = await run('/usr/bin/lipo', ['-archs', binary]);
  if (!architecture.stdout.split(/\s+/).includes(arch)) throw new Error(`Binary lacks ${arch} architecture: ${binary}`);
  const links = await run('/usr/bin/otool', ['-L', binary]);
  for (const dependency of links.stdout.split('\n').slice(1).map(line => line.trim().split(/\s+/)[0]).filter(Boolean)) {
    if (!dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')) {
      throw new Error(`Binary depends on a non-system library: ${dependency}`);
    }
  }
}

async function verifyNodeCacheAPIs(binary, run) {
  const probe = await run(binary, ['--input-type=module', '-e',
    'import * as zlib from "node:zlib"; console.log(JSON.stringify({crc32:typeof zlib.crc32,zstdCompressSync:typeof zlib.zstdCompressSync,zstdDecompressSync:typeof zlib.zstdDecompressSync}))']);
  let features;
  try { features = JSON.parse(probe.stdout); } catch { /* Rejected below. */ }
  if (!features || ['crc32', 'zstdCompressSync', 'zstdDecompressSync'].some(key => features[key] !== 'function'))
    throw new Error('Portable Node runtime requires Zstandard and CRC32 APIs; use Node.js 22.15+ (22.x) or 23.8+.');
}

export async function buildClaudexApp({
  sourceRoot, destination, nodeDistribution, identity, zip, arch = 'arm64',
  run = runCommand,
}) {
  if (process.platform !== 'darwin') throw new Error('macOS is required to build Claudex.app');
  if (!sourceRoot || !destination || !nodeDistribution || !identity) throw new Error('sourceRoot, destination, nodeDistribution, and signing identity are required');
  if (![sourceRoot, destination, nodeDistribution, ...(zip ? [zip] : [])].every(isAbsolute)) throw new Error('All paths must be absolute');
  if (!['arm64', 'x86_64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);
  if (!destination.endsWith('.app')) throw new Error('Destination must end in .app');
  const source = resolve(sourceRoot);
  const output = resolve(destination);
  const distribution = resolve(nodeDistribution);
  if (output === source || output.startsWith(`${source}${sep}`)) throw new Error('Destination must be outside the repository');
  await ensureAbsent(output);
  if (zip) await ensureAbsent(resolve(zip));
  const nodeSource = join(distribution, 'bin', 'node');
  const npmSource = join(distribution, 'lib', 'node_modules', 'npm');
  await requireRegular(nodeSource);
  await requireRegular(join(npmSource, 'bin', 'npm-cli.js'));
  await requireRegular(join(distribution, 'LICENSE'));
  await verifyPortableBinary(nodeSource, arch, run);
  await verifyNodeCacheAPIs(nodeSource, run);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const stageRoot = await mkdtemp(join(dirname(output), '.claudex-app-'));
  const app = join(stageRoot, 'Claudex.app');
  try {
    const contents = join(app, 'Contents');
    const resources = join(contents, 'Resources');
    const runtime = join(resources, 'runtime');
    const engine = join(resources, 'engine');
    const macos = join(contents, 'MacOS');
    await mkdir(join(runtime, 'bin'), { recursive: true });
    await mkdir(join(runtime, 'lib', 'node_modules'), { recursive: true });
    await mkdir(macos, { recursive: true });
    await mkdir(engine, { recursive: true });
    await copyFile(nodeSource, join(runtime, 'bin', 'node'));
    await cp(npmSource, join(runtime, 'lib', 'node_modules', 'npm'), { recursive: true, dereference: false });
    await symlink('../lib/node_modules/npm/bin/npm-cli.js', join(runtime, 'bin', 'npm'));
    await copyFile(join(distribution, 'LICENSE'), join(runtime, 'LICENSE'));
    await copyAllowed(source, engine);
    await buildAppIcon(source, resources, stageRoot, run);
    await mkdir(join(resources, 'Locales'));
    const base = JSON.parse(await readFile(join(source, 'native', 'ClaudexApp', 'Locales', 'en.json'), 'utf8'));
    for (const language of APP_LOCALES) {
      const catalogPath = join(source, 'native', 'ClaudexApp', 'Locales', `${language}.json`);
      await requireRegular(catalogPath);
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      if (JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(Object.keys(base).sort())
        || Object.values(catalog).some(value => typeof value !== 'string' || !value.trim()))
        throw new Error(`Incomplete UI translation: ${language}`);
      for (const [key, value] of Object.entries(catalog)) {
        if ((key.match(/%@/g) ?? []).length !== (value.match(/%@/g) ?? []).length
          || value.replaceAll('%@', '').includes('%')) throw new Error(`Invalid UI translation placeholder: ${language}`);
      }
      await copyFile(catalogPath, join(resources, 'Locales', `${language}.json`));
    }
    await run(join(runtime, 'bin', 'node'), [join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: engine,
      env: { ...process.env, PATH: `${join(runtime, 'bin')}:${process.env.PATH || '/usr/bin:/bin'}`, npm_config_cache: join(stageRoot, 'npm-cache') },
    });
    await run(join(runtime, 'bin', 'node'), [join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'ls', '--omit=dev', '--depth=0'], { cwd: engine });
    await writeFile(join(contents, 'Info.plist'), plist(manifest.version));
    await writeFile(join(stageRoot, 'node-entitlements.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>');
    const swiftSources = ['main.swift', 'SetupModel.swift', 'StatusController.swift', 'Localization.swift'].map(name => join(source, 'native', 'ClaudexApp', name));
    swiftSources.push(join(source, 'native', 'ClaudexStatus', 'StatusModel.swift'));
    for (const swiftSource of swiftSources) await requireRegular(swiftSource);
    await run('/usr/bin/xcrun', ['swiftc', ...swiftSources, '-framework', 'Cocoa', '-framework', 'UserNotifications', '-target', `${arch}-apple-macos13.0`, '-o', join(macos, 'ClaudexApp')]);
    const binaries = [join(runtime, 'bin', 'node'), ...await nativeObjects(join(runtime, 'lib', 'node_modules', 'npm')), ...await nativeObjects(join(engine, 'node_modules'))];
    for (const binary of binaries.slice(1)) await verifyPortableBinary(binary, arch, run);
    for (const binary of binaries) {
      const args = ['--force', '--sign', identity, '--options', 'runtime'];
      if (binary === binaries[0]) args.push('--entitlements', join(stageRoot, 'node-entitlements.plist'));
      await run('/usr/bin/codesign', [...args, binary]);
    }
    await run('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', app]);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    if (zip) await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, resolve(zip)]);
    await ensureAbsent(output);
    await rename(app, output);
    return { app: output, zip: zip ? resolve(zip) : null, identity, architecture: arch, notarized: false };
  } catch (error) {
    error.message = `${error.message}\nStaging preserved at: ${stageRoot}`;
    throw error;
  }
}

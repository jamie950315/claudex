import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeVersionPolicy, readVersionPolicy, runtimeVersionPermitted } from '../src/runtime-version-policy.mjs';
import { isAllowedCodexVersion, isSupportedCodexVersion } from '../src/codex-versions.mjs';
import { nativeDrivers } from '../src/native-drivers.mjs';

test('warn is explicit and does not relabel unknown versions as verified or bypass malformed metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-version-policy-'));
  assert.equal(await readVersionPolicy(root), 'strict');
  assert.equal(normalizeVersionPolicy(), 'strict');
  assert.throws(() => normalizeVersionPolicy('silent'), /strict or warn/);
  assert.equal(isAllowedCodexVersion('codex-cli 99.0.0', 'strict'), false);
  assert.equal(isAllowedCodexVersion('codex-cli 99.0.0', 'warn'), true);
  assert.equal(isSupportedCodexVersion('codex-cli 99.0.0'), false);
  for (const value of [null, '', 'a\nb', 'x'.repeat(161)]) assert.equal(runtimeVersionPermitted(value, 'known', 'warn'), false);
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, versionPolicy: 'warn' }));
  assert.equal(await readVersionPolicy(root), 'warn');
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, versionPolicy: 'invalid' }));
  await assert.rejects(readVersionPolicy(root), /strict or warn/);
});

test('legacy adapters attempt unknown Codex and Claude versions only with warn policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-version-policy-native-'));
  const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  await mkdir(codexHome); await mkdir(claudeHome);
  const binary = join(root, 'fake-codex'), claudeBinary = join(root, 'fake-claude');
  for (const [path, value] of [[binary, 'codex-cli 99.0.0'], [claudeBinary, '9.9.9 (Claude Code)']])
    await writeFile(path, `#!${process.execPath}\nif(process.argv[2]!=='--version') throw Error('No native work is allowed in this fixture');\nconsole.log(${JSON.stringify(value)});\n`, { mode: 0o700 });
  const options = { root: join(root, 'state'), codexHome, claudeHome, binary, claudeBinary, desktopHome: null };
  await assert.rejects(nativeDrivers(options), /version changed/);
  const native = await nativeDrivers({ ...options, versionPolicy: 'warn' });
  assert.ok(native.drivers.codex && native.drivers.claude);
  await native.close();
});

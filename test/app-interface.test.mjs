import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('first launch opens settings automatically, while later background starts stay quiet',
  { skip: process.platform !== 'darwin' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudex-settings-policy-'));
    const main = join(directory, 'main.swift'), binary = join(directory, 'check');
    await writeFile(main, `import Foundation
for background in [false, true] {
  let first = SetupLaunchPolicy(background: background, inspectOnly: false, hasPresentedSettings: false, hasPriorSetup: false)
  precondition(first.showSettings && first.startSetup)
  for (seen, prior) in [(true, false), (false, true), (true, true)] {
    let later = SetupLaunchPolicy(background: background, inspectOnly: false, hasPresentedSettings: seen, hasPriorSetup: prior)
    precondition(later.showSettings == !background && !later.startSetup)
  }
  let inspect = SetupLaunchPolicy(background: background, inspectOnly: true, hasPresentedSettings: false, hasPriorSetup: false)
  precondition(inspect.showSettings == !background && !inspect.startSetup)
}
print("Settings launch policy passed")
`);
    const run = promisify(execFile);
    await run('/usr/bin/xcrun', ['swiftc', new URL('../native/ClaudexApp/SetupModel.swift', import.meta.url).pathname, main, '-o', binary]);
    assert.match((await run(binary)).stdout, /Settings launch policy passed/);
  });

test('settings owns retry setup; menus only expose the settings entry', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /addMenu\(menu, "Retry setup"|"Open setup…"/);
  assert.match(source, /NSButton\(title: "Retry setup", target: self, action: #selector\(retrySetup\(_:\)\)\)/);
  assert.match(source, /if !inspectOnly && !uiSmoke \{ UserDefaults.standard.set\(true, forKey: settingsPresentedKey\) \}/);
  assert.match(source, /if launch.showSettings \{ showSetup\(nil\) \}/);
});

test('graphical app owns one status item and integrates the bounded health controller', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  const controller = await readFile(new URL('../native/ClaudexApp/StatusController.swift', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../src/app-bundle.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/NSStatusBar\.system\.statusItem\(/g) || []).length, 1);
  assert.doesNotMatch(controller, /NSStatusBar\.system\.statusItem|NSApplication\.shared|app\.run\(/);
  assert.match(source, /health\.start\(item: statusItem\)/);
  assert.match(source, /runningApplications\(withBundleIdentifier:/);
  for (const action of ['showSetup', 'showDiagnostics', 'notifications']) {
    assert.match(source, new RegExp(`#selector\\(${action}\\(_:\\)\\)`));
  }
  assert.match(controller, /report = loadHealth\(root\)/);
  assert.match(controller, /guard !readOnly else \{ return \}/);
  assert.match(controller, /gate\.event\(for: report/);
  assert.match(builder, /StatusController\.swift/);
  assert.match(builder, /ClaudexStatus', 'StatusModel\.swift/);
  assert.equal((source.match(/NSWindow\(contentRect:/g) || []).length, 1);
  assert.doesNotMatch(controller, /NSWindow\(|showStatus|windowWillClose/);
  assert.doesNotMatch(source, /"Open status…"|"Settings…"|Claudex Status|Claudex Settings/);
  assert.match(source, /"Open Claudex…"/);
  assert.match(source, /health\.onOpen =/);
  assert.match(controller, /self\.onOpen\?\(\)/);
});

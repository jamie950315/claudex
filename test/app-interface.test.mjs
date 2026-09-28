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
let components = ["codex-cli", "codex-login", "codex-desktop", "claude-cli", "claude-login", "claude-desktop"].map {
    SetupComponent(id: $0, label: $0, state: .ready, detail: "Verified", action: .retry)
}
let ready = SetupReport(version: 1, phase: .ready, allProjects: true, allowWrite: true, components: components, message: nil)
precondition(ready.attentionComponents.isEmpty && ready.connectionSummaries.count == 2)
precondition(!ready.needsSetupRetry)
precondition(ready.connectionSummaries.allSatisfy { $0.state == .ready && $0.detail == "Ready to connect" })
precondition(ready.connectionSummaries[0].action == .openCodex && ready.connectionSummaries[1].action == .openClaude)
let missing = SetupReport(version: 1, phase: .needsAction, allProjects: true, allowWrite: true,
    components: components.filter { $0.id != "claude-login" } + [SetupComponent(id: "claude-login", label: "Claude", state: .loginRequired, detail: "Sign in required", action: .loginClaude)], message: nil)
precondition(missing.attentionComponents.count == 1)
precondition(missing.connectionSummaries[1].state == .loginRequired)
precondition(missing.connectionSummaries[1].action == nil)
precondition(missing.needsSetupRetry)
let blocked = SetupReport(version: 1, phase: .blocked, allProjects: true, allowWrite: true,
    components: components + [SetupComponent(id: "synchronization", label: "Conversation synchronization", state: .blocked,
       detail: "Nonlinear history", action: .diagnostics)], message: nil)
precondition(blocked.attentionComponents.count == 1 && !blocked.needsSetupRetry)
let installationFailure = SetupReport(version: 1, phase: .blocked, allProjects: true, allowWrite: true,
    components: blocked.components + [SetupComponent(id: "interface", label: "Claudex application", state: .blocked,
       detail: "Installation failed", action: .retry)], message: nil)
precondition(installationFailure.needsSetupRetry)
let diagnosticData = try! JSONSerialization.data(withJSONObject: ["version": 1, "phase": "blocked", "allProjects": true,
    "allowWrite": true, "components": [["id": "synchronization", "label": "Conversation synchronization", "state": "blocked",
    "detail": "Nonlinear history", "action": "diagnostics"]]])
precondition(!(try! SetupReport.parse(diagnosticData)).needsSetupRetry)
let incomplete = SetupReport(version: 1, phase: .waiting, allProjects: true, allowWrite: true, components: [], message: nil)
precondition(incomplete.connectionSummaries.allSatisfy { $0.state == .waiting })
`);
    const run = promisify(execFile);
    await run('/usr/bin/xcrun', ['swiftc', new URL('../native/ClaudexApp/SetupModel.swift', import.meta.url).pathname, main, '-o', binary]);
    assert.match((await run(binary)).stdout, /Settings launch policy passed/);
  });

test('settings owns retry setup; menus only expose the settings entry', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /addMenu\(menu, "Retry setup"|"Open setup…"/);
  assert.match(source, /NSButton\(title: L\("Retry setup"\), target: self, action: #selector\(retrySetup\(_:\)\)\)/);
  assert.match(source, /if !inspectOnly && !uiSmoke \{ UserDefaults.standard.set\(true, forKey: settingsPresentedKey\) \}/);
  assert.match(source, /if launch.showSettings \{ showSetup\(nil\) \}/);
});

test('graphical Quit waits for verified service shutdown and read-only exits bypass it', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  assert.match(source, /func applicationShouldTerminate/);
  assert.match(source, /allowTermination \|\| inspectOnly \|\| uiSmoke/);
  assert.match(source, /runner.stop\(statusOnly: statusOnly\)/);
  assert.match(source, /if result.stopped/);
  assert.match(source, /checkStop\(statusOnly: true\)/);
  assert.doesNotMatch(source, /Quit Claudex \(service keeps running\)/);
});

test('graphical app owns one status item and integrates the bounded health controller', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  const controller = await readFile(new URL('../native/ClaudexApp/StatusController.swift', import.meta.url), 'utf8');
  const builder = await readFile(new URL('../src/app-bundle.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/NSStatusBar\.system\.statusItem\(/g) || []).length, 1);
  assert.match(source, /statusItem\(withLength: NSStatusItem.squareLength\)/);
  assert.match(source, /statusItem.button\?\.title = ""/);
  assert.match(controller, /button.title = ""/);
  assert.match(controller, /button.imagePosition = .imageOnly/);
  assert.match(controller, /systemSymbolName: "arrow.left.arrow.right"/);
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
  assert.equal((source.match(/NSScrollView\(\)/g) || []).length, 1);
  assert.doesNotMatch(source, /preferredChecklistHeight|issueScroll|checklistScroll/);
  assert.match(source, /pageScroll\.bottomAnchor\.constraint\(equalTo: content.bottomAnchor\)/);
  assert.match(source, /Show advanced diagnostics/);
});

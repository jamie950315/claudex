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
let ready = SetupReport(version: 1, phase: .ready, allProjects: true, allowWrite: true, components: components, message: nil, modSettings: nil, modInfo: nil)
precondition(ready.attentionComponents.isEmpty && ready.connectionSummaries.count == 2)
precondition(!ready.needsSetupRetry)
precondition(!ready.needsProviderFollowUp)
precondition(ready.connectionSummaries.allSatisfy { $0.state == .ready && $0.detail == "Ready to connect" })
precondition(ready.connectionSummaries[0].action == .openCodex && ready.connectionSummaries[1].action == .openClaude)
let missing = SetupReport(version: 1, phase: .needsAction, allProjects: true, allowWrite: true,
    components: components.filter { $0.id != "claude-login" } + [SetupComponent(id: "claude-login", label: "Claude", state: .loginRequired, detail: "Sign in required", action: .loginClaude)], message: nil, modSettings: nil, modInfo: nil)
precondition(missing.attentionComponents.count == 1)
precondition(missing.connectionSummaries[1].state == .loginRequired)
precondition(missing.connectionSummaries[1].action == nil)
precondition(missing.needsSetupRetry)
precondition(missing.needsProviderFollowUp)
precondition(ready.providerBecameReady(from: missing))
precondition(!ready.providerBecameReady(from: ready))
precondition(!ready.providerBecameReady(from: nil))
let blocked = SetupReport(version: 1, phase: .blocked, allProjects: true, allowWrite: true,
    components: components + [SetupComponent(id: "synchronization", label: "Conversation synchronization", state: .blocked,
       detail: "Nonlinear history", action: .diagnostics)], message: nil, modSettings: nil, modInfo: nil)
precondition(blocked.attentionComponents.count == 1 && !blocked.needsSetupRetry)
precondition(!blocked.needsProviderFollowUp)
let installationFailure = SetupReport(version: 1, phase: .blocked, allProjects: true, allowWrite: true,
    components: blocked.components + [SetupComponent(id: "interface", label: "Claudex application", state: .blocked,
       detail: "Installation failed", action: .retry)], message: nil, modSettings: nil, modInfo: nil)
precondition(installationFailure.needsSetupRetry)
let diagnosticData = try! JSONSerialization.data(withJSONObject: ["version": 1, "phase": "blocked", "allProjects": true,
    "allowWrite": true, "components": [["id": "synchronization", "label": "Conversation synchronization", "state": "blocked",
    "detail": "Nonlinear history", "action": "diagnostics"]]])
precondition(!(try! SetupReport.parse(diagnosticData)).needsSetupRetry)
let incomplete = SetupReport(version: 1, phase: .waiting, allProjects: true, allowWrite: true, components: [], message: nil, modSettings: nil, modInfo: nil)
precondition(incomplete.connectionSummaries.allSatisfy { $0.state == .waiting })
let modWaiting = SetupReport(version: 1, phase: .waiting, allProjects: true, allowWrite: true,
    components: components + [SetupComponent(id: "claude-mod-activation", label: "Claude Mod activation", state: .waiting,
        detail: "Open a new Claude Code session", action: .openClaude)], message: nil, modSettings: nil, modInfo: nil)
precondition(modWaiting.attentionComponents.count == 1 && !modWaiting.needsSetupRetry && !modWaiting.needsProviderFollowUp)
let modMissing = SetupReport(version: 1, phase: .needsAction, allProjects: true, allowWrite: true,
    components: components + [SetupComponent(id: "claude-mod", label: "Claude Mod", state: .missing,
        detail: "Install Claude Mod", action: .modSetup)], message: nil, modSettings: nil, modInfo: nil)
precondition(modMissing.attentionComponents.count == 1 && !modMissing.needsSetupRetry)
precondition(SetupCommand.modSetup().arguments == ["mod-setup"])
precondition(SetupCommand.modSetup(receiver: true).arguments == ["mod-setup", "--receiver", "enabled"])
precondition(SetupCommand.modSetup(receiver: false).arguments == ["mod-setup", "--receiver", "disabled"])
precondition(SetupCommand.modEnable.arguments == ["mod-setup", "--enable"])
var modData: [String: Any] = ["version": 1, "phase": "waiting", "allProjects": true, "allowWrite": true,
    "components": [["id": "claude-mod", "label": "Claude Mod", "state": "missing", "detail": "Install", "action": "mod-setup"]],
    "modSettings": ["nativeWake": false, "selfWake": true],
    "modInfo": ["bundledVersion": "0.6.3", "installedVersion": "0.6.3", "managerVersion": "2.1.287", "loadedVersion": "0.6.2", "reason": "awaiting-mod-load", "route": "mod-self"]]
let parsedMod = try! SetupReport.parse(JSONSerialization.data(withJSONObject: modData))
precondition(parsedMod.modSettings?.nativeWake == false && parsedMod.modSettings?.selfWake == true)
precondition(parsedMod.modInfo?.installedVersion == "0.6.3" && parsedMod.modInfo?.loadedVersion == "0.6.2")
modData["modInfo"] = ["reason": String(repeating: "x", count: 129)]
precondition((try? SetupReport.parse(JSONSerialization.data(withJSONObject: modData))) == nil)
modData.removeValue(forKey: "modInfo")
modData["modSettings"] = ["nativeWake": "true", "selfWake": true]
precondition((try? SetupReport.parse(JSONSerialization.data(withJSONObject: modData))) == nil)
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

test('Claude Mod management is scoped, explicit and disabled in read-only or synthetic UI', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  assert.match(source, /Install or update Claude Mod/);
  assert.match(source, /modSetupButton\?\.isEnabled = !busy && !modelBusy && !stopping && !inspectOnly && !uiSmoke/);
  assert.match(source, /modReceiverButton\?\.isEnabled = modSetupButton\?\.isEnabled == true && settings != nil/);
  assert.match(source, /response == \.alertFirstButtonReturn[\s\S]*run\(\.modSetup\(receiver: enabled\)\)/);
  assert.match(source, /attention\.contains\(where: \{ \$0\.id == component\.id \}\)/);
  assert.match(source, /case 8: installMod\(nil\)/);
});

test('background inspections end after provider setup settles and notification settings are refreshed on the main thread', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  const controller = await readFile(new URL('../native/ClaudexApp/StatusController.swift', import.meta.url), 'utf8');
  assert.match(source, /self\.setupFlowActive = self\.setupFlowActive && self\.report\?\.needsProviderFollowUp == true/);
  assert.match(source, /updateRefreshTimer\(windowVisible: false\)/);
  assert.match(source, /refreshTimer\?\.invalidate\(\)/);
  assert.match(source, /let self, !uiSmoke, !self\.busy/);
  assert.match(source, /Claudex inspection timer: lifecycle ready/);
  assert.match(controller, /func notificationAction[\s\S]*getNotificationSettings \{ settings in\s*DispatchQueue\.main\.async \{\s*self\.permission = settings\.authorizationStatus/);
});

test('graphical Quit waits for verified service shutdown and read-only exits bypass it', async () => {
  const source = await readFile(new URL('../native/ClaudexApp/main.swift', import.meta.url), 'utf8');
  assert.match(source, /func applicationShouldTerminate/);
  assert.match(source, /allowTermination \|\| inspectOnly \|\| uiSmoke/);
  assert.match(source, /runner.stop\(statusOnly: statusOnly\)/);
  assert.match(source, /if result.stopped/);
  assert.match(source, /checkStop\(statusOnly: true\)/);
  // A logout or restart waits for the drain instead of being cancelled.
  assert.match(source, /checkStop\(statusOnly: false\)\s*return \.terminateLater/);
  assert.match(source, /if result\.stopped \{\s*self\.allowTermination = true\s*NSApp\.reply\(toApplicationShouldTerminate: true\)/);
  assert.match(source, /case \.failure\(let error\):\s*NSApp\.reply\(toApplicationShouldTerminate: false\)/);
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

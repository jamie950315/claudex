import Cocoa
import UserNotifications

let arguments = CommandLine.arguments
let rootArgument = arguments.firstIndex(of: "--root").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
let root = rootArgument ?? Bundle.main.object(forInfoDictionaryKey: "ClaudexRoot") as? String ?? ""
if arguments.contains("--diagnose") {
    let data = try JSONEncoder().encode(loadHealth(root))
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

final class StatusApp: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate, NSWindowDelegate {
    let center = UNUserNotificationCenter.current()
    var item: NSStatusItem!
    var timer: Timer?
    var report = loadHealth(root)
    var window: NSWindow?
    var headline: NSTextField?
    var descriptionText: NSTextField?
    var updatedText: NSTextField?
    var recoveryText: NSTextField?
    var permissionText: NSTextField?
    var permission = UNAuthorizationStatus.notDetermined
    var deliveryFailed = false
    var testNotice = ""
    var gate = NoticeGate()
    let defaults = UserDefaults.standard

    func applicationDidFinishLaunching(_ notification: Notification) {
        if FileManager.default.fileExists(atPath: root + "/status-ui/install.lock") { NSApp.terminate(nil); return }
        if let id = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0.processIdentifier != getpid() }) {
            NSApp.terminate(nil); return
        }
        NSApp.setActivationPolicy(.accessory)
        center.delegate = self
        gate.lastIssue = defaults.string(forKey: "lastIssue") ?? ""
        gate.lastNoticeAt = defaults.double(forKey: "lastNoticeAt")
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu(); menu.delegate = self; item.menu = menu
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer!, forMode: .common)
        refreshPermission()
        if !defaults.bool(forKey: "hasLaunched") {
            defaults.set(true, forKey: "hasLaunched")
            showStatus(nil)
            center.getNotificationSettings { settings in
                if settings.authorizationStatus == .notDetermined {
                    self.center.requestAuthorization(options: [.alert, .sound]) { _, _ in self.refreshPermission() }
                }
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showStatus(nil); return true
    }

    func refreshPermission() {
        center.getNotificationSettings { settings in
            DispatchQueue.main.async { self.permission = settings.authorizationStatus; self.updateWindow() }
        }
    }

    func refresh() {
        report = loadHealth(root)
        let labels = ["ready": "Ready", "waiting": "Waiting", "recovering": "Recovering", "paused": "Paused",
                      "offline": "Offline", "unknown": "Check", "stopping": "Stopping", "stopped": "Stopped"]
        if let button = item?.button {
            button.title = " Claudex · " + (labels[report.state] ?? "Check")
            button.image = NSImage(systemSymbolName: report.symbol, accessibilityDescription: report.title)
            button.image?.isTemplate = true
            button.toolTip = report.title + "\n" + report.detail
            button.setAccessibilityLabel("Claudex: " + report.title)
        }
        updateWindow()
        let now = Date().timeIntervalSince1970 * 1000
        if let event = gate.event(for: report, now: now) {
            if permission == .authorized || permission == .provisional {
                let content = UNMutableNotificationContent()
                content.title = event == "recovered" ? "Claudex synchronization restored" : "Claudex needs attention"
                content.body = event == "recovered" ? "The service is running without reported synchronization blocks."
                    : "Synchronization or recovery needs attention. Open Claudex in the menu bar for details. Your histories are preserved."
                // Generic notices never include transcript text, titles, paths, or credentials.
                let sentIssue = gate.lastIssue, sentAt = gate.lastNoticeAt
                center.add(UNNotificationRequest(identifier: "claudex-health", content: content, trigger: nil)) { error in
                    DispatchQueue.main.async {
                        self.deliveryFailed = error != nil
                        if error == nil {
                            self.defaults.set(sentIssue, forKey: "lastIssue")
                            self.defaults.set(sentAt, forKey: "lastNoticeAt")
                        } else {
                            self.gate.lastIssue = self.defaults.string(forKey: "lastIssue") ?? ""
                            self.gate.lastNoticeAt = sentAt
                        }
                        self.updateWindow()
                    }
                }
            } else {
                // Enabling notifications later must still surface a persistent issue.
                gate.lastIssue = defaults.string(forKey: "lastIssue") ?? ""
                gate.lastNoticeAt = defaults.double(forKey: "lastNoticeAt")
            }
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let heading = NSMenuItem(title: report.title, action: nil, keyEquivalent: ""); heading.isEnabled = false
        menu.addItem(heading)
        menu.addItem(NSMenuItem.separator())
        add(menu, "Open status…", #selector(showStatus(_:)))
        add(menu, "Open Codex", #selector(openCodex(_:)))
        add(menu, "Open Claude", #selector(openClaude(_:)))
        add(menu, "Show diagnostic files", #selector(showDiagnostics(_:)))
        menu.addItem(NSMenuItem.separator())
        add(menu, permission == .authorized || permission == .provisional ? "Send a test notification" : "Enable notifications…", #selector(notificationAction(_:)))
        menu.addItem(NSMenuItem.separator())
        add(menu, "Quit status display (sync keeps running)", #selector(quit(_:)))
        refreshPermission()
    }

    func add(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: ""); entry.target = self; menu.addItem(entry)
    }

    @objc func showStatus(_ sender: Any?) {
        if window == nil {
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 570, height: 420),
                                 styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            panel.title = "Claudex Status"; panel.isReleasedWhenClosed = false; panel.delegate = self
            let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
            stack.translatesAutoresizingMaskIntoConstraints = false
            panel.contentView!.addSubview(stack)
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 26),
                stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -26),
                stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 26)])
            let name = NSTextField(labelWithString: "CLAUDEX"); name.font = .systemFont(ofSize: 11, weight: .semibold); name.textColor = .secondaryLabelColor
            stack.addArrangedSubview(name)
            headline = NSTextField(wrappingLabelWithString: report.title); headline!.font = .systemFont(ofSize: 23, weight: .semibold)
            stack.addArrangedSubview(headline!)
            descriptionText = NSTextField(wrappingLabelWithString: report.detail); descriptionText!.font = .systemFont(ofSize: 13)
            descriptionText!.maximumNumberOfLines = 6; stack.addArrangedSubview(descriptionText!)
            descriptionText!.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            updatedText = NSTextField(labelWithString: ""); updatedText!.textColor = .secondaryLabelColor; stack.addArrangedSubview(updatedText!)
            recoveryText = NSTextField(wrappingLabelWithString: ""); recoveryText!.textColor = .secondaryLabelColor; stack.addArrangedSubview(recoveryText!)
            permissionText = NSTextField(wrappingLabelWithString: ""); permissionText!.textColor = .secondaryLabelColor; stack.addArrangedSubview(permissionText!)
            let buttons = NSStackView(); buttons.orientation = .horizontal; buttons.spacing = 10
            for (title, action) in [("Open Codex", #selector(openCodex(_:))), ("Diagnostics", #selector(showDiagnostics(_:))),
                                    ("Notifications…", #selector(notificationAction(_:)))] {
                let button = NSButton(title: title, target: self, action: action); button.bezelStyle = .rounded; buttons.addArrangedSubview(button)
            }
            stack.addArrangedSubview(buttons)
            window = panel; panel.center()
        }
        updateWindow(); window!.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }

    func updateWindow() {
        headline?.stringValue = report.title
        descriptionText?.stringValue = report.detail
        if let update = report.updatedAt {
            let formatter = DateFormatter(); formatter.dateFormat = "HH:mm:ss"
            updatedText?.stringValue = "Last status update: " + formatter.string(from: Date(timeIntervalSince1970: update / 1000))
        } else { updatedText?.stringValue = "No verified status update yet" }
        var recovery = report.autoRestart ? "Automatic service recovery: enabled" : "Automatic service recovery: not confirmed"
        if let retry = report.retryAt { recovery += " · next check in \(max(0, Int(ceil((retry - Date().timeIntervalSince1970 * 1000) / 1000))))s" }
        recoveryText?.stringValue = recovery
        permissionText?.stringValue = deliveryFailed ? "Notification delivery failed · another attempt is scheduled"
            : permission == .authorized || permission == .provisional
            ? (testNotice.isEmpty ? "Notifications: enabled · repeated alerts are suppressed" : testNotice)
            : "Notifications: not enabled · click Notifications to allow alerts"
    }

    @objc func openCodex(_ sender: Any?) { openApplication("com.openai.codex") }
    @objc func openClaude(_ sender: Any?) { openApplication("com.anthropic.claudefordesktop") }
    func openApplication(_ id: String) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
    }
    @objc func showDiagnostics(_ sender: Any?) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: root + "/watcher-status.json")])
    }
    @objc func notificationAction(_ sender: Any?) {
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                self.center.requestAuthorization(options: [.alert, .sound]) { _, _ in self.refreshPermission() }
            } else if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                let content = UNMutableNotificationContent(); content.title = "Claudex notification test"
                content.body = "Alerts are working. No conversation or synchronization state was changed."
                self.center.add(UNNotificationRequest(identifier: "claudex-test", content: content, trigger: nil)) { error in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                        if error != nil {
                            self.testNotice = "Test notification failed. Check macOS notification settings."
                            self.updateWindow(); return
                        }
                        self.center.getDeliveredNotifications { delivered in
                            DispatchQueue.main.async {
                                self.testNotice = delivered.contains(where: { $0.request.identifier == "claudex-test" })
                                    ? "Test notification delivered to Notification Center"
                                    : "Test submitted · macOS Focus may suppress its presentation"
                                self.updateWindow()
                            }
                        }
                    }
                }
            } else {
                DispatchQueue.main.async {
                    let alert = NSAlert(); alert.messageText = "Notifications are disabled"
                    alert.informativeText = "Allow Claudex Status in System Settings > Notifications. The menu bar status remains available."
                    alert.runModal()
                }
            }
        }
    }
    @objc func quit(_ sender: Any?) { NSApp.terminate(nil) }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .list])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        DispatchQueue.main.async { self.showStatus(nil) }; completion()
    }
}

let app = NSApplication.shared
let delegate = StatusApp()
app.delegate = delegate
app.run()

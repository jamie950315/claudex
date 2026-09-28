import Cocoa
import UserNotifications

final class StatusController: NSObject, UNUserNotificationCenterDelegate, NSWindowDelegate {
    let center = UNUserNotificationCenter.current()
    var item: NSStatusItem!
    var timer: Timer?
    let root: String
    let readOnly: Bool
    var report: HealthReport

    init(root: String, readOnly: Bool) {
        self.root = root
        self.readOnly = readOnly
        self.report = loadHealth(root)
        super.init()
    }
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

    func start(item: NSStatusItem) {
        self.item = item
        if !readOnly { center.delegate = self }
        gate.lastIssue = defaults.string(forKey: "lastIssue") ?? ""
        gate.lastNoticeAt = defaults.double(forKey: "lastNoticeAt")
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer!, forMode: .common)
        refreshPermission()
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
        guard !readOnly else { return }
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
        NSApp.setActivationPolicy(.regular)
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

    func windowWillClose(_ notification: Notification) {
        if !NSApp.windows.contains(where: { $0 != window && $0.isVisible }) {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    @objc func openCodex(_ sender: Any?) { openApplication("com.openai.codex") }
    @objc func openClaude(_ sender: Any?) { openApplication("com.anthropic.claudefordesktop") }
    func openApplication(_ id: String) {
        guard !readOnly else { return }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
    }
    @objc func showDiagnostics(_ sender: Any?) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: root + "/watcher-status.json")])
    }
    @objc func notificationAction(_ sender: Any?) {
        guard !readOnly else { return }
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
                    alert.informativeText = "Allow Claudex in System Settings > Notifications. The menu bar status remains available."
                    alert.runModal()
                }
            }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .list])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        DispatchQueue.main.async { self.showStatus(nil) }; completion()
    }
}

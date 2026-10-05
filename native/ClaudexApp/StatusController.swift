import Cocoa
import UserNotifications

final class StatusController: NSObject, UNUserNotificationCenterDelegate {
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
    var onOpen: (() -> Void)?
    var onContentChange: (() -> Void)?
    var statusIcon: NSImageView? {
        didSet { presentedIcon = "" }
    }
    var issuePanel: NSView?
    var issueText: NSTextField?
    var headline: NSTextField?
    var descriptionText: NSTextField?
    var updatedText: NSTextField?
    var recoveryText: NSTextField?
    var permissionText: NSTextField?
    var permission = UNAuthorizationStatus.notDetermined
    var deliveryFailed = false
    var testNotice = ""
    var gate = NoticeGate()
    private var presented: [String] = []
    private var presentedIcon = ""
    private let timeFormatter: DateFormatter = {
        let formatter = DateFormatter(); formatter.dateFormat = "HH:mm:ss"; return formatter
    }()
    let defaults = UserDefaults.standard

    func start(item: NSStatusItem) {
        self.item = item
        // The fixed icon-only template symbol never changes; configure it once, not per poll.
        if let button = item.button {
            button.title = ""
            button.imagePosition = .imageOnly
            button.image = NSImage(systemSymbolName: "arrow.left.arrow.right", accessibilityDescription: "Claudex")
            button.image?.size = NSSize(width: 18, height: 18)
            button.image?.isTemplate = true
        }
        if !readOnly { center.delegate = self }
        gate.lastIssue = defaults.string(forKey: "lastIssue") ?? ""
        gate.lastNoticeAt = defaults.double(forKey: "lastNoticeAt")
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        timer?.tolerance = 0.5
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
        if let button = item?.button {
            let tooltip = L(report.title) + "\n" + LD(report.detail)
            if button.toolTip != tooltip { button.toolTip = tooltip }
            button.setAccessibilityLabel("Claudex: " + L(report.title))
        }
        updateWindow()
        guard !readOnly else { return }
        let now = Date().timeIntervalSince1970 * 1000
        if let event = gate.event(for: report, now: now) {
            if permission == .authorized || permission == .provisional {
                let content = UNMutableNotificationContent()
                content.title = L(event == "recovered" ? "Claudex synchronization restored" : "Claudex needs attention")
                content.body = L(event == "recovered" ? "The service is running without reported synchronization blocks."
                    : "Synchronization or recovery needs attention. Open Claudex in the menu bar for details. Your histories are preserved.")
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

    func updateWindow() {
        let iconKey = [report.symbol, L(report.title), String(report.attention), String(report.operational)].joined(separator: "\n")
        if presentedIcon != iconKey {
            statusIcon?.image = NSImage(systemSymbolName: report.symbol, accessibilityDescription: L(report.title))
            statusIcon?.contentTintColor = report.attention ? .systemOrange : report.operational ? .systemGreen : .secondaryLabelColor
            presentedIcon = iconKey
        }
        setText(headline, L(report.title))
        setText(descriptionText, LD(report.detail))
        if issuePanel?.isHidden != report.issues.isEmpty { issuePanel?.isHidden = report.issues.isEmpty }
        var details = formattedIssues(Array(report.issues.prefix(1)), includeIdentity: false)
        if report.issues.count > 1 { details += "\n\n" + LF("%@ more items are available in diagnostics.", String(report.issues.count - 1)) }
        setText(issueText, details)
        if let update = report.updatedAt {
            setText(updatedText, LF("Last status update: %@", timeFormatter.string(from: Date(timeIntervalSince1970: update / 1000))))
        } else { setText(updatedText, L("No verified status update yet")) }
        var recovery = L(report.autoRestart ? "Automatic service recovery: enabled" : "Automatic service recovery: not confirmed")
        if let retry = report.retryAt { recovery += LF(" · next check in %@s", String(max(0, Int(ceil((retry - Date().timeIntervalSince1970 * 1000) / 1000))))) }
        setText(recoveryText, recovery)
        setText(permissionText, L(deliveryFailed ? "Notification delivery failed · another attempt is scheduled"
            : permission == .authorized || permission == .provisional
            ? (testNotice.isEmpty ? "Notifications: enabled · repeated alerts are suppressed" : testNotice)
            : "Notifications: not enabled · click Notifications to allow alerts"))
        // The three-second poll usually repeats identical content; refit the window only
        // when presented text or visibility changed. Showing the window always refits.
        let current = [report.symbol, String(report.attention), String(report.operational), L(report.title), LD(report.detail),
                       details, updatedText?.stringValue ?? "", recovery, permissionText?.stringValue ?? "",
                       String(issuePanel?.isHidden ?? true)]
        if current != presented { presented = current; onContentChange?() }
    }

    private func setText(_ field: NSTextField?, _ text: String) {
        if field?.stringValue != text { field?.stringValue = text }
    }

    var diagnosticText: String {
        formattedIssues(report.issues, includeIdentity: true)
    }

    private func formattedIssues(_ issues: [HealthIssue], includeIdentity: Bool) -> String {
        issues.map { issue in
            let target = issue.identity == nil ? L(issue.target) : issue.target
            let identity = includeIdentity ? issue.identity.map { $0 == target ? "" : " [\($0)]" } ?? "" : ""
            return LF("Conversation: %@", target) + identity + "\n"
                + LF("Reason: %@", LD(issue.reason)) + "\n"
                + (issue.savedWorkingDirectory.map { LF("Saved working directory: %@", $0) + "\n" } ?? "")
                + LF("Next step: %@", L(issue.nextStep))
        }.joined(separator: "\n\n")
    }

    @objc func copyDiagnostics(_ sender: Any?) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(diagnosticText, forType: .string)
    }

    @objc func showDiagnostics(_ sender: Any?) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: root + "/watcher-status.json")])
    }
    @objc func notificationAction(_ sender: Any?) {
        guard !readOnly else { return }
        center.getNotificationSettings { settings in
            DispatchQueue.main.async {
                self.permission = settings.authorizationStatus
                self.updateWindow()
                if settings.authorizationStatus == .notDetermined {
                    self.center.requestAuthorization(options: [.alert, .sound]) { _, _ in self.refreshPermission() }
                } else if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                    let content = UNMutableNotificationContent(); content.title = L("Claudex notification test")
                    content.body = L("Alerts are working. No conversation or synchronization state was changed.")
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
                    let alert = NSAlert(); alert.messageText = L("Notifications are disabled")
                    alert.informativeText = L("Allow Claudex in System Settings > Notifications. The menu bar status remains available.")
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
        DispatchQueue.main.async { self.onOpen?() }; completion()
    }
}

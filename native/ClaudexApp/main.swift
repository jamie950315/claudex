import AppKit

private let cliArguments = Array(CommandLine.arguments.dropFirst())
private let rootIndex = cliArguments.firstIndex(of: "--root")
private let setupRoot = rootIndex.flatMap { $0 + 1 < cliArguments.count ? cliArguments[$0 + 1] : nil }
    ?? NSHomeDirectory() + "/.local/share/claudex"
private let inspectOnly = cliArguments.contains("--inspect-only")
private let uiSmoke = cliArguments.contains("--ui-smoke")

private final class TopAlignedDocumentView: NSView {
    override var isFlipped: Bool { true }
}

final class ClaudexApp: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    private lazy var health = StatusController(root: setupRoot, readOnly: inspectOnly)
    private let runner = SetupRunner(root: setupRoot, resources: Bundle.main.resourceURL)
    private var statusItem: NSStatusItem!
    private var window: NSWindow!
    private var statusIcon: NSImageView!
    private var statusTitle: NSTextField!
    private var statusDetail: NSTextField!
    private var cards: NSStackView!
    private var checklistScroll: NSScrollView!
    private var progress: NSProgressIndicator!
    private var setupButton: NSButton!
    private var refreshButton: NSButton!
    private var busy = false
    private var report: SetupReport?
    private var lastVerifiedReport: SetupReport?
    private var failure: String?
    private var refreshTimer: Timer?
    private var setupFlowActive = false
    private var checkingOnly = true
    private var settingsPresentedKey: String { "settingsPresented.v1:" + setupRoot }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !uiSmoke, let identifier = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
               .first(where: { $0.processIdentifier != getpid() }) {
            if !cliArguments.contains("--background") { existing.activate(options: [.activateAllWindows]) }
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.regular)
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu(title: "Claudex")
        for (title, action) in [("Open status…", #selector(showHealth(_:))), ("Settings…", #selector(showSetup(_:)))] {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
            entry.target = self
            applicationMenu.addItem(entry)
        }
        applicationMenu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit Claudex", action: #selector(quit(_:)), keyEquivalent: "q")
        quitItem.target = self
        applicationMenu.addItem(quitItem)
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)
        NSApp.mainMenu = mainMenu
        createWindow()
        if uiSmoke {
            runUISmoke()
            return
        }
        createStatusItem()
        health.start(item: statusItem)
        let launch = SetupLaunchPolicy(background: cliArguments.contains("--background"), inspectOnly: inspectOnly,
            hasPresentedSettings: UserDefaults.standard.bool(forKey: settingsPresentedKey),
            hasPriorSetup: FileManager.default.fileExists(atPath: setupRoot + "/app-setup-status.json"))
        if launch.showSettings { showSetup(nil) } else { NSApp.setActivationPolicy(.accessory) }
        run(inspectOnly ? .inspect : launch.startSetup ? .setup : .startup)
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            guard let self, !self.busy else { return }
            self.run(.inspect)
        }
        RunLoop.main.add(refreshTimer!, forMode: .common)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSetup(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func windowWillClose(_ notification: Notification) {
        if !NSApp.windows.contains(where: { $0 != window && $0.isVisible }) {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    private func createStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = " Claudex"
        statusItem.button?.image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: "Claudex")
        statusItem.button?.image?.isTemplate = true
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let heading = NSMenuItem(title: health.report.title, action: nil, keyEquivalent: "")
        heading.isEnabled = false
        menu.addItem(heading)
        addMenu(menu, "Open status…", #selector(showHealth(_:)))
        addMenu(menu, "Settings…", #selector(showSetup(_:)))
        addMenu(menu, "Refresh status", #selector(refreshStatus(_:)))
        menu.addItem(.separator())
        addMenu(menu, "Open Codex", #selector(openCodex(_:)))
        addMenu(menu, "Open Claude", #selector(openClaude(_:)))
        addMenu(menu, "Show diagnostic files", #selector(showDiagnostics(_:)))
        if !inspectOnly { addMenu(menu, "Notifications…", #selector(notifications(_:))) }
        menu.addItem(.separator())
        addMenu(menu, "Quit Claudex (service keeps running)", #selector(quit(_:)))
    }

    private func addMenu(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        let inspectionAction = action == #selector(openCodex(_:)) || action == #selector(openClaude(_:))
        item.isEnabled = (!busy || action == #selector(showSetup(_:)) || action == #selector(showHealth(_:))
            || action == #selector(showDiagnostics(_:)) || action == #selector(notifications(_:)) || action == #selector(quit(_:)))
            && (!inspectOnly || !inspectionAction)
        menu.addItem(item)
    }

    private func createWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 690, height: 700),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Claudex Settings"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.backgroundColor = .windowBackgroundColor

        let content = NSView()
        window.contentView = content
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -32),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24)
        ])

        let brand = label("CLAUDEX", size: 11, weight: .bold, color: .secondaryLabelColor)
        stack.addArrangedSubview(brand)
        let title = label("Setup & connections", size: 28, weight: .semibold)
        stack.addArrangedSubview(title)
        let intro = wrapping("Claudex checks and configures your connections automatically on first launch. Complete any sign-in or required action below. No terminal setup is needed.", size: 13)
        stack.addArrangedSubview(intro)
        intro.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let scope = NSBox()
        scope.boxType = .custom
        scope.borderColor = NSColor.separatorColor
        scope.cornerRadius = 12
        scope.fillColor = NSColor.controlBackgroundColor
        let scopeStack = NSStackView()
        scopeStack.orientation = .vertical
        scopeStack.alignment = .leading
        scopeStack.spacing = 7
        scopeStack.translatesAutoresizingMaskIntoConstraints = false
        scope.contentView!.addSubview(scopeStack)
        NSLayoutConstraint.activate([
            scopeStack.leadingAnchor.constraint(equalTo: scope.contentView!.leadingAnchor, constant: 16),
            scopeStack.trailingAnchor.constraint(equalTo: scope.contentView!.trailingAnchor, constant: -16),
            scopeStack.topAnchor.constraint(equalTo: scope.contentView!.topAnchor, constant: 13),
            scopeStack.bottomAnchor.constraint(equalTo: scope.contentView!.bottomAnchor, constant: -13)
        ])
        scopeStack.addArrangedSubview(label("All projects", size: 16, weight: .semibold))
        let scopeDetail = wrapping("Enabled by default. Claudex requests task-scoped access when work needs it; this does not grant unrestricted disk access or bypass native permissions.", size: 12, color: .secondaryLabelColor)
        scopeStack.addArrangedSubview(scopeDetail)
        scopeDetail.widthAnchor.constraint(equalTo: scopeStack.widthAnchor).isActive = true
        stack.addArrangedSubview(scope)
        scope.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let statusRow = NSStackView()
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = 12
        statusIcon = NSImageView()
        statusIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 24, weight: .medium)
        statusIcon.translatesAutoresizingMaskIntoConstraints = false
        statusIcon.widthAnchor.constraint(equalToConstant: 30).isActive = true
        statusIcon.heightAnchor.constraint(equalToConstant: 30).isActive = true
        statusRow.addArrangedSubview(statusIcon)
        let statusText = NSStackView()
        statusText.orientation = .vertical
        statusText.alignment = .leading
        statusText.spacing = 3
        statusTitle = label("Checking setup…", size: 17, weight: .semibold)
        statusDetail = wrapping("Reading the local setup state.", size: 12, color: .secondaryLabelColor)
        statusText.addArrangedSubview(statusTitle)
        statusText.addArrangedSubview(statusDetail)
        statusRow.addArrangedSubview(statusText)
        stack.addArrangedSubview(statusRow)
        statusRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        statusDetail.widthAnchor.constraint(equalTo: statusText.widthAnchor).isActive = true

        let separator = NSBox()
        separator.boxType = .separator
        stack.addArrangedSubview(separator)
        separator.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.addArrangedSubview(label("SETUP CHECKLIST", size: 11, weight: .bold, color: .secondaryLabelColor))
        let scroll = NSScrollView()
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        cards = NSStackView()
        cards.orientation = .vertical
        cards.alignment = .leading
        cards.spacing = 0
        let container = TopAlignedDocumentView()
        container.translatesAutoresizingMaskIntoConstraints = false
        cards.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(cards)
        NSLayoutConstraint.activate([
            cards.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            cards.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            cards.topAnchor.constraint(equalTo: container.topAnchor),
            cards.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        scroll.documentView = container
        checklistScroll = scroll
        stack.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: 215).isActive = true
        container.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true

        let footer = NSStackView()
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 10
        progress = NSProgressIndicator()
        progress.style = .spinning
        progress.controlSize = .small
        progress.isIndeterminate = true
        footer.addArrangedSubview(progress)
        setupButton = NSButton(title: "Retry setup", target: self, action: #selector(retrySetup(_:)))
        setupButton.bezelStyle = .rounded
        footer.addArrangedSubview(setupButton)
        refreshButton = NSButton(title: "Refresh status", target: self, action: #selector(refreshStatus(_:)))
        refreshButton.bezelStyle = .rounded
        footer.addArrangedSubview(refreshButton)
        stack.addArrangedSubview(footer)
        stack.addArrangedSubview(wrapping("After resolving a missing requirement, use Retry setup to continue configuration. It does not resend messages or force a paused synchronization to continue.", size: 11, color: .secondaryLabelColor))
        stack.addArrangedSubview(wrapping("Sign in to your existing vendor accounts when prompted. Approve any macOS permission prompts yourself; Claudex cannot bypass them. Closing this window or quitting the app leaves the service running.", size: 11, color: .secondaryLabelColor))
        render()
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        return field
    }

    private func wrapping(_ text: String, size: CGFloat, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size)
        field.textColor = color
        field.maximumNumberOfLines = 0
        return field
    }

    private func run(_ command: SetupCommand) {
        guard !busy else { return }
        switch command {
        case .setup, .login: setupFlowActive = true; checkingOnly = false
        case .inspect, .startup: checkingOnly = true
        }
        let previousReport = lastVerifiedReport
        busy = true
        failure = nil
        render()
        runner.run(command) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let report): self.report = report; self.lastVerifiedReport = report; self.failure = nil
            case .failure(let error): self.report = nil; self.failure = error.message
            }
            self.render()
            if case .inspect = command, !inspectOnly, self.setupFlowActive, let current = self.report,
               Self.providerBecameReady(from: previousReport, to: current) {
                self.run(.setup)
            }
        }
    }

    private static func providerBecameReady(from previous: SetupReport?, to current: SetupReport) -> Bool {
        guard let previous else { return false }
        let providerIDs: Set<String> = ["codex-cli", "claude-cli", "codex-login", "claude-login", "codex-desktop", "claude-desktop"]
        let old = Dictionary(uniqueKeysWithValues: previous.components.map { ($0.id, $0.state) })
        return current.components.contains { component in
            providerIDs.contains(component.id) && component.state == .ready
                && old[component.id].map { $0 == .missing || $0 == .loginRequired } == true
        }
    }

    private func render() {
        guard statusIcon != nil else { return }
        let phase = report?.phase
        let title: String
        let symbol: String
        let color: NSColor
        if busy { title = checkingOnly ? "Checking Claudex…" : "Setting up Claudex…"; symbol = "arrow.triangle.2.circlepath"; color = .controlAccentColor }
        else if failure != nil { title = "Setup status unavailable"; symbol = "exclamationmark.triangle"; color = .systemOrange }
        else {
            switch phase {
            case .ready: title = "Ready to connect"; symbol = "checkmark.circle.fill"; color = .systemGreen
            case .settingUp: title = "Setup in progress"; symbol = "clock"; color = .controlAccentColor
            case .needsAction: title = "Action needed"; symbol = "person.crop.circle.badge.exclamationmark"; color = .systemOrange
            case .blocked: title = "Setup needs attention"; symbol = "exclamationmark.triangle"; color = .systemOrange
            case nil: title = "Checking setup…"; symbol = "clock"; color = .secondaryLabelColor
            }
        }
        statusTitle.stringValue = title
        statusDetail.stringValue = failure ?? report?.message ?? (busy ? "Checking and configuring local components." : "Waiting for a verified setup report.")
        statusIcon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        statusIcon.contentTintColor = color
        progress.isHidden = !busy
        if busy { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
        setupButton.isHidden = inspectOnly
        setupButton.isEnabled = !busy
        refreshButton.isEnabled = !busy
        for view in cards.arrangedSubviews { cards.removeArrangedSubview(view); view.removeFromSuperview() }
        if let components = report?.components, !components.isEmpty {
            for component in components {
                let row = componentRow(component)
                cards.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: cards.widthAnchor).isActive = true
            }
        } else {
            let placeholder = wrapping(busy ? "Checking local components…" : "No verified component details are available.", size: 13, color: .secondaryLabelColor)
            cards.addArrangedSubview(placeholder)
            placeholder.widthAnchor.constraint(equalTo: cards.widthAnchor).isActive = true
        }
    }

    private func componentRow(_ component: SetupComponent) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.edgeInsets = NSEdgeInsets(top: 11, left: 2, bottom: 11, right: 2)
        let image = NSImageView()
        let symbol: String
        switch component.state {
        case .ready: symbol = "checkmark.circle.fill"; image.contentTintColor = .systemGreen
        case .waiting: symbol = "clock"; image.contentTintColor = .secondaryLabelColor
        case .loginRequired: symbol = "person.crop.circle.badge.exclamationmark"; image.contentTintColor = .systemOrange
        case .missing, .blocked: symbol = "exclamationmark.circle"; image.contentTintColor = .systemOrange
        }
        image.image = NSImage(systemSymbolName: symbol, accessibilityDescription: component.state.rawValue)
        image.translatesAutoresizingMaskIntoConstraints = false
        image.widthAnchor.constraint(equalToConstant: 22).isActive = true
        row.addArrangedSubview(image)
        let textStack = NSStackView()
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 3
        textStack.addArrangedSubview(label(component.label, size: 13, weight: .medium))
        let detail = wrapping(component.detail, size: 11, color: .secondaryLabelColor)
        textStack.addArrangedSubview(detail)
        row.addArrangedSubview(textStack)
        row.setContentHuggingPriority(.defaultLow, for: .horizontal)
        if let action = component.action, !(action == .retry && component.state == .ready) {
            let button = NSButton(title: actionTitle(action), target: self, action: #selector(componentAction(_:)))
            button.bezelStyle = .rounded
            button.tag = actionTag(action)
            button.isEnabled = !busy && !inspectOnly
            row.addArrangedSubview(button)
        }
        detail.widthAnchor.constraint(lessThanOrEqualTo: textStack.widthAnchor).isActive = true
        return row
    }

    private func runUISmoke() {
        let ids = ["projects", "runtime", "codex-cli", "codex-login", "codex-desktop", "claude-cli",
                   "claude-login", "claude-desktop", "collaboration", "synchronization", "folders", "handoffs"]
        let components = ids.map { id in
            ["id": id, "label": id.replacingOccurrences(of: "-", with: " ").capitalized,
             "state": id == "claude-login" ? "login-required" : "ready",
             "detail": "Synthetic layout check for a native setup component. No account, service, or history is accessed.",
             "action": id == "claude-login" ? "login-claude" : "retry"]
        }
        let sample: [String: Any] = ["version": 1, "phase": "needs-action", "allProjects": true,
                                     "allowWrite": true, "components": components, "message": "Synthetic UI layout check"]
        do {
            report = try SetupReport.parse(JSONSerialization.data(withJSONObject: sample))
        } catch {
            fputs("Claudex UI smoke: invalid sample report\n", stderr)
            exit(1)
        }
        render()
        showSetup(nil)
        DispatchQueue.main.async {
            self.window.contentView?.layoutSubtreeIfNeeded()
            self.checklistScroll.documentView?.layoutSubtreeIfNeeded()
            self.checklistScroll.contentView.scroll(to: .zero)
            self.checklistScroll.reflectScrolledClipView(self.checklistScroll.contentView)
            self.window.displayIfNeeded()
            let rows = self.cards.arrangedSubviews
            let document = self.checklistScroll.documentView
            let valid = rows.count == ids.count && document?.isFlipped == true
                && (document?.frame.height ?? 0) > 0 && self.cards.frame.width > 0
                && self.checklistScroll.contentView.bounds.origin.y == 0
            if valid { print("Claudex UI smoke: layout ready") }
            else { fputs("Claudex UI smoke: layout unavailable\n", stderr) }
            exit(valid ? 0 : 1)
        }
    }

    private func actionTitle(_ action: ComponentAction) -> String {
        switch action {
        case .loginCodex: return "Sign in"
        case .loginClaude: return "Sign in"
        case .openCodex, .openClaude: return "Open app"
        case .retry: return "Retry"
        }
    }

    private func actionTag(_ action: ComponentAction) -> Int {
        switch action {
        case .loginCodex: return 1
        case .loginClaude: return 2
        case .openCodex: return 3
        case .openClaude: return 4
        case .retry: return 5
        }
    }

    @objc private func componentAction(_ sender: NSButton) {
        guard !inspectOnly else { return }
        switch sender.tag {
        case 1: run(.login("codex"))
        case 2: run(.login("claude"))
        case 3: openCodex(nil)
        case 4: openClaude(nil)
        case 5: run(.setup)
        default: break
        }
    }

    @objc private func showSetup(_ sender: Any?) {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if !inspectOnly && !uiSmoke { UserDefaults.standard.set(true, forKey: settingsPresentedKey) }
    }

    @objc private func retrySetup(_ sender: Any?) { if !inspectOnly { run(.setup) } }
    @objc private func showHealth(_ sender: Any?) { health.showStatus(sender) }
    @objc private func showDiagnostics(_ sender: Any?) { health.showDiagnostics(sender) }
    @objc private func notifications(_ sender: Any?) { health.notificationAction(sender) }
    @objc private func refreshStatus(_ sender: Any?) { health.refresh(); health.refreshPermission(); run(.inspect) }
    @objc private func openCodex(_ sender: Any?) { openApplication("com.openai.codex") }
    @objc private func openClaude(_ sender: Any?) { openApplication("com.anthropic.claudefordesktop") }
    private func openApplication(_ identifier: String) {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
            return
        }
        let name = identifier == "com.openai.codex" ? "ChatGPT/Codex" : "Claude"
        let alert = NSAlert()
        alert.messageText = "\(name) desktop app is required"
        alert.informativeText = "Install and sign in to the official \(name) desktop app, then return to Claudex. Setup status refreshes automatically."
        alert.addButton(withTitle: "OK")
        showSetup(nil)
        alert.beginSheetModal(for: window)
    }
    @objc private func quit(_ sender: Any?) { NSApp.terminate(nil) }
}

if cliArguments.contains("--diagnose") {
    let data = try JSONEncoder().encode(loadHealth(setupRoot))
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

let app = NSApplication.shared
let delegate = ClaudexApp()
app.delegate = delegate
app.run()

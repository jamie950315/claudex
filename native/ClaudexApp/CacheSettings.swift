import Cocoa

/// The cache settings window. Everything it edits is saved in the Claudex
/// broker: the default warming limit (Claude Code and Codex) and the startup
/// TTL preference (Claude Code only). It also lists the conversations still
/// being kept warm and can stop one. Opening, reloading and selecting never
/// write; only Save and Stop do. Nothing here enables warming or starts model
/// work.
final class CacheSettingsWindowController: NSObject, NSWindowDelegate {
    private let runner: SetupRunner
    private let writable: Bool
    private let width: CGFloat = 520
    private var window: NSWindow!
    private var content: NSView!
    private var limitPicker: NSPopUpButton!
    private var messagePicker: NSPopUpButton!
    private var modePicker: NSPopUpButton!
    private var ttlPicker: NSPopUpButton!
    private var legacy: NSTextField!
    private var rows: NSStackView!
    private var saveButton: NSButton!
    private var reloadButton: NSButton!
    private var message: NSTextField!
    private var settings: WarmSettings?
    private var busy = false
    var stopping = false { didSet { updateControls() } }

    init(runner: SetupRunner, writable: Bool) {
        self.runner = runner
        self.writable = writable
        super.init()
        build()
    }

    static func title(_ limit: String) -> String {
        let parts = limit.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return limit }
        if parts[0] == "rounds" { return LF("%@ warm requests", parts[1]) }
        if parts[0] == "for", parts[1].hasSuffix("h"), let hours = Int(parts[1].dropLast()) {
            return hours == 1 ? L("1 hour") : LF("%@ hours", String(hours))
        }
        // Any other saved limit is shown as the word the commands accept.
        return limit
    }

    private func wrapping(_ text: String, color: NSColor = .secondaryLabelColor) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: 11)
        field.textColor = color
        field.maximumNumberOfLines = 0
        field.preferredMaxLayoutWidth = width - 44
        return field
    }

    /// A section heading with the apps it applies to beside it.
    private func heading(_ title: String, scope: String) -> NSStackView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 8
        row.alignment = .firstBaseline
        let name = NSTextField(labelWithString: L(title))
        name.font = .systemFont(ofSize: 14, weight: .semibold)
        row.addArrangedSubview(name)
        let tag = NSTextField(labelWithString: L(scope))
        tag.font = .systemFont(ofSize: 11, weight: .medium)
        tag.textColor = .secondaryLabelColor
        row.addArrangedSubview(tag)
        return row
    }

    private func picker(_ label: String) -> NSPopUpButton {
        let value = NSPopUpButton(frame: .zero, pullsDown: false)
        value.setAccessibilityLabel(L(label))
        value.target = self
        value.action = #selector(selected(_:))
        return value
    }

    private func separator() -> NSBox {
        let line = NSBox()
        line.boxType = .separator
        return line
    }

    private func build() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 420),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = L("Cache settings")
        window.isReleasedWhenClosed = false
        window.delegate = self
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 20, right: 22)
        stack.translatesAutoresizingMaskIntoConstraints = false

        stack.addArrangedSubview(heading("Default warming limit", scope: "Claude Code and Codex"))
        limitPicker = picker("Default warming limit")
        stack.addArrangedSubview(limitPicker)
        stack.addArrangedSubview(wrapping(L("Used when /claudex:warm on is given no limit, in Claude and in Codex. Saving changes no running warm-up and starts no model work.")))
        let first = separator()
        stack.addArrangedSubview(first)

        stack.addArrangedSubview(heading("When you send a message", scope: "Claude Code and Codex"))
        messagePicker = picker("When you send a message")
        for (value, title) in zip(WarmSettings.messageModes, ["Keep warming and start the limit over", "Stop warming"]) {
            messagePicker.addItem(withTitle: L(title))
            messagePicker.lastItem?.representedObject = value
        }
        stack.addArrangedSubview(messagePicker)
        stack.addArrangedSubview(wrapping(L("What happens to a conversation that is being kept warm when you send it a message of your own. Keep: the limit you chose starts over from the reply, so a four-hour limit runs four more hours and a number of requests is counted again; a limit given as a clock time keeps that time. A limit that has already run out is not started again. Stop: warming ends with that message. It applies to warm-ups already running too.")))
        let third = separator()
        stack.addArrangedSubview(third)

        stack.addArrangedSubview(heading("Startup cache TTL", scope: "Claude Code only"))
        let ttlRow = NSStackView()
        ttlRow.orientation = .horizontal
        ttlRow.spacing = 10
        modePicker = picker("Startup cache TTL")
        for (value, title) in zip(WarmSettings.ttlModes, ["This process only", "Remember last TTL", "Fixed startup TTL"]) {
            modePicker.addItem(withTitle: L(title))
            modePicker.lastItem?.representedObject = value
        }
        ttlPicker = picker("Cache TTL")
        for (value, title) in zip(WarmSettings.ttls, ["1 hour", "5 minutes"]) {
            ttlPicker.addItem(withTitle: L(title))
            ttlPicker.lastItem?.representedObject = value
        }
        ttlRow.addArrangedSubview(modePicker)
        ttlRow.addArrangedSubview(ttlPicker)
        stack.addArrangedSubview(ttlRow)
        stack.addArrangedSubview(wrapping(L("Applied when a new Claude Code session starts; it never enables warming. Remember follows the TTL you last confirmed in Claude Code. The TTL of a session that is already running is changed inside it, with /claudex:warm on 5m or 1h.")))
        legacy = wrapping(L("Not saved in Claudex yet. A preference saved by an earlier Mod stays in use until one is saved here."))
        stack.addArrangedSubview(legacy)

        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 10
        saveButton = NSButton(title: L("Save"), target: self, action: #selector(save(_:)))
        saveButton.keyEquivalent = "\r"
        reloadButton = NSButton(title: L("Reload"), target: self, action: #selector(reload(_:)))
        for button in [saveButton!, reloadButton!] {
            button.bezelStyle = .rounded
            actions.addArrangedSubview(button)
        }
        stack.addArrangedSubview(actions)
        let second = separator()
        stack.addArrangedSubview(second)

        stack.addArrangedSubview(heading("Conversations being kept warm", scope: "Claude Code and Codex"))
        rows = NSStackView()
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 6
        stack.addArrangedSubview(rows)
        stack.addArrangedSubview(wrapping(L("Turn warming on or off inside a conversation with /claudex:warm on, off or status.")))
        message = wrapping("")
        stack.addArrangedSubview(message)

        content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            content.widthAnchor.constraint(equalToConstant: width),
        ])
        for line in [first, second, third] { line.widthAnchor.constraint(equalToConstant: width - 44).isActive = true }
        rows.widthAnchor.constraint(equalToConstant: width - 44).isActive = true
        window.contentView = content
        show(nil)
    }

    private func time(_ milliseconds: Double) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000), formatter = DateFormatter()
        formatter.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /// Fill every control from the loaded settings; nil keeps the built-in choices.
    private func show(_ loaded: WarmSettings?) {
        limitPicker.removeAllItems()
        let limit = loaded?.defaultLimit
        var limits = WarmSettings.presets
        if let limit, !limits.contains(limit) { limits.insert(limit, at: 0) }
        for value in limits {
            limitPicker.addItem(withTitle: CacheSettingsWindowController.title(value))
            limitPicker.lastItem?.representedObject = value
            if value == limit { limitPicker.select(limitPicker.lastItem) }
        }
        messagePicker.selectItem(at: WarmSettings.messageModes.firstIndex(of: loaded?.onUserMessage ?? "continue") ?? 0)
        modePicker.selectItem(at: WarmSettings.ttlModes.firstIndex(of: loaded?.ttlMode ?? "session") ?? 0)
        ttlPicker.selectItem(at: WarmSettings.ttls.firstIndex(of: loaded?.startupTtl ?? "1h") ?? 0)
        legacy.isHidden = loaded == nil || loaded?.ttlMode != nil
        for view in rows.arrangedSubviews { rows.removeArrangedSubview(view); view.removeFromSuperview() }
        let warming = loaded?.warming ?? []
        if warming.isEmpty {
            rows.addArrangedSubview(wrapping(loaded == nil ? "" : L("None right now.")))
        }
        for (index, item) in warming.enumerated() {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 10
            let app = item.provider == "codex" ? "Codex" : "Claude Code"
            let folder = URL(fileURLWithPath: item.cwd).lastPathComponent
            var text = LF("%@ · %@ · %@ of %@ requests · until %@", app, folder, String(item.used),
                          item.max.map(String.init) ?? "–", time(item.until))
            if let ttl = item.ttl { text += " · TTL " + ttl }
            let label = wrapping(text, color: .labelColor)
            label.preferredMaxLayoutWidth = width - 130
            label.toolTip = item.cwd
            row.addArrangedSubview(label)
            let stop = NSButton(title: L("Stop"), target: self, action: #selector(stop(_:)))
            stop.bezelStyle = .rounded
            stop.controlSize = .small
            stop.tag = index
            stop.setAccessibilityLabel(LF("Stop warming %@", folder))
            row.addArrangedSubview(stop)
            rows.addArrangedSubview(row)
        }
        updateControls()
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    private var chosenLimit: String? { limitPicker.selectedItem?.representedObject as? String }
    private var chosenMode: String { modePicker.selectedItem?.representedObject as? String ?? "session" }
    private var chosenTtl: String { ttlPicker.selectedItem?.representedObject as? String ?? "1h" }
    private var chosenMessage: String { messagePicker.selectedItem?.representedObject as? String ?? "continue" }
    private var messageChanged: Bool { settings != nil && chosenMessage != (settings?.onUserMessage ?? "continue") }
    private var limitChanged: Bool { chosenLimit != nil && chosenLimit != settings?.defaultLimit }
    private var ttlChanged: Bool {
        guard let settings else { return false }
        if chosenMode != (settings.ttlMode ?? "session") { return true }
        if chosenMode == "session" { return false }
        return chosenTtl != settings.startupTtl
    }

    private func updateControls() {
        guard limitPicker != nil else { return }
        let editable = writable && !busy && !stopping && settings != nil
        limitPicker.isEnabled = editable
        modePicker.isEnabled = editable
        messagePicker.isEnabled = editable
        ttlPicker.isEnabled = editable && chosenMode != "session"
        saveButton.isEnabled = editable && (limitChanged || ttlChanged || messageChanged)
        reloadButton.isEnabled = !busy && !stopping
        for case let row as NSStackView in rows.arrangedSubviews {
            for case let button as NSButton in row.arrangedSubviews { button.isEnabled = editable }
        }
    }

    private func load(limit: String? = nil, mode: String? = nil, ttl: String? = nil, onMessage: String? = nil, stop: WarmSettings.Enrollment? = nil) {
        guard !busy && !stopping else { return }
        let saving = limit != nil || mode != nil || onMessage != nil
        busy = true
        message.stringValue = L(stop != nil ? "Stopping warming…" : saving ? "Saving cache settings…" : "Loading cache settings…")
        updateControls()
        runner.warmSettings(defaultLimit: limit, ttlMode: mode, ttl: ttl, onMessage: onMessage, stop: stop) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let settings):
                self.settings = settings
                self.message.stringValue = stop != nil ? L("Warming stopped for that conversation.")
                    : saving ? L("Cache settings saved. Running warm-ups are unchanged.") : ""
                self.show(settings)
            case .failure(let error):
                if case .engineMessage(let detail) = error {
                    self.message.stringValue = L("Cache settings could not be loaded or saved.") + "\n" + LD(detail)
                } else {
                    self.message.stringValue = L("Cache settings are unavailable. Check that Claudex is running, then reload.")
                }
                self.updateControls()
                self.content.layoutSubtreeIfNeeded()
                self.window.setContentSize(self.content.fittingSize)
            }
        }
    }

    func show() {
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        load()
    }

    func close() {
        window.delegate = nil
        window.close()
    }

    @objc private func selected(_ sender: Any?) { updateControls() }
    @objc private func reload(_ sender: Any?) { load() }
    @objc private func save(_ sender: Any?) {
        guard writable else { return }
        let limit = limitChanged ? chosenLimit : nil
        if let limit, !WarmSettings.valid(limit) { return }
        let mode = ttlChanged ? chosenMode : nil
        let onMessage = messageChanged ? chosenMessage : nil
        guard limit != nil || mode != nil || onMessage != nil else { return }
        load(limit: limit, mode: mode, ttl: mode == nil || mode == "session" ? nil : chosenTtl, onMessage: onMessage)
    }
    @objc private func stop(_ sender: NSButton) {
        guard writable, let warming = settings?.warming, warming.indices.contains(sender.tag) else { return }
        load(stop: warming[sender.tag])
    }
}

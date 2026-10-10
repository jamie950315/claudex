import Cocoa

/// The cache settings window. It edits one value: the limit a warming on
/// command uses when it is given none. Opening, reloading and selecting never
/// write; only Save does. Nothing here enables warming or starts model work.
final class CacheSettingsWindowController: NSObject, NSWindowDelegate {
    private let runner: SetupRunner
    private let writable: Bool
    private var window: NSWindow!
    private var picker: NSPopUpButton!
    private var saveButton: NSButton!
    private var reloadButton: NSButton!
    private var message: NSTextField!
    private var active: NSTextField!
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
        return field
    }

    private func build() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 300),
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
        let heading = NSTextField(labelWithString: L("Default warming limit"))
        heading.font = .systemFont(ofSize: 14, weight: .semibold)
        stack.addArrangedSubview(heading)
        picker = NSPopUpButton(frame: .zero, pullsDown: false)
        picker.setAccessibilityLabel(L("Default warming limit"))
        picker.target = self
        picker.action = #selector(selected(_:))
        stack.addArrangedSubview(picker)
        let help = wrapping(L("Used when /claudex:warm on is given no limit, in Claude and in Codex. Saving changes no running warm-up and starts no model work."))
        stack.addArrangedSubview(help)
        let usage = wrapping(L("Turn warming on or off inside a conversation with /claudex:warm on, off or status."))
        stack.addArrangedSubview(usage)
        active = wrapping("")
        stack.addArrangedSubview(active)
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
        message = wrapping("")
        stack.addArrangedSubview(message)
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            content.widthAnchor.constraint(equalToConstant: 460),
        ])
        for field in [help, usage, active!, message!] {
            field.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -44).isActive = true
        }
        window.contentView = content
        fillPicker(selecting: nil)
        updateControls()
    }

    private func fillPicker(selecting limit: String?) {
        picker.removeAllItems()
        var limits = WarmSettings.presets
        if let limit, !limits.contains(limit) { limits.insert(limit, at: 0) }
        for value in limits {
            picker.addItem(withTitle: CacheSettingsWindowController.title(value))
            picker.lastItem?.representedObject = value
            if value == limit { picker.select(picker.lastItem) }
        }
    }

    private func updateControls() {
        guard picker != nil else { return }
        let chosen = picker.selectedItem?.representedObject as? String
        picker.isEnabled = writable && !busy && !stopping && settings != nil
        saveButton.isEnabled = picker.isEnabled && chosen != nil && chosen != settings?.defaultLimit
        reloadButton.isEnabled = !busy && !stopping
        if let counts = settings?.active {
            let text = { (value: Int?) in value.map(String.init) ?? "–" }
            active.stringValue = LF("Conversations being kept warm now: Claude %@ · Codex %@", text(counts.claude), text(counts.codex))
        } else { active.stringValue = "" }
    }

    private func load(saving limit: String? = nil) {
        guard !busy && !stopping else { return }
        busy = true
        message.stringValue = L(limit == nil ? "Loading cache settings…" : "Saving cache settings…")
        updateControls()
        runner.warmSettings(defaultLimit: limit) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let settings):
                self.settings = settings
                self.fillPicker(selecting: settings.defaultLimit)
                self.message.stringValue = limit == nil ? "" : L("Default warming limit saved. Running warm-ups are unchanged.")
            case .failure(let error):
                if case .engineMessage(let detail) = error {
                    self.message.stringValue = L("Cache settings could not be loaded or saved.") + "\n" + LD(detail)
                } else {
                    self.message.stringValue = L("Cache settings are unavailable. Check that Claudex is running, then reload.")
                }
            }
            self.updateControls()
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
        guard writable, let limit = picker.selectedItem?.representedObject as? String, WarmSettings.valid(limit) else { return }
        load(saving: limit)
    }
}

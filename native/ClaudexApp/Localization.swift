import Foundation

final class Localization {
    static let languages: [(String, String)] = [
        ("en", "English"), ("zh-Hant", "繁體中文"), ("zh-Hans", "简体中文"),
        ("ja", "日本語"), ("ko", "한국어"), ("es", "Español"),
        ("de", "Deutsch"), ("fr", "Français"), ("it", "Italiano")
    ]
    static let preferenceKey = "claudex.ui-language"
    static let shared: Localization = {
        let args = CommandLine.arguments
        let override = (args.contains("--ui-smoke") || args.contains("--inspect-only"))
            ? args.firstIndex(of: "--ui-language").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } : nil
        return Localization(directory: Bundle.main.resourceURL?.appendingPathComponent("Locales"),
                            preference: override ?? UserDefaults.standard.string(forKey: preferenceKey))
    }()

    let directory: URL?
    let preferredLanguages: [String]
    private(set) var preference: String
    private(set) var language = "en"
    private var catalog: [String: String] = [:]
    private let lock = NSRecursiveLock()

    init(directory: URL?, preference: String? = nil, preferredLanguages: [String] = Locale.preferredLanguages) {
        self.directory = directory
        self.preferredLanguages = preferredLanguages
        self.preference = Self.languages.contains(where: { $0.0 == preference }) ? preference! : "system"
        reload()
    }

    static func resolve(_ preferred: [String]) -> String {
        for value in preferred {
            let tag = value.replacingOccurrences(of: "_", with: "-").lowercased()
            let parts = tag.split(separator: "-").map(String.init)
            guard let base = parts.first else { continue }
            if base == "zh" {
                if parts.contains("hant") { return "zh-Hant" }
                if parts.contains("hans") { return "zh-Hans" }
                return parts.contains(where: { ["tw", "hk", "mo"].contains($0) }) ? "zh-Hant" : "zh-Hans"
            }
            if languages.contains(where: { $0.0 == base }) { return base }
        }
        return "en"
    }

    func select(_ value: String, persist: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard value == "system" || Self.languages.contains(where: { $0.0 == value }) else { return }
        preference = value
        if persist { UserDefaults.standard.set(value, forKey: Self.preferenceKey) }
        reload()
    }

    private func reload() {
        language = preference == "system" ? Self.resolve(preferredLanguages) : preference
        catalog = [:]
        if let url = directory?.appendingPathComponent(language + ".json"),
           let data = try? Data(contentsOf: url), let values = try? JSONDecoder().decode([String: String].self, from: data) {
            catalog = values
        }
    }

    func format(_ key: String, _ values: [CVarArg]) -> String {
        lock.lock(); defer { lock.unlock() }
        return String(format: catalog[key] ?? key, locale: Locale(identifier: language), arguments: values)
    }

    func text(_ original: String) -> String {
        lock.lock(); defer { lock.unlock() }
        if let translated = catalog[original] { return translated }
        // Explicit presentation templates only. Native diagnostics, paths,
        // account data and conversation text are never interpreted as keys.
        for (prefix, suffix, key) in [
            ("Available: ", "", "Available: %@"),
            ("Last status update: ", "", "Last status update: %@"),
            ("Untrusted app at ", "", "Untrusted app at %@"),
            ("Unexpected publisher for ", "", "Unexpected publisher for %@"),
            ("Official ", " CLI package did not provide a working binary.", "Official %@ CLI package did not provide a working binary."),
            ("", " Desktop app is required; install and sign in to the official app before setup.", "%@ Desktop app is required; install and sign in to the official app before setup."),
            ("CLI installation failed: ", "", "CLI installation failed: %@"),
            ("The setup engine exited with code ", ". Check the app installation, then retry.", "The setup engine exited with code %@. Check the app installation, then retry.")
        ] {
            if original.hasPrefix(prefix), original.hasSuffix(suffix), original.count >= prefix.count + suffix.count {
                let value = String(original.dropFirst(prefix.count).dropLast(suffix.count))
                return format(key, [key == "Available: %@" && value == "native CLI" ? text(value) : value])
            }
        }
        for key in ["%@ conversation(s) need attention. ", "%@ new conversation(s) could not be enrolled. Existing conversations can continue. "] {
            let separator = String(key.dropFirst(2))
            if let range = original.range(of: separator), let count = Int(original[..<range.lowerBound]) {
                return format(key, [String(count)]) + text(String(original[range.upperBound...]))
            }
        }
        return original
    }

    func detail(_ original: String) -> String {
        lock.lock(); defer { lock.unlock() }
        let translated = text(original)
        if language == "en" || catalog[original] != nil || translated != original || original.isEmpty { return translated }
        return text("Diagnostic details:") + "\n" + original
    }
}

func L(_ text: String) -> String { Localization.shared.text(text) }
func LF(_ key: String, _ arguments: CVarArg...) -> String { Localization.shared.format(key, arguments) }
func LD(_ text: String) -> String { Localization.shared.detail(text) }

import Foundation

struct SetupLaunchPolicy {
    let showSettings: Bool
    let startSetup: Bool

    init(background: Bool, inspectOnly: Bool, hasPresentedSettings: Bool, hasPriorSetup: Bool) {
        let firstLaunch = !hasPresentedSettings && !hasPriorSetup
        showSettings = !background || (!inspectOnly && firstLaunch)
        startSetup = !inspectOnly && firstLaunch
    }
}

enum SetupPhase: String, Decodable {
    case ready = "ready"
    case waiting = "waiting"
    case settingUp = "setting-up"
    case needsAction = "needs-action"
    case blocked = "blocked"
}

enum ComponentState: String, Decodable {
    case ready, missing, loginRequired = "login-required", waiting, blocked
}

enum ComponentAction: String, Decodable {
    case loginCodex = "login-codex"
    case loginClaude = "login-claude"
    case openCodex = "open-codex"
    case openClaude = "open-claude"
    case retry
    case diagnostics
    case resolveUncertain = "resolve-uncertain"
    case modSetup = "mod-setup"
    case modEnable = "mod-enable"
}

struct SetupComponent: Decodable {
    let id: String
    let label: String
    let state: ComponentState
    let detail: String
    let action: ComponentAction?

    func validated() throws -> SetupComponent {
        guard !id.isEmpty, id.count <= 80, !label.isEmpty, label.count <= 100,
              detail.count <= 2_000 else { throw SetupParseError.invalid }
        return self
    }
}

struct SetupReport: Decodable {
    let version: Int
    let phase: SetupPhase
    let allProjects: Bool
    let allowWrite: Bool
    let components: [SetupComponent]
    let message: String?
    let modSettings: ModSettings?
    let modInfo: ModInfo?

    private static let providerIDs: Set<String> = ["codex-cli", "claude-cli", "codex-login", "claude-login", "codex-desktop", "claude-desktop"]

    var needsProviderFollowUp: Bool {
        components.contains { Self.providerIDs.contains($0.id) && [.missing, .loginRequired].contains($0.state) }
    }

    func providerBecameReady(from previous: SetupReport?) -> Bool {
        guard let previous else { return false }
        let old = Dictionary(uniqueKeysWithValues: previous.components.map { ($0.id, $0.state) })
        return components.contains { component in
            Self.providerIDs.contains(component.id) && component.state == .ready
                && old[component.id].map { $0 == .missing || $0 == .loginRequired } == true
        }
    }

    var attentionComponents: [SetupComponent] {
        components.filter { [.blocked, .missing, .loginRequired].contains($0.state)
            || ($0.state == .waiting && ["claude-mod", "claude-mod-activation"].contains($0.id)) }
    }

    var needsSetupRetry: Bool {
        attentionComponents.contains { component in
            guard [.blocked, .missing, .loginRequired].contains(component.state) else { return false }
            guard let action = component.action else { return false }
            return [.retry, .loginCodex, .loginClaude].contains(action)
        }
    }

    var connectionSummaries: [SetupComponent] {
        [("codex", "Codex", ComponentAction.openCodex), ("claude", "Claude", ComponentAction.openClaude)].map { provider, title, open in
            let entries = components.filter { ["\(provider)-cli", "\(provider)-login", "\(provider)-desktop"].contains($0.id) }
            let issue = entries.first { [.blocked, .missing, .loginRequired].contains($0.state) }
                ?? entries.first { $0.state != .ready }
            let complete = entries.count == 3 && issue == nil
            return SetupComponent(id: "\(provider)-connection", label: title, state: complete ? .ready : issue?.state ?? .waiting,
                                  detail: complete ? "Ready to connect" : issue?.detail ?? "Checking connection…",
                                  action: complete ? open : nil)
        }
    }

    static func parse(_ data: Data) throws -> SetupReport {
        let decoder = JSONDecoder()
        let report = try decoder.decode(SetupReport.self, from: data)
        guard report.version == 1, report.allProjects, report.allowWrite,
              report.components.count <= 24, report.message?.count ?? 0 <= 2_000 else {
            throw SetupParseError.invalid
        }
        _ = try report.components.map { try $0.validated() }
        try report.modInfo?.validate()
        guard Set(report.components.map(\.id)).count == report.components.count else {
            throw SetupParseError.invalid
        }
        guard report.phase != .ready || (!report.components.isEmpty && report.components.allSatisfy { $0.state == .ready }) else {
            throw SetupParseError.invalid
        }
        return report
    }
}

struct ModSettings: Decodable {
    let nativeWake: Bool
    let selfWake: Bool
}

struct ModInfo: Decodable {
    let bundledVersion: String?
    let installedVersion: String?
    let managerVersion: String?
    let loadedVersion: String?
    let reason: String?
    let route: String?

    func validate() throws {
        for value in [bundledVersion, installedVersion, managerVersion, loadedVersion, reason, route] {
            if let value, value.isEmpty || value.utf8.count > 128
                || value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
                throw SetupParseError.invalid
            }
        }
    }
}

enum SetupParseError: Error { case invalid }

struct ModelSettings: Decodable {
    struct Defaults: Decodable {
        let codex: String?
        let claude: String?
    }
    let defaultModels: Defaults
    let defaultEfforts: Defaults?
    let defaultPermission: String?

    static let codexEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    static let claudeEfforts = ["low", "medium", "high", "xhigh", "max"]
    static let permissions = ["read-only", "workspace-write", "full-access"]

    static func parse(_ data: Data) throws -> ModelSettings {
        let settings = try JSONDecoder().decode(ModelSettings.self, from: data)
        for model in [settings.defaultModels.codex, settings.defaultModels.claude] {
            guard model == nil || (!model!.isEmpty && model!.utf8.count <= 200
                && !model!.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })) else {
                throw SetupParseError.invalid
            }
        }
        for (effort, supported) in [(settings.defaultEfforts?.codex, codexEfforts), (settings.defaultEfforts?.claude, claudeEfforts)] {
            guard effort == nil || supported.contains(effort!) else { throw SetupParseError.invalid }
        }
        guard settings.defaultPermission == nil || permissions.contains(settings.defaultPermission!) else { throw SetupParseError.invalid }
        return settings
    }
}

/// The cache settings the app window shows, all saved in the Claudex broker:
/// the default warming limit (Claude Code and Codex), the startup TTL
/// preference (Claude Code only) and the enrollments that are still running.
struct WarmSettings: Decodable {
    struct Active: Decodable {
        let claude: Int?
        let codex: Int?
    }
    struct Enrollment: Decodable {
        let provider: String
        let sessionId: String
        let cwd: String
        let ttl: String?
        let used: Int
        let max: Int?
        let until: Double
        let nextAt: Double?
    }
    let defaultLimit: String
    let saved: Bool
    /// nil while no preference has been saved in Claudex.
    let ttlMode: String?
    let startupTtl: String?
    let active: Active?
    let warming: [Enrollment]?

    static let presets = ["for=1h", "for=2h", "for=4h", "for=8h", "for=12h", "for=24h", "for=72h", "for=168h",
                          "rounds=3", "rounds=5", "rounds=10", "rounds=20", "rounds=50", "rounds=100"]
    static let ttlModes = ["session", "remember", "default"]
    static let ttls = ["1h", "5m"]

    static func valid(_ limit: String) -> Bool {
        limit.utf8.count <= 32 && limit.range(of: "^(rounds|for|until)=[0-9a-z:]+$", options: .regularExpression) != nil
    }

    static func parse(_ data: Data) throws -> WarmSettings {
        let settings = try JSONDecoder().decode(WarmSettings.self, from: data)
        guard valid(settings.defaultLimit),
              settings.ttlMode == nil || ttlModes.contains(settings.ttlMode!),
              settings.startupTtl == nil || ttls.contains(settings.startupTtl!),
              [settings.active?.claude, settings.active?.codex].allSatisfy({ $0 == nil || (0...4096).contains($0!) }),
              (settings.warming ?? []).count <= 64,
              (settings.warming ?? []).allSatisfy({ ["claude", "codex"].contains($0.provider) && !$0.sessionId.isEmpty
                  && $0.sessionId.utf8.count <= 100 && $0.cwd.hasPrefix("/") && $0.cwd.utf8.count <= 4096
                  && ($0.ttl == nil || ttls.contains($0.ttl!)) && $0.used >= 0 && ($0.max ?? 0) >= 0 }) else { throw SetupParseError.invalid }
        return settings
    }
}

enum SetupCommand {
    case inspect
    case startup
    case setup
    case login(String)
    case modSetup(receiver: Bool? = nil)
    case modEnable

    var arguments: [String] {
        switch self {
        case .inspect: return ["inspect"]
        case .startup: return ["startup"]
        case .setup: return ["setup"]
        case .login(let provider): return ["login", "--provider", provider]
        case .modSetup(let receiver): return ["mod-setup"] + (receiver.map { ["--receiver", $0 ? "enabled" : "disabled"] } ?? [])
        case .modEnable: return ["mod-setup", "--enable"]
        }
    }
}

enum SetupProcessError: Error {
    case unavailable, excessiveOutput, failed(Int32), invalidResponse
    case engineMessage(String)

    var message: String {
        switch self {
        case .unavailable: return "The bundled setup engine is unavailable. Reinstall Claudex and try again."
        case .excessiveOutput: return "The setup engine returned too much data. Setup status could not be verified."
        case .failed(let code): return "The setup engine exited with code \(code). Check the app installation, then retry."
        case .invalidResponse: return "The setup engine returned an unrecognized status. Setup is not confirmed."
        case .engineMessage(let detail): return detail
        }
    }
}

struct ResolveResult: Decodable {
    struct Failure: Decodable {
        let taskId: String
        let error: String
    }
    let resolved: Int
    let failed: [Failure]
}

struct StopResult: Decodable {
    let stopped: Bool
    let detail: String?
}

final class SetupRunner {
    private let root: String
    private let node: URL
    private let engine: URL
    private let maxOutput = 1_048_576
    private let readOnly: Bool

    init(root: String, resources: URL?, readOnly: Bool = false) {
        self.root = root
        self.readOnly = readOnly
        let base = resources ?? URL(fileURLWithPath: "/nonexistent")
        self.node = base.appendingPathComponent("runtime/bin/node")
        self.engine = base.appendingPathComponent("engine/bin/claudex-app.mjs")
    }

    func run(_ command: SetupCommand, completion: @escaping (Result<SetupReport, SetupProcessError>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.execute(command)
            DispatchQueue.main.async { completion(result) }
        }
    }

    func models(codex: String? = nil, claude: String? = nil, codexEffort: String? = nil, claudeEffort: String? = nil,
                permission: String? = nil, completion: @escaping (Result<ModelSettings, SetupProcessError>) -> Void) {
        var arguments = ["models"]
        if let codex, let claude { arguments += ["--codex-model", codex, "--claude-model", claude] }
        if let codexEffort, let claudeEffort { arguments += ["--codex-effort", codexEffort, "--claude-effort", claudeEffort] }
        if let permission { arguments += ["--default-permission", permission] }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.executeData(arguments).flatMap { data -> Result<ModelSettings, SetupProcessError> in
                do { return .success(try ModelSettings.parse(data)) }
                catch { return .failure(.invalidResponse) }
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    func warmSettings(defaultLimit: String? = nil, ttlMode: String? = nil, ttl: String? = nil,
                      stop: WarmSettings.Enrollment? = nil, completion: @escaping (Result<WarmSettings, SetupProcessError>) -> Void) {
        var arguments = ["warm-settings"]
        if let stop { arguments = ["warm-stop", "--provider", stop.provider, "--session", stop.sessionId, "--cwd", stop.cwd] }
        if let defaultLimit { arguments += ["--default-limit", defaultLimit] }
        if let ttlMode { arguments += ["--ttl-mode", ttlMode] }
        if let ttl { arguments += ["--ttl", ttl] }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.executeData(arguments).flatMap { data -> Result<WarmSettings, SetupProcessError> in
                do { return .success(try WarmSettings.parse(data)) }
                catch { return .failure(.invalidResponse) }
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    func resolveUncertain(completion: @escaping (Result<ResolveResult, SetupProcessError>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.executeData(["resolve-uncertain"]).flatMap { data -> Result<ResolveResult, SetupProcessError> in
                do { return .success(try JSONDecoder().decode(ResolveResult.self, from: data)) }
                catch { return .failure(.invalidResponse) }
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    func stop(statusOnly: Bool = false, completion: @escaping (Result<StopResult, SetupProcessError>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.executeData([statusOnly ? "stop-status" : "stop"]).flatMap { data -> Result<StopResult, SetupProcessError> in
                do { return .success(try JSONDecoder().decode(StopResult.self, from: data)) }
                catch { return .failure(.invalidResponse) }
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    private func execute(_ command: SetupCommand) -> Result<SetupReport, SetupProcessError> {
        executeData(command.arguments).flatMap { data in
            do { return .success(try SetupReport.parse(data)) }
            catch { return .failure(.invalidResponse) }
        }
    }

    private func executeData(_ arguments: [String]) -> Result<Data, SetupProcessError> {
        let files = FileManager.default
        guard files.isExecutableFile(atPath: node.path), files.fileExists(atPath: engine.path) else {
            return .failure(.unavailable)
        }
        let process = Process()
        process.executableURL = node
        // Read-only inspection must not record engine state such as verification caches.
        process.arguments = [engine.path] + arguments + ["--root", root] + (readOnly ? ["--read-only"] : [])
        let output = Pipe(), errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        process.standardInput = FileHandle.nullDevice

        // Drain both pipes concurrently so a verbose error cannot deadlock the child.
        let group = DispatchGroup()
        let lock = NSLock()
        var stdout = Data(), stderrCount = 0, tooLarge = false
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            while true {
                let chunk = output.fileHandleForReading.readData(ofLength: 16_384)
                if chunk.isEmpty { break }
                lock.lock()
                if stdout.count + chunk.count <= self.maxOutput { stdout.append(chunk) }
                else { tooLarge = true }
                lock.unlock()
            }
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            while true {
                let chunk = errors.fileHandleForReading.readData(ofLength: 16_384)
                if chunk.isEmpty { break }
                lock.lock()
                stderrCount += chunk.count
                if stderrCount > self.maxOutput { tooLarge = true }
                lock.unlock()
            }
            group.leave()
        }
        do { try process.run() }
        catch {
            output.fileHandleForWriting.closeFile()
            errors.fileHandleForWriting.closeFile()
            group.wait()
            return .failure(.unavailable)
        }
        output.fileHandleForWriting.closeFile()
        errors.fileHandleForWriting.closeFile()
        process.waitUntilExit()
        group.wait()
        if tooLarge { return .failure(.excessiveOutput) }
        guard process.terminationStatus == 0 else {
            if ["models", "warm-settings", "warm-stop", "stop", "stop-status", "resolve-uncertain"].contains(arguments.first ?? ""), let response = try? JSONSerialization.jsonObject(with: stdout) as? [String: Any],
               let detail = response["error"] as? String, !detail.isEmpty, detail.count <= 2_000 {
                return .failure(.engineMessage(detail))
            }
            return .failure(.failed(process.terminationStatus))
        }
        return .success(stdout)
    }
}

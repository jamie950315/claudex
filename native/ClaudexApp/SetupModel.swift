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

    var attentionComponents: [SetupComponent] {
        components.filter { [.blocked, .missing, .loginRequired].contains($0.state) }
    }

    var needsSetupRetry: Bool {
        attentionComponents.contains { component in
            guard let action = component.action else { return false }
            return action != .diagnostics
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
        guard Set(report.components.map(\.id)).count == report.components.count else {
            throw SetupParseError.invalid
        }
        guard report.phase != .ready || (!report.components.isEmpty && report.components.allSatisfy { $0.state == .ready }) else {
            throw SetupParseError.invalid
        }
        return report
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

    static let codexEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    static let claudeEfforts = ["low", "medium", "high", "xhigh", "max"]

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
        return settings
    }
}

enum SetupCommand {
    case inspect
    case startup
    case setup
    case login(String)

    var arguments: [String] {
        switch self {
        case .inspect: return ["inspect"]
        case .startup: return ["startup"]
        case .setup: return ["setup"]
        case .login(let provider): return ["login", "--provider", provider]
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

final class SetupRunner {
    private let root: String
    private let node: URL
    private let engine: URL
    private let maxOutput = 1_048_576

    init(root: String, resources: URL?) {
        self.root = root
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
                completion: @escaping (Result<ModelSettings, SetupProcessError>) -> Void) {
        var arguments = ["models"]
        if let codex, let claude { arguments += ["--codex-model", codex, "--claude-model", claude] }
        if let codexEffort, let claudeEffort { arguments += ["--codex-effort", codexEffort, "--claude-effort", claudeEffort] }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.executeData(arguments).flatMap { data -> Result<ModelSettings, SetupProcessError> in
                do { return .success(try ModelSettings.parse(data)) }
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
        process.arguments = [engine.path] + arguments + ["--root", root]
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
            if arguments.first == "models", let response = try? JSONSerialization.jsonObject(with: stdout) as? [String: Any],
               let detail = response["error"] as? String, !detail.isEmpty, detail.count <= 2_000 {
                return .failure(.engineMessage(detail))
            }
            return .failure(.failed(process.terminationStatus))
        }
        return .success(stdout)
    }
}

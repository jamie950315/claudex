import Foundation
import Darwin
import AppKit

struct HealthIssue: Codable, Equatable {
    var target: String
    var identity: String?
    var reason: String
    var nextStep: String
    var savedWorkingDirectory: String? = nil
}

struct HealthReport: Codable, Equatable {
    var state: String
    var title: String
    var detail: String
    var symbol: String
    var attention: Bool
    var updatedAt: Double?
    var retryAt: Double?
    var autoRestart: Bool
    var operational = false
    var issues: [HealthIssue] = []
    // A specific request shown as the notification instead of the generic notice.
    var notice: String? = nil
    var issueKey: String { attention ? state + ":" + detail : "" }
}

enum StatusReadError: Error { case unsafe, tooLarge, changing }

func statusTimestamp(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber else { return nil }
    let timestamp = number.doubleValue
    // Diagnostic files use JavaScript millisecond timestamps. Refuse values
    // outside the JavaScript Date range before presentation converts them to Int.
    guard timestamp.isFinite, timestamp > 0, timestamp <= 8_640_000_000_000_000 else { return nil }
    return timestamp
}

func initialChecking(_ watcher: [String: Any]) -> Bool {
    guard watcher["mode"] as? String == "desktop" else { return false }
    let completion = watcher["checkingConversationCount"] == nil ? "foregroundCompletedAt" : "initialSweepCompletedAt"
    return watcher[completion] as? NSNumber == nil
}

func checkingProgress(_ watcher: [String: Any], now: Double) -> String? {
    guard initialChecking(watcher),
          let checked = watcher["checkedConversationCount"] as? Int,
          let total = watcher["checkingConversationCount"] as? Int,
          checked >= 0, total >= checked else { return nil }
    var lines = ["Checked \(checked) of \(total) conversations."]
    if let operation = watcher["currentOperation"] as? [String: Any],
       let identity = operation["conversationId"] as? String, !identity.isEmpty,
       let started = operation["startedAt"] as? NSNumber,
       started.doubleValue.isFinite, started.doubleValue > 0, started.doubleValue <= now {
        let elapsed = (now - started.doubleValue) / 1000
        if elapsed.isFinite && elapsed < Double(Int.max) {
            let title = (operation["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? identity
            let display = String(title.prefix(200)).replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
            lines.append("Checking \(display) (\(Int(elapsed)) seconds elapsed).")
        }
    }
    return lines.joined(separator: "\n")
}

func privateJSON(_ root: String, _ name: String) throws -> [String: Any]? {
    var directory = stat()
    guard root.hasPrefix("/"), URL(fileURLWithPath: root).resolvingSymlinksInPath().path == root,
          lstat(root, &directory) == 0, directory.st_uid == getuid(),
          directory.st_mode & S_IFMT == S_IFDIR, directory.st_mode & 0o077 == 0 else { throw StatusReadError.unsafe }
    let path = root + "/" + name
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    if fd < 0 { if errno == ENOENT { return nil }; throw StatusReadError.unsafe }
    defer { close(fd) }
    var before = stat()
    guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
          before.st_uid == getuid(), before.st_mode & 0o077 == 0, before.st_nlink == 1 else { throw StatusReadError.unsafe }
    guard before.st_size >= 0 && before.st_size <= 262144 else { throw StatusReadError.tooLarge }
    var bytes = [UInt8](repeating: 0, count: Int(before.st_size) + 1)
    let count = bytes.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
    var after = stat(), current = stat()
    guard count == before.st_size, fstat(fd, &after) == 0, lstat(path, &current) == 0,
          before.st_ino == after.st_ino, before.st_dev == after.st_dev, before.st_size == after.st_size,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
          before.st_ino == current.st_ino, before.st_dev == current.st_dev else { throw StatusReadError.changing }
    return try JSONSerialization.jsonObject(with: Data(bytes.prefix(count))) as? [String: Any]
}

func processAlive(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, number.doubleValue.rounded() == number.doubleValue,
          number.int64Value > 1, number.int64Value <= Int32.max else { return false }
    return kill(pid_t(number.int32Value), 0) == 0 || errno == EPERM
}

/// When the running Claude Desktop was launched, in milliseconds; nil when it is not running.
func claudeDesktopLaunchedAt() -> Double? {
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop")
        .compactMap { $0.launchDate }.max().map { $0.timeIntervalSince1970 * 1000 }
}

func classifyHealthBase(watcher: [String: Any]?, service: [String: Any]?, now: Double,
                    alive: (Any?) -> Bool = processAlive, claudeLaunchedAt: () -> Double? = { nil }) -> HealthReport {
    let automatic = service?["autoRestart"] as? Bool == true
    let updated = statusTimestamp(watcher?["updatedAt"])
    func report(_ state: String, _ title: String, _ detail: String, _ attention: Bool = false,
                _ retry: Double? = nil, operational: Bool = false) -> HealthReport {
        let symbols = ["ready": "checkmark.circle", "waiting": "clock", "recovering": "arrow.triangle.2.circlepath",
                       "paused": "pause.circle", "offline": "exclamationmark.triangle", "unknown": "questionmark.circle",
                       "stopping": "clock", "stopped": "stop.circle"]
        return HealthReport(state: state, title: title, detail: String(detail.prefix(700)),
                            symbol: symbols[state] ?? "questionmark.circle", attention: attention,
                            updatedAt: updated, retryAt: retry, autoRestart: automatic, operational: operational)
    }
    if let service, alive(service["pid"]) {
        let state = service["state"] as? String ?? ""
        if state == "stopping" { return report("stopping", "Stopping safely", "Waiting for active sessions to finish. No work is force-closed.") }
        if state == "blocked" {
            let blockers = service["blockers"] as? [[String: Any]] ?? []
            if watcher?["running"] as? Bool == true, alive(watcher?["pid"]),
               let update = updated, now - update < 120000, !blockers.isEmpty,
               service["blockerCount"] as? Int == blockers.count,
               blockers.allSatisfy({ $0["code"] as? String == "live-owner"
                   && ($0["pid"] as? NSNumber) == (watcher?["pid"] as? NSNumber) }) {
                // A restarted supervisor watches the existing worker instead
                // of replacing it. Its ownership hold is not a sync failure.
                var existing = classifyHealth(watcher: watcher, service: nil, now: now, alive: alive)
                existing.autoRestart = automatic
                return existing
            }
            return report("paused", "Recovery is waiting", "Another writer or an unverified ownership lock prevents a safe restart. Existing work is preserved. Ownership is checked again automatically.", true,
                          statusTimestamp(service["nextAttemptAt"]))
        }
        if state == "backoff" || state == "starting" {
            return report("recovering", "Recovering service", "The service will restart safely and verify the saved handoff before continuing. Messages are not blindly resent.", true,
                          statusTimestamp(service["nextAttemptAt"]))
        }
    }
    guard let watcher, alive(watcher["pid"]) else {
        if service?["state"] as? String == "stopped" {
            return report("stopped", "Service stopped", "The service was stopped normally. Login startup remains separate from a manual stop.")
        }
        return report("offline", "Service offline", automatic ? "The service is not running. Automatic recovery is configured; check again shortly or open diagnostics."
                      : "The service is not running. Open diagnostics to inspect the last error.", true)
    }
    if watcher["running"] as? Bool != true {
        return report("stopping", "Waiting for safe shutdown", "The coordinator has stopped. Native sessions are allowed to finish before recovery.", true)
    }
    if let updated, updated <= now + 5000, now - updated < 120000 {
        // Fresh status is not proof that every conversation has been delivered.
    } else {
        return report("unknown", "Status update overdue", "The process is alive, but its last status update is over two minutes old. It may be busy; synchronization is not confirmed.", true)
    }
    if let blocked = watcher["blocked"] as? [String: Any] {
        return report("paused", "Synchronization paused", blocked["reason"] as? String ?? "A saved handoff needs verified recovery.", true,
                      watcher["scheduler"] as? String == "completion-events" ? nil : statusTimestamp(blocked["retryAt"]))
    }
    if (watcher["blockedConversationCount"] as? Int ?? 0) > 0 {
        let entries = watcher["blockedConversations"] as? [[String: Any]] ?? []
        let count = watcher["blockedConversationCount"] as? Int ?? entries.count
        return report("paused", "Some conversations paused", "\(count) conversation(s) need attention. " + (entries.first?["reason"] as? String ?? "Open diagnostics for details."), true,
                      watcher["scheduler"] as? String == "completion-events" ? nil : statusTimestamp(entries.first?["retryAt"]))
    }
    if (watcher["blockedSourceCount"] as? Int ?? 0) > 0 {
        let sources = watcher["blockedSources"] as? [[String: Any]] ?? []
        let count = watcher["blockedSourceCount"] as? Int ?? sources.count
        return report("paused", "New conversations need attention", "\(count) new conversation(s) could not be enrolled. Existing conversations can continue. "
                      + (sources.first?["reason"] as? String ?? "Open diagnostics for details."), true)
    }
    for key in ["folderProjection", "localHandoff"] {
        if let component = watcher[key] as? [String: Any], component["state"] as? String == "error" {
            return report("paused", "Desktop integration needs attention", component["error"] as? String ?? "Folder placement or archival could not be verified.", true)
        }
    }
    // Claude Desktop loaded frontend files before they were prepared. The
    // request ends by itself once Desktop has been started after that write.
    if let restart = watcher["claudeDesktopRestart"] as? [String: Any], let since = restart["requiredSince"] as? NSNumber,
       let launched = claudeLaunchedAt(), launched <= since.doubleValue,
       now >= (restart["notBefore"] as? NSNumber)?.doubleValue ?? 0 {
        var result = report("waiting", "Restart Claude to finish updating",
                            "Claude Desktop loaded a new version before Claudex could prepare it. Quit and reopen Claude to restore folder placement, conversation wake and the /claudex command. Synchronization is not affected.", true)
        result.notice = result.detail
        return result
    }
    if let renderer = watcher["rendererAdapters"] as? [String: Any], renderer["state"] as? String == "checking" {
        return report("waiting", "Checking Desktop integration",
                      "The frontend cache changed during inspection. Claudex is checking it again; no action is required.")
    }
    if let renderer = watcher["rendererAdapters"] as? [String: Any], renderer["state"] as? String == "held" {
        return report("waiting", "Waiting for Desktop integration",
                      "Desktop integration is waiting for Claudex to resume and finish checking. No action is required.")
    }
    if let handoff = watcher["localHandoff"] as? [String: Any],
       handoff["state"] as? String == "waiting", handoff["deferred"] as? String == "history_changed" {
        return report("waiting", "Waiting for Desktop handoff",
                      "A conversation changed while its old Desktop entry was being checked. Archival was postponed and will be rechecked automatically; synchronization is not blocked by this check.")
    }
    if let waiting = watcher["waiting"] as? String, !waiting.isEmpty {
        if waiting.localizedCaseInsensitiveContains("backend is not ready") {
            return report("waiting", "Waiting for Codex", "Open Codex normally. Synchronization resumes when its shared backend is available.")
        }
        let work = ["still running", "complete assistant", "no completed persisted history", "in-progress", "unfinished",
                    "incomplete final", "empty or invalid conversation", "transcript changed", "source history changed",
                    "active writer", "destination is active", "Claude Code is open", "another bridge operation"]
            .contains(where: waiting.localizedCaseInsensitiveContains)
        return report("waiting", work ? "Waiting for a conversation to finish" : "Waiting for a connection",
                      work ? "A tracked conversation is still replying, changing, or busy. Its next handoff waits for a complete turn and an idle destination; Claudex checks again automatically."
                      : "The connection is not ready. Claudex checks again automatically.", operational: work)
    }
    if initialChecking(watcher) {
        return report("waiting", "Checking history in background", "Saved histories are being checked in the background; they are not being imported again. New and changed conversations are prioritized. Wait for the latest messages in the conversation you are using before switching apps.")
    }
    return report("ready", "Synchronization ready", "No reported synchronization blocks. Before switching apps, still wait for the current reply and its latest messages to appear.", operational: true)
}

func classifyHealth(watcher: [String: Any]?, service: [String: Any]?, now: Double,
                    alive: (Any?) -> Bool = processAlive, claudeLaunchedAt: () -> Double? = { nil }) -> HealthReport {
    var result = classifyHealthBase(watcher: watcher, service: service, now: now, alive: alive, claudeLaunchedAt: claudeLaunchedAt)
    if result.state == "waiting", let watcher,
       watcher["running"] as? Bool == true, alive(watcher["pid"]),
       let updated = watcher["updatedAt"] as? NSNumber,
       now - updated.doubleValue >= -5000, now - updated.doubleValue < 120000,
       let progress = checkingProgress(watcher, now: now) {
        result.detail = String((progress + "\n" + result.detail).prefix(700))
        result.operational = false
    }
    var issues: [HealthIssue] = []
    func bounded(_ value: Any?, _ fallback: String, _ limit: Int) -> String {
        guard let text = value as? String, !text.isEmpty else { return fallback }
        return String(text.prefix(limit))
    }
    func append(_ entry: [String: Any], target: String, waiting: Bool, fallback: String) {
        guard issues.count < 20 else { return }
        let reason = bounded(entry["reason"], fallback, 1000)
        let directoryUnavailable = entry["workingDirectoryUnavailable"] as? [String: Any]
        let savedWorkingDirectory = directoryUnavailable?["savedCwd"] as? String
        let unavailableDirectory = savedWorkingDirectory.flatMap { path -> String? in
            guard path.hasPrefix("/"), path.utf8.count <= 4096,
                  !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
            return path
        }
        let nextStep: String
        if !waiting && unavailableDirectory != nil {
            switch directoryUnavailable?["reason"] as? String {
            case "missing":
                nextStep = directoryUnavailable?["autoStopFailed"] as? Bool == true
                    ? "Claudex could not safely stop tracking this conversation. Histories are preserved. Open diagnostics for the blocking reason; do not retry setup or resend messages."
                    : "When the saved working directory is confirmed missing, Claudex stops tracking automatically and preserves all histories. If still paused, open diagnostics for the safety hold. Do not retry setup or resend messages."
            case "alias":
                nextStep = "Restore the saved working directory, or stop tracking this conversation while preserving its histories. Stop synchronization normally before changing tracking; do not retry setup or resend messages."
            default:
                nextStep = "Check the saved working directory and open diagnostics for the exact reason. Histories are preserved; do not retry setup or resend messages."
            }
        } else if !waiting { nextStep = "Open diagnostics for the exact conflict. Do not retry setup or resend messages." }
        else if ["backend is not ready", "sign-in", "permission prompt"].contains(where: reason.localizedCaseInsensitiveContains) {
            nextStep = "Open Codex or Claude and finish any sign-in or permission prompt."
        } else if ["still running", "complete assistant", "unfinished", "in-progress", "incomplete", "changed", "active writer", "destination is active", "Claude Code is open", "another bridge operation"].contains(where: reason.localizedCaseInsensitiveContains) {
            nextStep = "Wait for the reply to finish. No action is required."
        } else { nextStep = "Waiting for a connection. Claudex will retry automatically; no setup changes are needed." }
        let id = entry["conversationId"] as? String ?? entry["nativeId"] as? String
        issues.append(HealthIssue(target: bounded(entry["title"], id ?? target, 200), identity: id.map { String($0.prefix(100)) },
                                  reason: reason, nextStep: nextStep, savedWorkingDirectory: unavailableDirectory))
    }
    let fresh = watcher?["running"] as? Bool == true && alive(watcher?["pid"])
        && ((watcher?["updatedAt"] as? NSNumber).map { now - $0.doubleValue >= -5000 && now - $0.doubleValue < 120000 } ?? false)
    if fresh, let watcher {
        if let blocked = watcher["blocked"] as? [String: Any] {
            append(blocked, target: "Synchronization", waiting: false, fallback: result.detail)
        }
        for entry in watcher["blockedConversations"] as? [[String: Any]] ?? [] {
            append(entry, target: "Synchronization", waiting: false, fallback: result.detail)
        }
        for entry in watcher["blockedSources"] as? [[String: Any]] ?? [] {
            append(entry, target: "Synchronization", waiting: false, fallback: result.detail)
        }
        for (key, label) in [("folderProjection", "Native project folders"), ("localHandoff", "Desktop handoff")] {
            if let entry = watcher[key] as? [String: Any], entry["state"] as? String == "error" {
                var details = entry; details["reason"] = entry["error"]
                append(details, target: label, waiting: false, fallback: result.detail)
            }
        }
        let contexts = watcher["waitingContexts"] as? [[String: Any]] ?? []
        for entry in contexts { append(entry, target: "Synchronization", waiting: true, fallback: result.detail) }
        if contexts.isEmpty, let waiting = watcher["waiting"] as? String, !waiting.isEmpty {
            append(["reason": waiting], target: "Synchronization", waiting: true, fallback: result.detail)
        }
        if let handoff = watcher["localHandoff"] as? [String: Any], handoff["deferred"] as? String == "history_changed" {
            var details = handoff; details["reason"] = "A conversation changed while its old Desktop entry was being checked. Archival was postponed and will be rechecked automatically; synchronization is not blocked by this check."
            append(details, target: "Desktop handoff", waiting: true, fallback: result.detail)
        }
    }
    if issues.isEmpty && result.attention { append([:], target: "Synchronization", waiting: false, fallback: result.detail) }
    result.issues = issues
    return result
}

func loadHealth(_ root: String) -> HealthReport {
    do {
        return classifyHealth(watcher: try privateJSON(root, "watcher-status.json"),
                              service: try privateJSON(root, "service-status.json"),
                              now: Date().timeIntervalSince1970 * 1000, claudeLaunchedAt: claudeDesktopLaunchedAt)
    } catch StatusReadError.changing {
        return HealthReport(state: "waiting", title: "Checking status", detail: "The status file is being updated. Checking again shortly.",
                            symbol: "clock", attention: false, autoRestart: false)
    } catch {
        return HealthReport(state: "unknown", title: "Status unavailable", detail: "The private status files could not be verified. No session files were changed.",
                            symbol: "exclamationmark.triangle", attention: true, autoRestart: false)
    }
}

struct NoticeGate {
    var pendingKey = ""
    var pendingSince = 0.0
    var lastIssue = ""
    var lastNoticeAt = 0.0
    mutating func event(for report: HealthReport, now: Double) -> String? {
        if report.attention {
            if pendingKey != report.issueKey { pendingKey = report.issueKey; pendingSince = now }
            guard now - pendingSince >= 15000, now - lastNoticeAt >= 60000, lastIssue != pendingKey else { return nil }
            lastIssue = pendingKey; lastNoticeAt = now
            return "attention"
        }
        pendingKey = ""; pendingSince = 0
        guard report.operational, !lastIssue.isEmpty, now - lastNoticeAt >= 15000 else { return nil }
        lastIssue = ""; lastNoticeAt = now
        return "recovered"
    }
}

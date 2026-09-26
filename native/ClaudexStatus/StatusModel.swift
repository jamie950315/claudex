import Foundation
import Darwin

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
    var issueKey: String { attention ? state + ":" + detail : "" }
}

enum StatusReadError: Error { case unsafe, tooLarge, changing }

func privateJSON(_ root: String, _ name: String) throws -> [String: Any]? {
    var directory = stat()
    guard root.hasPrefix("/"), URL(fileURLWithPath: root).resolvingSymlinksInPath().path == root,
          lstat(root, &directory) == 0, directory.st_uid == getuid(),
          directory.st_mode & S_IFMT == S_IFDIR, directory.st_mode & 0o077 == 0 else { throw StatusReadError.unsafe }
    let path = root + "/" + name
    let fd = open(path, O_RDONLY | O_NOFOLLOW)
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

func classifyHealth(watcher: [String: Any]?, service: [String: Any]?, now: Double,
                    alive: (Any?) -> Bool = processAlive) -> HealthReport {
    let automatic = service?["autoRestart"] as? Bool == true
    let updated = (watcher?["updatedAt"] as? NSNumber)?.doubleValue
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
                          (service["nextAttemptAt"] as? NSNumber)?.doubleValue)
        }
        if state == "backoff" || state == "starting" {
            return report("recovering", "Recovering service", "The service will restart safely and verify the saved handoff before continuing. Messages are not blindly resent.", true,
                          (service["nextAttemptAt"] as? NSNumber)?.doubleValue)
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
                      (blocked["retryAt"] as? NSNumber)?.doubleValue)
    }
    if (watcher["blockedConversationCount"] as? Int ?? 0) > 0 {
        let entries = watcher["blockedConversations"] as? [[String: Any]] ?? []
        let count = watcher["blockedConversationCount"] as? Int ?? entries.count
        return report("paused", "Some conversations paused", "\(count) conversation(s) need attention. " + (entries.first?["reason"] as? String ?? "Open diagnostics for details."), true,
                      (entries.first?["retryAt"] as? NSNumber)?.doubleValue)
    }
    for key in ["folderProjection", "localHandoff"] {
        if let component = watcher[key] as? [String: Any], component["state"] as? String == "error" {
            return report("paused", "Desktop integration needs attention", component["error"] as? String ?? "Folder placement or archival could not be verified.", true)
        }
    }
    if let waiting = watcher["waiting"] as? String, !waiting.isEmpty {
        if waiting.localizedCaseInsensitiveContains("backend is not ready") {
            return report("waiting", "Waiting for Codex", "Open Codex normally. Synchronization resumes when its shared backend is available.")
        }
        let work = ["still running", "complete assistant", "no completed persisted history", "in-progress", "unfinished",
                    "incomplete final", "empty or invalid conversation", "transcript changed", "source history changed",
                    "active writer", "destination is active", "Claude Code is open", "another bridge operation"]
            .contains(where: waiting.localizedCaseInsensitiveContains)
        return report("waiting", work ? "Waiting for a safe boundary" : "Waiting for a connection",
                      "A reply, native file update, or connection is still in progress. Claudex checks again automatically; no action is normally needed.", operational: work)
    }
    if watcher["mode"] as? String == "desktop", watcher["foregroundCompletedAt"] as? NSNumber == nil {
        return report("waiting", "Checking conversations", "Native connections and saved histories are being verified. Wait for the latest messages before switching apps.")
    }
    return report("ready", "Synchronization ready", "No reported synchronization blocks. Before switching apps, still wait for the current reply and its latest messages to appear.", operational: true)
}

func loadHealth(_ root: String) -> HealthReport {
    do {
        return classifyHealth(watcher: try privateJSON(root, "watcher-status.json"),
                              service: try privateJSON(root, "service-status.json"),
                              now: Date().timeIntervalSince1970 * 1000)
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

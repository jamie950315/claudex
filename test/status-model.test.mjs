import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('native status model distinguishes liveness, guarded recovery, freshness, and deduplicated notices',
  { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-status-model-'));
    const main = join(root, 'main.swift'), binary = join(root, 'status-model');
    await writeFile(main, `import Foundation
let now = 1700000000000.0
let alive: (Any?) -> Bool = { ($0 as? Int) == 42 }
let ready: [String: Any] = ["pid": 42, "running": true, "updatedAt": now, "blockedConversationCount": 0]
func check(_ condition: Bool) { if !condition { fatalError("Status contract failed") } }
func health(_ watcher: [String: Any]? = ready, _ service: [String: Any]? = nil) -> HealthReport {
  classifyHealth(watcher: watcher, service: service, now: now, alive: alive)
}
check(health().state == "ready")
var initial = ready; initial["mode"] = "desktop"
initial["checkedConversationCount"] = 3; initial["checkingConversationCount"] = 12
initial["currentOperation"] = ["conversationId": "known-thread", "title": "Translation task", "startedAt": now - 65000] as [String: Any]
let checking = health(initial)
check(checking.state == "waiting" && checking.title == "Checking history in background" && !checking.operational)
check(checking.detail.contains("they are not being imported again") && checking.detail.contains("New and changed conversations are prioritized."))
check(checking.detail.contains("Checked 3 of 12 conversations."))
check(checking.detail.contains("Checking Translation task (65 seconds elapsed)."))
var invalidProgress = initial; invalidProgress["checkedConversationCount"] = 13
check(!health(invalidProgress).detail.contains("Checked "))
invalidProgress = initial; invalidProgress["currentOperation"] = ["title": "Unknown task", "startedAt": now - 1000] as [String: Any]
check(!health(invalidProgress).detail.contains("Checking Unknown task"))
invalidProgress = initial; invalidProgress["currentOperation"] = ["conversationId": "known-thread", "startedAt": now + 1000] as [String: Any]
check(!health(invalidProgress).detail.contains("seconds elapsed"))
invalidProgress = initial; invalidProgress["currentOperation"] = ["conversationId": "known-thread", "startedAt": now - 1200] as [String: Any]
check(health(invalidProgress).detail.contains("Checking known-thread (1 seconds elapsed)."))
invalidProgress = initial; invalidProgress["foregroundCompletedAt"] = now
check(health(invalidProgress).state == "waiting" && health(invalidProgress).detail.contains("Checked 3 of 12"))
invalidProgress["initialSweepCompletedAt"] = now
check(health(invalidProgress).state == "ready" && !health(invalidProgress).detail.contains("Checked "))
var legacy = ready; legacy["mode"] = "desktop"
check(health(legacy).state == "waiting")
legacy["foregroundCompletedAt"] = now
check(health(legacy).state == "ready")
invalidProgress = initial; invalidProgress["blocked"] = ["reason": "Exact history mismatch"]
check(health(invalidProgress).state == "paused" && health(invalidProgress).detail == "Exact history mismatch")
invalidProgress = initial; invalidProgress["waiting"] = "Shared Codex Desktop backend is not ready."
check(health(invalidProgress).title == "Waiting for Codex" && health(invalidProgress).detail.contains("Open Codex normally."))
invalidProgress = initial; invalidProgress["waiting"] = "Wait for a complete assistant turn or verified synchronized checkpoint."
check(!health(invalidProgress).operational && health(invalidProgress).title == "Waiting for a conversation to finish")
invalidProgress = initial; invalidProgress["updatedAt"] = now - 120001
check(health(invalidProgress).state == "unknown" && !health(invalidProgress).detail.contains("Checked "))
check(health(nil).state == "offline")
var changed = ready; changed["pid"] = 99
check(health(changed).state == "offline")
changed = ready; changed["updatedAt"] = now - 120001
check(health(changed).state == "unknown")
changed = ready; changed["blocked"] = ["reason": "Exact history mismatch", "retryAt": now + 30000] as [String: Any]
let paused = health(changed)
check(paused.state == "paused" && paused.attention && paused.retryAt == now + 30000)
changed = ready; changed["blockedConversationCount"] = 1
check(health(changed).state == "paused")
changed = ready; changed["blockedSourceCount"] = 1
changed["blockedSources"] = [["reason": "A new native history requires verification"]]
check(health(changed).attention && health(changed).title == "New conversations need attention")
changed = ready; changed["waiting"] = "Shared Codex Desktop backend is not ready."
check(health(changed).title == "Waiting for Codex")
changed = ready; changed["localHandoff"] = ["state": "error", "error": "Native history changed"]
check(health(changed).attention)
changed = ready; changed["localHandoff"] = ["state": "waiting", "deferred": "history_changed"]
check(health(changed).state == "waiting" && !health(changed).attention)
check(health(changed).title == "Waiting for Desktop handoff")
changed = ready; changed["waiting"] = "Wait for a complete assistant turn or verified synchronized checkpoint."
changed["waitingContexts"] = [["scope": "conversation", "conversationId": "thread-123", "title": "Translation task", "reason": "Wait for a complete assistant turn or verified synchronized checkpoint."]]
check(health(changed).issues.count == 1)
check(health(changed).issues[0].target == "Translation task")
check(health(changed).issues[0].identity == "thread-123")
check(health(changed).issues[0].nextStep == "Wait for the reply to finish. No action is required.")
check(!health(changed).attention)
changed = ready; changed["blocked"] = ["title": "Affected work", "conversationId": "thread-456", "reason": "Exact conflicting prefix"]
check(health(changed).issues[0].target == "Affected work")
check(health(changed).issues[0].reason == "Exact conflicting prefix")
check(health(changed).issues[0].nextStep.contains("Do not retry setup"))
check(health(changed).attention)
check(health().issues.isEmpty)
let recovering: [String: Any] = ["pid": 42, "state": "backoff", "autoRestart": true, "nextAttemptAt": now + 5000]
check(health(ready, recovering).state == "recovering" && health(ready, recovering).autoRestart)
check(health(ready, ["pid": 42, "state": "blocked", "blockerCount": 1,
  "blockers": [["code": "live-owner", "pid": 42]], "autoRestart": true]).state == "ready")
check(health(ready, ["pid": 42, "state": "blocked", "blockerCount": 1,
  "blockers": [["code": "unverified-lock"]], "autoRestart": true]).state == "paused")
check(health(ready, ["pid": 42, "state": "stopping"]).state == "stopping")
check(health(nil, ["state": "stopped"]).state == "stopped")
var gate = NoticeGate()
check(gate.event(for: paused, now: now) == nil)
check(gate.event(for: paused, now: now + 15000) == "attention")
check(gate.event(for: paused, now: now + 90000) == nil)
check(gate.event(for: health(), now: now + 90001) == "recovered")
check(gate.event(for: health(), now: now + 180000) == nil)
var busyRecovery = NoticeGate(); busyRecovery.lastIssue = "previous failure"; busyRecovery.lastNoticeAt = now - 60000
changed = ready; changed["waiting"] = "Wait for a complete assistant turn or verified synchronized checkpoint."
check(health(changed).operational && health(changed).title == "Waiting for a conversation to finish")
check(busyRecovery.event(for: health(changed), now: now) == "recovered")
changed["waiting"] = "Shared Codex Desktop backend is not ready."
check(!health(changed).operational)
changed["waiting"] = "Shared Codex transport closed."
check(!health(changed).operational)
var transient = NoticeGate()
check(transient.event(for: paused, now: now) == nil)
check(transient.event(for: health(), now: now + 1000) == nil)
check(transient.lastIssue.isEmpty)
let folder = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath().path
check((try privateJSON(folder, "good.json"))?["state"] as? String == "ready")
check(try privateJSON(folder, "missing.json") == nil)
do { _ = try privateJSON(folder, "link.json"); fatalError("Symlink was followed") } catch {}
do { _ = try privateJSON(folder, "public.json"); fatalError("Public file was trusted") } catch {}
print("status-contracts-passed")
`, { mode: 0o600 });
    await writeFile(join(root, 'good.json'), '{"state":"ready"}', { mode: 0o600 });
    await writeFile(join(root, 'public.json'), '{}', { mode: 0o644 });
    await chmod(join(root, 'public.json'), 0o644);
    await symlink(join(root, 'good.json'), join(root, 'link.json'));
    await run('xcrun', ['swiftc', resolve('native/ClaudexStatus/StatusModel.swift'), main, '-o', binary]);
    const result = await run(binary, [root]);
    assert.match(result.stdout, /status-contracts-passed/);
  });

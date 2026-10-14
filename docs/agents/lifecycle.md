# Tracking, discovery, holds and the service

Contributor rules moved out of AGENTS.md; they are binding. Scope: Enrollment and untracking, project relocation, per-conversation holds, pending-transaction recovery, dependency anchors, collection, split-original, archive-original, the supervisor and lock recovery.

- During normal synchronization, automatically stop enrollment when the exact
  saved working directory is confirmed absent, including before a cached skip.
  Use the existing locked tracking transition after pending recovery; revoke
  archival commands and preserve histories, checkpoints, records and assets.
  Keep stopped native identities excluded across startup and event discovery.
  Directory restoration requires explicit resume-tracking. Permission errors,
  existing aliases and history conflicts remain visible under their normal guards.

## Holds that recover on their own

These relaxations are user decisions; keep them when touching the same code.
A conversation that only waited during the startup sweep gets the same three
bounded follow-ups as a completion event. A Claude owner block persisted by one
engine version (`blockedEngine`) is judged again by another through the normal
checkpoint checks. Anchors and frozen snapshots over the backup quota are
reported by collection (`retained`) and never pause deliveries, because nothing
there can be removed; a removable snapshot that cannot be retired still does.
The Mod cache check accepts any native-generated `types/<package>/index.d.ts`
and `.orphaned_at`, never an additional script, skill or packaged file. The
collaboration process sampler ends tracking only after the process table stays
unreadable for ten seconds; each tracker's own identity checks still fail at once.

Claude Desktop may move a current unmanaged Local original to another project.
Reconcile only an exact, stable native registry mapping of the same CLI identity,
with the saved transcript absent, canonical owned regular destination bytes,
and complete authenticated saved canonical prefix. Historical native cwd values
remain untouched; the ledger's current cwd follows the native project. Recheck
the source proof after verifying an idle unchanged managed Codex counterpart.
Never reroute pending work or choose between independently advanced histories.
Create a normal Codex snapshot in the new cwd even without a new message; retain
old snapshot cwd and normal retirement guards. Keep at most 16 verified project
roots. Imported bootstrap originals and ambiguous duplicate paths remain blocked.
Stable relocated reads revalidate the registry and saved prefix without creating
a Claude writer or editing any native transcript or registry.

By user decision Codex project moves are followed too. Only a current unmanaged
Codex original qualifies: the saved cwd must be absent or an alias resolving to
the new directory Codex thread/read reports (global checks use the filesystem
alone so unmoved conversations never contact the backend; only after that
conversation's own read reports another working directory does its sync ask
for a thorough proof, which also follows a move whose saved directory still
exists, such as into a worktree), the complete history must keep
the saved prefix and two reads must agree. A Codex tail of closed turns (failed
or interrupted without a reply, in both reads) does not hold the move: it cannot
complete by waiting and stays in the native history; an in-progress tail waits.
A Claudex-owned Codex snapshot or preserved superseded Codex original, like a
Claude read, keeps its saved directory
string while Codex reports that same directory in either spelling (Codex later
reports the canonical one), even once that directory is an alias; only an
unmanaged original follows a Codex project move. Dependency anchors compare the
directory the same way. The managed Claude owner must be
idle and unchanged. Claude owners are per conversation and bound to their cwd,
so the move retires the old owner: close it at an idle boundary, move its state
to owners/retired/<hash>-<sessionId>.json and mark its record retired-owner (kept
forever, never collected, read without a process, excluded from freezing). A new
owner in the new cwd receives the complete history through the normal journaled
handoff (pending.relocation). Interrupted moves recognize the retired state and
must never restart the old owner. Its transcript and Remote Control entry remain.
A cold-imported pair's unmanaged Claude original is instead superseded like any
preserved original (unchanged, verified, idle) and the new owner is created
normally. Claude reads keep the saved cwd string when the transcript records
exactly it, so a renamed directory left as an alias is not misread as a move;
the directory must still resolve, and any other recorded cwd is canonicalized.
An owner is bound to its saved cwd string: once that directory is an alias of
another, starting it is a per-conversation CLAUDEX_TRACKED_CWD_UNAVAILABLE hold
(never a worker crash), and the move proof reads it from disk like a retired
owner, requiring its state lock to be absent. That disk read restores bound image
originals before authenticating packets, exactly like a running owner's view.

A native transcript file changing between successful handoff inspections is a
revoked, deferred Desktop archival attempt, not a synchronization failure. Return
history_changed only after clearing all archive actions and cached proofs; perform
full verification on the next poll. Canonical history conflicts, registration
changes and manifest revocation failures remain errors. Surface this narrow race
as waiting for Desktop handoff, without an attention notification.

Dependency-bearing owned Codex snapshots are preserved as managed
`dependency-anchor` records, not archived/deleted or relabeled unmanaged.
Require stable metadata-only native dependency inventories, exact authenticated
canonical history and raw-byte proofs, and rechecked promoted source/replacement
prefixes. Finalize only the original verified pending transaction; never resend.
Anchors are immutable guarded history sources, remain in the global backup byte
quota, and have a hard global count cap of 64. They are separate from disposable
previous snapshots' count/age limits. Missing or changed anchors block; never
auto-demote them, remove children, or skip preallocation capacity checks.

`bin/claudex.mjs` provides explicit initialization with all-project or selected-project scope, discovery,
watching, synchronization, recovery, collection, and optional macOS LaunchAgent
installation. Disposable-copy defaults retain one current and one previous copy per side,
seven-day rollback age, 512 MiB aggregate rollback quota, and 50 audit entries.
One extra candidate is allowed during a transaction; unresolved failures prevent
new allocation. Original source sessions are not disposable backups.
All-project discovery skips unsupported unenrolled histories and reports a
bounded diagnostic list. An unenrolled source whose working directory is
confirmed absent on this Mac (a Claude Desktop SSH session, a deleted project)
has nothing to enroll: report it as bounded absentSources, never as a blocked
source or a request for attention. A directory that merely cannot be resolved
stays a blocked source. Tracked conversations keep their own missing-directory
rules. Keep unsupported-source diagnostics across configuration
and unrelated native events; only exact targeted reinspection or full discovery
may replace their snapshot. Claude Desktop forks copy parent rows under the parent's
session ID into a new file. Enroll one under its file identity only after the
copied lines match the parent's native bytes (identity-free metadata may
follow) and it has its own completed reply; otherwise it is an unsupported
source, never an adopted parent identity or a worker crash. Allocation-time collection tags another
conversation's history failure with that conversation's identity for status. In Desktop mode, recognized tracked-history guards
pause synchronization without exiting the watcher or closing live Claude owners.
A pending transaction blocks all discovery, new syncs and collection until normal
verified recovery succeeds; it is never resent to regain availability. By user
decision a failed recovery no longer ends the watcher: the transaction stays
visibly blocked and the next pass retries it. Only one case is dropped
(`abandonUnapplied`, also `claudex abort` in Desktop mode): a prepared new Codex
snapshot whose planned rollout file is absent and whose thread Codex does not
know wrote nothing natively, so its conversation is held with the failure
reason and the others continue. Applied, promoted, owner-reusing and
original-archive transactions, and any unreadable answer, are always recovered.
Missing tracked transcript paths are explicit history blocks, not repeated
worker crashes. Preserve the saved native identity/path and pending evidence.
A removed saved working directory (such as a cleaned-up Codex worktree) is the
same kind of explicit hold (CLAUDEX_TRACKED_CWD_UNAVAILABLE), never a worker
crash or a substitute directory; the folder map omits only that owner's row.
The same applies when the saved cwd is no longer canonical (a renamed project
leaving a symlink alias) or not a directory: never follow or adopt the alias.
Omitted rows are reported as bounded folderProjection.unavailable diagnostics
while the projection stays ready; relocation needs its explicit protocol.
By user decision such a conversation is frozen: when a native adapter reports
any of its saved cwds absent, global collection defers its superseded-original,
dependency-anchor and current-side verification and never retires its snapshots
(they still count toward the backup quota; exceeding it blocks explicitly). Its
own syncs still verify everything and hold. Full verification resumes when the
directory exists again. Freezing is deferral, never checkpoint or mutation proof.
Explicit Desktop `untrack` stops enrollment while retaining canonical history,
native files, records and content assets. Keep the exact native identities indexed
so all-project discovery cannot reenroll them. Exclude stopped conversations from
sync queues, native owners, folder rows and archival actions; retain their managed
snapshots in retention quotas without retiring them. `resume-tracking` verifies
the saved originals, anchors and idle current prefixes before restoring enrollment;
missing directories or independently advanced current sides keep it stopped.

Explicit `split-original` preserves an independently continued superseded,
unmanaged Claude original as a separate logical conversation. Require exact
conversation/native/record IDs and an inspected completed checkpoint, the same
saved working directory, an authenticated shared prefix, an unchanged current
managed pair, and stable raw-byte and nanosecond identity proofs. Preserve the
existing pair and every native file; never merge or discard either tail. Move
only the original's enrollment and save an idempotent split receipt. Its new
counterpart is created by the subsequent normal guarded synchronization.
Event-filtered discovery skips a Codex source whose metadata read fails only
when its exact discovered rollout file is now absent (Desktop deleted a
transient thread); other metadata failures keep their severity.
Never scan for same-ID substitutes; only the explicit native registry relocation
protocol above may adopt a verified new project location without pending work.
Without pending work, affected syncs are held individually. By user decision,
allocation-time collection holds another conversation that fails its own
relocation, original, anchor, current-side or snapshot verification exactly like
a frozen one: nothing of it is retired, its snapshots still count toward the
quota, bridge.collectionHolds keeps it visible as blocked, and its own syncs keep
their explicit hold. The caller's own conversation, an unavailable backend and an
exceeded quota still stop the delivery; explicit collection reports every failure. In event mode a new relevant
event revalidates a hold; no recurring scan attempts to clear it. By user decision, an
unclassified failure of one conversation's sync holds only that conversation,
shown as blocked with its own reason: it requires no pending transaction, a
readable ledger and a shared backend that still answers. It is never retried or
reported as synchronized. Failed recovery of a pending transaction, an unreadable
ledger, aborts and failures outside a conversation's sync still end the worker. Discovery starts
at initialization, not a bulk history import.
An unenrolled source with no completed first turn does not make the entire
watcher wait. Transport failures and tracked waits remain visible. The status
app also surfaces the existing unsupported-new-source diagnostics.

The installed macOS service has an independent supervisor. Unexpected worker
exits restart after 5/10/20/40/60 seconds; two stable minutes reset backoff.
Read-only ownership preflight must find prior writers and recorded children dead.
Live/malformed/reclaiming locks or unrecorded children block duplicate writers.
By user decision leftover lock states no longer block forever: a holder PID
born more than two seconds after its lock was written (coordinator `started`,
owner lock mtime) is a reused PID, not the holder; a lock still empty after a
minute and a `.reclaim` claim older than a minute are reclaimed; an owner lock
without a recorded child blocks only while a parentless process under a Claude
path born with that lock exists. Unreadable start times stay live holders.
Never clear pending work, kill native user work or resend uncertain inputs to
recover. Launchd recovers supervisor crashes; detached workers and
AbandonProcessGroup retain surviving work until it exits safely. Normal exit
respects intentional stop, while login startup remains installed. CLI shutdown
rechecks only the explicit busy-owner refusal until native closure is safe.
service-status.json and watcher-status.json are disposable diagnostics written
by writeDiagnosticJSON (atomic rename, no device flush). Never use it for
journals, checkpoints, ownership, inbox or any state that authorizes work.

Explicit `archive-original CONVERSATION_ID --id NATIVE_ID` reconciliation may
also preserve-archive an unchanged legacy original plus its completed/unloaded
direct spawned-agent tree, validated on Codex .16.4 and 0.158.0-alpha.2.1.
Enumerate general, loaded and ancestor-specific inventories; general lists can
omit spawned children. Ordinary forks remain unchanged read-only witnesses.
Require stable full-history/raw-byte proofs, exact same-title/cwd replacement
and authenticated prefix before/after native archival. Journal requested only
at dispatch; unknown outcomes recover read-only without resend. No deletion or
relaxed ordinary retirement guards are implied.
Claude projections use canonical project paths and owned rollback storage.
The append helper is for controlled fixtures, not runtime concurrent writes.

Do not
claim production readiness for opaque/dependent compaction, external asset dependencies,
unverified project relocations, or unsigned reasoning replay. Verified project
moves use the explicit relocation protocols above. Visible reasoning is labeled
text; encrypted reasoning and native permissions do not migrate.

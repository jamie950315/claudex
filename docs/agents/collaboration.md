# Cross-model collaboration broker

Contributor rules moved out of AGENTS.md; they are binding. Scope: The work graph, MCP facade, chat mailbox and native wake, worker execution and permissions, observability, diagnostics, notifications, uncertainty resolution and acceptance evidence.

Work observability is broker-owned and independently configured per task:
`observability.timeline=public`, `reports=milestones`, and `blockerNotifications`.
Defaults collect no native public content. By explicit user decision (2026-10-15),
external root tasks whose effective notification mode is wake default
blockerNotifications to true; explicit false opts out. Queue/off roots and
managed children retain the off default. Preserve saved policies on existing tasks.
Keep public work events separate from content-free activity; allow only native
assistant messages and tool identity/status/exit metadata, never prompts,
reasoning, tool payloads or arbitrary output. Event reads use task/generation
cursors, not revisions, and expose eviction/collection-capacity gaps. Complete
reports use the separate bounded work_reports API; do not put their entire
history back in status. These observability reads preserve child-result
acknowledgement state; ordinary status/wait retain their existing worker outcome
acknowledgement contract.
Blocker transitions retain exact ID/generation, deduplicate unchanged reports,
and revoke stale native dispatch after awaited preflights. Managed parents use
child-progress context, never external native-chat controller privileges.
Follow-up instruction context delivery is distinct from worker-reported adoption
and actual completion. Worker-only generation-fenced check-in can deliver queued
instructions during the current invocation; exact accepted/rejected acknowledgements
consume them for continuation scheduling, never prove completed work. Ordinary
status does not consume the instruction queue. Eligible worker MCP response
boundaries may append separate bounded inbox context through actor-derived
worker_check_in RPC; controllers do
not auto-consume, and end-turn receipts suppress intake. Preserve original tool
results and explicit intake failures without retrying tools or uncertain work.
This is cooperative delivery, not native steer/interrupt or a second writer.
Opted-in managed child milestones can resume a waiting parent before child completion;
deduplicate identical same-generation reports and consumed progress notices without
acknowledging unrelated child outcomes or enabling external native-chat wake.
Cooperative pause remains pending until the worker's
checkpoint, successful native completion and owned-process exit; no SIGSTOP,
forced interruption, second writer or uncertain replay. End-turn receipts
override any report requirement. File evidence requires a declared artifact and
canonical, stable no-follow identities within task roots, even for full-access
work. Exact-file Git diffs remain shared-workspace observations with unknown
authorship. UI expansion/reads never imply result review or integration.
Completed-result review and blocker-closure annotations retain the work revision
and completion timestamp; they must not create another unread result or native
completion wake. Their own records retain annotation timestamps and provenance.

AI-first diagnostics retain bounded native activity on each execution without
changing task revisions or child acknowledgements. Keep requested model/effort
separate from native response-model evidence; initialization, auxiliary and
aggregate model metadata are not main-response proof. Missing main-response model
metadata is benign `not-reported`, never task `uncertain` or a dispatch gate.
Normalize legacy model labels on presentation without rewriting history/revisions;
preserve actual native execution/process uncertainty. No prompts, tool payloads
or reasoning are diagnostic data. PID/process samples never update activity.
Per-task waitReason contains exact blockers (up to 64 IDs plus truncation/count);
the legacy global uncertain flag is not a per-task blocking claim. List supports
query-bound live pagination and filters. Task lists default to `order=id`, keeping
the legacy ID cursor and digest; explicit `order=recent` sorts `updatedAt`
descending with ascending ID ties and carries both values in the cursor.
Bind recent cursors to their order and filters; reject cross-order continuation.
Pages remain live: an updated task can move ahead of a saved cursor and requires
a first-page refresh to appear again. Never look up the cursor task's current
timestamp to resume a page. Multi-wait supports 1–16 targets with
one event listener, atomically acknowledging only returned child outcomes after
checking the MCP-escaped response bound. Preserve compatible single-task behavior.
Task waits default to five minutes and accept an explicit maximum of thirty minutes;
only validated waits extend the private RPC deadline. Native MCP host deadlines
remain independent. External controllers must request status checkNotification:true
after start and may end their turn only on await-notification. On wait with reason
awaiting-native-proof, re-check that status after retryAfterMs (2000 ms); other wait
reasons require continued claudex_wait monitoring. Exhausted proof attempts use
native-proof-attempts-exhausted without a short status-recheck hint.
Its continuation nextAction is a read-only
snapshot, never a dispatch lease or delivery guarantee: require verified origin,
available notification quota, exact current native routing and lifecycle checks.
Do not navigate, dispatch, change revisions or infer permission in this check.
Queue-only, unbound, stopped, ended and unobservable routes continue waiting.
External root notifications default to wake; off explicitly opts out. Main reads
authoritative status after reception.
MCP errors retain typed code and readable text through structuredContent.error.
Capacity errors additionally retain only fixed resource plus safe-integer used/limit
through Unix RPC and MCP; never serialize arbitrary error properties.
Worker-only report is generation-fenced and explicitly self-reported, never
verified goal completion or a replacement for completed/resultFinal. Handoff
reports preserve author provenance and normal completion/process-exit guards.
Controller requestId namespaces remain provider-scoped; do not migrate old
receipts or mistake that scope for native-origin proof.

Mod observations are content-free, self-reported diagnostics in broker memory:
at most 64 observers, 60-second server TTL, lifecycle/disconnect invalidation and
existing wait refresh. Never reuse observations as dispatch or claim permission.
Every new RPC must be in the private transport allowlist and tested over Unix
RPC. By explicit user decision (2026-10-15), external root start defaults to wake
when the broker has a native origin verifier: omitting notifications must not lose
the caller's completion wake. This supersedes the earlier default-off decision.
Explicit off opts out; explicit queue retains next-hook delivery. Default wake
uses a one-hour expiry after the terminal revision by explicit user decision
(2026-10-15), within the unchanged 1-second to 1-hour bound and is visible as
notificationMode in the start receipt. Preserve the original omitted arguments
in the native request fingerprint. No message is created before independent
native call/result origin proof. Managed children omit notifications and retain
only their child-result continuation, even when the broker has an origin verifier.
Manual CLI request start and Mod prepare/confirm explicitly keep omitted root
notifications off: neither produces a native MCP start call/result for PostToolUse
to prove. The Mod protocol still exposes no notifications field. Roots without
an origin verifier also stay off when omitted; explicit unsupported queue/wake
still refuses. Handoff preserves the original task notification policy and origin;
it does not create or rebind one.
PostToolUse supplies hints only: match the exact start arguments fingerprint,
one-use receipt challenge, primary session and call/result identity. Codex uses
bounded exact-turn native items; Claude verifies one exact native UUID/cwd transcript
under its configured native home, without requiring Desktop registry membership.
Persistent primary Codex origins accept native cli, vscode and exec source labels;
exec still requires non-ephemeral user-thread metadata and exact new call/result
proof. Exact native catalog lookup explicitly lists those primary source kinds;
Codex's default thread list can omit exec. Reject unknown and auxiliary sources.
A source label alone is never origin authority.
Persisted same-host CLI/SDK/Remote Control sessions qualify, including new native
calls after a managed bootstrap; copied ancestors/imported calls do not. Preserve
native result provenance and primary parent-chain checks, excluding agent nodes.
Canonical owned home/projects/project directories must reject foreign writes.
Nonpersistent, remote-host-only, missing or ambiguous evidence stays unbound;
never scan or accept arbitrary hook transcript paths. Origin proof is separate
from unchanged notification recipient/wake capability checks. Observed on
2026-10-15 with Claude Code 2.1.295: PostToolUse ran before the native tool_result
row was appended, and lifecycle-only recovery deadlocked with the caller's
in-turn wait protocol until the challenge expired. Codex exact-turn native items
can likewise remain inProgress or lack the persisted result at the first read.
By user decision, an ORIGIN_PROOF_UNAVAILABLE result retains one identity-only
hint and arms broker-owned read-only follow-ups after 1000 ms, then 3000 ms after
the next missing-proof result, strictly inside the original five-minute challenge.
Use the identical bindTaskOrigin verifier and original fingerprint/receipt; no
new hint, transcript scan, invocation or notification-send retry. Keep one hint
per task and reject a conflicting identity; coalesce overlapping checks. Timer,
duplicate bind and matching SessionStart/UserPromptSubmit/Stop recovery share the
existing three-attempt bound (lifecycle events still select at most four tasks).
Reserve each retained hint's attempt before reading, so shutdown/restart cannot
restore a spent read; retain unused attempts for later lifecycle recovery.
Success, invalid/bound-exceeded evidence and exhaustion end follow-ups. Expiry
prevents reads; broker close/app-stop clears timers and fences in-flight results,
without exhausting a stopped hint. No timer is persisted or rearmed at startup
or app resume: pending hints recover through matching lifecycle events. Do not
expand the PostToolUse matcher: broker follow-ups handle both providers without
changing hook definitions or requiring a new Codex trust review.
The new PostToolUse trust diagnostic is separate from legacy sync readiness.
Claude PostToolUse uses a single-text MCP content array; Codex uses the full
MCP envelope. Native Claude project directories may be 0755: require canonical
ownership and no group/world writes, retaining private stable single-link files.
Do not demand broker-only directory modes or chmod originals to validate origin.
Keep write-ahead notification intents, absolute expiry through awaited preflights,
and the final native dispatch fence. Interrupted/unknown dispatch never retries.
Coalesce undispatched terminal revisions. Task and origin quotas each allow 16
intents per rolling minute, independently for terminal and blocker notifications;
blockers cannot consume completion capacity. A throttled target stays pending
without an intent. One broker timer wakes at the earliest quota release or
absolute deadline; close/app-stop clears it and resume uses the existing marker
event. Expiry becomes an explicit missed delivery. Do not poll or resend an
existing intent. Retain all intent identities under the existing ledger byte and
request bounds (the validation ceiling covers 100,000 requests plus 100 generations),
rather than treating sixteen retained receipts as a lifetime send limit. Legacy
quota suppression without an intent is eligible again within its original TTL;
dispatched/uncertain records remain no-replay.
All terminal failure paths update updatedAt at the transition. Status joins exact
active/archive mailbox receipts, showing queued/offered/acknowledged/expired and
the separate dispatch state; it never manufactures an ACK or extends a TTL.
By explicit user decision (2026-10-15), expiry should begin when reception becomes
possible if the existing contract can prove that boundary. It cannot: readiness is
a volatile diagnostic, while the one-use receiver claim happens after the
write-ahead intent and mailbox deadline. Keep the existing terminal/blocker
transition start and absolute fences; never renew an offered/uncertain message.
Expose expiryStartsAt and unreadResult. An expired wake stays unread until its
exact terminal receipt is acknowledged or that generation is explicitly reviewed;
ordinary status reads do not manufacture a native receipt.
Notification intents record a fixed dispatch phase and typed failure code. Only
an internal preflight or mailbox-guard phase proves failed-not-sent; entering the
mailbox commit boundary or an unknown/native dispatch remains uncertain. Never
infer pre-dispatch safety from an error string/code alone. Keep origin references
for dispatching/uncertain evidence.
List/status expose completionDelivery separately from broker health: fresh watcher
PostToolUse trust for each provider, the selected route, diagnostic recipient
observations and concrete next-step codes. Missing/stale trust stays unknown.
Only explicit status checkNotification performs the existing exact-recipient
preflight. Aggregate loaded observers and a prior ACK never certify that recipient
or its effective native policy. Unknown Mod policy includes the missing proof and
observer reason when available, without changing native admission or defaults.
Status/wait remains the result authority.

`collaboration` is an explicit inference-capable work protocol, separate from
the no-inference history bridge. `src/collaboration-hub.mjs` owns one durable
work graph: delegation adds a parent edge and handoff transfers the same task's
owner at a completed native boundary. MCP exposes start/send/handoff/status/wait/
cancel/list through an owner-private Unix socket. Request IDs are idempotent;
generation capabilities fence old workers. Never launch the next owner before
the outgoing invocation and its owned process group finish. Never replay an
uncertain native invocation. In-flight work found after restart becomes uncertain;
preserve its process/session evidence and work record. By user decision an
uncertain task blocks only its own task tree and work whose access overlaps its
writable roots (full-access overlaps everything), not all dispatch. The broker
closes it as failed automatically (at startup and every 30 seconds) once the same
exit proof as controller resolve passes: leader, group and every recorded
descendant absent with a complete inventory. Writable work is then flagged for
workspace review in its error and receipt; nothing is replayed. Incomplete
inventories and live processes stay uncertain until an operator resolves them.
Native tools may detach into another process group. A shared bounded metadata
sampler records observed descendants by exact ancestry, PID, UID, PGID and UTC
start identity; persist those records with each execution. Recheck before every
individual signal and require both primary-group and recorded-descendant closure
before releasing ownership. Missing, changed or incomplete inventories retain
uncertainty. This is evidence for observed descendants, not every transient fork
or hostile same-user process. Never interpret a changed PGID as process absence.
A complete sample that no longer contains a descendant's birth identity proves
its exit. Shutdown also accepts exact leader birth absence plus a complete-table
proof that its process group is absent or its leader PID has been reused; never
probe or signal an unrelated reused PID as if it were the old worker. A surviving
leaderless group and any recorded live descendant still prevent shutdown.
Retire proven-exited descendants from the persisted inventory so the 256-record bound covers
unresolved descendants, not every short-lived test/tool process of a long
invocation. The leader is never retired, retained identities never change, and
a reused leader PID during active tracking or too many concurrently unresolved descendants still fail.
An interrupted inventory stays uncertain and blocks shutdown verification until
controller resolve supplies processInventoryReconciled plus nonempty notes, with
the leader, group and recorded descendants absent; keep the original evidence.

`bin/claudex-collaboration.mjs` runs the independent broker or stdio MCP facade.
Controller-only chat_list/chat_send/chat_status coordinate exact native sessions
through the private chat-mailbox, not through managed task IDs or a new writer.
Native SessionStart/UserPromptSubmit/Stop hooks register metadata and offer at most
one message; SessionEnd never consumes. Codex Stop uses native decision:block,
Claude Stop uses additionalContext. A continued Stop publishes started, not a
completed sync hint. stop_hook_active prevents additional Stop continuation loops.
Keep queued/offered/acknowledged distinct; offered may be lost and must never be
automatically replayed. Only the same native recipient's Stop acknowledgement
marker counts as receipt, never as proof of task shutdown or new authorization.
The sync hook registers and consumes in one ChatMailbox.hook journal
transaction with the same register-then-consume semantics.
Observed on 2026-10-15: the 1,024-chat journal filled with mostly ended
registrations, permanently refusing new hooks and losing their completion-wake
and peer-message routes. Capacity recovery is now demand-driven in that same
transaction, including legacy journals and native metadata discovery. Retire only
one needed slot, ended chats first, then non-ended chats unseen for at least 30
days; within each group use ascending lastSeenAt, then exact chatId. This forgets
mailbox metadata only, never native history, lifecycle state or ownership.
Queued/offered messages and any unresolved wake (including dispatching/uncertain
after ACK) pin their exact target and claim-source chats. Receipts remain paired
with their message. Unexpired wake-manifest entries pin their message and native
recipient; publication rechecks the queue under the retention lock after awaited
metadata reads. Native titles, observations and delivery diagnoses are not
references or retirement authority.
Read the adjacent private work ledger through a bounded stable no-follow read.
Pin verified origins (and unexpired origin hints) for nonterminal notification
tasks, unexpired unsuppressed terminal notifications awaiting publication, and
dispatching/uncertain deliveries. Publish changed task-origin pins under the
same mailbox lock before the work ledger becomes visible; this prevents hooks
from retiring an origin concurrently with binding or reopening its task.
On projected serialized-byte pressure as well as message/receipt count pressure,
plan enough oldest acknowledged or expired pairs (terminal time, createdAt,
then messageId) to fit the complete 1,024-pair/8-MiB journal, including its
actual pretty JSON plus newline. Exclude unresolved wakes, unexpired manifest
references and any ACK/wake outcome first created by the uncommitted operation.
Prove the complete projection fits before publishing archives. A chat retirement archives all its resolved pairs
before removing its metadata. Preserve exact message and request lookup records
durably under the private mailbox archive before removing an active pair. Keep
archives indefinitely: status and sender-scoped request-ID replay/conflict checks
use exact filenames without scans; no receipt is discarded and no native input
is replayed. Interrupted publication leaves the active pair recoverable at the
next capacity request, including after restart. Storage operations and scans are
bounded by existing journal limits; archive size grows with retained receipts.
If no safe slot exists, refuse with MAILBOX_CAPACITY_EXHAUSTED without changing
the journal. Hooks report explicit capacity stderr while preserving sync hints.
Controller collaboration list/status inventory and mod_wake_status expose
content-free chatMailbox counts and capacity flags, usedBytes/byteLimit/remainingBytes
and byteCapacityExhausted; notification continuation
reports mailbox-capacity-exhausted for a missing origin when registration is
blocked. This is diagnostic evidence, never dispatch permission. Malformed or
unsafe reference/archive storage fails closed and is never repaired by deletion.
Idle wake requires an explicitly authorized and verified native-owner adapter;
hook-only delivery must continue to report that it cannot wake idle chats.
Never resolve fuzzy titles, create/archive replacement chats,
edit transcripts/registries/SQLite, or use classifierContext as message delivery.
Messages remain quoted peer text. No new native hook trust bypass is permitted.
chat_list supports native-title query/provider/match filters for already hook-
registered Claude sessions and bounded native Codex metadata discovery. Enrich from bounded stable Codex session_index metadata and
exact Claude Desktop CLI-ID mappings, never transcript guesses or title-based ID
substitution. Preserve duplicate candidates and metadata errors; partial/duplicate
matches require user disambiguation. Presentation isolates invalid metadata only
after exact native identity validation; unsafe storage and ambiguous identities
still fail closed, and action/writer mappings stay strict. Title queries show
healthy matches before explicit error rows in one bounded page; unfiltered
inventory order stays unchanged. Native discovery with a next cursor still
refuses the whole query as NATIVE_CHAT_DISCOVERY_INCOMPLETE; MCP and the Mod
companion request a longer, more specific title without partial candidates,
retry or arbitrary native diagnostic exposure. chat_send expectedTitle rechecks the chosen
native title before enqueueing, without changing exact-session addressing. This
also supports direct exact `title` addressing when a single valid native candidate
exists; duplicates return needs-selection without enqueueing. Known ended chats
can queue messages waiting-for-resume. Only real SessionStart/UserPromptSubmit
reactivates them; late Stop events cannot. Receipt deliveryStatus is computed,
not a new durable state or proof of native receipt. This
alone does not establish managed-task-to-origin-chat mapping; the native
receipt proof above is separate. Codex metadata discovery
does not fabricate hook registrations. The broker inspects the synchronization
root beside its collaboration root for the configured Desktop launcher. When
configured, metadata discovery uses its private codex-shared/app.sock listener;
an unavailable or invalid configured listener never falls back to another backend.
Without a launcher configuration, discovery uses the native control endpoint.
Native owner IPC supports untrusted-input
wake in the original Desktop chat, including deep-link opening of unloaded originals;
busy/native-owner changes never authorize a second writer. Claude wake uses the
structurally validated renderer and narrow Desktop MCP claim/receipt endpoint.
Claude wake has its own discovered frontend asset and recoverable `ui-chat-wake`
installation journal. New resources keep a separate journal under the exact
cache filename; preserve earlier resource originals and receipts. It starts at
module load, independently of folder/sidebar
subscriptions; a sidebar resource existing on disk is not proof of a running
consumer. Keep bounded lifecycle/wait-reason diagnostics without message content.
Every new graph requires separate
live reception acceptance; a cache installation or native account check is
insufficient. This does not revalidate other frontend presentation adapters
against the same vendor update.
Shared mailbox claims fence hooks and native wake with exact claim IDs before dispatch;
only proven pre-dispatch refusal may restore queued state. Unknown dispatch is
never resent. Serialize wake-manifest snapshots and publication so older metadata
reads cannot replace newer queued messages or receipts. Native acceptance is not
hook acknowledgement or work completion.
The renderer manifest keeps its 64-entry/240-KiB serialized bound and exposes
count/total/eligible/omitted/unavailable/bytes plus nextPublicationAt in broker
list/status. Rotate omitted queued messages fairly at five-second metadata
boundaries, preserving per-message claims and all native idle/draft guards.
A single broker timer republishes at the earliest queued expiry or rotation;
startup recovers queued renderer metadata, send/receipt refreshes it, app-stop
and close clear/fence it, and the existing resume marker rearms it. Publication
reads metadata only and never retries native sends. Recheck app-stop/epoch under
the mailbox retention lock before replacing a manifest. Publication failure is
explicit unavailable with a fixed code, not a claim of native delivery.
Its root is separate from sync state. Installation uses a separately journaled
LaunchAgent and native MCP registration, never edits native conversation stores
or restarts active apps. Controller capabilities are private files; worker
capabilities go through environment variables, never argv or returned status.
This fences protocol operations, not hostile same-UID processes.

Native execution uses fresh Codex ephemeral exec or Claude nonpersistent print
sessions with normal account authentication, no copied credentials, no inherited
API keys, and explicit collaboration MCP configuration. Ordinary sync must not
enroll this work. read-only and workspace-write profiles do not inherit arbitrary
user tools, hooks or model settings. By user decision, sandboxed levels remain
network-less; do not add network access or change authorization to hide this limit.
The pure collaboration-permissions module defines native launch profiles and
public network/userConfig/provider-shell capabilities. Tool descriptions and the
permission schema must explicitly describe no network and no user config,
plugins, MCP servers or hooks (Claude also has no Bash or web tools). Tell callers
to inspect claudex_list's defaultPermission/permissionCapabilities before choosing
and to omit permission for inheritance when authorized full-access is needed.
Start/handoff receipts expose effective permission and destination capabilities;
an explicit start below the effective broker default includes PERMISSION_NARROWED,
captured in the idempotency receipt, and other starts omit it. Handoff cannot change
permission. Sandboxed worker prompts require an exact need report instead of
retrying or working around network/tool/config limits. The Mod's read-only default
and sandbox-only start boundary remain unchanged; its previews/receipts always
show SANDBOX_NO_NETWORK, including omitted permission. By user decision, full-access work runs like
the user's own agent: Codex danger-full-access without --ignore-user-config and
Claude --dangerously-skip-permissions without --restricted/--strict-mcp-config,
so user settings, plugins, MCP servers and hooks (such as RTK) load. The user's
claudex-work controller MCP is disabled in those workers (Codex only when it is
registered, since disabling an unknown server breaks config loading; Claude via
--disallowedTools) so children keep their parent link. Every worker carries
CLAUDEX_COLLABORATION_WORKER=1, and the Claudex sync/chat hook exits without
recording anything for it. full-access workers take only PATH from the user's
login shell (cached ten minutes) because launchd's minimal PATH hides tools such
as Homebrew binaries used by hooks; a failed probe logs and keeps the broker PATH.
Sessions stay ephemeral. Models use per-provider broker defaults unless overridden
by the caller; an unset default or explicit null override uses the native CLI
default. Controller-only `models` requests persist both provider defaults in
work.json without restarting services. Start and handoff capture the destination
model at request time; children do not inherit a model ID from another provider,
and follow-ups retain their task selection. Preference changes never mutate
existing or pending work. Prompts instruct workers to read project guidance.
New root work defaults to the closest Git checkout root (bounded .git metadata,
including linked worktrees, with no Git executable requirement); non-Git cwd stays
exact. Explicit projectRoot must contain requested cwd. Per-task readOnlyDirs and
writableDirs are canonical existing directories, bounded to 16 each, with no
reference/write overlap. Children inherit or narrow grants without Git promotion;
handoff preserves them. Legacy records retain exact cwd. Revalidate canonical
roots before dispatch and refuse replaced symlinks. Codex adds only writable extras
and excludes implicit temp write grants when references are declared. Claude uses
restricted file tools plus absolute Edit deny rules for reference roots, covering
Write too; reject unrepresentable path patterns. Preserve native permission checks,
not a new claim of an OS read jail. Directory grants alone do not imply
full-filesystem/home write access; full-access requires its separate authorization.
Reasoning effort follows the same destination-provider capture rules. Persist
defaultEfforts separately from defaultModels; settings may update either full
provider pair atomically. Optional start/handoff effort=null explicitly requests
native defaults; old tasks/pending handoffs without effort must never adopt newly
configured defaults. Validate provider-native effort tokens without translating
levels or broadening permissions. Codex uses model_reasoning_effort, Claude uses
--effort; strip inherited CLAUDE_CODE_EFFORT_LEVEL from isolated Claude workers.
Expose the requested effort only: native organization caps can affect effective
effort, including silent Claude stream-json caps. Do not claim effective-budget
verification merely from argv or task metadata.
Manual CLI tasks default to read-only. The app enables all projects and task-scoped
writes by default, using the explicit broker defaultPermission setting. Permissions
are ordered read-only < workspace-write < full-access. A controller-saved default
(models/permissions request or the app picker) is the explicit authorization for
that level; installation flags remain the floor. Read-only requests and parent
restrictions must never elevate; children cannot exceed their parent. Sandboxed
levels keep bounded Claude file tools without Bash and the Codex native sandbox;
only full-access, chosen explicitly by the user, removes them. full-access refuses
readOnlyDirs it cannot enforce. New installations keep workspace-write. Writable work needs a caller-selected dedicated
checkout; this protocol does not create or merge worktrees. Concurrent work in
the same or overlapping canonical access roots is allowed, including ancestor/
descendant paths, reference readers and writable parent/child tasks. Callers must
assign disjoint file responsibilities and coordinate shared-file edits; there is
no workspace lock or automatic conflict merge. Delegated children may start while
their parent runs. A waiting parent normally resumes with durable child results
once all its children finish; opted-in milestones or blocker progress may also
resume it before child completion. This is explicit new work, not replay of an
uncertain invocation.
Handoff receipts use nextAction=end-turn with CLAUDEX_HANDOFF.
Worker instructions prioritize that single-token response over
normal final-report formatting; put handoff context in the request before it.
Do not treat these text tokens as proof of native completion or release a writer
before successful native completion and process-group exit.
Native quota failures follow the same terminal-receipt and process-exit proofs as
other failures. Preserve bounded readable terminal error text from Codex
`turn.failed.error.message` and Claude error `result.errors` or `result.result`
in the task error and parent child-result. Never serialize arbitrary event objects,
partial answers or stderr as failure detail. Diagnostic events, including Claude
`rate_limit_event`, do not independently prove a failed invocation. Do not add
quota-reset scheduling, provider/model substitution or automatic failed-task replay.
Native chat delivery receipts prove dispatch or acknowledgement only; they do not
observe a recipient's subsequent model quota failure or work completion.
Status presentation keeps legacy result intact but labels phase, terminal,
resultRole/resultFinal/resultGeneration and cancelPending. Completed work reopened
by send is not resultFinal even before its generation advances. Terminal includes
uncertain and never means success. Cancel receipts distinguish accepted/pending;
known-terminal no-op cancellation does not bump task revisions. Cancelled child
notifications use its final revision once, not an intermediate revision.
Optional status/wait view=summary omits histories and caught-up terminal outcomes,
but always returns unseen terminal child outcomes to worker callers. Snapshot and
seenChildren acknowledgement share one serialized mutation; omitted outcomes must
not be acknowledged. Full output remains default. Persist per-invocation inputs
{from,to,kinds} for resumption context without replay or permission changes.
Record normalized native token usage on each finished invocation, including
failures, and per-provider usageTotals. Drop malformed reports; usage never
decides success, failure or uncertainty.
Independent reviews must not concurrently reopen related parent/child tasks unless
normal child-result propagation is intended; no detached mode is implied.

All automated collaboration tests inject synthetic runners or inspect protocol
startup without inference. Do not describe these as live cross-model acceptance.
The native work record is text-only, not a native chat/permission/context clone.
Whole-work handoff retains logical task identity; an external caller ends its
own turn rather than forcibly transferring an unrelated native UI conversation.
Work has no elapsed-time execution timeout; native invocations run until completion,
failure or explicit cancellation. Bounded wait/socket request timeouts do not cancel
work. Disconnecting a socket wait releases only its listener and timer, never the
native invocation. Shutdown drains an already queued pump before taking its worker
snapshot and prevents any new native dispatch. Storage, context, concurrency, depth
and generation limits fail explicitly without
pruning history or idempotency receipts. Cancellation is not rollback.

Rust startup must inspect optional notification deliveries with `get_mut`, never
an inserting `IndexMut` lookup. A task with notifications off keeps that field
absent across restarts. Recover only the prior startup bug's exact
`notification: {"deliveries": null}` placeholder, with no other notification
fields and no creation receipt for that task carrying `originChallenge`,
`originChallengeExpiresAt` or `notificationMode`. Validate the complete corrected
ledger before recovery. Preserve the original ledger bytes in the private,
exclusive `work-notification-placeholders-v1.json` backup before the normal atomic
work-ledger publication; an existing backup must match those bytes exactly to
resume an interrupted recovery. All other malformed notification evidence still
refuses startup. Recovery never changes request receipts, task revisions or
generations, and never creates or retries a notification or native invocation.

Work-ledger capacity covers active tasks (1,000), active request receipts
(10,000) and compact serialized state (32 MiB). List and status expose used,
limit and remaining for each; status also exposes the used/remaining transition
budget. On projected count or byte pressure, durably archive exact request
receipts and unchanged, completely settled root trees before their active removal.
Never retire running, ready, waiting, paused or uncertain work, a live worker,
a pending handoff/checkpoint, unexpired origin binding/publication, a recent
quota intent, or an unresolved mailbox/wake receipt. Preserve full messages,
execution evidence, reports, instructions and events in immutable private tree
snapshots. Exact task locators and actor-scoped request keys avoid lifetime scans.
Active work.json remains authoritative after interrupted archive publication;
redundant evidence is retained. Unsafe/malformed archives fail closed.
The bounded list explicitly reports inventoryScope=active and archivedTaskCount;
exact status, single/multi-wait and work evidence reads also find archived tasks.
A valid new operation on archived completed work restores its whole tree through
the normal commit/capacity path, preserving original follow-up/handoff semantics.
Do not execute a replayed request, alter its fingerprint/result, reset a generation
or discard an uncertain outcome. If protected work leaves no safe space, return
CLAUDEX_WORK_CAPACITY_EXHAUSTED atomically. Archives have no expiry; their disk
usage grows with retained history, outside active-ledger bounds.

Controller-only `request resolve` may close an inspected uncertain
invocation as failed, never successful or replayable. Require exact revision and
current execution generation, absent recorded PID and process group, no in-memory
worker or unresolved descendants. Preserve original error and execution evidence
with the resolution receipt. Writable uncertainty requires controller attestation
`workspaceReconciled: true` plus nonempty `reconciliationNotes`, saved with exact
directory grants in the receipt. This attests to prior workspace inspection, not
automatic validation or rollback. full-access uncertainty requires the same
workspace attestation. The app's Resolve action records the user's in-app
confirmation as that attestation, still refusing live processes.
Codex collaboration supports explicitly selected non-Git directories using
`--skip-git-repo-check`; native sandbox and approval restrictions remain unchanged.
Only an exact no-stdout, no-session pre-execution Git refusal with a closed process
group is a known startup failure; unknown exits retain uncertainty safeguards.


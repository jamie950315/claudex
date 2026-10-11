# Cross-model collaboration broker

Contributor rules moved out of AGENTS.md; they are binding. Scope: The work graph, MCP facade, chat mailbox and native wake, worker execution and permissions, observability, diagnostics, notifications, uncertainty resolution and acceptance evidence.

Work observability is broker-owned and independently opt-in per task:
`observability.timeline=public`, `reports=milestones`, and `blockerNotifications`.
Defaults collect no native public content and authorize no intermediate wake.
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
query-bound live pagination and filters. Multi-wait supports 1–16 targets with
one event listener, atomically acknowledging only returned child outcomes after
checking the MCP-escaped response bound. Preserve compatible single-task behavior.
Task waits default to five minutes and accept an explicit maximum of thirty minutes;
only validated waits extend the private RPC deadline. Native MCP host deadlines
remain independent. External controllers may request status checkNotification:true
before ending a wake-enabled root turn. Its continuation nextAction is a read-only
snapshot, never a dispatch lease or delivery guarantee: require verified origin,
available notification quota, exact current native routing and lifecycle checks.
Do not navigate, dispatch, change revisions or infer permission in this check.
Queue-only, unbound, stopped, ended and unobservable routes continue waiting.
Notifications still default off; main reads authoritative status after reception.
MCP errors retain typed code and readable text through structuredContent.error.
Worker-only report is generation-fenced and explicitly self-reported, never
verified goal completion or a replacement for completed/resultFinal. Handoff
reports preserve author provenance and normal completion/process-exit guards.
Controller requestId namespaces remain provider-scoped; do not migrate old
receipts or mistake that scope for native-origin proof.

Mod observations are content-free, self-reported diagnostics in broker memory:
at most 64 observers, 60-second server TTL, lifecycle/disconnect invalidation and
existing wait refresh. Never reuse observations as dispatch or claim permission.
Every new RPC must be in the private transport allowlist and tested over Unix
RPC. Root notifications default off; explicit queue/wake captures per-task intent,
but no message is created before independent native call/result origin proof.
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
from unchanged notification recipient/wake capability checks. Native flush gaps
retain one identity-only hint, rechecked on matching
SessionStart/UserPromptSubmit/Stop only (four tasks/event, three attempts/task).
The new PostToolUse trust diagnostic is separate from legacy sync readiness.
Claude PostToolUse uses a single-text MCP content array; Codex uses the full
MCP envelope. Native Claude project directories may be 0755: require canonical
ownership and no group/world writes, retaining private stable single-link files.
Do not demand broker-only directory modes or chmod originals to validate origin.
Keep write-ahead notification intents, absolute expiry through awaited preflights,
and the final native dispatch fence. Interrupted/unknown dispatch never retries.
Coalesce undispatched terminal revisions and cap retained sends at 16/task and
16/origin/minute. App-stop release is event-driven, not a polling loop. Status/wait
remains the result authority. Fresh authorized native acceptance verifies both
origin providers, queue-only Codex receipt and automatic Claude mod-self receipt
with real Stop ACK. Additional installed acceptance on Codex 0.159.0-alpha.12.1
verified a persistent exec-origin main idle before its read-only Claude worker
completed, one automatic native-owner completion wake, exact status/result read
and real Stop ACK. The earlier unbound and uncertain exec canaries remain intact;
source/catalog fixes never bind or replay them manually. This is separate from
the earlier Claude Mod route and does not certify every runtime or host timeout.
Preserve the earlier unbound and expired records without
replay. This is bounded evidence for the reviewed installation, not a new
synchronization-runtime allowlist or blanket acceptance of other versions/routes.

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
alone does not establish managed-task-to-origin-chat mapping; the opt-in native
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
Authorized native acceptance on an earlier pinned resource verified an idle
original Claude chat waking through its existing Desktop owner, rendering the
requested reply and acknowledging once under the same UI/CLI identities. No
manual prompt or acknowledgement was submitted. Every new graph requires separate
live reception acceptance; a cache installation or native account check is
insufficient. This does not revalidate other frontend presentation adapters
against the same vendor update.
Shared mailbox claims fence hooks and native wake with exact claim IDs before dispatch;
only proven pre-dispatch refusal may restore queued state. Unknown dispatch is
never resent. Serialize wake-manifest snapshots and publication so older metadata
reads cannot replace newer queued messages or receipts. Native acceptance is not
hook acknowledgement or work completion.
Its root is separate from sync state. Installation uses a separately journaled
LaunchAgent and native MCP registration, never edits native conversation stores
or restarts active apps. Controller capabilities are private files; worker
capabilities go through environment variables, never argv or returned status.
This fences protocol operations, not hostile same-UID processes.

Native execution uses fresh Codex ephemeral exec or Claude nonpersistent print
sessions with normal account authentication, no copied credentials, no inherited
API keys, and explicit collaboration MCP configuration. Ordinary sync must not
enroll this work. read-only and workspace-write profiles do not inherit arbitrary
user tools, hooks or model settings. By user decision, full-access work runs like
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

Separately authorized live CLI acceptance verifies Codex-to-Claude and
Claude-to-Codex child delegation with exact result return, plus two consecutive
owner transfers under one logical task ID. The tested runtimes are Codex CLI
0.158.0-alpha.2.1 and Claude Code 2.1.283. Seven model executions completed in an
isolated read-only workspace; test files stayed unchanged and owned process
groups exited. A separate authorized writable run on the same versions verifies
both directions of child file editing and parent yield/resumption, plus sequential
Codex-to-Claude-to-Codex edits under one task ID. Nine native executions completed;
exact final bytes and recorded serial ownership boundaries were checked. Only a
temporary broker enabled writes and it was stopped afterward. The installed
service retained its then-current read-only default. This is historical bounded
collaboration file-editing evidence, not a new synchronization version allowlist entry, generic build/test
execution in Claude, or proof of Desktop UI chat transfer.

Claudex 1.1.1 cooperative-follow-up acceptance also verifies both real
supervisor/child directions: a proactive follow-up sent after work started was
received, acknowledged and completed by the child in generation one, without a
prior blocker or question. See docs/collaboration.md for exact native versions
and verification scope. This is cooperative check-in/MCP-return delivery, not
instantaneous interruption, external idle wake or synchronization certification.

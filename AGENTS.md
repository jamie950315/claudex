# Claudex

Local turn-boundary conversation bridge between Codex desktop/CLI and Claude Code CLI.
Use English for repository content. Keep private transcripts, state, logs, credentials,
and generated sessions outside the repository.

## Documentation

Keep README.md focused on current capabilities, requirements, setup and concrete
limits. Put graphical setup in docs/app.md, the work protocol in docs/collaboration.md, native synchronization
details in docs/synchronization.md, and existing CLI-only installations and
migration boundaries in docs/compatibility.md. Do not use broad maturity labels
as substitutes for version requirements or explicit unsupported behavior.
Keep collaboration acceptance separate from the synchronization allowlist, and
distinguish synthetic checks from authorized native model or Desktop evidence.
This checkout's history is published directly to origin main with a normal
push. Keep secrets, credentials and private transcripts out of commits; test
fixtures use placeholder paths and IDs.

## Development

- Node.js 22.15+ (22.x) or 23.8+, ES modules; install with `npm ci`.
- Run `npm test` for the coordinator and adapter contracts.
- Native integration checks use isolated temporary homes and synthetic transcripts.
- Automated tests never start model inference. Real Desktop reply acceptance requires explicit user authorization; never overwrite live sessions or modify user databases as a test.
- Product repairs must apply through normal installation and runtime paths on
  other users' machines. Do not depend on one account, UID, project path, native
  conversation ID or manually repaired local state. Reproduce relevant failures
  in fresh isolated roots and cover environment-dependent paths, permissions and
  restart recovery. Establish fixture permissions explicitly when they matter,
  so the test process's umask cannot hide the failing native state. Keep local
  recovery evidence separate from clean-profile and other-machine acceptance.
- The synchronization coordinator has one owner per conversation and commits only complete turns.
- Unmanaged Claude originals may end in native transcript-only task notifications.
  Accept these as ancillary tails only with system provenance, exact queue evidence
  and a parent chain from the completed assistant. Preserve their original bytes
  and the canonical checkpoint; ordinary input and ambiguous tails still wait.
- Fail explicitly on conflicts, partial history, or unsupported lifecycle states.
- Read transcript snapshots through a no-follow file descriptor and compare its
  nanosecond file identity with the named file before and after reading. Size and
  modification time alone do not prove stability after a replacement or rewrite.
- Before truncating a reusable staging file, verify its opened inode is an owned
  regular file with exactly one link and still matches the named file. No-follow
  alone does not protect originals against hardlink staging aliases. Controlled
  fixture appends compare exact serialized nanosecond identities, never converted
  floating-point millisecond timestamps.
- Preserve original contents and never prune originals as generated backups. Authorized same-title handoffs may archive an unchanged superseded original only after verifying its replacement and the applicable native lifecycle guards; archival never grants an external transcript writer lease.

## macOS app setup

The main window uses one outer scroll view, with a width-constrained natural-height
document. Never restore fixed-height nested checklist/diagnostic panes. Healthy
operation shows only Codex/Claude prerequisite summaries; actual missing/login/
blocked components automatically expose setup actions. The full checklist and
technical details stay in an explicitly expanded advanced section. A prerequisite
summary is not proof that messages have synced. Resize smoke checks must verify
viewport growth, natural content width, a single scroll view, and compact ready mode.
Fit window height to natural document height (including its padding) when opening,
changing content or toggling advanced diagnostics. Preserve width and the top edge
where possible; cap height to the current screen's visible frame and retain the
outer scroll view for overflow. Do not resize fullscreen or during live dragging.
Runtime history/ownership blocks offer diagnostics, not setup retries. Show the
global setup retry only for actionable installation/account requirements or a
failed setup operation; keep the instructions consistent with available actions.
Initial verification reports unique checked/total conversations and the known
current conversation with elapsed seconds. A ten-second status-only heartbeat
keeps long native operations observable; it must never publish archival intents,
inspect histories concurrently, advance checkpoints, or imply synchronization
completion. Stop and drain the heartbeat before leaving the operation.
Keep initialSweepCompletedAt separate from foregroundCompletedAt: completing the
foreground queue must not hide initial verification of the cold backlog.

Distinguish setup `waiting` from `needs-action`: only missing components or sign-in
requirements request user action, while normal runtime waits need no setup retry.
Predecessor archival without a verified idle replacement owner (including an
evicted owner) is a typed `owner_not_idle` wait after archive intents are revoked,
not a history conflict or an actionable setup failure. Keep idle verification
mandatory and do not start owners just to archive; real identity errors still block.
Keep bounded per-pass waitingContexts with exact known conversation identity,
title and reason. The main window shows reasons and next steps without opening
details, and orders non-ready setup rows first. Never infer a missing identity,
hide a real conflict, or change synchronization semantics for a friendlier status.

Claudex.app localizes presentation using complete English-keyed JSON catalogs
under native/ClaudexApp/Locales for en, zh-Hant, zh-Hans, ja, ko, es, de, fr and it.
Keep key and %@ placeholder parity; the builder rejects incomplete catalogs.
System-language selection distinguishes Chinese scripts and regions. Runtime
switches rebuild presentation only, never run setup or restart services. Raw
unknown native diagnostics remain verbatim with a translated diagnostic label.
Read-only/synthetic modes must not persist language or onboarding preferences.

The graphical app owns the sole menu bar item, a combined setup/health window, and
notifications. It reuses the bounded native status model and an icon-only,
square-width menu bar button with the bidirectional-arrow
template symbol; never restore a visible app name or status suffix. Keep health
details in the tooltip, accessibility label, menu and window. Its owned login item
launches the same bundle in background inspection mode, not setup. Migrate only
the verified legacy status-display login item and native display process; preserve
its recoverable artifacts and never restart service or native conversation owners.
CLI-only installations may retain the standalone status display.
The approved app artwork is native/ClaudexApp/Assets/AppIcon.png. The app builder
derives standard 1x/2x icon sizes and packages Claudex.icns with CFBundleIconFile;
keep this raster app icon separate from the monochrome menu bar symbol.
The combined window contains setup retries and account actions; menus expose Open Claudex,
not a separate retry action. First launch automatically presents the main window and
starts setup, including a fresh background launch. Subsequent login starts stay
quiet; prior setup reports preserve existing-install behavior. Read-only and
synthetic UI modes must not mark onboarding as presented or run setup.
Live health appears above setup, with timestamps, recovery, notifications and
diagnostics under advanced diagnostics. Notification clicks open the same window;
the status controller must never create a separate window.
Graphical Quit (menu, Command-Q and native termination) now stops the owned sync
and collaboration services and exits only after read-only native ownership/process
checks confirm shutdown. Keep the UI responsive while draining; never kill user
native work or report a merely unloaded launchd job as fully stopped.
applicationShouldTerminate returns terminateLater and replies once the stop is
verified (false on failure); never terminateCancel a first request, which aborts
a logout or restart. The runtime closes idle Claude owners concurrently; a busy
owner still refuses after the idle ones are closed. Failures
remain visible in the app. Closing the window still only hides it. Persist the
private app-stop.json hold before stopping; hooks must not record events while
held. Reopening resumes only exact installed owned services, using a recoverable
resuming marker for partial starts, and clears the hold after successful starts.
Do not delete native data, credentials, or login definitions. Inspect/smoke and
duplicate-instance exits must never stop services. CLI-only status display Quit
retains its display-only behavior.

`native/ClaudexApp` and `bin/claudex-app.mjs` provide automatic setup for users
who already have signed ChatGPT/Codex and Claude desktop apps. Never download or
replace those apps. Reuse native CLIs or fill missing CLI components from pinned
official npm packages in the private root. Keep normal native credential
namespaces, never copy credentials, and do not auto-start model work during setup.
Private state and status reads use non-blocking, no-follow file descriptors and
reject non-regular files before reading. Read-only AppSetup inspection refuses
setup, account, service and model-setting mutations before any native operation.
Service control verifies the loaded launchd job's definition path, program and
exact arguments against the owned installation before reporting readiness or
starting, stopping or removing it; a matching on-disk plist alone is insufficient.
Completion-event history holds have no scheduled retry countdown. Only actual
supervisor backoff supplies the next recovery time in that scheduler.
The app profile enables all projects and task-scoped writes; explicit read-only
requests and child permission bounds remain strict. Do not loosen existing
writer, version, resource, account or macOS guards to report a ready checklist.
An active or incompatible existing deployment must be preserved and explained.
By user decision, Claude.app is accepted with the official Anthropic team or
as a locally patched build: official bundle identifier, ad-hoc signature, no
team, and a passing strict deep verification; it is labeled as a local build.
Codex keeps its vendor-only check. Any other publisher blocks only its own
desktop-integration row; never skip to another copy or show unrelated
prerequisites as missing.
Package portable Node/npm and production dependencies so end users need no Git,
Node installation, compiler or terminal setup. Build with an explicit file
allowlist, probe the supplied Node binary's Zstandard/CRC32 APIs before staging,
and verify nested signatures. Reject incompatible runtime distributions before
producing an app. Development signing is not notarized
public distribution. `--inspect-only` is read-only UI validation; `--ui-smoke`
checks native layout with synthetic data, not installed service acceptance.
The 20-second setup inspection runs only while the window is visible or a
setup/login flow is active. Clear that activity after failures or when no provider
installation/sign-in follow-up remains. Stop the inspection timer when neither
condition applies and recreate it when needed. By user decision, report inspection
may reuse a successful deep desktop-app signature verification recorded in the private
app-signatures.json for at most one hour, keyed by the expected publisher and
nanosecond identities of the bundle, Contents, Info.plist, MacOS and the code
seal. Setup and sign-in always verify again; failures and bundles that changed
during verification are never recorded; `--read-only` (used by --inspect-only)
never writes it. The cache is a scheduling optimization, not publisher proof.

## Adapters

Desktop synchronization is completion-event driven, not a recurring two-second
history sweep. Native Stop/lifecycle hooks publish bounded identity-only hints to
the private durable sync-events inbox and wake the owner through a private Unix
socket. Native SDK/app-server events join the same queue. Configuration events
recheck hook readiness and liveness. After a successful empty-scope publication
revokes archival commands, configuration-only passes with an unchanged ledger
reuse presentation without renewing manifest timestamps or proof lifetimes.
Pending recovery, changed state, native events and deferred/failed publications
still use normal publication. Known managed session registration and started events
never start a sync. Resuming an original reconciles that conversation for offline
completions. Hook definitions are merged with existing settings and require the
native Codex trust review; never bypass or forge trust receipts. CLI hooks install
and hooks status configure/inspect them; graphical setup installs them too.
Perform one startup/reconnection reconciliation, then sleep until an event.
Map exact native IDs, including preserved originals, to affected logical work.
Discovery may return only side/path. In event-filtered discovery, obtain a Claude
ID from its validated UUID filename and a Codex ID from its native header, then
pass that explicit nativeId into track so the adapter verifies the actual identity.
Recover an existing pending transaction first, preserve all write/history guards,
and acknowledge only the consumed inbox revision. Newer events survive a sync.
Completion-before-flush gets at most three event-scoped follow-ups at 250/1000/3000
ms and a completion-armed exact-file notification; started disarms streaming files.
Never infer completion from a hook alone or resend uncertain native input.
Socket notifications are primary: macOS fs.watch registration can lose events.
Use one OS watcher per parent directory with subscriber fanout; filesystem signals
are hints, never checkpoint or mutation evidence. Release retired subscribers and
recheck lifecycle after awaited path inspections. Anonymous directory signals use
exact-file metadata to suppress unchanged transcript hints; root/config/backend
signals must still check their exact target rather than discard unknown filenames.
A 30-second idle status heartbeat does no native history reads, discovery or
archival proof renewal. Scope Desktop
handoff history checks to event targets; empty scope revokes commands while keeping
validated presentation anchors. Test-only dependency injection retains the former
bounded polling harness, not a production fallback.

- Codex publishes only new independent rollouts and registers them with `thread/resume(path)`; no direct SQLite mutations or external-agent imports.
- Claude uses native resumable session projections with pinned `txcript` codecs.
- Filesystem events are hints; durable checkpoints and source identities determine work.
- Imported history must not loop back as newly authored history.

## Cross-model collaboration

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
its exit; retire it from the persisted inventory so the 256-record bound covers
unresolved descendants, not every short-lived test/tool process of a long
invocation. The leader is never retired, retained identities never change, and
a reused leader PID or too many concurrently unresolved descendants still fail.
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
matches require user disambiguation. chat_send expectedTitle rechecks the chosen
native title before enqueueing, without changing exact-session addressing. This
also supports direct exact `title` addressing when a single valid native candidate
exists; duplicates return needs-selection without enqueueing. Known ended chats
can queue messages waiting-for-resume. Only real SessionStart/UserPromptSubmit
reactivates them; late Stop events cannot. Receipt deliveryStatus is computed,
not a new durable state or proof of native receipt. This
does not introduce managed-task-to-origin-chat mapping. Codex metadata discovery
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
not a new claim of an OS read jail. No full-filesystem/home write grant is implied.
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
their parent runs. A waiting parent resumes with durable child results once all its
children finish; this is explicit new work, not replay of an uncertain invocation.
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
service remains read-only by default. This is bounded collaboration file-editing
evidence, not a new synchronization version allowlist entry, generic build/test
execution in Claude, or proof of Desktop UI chat transfer.

## Current boundary

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
the new directory Codex thread/read reports (an existing independent saved
directory is another project and stays held; check the filesystem first so
unmoved conversations never contact the backend), the complete history must keep
the saved prefix and two reads must agree. The managed Claude owner must be
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
owner, requiring its state lock to be absent.

A native transcript file changing between successful handoff inspections is a
revoked, deferred Desktop archival attempt, not a synchronization failure. Return
history_changed only after clearing all archive actions and cached proofs; perform
full verification on the next poll. Canonical history conflicts, registration
changes and manifest revocation failures remain errors. Surface this narrow race
as waiting for Desktop handoff, without an attention notification.

Do not emit warnings merely because Codex/Claude versions are outside the
validated baseline. The existing `warn` policy name is retained for config
compatibility, but version-only status warnings and events are silent.
New graphical installations default to this permissive policy; an explicitly
configured strict policy is preserved.
Actual protocol, schema, history, ownership and native operation failures still surface
and keep their safety guards. Do not relabel unknown runtimes as verified.

Owned Claude image-source annotations may use the exact parent timestamp or
the observed one-millisecond-later timestamp. The latter requires an immediately
adjacent physical parent, queueTranscriptOnly, identical native version, and all
existing signed packet, prompt, session, cwd, image ID/path and graph checks.
Apply this predicate consistently to completed tails and later delta decoding;
never drop arbitrary image-like text or infer a general timestamp tolerance.

Before capturing an authenticated owned image append, a native cache project
created with the observed 0755 mode is tightened to 0700 through a stable
no-follow owned directory descriptor. Its cache root must already be private;
reject symlinks, foreign owners and other modes. Keep exact asset byte and
append provenance checks, and preserve pending evidence on any failure.

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
bounded diagnostic list. Keep unsupported-source diagnostics across configuration
and unrelated native events; only exact targeted reinspection or full discovery
may replace their snapshot. Claude Desktop forks copy parent rows under the parent's
session ID into a new file. Enroll one under its file identity only after the
copied lines match the parent's native bytes (identity-free metadata may
follow) and it has its own completed reply; otherwise it is an unsupported
source, never an adopted parent identity or a worker crash. Allocation-time collection tags another
conversation's history failure with that conversation's identity for status. In Desktop mode, recognized tracked-history guards
pause synchronization without exiting the watcher or closing live Claude owners.
A pending transaction blocks all discovery, new syncs and collection until normal
verified recovery succeeds; it is never cleared or resent to regain availability.
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
Without pending work, affected syncs are held individually, but global original
and quota guards still apply to other deliveries (except frozen conversations). In event mode a new relevant
event revalidates a hold; no recurring scan attempts to clear it. Unclassified unsafe failures remain
fatal to that worker rather than being treated as successful. Discovery starts
at initialization, not a bulk history import.
An unenrolled source with no completed first turn does not make the entire
watcher wait. Transport failures and tracked waits remain visible. The status
app also surfaces the existing unsupported-new-source diagnostics.

The installed macOS service has an independent supervisor. Unexpected worker
exits restart after 5/10/20/40/60 seconds; two stable minutes reset backoff.
Read-only ownership preflight must find prior writers and recorded children dead.
Live/malformed/reclaiming locks or unrecorded children block duplicate writers.
Never clear pending work, kill native user work or resend uncertain inputs to
recover. Launchd recovers supervisor crashes; detached workers and
AbandonProcessGroup retain surviving work until it exits safely. Normal exit
respects intentional stop, while login startup remains installed. CLI shutdown
rechecks only the explicit busy-owner refusal until native closure is safe.
service-status.json and watcher-status.json are disposable diagnostics written
by writeDiagnosticJSON (atomic rename, no device flush). Never use it for
journals, checkpoints, ownership, inbox or any state that authorizes work.

For CLI-only installations, `status-app install|status` manages a separately signed macOS menu-bar app in
the private root, with independent login startup. It only reads bounded private
status files, distinguishes readiness from liveness/stale data, and reports
waiting, paused, recovering or offline states. Its status window exposes
diagnostics and notification permission/test feedback. Persistent issues are
debounced 15 seconds and deduplicated with a 60-second minimum notice interval;
recovery generates a notice too. Notifications contain no transcript or paths.
Graphical installations use the unified Claudex app instead; standalone display
installation is blocked after graphical login migration. Quit stops only the display. Signed, journaled upgrades require the old UI to
exit and preserve one previous artifact. No built bundles belong in Git.

Historical backfill is an explicit module API in `src/cold-import.mjs`, not a public
CLI command or a changed discovery cutoff. Its private journal reserves one target
per source before publication. `trackImportedPair()` verifies equal canonical
digest/count/cwd and enrolls two unmanaged originals with `discoveryMode: cold-import`.
The Claude original uses `importPacket: true`, packetVersion 2; runtime reads must
authenticate its archive without creating an SDK owner. Never overwrite its
bootstrap, replace a Desktop-owned file, or collect either original as a backup.
Native UI acceptance of the official `claude://resume` handoff adopts the published
CLI transcript. `paired` is not Desktop visibility; `adopted` requires read-only
registry evidence, and visible project/title/history require UI verification.
Do not inject registry/database/IPC state. One real Local adoption is verified
without inference, not the completeness of a bulk migration. Missing cwd/assets,
empty or unsupported histories remain explicit exclusions; incomplete tails are
withheld. Do not label a partial import as all-history success.
Claude Local continuations use normal Codex snapshot/original-dependency guards;
the return from Codex creates a separate managed Remote Control entry with the
same title. The opt-in native Local handoff archives the verified superseded
Local entry while preserving its contents; it never reuses the Local writer. Cold imports
avoid idle SDK workers only until that transition; active owners remain long-lived.
Cold-import hints require stable, complete no-change verification. Pure pairs of
two verified current unmanaged originals may persist a signed verification proof
under cold-verification. Bind exact ledger/native file observations, inactive
Codex identity/path/cwd/update metadata, decoder code/runtime/configuration, and
all authenticated archive files and their directory with nanosecond identities.
Reuse survives restart without a timer-driven full export; changes, uncertainty,
missing files or invalid proof require full verification. This is a no-op scheduling
optimization, never mutation, archival, collection or checkpoint authorization.
Exclude managed records, dependency anchors, relocation and retained-image chains.
An inactive original's byte-identical unfinished tail may remain withheld while
reusing its verified canonical-prefix no-op proof. This never completes the tail;
new bytes or native activity require full verification again.
Proof storage is bounded to 4096 entries, 16 MiB per entry and 64 MiB total, plus
one bounded temporary file. Save only after full no-change verification and stable
post-read observations. No native history or credential is copied into the proof.
Other eligible cold pairs retain ephemeral hints covering all lifecycle/checkpoint
fields and native file identities, including superseded originals, with a fixed
60-second full-verification deadline. Pending work suspends proof use until verified
recovery; errors revoke the affected proof. New and active
conversations and dirty cold imports run before the fair cold-validation sweep.
Proof misses run full verification directly; only failed reads require durable
revocation. A successful refresh replaces its proof once, without a preceding
tombstone flush. Restoring an old context never revives a failed proof.
During startup/reconnection reconciliation, between complete cold operations,
refresh discovery and changed work after two
seconds, not the entire unchanged foreground queue. Every managed owner retains
its full lifecycle check once per pass; changed owners are prioritized. Running
Claude owners use live lifecycle state. Stopped current owners use matched saved
state under the native writer lock and stable transcript reads, without starting a
process. Pending appends/resets require explicit recovery. Preserve archive,
image restoration and retained-generation checks. Idle assertions and maintenance
discovery must not start an owner; actual reset plans still require a fresh cold
native owner. Reconcile legacy display titles only when an owner runs for work.
Discovery and new deliveries also refresh between individual foreground syncs,
using their own clock; a long active-owner sweep must not block new enrollment.
Stable file/lifecycle observations also prioritize changed existing conversations
between native operations. This includes superseded originals and both current
sides, not just new enrollment or cold imports. These observations only reorder
full syncs; unchanged managed owners still receive normal lifecycle verification.
Serve at most one queued existing change per boundary and keep the regular sweep
advancing, so repeated busy activity cannot starve other conversations.
Keep the original sweep moving after each nonrecursive discovery refresh; never
restart it recursively or parallelize writers. Post-enrollment errors retain
tracked-history severity, not unsupported-discovery warning classification.
Raw observations select priority only; unsuccessful dirty work stays foreground
until stable full verification. One in-flight native operation can exceed this
interval, so it is not an end-to-end latency guarantee. Never advance semantic
checkpoints from hints or skip a current managed Claude owner's lifecycle checks.
Within the coordinator lock, the two current Codex/Claude history inspections
may overlap. Superseded-original inspections use batches of at most four;
dependency-anchor checks retain their ordering. Drain every started read before
reporting the first input-ordered error, starting another batch, planning writes
or releasing the lock. Relocation, recovery, maintenance, native writes and
checkpoint commits remain serial. Concurrent Codex readers share one pending
transport initialization and receive a client only after it fully initializes;
initialization failures reach all waiters without replaying native work.
Full fingerprints stream the existing canonical JSON digest by message. Raw
archive reads retain canonical byte, reference, portable-shape, asset and semantic
digest validation without regenerating the chunk/page tree; custom message
resolvers still require independent deterministic archive binding. Never change
persisted digest bytes or treat this optimization as a cross-snapshot content cache.
Bounded watcher timing fields report discovery gaps and last/slowest syncs,
without transcript content; they are operation timings, not UI latency promises.
Ordinary progress diagnostics coalesce at two-second intervals. Initial status,
changed health/conflict reasons, completion boundaries and final shutdown remain
visible promptly; the ten-second in-flight heartbeat remains. Durable transaction
ledgers and expiring Desktop handoff proofs never use this diagnostic throttle.
Normal discovery scope is unchanged.
Collection validates both current sides only for conversations owning managed
snapshots, avoiding full exports of unrelated cold pairs with no backups. Keep
the superseded-original guards global (frozen conversations are deferred), retain every managed snapshot in the
global quota, and preserve exact previous-snapshot/native retirement checks.
Within one collection, previous Codex snapshots share one fresh initial global
metadata dependency inventory; each parent still has its own ancestor queries.
Actual dependency anchors retain independent fresh inventory, canonical and raw
proof revalidation. Never reuse this inventory for a later collection or as
mutation authorization; native hide/remove guards still recheck independently.
Native sorting of a Claudex projection's first JSON header may be recognized only
by reconstructing its original serialization and matching the saved whole-file
SHA256, with every subsequent byte unchanged. Preserve actual raw proofs and
native files; never rebaseline an anchor from canonical message equality alone.
Missing native paths invalidate persistent cold-cache reuse and proceed to full
inspection for per-conversation diagnostics, rather than crashing the watcher.
Reuse the verified read returned by assertUnchanged for that snapshot's byte
count instead of immediately exporting the same history a second time.

Validated native baselines are Codex `0.155.0-alpha.16.3`/`.16.4` and Claude Code
`2.1.210`/`2.1.281`. versionPolicy defaults to strict; an explicit warn policy
allows unvalidated runtime versions to be attempted without version-only pauses.
Never label an unvalidated version as verified. Codex has cross-process writer locks.
Check both spawned descendants and ordinary forks before retirement: this Codex
version omits fork ancestry from `thread/list`, so use metadata-only `thread/read`.
Include `thread/loaded/list`: a fresh fork can be loaded before the stored list
exposes it. Normal original archival and owned-snapshot retirement share these guards.
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

The native watcher, six synthetic roundtrips, real Claude rendering, and desktop
task-reading integration are verified without inference. Separately authorized
real Desktop acceptance verifies two model-authored roundtrips, history-based
nonce recall on both sides, and automatic delivery. Do not
claim production readiness for opaque/dependent compaction, external asset dependencies, changed
working directories, or unsigned reasoning replay. Visible reasoning is labeled
text; encrypted reasoning and native permissions do not migrate.

Readable native compaction summaries plus complete continuation are supported.
Owned Claude history retains its complete authenticated prefix through a fresh,
explicitly linked native compaction. The observed single preserved SDK no-query
packet is accepted only with exact native identities, summary anchors and an
authenticated packet already present once in that prefix; it is not replayed.
Semantic baseline resets require a new boundary after an unchanged saved byte
prefix; checkpoints advance only on successful promotion. Opaque Codex summaries,
replacement histories, and general Claude preserved-segment chains remain blocked.
Native Claude originals (Desktop Local, CLI 2.1.284 /compact) keep their complete
readable prefix, so a preserved segment there is accepted when its uuids exist
exactly once before the boundary as a contiguous parent chain ending at the
logical parent, anchored to the summary and ordered within allUuids (which may
list unpersisted rows). Their interactive summary may omit queueTranscriptOnly;
owned histories still require it. Nothing is replayed.
The Local archival publisher skips an original left in its old project by a
Codex project move (no same-project continuation); other cwd mismatches fail.
Watcher status lists each blocked conversation once, even when several held
callers report the same global guard.

The observed Claude split-response parallel-tool graph is supported without
choosing a branch: require one request/response/model/session identity, ordered
apiBlockIndex records, unique tool IDs and exactly one native result per call,
matching sourceToolAssistantUUID, prompt, cwd and version. Only result and
PreToolUse hook rows may carry another absolute cwd, because a tool in the wave
(for example Bash `cd`) can move the native cwd before they are persisted. Validate one final
join and reject intervening authored input or alternate continuations. Only
virtual graph-validation parents change; native bytes, codec input, message
order and every tool record remain untouched. Missing/ambiguous evidence and
actual competing branches still block; saved semantic prefixes must still match.
The observed empty-display successful PreToolUse hook attachment may occur
between results when its tool, native parent, session and pending-result position
all match. Its historical command/stdout remain inert and are never executed.
One response may stream later blocks after earlier tool results. CLI 2.1.284
persists a later block of the same response after a partial result while another
call still runs (the model cannot have seen that result). Require contiguous
response block indices, identical response identity, exact call/result pairing,
every result before the final join, and each block parenting the preceding
physical member. Only virtual result parents change; physical order is kept and
misparented continuations and competing joins remain blocked.

Claude Desktop uses a separate registry. Native handoff adopts the CLI transcript.
Desktop-owned transcripts must not be replaced or pruned, even when archived.
Automatic per-generation Local registration is not enabled. The opt-in renderer
consumer may invoke the observed native archive API after a verified same-title
Remote Control replacement; it never writes registry/database files or takes
over a Local transcript. CLI discovery alone does not prove Desktop visibility.

Claude Desktop Code > New > Local outbound discovery is now actually verified:
the pinned Desktop writes its native transcript under ~/.claude/projects,
which the existing watcher discovers automatically. No second discovery store
is needed. A real Codex continuation recalled the original Claude response.
The UI local_<UUID> may differ from registry.cliSessionId; ownership checks must
use the bounded stable registry mapping, including archived entries, and retain
conservative filename protection. Never assume the UI suffix is the native ID.
Returning from Codex creates a separate managed Remote Control entry with the
same logical title, without a `[Claudex]` prefix. The opt-in native Local handoff
archives the verified Local predecessor so the ordinary same-title entry is the
continuation; it does not append into or reuse the original Local native ID.
New managed owners persist the logical display title before registration.
Existing owned titles with the exact legacy `[Claudex]` prefix are migrated by
the live owner's `query.renameSession(title, nativeId)`, with a durable rename
journal, native persistence proof and recovery. Unrelated manual names survive.
Remote Control reattachment omits the name so native/cloud UI renames survive
reconnection. Do not use the SDK's standalone JSONL-appending rename helper
against a live owner. Existing entries may be renamed or pinned through native UI
when requested; pinning is not automatic and does not merge a Local entry.
The required sidebar behavior is placement under the same existing local
project/folder group as the source. Pinning, title prefixes, and a new same-name
custom group are not substitutes. `desktop folders enable|disable|status` manages
an opt-in, structurally validated presentation adapter for the cached Claude frontend.
It patches only the uniquely proved sidebar HTTP cache resource, preserving an immutable original
and a prepared/installed recovery journal under the private root. It does not
modify ASAR, signatures, login data or writer routing, and never edits native
session registry files directly. Native archival remains a separate guarded action.
Missing or ambiguous structural anchors, unsupported cache schemas, transformed
syntax errors and foreign changes to an installer-owned cache entry fail explicitly.
Asset URL and whole-source hash changes alone do not require a human re-pin.
Initial installation and each newly installed graph require an idle Claude app restart
because the app can retain old resources in memory despite a page reload.
The watcher publishes only verified current owner RC IDs and canonical cwd to
private `folder-map.json`. The renderer polls it through the existing guarded
LocalSessions.readFileAtCwd API and React subscription; no HTTP listener or new
worker is created. Match an existing same-host Local/CLI row and use its actual
native Folder key and label. Missing or conflicting matches get no override.
Rows, IDs, types, routes and native histories remain unchanged. Native cold-start
and live map-update checks verify entries in the original claudex folder, without
pinning or a custom group. Tests must not substitute fixture success for this UI
evidence. `folderProjection` status describes map/resource readiness, not proof
that a particular running renderer loaded the adapter.

`desktop handoffs enable|disable|status` controls native Local predecessor
archival. Configuration changes require a safely stopped watcher and the folder
adapter enabled. A cache upgrade requires an idle Claude app restart. Existing
verified pairs are eligible; this is not an unchecked bulk archival operation.
The coordinator publishes bounded, 15-second archive intents only after exact
original/checkpoint and replacement/canonical verification. Pending work or new
activity revokes commands before expensive verification. The renderer rereads
native identities, title, cwd, activity, idle state, drafts and dependencies before
the normal archive API, with worktree cleanup disabled. An outcome is not accepted
until native archive state and original history preservation are verified.
The native getSession/getTranscript DTO may expose only the Desktop UI ID, not
the CLI ID. Before archival, reread the exact original registry JSON through the
guarded native readFileAtCwd API; require its path beneath the pinned native
registry root, the exact local_<UI ID>.json filename, and matching UI/CLI IDs,
cwd, title and activity. This is read-only, not a registry/database mutation.
Separate presentation anchors survive new turns only while current owner native
ID/RC ID, ledger cwd and source Local-to-CLI registry mapping still match. They
never authorize archive actions or advance checkpoints; expired commands cannot
be revived by an anchor. Archived folder anchors use the observed native session
normalizer and actual git metadata, not invented keys or labels. Keep one fixed
Local original archive per logical conversation, never a new original per turn.
Disposable generated predecessors retain the existing one-previous-per-side, seven-day,
512 MiB aggregate rollback and 50-audit-entry bounds; originals are not deletable
quota entries. Native automatic archival UI acceptance is a separate requirement
from unit tests, manifest publication or service readiness.
Native UI checks now verify existing Local predecessors and a fresh image-origin
Local predecessor are archived, with native Active filtering instead of hiding
rows in code. The All view may still show recoverable archived sources. Actual
native titles have lost their owned legacy prefix; authenticated transport labels
inside conversation content intentionally retain their existing Claudex markers.
Do not claim same-Local-ID bidirectional writing or generic Chat/Cowork support.

A native Desktop probe verifies two then four synthetic messages under one ID,
including archive and deep-link unarchive without another registry entry. This
does not establish a writer lease: archive persists before child exit is awaited,
and unarchive can race an external append. Keep the Desktop-owned write guard.

Reject unresolved Codex history_base references without a self-contained readable
summary; do not silently export only their local tail. Earlier readable originals
can remain in prior rollouts, but prefix ordinals, byte boundaries, item identity,
and complete-turn coverage must agree before publishing a reconstruction.

Experimental SDK path: `ClaudeOwner` is the sole native writer; Desktop views it
through Remote Control. Actual native/desktop tests verify shouldQuery:false,
zero-inference receipts, same remote ID after restart, exact UUID/content
persistence, and duplicate suppression. SDK0.3.281/CLI2.1.281 are validated baselines
enforced only in strict policy. Preserve
the default OAuth namespace by omitting CLAUDE_CONFIG_DIR for standard ~/.claude.
No credential extraction/copy is allowed. The opt-in Desktop watcher uses this
path. Store the owner handle before start() so startup failures
during user work retain the live owner instead of interrupting it.

Context packets preserve portable semantic messages as authenticated labeled
native text/images. DesktopBridge persists a private key, canonical prefix,
single pending transaction and bounded audit. Native history export uses full paginated API reads with a stable
two-read snapshot, including pre-compaction readable history. Do not claim it
recovers encrypted reasoning or native-truncated output.

An exact singleton completed contextCompaction item with only type/id is inert
control metadata when prior request context exists, not a completion boundary.
Publish it only inside a prefix ending with a real completed assistant response;
withhold trailing control turns and unfinished tails. Initial, mixed, malformed
or error-bearing control turns retain normal rejection; never fabricate a reply.

DesktopRuntime reads optional `nativeHistoryMaxBytes` and `nativeHistoryPageSize`
from the private root's config.json. Defaults remain 16 MiB and 100 turns/page;
explicit bounds are 1024..67108864 bytes and 1..100 turns/page. Both original and
owned native exports enforce the configured raw/converted byte budget. Keep the
256-page, 25,000-item and 64 MiB transport-frame limits unchanged. Limit errors
identify the source thread; never add automatic retries, truncation or fallback.
Codex Desktop attaches a display-only data-URL screenshot at mcpToolCall
result._meta["codex/toolSurface"].screenshot.url (Browser Use/CUA); it is not
model input and can be ~90% of a history. Conversations enrolled from now on
carry displayScreenshots:'omitted' (on the conversation and every Codex record
it creates), and their reads replace exactly that data URL with an explicit
{reason,mimeType,bytes,sha256} record before the byte budget. Existing
conversations keep their exact representation; never apply the policy to a
conversation whose checkpoints were made without it.

Native Codex localImage recovery for originals and owned continuations reads
metadata.path's current owned regular rollout. After a native rollover, it may
also read exact previously verified ledger origins, never discover candidate
files. Persist `localImageRollouts` per turn/item/canonical-message identity at
verified promotion, filtering out later source turns beyond the committed count.
A legacy verified record's saved path can establish those origins once. Retained
images must remain inside the saved canonical prefix and match its full digest;
new image messages require current-rollout evidence. Preserve origins across
later path updates, without adding image-free rollovers. Conflicting duplicate
proofs, partial provenance, missing files, aliases or moved message identities
fail explicitly. Use O_NOFOLLOW and stable identity/stat checks across at most
256 explicit files, with a 512 MiB aggregate scan cap and 64 MiB row cap.
Native archival may relocate the current file. A missing former path is not
required when the exact requested images are already completely proven by the
authoritative/retained sources and the saved canonical checkpoint still matches;
an origin still needed for any image remains mandatory. Image-free reads do not
probe obsolete paths. Existing conflicting evidence is never ignored.
An image turn may close with its exact turn_aborted (reason interrupted) event
instead of task_complete; the API reports it as an interrupted closed turn.
Require exact translated completed-item
equality with the full API item, matching thread/turn/context/passthrough IDs,
one earlier embedded user response, exact text, and image wrapper path/number/order
agreement before a closed turn. Keep image descriptors as inert metadata and
validate the recovered data URI and converted-history budget. Never read API
image paths, fetch URLs, search for rollout files or silently choose a candidate.
By user decision, images the current and retained rollouts do not prove may come
from the declared history_base chain (fork or rollover), nearest segment first.
Each link is located only by its exact segment ID in the native layout
(sessions/YYYY/MM/DD or archived_sessions; root <thread>.jsonl or
<thread>_<segment>.jsonl, exactly one match), and its session_meta must belong
to the forked_from thread (fork, with matching forked_from_ordinal_exclusive) or
the same thread (rollover). Rows carry contiguous native ordinals; only rows
before end_ordinal_exclusive count. Observed end_byte_offset values can land a
few bytes inside an adjacent row, so the offset must fall within the last
included or first excluded row. The referenced segment may keep growing; only
its inode and covered prefix length are rechecked. The source thread_id in those
rows is the owning thread's, and every image still matches the exact API item.
Mixed local attachments and inline images retain their exact native order. Inline
bytes come from the full API item and must match the translated persisted user
completion; validate the normalized model-input image without substituting its
possibly resized bytes for the inline original.
This preserves native persisted model-input bytes, not proven unresized uploads.
Owned bootstraps must still be inline authenticated checkpoints before hydration;
only subsequent native inputs can use this recovery path. Packet authentication,
exact transport receipts and all continuation provenance checks remain mandatory.
Accept only the observed passthrough key sets: turn_id alone, plus create_time,
or plus create_time and content_item_kinds. Validate every present value; never
invent absent timestamps. A raw response may omit its own id, but a present id
must remain nonempty and the completed-event/API item identity is always exact.
Only absent raw client_id normalizes to API clientId:null; explicit values must
match exactly, and raw clientId aliases are rejected rather than overwritten.

Shared Codex transport installs for the next normal app start: `bin/claudex-codex.mjs` preserves
native Desktop args/env, starts a public Unix WS listener, and forwards JSONL
unchanged. Do not use a prestarted WS_URL override: it loses Desktop app-tools
injection. The native CODEX_CLI_PATH launcher is the intended activation path;
never restart active user work. Login window restoration can start Desktop
before LaunchAgents, bypassing the launcher; src/codex-desktop-relaunch.mjs then
quits (never kills) and background-reopens that exact process once, immediately
when the override is active and no Codex turn is running (user activity does
not delay it). WS clients share the backend and can retire idle
owned projections immediately (native isolated proof). The CLI's raw proxy is
not compatible with the WS listener. Native socket aliases need strict UID,
private-directory, inode and target validation, not blanket symlink following.
An ENOENT during endpoint inspection is a transport-unavailable wait, not a
fatal history failure. Recheck all socket/manifest identities on the next
connection; permission/alias failures remain strict. Never apply this exception
to missing transcript/archive files or resend uncertain native writes.

Opt-in paginated projections preserve signed packet blocks and images in the
full native history API; default legacy behavior is unchanged. Owned decoders
validate the packet before generic metadata conversion, strip only the exact
explicit transport receipt, and retain real subsequent turns. DesktopRuntime,
DesktopBridge and desktop-watch integrate all-project discovery, stable Claude
owners, bounded Codex snapshots and recovery. Completed-prefix readers withhold
active tails. Verified dead locks are reclaimed; live/malformed locks block.

`desktop install` selects Desktop mode only for roots with no legacy records.
The generated fixed-Node shim configures CODEX_CLI_PATH without changing or
restarting the app. The watcher reapplies its exact override at login and waits
for a private verified shared-backend manifest. Never silently start another
stdio writer. CLI status selects the configured ledger. `desktop uninstall`
preserves transcripts and ledgers; it is not a reverse migration. The launcher
is activated on the real Codex Desktop backend. Automatic native enrollment and
Claude Remote Control registration of real conversations are verified. Both real
mirrored conversations render in the Claude Desktop sidebar and their history
opens through Remote Control. Real dual-Desktop alternation acceptance now
passes, including native retirement of the oldest of three generated Codex
snapshots: one current and one archived previous remain. The original source
is preserved. Do not remove dependency guards for retirement.

The real integrated coordinator/SDK/Desktop check verifies initial import, a
restart, delta delivery, same Remote Control identity, exact canonical history,
and recovery without resend. CLI 2.1.281 inserts a zero-usage synthetic assistant
`No response requested.` after a resumed no-query tail. The owned decoder
excludes only that exact placeholder immediately after an authenticated packet;
real replies remain history. SDK-owned packets from another state root are
excluded during discovery to prevent import loops (classification is not HMAC
authentication). No current user transcript is modified by these checks.

Native metadata, not the rollout header, determines subagent exclusion; ordinary
forks remain eligible. Goal continuations may begin with assistant items and
receive user steering later. Full native reads preserve this order when earlier
verified user context exists, still requiring a final answer and withholding
active tails. Never fabricate a user message to force role alternation.
Desktop create_thread can deliver the first request as a codex_app function
output instead of a userMessage. Only its exact initial delegation envelope
establishes request context; preserve the event's assistant role and full inert
payload. The same narrow predicate permits its owned Codex checkpoint. Generic
assistant-only history, arbitrary tool outputs and malformed envelopes still fail.
An initial native goal may have no API user item. Accept only a stable owned
authoritative rollout proving the exact initial active goal, marked goal context,
thread/turn/cwd identities, every API assistant completion and its final boundary.
Recheck the source inode and goal prefix across both API passes. Preserve the goal
as inert assistant-role historical data, never a fabricated user prompt or an
instruction to run inference. Missing, ambiguous or changed proof still blocks.
Carry the additional canonical message offset into native image evidence and
include the resolver in packaged engines and cold-verification cache identity.

Claude 2.1.281 stores original input images under its private per-UID temporary
project/session image cache, but may persist resized previews in JSONL. When an
exact pending intent proves an original PNG/JPEG, retain its bytes once in the
content-addressed private image-assets store and bind the native preview hash.
Logical reads restore the original and validate the packet; native files are
never rewritten. Missing originals, altered previews or changed text fail closed.
Image bindings grow with actual image occurrences, not image-free sync rounds;
identical originals deduplicate across owners. The observed large PNG-to-JPEG
native preview is restored only with matching PNG/JPEG magic bytes, exact paste
identity, saved preview hash and original pending-intent hash. Regression and
isolated native checks cover roughly 5.5 MiB PNG/JPEG inputs, subsequent deltas,
restart and archived reconstruction. Archive assets are authoritative content,
not disposable rollback snapshots. Other format conversion and ambiguous cache
identities still pause synchronization.

The CLI also appends an `isMeta` image-source sidecar after an imported image
packet, including one text block per image on multi-image inputs (or the observed
single-block newline representation). It is excluded from logical history only
with the exact pinned text
format, matching parent packet, prompt ID/time/cwd, paste IDs and authenticated
packet. Other metadata or user text is retained. The native parent graph is
validated before this exclusion, and ambiguous codec identity mappings fail.
This keeps the following no-query placeholder and next delta on the same digest
chain without editing native files or resending an already persisted packet.

The pinned Desktop CUA and Browser Use helpers invoke exactly
`app-server --listen stdio://`. CUA inherits the app-tools pipe; Browser Use
does not. Preserve both independent auxiliary processes instead of claiming the
shared owner lock. Both routes are verified, including live browser startup.
If Claude has no capturable primary window, its official web session's
Open in > Desktop app action can restore the window. Chrome's external-app
confirmation is a native browser window, not part of the webpage snapshot.
This route restored real Claude Desktop observations without restarting it.

Desktop launchers must use the original OpenAI-signed bundled Node, not the
installing shell's process.execPath. The app's native peer authorizer checks
the peer, parent and grandparent signing identities. A Homebrew/ad-hoc wrapper
breaks codex_app startup and browser policy verification despite a signed leaf
runtime. The installer verifies the bundled Node signature and journals exact
owned-runtime upgrades. An isolated signed-wrapper native startup exposes the
47 app tools without changing the verifier. A normal user-initiated app restart
activated the signed wrapper and restored the live app-tools path. Never
disable peer checks or substitute an unsigned client. Stdio close does not
schedule immediate reconnect; next-request recovery is not proof that killing
an active backend is safe.
The observed 0.158 package relocates Resources/codex into
Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex; bin/codex is a shell entry.
Resolve only the observed same-bundle layouts, verify package metadata/native
OpenAI signatures and journal exact owned launcher migration. Bundled Node stays
at Resources/cua_node/bin/node. Normal startup detects this package even with a
stale recorded flat path. Unknown packaging fails explicitly, never selecting
an unrelated CLI. This does not certify every new protocol or migrate credentials.

Runtime compatibility is centralized in src/codex-versions.mjs. The .16.4 app
update passed isolated native contracts and signed-Node launcher initialization.
Under strict policy an unknown runtime uses original native Desktop transport under the same
exclusive owner lease, labeled transportMode:native, with no shared socket.
The watcher refuses that mode and reports synchronization paused pending version
validation. Only this pre-launch version decision may select native-only mode;
never fall back after an ownership/shared-start/transport failure or bypass a
live owner. Release the lease after the native child exits, including signals.
The projection codec's .16.3 schema label is not a runtime version assertion.

The user can suspend version-only enforcement with `version-policy warn` and
restore it with `version-policy strict`; the setting is saved per state root.
Launcher, DesktopRuntime, legacy adapters and ClaudeOwner honor the same policy.
Warn mode keeps shared transport for unknown Codex versions and attempts unknown
Claude CLI/SDK versions. Native version tags in the existing exact image/reset
formats honor this choice too; no structural/provenance/receipt checks are removed.
Watcher status exposes bounded deduplicated warnings. Settings take effect for
newly loaded workers; never replace active work to apply them. Claudex no longer
injects DISABLE_AUTOUPDATER=1; preserve explicit inherited/override preferences.
Runtime updater behavior and npm dependency upgrades remain the native tools'
responsibility. Keep schema versions, signatures, locks, identity and conflict
checks strict even when runtime version enforcement is suspended.

Rejected transport shortcuts: queue/add auto-starts inference on an idle native
thread. shellCommand persists userShell events without a model request, but
native model-context output truncates around 40k characters even when API output
is complete. It is not a lossless arbitrary-packet transport and is not enabled.

Reverse Desktop delivery creates a new Codex task using the stored logical title
without a prefix; it never appends into the original task. A verified independent
Codex original is archived only after promotion of the complete replacement.
Original-archive preflight runs before allocation, and pending.archiveOriginalId
journals the exact target for idempotent recovery. Originals remain unmanaged
and excluded from deletion quotas. Active, changed or dependent originals block
this transition; existing sessions are not bulk-renamed or archived on startup.
Older pending transactions preserve their saved naming and archive behavior.
Native IDs, managed records, packet signatures and checkpoints remain
authoritative. UI-only renames do not change the stored title for later
generations. Naming changes must not alter transport markers or weaken
original/retirement guards. Superseded originals remain tracked:
sync, recovery and collection compare their own saved checkpoints and reject
new complete turns or changed prefixes. Never silently ignore activity in a
preserved original or compare it to the newer canonical checkpoint. Recovery
also rechecks a replaced destination after a durable native apply, before
promotion, so concurrent work cannot be silently left behind.

Fresh user-authorized Desktop acceptance verifies same-title deliveries across
two Codex generations, automatic original archival with exact bytes preserved,
one visible current entry, one archived generated predecessor, a stable Claude
owner and equal canonical history. Existing dependent originals are not migrated
by force. The preserved original remains a separate fixed copy, not a backup
that grows on every synchronization round.

Desktop `contextMode: "archive"` stores complete portable messages in private
content-addressed history-assets and sends signed v2 packets with bounded,
explicitly labeled readable text excerpts and authenticated native image blocks.
They are not AI summaries. Archive storage alone is not visual model input: the
former three-text-only packet preserved images on disk but did not present them
to the receiving model. Image-bearing packets now sign imageProjectionVersion:1
and project exact supported source/tool-result images alongside the text view.
Arbitrary image-shaped tool input JSON remains inert, not visual input. Native
packet byte limits still fail explicitly without dropping or truncating images.
Explicit imageProjectionVersion:0 reproduces existing prepared three-text packet
bytes exactly; recovery must not silently change a saved operation's encoding.
Mixed v1/v2 decoders reconstruct the exact canonical digest; authenticate before loading
archives and require their signed archiveRoot to match the configured root.
Archive assets are authoritative history, not rollback garbage.
One-time image-context repair uses the record's imageProjectionVersion flag.
DesktopBridge serially creates a bounded new managed Codex snapshot and refreshes
the same Claude owner with a complete authenticated checkpoint. historyPrefixCount
must match the exact prior canonical prefix; only a genuinely new tail advances
logical history. Repeated historical messages/images are not new authored turns.
The Claude refresh retains its native and Remote Control IDs, performs no /clear,
and invokes no model. Existing original, activity, pending, dependency and quota
guards remain intact. Archive digest/fixture success does not establish model
visual acceptance; verify actual model input after deploying the representation.
Visual-only replacement of an already managed Codex snapshot does not acquire a
new archival intent for a legacy preserved original; its checkpoint is unchanged.
Preflight and retirement still verify the managed target's independence, and
superseded-original content/activity guards remain global.
Fresh native vision acceptance verifies PNG and JPEG pictures in both directions,
including a new large image attached after a Codex handoff. The receiving models
identify visible details and retain earlier codes; canonical image hashes and
original prefixes remain exact. Native apps can resize uploads before persistence;
do not label their persisted model-input bytes as unresized uploaded originals.
Archive chunk loading overlaps at most four independent read-only operations,
retaining every file/directory identity, permission, byte and hash check and
draining each batch on failure. Within one synchronous stable Claude snapshot,
exact native packet content may reuse its authenticated decode. No result
survives another snapshot. Growing prefix hashes must remain byte-equivalent
to the existing fingerprint and are checked against a final full fingerprint;
never use these optimizations to skip lifecycle, provenance or later file reads.
Archive format v2 shares reference pages of at most 64 messages; full-checkpoint
metadata growth per new message is bounded instead of quadratic. Preserve v1
archive encoding when recovering old packetVersion2 intents without archiveVersion.

Inline-owner migration requires a fresh deferred, input-isolated maintenance
process after the previous writer exited. Ordinary hooks/plugins/tools/MCP are
disabled only in that process; fixed macOS managed/MDM/remote policy inputs must
be absent or bounded-readable, with no managed hooks or dynamic policy helpers.
Never use bare mode, hot detach, or a stale idle level as a reset lease. Dispatch
only advertised /clear with shouldQuery:false and without client_composed. Match
the result's native session_id to the new init; conversation_reset's display ID
is different. Preserve the old byte prefix plus exact verified native metadata.
After authenticated archive restoration, promote the new native ID before a
normal-profile worker reattaches the same RC ID. One sealed prior generation is
retained; repeated resets are refused until safe retirement exists. Unknown clear
outcomes are never resent. Unexpected session identity makes shutdown unsafe.
CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS must be enabled explicitly. Pinned native
no-query appends and /clear also emit running/idle; correlate their own receipts
and wait for reset idle without classifying the owned lifecycle as user work.

Verified archived current owners resume directly with their normal execution
profile after restart; pending resets still require deferred cold maintenance.
Owners start on demand and each keeps a native Claude process (~300 MB). The
watcher closes an owner unused for claudeOwnerIdleSeconds (config.json, default
900, bounds 60..86400) while it waits for events: only idle, unblocked owners
with no pending/reset/background work, never while the ledger has a pending
transaction, and a busy refusal keeps the owner. The next delivery, required
maintenance/recovery or explicit wake restarts it with the same Remote Control
identity. Verification stays process-free while closed; its Desktop
entry is not connected, like any other owner that has not been started.
The Code owner-wake adapter resolves the native session component structurally:
initialSessionId/sessionType, submitMessage/getComposerSnapshot, the asynchronous
send's waitForImagesReady and its retained current-reference getter. The same
reference supplies selection and native send; signal submit before early refusals.
Require unique complete binding relationships, never select the shared Chat/Cowork
view or a wrapper merely exposing a similar submit interface. Never await or retry
native send. Resolve the exported exact-UUID lookup by its read-only getState,
Object.entries(localClients), uuid/client destructuring and exact UUID return.
Import that already attached user-config stdio client lookup from the current
reachable module. Preserve the runtime's open MessagePort transport and Claudex
server identity checks; native session proxy clients are refused. Never connect,
replace or close a client, change connector approval, borrow a Local session,
inspect prompt content or send model input. The managed/builtin directMcpCallTool
pool is separate and must not be used. Independent ui-owner-wake/<cache filename>
journals preserve earlier originals and receipts.
Owner-wake inbox keys stay separate from completion hints. All tracked-pair,
registration, canonical native-path, pending/block/retired/alias/relocation and
app-stop guards remain unchanged. Owner activation refreshes idle eviction without
Codex transport, sync, archival proof publication or queued-message replay. Native
RC owns delivery. Promoted recovery reconnects the normal owner without a cached
handle. Ignored hints have bounded diagnostics, no automatic wake retry.

src/claude-frontend-graph.mjs discovers the latest fetched index entry from the
private HTTP cache using verified Chromium HttpResponseInfo response timestamps,
never filesystem mtime (patches change mtime). Require a unique newest entry and
its root bootstrap. Follow literal static/re-export/dynamic imports within the
exact Anthropic assets origin; only reachable cached modules qualify. Missing
lazy chunks are counted, never fetched or replaced with an older graph. Cache
recency cannot prove which graph a running renderer has already evaluated.
Resolve LocalSessions from its globalThis["claude.web"] binding/export/import and
React hooks from their public getter, definition and export/import relationships.
The folder adapter requires the unique repoInfo/isScratchWorkspace/environmentId
project-key function and sidebar sessionStatus/hasActiveSessions/disambiguationText
aggregation. Retain its native key/label fallback and extend its compiled memo
cache with the map subscription version. Older conditional bindings retain a
compiler and an uncompiled implementation: validate and patch both branches of
the one exact binding, including useMemo's version dependency; never choose a
branch from host feature flags. Graphs are bounded to 2,048 cached modules and
2,048 missing imports (observed older entries reach 1,171 cached modules).
The independent chat-wake adapter uses the session-action module's unique native
import binding and optional forkSession capability relationship (older branches
repeat the same read),
reopenClosed and amber_tributary_lantern_overview_toggle shortcut anchors. Folder
bootstrap no longer embeds another chat-wake consumer. Every adapter's entire
transformed module must pass Acorn syntax validation before any cache publication.

src/claude-renderer-maintenance.mjs is owned by the normal Desktop watcher under
watch.lock. It performs one startup cache pass, then debounces cache-directory
notifications and serially re-discovers/reapplies all enabled adapters. Exact
metadata/key hints suppress unchanged JS entries and unrelated HTTP/image writes;
anonymous notifications still recheck the graph. Hints never authorize patches.
Failed or partially refused passes discard unchanged-asset suppression evidence;
the next JavaScript cache hint revalidates through the normal guarded installer.
Do not schedule polling or retry timers. Failure diagnostics expose fixed phase
and reason codes, never native error text, paths or cache keys.
Subscribe to app-stop.json through the event source's shared root watcher before
the initial hold check. Graphical resume starts services before clearing that
hold; its release must trigger renderer revalidation without cache activity,
history synchronization or a timer. Close the subscription with maintenance.
Existing normal native folder cache configurations opt in; graphical setup records
rendererAdapters.enabled. An explicit false disables automatic cache maintenance.
A disabled folder choice stays disabled. Cache maintenance reads no conversation
histories and does not renew archive intents, advance checkpoints, start owners,
run inference, restart services or reload apps. The 30-second status heartbeat
remains status-only. Check app-stop before publication and stop/drain cache work
before releasing watch.lock. Bounded renderer-adapters-status.json and watcher
rendererAdapters report matched/installed/skipped assets and activation limits;
folder status also exposes this maintenance report.

Each resource uses <adapter>/<cache filename>/ui-folder-compat, with adapter
ui-folders, ui-chat-wake or ui-owner-wake, an immutable original and a
prepared/installed journal.
Older graphs can share one folder/chat resource. The all-adapter installer
combines both complete transforms in one transaction and owns its immutable
original/journal under ui-folders/<cache filename>/ui-folder-compat. A disabled
folder choice installs chat only there. Individual adapter calls refuse a shared
resource without the explicit combined/chat-only mode. Restoring that shared
resource restores both transforms; earlier independent journals remain intact.
Normal graphical chat setup passes the saved folder choice to that shared recipe;
explicit folder enable selects the combined recipe. Never remove an enabled
folder patch merely because chat setup runs before synchronization setup.
Observed source hashes bind recovery evidence, not a checked-in allowlist.
Never overwrite foreign changes or prune earlier generations. Re-discovery reads
validated originals for installed/prepared generations; reinstall is idempotent.
Restore uses the journal-bound original URL/hash, including older resources.
The watcher receives notifications after cache writes: it cannot guarantee that a
new asset is patched before the renderer first evaluates it. A new installation
is restart-required; unchanged cache is load-not-verified, never proof of live
reception. The user performs each idle Claude restart; automatic reload/quit is
forbidden. Unsupported structural/API changes remain explicit skipped adapters.

Each resource logs its bounded loaded asset name; owner/chat wake also log started.
These lines prove bootstrap execution, never native receipt or owner reconnect.
Owner wake keeps API availability, exact stdio lookup/connection and selection/
submit received, matched, ignored, called, accepted/deferred or fixed failure
reasons. Never log native error/receipt text, IDs, paths or input. Limit duplicate
lines to once per second and runtime diagnostics to 64 per thirty seconds, without
diagnostic timers/retries. Synthetic, syntax and copied-cache checks are not live
renderer acceptance. Earlier native reception evidence remains historical; each
new graph requires separate live reception acceptance before claiming delivery.

dev/verify-claude-frontend-builds.mjs is a developer-only static acceptance script.
It inventories real cached entries and all current/legacy renderer journals,
validates immutable originals, copies exact import graphs into temporary homes,
and runs production discovery/installation plus node --check and AST/wiring
comparison. It compares historical hand-pin transforms with the current runtime
supplied to both, excluding diagnostic label spelling, and exercises actual
fs.watch re-application, original/receipt preservation, reinstall and restore.
It never executes vendor modules, performs inference or mutates live cache/state;
only metadata reports survive. List exact missing assets and explicit failures.
Obsolete shared Chat/Cowork owner-wake pins are not equivalent to the required
Code/attached-stdio design: report their refusal/comparison failure and preserve
them, never restore directMcpCallTool or the wrong component to pass acceptance.

The integrated real SDK/coordinator proof preserves four canonical messages
through a cold migration, restart and then a six-message next-delta checkpoint;
the v2 delta and archive path render in the same Claude Desktop entry. Native
receipts report zero inference. The live watcher has also migrated both real
conversations without changing their Remote Control identities or canonical
digests. The large history's real Desktop context fell from over-capacity to
41.1k/1M while complete portable content remained in the archive. This native
context migration does not erase the older cloud display history. User-authorized
model-generated acceptance verifies two full alternating continuations from a
real source containing compaction and history_base, followed by a final Claude
recall and automatic bounded snapshot collection. Both logical histories match.

Pinned no-query receipts have zero num_turns and duration_api_ms, but
total_cost_usd/modelUsage are cumulative across real replies and resume. Require
finite nonnegative cumulative cost, not absolute zero; preserve success, exact
single input UUID, session identity and native persistence checks. Report this
field as cumulativeCost, never as measured append cost. The native /clear
receipt still requires zero cost after its ledger reset. Recovery of the
observed old false-positive block verified exact persisted SDK/no-query input,
authenticated canonical history, no later authored rows and an exited writer;
it preserved the pending intent and did not resend or invent a lost receipt.

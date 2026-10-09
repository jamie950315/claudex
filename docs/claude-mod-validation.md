# Claude Mod integration validation

The current source target is Claude Mod 0.8.15 in Claudex.app 1.2.31. The version-scoped
cache-warm acceptance below used isolated staged sessions and did not update the installed
app, global preferences or existing conversations. Version-scoped installation
checkpoints remain historical evidence, not claims about the current installation.
The earlier reviewed Mac used `nativeWake=true`, `selfWake=true` and broker route
`mod-self`; source defaults remain false. Installation, native invocation and
actual Desktop display are separate evidence.
Private IDs, transcripts and evidence directories remain outside this repository.

## Codex 25-minute native retention experiment, 1.2.6 (2026-10-04)

The new-enrollment default is 25 minutes; saved explicit 20-minute policies are
unchanged. The complete Node run passed 1,685 tests, zero failures and 23 opt-in
skips. A final focused 33-test run additionally covered mid-turn enrollment
waiting for its first native settings snapshot instead of advertising an
unusable timer. The bundled Mod payload is unchanged at 0.8.5.

An explicitly authorized experiment used native ChatGPT sign-in and two isolated
persistent Desktop threads on Codex 0.160.0. Both used configured
`gpt-6.1-sol` / high effort after their test-only settings were normalized before
any model input. These are native configured settings, not independent response
model telemetry. The existing native owner handled every input; there was no
fork, separate inference CLI, API key or change to an existing user conversation.

| Measurement | Warm arm cached-input tokens | No-refresh control cached-input tokens |
| --- | ---: | ---: |
| Initial completed primer | 35,968 | 35,968 |
| One automatic refresh at 25 minutes | 36,096 | No request |
| Final measurement at approximately 31 minutes | 36,224 | 36,096 |

The scheduled refresh replied exactly `OK`, used five output tokens (zero
reported reasoning tokens), called no tools, and became `verified` only after
exact native completion and accounting. Its one-refresh limit stopped further
warming. Final measurement starts were 1,863 and 1,857 seconds after the warm
and control primers respectively. Native metadata verified exactly four warm-arm
turns and three control-arm turns, all completed, with no extra turns. Both final
requests returned `OK` with five output tokens. All test warming ended disabled.

**The automatic warm path and cache hit passed, but retention extension is
inconclusive.** The untouched control still reused its full observed prefix at
about 31 minutes. The warm arm's larger final cached-token count reflects its
additional history; it is not evidence that warming extended retention or made
the response faster. This single run does not establish an expiry time.

Real testing exposed two boundaries missed by the initial synthetic setup:
ordinary turns emit unchanged settings snapshots, and a new thread can resolve
native default instructions on its first turn. The adapter now keeps the
independent permission/provider/plugin baseline, binds the first observed prompt
snapshot to confirmed identity, and rejects subsequent actual changes. It never
uses an idle resume response as already-observed prompt evidence. A mid-turn
enrollment with no snapshot waits instead of scheduling an unusable refresh.

Earlier candidates are preserved: one failed before inference when Desktop's
loaded defaults differed from creation metadata; two completed four seed/primer
turns each but stopped before warm dispatch on settings checks. An attempted
reuse also refused differing settings without inference. The final seven-turn
run brought this request's total to 15 main test turns; there were no uncertain
input retries. Private reports, native IDs and synthetic native histories remain
outside the repository. Existing user work and the installed 1.2.4 app were not
restarted or replaced by this experiment.

## Codex best-effort 1.2.5 / 0.8.5 verification scope (2026-10-04)

Codex now has a separate, explicitly confirmed broker-owned best-effort scheduler
and private journal. The complete Node run passed 1,674 tests with zero failures
and 23 opt-in skips; subsequent focused service/RPC checks cover the final status
metadata and exact-root/peer CLI confirmation. All 22 native Mod kit cases and
strict staged validation passed. The Mod version changed because its packaged
transport allowlist changed; its pane still controls its own Claude settings.

Synthetic tests exercise a timed same-owner dispatch, exact returned-turn
attribution, complete-turn cache verification, tool-activity stop, budgets,
same-millisecond samples, second-precision starts, opt-out during awaited
preflight, actor isolation, disconnect and timeout without replay. A candidate
cache hit is not finalized until every buffered request has been accounted and
the exact native turn completed successfully.

Live Codex Desktop 0.160.0 inspection and observer attachment used the existing
owner with no model input, new thread, fork or setting override. The private
observer probe received two fresh counter-delta samples and stopped at its
one-minute enrollment deadline; it made zero dispatch attempts and ended
disabled. Earlier short probes observed no second sample and remain inconclusive.
The one-minute probe's original harness assertion treated normal duration expiry
as unexpected retirement; that assertion was corrected without weakening the
product deadline or rewriting the retained report. These observations verify
the native metadata/usage connection, not an actual Codex warm-turn reply or
retention extension. No Codex cache-refresh inference was performed, and the
new build has not replaced the installed 1.2.4 app in this verification step.

## Cache settings pane 1.2.4 / 0.8.4 validation (2026-10-04)

After explicit installation approval, the existing Claudex app completed normal
Quit with verified synchronization, collaboration and owned-process shutdown.
The development-signed 1.2.4 bundle replaced the installed app with a recoverable
1.1.2 backup retained outside the checkout. All 129 installed engine files matched
the reviewed source and strict deep signature verification passed. Normal app
startup installed and verified Mod 0.8.4 through its journaled native-manager
path, preserving the prior 0.7.3 cache and both configuration identities' receiver
opt-ins. Existing Claude sessions were not restarted; the app correctly reports
installed/enabled separately from waiting for fresh loaded-version evidence.

The native pane now exposes TTL and startup preferences through the existing
cache client rather than a separate writer. The official native test kit passed
all 22 cases. Its new narrow Desktop-surface test selects 5m/fixed-default,
verifies preview is read-only, switches through all nine languages without losing
the complete confirmation or form values, confirms the native environment/store
change, then changes only the current TTL to 1h while retaining the fixed 5m
startup default. Discard removes the confirmation, and no warming enable occurs.
This is native UI tree/API simulation, not a screenshot of an installed Desktop
session. Existing tests validate both native surface schemas.

The complete Node suite passed 1,644 tests with zero failures and 23 opt-in skips;
affected controller/localization tests also passed after the final presentation
cleanup. Regressions cover duplicate confirmation, stale panel context, native
preview revocation and settings-only TTL changes without model work. The prior
four-process persistence evidence remains applicable to the unchanged startup
and storage implementation. No new model inference was performed for this pane
change or installation; installed Desktop painting remains a separate check.

## Persistent TTL preferences 1.2.3 / 0.8.3 acceptance (2026-10-04)

Four sequential, isolated Claude Code 2.1.286 processes used the shipping Mod,
one fresh native configuration directory and a real private broker. A fixed 1h
default survived a temporary 5m selection; the next process restored 1h. Remember
mode then retained the latest confirmed 1h selection across another process exit.
Switching to session-only left the current 1h value unchanged, while the fourth
process used its original 5m launch environment. Every process began with warming
disabled, every local-command result reported zero model turns, no warm attempt
was created, and all four owned processes exited. No user credentials were copied
or existing configuration/plugin store modified. The test used the previously
authorized function-hooks option only in its isolated processes.

The complete Node suite passed 1,640 tests with zero failures and 23 opt-in skips.
All 21 official native-kit cases passed, including startup environment application
and managed-policy refusal; these are synthetic native API tests, not Desktop
painting evidence. Regression tests separately cover stale cross-session remember
writes, partial saves and activity races. Remember updates use revision-specific
keys and cannot overwrite another session's newer persistence mode or last choice.

Initial harness candidates stopped on a local command's synthetic assistant
envelope and on aggregate/too-early session-identity readiness checks. Failed roots
were preserved. The corrected harness distinguishes local synthetic output and
waits for the exact newly observed native context without replaying old commands.
This evidence verifies native preference persistence, not a new one-hour cache
retention experiment or installation into existing Desktop conversations.

## Native TTL sync 1.2.2 / 0.8.2 acceptance (2026-10-04)

An authorized isolated Claude Code 2.1.286 session with Sonnet 5.5 and requested
medium effort switched the real main-cache TTL from 5m to 1h and back to 5m using
the shipping Mod's on/confirm commands. The official environment API changed
only the current process. Native readback and the following ordinary request's
actual cache-creation buckets agreed: 5,537 tokens in the one-hour bucket with
zero in five-minute, then 8,937 tokens in the five-minute bucket with zero in
one-hour. Both requests generated four output tokens. These were cold writes,
not proof of latency improvement or one-hour retention duration.

There were exactly two main model requests in one native session, zero automatic
warm attempts, and zero model turns for status/on/confirm/off. Off retained the
selected TTL. The owned process exited. The test used the explicitly authorized
function-hooks option only in its process; no API key, global preference, vendor
binary, existing conversation or installed app was changed. Subsequent synthetic
regressions cover queued-timer exclusion, native activity before the environment
write and explicit partial-write/readback-failure reporting.

## Cache-warming 1.2.1 / 0.8.1 acceptance (2026-10-04)

An explicitly authorized isolated Claude Code 2.1.286 session, using Sonnet 5.5
and requested medium effort, passed the actual shipping Mod's local status,
on/confirm, timer, native reply, broker accounting and off path. The native
function-hooks option was set only for the test processes; global preferences
and the vendor executable were unchanged. The test used one native session, no
fork, no API key, no peer-wake route and no self-inbox delivery.

The main seed wrote 7,446 cache tokens. At the four-minute deadline, exactly one
native plugin-origin prompt reused all 7,446 tokens, wrote 105 new cache tokens
and generated four output tokens (`OK`). The broker recorded one verified
response, reached `refresh-limit`, and scheduled no further refresh. Explicit
off retained the accounting and disabled the policy. Status/on/confirm/off each
returned zero native model turns; the owned process exited afterward.

Native acceptance exposed two boundaries missing from synthetic hooks: the host
suppresses the originating plugin's own prompt hook as re-entry, and wraps its
idle message before `turn.start`. The fix binds the already authorized one-use
dispatch to exact raw/native-framed text, context, epoch and expiry, without
forging user origin or an acknowledgement. A stale awaited callback cannot
replace a newer human turn. Earlier submitted-but-unverified attempts remain
uncertain and were not replayed; success used a new isolated session.

The SDK initialization catalog can precede dynamic command registration, and
its result can precede completion-hook settlement. The manual harness waits for
the actual loaded-version observer and broker state rather than treating those
earlier signals as failure or completion. It never retries model input.

This verifies the opt-in CLI/SDK native-owner path, not Desktop rendering, every
runtime's default Mod availability, one-hour TTL, Codex warming, or all native
queue races. The earlier main-turn/control experiment separately established
reuse after the original five-minute TTL. Native admission still has no public
atomic dequeue API.

## Historical 1.1.1 / 0.7.1 checkpoint (2026-10-03)

The 0.7.1 stage passed all 18 official native kit cases on Claude Code 2.1.286,
using the previously approved function-hooks option only in the isolated test
process. End-user setup does not set that option. The public v1.1.1 artifact was
built from `a066217`; its 127 engine files and nine app locale catalogs matched
source after extraction, and strict deep signature verification passed. Its ZIP
SHA256 is `1ea3bfc0d5559abb18cd279afdcd550a114ca32b3b257f22395f4c7318029c8a`.
It is development-signed, not notarized. Subsequent documentation-only corrections
do not imply the existing release archive was rebuilt or retagged.

The current Desktop check observed the actual 0.7.1 pane and its fresh
loaded-version self-report. This proves that the reviewed session loaded and
painted the current companion, not that every pane action or a new native-wake
message was accepted. No new Stop ACK is inferred from the version display.

Separately authorized two-direction supervisor/child acceptance verified that
proactive follow-ups were received and acknowledged in generation one through
the cooperative worker protocol. All four native invocations completed once,
the read-only fixture remained unchanged and recorded process groups exited;
see [the collaboration verification scope](collaboration.md#verification-scope).
That evidence does not certify instantaneous native steering or interruption,
external Desktop idle wake, or a new synchronization runtime.

The historical records below retain earlier test-kit refusals, approved isolated
test exceptions, unsuccessful messages and subsequent successful cases. They
must not be reset, replayed or rewritten into newer acceptance claims.

## Historical 1.1.0 / 0.7.0 app-managed lifecycle acceptance (2026-10-03)

Graphical setup and normal startup now install/update only the bundled Mod through
the official manager, with an app-owned journal and immutable versioned stages.
Status inspection is read-only. The nine-language app reports payload integrity,
installed version and fresh loaded-code observations separately, offers scoped
install/update and explicit enable actions, and confirms receiver permission
changes without changing native notification routes or model defaults.

The integrated regression run passed 1,550 tests with zero failures and 23
existing opt-in skips. Official strict validation passed with zero errors/warnings,
and all 18 native kit tests passed with the previously user-authorized isolated
test-process function-hooks option. Setup never applies that option or runs a
model/test suite on an end user's machine. Swift compilation and native synthetic
layout smoke passed, including Traditional Chinese activation waiting, German
compact-ready, one scroll view, natural fit and read-only controls.

Real native tests in separate empty user homes verified initial installation,
repeated-startup idempotence, read-only settings preservation, legacy 0.6.2 to
0.7.0 migration, independent marketplace/inline preferences, explicit receiver
changes, intentional disabled-state preservation and explicit enable. The app
setup path itself installed the Mod while account/service operations were
isolated, and correctly left native activation unverified. These are fresh-profile
tests on this Mac, not physical acceptance of every other machine or native policy.

A separate empty-home bootstrap downloaded the pinned official 2.1.287 manager,
verified wrapper and platform-package integrity, ran no package scripts, and
selected the real native platform binary rather than its wrapper's postinstall
placeholder. Subsequent read-only discovery found that same working manager.
This leaves the inference CLI unchanged. Real npm configuration probes also
reproduced and repaired the former duplicate /dev/null user/global configuration
failure, using distinct private empty files without inheriting user credentials.
The app setup path then used that real pinned 2.1.287 manager in the same empty
profile to install 0.7.0 successfully, with receiver defaults off and activation
still correctly waiting. This closes the bootstrap-to-installer integration path;
the test did not merely inspect the manager's help output.

The development-signed 1.1.0 app was installed through normal Quit, verified
owned-service shutdown and recoverable bundle replacement. On ordinary startup,
the app itself migrated the existing verified marketplace to app-mod/releases
and upgraded 0.6.2 to 0.7.0; no separate manual plugin installation command was
used for that live upgrade. Its journal reached complete, its previous source
remained present, and both native configuration identities retained their prior
receiver values. The UI first showed installed-but-not-loaded waiting rather
than falsely declaring activation. A new ordinary Claude Code session opened
/claudex without model work; actual versioned observations then made the app show
bundled/installed/loaded 0.7.0 with manager 2.1.286 and the unchanged mod-self route.
The app returned to compact ready presentation. Neither Codex nor Claude was
restarted, and no global function-hooks override or credential copy was made.

Newly installed users still need the vendor apps, native sign-in/trust and any
required component downloads. Existing sessions can retain old Mod code; a new
session loads an update. Receiver observations are bounded self-reports, not a
guarantee of delivery. The app remains development-signed and not notarized.

## Historical 0.6 work observability acceptance (2026-10-03)

The source adds per-task public events, complete structured report history,
generation-fenced blockers and instruction acknowledgements, scoped artifact/diff
reads, explicit result review, and cooperative pause/resume. The existing Mod
work view exposes the same authority, with nine-language catalogs, bounded
generation selection and on-demand reads. Public content collection and
intermediate notifications are independently opt-in; neither changes native
origin proof or grants worker authority.

Synthetic checks exercise the real MCP facade/private Unix RPC through report,
blocker notification, exact decision, next-generation instruction adoption and
final result. Event/report/artifact reads preserve revisions and child-outcome
acknowledgements. Focused tests cover expiry during artifact reads, no-follow
file identity, literal Git pathspecs, pagination/gaps/deduplication, pause/cancel/
handoff/restart boundaries and notification rate-limit suppression. Full regression
ran 1,534 cases: 1,510 passed and 23 opt-in cases skipped; the sole failure was an
old CLI fixture expecting 11 tools rather than 15, repaired and passed in the
affected CLI/Mod group. Later presentation deltas passed their focused tests;
unchanged expensive checks were not repeated merely for packaging.

Authorized source-runner native acceptance used Codex 0.159.0-alpha.12.1 with
gpt-6.1-sol/xhigh and Claude Code 2.1.283 with opus/medium, through actual worker
MCP and Unix RPC. Codex completed one invocation with 22 retained events. Claude
completed a real checkpoint/process-exit pause and a second resumed invocation,
with 26 retained events. Both returned final results and worker-provenance
reports, and exact declared artifact hashes matched an unchanged fixture.
Independent process-table inspection confirmed all recorded leaders and process
groups, including the paused generation, absent. These were three new read-only
invocations with notifications off, not blocker-wake or Desktop painting proof.

The final 0.6.0 stage passes the official Claude Code 2.1.286 strict validator
with zero errors/warnings. The complete native test kit was attempted but refused
before running tests because the runtime's function-hooks rollout is disabled.
No explicit disabling environment/settings entry was found in the bounded known
locations, and no feature flag or policy override was applied. Synthetic rendered
trees do not replace this gate or actual Desktop pixels. The live companion was
therefore preserved rather than replaced with an unvalidated candidate.

The normal Apple Development-signed app builder packaged the changed backend and
the uninstalled companion source. All 121 allowlisted runtime/entrypoint/plugin
files matched the source. Installation used the app's ordinary Quit drain,
verified stopped services and zero native-owner blockers, preserved the previous
bundle, copied with ditto, and passed strict deep signature verification. Normal
startup resumed the exact owned services and cleared the app-stop hold without
changing model/effort/permission defaults or restarting Codex/Claude. The app is
still 1.0.3 and development-signed, not notarized; shipping a staged plugin inside
the bundle is not installation or native validation of that companion.

Installed blocker acceptance then used a fresh persistent Codex main and a new
read-only Claude task. Native origin binding succeeded automatically. The main
read exact work_events/work_reports on the real blocker wake, responded once to
that blocker/generation, and the second Claude generation acknowledged the exact
instruction as accepted before returning the requested final nonce. The main
read resultFinal and the accepted-instruction evidence. Both the blocker native
wake and the final native wake have actual recipient Stop ACKs. A first-generation
terminal notice arrived while the main was busy and followed the normal hook
path, also acknowledged; no second writer or custom delivery route was added.

The initial CLI acceptance source was refused before dispatch by its MCP approval
configuration. A fresh invocation used the already-supported, invocation-local
tool approval option, without changing global settings. That source bound but
had no native title, so exact recipient discovery refused both notices. Its two
uncertain records remain unchanged; nothing was rebound or resent. A later peer
setup was correctly refused because the earlier main request had authorized only
one start. The successful fresh source explicitly authorized one later tagged
setup in its initial request, received a title through the normal native API,
and used new task/request IDs. These are fixture/lifecycle findings, not reasons
to weaken title, peer-authority or no-replay guards.

A final source inspection also repaired a presentation edge case: explicit new
reports on a legacy task without a public event ledger now report collected
history correctly, without enabling native content collection. Its focused
regression passed; the prior native execution/delivery evidence remains valid
because that one read-time label does not change execution or notifications.

### Completed Mod gate and installed UI follow-up

The user subsequently approved `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` only for the
isolated official test process. With that process-local option, the final 0.6.2
candidate passed all 18 native kit tests and its strict validator reported zero
errors/warnings. No global option, native inbound policy, credential or app
restart was introduced. This explicit test opt-in is not evidence that every
unmodified CLI runtime enables function hooks by default.

Real Desktop inspection exposed a standalone-package defect that mocked transport
tests had missed: the staged transport omitted collaboration-wait and imported
broker-only notification dependencies. The shared policy validator was extracted
into a pure module, with explicit stage/app allowlists. A new integration test
copies the real source allowlist, stages it, removes that source copy, and reads
through the actual staged helper and Unix RPC. The packaging/transport/notification
group passed all 44 tests. A later 43-case affected group also passed after
aligning the pane's artifact read to the API's 64 KiB bound and preserving a typed,
bounded artifact refusal instead of generic companion-unavailable text.

The official native manager installed the updated companion while retaining
earlier cache versions and recoverable marketplace copies. Both known native
configuration identities retained the exact state root, bundled Node, and existing
nativeWake/selfWake values. Already-loaded SDK sessions can retain their older
plugin root despite reload-plugins; a fresh Local session loaded the update
without restarting Claude. The first /claudex submission in a fresh composer can
leave a native command-catalog warning while the registered handler opens its
pane; do not equate that warning with inference or successful plugin activation.

Actual native pixels verified the narrow two-row navigation, task pagination and
exact task detail, independent report/activity timestamps, the answered old-generation
blocker, worker-reported instruction acceptance, and artifact/check entry points.
Native interaction switched history to generation 1, showed both reports, and
read generation 2's native tool/message timeline with source labels. These pixels
were captured on 0.6.1; 0.6.2 leaves that rendering unchanged and corrects only the
artifact byte request/error path. A real installed 0.6.2 helper read the 52,379-byte
declared document through Unix RPC with a matching SHA256 and attribution unknown.
The final package has 23 companion files and 122 app engine/entrypoint/plugin
files, verified against source after normal installation and strict deep signing.
Final 0.6.2 native inspection also displayed the declared document's beginning
and end with file-observed provenance, then showed the complete exact-generation
result-review confirmation. Discarding that preview preserved its audit receipt
without dispatching the operation or changing the task revision. A fresh host
view briefly exposed the native session in accessibility state before painting
it; ordinary Back/Forward navigation to the same session restored the actual
view without an app restart, reload, alternate owner, or another model turn.
Synthetic all-language tests remain distinct from this bounded native visual
acceptance; this is not proof of every button or vendor host lifecycle.

The final confirmation audit reproduced another completion-boundary defect:
reviewing a finished result or closing its blocker advanced the task revision,
which could manufacture another unread result and completion notification.
These annotations now preserve the completed work revision/timestamp, with their
own timestamp/provenance retained. The 32-case affected protocol, notification,
observability and Unix/MCP integration group passed after the repair. Actual
execution, reports, active controls and new work retain their normal revisions.
The installed broker then accepted an independent controller review of the
verified acceptance result: revision remained 10, all three existing messages
remained acknowledged, and no additional notification was created. Final source
hash checks matched all 122 app files and 23 companion files; the stop hold was
released and both earlier uncertain notification records remained unchanged.

## Historical Codex main completion-wake acceptance (2026-10-03)

The user authorized a bounded native completion-wake check. A persistent Codex
CLI source was opened in its exact existing Desktop conversation, using Codex
0.159.0-alpha.12.1. That main called the installed `claudex_start` for one read-only
Claude Code 2.1.283 worker, explicitly requesting `notifications.mode=wake`.
No provider defaults, hook trust, native input policy or synchronization allowlist
changed.

The first attempt exposed the persistent native `exec` source label missing from
origin validation. The next exposed Codex's default `thread/list` excluding that
same source kind. Both were reproduced with exact read-only native metadata and
fixed generally: primary `cli`, `vscode` and `exec` sources still require the
existing persistent user-thread and exact native call/result proof; catalog
queries explicitly select those primary kinds and reject unknown/auxiliary ones.
The unbound first task and uncertain second notification remain preserved without
manual binding, reset or replay. Each acceptance attempt used fresh work.

The final installed build demonstrated the complete path:

- Native call/result origin proof bound the exact source automatically.
- A read-only continuation check returned `await-notification`, with native owner
  evidence and the explicit `diagnosticOnly`/no-delivery-guarantee labels.
- The main completed its dispatch turn; a native metadata observation confirmed
  it was idle while the worker was still running.
- The worker completed once, with `active=null` and one generation. The broker
  created one notification and the existing native owner accepted one new turn.
- The awakened main called `claudex_status` for that exact task, returned its
  final nonce and `resultFinal=true`, and produced the real recipient Stop ACK.
  No manual input or acknowledgement was submitted for that completion turn.

This proves automatic completion wake for the reviewed installed Codex route,
not every runtime, policy, offline case or synchronization lifecycle. The earlier
Claude mod-self acceptance remains separate. Five-minute wait support is verified
at the Claudex MCP/Unix-RPC boundary with early-return and disconnect checks;
native hosts can still impose independent shorter tool deadlines. The full suite
passed 1,483 tests with 23 opt-in skips before the native source fixes; the final
affected origin/catalog/continuation/notification/Desktop-wake group passed all
66 tests. Packaged changed runtime files matched source and strict deep signature
verification passed. The installed app remains development-signed, not notarized.

## Historical 0.5.2 origin support and model diagnostics (2026-10-03)

The origin verifier now uses an exact stable primary native Claude transcript
without Desktop Local registry membership. Isolated integration tests exercise
the real MCP facade, private Unix RPC, hook subprocess, native-format transcript,
queue notification and synthetic recipient hook/ACK for both registry-free
CLI/SDK and managed Remote Control fixtures, including delayed native flush.
Desktop Local and Codex paths remain covered. Imported codec output, copied
ancestors, subagents, unsafe storage and replayed receipts remain refused.
These are source/protocol checks, not additional native model acceptance.
Remote-host-only and nonpersistent sources still require readable native
evidence; wake routing and recipient policy are unchanged.

Absent main-response model metadata is now `not-reported`, independent of task
status. Unix RPC tests cover completed Claude/Codex tasks without model IDs and
legacy `unverified` model labels normalized on read without rewriting history.
Actual execution uncertainty remains unchanged. The native inference acceptance
below predates this diagnostic label change.

The user subsequently authorized installation and push. A development-signed
app built from engine commit `1830397` was installed through the normal app
shutdown/resume lifecycle, retaining the previous bundle. All 117 packaged
engine/entrypoint/plugin files match the checkout and strict deep signature
verification passes. The resumed broker presents an existing completed task's
missing model evidence as `not-reported`; model/effort/permission preferences
are unchanged. No Claude restart or additional model inference was performed.
The companion remains 0.5.2. The existing 1,469-pass, zero-failure regression
result (23 opt-in skips) was reused; the final strengthened origin test passed
separately. This remains a development-signed, non-notarized installation.

## Historical 0.5 installed origin and notification acceptance (2026-10-03)

The user authorized local installation and minimal native inference. The signed
candidate was installed at the normal app path after owned services stopped and
native ownership checks drained; prior app and marketplace artifacts were kept.
The native plugin manager upgraded 0.4.1 to 0.5.0, preserving the plugin ID,
language store and saved nativeWake/selfWake=true overrides. The original broker
model/effort defaults were unchanged, and every canary explicitly used read-only.

The new Codex PostToolUse definition was reviewed through the official CLI
`/hooks` interface and trusted individually. The Desktop backend confirmed the
same exact definition hash as trusted; no bypass flag or trust-file edit was used.

Live acceptance found and repaired two fixture-hidden native contract defects:

- Claude creates owned canonical project directories with 0755 under ordinary
  umasks. Origin verification now accepts non-foreign-writable native directories
  while retaining 0600, no-follow, stable identity and single-link transcript
  checks. It does not chmod native files or loosen broker-private storage.
- Claude 2.1.286 PostToolUse supplies an MCP content array, whereas Codex supplies
  the MCP result envelope. The hook now recognizes the exact provider-specific
  single-text shape, with unchanged error/replay/ambiguity refusals. Updated
  real-shape integration fixtures reproduced the old refusal and pass after repair.

The first completed but unbound task was retained without manual binding or
replay. A new Claude Desktop Local canary then obtained native origin proof and
completed its Codex worker once with a matching nonce and structured done report.
A separate normal Codex CLI source obtained its own exact native proof, completed
one Claude worker and received the queue-only result through the next real hook.
Its native recipient read the exact result and emitted a genuine Stop ACK. Both
workers have active=null, one generation and confirmed absent recorded processes.
Claude's main response reported claude-opus-5-5 separately from requested opus;
Codex did not expose an actual model ID; its optional model evidence was labeled
`unverified` in that build (now presented as `not-reported` by current source).

The first wake notification expired while the receiver reported both opt-ins
false despite saved marketplace settings. Its task and receipt remain intact,
without fallback or replay. Installation and binding alone were not counted as
wake delivery.

The 0.5.1 diagnostic candidate passed 34 focused Node cases and all 17 official
native kit cases, with zero strict-validator errors/warnings. A fresh zero-model
Desktop Local session rendered its actual 0.5.1 cache root and registered boolean
false/false, while the same session's native settings API returned user-layer
boolean true/true and no flag/policy override. No secrets or unrelated settings
were displayed. Native artifact analysis and native-manager queries identified
the cause: Desktop injects installed plugins as SDK local plugins, whose storage
identity is claudex@inline, not claudex@claudex-local. The intended values were
saved to that inline identity through the supported native manager. The host
reported options changed/reloaded and both old and fresh observers reported
true/true. No default=true workaround, inbound-policy change, forced reload or
app restart was used.

A new final wake canary completed one Codex invocation, independently bound the
exact Claude source and generated one mod-self notification. The same loaded
source received the broker-authored peer message automatically, read the exact
task once, rendered the expected nonce and emitted a real Stop ACK. Private
mailbox evidence records a single claim, own-inbox submission, receive-once
authorization and acknowledged state. No manual notification or acknowledgement
was submitted. The final worker intentionally omitted structured reporting and
status correctly remained unreported rather than inferring done from prose.
The earlier expired message remained expired after receiver activation.

Version 0.5.2 retains this delivery path and adds both known configuration
identities to the bounded diagnostics, an explicit local /claudex response and
accurate bounded task counts. Its 35 focused Node cases and 17 official native
kit cases pass; the final delta does not alter authorization, routing or replay.
The final normal installation matched 117 app engine/entrypoint/plugin hashes
and all 22 installed Mod hashes; the app's nested strict signature passed.
The installed read-only inspection returned ready for all components after its
startup reconciliation. Actual 0.5.2 pixels/AX showed the native local command
response, two-row translated panel, active delivery waiter and Tasks 100 / 134.
On an empty native session's very first bootstrap command, the host briefly
retained its invalid-command banner while initialization completed; the pane
and local response still appeared, and the initialized command ran cleanly.
This initial native-host presentation quirk is not a failed model invocation.

### Handoff finding disposition

| Finding | Disposition and evidence boundary |
| --- | --- |
| F01 | Fixed: bounded native event/tool activity; real worker streams and synthetic liveness separation. |
| F02 | Fixed: native Claude response model evidence separate from requested alias/effort; absent model metadata is now not-reported, never execution uncertainty. |
| F03-F04 | Fixed: exact per-task wait reasons/blocker IDs; unrelated uncertainty and capacity covered in isolated contracts. |
| F05 | Fixed: typed codes survive actual Unix RPC and MCP error envelopes. |
| F06-F08 | Fixed: expiring per-session diagnosis, including reproduced unmapped targets; observations never grant dispatch authority. |
| F09 | Native acceptance covers the documented Codex and Desktop Local paths. Current source also has registry-free CLI/SDK and managed Remote Control protocol coverage; unreadable evidence remains explicit. |
| F10 | Reproduced and documented as a retained receipt-namespace boundary; no unsafe migration or replay-based origin binding. |
| F11-F12 | Implemented: fenced worker-self-reported outcomes and structured handoff context, independent of execution completion; report and unreported native cases verified. |
| F13 | Implemented: bounded multi-wait, filters/cursors and response-before-ack bounds; large escaped responses and blocker inventories covered. |
| F14 | Implemented: exact lifecycle/policy/capability/usage observations and safe option-source diagnostics, with native loaded-session evidence. |
| F15 | Updated AI-first workflow guidance; the human pane remains optional. |

## Historical 0.5 AI-first observation candidate (2026-10-03)

- 106 affected Mod Node tests passed, including real Unix RPC observation and
  typed-error ingress, per-session expiry/end/disconnect/restart behavior,
  unmapped target diagnosis and unchanged hook/claim/receive/ACK boundaries.
- All 22 final staged hashes match. The independent packaged transport import
  and helper doctor work without source-checkout dependencies; both wake opt-ins
  remain false in this candidate. It was not installed or activated.
- Desktop Code 2.1.286 strict validation has zero errors and warnings. Initial
  kit launches were refused by the vendor rollout; a later normal kit process
  became available without any rollout override or app restart. Its own-inbox
  case correctly could not deliver against the default-disabled shipping stage.
  A separate never-installed test stage with both required opt-ins enabled passed
  all 16 cases, including the new lifecycle observer case. The quickstart now
  distinguishes those configurations. No new Desktop painting, policy or model
  inference acceptance is claimed.
- The signed app candidate packages all new broker modules through its normal
  allowlist; 109 engine/plugin hashes and nested strict signatures were checked.
  It is development-signed, not notarized, and does not replace the installed app.
- The broker now implements default-off origin binding and notifications after
  read-only native-pair feasibility checks. Four integrated synthetic cases cover
  both providers with immediate and delayed native result flush: real MCP facade,
  private RPC, random start receipt, production verifier, actual hook subprocess,
  synthetic worker completion and one exact-origin queue-only notification.
  Replay does not start a second invocation or send a second notification.
- Separate regressions cover missing proof, worker denial, late verification,
  lost notification response, restart, absolute expiry across async discovery,
  native pre-dispatch shutdown fences, app-stop release and bounded storms.
  New PostToolUse trust remains separate from the legacy synchronization gates.
  These tests do not certify fresh native nonce-to-notification delivery; no new
  model inference, live hook installation or recipient wake was performed.
- Final repository regression: 1,479 cases, 1,456 passed, zero failed and 23
  existing opt-in skips. The final P4 package passed strict native validation
  without errors/warnings and imported its packaged broker, origin verifier and
  standalone Mod transport without source-checkout dependencies.
- A subsequent narrow diagnostic correction preserves an unavailable native tool
  inventory as unknown instead of claiming SendMessage is absent; 35 related
  tests passed and the updated seven observation cases passed. No dispatch policy
  or permissions changed, and the valid full-suite evidence is retained.

### Read-only Codex origin-path probe

On the configured existing Codex 0.159.0-alpha.12.1 listener, a real
`claudex-work/claudex_list` call issued through code mode was read back through
bounded `thread/items/list`. Its completed `mcpToolCall` retained the exact
server/tool, empty arguments, native call ID and turn ID; the saved result
content exactly matched the actual MCP response. No new model invocation,
thread resume, hook installation or native-store write was involved.

This establishes the availability of an independent native call/result read
path for this Codex runtime, including nested code-mode calls. It does not yet
validate a fresh start receipt challenge, PostToolUse-to-task binding, Claude
provenance, automatic notification or recipient wake. Those gates remain open;
do not infer an origin from a supplied session ID or upgrade the read-only probe
to end-to-end notification acceptance.

### Read-only Claude origin-path probe

An exact native Desktop registry mapping identified one existing primary Claude
session. A stable no-follow transcript snapshot contained a unique native
`claudex_chat_send` call/result pair: matching tool-use ID, session/cwd,
non-sidechain records, source assistant UUID and parent chain. The result matched
the persisted mailbox receipt and message, including request identity, sender,
target, payload and timestamps. This was a historical 2.1.281 call reverified
read-only, not a new runtime invocation or a start-challenge acceptance.

Together these probes justify independent stored call/result verification for
the two provider paths. The production verifier still requires exact
`claudex_start` identity, the original arguments fingerprint and full one-use
receipt. The complete new live flow and optional-hook native trust remain
unverified until separately authorized acceptance.

## Historical 0.4 panel and localization acceptance (2026-10-03)

- The package provides 170 English-keyed strings in all nine app languages,
  grouped panel summaries, wrapping navigation and collapsed technical details.
  Native IDs, protocol bodies and unknown diagnostics remain verbatim.
- 73 affected Node cases passed: controller/bridge/RPC contracts (55), and
  localization/staging/packaged-engine contracts (18). Catalog validation rejects
  missing language columns and changed placeholders before staging.
- Desktop Code 2.1.286 strict validation passed with no warnings. Its official
  native kit passed all 15 cases, including all nine locales on terminal/Desktop
  trees, unsubmitted form retention, complete preview retention across language
  changes, and the unchanged self-inbox receive fences. A first added test used
  a store accessor absent from the test harness; that assertion was removed,
  leaving persistence covered through the dedicated host-adapter unit test.
- Earlier kit launches reported vendor rollout disabled, without an environment
  override. After normal Desktop restart/resume, the normal kit command became
  available. This was not a companion version gate or a synchronization-policy
  change. The final 0.4.1 differs from the passing candidate only in package
  version and README heading; runtime and test bytes are unchanged.
- Normal native marketplace/update commands installed 0.4.1. All 19 staged-file
  hashes match the installed package, including the corrected native fixture.
  Existing opt-ins and the broker's mod-self route were retained.
- Actual Desktop pixels showed Traditional Chinese selected from macOS system
  preferences, all five navigation controls fitting two rows, readable broker,
  work and runtime sections, and collapsed diagnostics. The broker inventory
  responded. These pixels do not certify mouse interaction with every control;
  native test-kit callbacks establish the multilingual switching contract.
- During UI automation, a duplicated reload command was mistakenly submitted as
  plain chat text and produced one short model reply, with no tools or workspace
  edits. It was disclosed and retained in the original test history. Subsequent
  correctly formed slash commands used native command handling. No history or
  uncertain message record was erased to clean up the acceptance transcript.

## Historical 0.3.1 single-session own-inbox evidence

| Check | Observed result | Evidence boundary |
| --- | --- | --- |
| Full repository regression | 1,325 passed, zero failures, 23 existing opt-in skips; 1,348 total, before the final narrow queued-hook exclusion | Final hook-fence delta uses affected mailbox/Mod regression; synthetic tests never start inference |
| Own-inbox transport | 16 focused cases pass | Includes exact parent/socket checks, Darwin listener plus accepted FD, timeout drainage and no retry |
| Broker/bridge/pump integration | 15 focused cases pass after the real RPC and queued-hook repairs | Includes actual private Unix RPC; synthetic model/native delivery |
| Final queued-hook fence regression | All 54 affected mailbox, own-inbox and prior Mod-route tests passed | The one-line final backend delta preserves Stop ACK and old routes; no additional model calls |
| Final native validator and kit | 0.3.1 strict validation and all 12 official native cases passed in a fresh normal process | Earlier isolated processes reported rollout disabled; none was overridden, and process-specific availability is not account-wide proof |
| Installed plugin assets | All 16 installed plugin assets match the final 0.3.1 stage | Artifact equality, separate from native display and delivery evidence |
| Final bundle verification | Installed Claudex and Claude app deep signature verification passed; Claude app.asar remained unchanged | Traditional Chinese Claude bundle retained; not notarization or public release |
| Installed 0.3.1 automatic delivery | After normal Claude restart, one Claude Code process and one eligible `mod-self` waiter remained; source and target were the same exact native session | Actual Desktop-owned listener, not a second sender, command-driven dispatch or synthetic broker |
| Recipient result | A newly authorized Sonnet 5.5 canary replied with the requested nonce and actual Stop ACK in 4.253 seconds | Exact claim, `submitted`, receive-once timestamp, reply and ACK inspected independently |
| Actual Desktop display | Native accessibility inspection after normal UI refresh showed peer framing, requested reply and Stop ACK; the original unsent draft remained unchanged | Actual rendered session and composer evidence, not only transcript/source checks |
| Native explicit refusal | Isolated Desktop-binary 2.1.286 session with `tools: []` and per-invocation `crossSessionInbound: refuse` received one production-transport write; native logs explicitly refused it before receive-hook delivery | Zero assistant turns and zero model turns; no global setting edit |
| Native explicit hold | Equivalent isolated session with `crossSessionInbound: hold` retained one message with `cause=explicit-setting`, then expired it at normal shutdown | Zero model turns; native hold was not released or bypassed |
| Native receive shape | Hold probe observed `origin.kind=peer`, no agent ID, and the exact routing prefix followed by JSON at `session.receive` | Observed 2.1.286 wire behavior, not a permanent public wire-format guarantee |
| Earlier failed delivery preservation | The earlier 0.3.0 claimed message remains `submitted` without receive authorization or ACK and was not resent | Success used a distinct newly authorized message; no reset, migration or replay of uncertain evidence |
| Final broker restart/no replay | Owned services were verified stopped and resumed normally; mod-self persisted, one waiter reconnected and the same single Claude Code process remained. Successful nonce appeared once, earlier undelivered nonce zero times, and the outbox had no pending receipt | Actual restart evidence; draft never became a submitted prompt; no claim reset or retransmission |

The documented native own-child inbox is distinct from `session.send`, which
explicitly refused self-addressing in the native probe, and from `prompt.submit`,
which is not used. This route is macOS-only. The helper verifies the native
parent's PID, birth identity and UID and its exact private socket. The per-session
token stays in inherited environment and the in-memory auth line: never in argv,
receipts or logs. Native kernel peer evidence can be unavailable after a fast
child exits; the documented own-session token supplies the native own-child
authentication in that case. Explicit inbound hold/refuse remains authoritative.

There is no native delivery ACK on the socket. `submitted` means the bounded write
completed, not that the model read it. Durable one-dispatch and receive-once
records prevent duplicate helpers and duplicate envelopes from replaying work.
Only the real recipient Stop hook records receipt. Neither that receipt nor a
socket write proves completion of arbitrary requested work.

### Failures reproduced and repaired

- Darwin `lsof` lists the listener and its accepted connection under the same
  socket pathname. Requiring exactly one matching FD falsely rejected a valid
  connected parent. The repair accepts one or more exact-parent/exact-path FDs
  while preserving independent socket ownership, type, path and identity checks.
- The private collaboration transport allowlist initially omitted
  `mod_wake_receive`. A live 0.3.0 socket write succeeded, but receive validation
  failed before reaching the broker. A real private-RPC regression reproduced
  `Invalid collaboration request`, then passed after the method was added. Tests
  that called the hub directly could not expose that transport boundary.
- Duplicate receive authorization and concurrent helper dispatch were fenced by
  durable one-use records. Route/shutdown is checked again after the awaited
  receive transaction. Synthetic tests cover each fence and restart behavior.
- Final safety review reproduced ordinary SessionStart/UserPromptSubmit/Stop
  hooks consuming queued mod-self messages, which could bypass native hold/refuse.
  A failing regression became green after excluding only that route from hook
  offer selection. Real Stop ACK scanning, queue-only messages and older routes
  retain their behavior. This backend-only delta does not change the validated
  native plugin assets or require replaying the live canary.

No native-store edits, fabricated ACKs, held-message approvals or hidden replay
were used. New-runtime synchronization acceptance, arbitrary pane-button flows,
Linux/Windows own-inbox delivery and closed-session automatic startup are outside
this evidence. Busy-delivery evidence below belongs to the older cross-session
route, not a new certification of every own-inbox busy-session case.
Collaboration remains ready. A post-upgrade renderer-maintenance inspection
reported `cache-entry-missing`; the own-inbox path does not use that renderer
adapter. Existing unfinished-tool synchronization and predecessor-archival waits
also remain separate from the completed own-inbox acceptance. This is not an
all-components-healthy claim.

## Historical 0.2.3 cross-session automatic-route evidence

| Check | Observed result | Evidence boundary |
| --- | --- | --- |
| Focused delivery/controller/bridge regression | 72 passed, no failures | Includes await-boundary lifecycle and authorization regressions; no inference |
| Actual Desktop Code 2.1.286 strict validator and native kit | Strict validation and 9 cases passed again | Earlier rollout-off refusal not reproduced; no vendor flag override |
| 0.2.2 local installation | Development-signed Claudex app installed with previous app backed up; native manager updated plugin 0.1.1 to 0.2.2 | Not notarization or public release |
| Configuration | Native manager saved nativeWake=true; matching installed broker uses route=mod | New wake-enabled messages capture that route |
| Automatic native delivery | Untouched listener in an SDK-owned sender claimed and called real session.send without a sender prompt/model input | Not manual acceptWake or Inbox-button acceptance |
| Recipient completion | Native queue accepted; Sonnet 5.5 returned the requested nonce and real Stop hook ACK in about 4.2 seconds | Exact source, claim and completed outbox receipt matched separately |
| Busy recipient | Second native send accepted before the first message's ACK; both replies and ACKs observed separately | Native queue controls timing; acceptance alone is not completion |
| Offline recipient | Native API returned false, recorded rejected; reopening the recipient did not replay it | One observed refusal mode, not every inbound policy variant |
| Desktop activation | Normal authorized Claude restart; 0.2.2 pane shows Engine 2.1.286, nativeWakeEnabled=true, waiting-for-authorized-message and real broker limits | Actual Desktop accessibility evidence and helper response |
| Draft preservation | Native screenshot shows the busy-delivery reply/ACK and the exact unsubmitted draft retained | Observed native composer behavior, not only a synthetic API contract |
| Translation and bundle preservation | Claude app.asar hash unchanged and signature verified after restart | Traditional Chinese application retained; Claude app was not replaced |
| Final 0.2.3 validation/installation | Strict native validator and 9 kit cases passed; 15 installed plugin assets match stage; installed broker, delivery, registration and manifest hashes match the repository and deep signature passes | Final executable artifact evidence; the packaged README predates this final documentation update |
| Final Desktop-owned delivery | After normal broker stop/start and Claude restarts, two Desktop-owned listeners remained; a new exact-recipient Sonnet 5.5 reply and real Stop ACK completed in 4.276 seconds | One reply, matching claim/outcome, no pending outbox; SDK sender had exited normally |
| Restart/no replay | nativeWake=true and route=mod persisted; earlier offline rejection remained unchanged with no native replay | Normal restart evidence, not injected loss during an in-flight native call |
| Final pane layout | Actual 0.2.3 screenshot shows all five tabs in two rows, Engine 2.1.286, nativeWakeEnabled=true and accepted outcome for the final message | Real painting; not every button-flow acceptance |

No direct native-store edits, fabricated ACKs, claim reset or replay were used.
That cross-session `mod` route requires another eligible loaded sender; the
new explicit `mod-self` route removes that dependency. Pending-receipt fault recovery remains synthetic coverage; a normal
restart with no pending outbox is not proof of every interrupted-send case. The
temporary upgrade-time folder-cache diagnostic cleared through normal maintenance.
Final read-only inspection shows collaboration, folders and renderer adapters ready,
with no active or uncertain managed collaboration tasks. Synchronization still
reports an unfinished-tool handoff pause and normal predecessor-archival lifecycle
wait; these separate guards were not altered or waived by Mod acceptance.
Pane-origin model delegation and new synchronization-runtime compatibility are
also outside this evidence.

## Historical 0.2 reproduced repairs

Version 0.2.1 added two malformed-reply regressions: dispatch requires literal
ready:true and receipt publication must confirm the exact message, claim, source,
recipient, route and outcome. Both failed before their fixes; the affected suite
then passed 69 cases. Its full regression passed 1,292 tests with zero failures
and 23 existing opt-in skips. Unchanged regression evidence is reused.

Version 0.2.2 added three cases around revocation during awaited native reads.
The lifecycle and readiness failures were reproduced before repair. Context is
rechecked after awaited helpers; broker claim/readiness rechecks route, shutdown,
claim outcome and expiry after metadata verification. This prevents stale
readiness or dispatch after clear/end. All 72 affected tests passed.

Real 0.2.2 Desktop inspection found that a single five-tab row clipped Inbox in
a normal narrow pane. Version 0.2.3 uses two rows of native Box elements, preserving
the existing controls and avoiding unsupported layout properties. Final native
pixels verify the repaired layout; unreliable accessibility-control frames were
not treated as proof of a product failure or of every button interaction.

Earlier integration repairs retained their tests: Darwin socket fixture length,
module-top-level $ helpers, intrinsic $.plugin.root property access, complete
native callback coverage, clear/end redraw, source-parent symlink rejection and
strict manifest attribution. Automated tests never start model inference.

## Native capability boundaries and historical availability observations

Claude Code 2.1.287 is the documented public Mod baseline, not a load gate.
The installed Desktop Code 2.1.286 actually validates and runs this companion.
Earlier CLI test processes on 2.1.286 and 2.1.287 reported the rollout switch off;
that applied to those processes, not every loaded Desktop session. Later isolated
native kit processes also reported rollout disabled while the installed Desktop
successfully ran 0.3.1. No override was introduced. Neither observation establishes
account-wide availability.

Hooks cover session.start, classic.SessionStart, session.end, session.receive,
turn.complete, command.run and ui.render. Calls include command.register, env.get, process.run,
prompt.fill, session.cwd/id/send/usage/version, settings.read, store.get/set, tool.list, clock.after and
ui.invalidate/open/resolve. The only environment read is the managed-worker marker.
plugin.root and plugin.name are intrinsic metadata. Timers drive bounded broker waits/reconnection,
not conversation-history sweeps. No prompt submission, permission approval or
new sender model process is introduced. Recipient delivery can trigger authorized
model work and consume account allowance.

The native kit stubs external operations; passing its tree/callback cases is not
Desktop painting or delivery evidence. The validator does not transitively audit
the child helper. The helper's private file/RPC effects retain source-level and
Node contract coverage. Declared session.send capability exists even with the
default nativeWake=false; that flag gates use, not trust granted to installed code.
Own-inbox delivery additionally requires selfWake; its native socket and token
are inherited by the helper without exposure to the Mod's public result.

## Historical manual acceptance

The earlier 0.1.1 test used a temporary native command invoking the unchanged
production controller's wakeList/previewWake/acceptWake, installed helper and real
broker. It verified actual queue acceptance, a Sonnet 5.5 reply and recipient Stop
ACK, but was not automatic-listener or mouse-driven Inbox acceptance. Its sender
test command performed zero model turns. Untitled imported recipients were refused;
native SDK-created titled recipients passed exact metadata checks.

A distinct all-tools-removed sender attempt returned false because SendMessage
was unavailable. The old controller retained that offered/uncertain evidence;
it was never reset or replayed. The successful case used a new message. Later
versions preflight SendMessage and classify explicit false as rejected.

At that stage nativeWake was restored to false and installed 0.1.1 remained in use.
The current authorized automatic deployment supersedes that snapshot. Prior
/reload-plugins success did not always replace an existing session's module;
verify the actual pane after a supported lifecycle boundary, never rewrite an
old cache to force loading.

Follow [the guide](claude-mod.md), [handoff](claude-mod-handoff.md) and
[acceptance checklist](claude-mod-acceptance.md). Development signing is not a
notarized public release; native Mod acceptance does not change synchronization
allowlists, ownership guards, existing holds or other Desktop adapters.

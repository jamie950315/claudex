# Historical acceptance evidence

Records of past authorized acceptance runs, moved out of the topic guides.
They describe what was verified on the versions named, not current rules or
current installation state. Read this only when a task asks what was verified.
Never extend a result to another version, route or runtime, and never replay
or reset the preserved failed or uncertain records mentioned here.

## Persisted Codex realtime voice transcripts (2026-10-23)

Development-signed App 2.0.16 / Mod 0.8.74 (`5aaba5b`) reconstructed a closed
voice source through two complete API reads and stable rollout evidence. Six
speaker transcript segments, two unchanged API handoffs and all selected native
session/lifecycle metadata produced 20 canonical messages, without creating an
agentMessage or final response. Normal app-managed enrollment and delivery
verified identical 20-message Codex/Claude checkpoints with no pending operation.
The installed GUI no longer showed the missing-final-response warning; its normal
background startup reconciliation was still proceeding at 563/571, with no
tracked-conversation blocks. Native apps were not restarted and no model prompt
or input replay was used. Bundled, installed and freshly observed Mod were 0.8.74.

Enrollment-scoped `realtimeHistory: "transcript-v1"` preserves earlier API-based
representations. Two real previously tracked voice records retained their exact
4- and 540-message checkpoints, including their original relocation records.
New enrollment retained its 20-message checkpoint after Runtime restart.
The sync suite passed 206 tests with one ignored; final cold-policy changes
passed ten scoped tests, voice checks twelve and Mod host checks 45. The remaining
workspace checks passed 216 tests in aggregate; one existing shared-source renderer
test timed out in the parallel run and passed its isolated exact rerun.
Private audit limits, raw snapshots and recovery bundles stay outside Git.

## Interrupted Codex image-turn read boundary (2026-10-23)

Development-signed App 2.0.15 / Mod 0.8.73 (`4545004`) read an interrupted
image turn containing user steering, reasoning, commands and assistant activity
despite its missing raw closing event. Two complete API passes agreed on the
interruption and completed successor; all API items were preserved, five images
were recovered and the prior 501-message checkpoint matched. Normal installed
synchronization then verified identical 721-message checkpoints on both sides,
with no pending transaction. The startup sweep checked 552/552 conversations
with no tracked-conversation blocks. Native apps were not restarted, model
requests were not made and no input was replayed.

The sync crate passed 192 tests, the rest of the workspace 216, the final
provenance checks 16 and the Mod host checks 45. A separate read-only full-API
image audit accepted six stable histories with seven image items; one active
source was unavailable. Two documented late-item ownership refusals remained
stable across both passes. The audit harness was updated to recognize its
existing cross-thread-fork refusal, without changing that runtime guard.

At that checkpoint, one independently discovered voice-only source was unimported: its full API
has two completed, error-free user-only handoff turns, while assistant replies
exist only in realtime transcript segments. That separate format limitation
remained visible; the synchronized image conversation was not blocked by it.
Bundled and installed Mod 0.8.73 were verified; existing loaded sessions were
preserved rather than restarted to obtain a fresh observer.

## Persisted Claude refusal import (2026-10-20)

Installed development-signed App 2.0.6 / Mod 0.8.64 (`c68d493`) recognized
one previously unenrolled Claude Code conversation whose only completed reply
ended with `stop_reason: refusal` and persisted text. Normal startup discovery
and synchronization created a Codex snapshot with the same 284-message canonical
checkpoint. Native Codex chat readback contained the safety notice, refusal text,
readable excerpts and authenticated complete-history archive. The native app
navigation succeeded, and the user confirmed that the chat was visible.
The later input and empty-reasoning refusal remained an incomplete tail.
No model request, refused-input replay or native-app restart was performed.

Read-only differential checks used identical stable snapshots of 818 Claude
and 1,788 Codex files. All previously accepted histories stayed unchanged:
224 Claude and 438 Codex. Only the target became newly accepted; 593 Claude
and 1,350 Codex files remained refused by the selected unkeyed audit readers.
There were no audit exclusions or accepted-prefix regressions. The sync library
passed 166 tests with one ignored; the CLI help/version test and signed release
build passed. App-owned installation verified Mod 0.8.64; existing loaded sessions
were preserved. Another unenrolled source still had an unfinished tool call.
Private identities, audit results and rollback bundles remain outside Git.

## Native-scheduler preservation assessment and Desktop acceptance (2026-10-17)

An authorized Claude Desktop Code test on native 2.1.299 created one
session-only, non-recurring Cron task through the normal composer and native
tools. The task enqueued its prompt 29.590 seconds after creation and completed
in the same session with the exact requested marker. The actual response model
was `claude-haiku-5-5`; medium remained configured. Its native usage was four
uncached input tokens, 102,114 cache reads, 434 cache writes and 32 output
tokens, with `end_turn` and no tools on the scheduled response. Cache reads
covered the preceding response's complete 102,114-token read/write prefix;
the read share was 99.57%. Computer Use inspected both the rendered marker and
the final `CronList` result, `No scheduled jobs.` The one-shot task had
auto-deleted. No Claudex warmer was enabled or native app restarted; the
existing model, session TTL, empty final draft and fullscreen were preserved.

The first setup model chose a past clock time from stale context. That test
job was cancelled through native `CronDelete`, not replayed or treated as a
successful firing. The corrected setup specified the next cron minute without
model clock arithmetic. The full Desktop check used twelve deduplicated model
requests: nine setup requests, one scheduled request and two final readback
requests. Setup also used native turn-bookkeeping tools; the scheduled response
used none. Private histories and exact task identities remain outside Git.

The conditional replacement assessment did not pass, so no runtime or installed
App was changed. Shipping Codex Desktop analysis found that busy deferral can
dispatch after recurrence `UNTIL`, and an optional pre-model hook cannot provide
fail-closed budget or stop admission. Claude Code 2.1.302 artifact analysis found
that Cron jobs lack Mod-lifetime ownership and a final dispatch deadline; minute
granularity and computed-minute 00/30 early jitter also cannot preserve the
existing four-minute refresh gates for every five-minute cache window. These
negative cases are source/path analysis, not deliberately induced live excess
requests. The actual Desktop firing above used 2.1.299, not 2.1.302. Existing
broker admission and Claude's native Mod `$.clock.after` remain in use.

## Installed Rust Codex warm-command repair (2026-10-17)

The development-signed App 1.4.8 / Mod 0.8.46 installation packages the
`1b9ff3e` broker-root repair and `f009929` payload version. The previously
failing installed hook was reproduced against exact active native metadata.
After normal service drain, bundle replacement and app-owned Mod maintenance,
the same existing Codex conversation completed one local off control; its exact
durable turn was completed and its broker policy was disabled. A separately
subscribed, trusted native status hook returned the localized disabled/stopped
summary with blocked interception and a completed turn on
`0.162.0-alpha.17.2`. Neither control produced model/tool items or a warm attempt.
The first off observer lacked a resume subscription; exact durable readback
resolved the missing notifications without replaying off. Codex pixel capture
remained unavailable. Bundled, installed and fresh observer versions were
0.8.46; native apps were not restarted. Twelve focused Rust tests passed.
The services resumed healthy while normal initial reconciliation continued;
this is not a new full-history or cache-retention acceptance claim.

## Installed Claude local warming controls (2026-10-17)

With Mod 0.8.46 installed and freshly observed loaded, an existing Claude
Desktop Code session completed native `status`, `off`, then `status` commands.
Computer Use inspected the rendered local replies: disabled, TTL 1h, zero warm
requests and stopped next warming. No ENOENT appeared and no warming was enabled.
The Claude companion already resolved the collaboration child correctly; this
check required no runtime repair. Native apps were not restarted.

## Installed Rust synchronization and Local archival repair (2026-10-17)

The development-signed Mac installation at `bb8aa1c` (App 1.4.8 / Mod 0.8.45)
used the normal service drain, signed-bundle replacement, app-owned Mod update
and idle Claude restart. Both user-selected existing conversations passed full
normal Runtime adapter reads on Codex and Claude: complete portable canonical
histories matched, including image blocks, with no incomplete tail. Later
metadata checks confirmed unchanged checkpoints. These were read-only
acceptance checks; no new model input was submitted.

The native sidebar first exposed two independent consumer defects: state grouping
unmounted a project-only subscription, and presentation filters or loaded pages
hid otherwise valid replacements. The installed consumer retains one Code-only
subscription and uses the existing native exact-ID no-store metadata reader,
normalizer and bridge classifier with the native account/cloud-access getters.
Three previously unarchived, unstarred Local predecessors then completed the
normal native archive API and were independently observed archived. The starred
predecessor remained unarchived. Complete saved byte prefixes of all fifteen
protected original histories (155,783,256 bytes) still matched after archival.
Native registry files, transcripts and ledgers were not manually repaired.

The actual consuming graph was `index-BOnos2uv.js`; source preparation preserved
its native AST and wiring, and live renderer diagnostics showed metadata reads,
dispatch and verified native archive outcomes. The fresh loaded Mod reported
0.8.45. Services stayed in one healthy generation with no worker restart.
The remaining watcher hold at observation time named the still-executing repair
thread, not either accepted target. Private histories, exact identities, native
flags, preservation proofs and rollback artifacts remain outside Git. This
installation is not a notarized or published release.

## Rust runtime follow-up (2026-10-16)

Authorized native synchronization acceptance used a dedicated two-message
synthetic genesis, real NativeAdapter plan/apply and signed archive packets,
then three real model turns: Claude -> Codex -> the same Claude owner, followed
by a final managed Codex snapshot. The recall prompts did not repeat the seed
values; both models recalled them and the preceding model's marker, ending
with the exact requested roundtrip result. All three turns used no tools.
The current native histories both matched the complete ten-message committed
canonical checkpoint, with no incomplete tail or pending transaction. Normal
owner close/reopen retained the Claude native and Remote Control identities;
the harness drained and exited 0. Claude responses reported `claude-opus-5-5`,
and the Codex turn's native context reported `gpt-6.1-sol`. Native versions were
Codex `0.162.0-alpha.17.2` and Claude Code `2.1.283`; the Rust owner used the
native stream-json/control protocol, not the JavaScript Agent SDK package.

The final reply was observed in the installed Claude Desktop accessibility
tree under the same Remote Control URL. Computer Use denied Codex UI access,
and Claude pixel capture remained stale, so neither Codex GUI rendering nor
pixel-level rendering or GUI prompt submission was established. Native model
dispatch used the native protocol and existing verified shared backend. This used
an explicitly composed private Runtime, not CLI enrollment, an installed Rust
launcher activation or app-tools authorization. Existing apps and services were
not replaced or restarted; private histories and receipts remain outside Git.

Authorized real-model collaboration acceptance used the release runtime at
`e7bdaf0`, an independent broker and an empty read-only workspace, with
notifications off and no model or effort overrides. Five native invocations
verified Codex-to-Claude child delegation and result acknowledgement,
Claude-to-Codex child delegation and result acknowledgement, and two consecutive
handoffs under one logical task ID (`Codex -> Claude -> Codex`, generations
1, 2 and 3). Exact canary results and the final combined result matched;
ownership transferred only after successful native completion and process exit.
All five native process groups exited and the broker drained with exit 0.
The runtimes were Codex CLI `0.162.0-alpha.17.2` and Claude Code `2.1.283`.
Claude main responses reported `claude-opus-5-5`; Codex main-response model
metadata was not reported. This establishes the tested read-only work protocol,
not Desktop synchronization, writable delegation or completion-wake delivery.

A fixed `e7bdaf0` JavaScript reference and Rust release comparison on one
Apple M5 Pro Mac used alternating paired samples and identical history inputs
with equal portable messages and canonical fingerprints. CLI help/status
medians improved from 62-67 ms to 5.4-6.5 ms (30 pairs per workload); six
decode/portable/fingerprint workloads improved 1.88-3.68 times (12 pairs each).
Large Claude processing was 90.59 -> 24.61 ms, with process peak RSS
508.85 -> 80.19 MiB; large Codex processing was 90.06 -> 27.43 ms,
481.42 -> 138.18 MiB. The Codex fixtures were large-payload two-message
snapshots, not long multi-turn Desktop pipelines. Normal empty-broker list RPC
medians regressed from 0.0884 to 0.1539 ms/request, while idle resident memory
fell from 72.20 to 11.63 MiB. The Rust RPC included additional renderer
publication diagnostics, so that comparison did not have identical complete
responses or proven equal work. These are bounded CPU/latency/process-memory
measurements on a shared-use machine, not model-response, whole-app or battery
measurements. Private inputs and raw records remain outside the repository.


## From cache-warming.md

Authorized native-scheduler evaluation (2026-10-17) tested alternatives without
enabling the Claudex warmer or replacing its implementation. A native Codex
Desktop heartbeat, created through the official automation tool and addressed
to an existing dedicated test thread, fired after 64.6 seconds in that same
thread. Its exact marker reply completed without tools, with 49,581 input,
48,384 cached-input and 12 output tokens. The configured model/effort remained
`gpt-6.1-sol` / `xhigh`; independent response-model identity was not reported.
The native history contained the matching heartbeat envelope. The official
delete action then removed the test automation.

Separately, Claude Code 2.1.299 in a dedicated interactive CLI session used
native `CronList` and `CronCreate` to create one session-only, non-recurring
task. It fired at the reported minute in the same session, returning the exact
marker with actual model `claude-opus-5-5`, four uncached input tokens, 6,013
cache reads, 317 cache writes and 29 output tokens, with no tools on the
scheduled request. Those reads covered the preceding request's 6,013-token
read/write prefix. Creating the task used three model requests; its scheduled
fire used one. The one-shot task was self-deleting and the owned idle CLI
exited normally afterward. No persistent Claude schedule was created.
Claude Desktop input did not arrive during this evaluation, so its same-session
scheduler was not tested; its empty draft and fullscreen state were restored.
These runs establish native same-context scheduling and actual cache reuse,
not multi-cycle retention, busy/restart behavior, or parity with Claudex's
budgets and stop policies. Private receipts and native identities remain outside
the repository.

Authorized installed Rust acceptance (2026-10-17, App 1.4.8 / Mod 0.8.46)
used dedicated native test conversations and the existing signed native hosts:

- Claude Desktop Code returned the exact ordinary acceptance marker, followed
  by an autonomous prime and a periodic request 240.199 seconds later. All
  three actual responses reported `claude-opus-5-5`; medium was configured.
  Prime read 82,218 cached tokens and wrote 480; the periodic request read
  82,698 (the complete required preceding prefix), wrote 107 and used four
  uncached input tokens, with four output tokens on each warm request.
  Native usage and the rendered Desktop replies agreed. Warming was stopped
  after two requests and the session-only TTL restored from 5m to its original
  1h without enabling another request or changing global preferences.
- Codex Desktop 0.162.0-alpha.17.2 completed an autonomous prime and a periodic
  request 60 seconds later, then an ordinary exact-marker reply after off.
  Configured model/effort remained `gpt-6.1-sol` / `xhigh`; the native protocol
  did not independently report response-model identity. Prime input/read/output
  was 45,995/33,408/19; periodic was 46,869/45,824/5. The periodic read share was
  97.77%, but it was 171 tokens short of the preceding complete input, so the
  ledger correctly retained `cacheVerified=false` / `native-cache-refreshed`.
  Exact starts, completions, usage and native history readback were observed;
  none of these model turns used tools. Both test schedules ended without a
  remaining timer or Codex binding. Codex GUI pixels remained unavailable.

This run found a terminal diagnostic defect: normal Codex limit completion was
overwritten with `native-binding-changed` during observer detach. Repair
`b630ed6` preserves the count/duration/output limit before normal detach while
retaining due compaction. Five unit and three native-transport tests passed,
including the previously failing native-prime regression and no uncertain
dispatch replay. Normal guarded installation of `e37f8a9` (Mod 0.8.47) then
completed one additional real Codex prime, with input/read/output
48,607/47,488/5 and an `OK` reply. It automatically ended disabled with both
reasons `refresh-limit`, zero bindings, no next request and an idle native
thread. The official Claude plugin reload and a local status command verified
loaded Mod 0.8.47, warming off and TTL 1h without another model request. Native
apps were not restarted. This proves the measured replies, scheduling, cache
reads and repaired limit stop, not cache retention beyond TTL or a speedup.
Private native identities, histories, receipts and rollback artifacts stay
outside the repository.

Authorized autonomous-start acceptance (2026-10-15, App 1.4.8 / Mod 0.8.31)
used independent test conversations, with no ordinary seed or follow-up message:

- Claude Code 2.1.295, Sonnet 5.5/medium, isolated staged Mod and real Unix
  broker: local `/claudex:warm on 5m rounds=2 compact=off` automatically produced
  a verified prime (11,819 cache-write tokens, zero cache reads, 4 output tokens),
  then a verified periodic request about four minutes later (11,803 cache reads,
  120 writes, 4 output tokens). Exactly two native responses, one session, no
  retries or native errors, refresh-limit stop, local off, and owned-process
  exit were verified. The process-only function-hooks opt-in was explicitly
  authorized; no global policy was changed.
- Installed Codex Desktop 0.162.0-alpha.17.2, GPT-6.1 Sol/xhigh: the trusted native
  hook intercepted literal `/claudex:warm on rounds=2 compact=off` without model
  activity. The existing Desktop owner then completed one autonomous prime with
  an `OK` reply, no tools, 31,842 input tokens, zero cached tokens and 22 output
  tokens. The broker verified that exact native completion and scheduled the
  next request at its start plus 25 minutes. Literal off completed locally and
  left no timer. Only this one automatic model turn was run; the 25-minute
  follow-up was scheduled, not awaited.

These runs establish no-extra-message enrollment and autonomous scheduling, not
cache retention beyond a provider's TTL. The normal signed-app Quit/reopen
upgrade installed 1.4.8 and app-managed Mod 0.8.31; existing Claude sessions were
not restarted and can retain their older loaded Mod until a normal reload.

Authorized Desktop 0.160.0 backend acceptance after native trust verified seven blocked local command turns (status/on/confirm/off), native hook-time primary/turn checks, structured output and no token-usage events or assistant/tool history items. The test policy ended disabled/unbound with zero refresh attempts and no timer.

Authorized 1.2.6 native acceptance verified a 25-minute same-owner OK refresh (36,096 cached input / 5 output tokens), exact accounting and the one-refresh limit. At about 31 minutes both warmed and untouched controls still hit; retain the inconclusive extension result, not a guaranteed native TTL claim. Detailed version-scoped evidence is in docs/claude-mod-validation.md.

Authorized 1.4.2 native acceptance (Claude Code 2.1.295, Sonnet 5.5 medium, staged Mod 0.8.24, isolated root, `dev/cache-warm-probe/native.mjs --run --compact --native-context`) verified one warm request under the prior-read rule (read 34,261, prior read 29,858, required prefix 34,310), compaction authorized 144 ms after its due time and 240 seconds after the warm request started, one `compact_boundary` with trigger `manual` (34,422 to 1,728 tokens, 6.7 seconds), the policy ending `compacted` with one refresh, and a normal reply afterwards. Earlier runs in the same series recorded the two defects this fixed: `$.session.compact()` refused in SDK sessions, and whole-prefix verification failing 49 to 528 tokens short after plain replies on 2.1.293 and 2.1.295. No real Codex compaction has been run.

## From collaboration.md

Fresh authorized native acceptance verifies both origin providers, queue-only Codex receipt and automatic Claude mod-self receipt with real Stop ACK. Additional installed acceptance on Codex 0.159.0-alpha.12.1 verified a persistent exec-origin main idle before its read-only Claude worker completed, one automatic native-owner completion wake, exact status/result read and real Stop ACK. The earlier unbound and uncertain exec canaries remain intact; source/catalog fixes never bind or replay them manually. This is separate from the earlier Claude Mod route and does not certify every runtime or host timeout. Preserve the earlier unbound and expired records without replay. This is bounded evidence for the reviewed installation, not a new synchronization-runtime allowlist or blanket acceptance of other versions/routes.

Authorized default-wake acceptance (2026-10-15, App 1.4.7 at 83a1665, Mod 0.8.28, Claude Code 2.1.295 in Claude Desktop, route mod-self): a root `claudex_start` from a Claude Desktop Code session with `notifications` omitted returned `notificationMode: wake`; the origin bound about one second after the start through the broker's bounded proof reread (no lifecycle event); the caller then ended its turn, its Stop hook registered the chat, and the Codex worker's terminal revision produced one queued wake delivered into the same session about two seconds later, followed by an exact status/result read. The two earlier probes the same day are preserved as failures: one expired awaiting native proof (result flushed after PostToolUse, before f19dcd7) and one bound but stayed `origin-not-registered` because the chat mailbox held 1,024 chats with no retention (before 83a1665). This is bounded evidence for that installation and route, not certification of other runtimes.

Authorized follow-up acceptance (2026-10-15, App 1.4.7 at 072cd1b, Mod 0.8.30, same runtime and route, `crossSessionInbound` unset): the defaulted root start reported `expiresInMs` 3,600,000 and `blockerNotifications: true`; the first status check already returned `await-notification` with reason `receiver-observed-native-default`, the app setup phase was `ready` with the Completion delivery row ready, the caller ended its turn, and the terminal revision's wake arrived in the same session about two seconds after completion, with status showing the delivery `offered` and an unread result until the Stop ACK.

Authorized native acceptance on an earlier pinned resource verified an idle original Claude chat waking through its existing Desktop owner, rendering the requested reply and acknowledging once under the same UI/CLI identities. No manual prompt or acknowledgement was submitted.

Separately authorized live CLI acceptance verifies Codex-to-Claude and Claude-to-Codex child delegation with exact result return, plus two consecutive owner transfers under one logical task ID. The tested runtimes are Codex CLI 0.158.0-alpha.2.1 and Claude Code 2.1.283. Seven model executions completed in an isolated read-only workspace; test files stayed unchanged and owned process groups exited. A separate authorized writable run on the same versions verifies both directions of child file editing and parent yield/resumption, plus sequential Codex-to-Claude-to-Codex edits under one task ID. Nine native executions completed; exact final bytes and recorded serial ownership boundaries were checked. Only a temporary broker enabled writes and it was stopped afterward. The installed service retained its then-current read-only default. This is historical bounded collaboration file-editing evidence, not a new synchronization version allowlist entry, generic build/test execution in Claude, or proof of Desktop UI chat transfer. Claudex 1.1.1 cooperative-follow-up acceptance also verifies both real supervisor/child directions: a proactive follow-up sent after work started was received, acknowledged and completed by the child in generation one, without a prior blocker or question. See docs/collaboration.md for exact native versions and verification scope. This is cooperative check-in/MCP-return delivery, not instantaneous interruption, external idle wake or synchronization certification.


## From claude-mod.md

The reviewed Mac has App 1.2.13 and Mod 0.8.10 installed through normal Quit/reopen and app-owned Mod management; both native configuration identities' receiver opt-ins were retained. Existing Claude sessions were not restarted; installation is verified but existing Desktop sessions can retain older loaded Mod code until a normal new session/reload. Isolated native 0.8.7 direct-on acceptance passed without model turns; it does not prove those existing sessions reloaded. The earlier reviewed 0.7.1 installation used route=mod-self. Earlier acceptance after a normal Claude restart verified that one Desktop native session and one waiter delivered a newly authorized message to the same session, with a Sonnet 5.5 reply and real Stop ACK. Native UI evidence retained the unsent draft. Explicit native hold and refuse passed in isolated tools:[] sessions with zero model turns. Preserve the earlier failed submitted/no-ACK message; success used a new message, never replay. Keep exact evidence in docs/claude-mod-validation.md.

Verified broker stop/start retained mod-self and one waiter without replay; the same native Claude process and unsent draft remained.

Bounded authorized automatic nativeWake acceptance on 2.1.286/Sonnet 5.5 verifies SDK-owned and Desktop-owned senders, exact claim, real session.send acceptance, recipient reply and actual Stop ACK. The final Desktop-owned case passed after normal broker/Claude restarts, with one reply and no pending outbox receipt. Busy delivery accepted a second message before the first ACK; both ACKs arrived. Offline rejection stayed rejected after reopening/restarts without replay. Native pixels verify the unsubmitted draft remained and all five 0.2.3 tabs fit two rows.


## From desktop-owner.md

The real integrated coordinator/SDK/Desktop check verifies initial import, a restart, delta delivery, same Remote Control identity, exact canonical history, and recovery without resend.

Fresh user-authorized Desktop acceptance verifies same-title deliveries across two Codex generations, automatic original archival with exact bytes preserved, one visible current entry, one archived generated predecessor, a stable Claude owner and equal canonical history.

Fresh native vision acceptance verifies PNG and JPEG pictures in both directions, including a new large image attached after a Codex handoff. The receiving models identify visible details and retain earlier codes; canonical image hashes and original prefixes remain exact.

The integrated real SDK/coordinator proof preserves four canonical messages through a cold migration, restart and then a six-message next-delta checkpoint; the v2 delta and archive path render in the same Claude Desktop entry. Native receipts report zero inference. The live watcher has also migrated both real conversations without changing their Remote Control identities or canonical digests. The large history's real Desktop context fell from over-capacity to 41.1k/1M while complete portable content remained in the archive. This native context migration does not erase the older cloud display history. User-authorized model-generated acceptance verifies two full alternating continuations from a real source containing compaction and history_base, followed by a final Claude recall and automatic bounded snapshot collection. Both logical histories match.

Recovery of the observed old false-positive block verified exact persisted SDK/no-query input, authenticated canonical history, no later authored rows and an exited writer; it preserved the pending intent and did not resend or invent a lost receipt.


## From lifecycle.md

The native watcher, six synthetic roundtrips, real Claude rendering, and desktop task-reading integration are verified without inference. Separately authorized real Desktop acceptance verifies two model-authored roundtrips, history-based nonce recall on both sides, and automatic delivery.


## From codex-transport.md

The launcher is activated on the real Codex Desktop backend. Automatic native enrollment and Claude Remote Control registration of real conversations are verified. Both real mirrored conversations render in the Claude Desktop sidebar and their history opens through Remote Control. Real dual-Desktop alternation acceptance now passes, including native retirement of the oldest of three generated Codex snapshots: one current and one archived previous remain. The original source is preserved.

An isolated signed-wrapper native startup exposes the 47 app tools without changing the verifier. A normal user-initiated app restart activated the signed wrapper and restored the live app-tools path.


## From sync-events.md

Late-item proof with a turn its runtime left open (2026-10-14, Codex 0.162.0-alpha.17.2): a backend restart ended a running turn without a closing record in three tracked threads. Across 1,635 local rollouts, 485 starts follow a still-open turn (most inside inherited fork prefixes); one names that turn afterwards, with a completion record, and remains a refused overlap. Replayed read-only through the shared backend against saved checkpoints: the affected thread with six earlier late arrivals was refused before the change and matches its whole 2,871-message checkpoint after it; six other tracked threads containing such a turn match their checkpoints both before and after. The API reported the open turn in progress in the three threads with a later running turn and interrupted, without a completion time, in idle threads.

Dialogue checkpoints and identity-only late items (2026-10-18, Mod 0.8.60): a temporary read-only audit decoded 762 local Claude transcripts and 55 Claudex Codex projections (124 raw rollouts are not projection files and were skipped). Every exact checkpoint also matched its own dialogue. Re-projecting tool inputs, tool results and inert native event payloads (an added null field, reformatted result content) changed the exact bytes of 154 histories; all 154 still matched their dialogue. Of 1,295 real divergences (an edited user or assistant text, a dropped first message, a changed tool call identity), all 1,295 were refused. Synthetic tests cover changed roles, event identities and tool result identities, the legacy checkpoint upgrade and the byte-exact handoff tail.

## Interrupted original and explicit edited-source recovery (2026-10-21)

Local App 2.0.10 / Mod 0.8.68 acceptance used normal signed-bundle installation,
Quit/drain and app-owned startup without restarting either native desktop app.
The startup sweep completed verification of 530 conversation pairs in both
native directions, with no genuine source/conversation blocks or pending transaction.
The interrupted original stayed unarchived under its persisted full-history
proof; its continuation and Claude matched at 1,746 messages. An explicitly
authorized never-sent first handoff retained its full 86-message transaction in
an immutable receipt, adopted the exact edited 82-message prefix and delivered
it normally. Native readback matched both checkpoints. A nested fork that
referenced a physical ancestor also delivered matching 114-message histories.
Installed and freshly observed Mod versions were 0.8.68; actual app pixels
showed synchronization ready. Recovery and acceptance issued no model requests.
Workspace contracts passed 404 tests with six intentional ignores; native
image/fork regressions retained exact segment, ordinal and byte-prefix checks.

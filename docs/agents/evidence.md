# Historical acceptance evidence

Records of past authorized acceptance runs, moved out of the topic guides.
They describe what was verified on the versions named, not current rules or
current installation state. Read this only when a task asks what was verified.
Never extend a result to another version, route or runtime, and never replay
or reset the preserved failed or uncertain records mentioned here.


## From cache-warming.md

Authorized Desktop 0.160.0 backend acceptance after native trust verified seven blocked local command turns (status/on/confirm/off), native hook-time primary/turn checks, structured output and no token-usage events or assistant/tool history items. The test policy ended disabled/unbound with zero refresh attempts and no timer.

Authorized 1.2.6 native acceptance verified a 25-minute same-owner OK refresh (36,096 cached input / 5 output tokens), exact accounting and the one-refresh limit. At about 31 minutes both warmed and untouched controls still hit; retain the inconclusive extension result, not a guaranteed native TTL claim. Detailed version-scoped evidence is in docs/claude-mod-validation.md.

Authorized 1.4.2 native acceptance (Claude Code 2.1.295, Sonnet 5.5 medium, staged Mod 0.8.24, isolated root, `dev/cache-warm-probe/native.mjs --run --compact --native-context`) verified one warm request under the prior-read rule (read 34,261, prior read 29,858, required prefix 34,310), compaction authorized 144 ms after its due time and 240 seconds after the warm request started, one `compact_boundary` with trigger `manual` (34,422 to 1,728 tokens, 6.7 seconds), the policy ending `compacted` with one refresh, and a normal reply afterwards. Earlier runs in the same series recorded the two defects this fixed: `$.session.compact()` refused in SDK sessions, and whole-prefix verification failing 49 to 528 tokens short after plain replies on 2.1.293 and 2.1.295. No real Codex compaction has been run.

## From collaboration.md

Fresh authorized native acceptance verifies both origin providers, queue-only Codex receipt and automatic Claude mod-self receipt with real Stop ACK. Additional installed acceptance on Codex 0.159.0-alpha.12.1 verified a persistent exec-origin main idle before its read-only Claude worker completed, one automatic native-owner completion wake, exact status/result read and real Stop ACK. The earlier unbound and uncertain exec canaries remain intact; source/catalog fixes never bind or replay them manually. This is separate from the earlier Claude Mod route and does not certify every runtime or host timeout. Preserve the earlier unbound and expired records without replay. This is bounded evidence for the reviewed installation, not a new synchronization-runtime allowlist or blanket acceptance of other versions/routes.

Authorized default-wake acceptance (2026-10-15, App 1.4.7 at 83a1665, Mod 0.8.28, Claude Code 2.1.295 in Claude Desktop, route mod-self): a root `claudex_start` from a Claude Desktop Code session with `notifications` omitted returned `notificationMode: wake`; the origin bound about one second after the start through the broker's bounded proof reread (no lifecycle event); the caller then ended its turn, its Stop hook registered the chat, and the Codex worker's terminal revision produced one queued wake delivered into the same session about two seconds later, followed by an exact status/result read. The two earlier probes the same day are preserved as failures: one expired awaiting native proof (result flushed after PostToolUse, before f19dcd7) and one bound but stayed `origin-not-registered` because the chat mailbox held 1,024 chats with no retention (before 83a1665). This is bounded evidence for that installation and route, not certification of other runtimes.

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

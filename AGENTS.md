# Claudex

Local turn-boundary conversation bridge between Codex desktop/CLI and Claude Code CLI.
Use English for repository content. Keep private transcripts, state, logs, credentials,
and generated sessions outside the repository.

## Development

- Node.js 22+, ES modules; install with `npm ci`.
- Run `npm test` for the coordinator and adapter contracts.
- Native integration checks use isolated temporary homes and synthetic transcripts.
- Automated tests never start model inference. Real Desktop reply acceptance requires explicit user authorization; never overwrite live sessions or modify user databases as a test.
- The synchronization coordinator has one owner per conversation and commits only complete turns.
- Fail explicitly on conflicts, partial history, or unsupported lifecycle states.
- Preserve original contents and never prune originals as generated backups. The authorized Desktop same-title handoff may archive an unchanged, independent Codex original only after verifying its replacement.

## Adapters

- Codex publishes only new independent rollouts and registers them with `thread/resume(path)`; no direct SQLite mutations or external-agent imports.
- Claude uses native resumable session projections with pinned `txcript` codecs.
- Filesystem events are hints; durable checkpoints and source identities determine work.
- Imported history must not loop back as newly authored history.

## Current boundary

`bin/claudex.mjs` provides explicit initialization with all-project or selected-project scope, discovery,
watching, synchronization, recovery, collection, and optional macOS LaunchAgent
installation. Defaults retain one current and one previous copy per side,
seven-day rollback age, 512 MiB aggregate rollback quota, and 50 audit entries.
One extra candidate is allowed during a transaction; unresolved failures prevent
new allocation. Original source sessions are not disposable backups.
All-project discovery skips unsupported unenrolled histories and reports a
bounded diagnostic list; pending transactions and tracked-history failures still
stop synchronization. Discovery starts at initialization, not a bulk history import.

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
the return from Codex creates a separate managed Remote Control entry. Preserve
the Local original and direct subsequent work to Remote Control. Cold imports
avoid idle SDK workers only until that transition; active owners remain long-lived.
Only cold-import pairs may use ephemeral watcher hints after stable, complete
no-change verification. Include all record lifecycle/checkpoint fields and file
identities before/after sync, including superseded originals. Pending work,
errors or missing/changed files invalidate hints; full verification is mandatory
every 60 seconds. Never advance semantic checkpoints from hints or skip a current
managed Claude owner's lifecycle checks. Normal discovery scope is unchanged.
Collection validates both current sides only for conversations owning managed
snapshots, avoiding full exports of unrelated cold pairs with no backups. Keep
the superseded-original guards global, retain every managed snapshot in the
global quota, and preserve exact previous-snapshot/native retirement checks.

Validated native baselines are Codex `0.155.0-alpha.16.3`/`.16.4` and Claude Code
`2.1.210`/`2.1.281`. versionPolicy defaults to strict; an explicit warn policy
allows unvalidated runtime versions to be attempted without version-only pauses.
Never label an unvalidated version as verified. Codex has cross-process writer locks.
Check both spawned descendants and ordinary forks before retirement: this Codex
version omits fork ancestry from `thread/list`, so use metadata-only `thread/read`.
Include `thread/loaded/list`: a fresh fork can be loaded before the stored list
exposes it. Original archival and owned-snapshot retirement share these guards.
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
Semantic baseline resets require a new boundary after an unchanged saved byte
prefix; checkpoints advance only on successful promotion. Opaque Codex summaries,
replacement histories, and Claude preserved-segment chains remain blocked.

Claude Desktop uses a separate registry. Native handoff adopts the CLI transcript.
Desktop-owned transcripts must not be replaced, hidden, or pruned (even if archived
in Desktop). No external no-inference lifecycle API is established, so automatic
Desktop generation registration is not enabled. Never claim that CLI discovery
proves Desktop Recents visibility or implement database/IPC injection as a shortcut.

Claude Desktop Code > New > Local outbound discovery is now actually verified:
the pinned Desktop writes its native transcript under ~/.claude/projects,
which the existing watcher discovers automatically. No second discovery store
is needed. A real Codex continuation recalled the original Claude response.
The UI local_<UUID> may differ from registry.cliSessionId; ownership checks must
use the bounded stable registry mapping, including archived entries, and retain
conservative filename protection. Never assume the UI suffix is the native ID.
Returning from Codex creates a separate managed Remote Control entry; it does
not write into or automatically archive the Desktop-owned Local original.
Clearly instruct users to continue via Connected via Remote Control thereafter.
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

Unmanaged native Codex localImage recovery reads only metadata.path's current
owned regular rollout, using O_NOFOLLOW and stable identity/stat checks with a
512 MiB stream cap and 64 MiB row cap. Require exact translated completed-item
equality with the full API item, matching thread/turn/context/passthrough IDs,
one earlier embedded user response, exact text, and image wrapper path/number/order
agreement before a closed turn. Keep image descriptors as inert metadata and
validate the recovered data URI and converted-history budget. Never read API
image paths, fetch URLs, search history_base files or silently choose a candidate.
This preserves native persisted model-input bytes, not proven unresized uploads.
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
never restart active user work. WS clients share the backend and can retire idle
owned projections immediately (native isolated proof). The CLI's raw proxy is
not compatible with the WS listener. Native socket aliases need strict UID,
private-directory, inode and target validation, not blanket symlink following.

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

Claude 2.1.281 stores original input images under its private per-UID temporary
project/session image cache, but may persist resized previews in JSONL. When an
exact pending intent proves an original PNG/JPEG, retain its bytes once in the
content-addressed private image-assets store and bind the native preview hash.
Logical reads restore the original and validate the packet; native files are
never rewritten. Missing originals, altered previews or changed text fail closed.
Image bindings grow with actual image occurrences, not image-free sync rounds;
identical originals deduplicate across owners. Archive assets are authoritative
conversation content, not disposable rollback snapshots. Unsupported format
conversion and ambiguous cache identities still pause synchronization.

The CLI also appends an `isMeta` image-source sidecar after an imported image
packet. It is excluded from logical history only with the exact pinned text
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
explicitly labeled readable excerpts. They are not AI summaries. Mixed v1/v2
decoders reconstruct the exact canonical digest; authenticate before loading
archives and require their signed archiveRoot to match the configured root.
Archive assets are authoritative history, not rollback garbage.
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
Promoted recovery reconnects the normal owner even without a cached handle.

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

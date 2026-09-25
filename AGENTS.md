# Claudex

Local turn-boundary conversation bridge between Codex desktop/CLI and Claude Code CLI.
Use English for repository content. Keep private transcripts, state, logs, credentials,
and generated sessions outside the repository.

## Development

- Node.js 22+, ES modules; install with `npm ci`.
- Run `npm test` for the coordinator and adapter contracts.
- Native integration checks use isolated temporary homes and synthetic transcripts.
- Never start model inference, overwrite live sessions, or modify user databases as a test.
- The synchronization coordinator has one owner per conversation and commits only complete turns.
- Fail explicitly on conflicts, partial history, or unsupported lifecycle states.
- Preserve original sessions; do not infer permission to prune or archive them.

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

Native compatibility is pinned to Codex `0.155.0-alpha.16.3` and Claude Code
`2.1.210` or `2.1.281`; version drift pauses writes. Codex has cross-process writer locks.
Check both spawned descendants and ordinary forks before retirement: this Codex
version omits fork ancestry from `thread/list`, so use metadata-only `thread/read`.
Claude projections use canonical project paths and owned rollback storage.
The append helper is for controlled fixtures, not runtime concurrent writes.

The native watcher, six synthetic roundtrips, real Claude rendering, and desktop
task-reading integration are verified without inference. Automatic desktop
sidebar refresh and new model-generated continuation are not verified. Do not
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
persistence, and duplicate suppression. SDK0.3.281/CLI2.1.281 are pinned. Preserve
the default OAuth namespace by omitting CLAUDE_CONFIG_DIR for standard ~/.claude.
No credential extraction/copy is allowed. The opt-in Desktop watcher uses this
path. Store the owner handle before start() so startup failures
during user work retain the live owner instead of interrupting it.

Context packets preserve portable semantic messages as authenticated labeled
native text/images. DesktopBridge persists a private key, canonical prefix,
single pending transaction and bounded audit. Native history export uses full paginated API reads with a stable
two-read snapshot, including pre-compaction readable history. Do not claim it
recovers encrypted reasoning or native-truncated output.

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
opens through Remote Control. Real dual-Desktop alternation acceptance is still
outstanding. Do not remove dependency guards for retirement.

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

Rejected transport shortcuts: queue/add auto-starts inference on an idle native
thread. shellCommand persists userShell events without a model request, but
native model-context output truncates around 40k characters even when API output
is complete. It is not a lossless arbitrary-packet transport and is not enabled.

Reverse Desktop delivery creates a new `[Claudex] <original title>` Codex task;
it never appends into the original task. Superseded originals remain tracked:
sync, recovery and collection compare their own saved checkpoints and reject
new complete turns or changed prefixes. Never silently ignore activity in a
preserved original or compare it to the newer canonical checkpoint. Recovery
also rechecks a replaced destination after a durable native apply, before
promotion, so concurrent work cannot be silently left behind.

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
context migration does not erase the older cloud display history. Real
model-generated two-way alternation remains a separate acceptance gate.

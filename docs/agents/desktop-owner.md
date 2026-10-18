# ClaudeOwner, context packets and delivery

Contributor rules moved out of AGENTS.md; they are binding. Scope: The SDK owner path, context packets and archive mode, image projection, reverse delivery and original archival, owner reset/migration, idle eviction, and no-query receipts.

A native Desktop probe verifies two then four synthetic messages under one ID,
including archive and deep-link unarchive without another registry entry. This
does not establish a writer lease: archive persists before child exit is awaited,
and unarchive can race an external append. Keep the Desktop-owned write guard.

The Rust `Owner` in `crates/claudex-sync/src/owner.rs` is the sole native writer;
it drives Claude's native SDK protocol directly, and Desktop views it through
Remote Control. Actual native/desktop tests verify shouldQuery:false,
zero-inference receipts, same remote ID after restart, exact UUID/content
persistence, and duplicate suppression. A first registration is saved as
registering before the call; an outcome without a native bridge-session row
stays unknown and never registers again. Only an explicit CLI error answer
(SDK errorClass control_request_failed) to a first registration resets it to
unregistered and replaces that process at its next idle use, which may register
once more (such failures were observed transiently after many registrations).
CLI2.1.281 is the validated baseline enforced only in strict policy; its
original native acceptance used SDK0.3.281. The Rust owner does not load the
Node SDK. Preserve
the default OAuth namespace by omitting CLAUDE_CONFIG_DIR for standard ~/.claude.
No credential extraction/copy is allowed. The opt-in Desktop watcher uses this
path. Store the owner handle before start() so startup failures
during user work retain the live owner instead of interrupting it.

The CLI started through its SDK protocol ignores `permissions.defaultMode` from settings
(observed with CLI 2.1.283: user and flag tiers both start in `default`) and has
no local prompt surface, so tools that would ask are denied in a Desktop turn.
A normal owner therefore resolves the same setting sources it passes and gives
the SDK the configured mode explicitly; `bypassPermissions` also sets
`allowDangerouslySkipPermissions`. The highest tier that names a mode decides,
except that the project tier cannot supply `bypassPermissions`, `auto` or
`acceptEdits` (a home-directory cwd resolves the user file as the project tier
too, so the SDK's whole-key `filterEscalatingDefaultMode` is not used). Bypass is
not requested when policy disables it or the process is root. An explicit
`permissionMode` owner option wins, maintenance owners never receive a mode, and
a different settings namespace is not resolved. Claudex never chooses a mode the
user did not configure.

Context packets preserve portable semantic messages as authenticated labeled
native text/images. DesktopBridge persists a private key, canonical prefix,
single pending transaction and bounded audit. Native history export uses full paginated API reads with a stable
two-read snapshot, including pre-compaction readable history. Do not claim it
recovers encrypted reasoning or native-truncated output.

Opt-in paginated projections preserve signed packet blocks and images in the
full native history API; default legacy behavior is unchanged. Owned decoders
validate the packet before generic metadata conversion, strip only the exact
explicit transport receipt, and retain real subsequent turns. DesktopRuntime,
DesktopBridge and desktop-watch integrate all-project discovery, stable Claude
owners, bounded Codex snapshots and recovery. Completed-prefix readers withhold
active tails. Verified dead locks are reclaimed; live/malformed locks block.

CLI 2.1.281 inserts a zero-usage synthetic assistant
`No response requested.` after a resumed no-query tail. The owned decoder
excludes only that exact placeholder immediately after an authenticated packet;
require zero input/output tokens and absent, null or zero cache-read/cache-creation
token counters, matching the legacy codec's four-counter usage projection.
Extended usage metadata (including nested counters and null fields) does not
become authored content; native bytes stay untouched. Real replies remain
history. SDK-owned packets from another state root are
excluded during discovery to prevent import loops (classification is not HMAC
authentication). No current user transcript is modified by these checks.

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

Existing dependent originals are not migrated
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
Native apps can resize uploads before persistence;
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
Current, stopped and retired owned readers pass the saved `lastReset` proof to
the completed-history decoder. Exclude only its exact `/clear` caveat, command
and empty native output after verifying the zero-query receipt, native graph,
session/cwd/version and authenticated restoring archive packet. Without that
proof they remain history; no reader starts or repeats a reset.
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

Pinned no-query receipts have zero num_turns and duration_api_ms, but
total_cost_usd/modelUsage are cumulative across real replies and resume. Require
finite nonnegative cumulative cost, not absolute zero; preserve success, exact
single input UUID, session identity and native persistence checks. Report this
field as cumulativeCost, never as measured append cost. The native /clear
receipt still requires zero cost after its ledger reset.

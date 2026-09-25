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
Claude Remote Control registration of real conversations are verified. Real
dual-Desktop alternation acceptance is still outstanding; fixture tests do not
establish sidebar rendering. Do not remove dependency guards for retirement.

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

The pinned Desktop CUA helper invokes exactly `app-server --listen stdio://`
with the app-tools pipe present. Preserve this independent auxiliary process
instead of claiming the shared owner lock. The real helper route is verified;
subsequent Claude-targeted UI capture timeouts remain an acceptance limitation.

Desktop launchers must use the original OpenAI-signed bundled Node, not the
installing shell's process.execPath. The app's native peer authorizer checks
the peer, parent and grandparent signing identities. A Homebrew/ad-hoc wrapper
breaks codex_app startup and browser policy verification despite a signed leaf
runtime. The installer verifies the bundled Node signature and journals exact
owned-runtime upgrades. An isolated signed-wrapper native startup exposes the
47 app tools without changing the verifier. The currently running old wrapper
must be replaced before claiming the live app-tools path is repaired. Never
disable peer checks or substitute an unsigned client. Stdio close does not
schedule immediate reconnect; next-request recovery is not proof that killing
an active backend is safe.

Rejected transport shortcuts: queue/add auto-starts inference on an idle native
thread. shellCommand persists userShell events without a model request, but
native model-context output truncates around 40k characters even when API output
is complete. It is not a lossless arbitrary-packet transport and is not enabled.

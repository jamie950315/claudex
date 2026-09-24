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
No credential extraction/copy is allowed. The default watcher is not integrated
with this path yet. Store the owner handle before start() so startup failures
during user work retain the live owner instead of interrupting it.

Context packets preserve portable semantic messages as authenticated labeled
native text/images; the coordinator still needs durable key and digest-chain
integration. Native history export uses full paginated API reads with a stable
two-read snapshot, including pre-compaction readable history. Do not claim it
recovers encrypted reasoning or native-truncated output.

Shared Codex transport is staged, not deployed: `bin/claudex-codex.mjs` preserves
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
explicit transport receipt, and retain real subsequent turns. Live scheduling,
bounded snapshot retirement and automatic discovery still need these pieces
integrated; the existing watcher remains the legacy path.

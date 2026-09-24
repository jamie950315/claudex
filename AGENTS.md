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

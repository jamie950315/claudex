# Claudex

Native compatibility prototype for a local conversation bridge between Codex desktop/CLI and Claude Code CLI.
Use English for repository content. Keep private transcripts, state, logs, credentials,
and generated sessions outside the repository.

## Development

- Node.js 22+, ES modules; install with `npm ci`.
- Run `npm test` for the coordinator and adapter contracts.
- Native integration checks use isolated temporary homes and synthetic transcripts.
- Never start model inference, overwrite live sessions, or modify user databases as a test.
- Any future synchronization coordinator must have one owner per conversation and commit only complete turns.
- Fail explicitly on conflicts, partial history, or unsupported lifecycle states.
- Preserve original sessions; do not infer permission to prune or archive them.

## Adapters

- Codex uses its app-server protocol, not direct SQLite mutations.
- Claude uses native resumable session projections with pinned `txcript` codecs.
- Filesystem events are hints; durable checkpoints and source identities determine work.
- Imported history must not loop back as newly authored history.

## Current boundary

There is no installed daemon, hook, CLI, or production sync coordinator.
Codex `thread/inject_items` persists model context without visible turns.
The official importer refreshes an untouched, unloaded imported thread, but skips
one that has gained Codex-native history. Do not implement in-place bidirectional
sync by rewriting user JSONL or SQLite to work around this boundary.
Claude projections are resumable when placed under the real (canonical) project path.
The append adapter is a low-level primitive, not safe concurrent-writer coordination.

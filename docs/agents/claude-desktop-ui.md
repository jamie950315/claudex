# Claude Desktop registry, folders and handoffs

Contributor rules moved out of AGENTS.md; they are binding. Scope: The Desktop registry, Local sessions, same-title Remote Control entries, the folder presentation adapter and native Local predecessor archival.

Claude Desktop uses a separate registry. Native handoff adopts the CLI transcript.
Desktop-owned transcripts must not be replaced or pruned, even when archived.
Automatic per-generation Local registration is not enabled. The opt-in renderer
consumer may invoke the observed native archive API after a verified same-title
Remote Control replacement; it never writes registry/database files or takes
over a Local transcript. CLI discovery alone does not prove Desktop visibility.

Claude Desktop Code > New > Local outbound discovery is now actually verified:
the pinned Desktop writes its native transcript under ~/.claude/projects,
which the existing watcher discovers automatically. No second discovery store
is needed. A real Codex continuation recalled the original Claude response.
The UI local_<UUID> may differ from registry.cliSessionId; ownership checks must
use the bounded stable registry mapping, including archived entries, and retain
conservative filename protection. Never assume the UI suffix is the native ID.
Desktop writes a registry record before its CLI session exists (observed for a
Remote Control spawn that never ran). A record with the exact filename identity
and an absent or null cliSessionId maps to no native transcript and is skipped;
its filename still protects that Desktop identity. A present but invalid CLI
identity or a mismatched sessionId remains ambiguous and fails the whole lookup.
Desktop rewrites the records of its running sessions at any time. A mapping
lookup that overlaps such a write (a record or directory identity changed during
the scan) repeats the whole scan, at most three times; a result always comes
from one scan that saw no change. Never accept a partly changed scan, and never
let a write to an unrelated session hold the conversation being looked up.
Returning from Codex creates a separate managed Remote Control entry with the
same logical title, without a `[Claudex]` prefix. The opt-in native Local handoff
archives the verified Local predecessor so the ordinary same-title entry is the
continuation; it does not append into or reuse the original Local native ID.
New managed owners persist the logical display title before registration.
Existing owned titles with the exact legacy `[Claudex]` prefix are migrated by
the live owner's `query.renameSession(title, nativeId)`, with a durable rename
journal, native persistence proof and recovery. Unrelated manual names survive.
Remote Control reattachment omits the name so native/cloud UI renames survive
reconnection. Do not use the SDK's standalone JSONL-appending rename helper
against a live owner. Existing entries may be renamed or pinned through native UI
when requested; pinning is not automatic and does not merge a Local entry.
The required sidebar behavior is placement under the same existing local
project/folder group as the source. Pinning, title prefixes, and a new same-name
custom group are not substitutes. `desktop folders enable|disable|status` manages
an opt-in, structurally validated presentation adapter for the cached Claude frontend.
It patches only the uniquely proved sidebar HTTP cache resource, preserving an immutable original
and a prepared/installed recovery journal under the private root. It does not
modify ASAR, signatures, login data or writer routing, and never edits native
session registry files directly. Native archival remains a separate guarded action.
Missing or ambiguous structural anchors, unsupported cache schemas, transformed
syntax errors and foreign changes to an installer-owned cache entry fail explicitly.
Asset URL and whole-source hash changes alone do not require a human re-pin.
Initial installation and each newly installed graph require an idle Claude app restart
because the app can retain old resources in memory despite a page reload.
The watcher publishes only verified current owner RC IDs and canonical cwd to
private `folder-map.json`. The renderer polls it through the existing guarded
LocalSessions.readFileAtCwd API and React subscription; no HTTP listener or new
worker is created. Match an existing same-host Local/CLI row and use its actual
native Folder key and label. Missing or conflicting matches get no override.
Rows, IDs, types, routes and native histories remain unchanged. Native cold-start
and live map-update checks verify entries in the original claudex folder, without
pinning or a custom group. Tests must not substitute fixture success for this UI
evidence. `folderProjection` status describes map/resource readiness, not proof
that a particular running renderer loaded the adapter.

`desktop handoffs enable|disable|status` controls native Local predecessor
archival. Configuration changes require a safely stopped watcher and the folder
adapter enabled. A cache upgrade requires an idle Claude app restart. Existing
verified pairs are eligible; this is not an unchecked bulk archival operation.
The coordinator publishes bounded, 15-second archive intents only after exact
original/checkpoint and replacement/canonical verification. Compare both counts
and digests after the same portable-message normalization used by ordinary
synchronization; empty thinking-only codec rows do not occupy canonical message
indices. This does not change the exact native-file identities or original byte
prefix proof. Pending work or new activity revokes commands before expensive
verification. The renderer rereads
native identities, title, cwd, activity, idle state, drafts and dependencies before
the normal archive API, with worktree cleanup disabled. An outcome is not accepted
until native archive state and original history preservation are verified.
The native getSession/getTranscript DTO may expose only the Desktop UI ID, not
the CLI ID. Before archival, reread the exact original registry JSON through the
guarded native readFileAtCwd API; require its path beneath the pinned native
registry root, the exact local_<UI ID>.json filename, and matching UI/CLI IDs,
cwd, title and activity. This is read-only, not a registry/database mutation.
Separate presentation anchors survive new turns only while current owner native
ID/RC ID, ledger cwd and source Local-to-CLI registry mapping still match. They
never authorize archive actions or advance checkpoints; expired commands cannot
be revived by an anchor. Archived folder anchors use the observed native session
normalizer and actual git metadata, not invented keys or labels. Keep one fixed
Local original archive per logical conversation, never a new original per turn.
Disposable generated predecessors retain the existing one-previous-per-side, seven-day,
512 MiB aggregate rollback and 50-audit-entry bounds; originals are not deletable
quota entries. Native automatic archival UI acceptance is a separate requirement
from unit tests, manifest publication or service readiness.
Native UI checks now verify existing Local predecessors and a fresh image-origin
Local predecessor are archived, with native Active filtering instead of hiding
rows in code. The All view may still show recoverable archived sources. Actual
native titles have lost their owned legacy prefix; authenticated transport labels
inside conversation content intentionally retain their existing Claudex markers.
Do not claim same-Local-ID bidirectional writing or generic Chat/Cowork support.

# Claudex

Local, turn-boundary conversation handoffs between Codex and Claude Code CLI.
Claudex prepares independent native sessions, verifies their content, and retires
only the copies it owns. It does not call a model or upload transcripts.

## Start

Requires macOS, Node.js 22+, Codex CLI `0.155.0-alpha.16.3`, and Claude Code
`2.1.210` or `2.1.281`. Other native versions pause synchronization until compatibility is
validated. Both tools retain their own authentication and permission settings.

```sh
npm ci --ignore-scripts
node bin/claudex.mjs init --all-projects
node bin/claudex.mjs watch
```

`--all-projects` automatically discovers activity across both native stores,
including new projects, without selecting repositories. To limit scope instead,
use repeated `--project /absolute/path/to/project` options during initialization.
Discovery starts with activity after initialization, not a bulk import of old
history. Existing conversations become eligible when they are updated.
Use the normal native session lists to open the latest version. Close the
destination session before switching back: loaded Codex writers and matching
live Claude sessions block replacement. Reading a completed source turn does not
require closing the source. Changes on both sides pause synchronization rather
than choosing which history to discard.

For background operation, stop the foreground watcher and install the per-user
LaunchAgent once:

```sh
node bin/claudex.mjs service install
node bin/claudex.mjs service status
```

The service runs at login. An unsafe error stops it rather than retrying an
ambiguous write. `status` shows the last error without transcript contents.
Unsupported histories found during discovery are left untouched and skipped,
so they do not stop unrelated projects. Status reports their count and at most
20 source paths/reasons; this diagnostic list does not accumulate over time.
Failures involving already tracked history or pending writes still stop safely.
`service stop` unloads it for the current login; `service start` loads it again.
`service uninstall` removes its LaunchAgent but preserves conversation data.
Only one watcher can run for a state root.

Existing conversations can be enrolled explicitly:

```sh
node bin/claudex.mjs track --from codex --id CODEX_THREAD_ID
node bin/claudex.mjs track --from claude --source /absolute/path/to/session.jsonl
node bin/claudex.mjs sync CONVERSATION_ID --from claude
```

`track` returns the logical conversation ID. The watcher handles subsequent
completed turns automatically. The first imported original remains untouched;
it can therefore remain as an extra row outside the managed copies. This tool
does not silently archive or delete the original.

## Bounded retention

Per logical conversation, the steady-state managed set is:

- One current Codex projection and one current Claude projection.
- At most one previous projection per side.
- Previous projections expire seven days after retirement, subject to a global
  512 MiB backup budget. Current conversations are never deleted for a quota.

This means at most four managed complete copies in steady state. A transaction
can temporarily add one candidate; an error stops further allocation. The
original enrolled session is separate and is never counted as disposable data.
Actual new conversation content naturally grows; this is not a cap on current
history or on the native applications' own operational logs and caches.

The state contains one pending transaction, fixed staging slots, and the most
recent 50 audit entries. It does not accumulate per-turn state snapshots or
service log files. The service uses a bounded `watcher-status.json`; stdout and
stderr are not appended to an unbounded log.

The watcher checks retirement on a 60-second cadence and during handoffs.
`gc` applies it on demand. When the service is stopped, no cleanup runs.
Policy overrides live in `config.json` under `policy`: `previousPerSide`,
`maxAgeMs`, `maxBackupBytes`, and `maxAuditEntries`.

## Safety and recovery

1. Snapshot a completed source and verify its prior checkpoint.
2. Refuse unsynchronized destination changes or an active destination writer.
3. Persist a transaction intent before creating a candidate.
4. Write a complete private staging file, fsync, then publish without overwriting.
5. Verify portable message content and native visibility before promotion.
6. Hide the previous owned version, then prune only verified independent backups.

```sh
node bin/claudex.mjs status
node bin/claudex.mjs recover
node bin/claudex.mjs abort
node bin/claudex.mjs gc
```

`recover` finishes the same interrupted transaction; it does not allocate a new
generation. `abort` discards only an unchanged unpublished owned candidate.
Promoted transactions must be recovered. If a process crashed holding a lock,
`recover-lock` or `recover-lock --watch` removes only a lock whose PID is no
longer alive. A live process is never killed to obtain a lock.

Generated files, rollback copies, configuration, and the ledger have private
permissions. Rollback symlinks are rejected. Native active/archived fork and
spawn relationships are checked before Codex retirement, since native deletion
can affect descendants. Missing/edited current history preserves old backups.

## Native integration

Codex projections use the pinned `txcript` codec plus validated complete-turn
events. `thread/resume(path)` registers a new independent rollout, and native
archive/delete APIs manage owned generations. This experimental path is version
gated. It does not use `externalAgentConfig/import`, so repeated handoffs do not
accumulate external-agent import mappings or import-attempt records. It does not
edit existing JSONL history or SQLite directly.

Claude projections use native JSONL with fresh record UUIDs and stable parent
links. Old owned files move outside the native picker into the bounded rollback
directory. Project paths are canonical; collisions in Claude's encoded directory
names are checked against transcript metadata.

Text, supported paired tools, and self-contained base64 images are carried.
Visible reasoning is labeled as imported transcript text, not replayed as an
unsigned provider thinking block. Opaque encrypted reasoning, approval state,
live processes, and provider-specific runtime state are not portable.

Synchronization explicitly pauses on unsupported compaction, interrupted/incomplete
turns, dependent histories, unsupported external attachments/artifacts, a changed
working directory, or conversion differences. Auxiliary asset/checkpoint/task
directories also block automatic retirement until their dependencies can be
verified. These cases are not silently flattened or deleted.

## Compacted conversations

Readable native compaction summaries are transferred as labeled historical
context, followed by complete post-compaction messages. No extra model is called
to summarize, decrypt, or reconstruct missing history. Earlier verbatim messages
are not presented as if they survived compaction.

- Codex: a nonempty native `compacted.message` without replacement history.
- Claude: an explicit `compact_boundary` linked to one readable
  `isCompactSummary` record and a complete independent continuation chain.
- Encrypted/empty summaries, Codex replacement histories, and Claude preserved
  segments are not transferable by this adapter. The latest boundary controls;
  an older readable summary cannot substitute for a newer opaque one.
- Codex `history_base` references are not flattened into tail-only conversations.
  Without a validated self-contained native summary, their earlier prefix must
  first be resolved and verified. An opaque summary does not establish that the
  earlier readable transcript has been deleted: it may live in a prior rollout.

After enrollment, a compaction may reset the semantic checkpoint only if its
boundary is new, occurs after the saved native byte count, and the entire saved
byte prefix still matches its hash. Checkpoints advance only after successful
promotion. Conflicts on the other side still block replacement. Original files
remain untouched; the existing retention limits apply to summarized generations.

## Claude Desktop boundary

The automatic watcher targets Claude Code CLI storage, **not the Claude Desktop
Recents list**. Desktop maintains a separate registry. Its official `/desktop`
handoff uses `claude://resume?session=<UUID>`; Desktop `/resume` is another native
entry point and requires a trusted folder. These entry points adopt the CLI
transcript rather than creating a disposable independent copy.

Automatic per-generation Desktop registration is not enabled: the inspected
Desktop `2.7032.0` offers no external no-inference archive/delete lifecycle API.
Importing every generation without that lifecycle would accumulate desktop
entries; moving their transcripts away would break those entries. The bridge
therefore refuses replacement or retirement of a CLI session registered with
Desktop, including archived desktop records. It does not alter Desktop's
database, trust settings, or internal IPC.

This is an explicit remaining integration limit, not a completed automatic
desktop synchronization feature. The foreground native CLI and desktop app
also retain their own authentication and workspace-trust requirements.

A controlled desktop probe verifies another possible direction: selecting the
project through the native folder picker permits CLI resume; two synthetic
messages render in Desktop, and after native archive, two fixture-only appended
messages render under the same desktop session ID. The official resume deep link
unarchives that same ID without another desktop record. This proves reload and
identity reuse, not safe concurrent synchronization.

Archive is not an external writer lease. The inspected native lifecycle requests
query closure without awaiting the child-process exit before persisting the
archived flag; another UI action can unarchive immediately. No shared external
writer lock is established. Consequently the runtime still refuses external
appends to adopted transcripts, even though the isolated synthetic probe works.
Do not promote the fixture append helper into a runtime writer based on an
archived flag, an absent PID, or a successful reload alone.

## Verification

```sh
npm test
CLAUDEX_NATIVE_TEST=1 node --test test/bridge-native.test.mjs test/cli.test.mjs test/codex-projection.test.mjs
```

Native checks use temporary homes and synthetic completed turns, not model
inference. They verify six alternating handoffs, one active and one archived
Codex projection, bounded Claude backups, restart/read behavior, zero import
history rows, cross-process writer protection, project-limited discovery, and
automatic watching. Pure tests cover twelve roundtrips, conflict handling,
recovery, quotas, atomic publication, symlinks, images, and visible reasoning.

Claude CLI displays a six-turn generated session. The desktop task-reading API
reads both complete turns of a synthetic Codex projection in the real local
store; that sample is removed afterward. Desktop renderer/automatic sidebar
refresh is not visually verified. New model-generated continuation is not part
of these no-inference tests.

`--root PATH` or `CLAUDEX_HOME` selects bridge state (default
`~/.local/share/claudex`). `init --codex-home PATH --claude-home PATH` selects
isolated native stores for testing. Runtime data stays outside the repository.

## References

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Claude storage and retention](https://code.claude.com/docs/en/claude-directory)
- [Thinking signatures](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [txcript usage](https://github.com/skillsynchq/txcript/blob/main/docs/usage.md)

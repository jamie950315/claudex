# Claudex

Turn-boundary conversation handoffs between Codex and Claude Code. The legacy
mode uses local CLI sessions. Experimental Desktop mode keeps a native Claude
SDK owner connected through official Remote Control and shares Codex Desktop's
native backend. Synchronization never requests model inference. Remote Control
does transmit the selected conversation to the user's Claude account; it is not
a local-only transport.

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

### Experimental Desktop mode

Desktop mode requires Claude Code `2.1.281` with normal subscription OAuth and
SDK `0.3.281`. It is integrated with the coordinator and background watcher, but
full two-application acceptance remains unverified. Install it only in a state
root without legacy tracked conversations; automatic legacy migration is refused.

```sh
node bin/claudex.mjs desktop install
node bin/claudex.mjs service install
```

Installation enables all-project discovery and configures the native
`CODEX_CLI_PATH` override for the next normal Codex Desktop start. It never quits
or restarts a running application. The existing watcher waits without enrolling
sources until the verified shared backend appears. On subsequent logins it
restores only its own launcher override; a different existing override is never
overwritten. If the LaunchAgent is already installed, use `service start` after
stopping its previous instance. No repository selection is needed.

The launcher uses Codex's original signed `cua_node/bin/node` runtime and verifies
its signature. An ad-hoc or Homebrew Node in the process ancestry prevents
native app-tools authentication and can make browser policy checks unavailable.
Re-running `desktop install` safely upgrades an unchanged Claudex-owned launcher
runtime with a durable recovery journal; it does not stop an active backend.
The new runtime takes effect on the next backend launch. Do not weaken native
peer verification to keep an unsigned wrapper running.

Desktop mode uses one stable Claude local/Remote Control identity per logical
conversation and at most two managed Codex snapshots in steady state. It keeps
one durable signed checkpoint chain, one pending transaction, a persistent
private signing key, and bounded diagnostics. Losing the key blocks writes; it
does not silently generate a replacement for existing state. Restart recovery
checks native operation identities before a write and never blindly retries an
uncertain append. Native user turns are never interrupted for synchronization.

`desktop uninstall` removes only the owned next-start launcher and returns the
configuration to legacy mode after the watcher is stopped. It does not delete
native conversations or Desktop state. Existing Desktop history is not migrated
back into the legacy coordinator. This rollback does not alter a running app.

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
longer alive. Desktop mode also reclaims verified dead coordinator locks at
startup. A live process is never killed to obtain a lock. Desktop owner appends
cannot be aborted or deleted as if they were unpublished snapshot files.

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

The legacy watcher targets Claude Code CLI storage, **not the Claude Desktop
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

This remains a limit of the legacy adapter, not a completed automatic
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

### Native SDK owner path

`src/claude-owner.mjs` provides an experimental alternative: a persistent native
Claude SDK process is the only transcript writer, and Claude Desktop connects
through native Remote Control. Synchronization submits `shouldQuery: false`
messages; normal user requests from Desktop remain native user turns. The
component pins SDK `0.3.281` and CLI `2.1.281` and requires normal subscription
OAuth. It does not copy credentials from Desktop. Setting `CLAUDE_CONFIG_DIR`
even to the default path selects a different native credential namespace, so
the owner omits that variable for the standard home.

The component verifies no-query receipts against the exact persisted UUID and
content, keeps one durable pending operation, deduplicates operation IDs, and
reconnects the same Remote Control identity. Native Desktop verification shows
updates arriving without reload, plus same-ID restart and duplicate suppression,
with zero inference turns/API time/cost for each bridge append. Desktop mode
wires this owner into the durable coordinator and background watcher; full
bidirectional Desktop delivery still requires app-level acceptance.

An integrated real SDK/Desktop check also verifies initial import, same-ID
restart, delta delivery, and recovery of a persisted append without resending it.
The native CLI may insert a synthetic zero-usage `No response requested.` receipt
after resuming an imported user tail. Only that exact placeholder following an
authenticated packet is excluded from logical history; genuine replies are not.
Discovery excludes SDK imports owned by other bridge roots as well, preventing
an already imported conversation from creating a new synchronization loop.

The real shared-backend watcher now enrolls ordinary Codex conversations and
forks, excluding subagents using native metadata. Goal continuation turns may
start with assistant work and accept steering later; the exporter preserves
that native order against earlier verified user context without inventing a
user message. Completed turns still need their final response.

For native resized PNG/JPEG previews, the owner verifies the exact original
against its pending intent and Claude's private input-image cache. It retains
original bytes once in a private content-addressed asset store and binds the
persisted preview hash. Logical history therefore remains lossless even when
the Desktop displays a smaller native preview. Source and native transcript
files are not rewritten. Missing or changed assets fail explicitly. These
originals are conversation content, not expiring rollback copies; identical
images deduplicate and image-free sync rounds do not add asset records.

Native image-source sidecars are transport metadata, not new authored messages.
The decoder excludes only the exact pinned annotation associated with the same
authenticated packet and native prompt identity, preserving the next delta's
digest chain. Arbitrary metadata and ordinary user text are not discarded.

`src/context-packet.mjs` carries reversibly labeled foreign messages as native
text and inline images, never executable tool requests. A bounded structural
footer authenticates the packet without duplicating its body. The Desktop
coordinator persists its private signing key, enforces digest chaining, and
keeps imported packets from looping back as newly authored messages.

`src/native-history.mjs` reads the native paginated `thread/turns/list` API twice,
requiring complete matching history rather than guessing raw `history_base`
offsets. A real compacted conversation exports all 15 completed turns and round
trips through the Claude codec. This is saved readable display history, including
inert tool events and inline images, not decrypted reasoning or recovered
source-truncated output. The destination transcript visibly states that limit.

### Shared Codex transport

`bin/claudex-codex.mjs` is the native launcher installed by Desktop mode. It preserves
the Desktop-supplied arguments and environment, replaces only the app-server
transport with the public Unix WebSocket listener, and forwards Desktop JSONL
frames unchanged. `CodexWebSocketClient` can join that same native backend. An
isolated native test proves that a second client can safely archive an idle owned
projection while the first client remains connected and receives the event.

Do not enable a separate prestarted backend through `CODEX_APP_SERVER_WS_URL` as
a shortcut: that skips Desktop's app-tools configuration and inherited pipe
environment. The entry point is the native `CODEX_CLI_PATH` override,
with the original bundled binary explicitly selected by `CLAUDEX_CODEX_BINARY`.
Changing a running Desktop process is not supported; integration must not
interrupt user work. Installation is distinct from activation: verify the live
shared-backend manifest and both desktop interfaces after the next normal start.

The native listener creates a private, UID-owned socket alias into its native
runtime directory. Both alias and target identities are verified. The bounded
manifest stores only process/socket identities and version, never inherited
environment values. The current CLI's `app-server proxy` sends raw JSONL and is
not interchangeable with this WebSocket transport.

Codex Desktop's separately launched CUA and Browser Use helpers keep their
original standalone stdio backends; they do not claim the shared Desktop owner's
lock. The exact pinned invocation is verified with and without the app-tools
pipe environment, including real browser startup. Real shared transport
activation, source enrollment, registration with Claude and canonical history
checks pass. Both real mirrored conversations are visible in Claude Desktop's
sidebar, and a large compacted source history renders through Remote Control.
Two real Desktop alternations with newly authored replies remain unverified;
no model inference is started merely to manufacture an acceptance test.

New owned Codex checkpoints can explicitly select `historyMode: 'paginated'`.
Typed native events preserve text block boundaries and inline images through
the persisted API, unlike the legacy display event encoder. A signed imported
checkpoint is followed by a clearly labeled transport receipt, not a fabricated
AI reply. `owned-codex-history` and `owned-claude-history` recover logical messages
and detect repeated imports or conflicting prefixes. The integrated native
adapter test verifies six alternating handoffs and restart/idempotency with
synthetic complete turns. Completed-prefix reads can publish an earlier finished
turn while a newer turn is still running. They never publish the active tail.
An original remains preserved even after the managed conversation advances.
Dependent forks, spawned tasks, edited backups, and auxiliary native assets
still block retirement safely; they are not deleted to satisfy a count limit.

## Verification

```sh
npm test
CLAUDEX_NATIVE_TEST=1 node --test test/bridge-native.test.mjs test/cli.test.mjs test/codex-projection.test.mjs
CLAUDEX_NATIVE_TEST=1 node --test test/desktop-native.test.mjs
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

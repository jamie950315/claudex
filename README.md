# Claudex

Turn-boundary conversation handoffs between Codex and Claude Code. The legacy
mode uses local CLI sessions. Experimental Desktop mode keeps a native Claude
SDK owner connected through official Remote Control and shares Codex Desktop's
native backend. One-time historical imports can instead start as native Local
sessions without an SDK owner. Synchronization never requests model inference.
Remote Control does transmit the selected conversation to the user's Claude
account; it is not a local-only transport.

## Setup and modes

Requires macOS and Node.js 22+. Validated native baselines are Codex CLI
`0.155.0-alpha.16.3`/`0.155.0-alpha.16.4` and Claude Code `2.1.210`/`2.1.281`.
The default `versionPolicy: "strict"` enforces these baselines. An explicit
`versionPolicy: "warn"` attempts newer or otherwise unvalidated runtimes without
blocking synchronization solely on their version numbers. Both tools retain
their own authentication and permission settings.

### Legacy CLI quick start

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

Desktop mode's validated Claude baseline is CLI `2.1.281` with normal subscription
OAuth and SDK `0.3.281`; warn policy permits other runtime versions to be attempted.
It is integrated with the coordinator and background watcher.
Explicitly user-authorized acceptance has verified two real model-authored
Desktop roundtrips, continuation from a compacted source, stable Claude identity,
exact logical history equality, restart recovery and bounded Codex snapshot
retirement. The experimental designation reflects pinned native versions and
the unsupported formats and lifecycle states documented below, not an untested
two-application path. Install it only in a state root without legacy tracked
conversations; automatic legacy migration is refused.

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

App updates do not need to match a single hard-coded CLI patch release.
`src/codex-versions.mjs` defines the exact validated runtime allowlist shared by
the launcher, doctor and both adapters. Under strict policy, an unvalidated version starts Desktop's
original native transport with unchanged arguments and environment, under an
exclusive native-only owner lease. No shared socket is published, and the
watcher explicitly reports synchronization awaiting version validation. This
does not enable history writes on an unknown version or bypass an existing
writer. Ownership, authentication and transport failures are never silently
retried through another backend. The bundled Node must still be OpenAI-signed.

The `.16.4` app update is validated with isolated native history, writer-lock,
snapshot-retirement and shared Unix WebSocket checks, plus an actual signed-Node
launcher initialization. No model request is needed for these checks.

#### Version-only enforcement

```sh
node bin/claudex.mjs version-policy warn
node bin/claudex.mjs version-policy strict
```

The first command opts out of version-only blocking for Codex, Claude Code and
the Claude owner SDK. Unvalidated Codex versions keep shared transport instead
of entering native-only mode, and Claude owners attempt the existing protocol.
`status` shows the selected policy and bounded runtime warnings; `doctor` still
reports unvalidated versions as unverified rather than claiming compatibility.
The second command restores the strict policy. Existing configuration fields,
conversation IDs, checkpoints and transcripts are not changed by either command.

Reload an idle watcher to apply a policy change to its native owners. The
launcher reads the saved policy at its next invocation; if Desktop is already
using native-only transport, a normal app restart is required before sharing
can start. Do not restart active user work. Claudex no longer forces
`DISABLE_AUTOUPDATER=1` on its Claude workers; explicitly inherited user settings
are preserved. Installed applications keep their normal update mechanisms;
Claudex does not automatically upgrade its npm SDK dependency.

Warn policy also allows changed native version tags through the existing exact
image-sidecar and reset-prologue formats. It does not relax signatures, native
identity, schema, content, no-query receipts, writer locks or conflict checks.
Malformed metadata or an actual protocol/format change can still stop a handoff.
This is permission to attempt an unvalidated version, not a guarantee that all
future versions will work.

Active Remote Control conversations use one stable Claude identity per logical
conversation and at most two managed Codex snapshots in steady state. A cold
context migration can change the Claude local native ID without changing the
Desktop entry. It keeps
one durable signed checkpoint chain, one pending transaction, a persistent
private signing key, and bounded diagnostics. Losing the key blocks writes; it
does not silently generate a replacement for existing state. Restart recovery
checks native operation identities before a write and never blindly retries an
uncertain append. Native user turns are never interrupted for synchronization.

New Desktop installations select `contextMode: "archive"`. The complete portable
history is stored in authenticated, content-addressed `history-assets` under the
private state root. Native messages show deterministic readable excerpts, not an
AI summary: at most 128 KiB per view and 8 KiB per text excerpt, with exact source
indices and an explicit manifest path for details. Native-event/tool bodies,
images, and unshown text remain in the archive and must reconstruct the identical
canonical digest. Missing, changed, or wrong-root archives stop synchronization.
These assets are authoritative conversation content, not disposable rollback data.
Archive v2 uses shared pages of at most 64 message references and a small manifest,
so successive full checkpoints do not duplicate an ever-growing reference list.
Archive v1 remains readable and reproducible for existing prepared operations.
The v1 inline packet format remains readable; already prepared v1 transactions
keep their original encoding during recovery.

Desktop native history reads default to a 16 MiB byte budget and 100 turns per
page. The private state root's `config.json` can explicitly set
`nativeHistoryMaxBytes` (1024 through 67108864 bytes) and `nativeHistoryPageSize`
(1 through 100); for example, `67108864` and `5` support a larger bounded export
with smaller native response pages. Apply changes only when the watcher can
restart safely. Both original and managed Codex histories use these settings;
the 256-page, 25,000-item and 64 MiB WebSocket-frame limits remain unchanged.
Raw and converted histories must both fit the byte budget. Exceeding a limit
reports the source thread ID and stops that operation without retry, truncation,
fallback, or weakening authentication and canonical-history checks.

For an unmanaged Codex source, a native `localImage` may be recovered from the
current authoritative rollout's embedded input image even when its old attachment
file is missing. Recovery requires the complete native/API user item, thread and
turn identities, a unique earlier user response, exact text, and ordered image
wrappers with matching paths to agree. It reads only that owned regular rollout,
with no-follow opens, a stable file identity/stat check, a 512 MiB scan limit and
64 MiB row limit. It never opens the historical image path, fetches a URL or searches
`history_base` files. MIME/base64 validation and the configured converted-history
budget still apply. These are the persisted model-input bytes, not a claim that
the original upload was unresized. Ambiguous, missing or changed provenance remains
blocked; the source file is never rewritten.

An existing inline owner migrates only in a fresh, unexposed maintenance process
after its previous writer has actually exited. A connected owner's idle state or
Remote Control detach is not treated as an exclusive input lease. Maintenance
disables ordinary extensions only for that process, checks readable managed-policy
sources without overriding them, and refuses managed hooks, dynamic policy helpers,
MCP channels, active/background work, or an unfinished native input. The native
`/clear` command uses a verified no-query receipt, preserves the old native file,
and changes context without asking a model to summarize. The coordinator adopts
the new native ID before restoring the normal user/project settings and reconnecting
the same Remote Control entry. One sealed old native generation is retained;
another reset is refused until its safe retirement is implemented and verified.
No hot-reset or unbounded generation fallback is enabled.
After successful promotion, restarts open the verified archived generation with
normal user settings immediately; an incomplete reset still requires the isolated
maintenance profile and cannot be exposed as a normal session.
The owner explicitly enables native session-state events; even no-query work
emits running/idle transitions. Reset waits for its verified idle boundary,
while unexpected native identities never grant shutdown authority.

Claude-to-Codex delivery creates a new Codex continuation named
with the original conversation title, without a `[Claudex]` prefix; it does not
append into the original Codex task. After verifying and promoting the new
version, the bridge archives the superseded original through the native API.
The original's contents remain preserved, but it leaves the main task list.
Continue in the current same-title task after switching back. If a superseded
original is used again,
its changed history stops synchronization explicitly instead of being silently
ignored or choosing one branch. Resolve that conflict before further delivery
or backup collection; neither history is overwritten.

#### Daily desktop use

1. Work in Codex normally and wait for the current reply to finish.
2. In Claude Desktop's Code page, open the corresponding conversation marked
   **Connected via Remote Control**. Wait for the new history to arrive, then
   continue there. Ordinary Chat/Cowork conversations are not this bridge's
   synchronized entry point.
3. After Claude finishes, return to the current task with the original title
   in Codex. Do not resume the superseded original for the same work branch.
4. Repeat as needed. Both applications may remain open in Desktop mode, but
   send new work on only one side of a logical conversation at a time.

No per-repository bridge setup, manual import or routine command is required
after installation. Synchronization occurs at complete-turn boundaries, not
token by token; wait for delivery rather than assuming a fixed delay. The Mac,
background service and shared Codex backend must be available. Remote Control
also requires connectivity to the user's Claude account. Unsupported tracked
history or an ambiguous write stops safely instead of retrying blindly.

#### Starting in Claude Desktop

Claude Desktop's **Code > New > Local** is also a verified starting point.
On the pinned version it persists a Claude Code transcript in the configured
native `~/.claude/projects` store. The existing all-project watcher discovers
its completed turn, retains its title and creates the corresponding Codex
continuation automatically. No separate import or repository enrollment is
needed. A fresh native Desktop session, automatic Codex visibility and an
actual Codex reply recalling the Claude response have been verified.

The first return from Codex uses a **separate managed Remote Control session**
with the same logical title. It does not append into the original Desktop-owned
Local session. Continue in the entry marked **Connected via Remote Control**
after that handoff. The original Local entry remains preserved and is not
automatically archived or deleted; writing new work there after the handoff
causes an explicit original-history conflict. This is not in-place two-way
writing to the original Local session, and Codex's original-archival policy does
not apply to that Desktop-owned entry. Ordinary Chat/Cowork and remote-only
sessions without an accessible supported native transcript are outside this
verified discovery path.

#### Historical Local imports

`src/cold-import.mjs` provides an explicit module API for backfilling supported
old Codex conversations. It is not a public bulk-import CLI command and does not
change discovery's initialization cutoff. A private journal reserves one target
per source before publication, so a rerun reuses the same allocation rather than
creating duplicates or overwriting an existing native file.

The importer publishes a native Claude CLI transcript with a signed archive
packet, then `DesktopBridge.trackImportedPair()` verifies exact portable-history
digest, message count and project directory on both sides. The pair remains two
unmanaged originals, not disposable snapshots; Claudex never overwrites their
history. The runtime's `importPacket` path authenticates and reconstructs the
archive without starting a Claude SDK owner. Readable excerpts are not a model
summary or a claim that all archived content is rendered inline.

Publishing into `~/.claude/projects` does **not** make a Desktop entry visible.
The official `claude://resume` handoff must be accepted through native UI to adopt
that transcript as a Local session. Journal state `paired` means only that the
bridge verified both histories; `adopted` additionally requires read-only native
registry evidence. Verify the visible project, title and history in Desktop too.
No registry/database writes or private IPC injection are used. A real Local
import has passed this visible adoption check without requesting model inference;
this is not evidence that every historical conversation can be imported.

Continue a newly adopted import in its Local entry. A completed Claude turn can
produce the usual Codex continuation, subject to the unchanged original-archive
and dependency guards. Returning from Codex creates a **separate Remote Control
entry**: continue there afterward, leaving the Local original preserved. Further
work in the superseded Local original is an explicit conflict, not an automatic
merge. This is the same Local-to-Remote-Control transition described above.

New managed Remote Control entries are named **`[Claudex] <original title>`**
to distinguish the continuation from its preserved Local source. For example,
continue in `[Claudex] Ping` after replying in Codex, not the old Local `Ping`.
The logical title and Codex task names remain unchanged. Existing owners are not
bulk-renamed; an explicit rename in Claude's native UI is preserved when Remote
Control reconnects. Without the optional folder presentation adapter below,
Remote Control entries may be under **Other** or in **Search**, rather than
inside the Local project's group. Pinning, title prefixes, or a new same-name
custom group do not satisfy the folder-placement requirement.

#### Native folder presentation

The opt-in macOS adapter places verified Claudex Remote Control continuations
inside the **same existing Local project/folder group**. It keeps the Remote
Control identity and input route intact; it does not register a second Local
writer or move conversation files. It reuses the existing folder's actual key
and label, including repository-backed folder keys. Unknown, ambiguous, SSH/WSL,
or missing Local matches are left unchanged instead of guessing a destination.

Stop the watcher safely while Claude is idle, then run:

```sh
node bin/claudex.mjs desktop folders enable
node bin/claudex.mjs desktop folders status
```

Restart the idle Claude app once, then start the watcher again. New verified
owners subsequently update through a small private map without another app
reload. Native checks have verified cold startup and adding/removing an exact
mapping while the interface remains open, with the continuation in the original
`claudex` folder and its Remote Control route unchanged.

This is a **version-pinned presentation compatibility patch**, not an official
Claude folder-assignment API. It updates one Zstandard-compressed HTTP cache
resource, with validated stream checksums, exact source hash and anchor checks,
an immutable backup and a recovery journal under `ui-folder-compat`. It does not
modify the signed app, credentials, session registry or transcript. Node must
provide Zstandard and CRC32 support. The checked frontend asset is
`shared-23-Db0dcGkF.js`, original decoded SHA-256
`01bc6cf8d85b25edda8a396f00e664872a03288f6c06aff03d1aa0f2fa466ebf`.
Claude app/web frontend updates or cache eviction may require revalidation and
reinstallation; unknown assets are not patched automatically. Status reports
map/resource readiness, not which version a running renderer has loaded.

The watcher publishes `folder-map.json` atomically, using only verified current
owner IDs and canonical directories. The renderer uses Claude's existing guarded
read-only file API; no local HTTP server, credential copy or extra native worker
is involved. Pending transitions preserve the previous map. Missing/invalid data
disables the presentation override and reports a diagnostic.

To undo, stop the watcher safely and run `node bin/claudex.mjs desktop folders
disable`, then restart the idle Claude app and watcher. The map is cleared and
the exact original cache resource is restored only if the current file remains
installer-owned. Original conversations and backups are preserved.

Idle historical imports do not each reserve a long-lived SDK process. For these
`cold-import` pairs only, the watcher may skip repeated full reads after a
successful complete, unchanged verification. It compares every record, including
superseded originals, and file identities/timestamps before and after verification.
The default 60-second expiry makes another full check due. Errors, pending work,
changed or missing files invalidate those hints. Hints never advance a history checkpoint.
Once a current managed Remote Control owner exists, normal per-pass inspection
resumes and its native process remains long-lived; this is not a general owner
pool or an unlimited-active-session resource guarantee.

New conversations, active owners, and changed historical imports are checked
before unchanged historical imports. During the fair historical-validation sweep,
the watcher refreshes foreground synchronization between complete native
operations, with a default two-second interval. Discovery and newly enrolled
deliveries use a separate clock and also run between individual active-owner
checks, so a long foreground sweep cannot hold new conversations until its end.
Changed existing conversations also receive priority between native operations,
using file and lifecycle observations for scheduling only. This includes changes
in either current side or a preserved original. A boundary serves at most one
queued existing change before continuing the regular sweep; unchanged managed
owners are still fully checked, and repeated busy activity cannot monopolize it.
These refreshes are serial and nonrecursive; the original sweep keeps advancing.
Failed or incomplete dirty
checks keep their foreground priority until stable full verification succeeds.
The interval is not a delivery guarantee: foreground reads, a single in-flight
native operation, handoff verification, and app UI refresh still take time. The
bounded watcher status includes foreground and discovery completion/duration,
the maximum observed discovery gap, and the last and slowest complete sync
operation. These timings contain no transcript content and do not measure UI
refresh latency.

Large archived Claude histories avoid repeatedly decoding the exact same packet
within one stable snapshot and rehashing every earlier message for each delta.
The final full fingerprint still independently checks the result. Archive chunks
use at most four concurrent reads with all existing identity, permission and
content checks preserved; writes remain serialized. Nothing is cached across
snapshots, and missing or changed archive content still fails closed.

Backup collection reads both current sides of every conversation with a managed
snapshot, but does not export unrelated cold pairs that have no backups. A missing
or diverged current history still prevents retirement of that conversation's
snapshots. Superseded-original checks and the byte quota remain global; previous
snapshots retain their existing native identity, activity and dependency guards.

Missing project directories or required assets, histories without a complete
turn, and unsupported histories remain blocked and must be reported separately.
Active incomplete tails are withheld, not presented as imported work. Originals
and authoritative archive assets remain preserved; a partial batch is never
reported as an all-history migration.

#### Same-title handoff and preserved originals

New Codex generations use the stored logical conversation title. The bridge
checks that an original can safely leave the main list before allocating its
same-title replacement, verifies the complete replacement, then archives the
old entry. A durable archive intent makes recovery idempotent: an interrupted
archive does not allocate another generation or resend history. Publication
and archive are separate native operations, so a candidate can be temporarily
visible during a handoff; a failed handoff is not silently presented as complete.

Originals remain unmanaged and are never deleted by the backup collector.
There is one preserved original per enrolled source, not another original for
each round. Later generated snapshots still follow the bounded current/previous
retention policy. Active work, changed content, dependent forks or descendants,
and unverified auxiliary data prevent automatic original archival. Existing
conversations with such dependencies remain untouched; no dependency guard is
removed merely to produce a cleaner sidebar.

Earlier `[Claudex]` task names remain until their next safe Codex handoff; this
does not bulk-rename or archive existing sessions on installation. An older
pending transaction retains its saved name and archive behavior during recovery.
If an older preserved original has not been archived, it must pass the same
preflight before a new same-title generation is allocated.

Titles are display labels, not synchronization credentials. Native IDs, managed
records, authenticated packets and checkpoints identify each version. Removing
the prefix does not merge native sessions or update the superseded original.
Do not edit authenticated packet markers, native IDs or bridge state to rename
a conversation. Native UI renames are separate from the stored logical title
used for future generations.

A separately opened, user-authorized Desktop test verifies this same-title
workflow across two Claude-to-Codex deliveries and a Codex-to-Claude return.
The current and prior generated tasks retain the original name, the source
original and prior generation are archived, and only the current generation
appears in the main list. Original bytes, Claude's identity and the complete
logical history remain unchanged by the archival operations.

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
completed turns automatically. Original contents are preserved. The legacy
adapter leaves original entries visible; Desktop mode archives a verified
superseded Codex original as described above. Neither mode treats original
content as a disposable generated backup.

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

New Local Desktop sessions can use a UI UUID different from their native CLI
UUID. Ownership checks read the registry's `cliSessionId`, not just the
`local_<UI UUID>.json` filename. Archived records remain protected. Registry
reads are bounded and stable; malformed identities, linked or non-regular files
and symlinked stores refuse retirement instead of treating ownership as absent.
The verified Desktop-origin export above is read-only and does not establish
permission for an external writer to take over the Local transcript.

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
with zero inference turns/API time for each bridge append. The native receipt's
cost and model usage are cumulative across the session, including earlier real
replies; nonzero cumulative cost is not evidence that an import invoked a model.
Desktop mode wires this owner into the durable coordinator and background watcher.
Separately user-authorized app-level acceptance verifies real bidirectional replies.

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
Tasks opened by the native Codex app's `create_thread` tool can begin with a
delegated request stored as a function output. Only the exact initial
`codex_app.create_thread` envelope is accepted as that request boundary. Its
original role and full payload remain quoted historical data; the bridge does
not fabricate a user message or accept arbitrary assistant-only histories.

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

An exact completed turn containing only a `contextCompaction` item with `type`
and `id` may be retained as inert metadata after verified prior request context
and before a later completed assistant response. It is never an answer or a
publication boundary. Trailing control turns and any unfinished tail remain
withheld in completed-prefix mode; initial, mixed or malformed control-only
histories do not gain an exception to the normal completion checks.

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
Two real Desktop alternations with newly authored replies pass under explicit
user authorization. Each side recalled a value generated by the other from
imported history, without the value being repeated in its new prompt. Claude
kept the same Remote Control/native identity, while Codex used the then-marked
current checkpoints. A third Claude continuation exercised actual snapshot collection:
one current and one archived previous Codex snapshot remain, with the original
source preserved. Normal automated tests still never request model inference.

The real coordinator/SDK migration proof verifies a no-inference reset, exact
canonical history, stable Remote Control identity, restored normal execution
profile, and a subsequent archived delta visible in the same Claude Desktop
conversation after restart. This synthetic transport proof is separate from
the explicitly authorized model-generated Desktop acceptance above.
The live watcher has also migrated both real mirrored conversations, retaining
their canonical digests and Remote Control identities. The large conversation's
Desktop context changed from over-capacity to 41.1k/1M; full portable history
remains in the private archive. The older cloud-rendered messages remain visible
even though the active native context is smaller.

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
store; that sample is removed afterward. These no-inference tests are distinct
from the separately authorized live Desktop acceptance above. That acceptance
also verified a previously compacted real source, automatic history delivery,
same-ID Claude rendering, native snapshot cleanup and exact canonical equality.

`--root PATH` or `CLAUDEX_HOME` selects bridge state (default
`~/.local/share/claudex`). `init --codex-home PATH --claude-home PATH` selects
isolated native stores for testing. Runtime data stays outside the repository.

## References

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Claude storage and retention](https://code.claude.com/docs/en/claude-directory)
- [Thinking signatures](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [txcript usage](https://github.com/skillsynchq/txcript/blob/main/docs/usage.md)

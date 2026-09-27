# Claudex

Turn-boundary conversation handoffs between Codex and Claude Code. The legacy
mode uses local CLI sessions. Experimental Desktop mode keeps a native Claude
SDK owner connected through official Remote Control and shares Codex Desktop's
native backend. One-time historical imports can instead start as native Local
sessions without an SDK owner. Synchronization never requests model inference.
Remote Control does transmit the selected conversation to the user's Claude
account; it is not a local-only transport.

## Cross-model work protocol

`claudex collaboration` is an opt-in execution layer alongside history synchronization.
It provides one durable work graph for both delegation and whole-work handoff:
starting child work records its parent, while handing off changes the owner of the
same task. Both Codex and Claude Code can initiate either operation. This layer
requests real model inference and uses native account authentication; history
synchronization still never requests inference.

On macOS, install the independent broker and the `claudex-work` native MCP connection:

```sh
node bin/claudex.mjs collaboration install
node bin/claudex.mjs collaboration status
```

Native clients must reload their MCP connections through their supported lifecycle;
installation does not restart an active app or replace an ongoing conversation.
The broker also runs in the foreground with `collaboration serve`. Its `--root`
is a separate private work root (default `~/.local/share/claudex/collaboration`),
not the history synchronization ledger. Installation, startup, inventory and reads
do not invoke models. This service neither owns nor stops the synchronization watcher.

The MCP interface exposes:

| Tool | Operation |
| --- | --- |
| `claudex_start` | Start work with `provider`, `cwd`, `prompt`, and a stable `requestId`; worker calls create children. |
| `claudex_send` | Queue a follow-up for the next completed boundary of an existing task. |
| `claudex_handoff` | Transfer the same task to the other provider using its current `revision` and a handoff message. |
| `claudex_status` | Read progress, messages, last native identity and results. |
| `claudex_wait` | Wait up to 30 seconds for a revision change or terminal result. |
| `claudex_cancel` | Cancel owned work and its active descendants. |
| `claudex_list` | Read the bounded work inventory and broker limits. |

For example, ask Codex to “use Claude to review this change and bring back its
findings,” or ask Claude to “hand this work to Codex with the current progress
and remaining steps.” The caller supplies relevant context; this is not automatic
access to its private native conversation. A root caller obtains results through
status/wait. Inside managed work, each worker receives tools scoped to its own
task and descendants. Handoff preserves the task ID, messages and workspace, not
a native model session or UI chat ID. An external caller relinquishes its own
work by ending its turn; the protocol cannot forcibly stop an unrelated native chat.

A running worker's handoff is recorded first. The next owner starts only after
the outgoing native execution finishes successfully and its process group closes.
The outgoing worker must stop work after handoff acknowledgement. It cannot issue
further mutations with that generation's capability. No handoff occurs after a
failure or an uncertain outcome. Idempotency keys reject changed request payloads
and prevent duplicate dispatch; transport errors never cause automatic replay.
Follow-ups reconstruct the bounded work record in a fresh native invocation.

### Permissions and limits

The default is read-only. File editing requires a broker installed or started with
`--allow-write` **and** task `permission: "workspace-write"`. A child cannot elevate
its parent's permission or change its workspace. Use a dedicated checkout for
writable work: the protocol does not create worktrees, merge edits, or prevent an
unrelated editor from modifying the same files. Within a broker, overlapping
writable tasks in the same canonical directory are serialized. Writable delegation
returns `deferredUntilParentExit`: the parent ends its native turn to release the
workspace, the child runs, then the parent resumes with the child's result. This
also covers a read-only child of a writable parent. Read-only workers may run
concurrently. Waiting on a deferred child before releasing its workspace is refused.

Codex runs `exec --ephemeral --json` with an explicit native read-only or workspace-write
sandbox, user configuration disabled, and the collaboration MCP connection supplied
explicitly. Claude runs nonpersistent print mode with restricted file tools and
explicit MCP configuration. Its read-only mode has Read/Glob/Grep; its write mode
also has Edit/Write, **not Bash**. Unattended approval requests are not auto-granted.
These profiles do not inherit arbitrary hooks, plugins, MCP connections or model
settings. With no requested model, each native CLI selects its default. Workers
are instructed to read applicable repository guidance. Native account login is
reused without copying credentials; inherited API-key variables are removed.

Private Unix sockets, controller/worker capabilities, and generation checks prevent
accidental cross-task control. They are not a security boundary against hostile
processes running as the same OS user. Prompts and results are text-only, stored
under the private root, never in the repository. Native ephemeral/nonpersistent
sessions do not become synchronization sources. No Desktop renderer integration,
image transfer, exact native-context migration, or automatic source-chat archival
is implied by the work protocol.

Defaults allow three workers, delegation depth two, twelve native executions per
task, 1,000 tasks, 10,000 idempotency receipts and a 32 MiB ledger. Context and native
output are separately bounded. Capacity errors are explicit; no history or receipt
is silently pruned. Tasks time out after 15 minutes. These are execution limits,
not a monetary spending guarantee; native account quotas still apply.

After a broker crash, in-flight work becomes `uncertain` and blocks new dispatch.
No native input or pending handoff is replayed. Inspect the last recorded native
process/session and workspace before operator recovery; do not clear the ledger
to regain availability. Completed work remains readable. Cancellation targets only
the invocation's owned process group and does not undo file changes.

The protocol, native command profiles, cancellation and both-direction handoff
contracts have synthetic tests, plus a real broker/stdio MCP process smoke test
without inference. Separately user-authorized native acceptance on Codex CLI
`0.158.0-alpha.2.1` and Claude Code `2.1.283` verifies both directions of model-created
child delegation, exact child-result return, and a Codex-to-Claude-to-Codex whole-work
handoff under one logical task ID. Seven real native executions completed across
five task records in an isolated read-only workspace, with unchanged test files,
no replay, closed owned process groups, and no observed enrollment of the checked
native IDs by the history watcher. Existing native account logins were used.
Separately authorized writable acceptance on the same runtimes verifies both
directions of child file editing, parent yield and automatic resumption, and
Codex-to-Claude-to-Codex sequential edits of one file under the same task ID.
Nine native executions completed across five task records in a separate temporary
broker with writes enabled. Exact final bytes, one child per parent, recorded
parent/child execution ordering and exited process groups were checked. The
temporary broker was stopped afterward; the installed service kept its read-only
default. This validates bounded text-file editing, not arbitrary builds, shell
availability in Claude, Desktop UI chat transfer, arbitrary future runtimes, or
synchronization compatibility for every feature of these versions. Automated
tests still never start inference.

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

The service runs at login. `status` shows errors without transcript contents.
Unsupported histories found during discovery are left untouched and skipped,
so they do not stop unrelated projects. Status reports their count and at most
20 source paths/reasons; this diagnostic list does not accumulate over time.
In Desktop mode, recognized tracked-history conflicts and export guards pause
synchronization while keeping the watcher and existing Claude Remote Control
owners alive. Status reports `synchronization: blocked` for a coordinator-wide
hold or `degraded` for individually held syncs, with bounded reasons and the next
revalidation time. Revalidation is spaced at least 30 seconds apart; it does not
clear failed operations or resend uncertain inputs. A pending transaction blocks
all discovery, new syncs and collection until verified recovery succeeds. Without
a pending transaction, other conversations continue their normal checks, including
global original-history and quota guards that may still block new deliveries.
Unclassified unsafe failures stop the affected worker. The installed supervisor
restarts unexpected exits with 5/10/20/40/60-second backoff, preserving pending
work and checking writer locks first. Live native children, malformed locks or
uncertain child identities block another writer. Launchd also recovers supervisor
crashes without replacing a surviving watcher. This is process recovery, not
permission to resend an uncertain native write or choose a history branch.
`service stop` unloads it for the current login; `service start` loads it again.
`service uninstall` removes its LaunchAgent but preserves conversation data.
Only one watcher can run for a state root.

For a visible macOS menu-bar status and native notifications:

```sh
node bin/claudex.mjs status-app install
```

This builds and signs the small native app with a valid local Apple Development
identity and enables login startup. Approve notifications once when macOS asks.
The window distinguishes readiness, waiting, blocked recovery, offline processes
and stale status. **Notifications…** tests delivery; **Diagnostics** opens the
status files. Persistent alerts are debounced/deduplicated and recovery is also
reported, without including conversation content. Quitting the display leaves
synchronization running. Normal macOS Focus and notification settings apply.

An existing legacy original with completed spawned agents can be reconciled
using `archive-original CONVERSATION_ID --id NATIVE_ID` while the watcher is
safely stopped. The verified original and its direct spawned children are archived
through the native API with exact content preservation. Ordinary forks remain
unchanged. This is not bulk archival and does not relax deletion guards.

The current App's CLI entrypoint is
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`.
Claudex recognizes the old flat and new packaged layouts in the same App,
verifies the native OpenAI signature and preserves its signed Node runtime.
It never edits the App bundle or switches to an unrelated PATH binary.

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
AI summary: the text view is at most 128 KiB, with at most 8 KiB per text excerpt,
exact source indices and an explicit manifest path for details. Supported source
images and tool-result images also appear as authenticated native image blocks,
so the receiving model has actual visual inputs rather than only an archive path.
Native-event/tool bodies, original images and unshown text remain in the archive
and must reconstruct the identical canonical digest. Missing, changed, or
wrong-root archives stop synchronization. The full native packet, including
images, must fit the existing byte limits; oversize projections fail explicitly
without silently omitting or truncating images.
These assets are authoritative conversation content, not disposable rollback data.
Archive v2 uses shared pages of at most 64 message references and a small manifest,
so successive full checkpoints do not duplicate an ever-growing reference list.
Archive v1 remains readable and reproducible for existing prepared operations.
The v1 inline packet format remains readable; already prepared v1 transactions
keep their original encoding during recovery.

Image-bearing archive packets sign `imageProjectionVersion: 1`. Earlier
three-text-only packets preserved image bytes on disk but did not expose those
images to the receiving model; matching archive hashes alone did not prove visual
delivery. Explicit projection version `0` reproduces those older prepared
operations byte for byte. Only genuine source image blocks and standard
tool-result image content are projected; image-shaped objects inside arbitrary
tool inputs remain inert historical JSON.

Older managed image histories receive a one-time serial visual-context repair,
gated by the saved record's image-projection version. Codex receives a new bounded
managed generation; Claude receives a complete authenticated checkpoint in its
existing owner, without `/clear`, a model call or a new native/Remote Control ID.
`historyPrefixCount` binds the checkpoint to the exact prior canonical prefix:
only any genuinely new tail is added to logical history, never a second copy of
earlier messages. Normal activity, conflict, pending-operation and retention
guards still apply. Transport and digest checks must be supplemented with actual
model-input acceptance after deployment; they do not by themselves prove the
receiving model can see the images.

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

For a Codex original or a later turn in an owned continuation, a native `localImage` may be recovered from the
current authoritative rollout's embedded input image even when its old attachment
file is missing. Recovery requires the complete native/API user item, thread and
turn identities, a unique earlier user response, exact text, and ordered image
wrappers with matching paths to agree. After native rollover, previously verified
image-bearing rollout origins may also supply images inside the saved canonical
checkpoint. Their exact turn/item/message positions and full checkpoint digest
must still match; new image messages require current-rollout evidence. The ledger
retains only actual image origins across verified promotions, not every rollover,
and never commits later source origins beyond the copied checkpoint. Reads use
no-follow opens and stable file identity/stat checks across at most 256 exact
origins, a 512 MiB aggregate scan limit and 64 MiB row limit. Conflicting duplicate
proofs or partial provenance remain blocked. It never opens the historical image path, fetches a URL or searches
`history_base` files. MIME/base64 validation and the configured converted-history
budget still apply. These are the persisted model-input bytes, not a claim that
the original upload was unresized. Ambiguous, missing or changed provenance remains
blocked; the source file is never rewritten.
An owned bootstrap remains an inline signed checkpoint, not a candidate for
historical-path recovery. Adding another attachment after switching apps uses
the same current-rollout provenance checks and retains the exact earlier prefix.

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
2. In Claude Desktop's Code page, open the corresponding same-title conversation
   in the original project folder. With native folders and Local handoffs enabled,
   the superseded Local entry is archived after verification; no title prefix is
   needed to identify the continuation. Its native connection still uses Remote
   Control. Wait for delivery before continuing. Ordinary Chat/Cowork conversations
   are not this bridge's synchronized entry point.
3. After Claude finishes, return to the current task with the original title
   in Codex. Do not resume the superseded original for the same work branch.
4. Repeat as needed. Both applications may remain open in Desktop mode, but
   send new work on only one side of a logical conversation at a time.

No per-repository bridge setup, manual import or routine command is required
after installation. Synchronization occurs at complete-turn boundaries, not
token by token; wait for delivery rather than assuming a fixed delay. The Mac,
background service and shared Codex backend must be available. Remote Control
also requires connectivity to the user's Claude account. Recognized tracked-history
guards hold synchronization with explicit status while preserving live owners;
ambiguous writes are never retried blindly.

#### Starting in Claude Desktop

Claude Desktop's **Code > New > Local** is also a verified starting point.
On the pinned version it persists a Claude Code transcript in the configured
native `~/.claude/projects` store. The existing all-project watcher discovers
its completed turn, retains its title and creates the corresponding Codex
continuation automatically. No separate import or repository enrollment is
needed. A fresh native Desktop session, automatic Codex visibility and an
actual Codex reply recalling the Claude response have been verified.

The first return from Codex uses a **separate managed Remote Control session**
with the same title and no `[Claudex]` prefix. It does not append into the original
Desktop-owned Local session. With the opt-in native Local handoff below, the
verified Local predecessor is archived through Claude's own lifecycle API, and
the same-title continuation remains in its existing project folder. Original
contents are preserved, not deleted or rewritten. Opening an archived original
and adding new work still causes an explicit original-history conflict; it does
not merge branches. This is a same-title handoff, not in-place two-way writing
under the Local native ID. Ordinary Chat/Cowork and remote-only sessions without
an accessible supported native transcript are outside this discovery path.

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
entry** with the same title. Native Local handoffs can archive the verified Local
predecessor while preserving its contents. Further
work in the superseded Local original is an explicit conflict, not an automatic
merge. This is the same Local-to-Remote-Control transition described above.

New managed Remote Control entries use the **original conversation title**,
matching Codex generations. Existing owned names with the exact legacy
`[Claudex]` prefix are migrated through the live owner's native rename API.
The durable migration journal and native transcript proof prevent an ambiguous
rename from silently succeeding or being sent again. Unrelated manual names
are preserved, including on Remote Control reconnection. No standalone helper
appends rename metadata into a live transcript. Without the optional folder
presentation adapter below,
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
modify the signed app or credentials, or directly edit session registries or
transcripts. Optional native archival is the separate guarded action below. Node must
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
disables the presentation override and reports a diagnostic. When native Local
handoffs are enabled, separate verified identity anchors allow the original
folder grouping to survive archival of its last visible Local entry. The
renderer reads the archived native session and git metadata through the app's
existing APIs and its exact session normalizer; it does not invent a folder key
or create a similarly named group.

To undo, stop the watcher safely and run `node bin/claudex.mjs desktop folders
disable`, then restart the idle Claude app and watcher. The map is cleared and
the exact original cache resource is restored only if the current file remains
installer-owned. Original conversations and backups are preserved.
Disabling folders also disables native Local handoffs.

#### Native Local predecessor archival

After enabling folders, safely stop the watcher before changing this setting:

```sh
node bin/claudex.mjs desktop handoffs enable
node bin/claudex.mjs desktop handoffs status
```

Restart the idle Claude app after the cache adapter upgrade, then start the
watcher. The optional consumer uses Claude's observed native Local archive API,
not direct database, registry or transcript writes. Both newly promoted and
existing verified Local-to-Remote-Control pairs are eligible. It does not archive
unrelated sessions, rename manual titles or register another Local writer.

Before issuing an intent, the coordinator verifies the original against its own
complete saved checkpoint and the idle replacement against the current canonical
history. It binds the exact Local UI/CLI mapping, registered Remote Control ID,
cwd, title, last activity and original byte-prefix proof. Commands expire after
15 seconds; pending work and newly observed activity revoke them. The renderer
reads fresh Local state twice, checks title, identity, cwd, activity, idle state,
drafts and dependencies, and rechecks the command immediately before archival.
Because native session/transcript DTOs can report the Desktop UI ID instead of
the CLI ID, it also rereads the exact original registry JSON through the guarded
native read-only file API. The path must be beneath the pinned native registry
root with the exact Local filename; persisted UI/CLI IDs, cwd, title and activity
must match the intent. No registry or database file is modified directly.
Worktree cleanup is disabled. Archive outcome and original history preservation
must be verified; an unresolved action is not silently treated as completed.

Presentation anchors have a separate lifecycle: new work may retain a previously
verified grouping only while the current ledger, owner native/Remote Control
identity and original Local mapping still agree. An anchor never authorizes an
archive, and expired commands are never made actionable by retained grouping.
There remains **one fixed Local original archive per logical conversation**, not
another copy each round. It is not disposable quota data. Generated previous
copies keep the existing one-per-side, seven-day and aggregate 512 MiB bounds;
the audit remains capped at 50 entries.

This path is version-pinned and guarded, not an external writer lease. A manifest
or ready service is not native UI acceptance: verify the old Local entry is
archived, the same-title continuation remains in the original folder, and its
history still opens normally. Automated protocol coverage does not alone prove
those running-app results.

Native UI checks have verified existing Local predecessors and a fresh
image-origin Local predecessor become archived, while native titles use their
original names without the owned legacy prefix. Inspect the native **Active**
view when checking that only the current conversation is shown: **All** may
intentionally include the recoverable archived originals. No code hides those
rows or deletes their history. Prefix removal applies to conversation titles;
authenticated Claudex import labels and transport receipts inside history remain
unchanged.

To disable only automatic Local archival, stop the watcher and run
`node bin/claudex.mjs desktop handoffs disable`. This clears pending commands;
it does not unarchive predecessors, delete histories or change the current
Remote Control writer.

#### Scheduling and collection

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

Earlier `[Claudex]` Codex task names remain until their next safe Codex handoff.
Exact legacy owned Claude prefixes use the guarded native title migration above;
unrelated manual names are not overwritten. Existing verified Local predecessors
are eligible only when native Local handoffs are enabled and all guards pass. An older
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
superseded Codex original, and its opt-in native Local handoff archives a verified
Claude predecessor, as described above. Neither mode treats original
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
- Encrypted/empty summaries, Codex replacement histories, and general Claude
  preserved-segment chains are not transferable. The latest boundary controls;
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

SDK-owned Desktop conversations have an additional exact-history path. Fresh
native Claude compaction keeps the complete earlier authenticated canonical
prefix and the explicitly linked readable summary, then adds only a complete
continuation. Native UUID, parent, logical-parent, session and cwd links must all
agree; a summary cannot legitimize a missing, changed or duplicate earlier row.
The observed native `/compact` form that preserves one trailing SDK no-query
packet is supported only when both preserved-metadata objects identify that same
physical prefix row and its summary anchor, and the packet authenticates under
the existing conversation. It is counted once, not replayed as new history.
This narrow exception does not enable arbitrary preserved segments or opaque
history. Malformed references, unknown forms and incomplete tails still block
checkpoint advancement.

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

Automatic per-generation Local registration is not enabled. The legacy external
adapter has no writer lease or supported lifecycle that would make a registered
Local transcript replaceable or disposable. Importing each generation would
accumulate entries, and moving their transcripts away would break those entries.
It therefore refuses replacement or deletion of Desktop-owned transcripts,
including archived records, without editing the database or trust settings.

The separate opt-in Desktop consumer described above invokes the observed native
archive action from the app after verifying an independent Remote Control
replacement. This does not transfer Local write ownership or enable automatic
Local generation registration. Native authentication and workspace-trust
requirements remain unchanged, and there is no direct registry or private IPC
injection shortcut.

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

Large-attachment regression and isolated real SDK checks cover approximately
5.5 MiB PNG and JPEG inputs, later text-only deltas, a native restart, removal of
the temporary cache from the read path, and complete archived reconstruction.
The observed large PNG-to-JPEG preview conversion is accepted only with exact
PNG/JPEG magic bytes, the native paste identity, matching original intent and
preview hashes, and durable original-byte binding. Logical reads restore the
original PNG, not a recompressed replacement. Other format conversions and
ambiguous cache identities remain unsupported. These native transport checks do
not by themselves establish model visual understanding or arbitrary attachment
format support.

Separate real Desktop vision acceptance covers PNG and JPEG transfers in both
directions, followed by another large PNG added to an already continued Codex
task. The receiving models identify banner geometry, background and noise, and
retain the earlier test codes. Native app preprocessing can resize an upload
before Claudex sees it; the verified cross-app byte contract is the persisted
native model input, with complete originals retained for bridge-owned previews.

Native image-source sidecars are transport metadata, not new authored messages.
The decoder excludes only the exact pinned annotation associated with the same
authenticated packet and native prompt identity, preserving the next delta's
digest chain. Arbitrary metadata and ordinary user text are not discarded.
When that exact validated sidecar is the only trailing message after a no-query
image packet, full native graph and packet validation establish a completed
transport boundary. A genuine newer user turn still remains withheld.

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

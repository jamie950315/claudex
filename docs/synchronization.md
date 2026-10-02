# Conversation synchronization

[Back to README](../README.md) · [CLI-only compatibility](compatibility.md)

This guide documents Desktop setup and the native lifecycle, history and storage
contracts. Synchronization moves completed history without requesting model
inference. For model execution and delegation, use [collaboration](collaboration.md).
Run all commands from the repository directory.

## In this guide

- [Runtime compatibility](#runtime-compatibility)
- [Desktop integration](#desktop-integration)
- [Daily desktop use](#daily-desktop-use)
- [Background service and status](#background-service-and-status)
- [Bounded retention](#bounded-retention) and [recovery](#safety-and-recovery)
- [Native integration](#native-integration) and [compacted conversations](#compacted-conversations)
- [Claude Desktop boundary](#claude-desktop-boundary)
- [Verification](#verification)

## Runtime compatibility

Requires macOS and Node.js 22.15+ (22.x) or 23.8+. The earlier 22.x and 23.x
runtimes lack the Zstandard/CRC32 APIs used by the Desktop resource adapters.
The app supplies its own compatible runtime. Validated native baselines are Codex CLI
`0.155.0-alpha.16.3`/`0.155.0-alpha.16.4` and Claude Code `2.1.210`/`2.1.281`.
The default `versionPolicy: "strict"` enforces these baselines. An explicit
`versionPolicy: "warn"` attempts newer or otherwise unvalidated runtimes without
blocking synchronization solely on their version numbers. Both tools retain
their own authentication and permission settings.

## Desktop integration

Desktop mode's validated Claude baseline is CLI `2.1.281` with normal subscription
OAuth and SDK `0.3.281`; warn policy permits other runtime versions to be attempted.
It is integrated with the coordinator and background watcher.
Explicitly user-authorized acceptance has verified two real model-authored
Desktop roundtrips, continuation from a compacted source, stable Claude identity,
exact logical history equality, restart recovery and bounded Codex snapshot
retirement. Compatibility depends on the pinned native versions and the supported
formats and lifecycle states documented below. Real two-application acceptance
does not remove these version and ownership requirements. Install it only in a
state root without CLI-only tracked conversations; automatic CLI-only migration
is refused.

For a fresh state root (do not reinitialize an existing configuration):

```sh
node bin/claudex.mjs init --all-projects
node bin/claudex.mjs desktop install
node bin/claudex.mjs service install
```

Installation enables all-project discovery and configures the native
`CODEX_CLI_PATH` override for the next normal Codex Desktop start. Installation
never quits or restarts a running application. The existing watcher waits without
enrolling sources until the verified shared backend appears. On subsequent logins it
restores only its own launcher override; a different existing override is never
overwritten.

macOS can reopen Codex Desktop at login before LaunchAgents run, so that process
starts without the launcher and never reads the override. The desktop watcher
detects this exact bypass (a direct native `app-server` child and no launcher
child) and restarts Codex Desktop once per process: a normal quit request, then a
background reopen, as soon as it is detected. It waits only until the override is
active and no Codex turn is running: no hook turn has started since that process
launched without completing, and no rollout was written in the last minute. User
activity does not delay it. A declined quit is never forced or retried. The current state is in `desktop-relaunch-status.json`. If the LaunchAgent is already installed, use `service start` after
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

### Version-only enforcement

```sh
node bin/claudex.mjs version-policy warn
node bin/claudex.mjs version-policy strict
```

The first command opts out of version-only blocking for Codex, Claude Code and
the Claude owner SDK. Unvalidated Codex versions keep shared transport instead
of entering native-only mode, and Claude owners attempt the existing protocol.
The legacy policy name `warn` is retained, but unfamiliar version numbers do not
emit warnings or warning events. Actual protocol, history, schema and ownership
failures still surface normally. `doctor` retains verification provenance as
diagnostic information rather than treating an unvalidated version as a fault.
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

Managed Claude owners start only for delivery, required maintenance/recovery or
an explicit owner wake. Startup/reconnection verification, idle assertions and
maintenance discovery do not start stopped current owners. They validate matched
saved state under the native writer lock (live foreign locks refuse the read), use
stable no-follow transcript snapshots and retain archive, image restoration and
preserved-generation checks. Unfinished tails remain withheld; pending appends
or resets require recovery. Already-running owners retain their live checks.
A process unused for `claudeOwnerIdleSeconds` (default 900; 60 through 86400) is
closed while the watcher waits for events, unless it is busy or a handoff is pending. The next
delivery or required maintenance/recovery starts it again with the same Remote
Control identity; while it is closed, that conversation's Claude Desktop entry
is not connected. With the pinned owner activation adapter loaded, opening or
submitting to an exact managed
entry can also reconnect that owner without a Codex connection (see below).

Codex Desktop stores a screenshot of the browser or app surface with every
Browser Use and computer-use call so its own window can preview the tool. That
picture is not part of what the model saw (the call's own result keeps any
model-visible image), yet it can make up most of a long history. Conversations
enrolled from this version on replace exactly those display screenshots with a
record of their type, size and SHA-256 hash; everything else is kept. Conversations
already being synchronized keep their existing representation.

For a Codex original or a later turn in an owned continuation, a native `localImage` may be recovered from the
current authoritative rollout's embedded input image even when its old attachment
file is missing. Recovery requires the complete native/API user item, thread and
turn identities, a unique earlier user response, exact text, and ordered image
wrappers with matching paths to agree. Mixed local attachments and inline images
keep their native order. Inline bytes remain those in the full API item and exact
persisted user completion; a resized model-input image never replaces them.
After native rollover, previously verified
image-bearing rollout origins may also supply images inside the saved canonical
checkpoint. Their exact turn/item/message positions and full checkpoint digest
must still match; new image messages require current-rollout evidence. The ledger
retains only actual image origins across verified promotions, not every rollover,
and never commits later source origins beyond the copied checkpoint. Reads use
no-follow opens and stable file identity/stat checks across at most 256 exact
origins, a 512 MiB aggregate scan limit and 64 MiB row limit. Conflicting duplicate
proofs or partial provenance remain blocked. It never opens the historical image path, fetches a URL or searches
for rollout files. A forked or rolled-over Codex conversation can inherit images
from earlier rollouts: those are read only through the exact `history_base`
references the conversation declares, located by their segment ID, limited to
the referenced rows (by native row ordinal) and checked against the thread they
belong to. MIME/base64 validation and the configured converted-history
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

### Stop tracking while preserving history

Stop the owned watcher normally before changing enrollment. In Desktop mode,
`untrack` accepts the exact logical conversation ID shown by `status`:

```sh
node bin/claudex.mjs untrack CONVERSATION_ID
```

This stops synchronization and removes the conversation from folder and Local
archival presentation. It preserves every native original, generated snapshot,
logical checkpoint, record and authoritative content asset. Its native identities
remain excluded from all-project discovery, including after a restart. The command
refuses a live watcher or pending transaction and revokes existing Local archive
commands before saving the stopped enrollment. A missing saved working directory
does not require a substitute directory or native history edits.

Stopped snapshots are retained even if the directory returns. Previous snapshots
and dependency anchors still count toward the existing backup quota; stopping
tracking does not grant deletion or hide quota exhaustion. To restore the saved
enrollment explicitly, stop the watcher and run:

```sh
node bin/claudex.mjs resume-tracking CONVERSATION_ID
```

Resumption verifies preserved originals, dependency anchors and current histories
under their normal identity and lifecycle guards. Missing directories, changed
prefixes, incomplete turns or independently advanced current branches leave the
conversation stopped. No branch is selected and no replacement is allocated by
the tracking command.

### Preserve an independently continued original branch

If a superseded unmanaged Claude original and the current managed pair have both
continued after the same saved prefix, an explicit `split-original` operation can
enroll the original as a separate logical conversation. First inspect both branches
and record the exact completed original checkpoint. With the watcher stopped:

```sh
node bin/claudex.mjs split-original CONVERSATION_ID --id ORIGINAL_NATIVE_ID \
  --record-id ORIGINAL_RECORD_ID --expected-count MESSAGE_COUNT --expected-digest SHA256
```

The operation requires the exact logical, native and ledger record identities and
the inspected message count and digest. It requires the same saved working
directory and verifies the original's saved prefix,
an idle unchanged managed Codex/Claude pair, genuinely independent continuations,
and stable native bytes before moving only the original's enrollment. Native
histories and the current pair's canonical checkpoint remain unchanged. A durable
receipt makes the same request idempotent. Pending work, stopped enrollment,
uncertain identities, imported originals, non-independent histories or concurrent
changes refuse the split. This is an explicit preservation repair, not an
automatic history merge or permission to discard a branch. The returned new
conversation ID receives its counterpart through normal guarded synchronization.

### Daily desktop use

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

### Starting in Claude Desktop

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

### Historical Local imports

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
matching Codex generations. Existing owned names with the previous
`[Claudex]` prefix are migrated through the live owner's native rename API when
it starts for work; verification alone never starts an owner to rename it.
The durable migration journal and native transcript proof prevent an ambiguous
rename from silently succeeding or being sent again. Unrelated manual names
are preserved, including on Remote Control reconnection. No standalone helper
appends rename metadata into a live transcript. Without the optional folder
presentation adapter below,
Remote Control entries may be under **Other** or in **Search**, rather than
inside the Local project's group. Pinning, title prefixes, or a new same-name
custom group do not satisfy the folder-placement requirement.

### Native folder presentation

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
an immutable backup and a recovery journal under
`ui-folders/9cebfb8fc5a9f22f_0/ui-folder-compat`. Earlier resource journals and
originals are preserved. It does not
modify the signed app or credentials, or directly edit session registries or
transcripts. Optional native archival is the separate guarded action below. Node must
provide Zstandard and CRC32 support. The checked frontend asset is
`shared-19-DDVvTIwQ.js`, cache file `9cebfb8fc5a9f22f_0`, original decoded SHA-256
`c036136315a82ada3fcca90ea62ed77c5696d49c97509b186364cf0ad9713784`.
Setup and `desktop folders enable` advance the exact previously supported
`15bc54146dcdb4ce_0` configuration path after successful installation. Unknown
custom resource names are refused; failed installation preserves the previous configuration.
Explicitly disabled folders and native handoffs stay disabled during setup.
The watcher retains its configuration for its current run; after deployment and
successful path migration, restart it only through the normal verified service
shutdown/start workflow so it reads the new resource path. Do not terminate busy
native owners to apply this presentation update.
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

### Activating a disconnected managed owner

Graphical setup installs a separate pinned conversation adapter alongside the
existing `claudex-desktop-wake` MCP endpoint. When the Code component
mounts or changes its current session reference, or its native submit callback runs, the adapter checks
the fresh private `folder-map.json` for that exact RC identity. Only verified
published IDs qualify; titles, unrelated sessions and prompt content are never
used. Only native `bridge` session references qualify; their `session_` ID is
normalized to the published `cse_` ID. The submit signal runs before native early
refusals, without awaiting, replacing or retrying the native send.
It reads `Oe()`, the native current-reference getter also used by send, rather
than the submit closure's captured `X`. This keeps a retained callback bound to
the current selection after a pane/session change.
Requests are debounced for five seconds per identity and bounded to sixteen
identities in a thirty-second window. There is no periodic owner keepalive.

The identity-only `claudex_desktop_owner_wake` tool uses the already attached
user-config stdio client from the native renderer registry: `Ga` in
`shared-common-mcp-msg-4-EwhHCIE8.js` looks up its exact UUID
`claudex-desktop-wake`. Require the pinned open MessagePort transport and the
Claudex server identity/capabilities. Local/Cowork session proxy clients are
refused; the adapter never connects, replaces or closes clients or changes
connector approval. An absent/closed/unvalidated client produces a bounded
diagnostic without another transport or retry. The existing
Claude controller capability authenticates publication to the private durable
event inbox. Separate owner-wake keys cannot replace completion/started hints.

`LocalAgentModeSessions.directMcpCallTool` addresses the separate managed/builtin
direct registry, which excludes this user-config stdio server. Its
`mcp-not-connected` refusal precedes device-grant inspection. Calling its
authorize API cannot attach an unknown stdio server. The chat-wake consumer's
`LocalSessions.mcpCallTool` reaches the shared stdio pool after checking its own
Local identity; that identity cannot be borrowed for RC owner activation.

The watcher processes the hint under coordinator ownership before checking Codex
transport. It revalidates a unique current tracked pair, saved RC/native owner
registration, project and native path identities, and pending, blocked, retired,
alias, relocation and app-stop guards. It starts or activates that exact owner's
normal execution profile without title reconciliation, synchronization or archival
proof renewal, and refreshes its idle timer. Normal native startup validation still
applies. Claude's own RC connection delivers any native queued user message;
Claudex submits no message.
Rejected hints are consumed with bounded status diagnostics, without recovery or
automatic retry. Hints wait for the watcher's current operation boundary; this
does not guarantee a reconnect deadline during long native operations.

The checked Code asset is `cc43287c9-6nYyeS-m.js`, decoded SHA-256
`62d14b5c968d83d64bc392656dafa4a5610409ad9757e168be6b7367a466a35a`,
cache file `6ce7062c8d22ac79_0`. Its immutable original and recovery journal live
under `ui-owner-wake/6ce7062c8d22ac79_0/ui-folder-compat`, independently of the
folder and chat-wake resources. Exact source, unique component/submit anchors,
cache checksums and installer ownership must match; unknown bytes fail explicitly.
A normal idle Claude restart is needed to load an installed patch. Cache eviction
or a vendor update requires revalidation. A cleared/unavailable folder map disables
these hints even when the resource remains installed.

The Code route `c11959232-Dt6Kvr8c.js` imports this asset. Its `o8` component
provides the current `X.id` and `X.type`; the shared Chat/Cowork `FM` component's
`conversationUuid` is not the Code RC view. The earlier
`shared-16-B0kpSitB.js` owner-wake bootstrap can load successfully while its
hooks never run for Code. Preserve its resource journal and immutable original;
the new pin uses a separate journal. The frontend entry `index-DaQFBRai.js`
also loads the current folder and chat-wake resources, but not the previously patched
`shared-16-K1Vl3wzJ.js`, `shared-18-BYDVwU8Z.js` or `shared-23-Db0dcGkF.js`.
Those files can still match their installed journals while having no effect on
this frontend. Source/cache validity alone must not be reported as renderer
reception. The native stdio client receives
`callTool({name: "claudex_desktop_owner_wake", arguments: {remoteId}})`.
In Claude Desktop 2.9939.4, duplicate generic connect requests invoke the native
launcher, which intentionally closes its previous transport before replacement.
The observed first-attach warning is accompanied by that native shutdown and a
successful replacement initialize/list; it is not a Claudex endpoint self-exit.
The independently connected LocalMcpServerManager pool also remains separate
from the direct registry. Check the subsequent
`initialize`/`tools/list` and the exact `claudex_desktop_owner_wake` `tools/call`.

After deploying the updated bundle, the coordinator installs with:

```sh
/Applications/Claudex.app/Contents/Resources/runtime/bin/node \
  /Applications/Claudex.app/Contents/Resources/engine/bin/claudex-app.mjs setup \
  --root "$HOME/.local/share/claudex"
```

Then restart Claude only at an idle boundary and open a managed conversation in Code. In
`~/Library/Logs/Claude/claude.ai-web.log`, expect
`[Claudex owner wake] loaded cc43287c9-6nYyeS-m.js`,
`[Claudex owner wake] started`,
`[Claudex owner wake] native APIs map=available mcp=available`,
`[Claudex chat wake] loaded shared-18-C2EdCha1.js`,
`[Claudex chat wake] started`, and
`[Claudex folder mapping] loaded shared-19-DDVvTIwQ.js`.
These lines prove only bootstrap execution. The Code asset may load lazily;
the earlier shared-16 bootstrap's lines are not acceptance of the new Code pin.
Selection should then report `signal selection received`, `matched published`,
`mcp lookup`, `mcp connected`, `called` and `accepted` under the same prefix.
Submit uses `signal submit`;
an overlapping signal reports `ignored pending` or `ignored debounced`.
Unpublished or non-RC sessions report `ignored unpublished` or `ignored non-rc-session`.
Failures report fixed stage labels such as `map-read-failed`, `map-invalid`,
`mcp-api-unavailable`, `mcp-lookup-failed`, `mcp-not-connected`,
`mcp-client-unvalidated`, `mcp-grant-refused`,
`mcp-call-failed` or `receipt-invalid`; known broker refusals report `deferred`
with a bounded reason. Diagnostics never include session IDs, paths, native error
text or input content. Repeated lines are limited to once per second and all
runtime diagnostics to 64 lines per thirty seconds, without timers or retries.
Opening an evicted managed conversation should produce an owner-wake MCP call and increase
`watcher-status.json.ownerWake.handled`/`woken`; verify the same native/RC identity
and actual reconnect. Submitting user input is a separate authorized live check.

Automated acceptance is synthetic, with an isolated real-cache installation
check and no inference. Live owner-wake, folder and chat-wake reception remain
unverified for these new pins:
confirm the native configured stdio client is attached, opening an evicted owner and submitting a queued
message with Codex unavailable, same RC/native identities, app-stop refusal and
subsequent idle eviction. Cache installation alone is not that acceptance.

### Native Local predecessor archival

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
disposable copies keep the existing one-per-side, seven-day and aggregate 512 MiB bounds;
the audit remains capped at 50 entries.

This path is version-pinned and guarded, not an external writer lease. A manifest
or ready service is not native UI acceptance: verify the old Local entry is
archived, the same-title continuation remains in the original folder, and its
history still opens normally. Automated protocol coverage does not alone prove
those running-app results.

Native UI checks have verified existing Local predecessors and a fresh
image-origin Local predecessor become archived, while native titles use their
original names without the previous owned prefix. Inspect the native **Active**
view when checking that only the current conversation is shown: **All** may
intentionally include the recoverable archived originals. No code hides those
rows or deletes their history. Prefix removal applies to conversation titles;
authenticated Claudex import labels and transport receipts inside history remain
unchanged.

To disable only automatic Local archival, stop the watcher and run
`node bin/claudex.mjs desktop handoffs disable`. This clears pending commands;
it does not unarchive predecessors, delete histories or change the current
Remote Control writer.

### Scheduling and collection

Idle historical imports do not each reserve a long-lived SDK process. For these
`cold-import` pairs only, the watcher may skip repeated full reads after a
successful complete, unchanged verification. It compares every record, including
superseded originals, and file identities/timestamps before and after verification.
The default 60-second expiry makes another full check due. Errors, pending work,
changed or missing files invalidate those hints. Hints never advance a history checkpoint.
Once a current managed Remote Control owner exists, normal per-pass inspection
resumes when synchronization needs it. Its process starts on demand and remains
subject to the idle eviction described above; there is no unlimited-active-session
resource guarantee.

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
Full fingerprints hash the same canonical JSON one message at a time, avoiding
an additional history-sized string while retaining existing checkpoint digests.
Raw archive reads verify the bound manifest, ordered pages, every chunk, portable
message shape and full semantic digest without regenerating the archive tree.
Custom message resolvers still require independent deterministic archive binding.

The coordinator overlaps the two current Codex/Claude history inspections while
holding the same operation lock. Global superseded-original checks use batches
of at most four independent inspections, after the existing dependency-anchor
checks. All started reads finish before an error leaves the lock or any next
batch, maintenance, allocation or native write begins. Errors retain input order;
partial results never authorize a handoff. Concurrent Codex reads wait for one
complete transport initialization, including its identity and configuration
checks. A failed initialization reaches every waiter; it never replays work.

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

A trailing native task notification on an unmanaged Claude original does not
require a reply when its system/task-notification provenance, transcript-only
flags, matching enqueue/dequeue evidence and parent chain from the completed
assistant are verified. It remains ancillary evidence in the unchanged native
original; the completed canonical checkpoint is unchanged. Ordinary user input,
ambiguous evidence and actual unfinished responses still wait. If Claude later
answers the notification, that completed continuation is handled normally,
including the existing independently-advanced-history conflict checks.

### Same-title handoff and preserved originals

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
Exact previous owned Claude prefixes use the guarded native title migration above;
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
configuration to CLI-only mode after the watcher is stopped. It does not delete
native conversations or Desktop state. Existing Desktop history is not migrated
back into the CLI-only coordinator. This rollback does not alter a running app.

Existing conversations can be enrolled explicitly:

```sh
node bin/claudex.mjs track --from codex --id CODEX_THREAD_ID
node bin/claudex.mjs track --from claude --source /absolute/path/to/session.jsonl
node bin/claudex.mjs sync CONVERSATION_ID --from claude
```

`track` returns the logical conversation ID. The watcher handles subsequent
completed turns automatically. Original contents are preserved. The CLI-only
adapter leaves original entries visible; Desktop mode archives a verified
superseded Codex original, and its opt-in native Local handoff archives a verified
Claude predecessor, as described above. Neither mode treats original
content as a disposable generated backup.

## Background service and status

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

An older preserved original with completed spawned agents can be reconciled
using `archive-original CONVERSATION_ID --id NATIVE_ID` while the watcher is
safely stopped. The verified original and its direct spawned children are archived
through the native API with exact content preservation. Ordinary forks remain
unchanged. This is not bulk archival and does not relax deletion guards.
This explicit cascade operation is validated on Codex `0.155.0-alpha.16.4`,
`0.158.0-alpha.2.1` and `0.159.2`. Isolated `0.159.2` native checks preserved
parent and child bytes and full history, kept active and archived ordinary forks
unchanged, and recovered a lost archive receipt after restart without repeating
the archive request. These checks use synthetic histories without inference;
they do not extend the general synchronization runtime allowlist.

The current App's CLI entrypoint is
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`.
Claudex recognizes the old flat and new packaged layouts in the same App,
verifies the native OpenAI signature and preserves its signed Node runtime.
It never edits the App bundle or switches to an unrelated PATH binary.

## Bounded retention

Per logical conversation, the steady-state managed set is:

- One current Codex projection and one current Claude projection.
- At most one previous projection per side.
- Previous projections expire seven days after retirement, subject to a global
  512 MiB backup budget. Current conversations are never deleted for a quota.

Independent snapshots therefore have at most four managed complete copies in steady state. A transaction
can temporarily add one candidate; an error stops further allocation. The
original enrolled session is separate and is never counted as disposable data.
Actual new conversation content naturally grows; this is not a cap on current
history or on the native applications' own operational logs and caches.

An owned Codex snapshot with native spawned children or forks is not disposable
rollback data. After verifying its exact authenticated checkpoint, stable raw
bytes and dependency inventory, Desktop mode preserves it as a
`dependency-anchor` without archiving, deleting, loading or editing its children.
The promoted replacement and source prefixes are rechecked before the same
transaction completes; recovery never resends that handoff. Such anchors remain
visible native histories and are never automatically demoted or expired, even
if their children later disappear. They still count toward the same 512 MiB
backup budget, with a hard maximum of 64 anchors globally. New allocation is
refused when these bounds cannot be met. The ordinary one-previous-per-side and
seven-day limits continue to apply to disposable snapshots. Missing or changed
anchors block synchronization instead of silently selecting a branch.

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
6. Preserve a verified dependency-bearing Codex version as an anchor, or hide
   the independent previous version; prune only verified independent backups.

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
archive/delete APIs manage owned generations. This path is version-gated. It does not use `externalAgentConfig/import`, so repeated handoffs do not
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

Native Claude originals (for example a Desktop Local conversation compacted with
`/compact`) retain their complete readable history, so a preserved segment there
only refers to rows that already exist before the boundary. It is accepted when
those rows appear exactly once, form a contiguous chain ending at the boundary's
logical parent, and are anchored to its summary; the summary is added as labeled
text and nothing is replayed.

## Claude Desktop boundary

The CLI-only watcher targets Claude Code CLI storage, **not the Claude Desktop
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

Automatic per-generation Local registration is not enabled. The CLI-only external
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

`src/claude-owner.mjs` provides Desktop synchronization: a persistent native
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

Claude Desktop forks are separate conversations. A fork file is named for its
own session but begins with the parent's rows copied under the parent's session
ID. It enrolls under its file identity only when those copied lines are a
byte-identical prefix of the parent transcript in the same project directory,
followed at most by identity-free metadata, and all later rows use the fork's
own ID. The parent may continue growing. A fork without its own completed reply
waits; a missing parent, edited copied row, extra authored parent row or third
session identity remains an unsupported source. The parent is never modified.

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
An initial goal can instead be persisted as `goal.internal_context`, which the
native display API omits. The bridge reads only the authoritative owned rollout
and requires its exact initial active goal, marked context, thread/turn/project
identities, all displayed assistant completions and final completion boundary.
Both API passes must retain the same source inode and goal prefix. The objective
is preserved as a separately labeled inert historical event; no user message is
invented and the goal is not executed. Missing proof, altered history or a
different native shape remains an explicit unsupported source.

For native resized PNG/JPEG previews, the owner verifies the exact original
against its pending intent and Claude's private input-image cache. It retains
original bytes once in a private content-addressed asset store and binds the
persisted preview hash. Logical history therefore remains lossless even when
the Desktop displays a smaller native preview. Source and native transcript
files are not rewritten. Missing or changed assets fail explicitly. These
originals are conversation content, not expiring rollback copies; identical
images deduplicate and image-free sync rounds do not add asset records.

The cache location follows the native owner's `CLAUDE_CODE_TMPDIR` setting and
current UID; it is not tied to a particular home or project. When the observed
native CLI creates an owned project directory with mode `0755` below its private
`0700` per-UID cache root, the bridge verifies that directory's opened and named
identities and tightens it to `0700` before capturing the image. Public roots,
writable projects, symlink aliases and unexpected modes are refused. A refused
or interrupted capture preserves the pending intent; restart verifies the same
native append without resending it. Once the original is durably bound, later
reads no longer require the temporary native cache.

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
the persisted API, unlike the older display event encoder. A signed imported
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
## Completion-driven synchronization

Desktop mode uses completion hooks and native lifecycle events instead of a
recurring two-second conversation poll. `Stop` wakes only the affected conversation;
`UserPromptSubmit` disarms the previous completion's late-write observer. Native
SDK/app-server notifications feed the same durable, identity-only event queue.
A private Unix socket wakes the worker; events remain stored if the worker is down.

The watcher performs one startup/reconnection reconciliation and otherwise sleeps.
A completion signal may precede the final transcript write, so it retains normal
complete-turn and idle-destination checks, with at most three short event-scoped
follow-ups and exact-file notifications. Hooks never force a write, choose a branch,
or replay uncertain work. Idle health timestamps are refreshed every 30 seconds
without inspecting histories. This is not a two-second delivery guarantee.

Graphical setup merges the publisher into existing native settings. For an existing
Desktop CLI installation, run `claudex hooks install` and inspect with
`claudex hooks status`. In Codex, review and trust the exact Claudex definitions via
the native `/hooks` interface; configuration alone is not proof that hooks can run.
Do not use a hook-trust bypass. Existing user hooks and native credentials remain
unchanged. The installed command is synchronous, bounded and returns no model
instructions; it only records session identity and the event type.

Authorized live native-model checks verify Codex-origin and Claude Code-origin
replies are delivered automatically, including a new Claude conversation created
while the watcher is idle. A Codex continuation recalled the Claude reply from
the synchronized history without receiving the token again, and its real reply
was delivered back to the managed Claude session with equal canonical histories.
These checks used isolated read-only test projects; they do not claim a separate
Claude Desktop UI reply was generated.

## Restart verification and unchanged history

An unchanged cold-import pair with two verified unmanaged originals can reuse a
signed local verification proof after restart. The watcher checks native metadata,
the exact ledger and transcript identities, and all verified archive file identities
without re-exporting and decoding the full history. The first run after this feature
is installed establishes proofs through normal complete verification. Changes to
history, dependencies, native state, decoder code or relevant configuration require
full verification again; elapsed time alone does not discard an unchanged proof.
An ordinary proof miss proceeds directly to full verification. Successful refreshes
replace the proof once; failed reads durably revoke it even if the old context later
returns. This avoids flushing a tombstone immediately before every successful refresh.
An inactive original's unchanged unfinished tail remains withheld. Reusing its
already verified canonical prefix never sends that tail or marks it complete.

Managed owners and pending operations retain their full native lifecycle guards.
Proofs never authorize writes, history promotion, archival or snapshot collection.
They contain metadata, not copied messages, and have a 64 MiB aggregate limit.
During the cold backlog, discovery and changed conversations are refreshed between
operations instead of repeatedly checking every unchanged active conversation.
An assistant-first Codex history without supported initial request provenance
remains explicitly unsupported. It does not enroll or restart the whole watcher;
an already tracked conversation with that error remains individually held.

## Native project relocation

When Claude Desktop moves a tracked Local conversation to another project,
Claudex can follow its native CLI session identity to the new project. The native
registry must identify one exact destination, the previous transcript must be
absent, and the complete previously synchronized history must remain unchanged.
Claudex preserves historical working-directory fields and original content.

An unchanged managed Codex counterpart is replaced through the normal guarded
snapshot flow in the new project, including when no new message was added.
Existing snapshots retain their original working directory and rollback guards.
An active or independently changed counterpart, ambiguous native mapping,
modified history, imported bootstrap original, or pending handoff is not forcibly
redirected. Source changes during verification wait for a stable boundary.
Moves back to an earlier project root and imported bootstrap originals remain
guarded rather than guessing which native location is authoritative.
This does not move project files or rewrite native conversation stores.

Codex conversations are followed the same way when Codex itself moves one to a
renamed project directory. The saved directory must be gone or be an alias of the
new one, and the synchronized history must be unchanged. Because a Claude
conversation is tied to its project directory, Claudex then retires the old
Claude counterpart (it is closed and kept, including its Desktop entry, which you
can archive yourself) and creates a new one in the new project with the complete
history. A cold-imported Claude original is kept unchanged as a preserved original
in the same way. A saved directory that still exists separately is treated as another
project and remains paused rather than guessed.

A native no-inference relocation check verified a moved Local original, preserved
all original transcript bytes, and advanced both sides from 258 to 300 canonical
messages through one new-project Codex snapshot. The pending transaction completed
normally. This is history-delivery evidence, not a new model-generated reply test.

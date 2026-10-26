# Claude frontend adapters and renderer maintenance

Contributor rules moved out of AGENTS.md; they are binding. Scope: Owner wake, frontend graph discovery, the folder/chat-wake/commands adapters, binding resolution, cache journals, renderer maintenance, the automatic Desktop restart and the build verification script.

The Code owner-wake adapter resolves the native session component structurally:
initialSessionId/sessionType, submitMessage/getComposerSnapshot, the asynchronous
send's waitForImagesReady and the expression through which it reads the current
session. That read is a getter call whose stored reader returns the selection, a
retained React ref's .current, or a composition of both. A retained ref needs
the public useRef import, a selection seed and an effect mirroring that
selection; its only other uses may be .current reads. A bare use is an escape
and any other write a rival; both refuse. Reads of different selections refuse.
The same reference supplies selection and native send; signal submit before
early refusals.
Require unique complete binding relationships, never select the shared Chat/Cowork
view or a wrapper merely exposing a similar submit interface. Never await or retry
native send. Resolve the exported exact-UUID lookup by its read-only getState,
Object.entries(localClients), uuid/client destructuring and exact UUID return.
Import that already attached user-config stdio client lookup from the current
reachable module. Preserve the runtime's open MessagePort transport and Claudex
server identity checks; native session proxy clients are refused. Never connect,
replace or close a client, change connector approval, borrow a Local session,
inspect prompt content or send model input. The managed/builtin directMcpCallTool
pool is separate and must not be used. Independent ui-owner-wake/<cache filename>
journals preserve earlier originals and receipts.
Owner-wake inbox keys stay separate from completion hints. All tracked-pair,
registration, canonical native-path, pending/block/retired/alias/relocation and
app-stop guards remain unchanged. Owner activation refreshes idle eviction without
Codex transport, sync, archival proof publication or queued-message replay. Native
RC owns delivery. Promoted recovery reconnects the normal owner without a cached
handle. Ignored hints have bounded diagnostics, no automatic wake retry.
Owner discovery shortlists modules/components by role markers, then requires one
complete identity/send/client proof. Bindings are resolved by declaration through
`crates/claudex-app/src/frontend_scope.rs`, never by comparing minified names: hoisted vars,
catch/loop/pattern bindings and nested writes all count, properties and unrelated
parameters do not. A name injected into vendor code is checked at the scope it is
placed in. Callbacks are found by following values, not shapes: a binding is
every function its declarators and plain assignments can give it, and exactly
one must remain. Compiler memo forms are transparent. A cached slot counts only
when every write to that slot in the component stores the same callback, directly
or through an identity helper whose range covers it. A module helper is an
identity when its own body returns one argument unchanged, writes only into its
first argument and has no call, closure, free name or parameter write; loop and
branch shapes are free. Which dependencies invalidate a cache, and what else a
fresh branch does, cannot change which function a binding holds and are not
compared. Never choose a callback by argument position. Named re-export
resolution is bounded to eight modules, value flow to twelve bindings and 96
steps; cycles, missing chunks, multiple proven targets and unknown semantics
remain refused. Keep all compiler branches and native source unchanged.
Everything injected into vendor code contains its own failures: signals and
store calls catch, bootstraps fall back to inert objects. A wrong anchor or a
broken runtime may lose a Claudex signal; it must never stop a native send, a
render or a vendor module's evaluation. This containment is the reason the
proofs may generalize, not a substitute for them.
Rust frontend module tests exercise synthetic component, binding and compiler
forms: every accepted form must retain native behavior and never signal a
session the send did not use. Extend these contracts when recognizing a new
construct. Before changing recognition, also run
`dev/verify-claude-frontend-builds.mjs` over the saved real build corpora and
compare selection and native wiring with the previous accepted metadata;
an unexplained difference is a regression.
The native LocalSessions switch report (reportSwitchInitiated) carries a session
ID and type, but it is gated telemetry, absent from the August builds and has
no counterpart for a Remote Control send. It is not a wake source.
The identity-only search diagnostic is not runtime activation proof. This changes
no idle eviction, retained-owner count, UI, native input or model work.
Reuse the graph's required syntax pass for compact exported-binding provenance,
keyed by its exact module/source snapshot. Do not retain whole dependency ASTs
or native initializer payloads. Parse the exact helper/lookup definition only
when its body supplies proof; release the graph after normal installation.
The publisher reads the ledger without the coordinator lock, so it normally
sees another conversation's delivery in flight. It still publishes the durable
hint (every other check applies); the watcher handles it under the lock and
keeps refusing a transaction that is really left pending.
An opened conversation shows as disconnected until its owner starts, and one
delivery can hold the coordinator for a minute, so a hint is not left until the
pass ends. The watcher also serves hints between the operations of a pass, and
the bridge reports boundaries inside a long locked operation (`boundary`, the
watcher's `interlude`): every native read so far is complete, nothing is pending
and no write is in flight. A hint served there runs under that same lock with
the ledger loaded there and every guard above, sequentially, never beside the
operation. The conversation the operation is working on is excluded: its hint
stays in the inbox for the watcher. A hint served there is acknowledged at once;
the other control events still wait for the pass. Never start an owner outside
the coordinator lock, and never report a boundary while a transaction is pending.

`crates/claudex-app/src/frontend_graph.rs` discovers the latest fetched index entry from the
private HTTP cache using verified Chromium HttpResponseInfo response timestamps,
never filesystem mtime (patches change mtime). Require a unique newest entry and
its root bootstrap. Follow literal static/re-export/dynamic imports within the
exact Anthropic assets origin; only reachable cached modules qualify. Missing
lazy chunks are counted, never fetched or replaced with an older graph. Cache
recency cannot prove which graph a running renderer has already evaluated.
Resolve LocalSessions from its globalThis["claude.web"] binding/export/import and
React hooks from their public getter, definition and export/import relationships.
Also accept the observed two-expression LocalSessions initializer containing
only a discarded globalThis["claude.web"] read followed by that exact optional
native API access. Other hosts, calls and additional expressions remain refused.
The folder adapter requires the unique repoInfo/isScratchWorkspace/environmentId
project-key function and sidebar sessionStatus/hasActiveSessions/disambiguationText
aggregation. Retain its native key/label fallback. Older keys can instead call
their exact one-return local-or-CLI type helper and retain the native cwd branch. Changed,
async or shadowed helpers remain refused. Broader folder role markers require
one complete grouping/key/native proof among competing modules. Extend its compiled memo
cache with the map subscription version. Older conditional bindings retain a
compiler and an uncompiled implementation: validate and patch both branches of
the one exact binding, including useMemo's version dependency; never choose a
branch from host feature flags. Split builds export a pure grouping helper and
one separately proved React consumer. Keep hooks only in the consumer; prepare
the exact native rows before key lookups and invalidate all key/group memo guards
with one subscription version. Import injected hooks under reserved Claudex
aliases: a proved module-level minified alias can still be shadowed by component
parameters or later lexical declarations. AST preservation and syntax checks do
not prove lexical resolution; exercise shadowing and verify the restarted native
renderer before claiming UI acceptance. Preflight both complete candidates, publish the
helper before its consumer, and restore dependent consumers before the helper.
Each resource retains its own immutable original and recoverable journal; a
partial pair is never ready. This is still restart-required, not live-load proof.
When the native sidebar exposes a common group-mode dispatcher, prove its
`groupBy`/`ctx` route, the context's `allRows`/`projectSectionRows`/`kind` fields,
the Code project route back to the existing folder consumer and its pure native
Code-row projector. Subscribe at that common component for Code only: project,
state and other group modes must not determine whether archival is consumed.
Context aliases are bounded to eight declarations; an older compiler memo
requires its unique object write and exact cache-slot store/read roundtrip,
with no rival context or slot writes. Never treat an alias as an absent mode.
Chat/Cowork keep an inert subscription. Keep the existing project consumer for
folder projection, but its filtered subset must not replace the common
component's full handoff inventory while any common-mode listener is active.
The common context's `allRows` is still presentation data: native status,
environment and age filters can remove a valid replacement before grouping.
Where the native sidebar supplies its existing `rawCodeSessions` React context,
read that nearest provider instead. Prove the unchanged native data parameter,
exact raw binding/provider/import, unique public `createContext([])` factory
and public `useContext` getter/export chain. Import the read hook and context
under reserved aliases and call the hook unconditionally; only Code supplies
the resulting normalized rows to the existing store. Keep native presentation
rows and filters untouched. This inventory covers native loaded pages, not an
assertion that every server session is loaded. Where the already imported native
Code metadata module exposes its exact-ID no-store GET reader, native DTO
normalizer and bridge classifier, prove those bodies and reuse that reader as
the replacement authority.
From the 2026-10-21 graph the reader's API base constant and organization
header factory are imported by name from a shared module. Follow only that
unique named import to its module-level declaration and apply the same literal
and one-parameter header proofs; a local declaration beside the import, an
unresolved import or a changed definition refuse. Capture raw fetch, active organization, Code-enabled
and cloud-access hooks from the native prefetch/exact-ID lookup caller; import
them under reserved aliases and invoke hooks unconditionally. Supply the reader
only in Code mode. Read only the valid intent's ID, require native Code/cloud
access, normalize before checking exact ID/title/unarchived bridge identity,
and read again before the final Local/manifest rechecks. A source/account change
fences in-flight reads; equal source tuples do not cancel ordinary renders.
Native absence, failure, access refusal or mismatch never falls back to visible
rows. Older graphs without this capability retain their existing row proof.
Graphs fetched up to 2026-10-17 declare the prefetch caller as a module-level
`var` arrow function rather than a function declaration; the same unique
prefetch proof covers both forms, and the reader, normalizer, classifier and
lookup remain function declarations. Graphs fetched up to 2026-10-15 have no
browser-only guard before the reader's request; the request, failure and
return proofs are unchanged, and any other extra statement still refuses.
Graphs fetched up to 2026-10-14 also prefetch the session's events with the
same headers: every authenticated prefetch request must use one raw fetch
binding, and requests through different callees refuse.
The 2026-10-12 graph index-CWtaU7tp.js constructs the raw Code context in a
module the folder helper does not import; it stays refused rather than gaining
a new vendor import edge.
Do not guess endpoints, paginate inventories, invoke owners or start model work.
Both use one store and poller; each actual subscription owns an idempotent
cleanup token, even when callbacks are identical. The last common listener
restores an existing project listener's rows; the last total listener stops
work. Do not retain a background consumer after native unmount. Older graphs
without the common dispatcher retain their proved project-consumer path;
ambiguous or disconnected new routing fails explicitly.
The 2026-10-19 graph creates its Code project/environment components through a
local factory instead of naming the project component directly in that table.
Follow the factory only when its immutable declaration synchronously returns
one component without other statements, its arguments are inert boolean/null
constants (including minified numeric negations), and that component's sole
return is a call through the same native JSX binding. Follow that returned
component's existing JSX route to the proved folder consumer; unrelated calls,
reassigned factories and disconnected routes remain refused.
Graphs are bounded to 2,048 cached modules and
2,048 missing imports (observed older entries reach 1,171 cached modules).
By user decision, each cache file and decoded/patched JavaScript source is
bounded to 4 MiB, shared by the codec and installer snapshot reader. Retain the
256 MiB graph cache-byte limit. HTTP length digit changes require the observed
HttpResponseInfo v3 pickle flags (0x82476d03, extra flags 6), its length-prefixed
raw header string and four-byte alignment. Update header/payload/footer lengths
and checksums, preserving native timestamps and the entire opaque tail; unknown
resize layouts remain refused. Historical source profiles use reconstructed
containers, not evidence of historical renderer evaluation.
The independent chat-wake adapter uses the session-action module's unique native
import binding and optional forkSession capability relationship (older branches
repeat the same read, and strict undefined comparisons may reverse operands),
reopenClosed and amber_tributary_lantern_overview_toggle shortcut anchors. The
2026-10-08 build moved the shortcut and reopen handlers into other chunks: when
no reachable module carries all three markers, the target is the single module
that passes the structural proof (unique native import plus its optional
forkSession capability read). Builds that still carry the markers keep the
marker selection, because several of their modules pass that proof; two proven
modules without markers require one further unique, exact native fork action:
an optional imported fork alias, immediate null guard, fresh local UUID and
awaited four-argument fork request with the same native reference. This
distinguishes the observed August shortcut-help reads from its session action;
missing or competing action proofs remain skipped. For the 2026-10-08 build,
the target is the folder resource, so the shared combined recipe applies. Folder
bootstrap no longer embeds another chat-wake consumer.
The chat wake starts when its module is evaluated, so only modules the entry
loads through static imports and re-exports are candidates; a module reached
only through import() is never one, cached or not. From 2026-10-08 the lazily
loaded keyboard shortcuts dialog carries all three markers and passes the
proof. It enters a cache once the dialog has been opened and, before this
rule, then replaced the real target while still reporting installed. In all 21
saved builds (2026-09-24 to 2026-10-10) the correct target is in that static
closure of 61 to 68 modules, and the rule changes no other selection.

Renderer wake publication caps the actual serialized manifest at 64 messages and
240 KiB, including metadata. Publish count/total/eligible/omitted/unavailable,
byteLimit and nextPublicationAt; the publisher's diagnostics also expose bytes.
Rotate eligible recipients fairly across bounded pages when capacity omits any,
skipping an oversized candidate rather than hiding every later recipient. The
broker owns one metadata-only timer: rotate backlog after five seconds or publish
at the earliest queued expiry, whichever comes first. Clear and fence it on
close/app-stop, and republish through normal startup/resume/send/receipt paths.
Publication rechecks the current queued identities under the mailbox lock after
awaited native mapping reads; a lifecycle fence runs immediately before writing.
This timer never claims a message, retries a native send or relaxes idle/draft
guards. Unavailable pre-claim recipient metadata does not block independent
later candidates. Retain attempted claim identities until their original expiry
across page rotation; an omitted page is not permission to retry an unknown
claim. New Claude wake messages capture the selected route (default mod-self);
existing absent per-message routes retain legacy renderer semantics.

The observed August owner component is wrapped by the uniquely imported public
React.memo with exactly one component argument and no comparator. Only that
wrapper exposes the component to the existing identity/send/client proofs;
arbitrary helpers and imperative forwarding wrappers do not qualify. A block-local
binding that reuses the ref's minified name is another declaration and never one
of the ref's uses.
Builds fetched from 2026-10-09 read and write compiler memo slots through
helper calls: changed(cache, i, ...deps) ? store(cache, i, ...deps, value) :
cache[n], with helpers that differ in where the value sits and may nest. The
owner-wake callback is the argument the helper's summary returns, whatever other
functions the call receives. The folder consumer accepts
the helper form of its grouping and key memo guards, with the same four
dependencies, store index and result slot; the extra version slot and guard
edits are unchanged. Earlier slot-by-slot builds keep their exact checks. Every adapter's entire
transformed module must pass Acorn syntax validation before any cache publication.

The independent `commands` adapter journals the exact LocalSessions cold-command
query under `ui-commands`. Desktop's temporary catalogue disables hooks, so it
cannot run the Mod's session.start registration. For a sessionless local query
only, advertise the literal `/claudex` panel command when the native catalogue
already advertises `claudex:claudex-workflow`. This is presentation metadata, not
activation or execution authority. Preserve live-session lists, native errors,
existing commands/aliases and exact cwd/session routing.
The observed nested async query retains the same single-return native request
and two-parameter cwd/session routing proof; enclosing native-binding shadows
remain refused. Preserve the outer catalogue's native errors and result checks.
Never enable hooks in the temporary query, create a model session, replace a
native command, install a same-name prompt skill, or change submission/dispatch
to make the item appear.
Use reserved identifiers and the normal original/journal and reload boundaries.

`crates/claudex-app/src/frontend_maintenance.rs` is owned by the normal Desktop watcher under
watch.lock. It performs one startup cache pass, then debounces cache-directory
notifications and serially re-discovers/reapplies all enabled adapters. Exact
metadata/key hints suppress unchanged JS entries and unrelated HTTP/image writes;
anonymous notifications still recheck the graph. Hints never authorize patches.
Failed or partially refused passes discard unchanged-asset suppression evidence;
the next JavaScript cache hint revalidates through the normal guarded installer.
Do not schedule polling or retry timers. A missing cache entry or changed graph
during discovery permits one immediate full rediscovery in the same pass; a
second failure stays explicit until another native event. While that one immediate
rediscovery is scheduled, report checking, not ready or a request for user action.
Desktop rewrites its cache for some seconds while it starts (observed: both
discoveries met an eviction, the next cache event recovered ten seconds later),
so a refusal made only of those transient codes keeps reporting checking for
sixty seconds from the first one. One timer ends that claim and publishes the
explicit refusal; it inspects nothing and retries nothing. A coherent pass or a
permanent refusal ends it at once.
An app-stop hold reports held until its existing release-triggered discovery completes;
never record that normal lifecycle fence as a frontend failure or poll its release.
Mixed permanent refusals still degrade; genuine map/history errors keep priority.
Retain one bounded lastFailure with fixed phase/code/times for the current maintenance
process, including recoveredAt after a coherent pass; no native error text or paths.
Failure diagnostics expose fixed phase
and reason codes, never native error text, paths or cache keys.
Classify missing native cache resources separately from missing known manifests or
immutable originals; recovery-evidence loss never gets the cache-eviction retry.
After interrupted cache discovery or adapter publication, retain full-revalidation demand for the next
cache-entry hint, including an unknown filename already evicted. Discarded
observations cannot classify that hint as unrelated. Clear this demand only
after a coherent pass; healthy unchanged/unrelated-hint suppression stays intact.
Per-adapter refusals retain fixed failure codes so a native publication race is
not mistaken for a permanent refusal; missing recovery evidence is never retried
as a native eviction.
Keep the folder map publication result separate from the renderer-resource
overlay. Cache status changes refresh only that overlay through existing status
heartbeats, not history reads, map/handoff publication or proof timestamps.
Renderer recovery cannot clear a genuine mapping error or deferred map state.
Subscribe to app-stop.json through the event source's shared root watcher before
the initial hold check. Graphical resume starts services before clearing that
hold; its release must trigger renderer revalidation without cache activity,
history synchronization or a timer. Close the subscription with maintenance.
Existing normal native folder cache configurations opt in; graphical setup records
rendererAdapters.enabled. An explicit false disables automatic cache maintenance.
A disabled folder choice stays disabled. Cache maintenance reads no conversation
histories and does not renew archive intents, advance checkpoints, start owners,
run inference, restart services or reload apps. The 30-second status heartbeat
remains status-only. Check app-stop before publication and stop/drain cache work
before releasing watch.lock. Bounded renderer-adapters-status.json and watcher
rendererAdapters report matched/installed/skipped assets and activation limits;
folder status also exposes this maintenance report.
Partial refusals publish `refusedAdapters` and retain every adapter's status,
fixed failure code and activation. The native health summary reports degraded or
skipped maintenance even when folders succeeded; it never turns an unrelated
chat/owner/command failure into a folder-map error. Prepared files with
`load-not-verified` activation remain explicit in advanced diagnostics, separate
from synchronization health and actual recipient/delivery proof.

Each resource uses <adapter>/<cache filename>/ui-folder-compat, with adapter
ui-folders, ui-chat-wake or ui-owner-wake, an immutable original and a
prepared/installed journal.
Older graphs can share one folder/chat resource. The all-adapter installer
combines both complete transforms in one transaction and owns its immutable
original/journal under ui-folders/<cache filename>/ui-folder-compat. A disabled
folder choice installs chat only there. Individual adapter calls refuse a shared
resource without the explicit combined/chat-only mode. Restoring that shared
resource restores both transforms; earlier independent journals remain intact.
While the folder adapter cannot be matched on a graph, chat wake installs under
its own ui-chat-wake journal. Once both match the same resource, the
all-adapter installer first restores the vendor bytes through that independent
journal (only while its own patch is the installed bytes), then installs the
shared recipe; the independent journal is kept. Chat-wake restore uses
whichever journal currently owns the cache.
Normal graphical chat setup passes the saved folder choice to that shared recipe;
explicit folder enable selects the combined recipe. Never remove an enabled
folder patch merely because chat setup runs before synchronization setup.
Observed source hashes bind recovery evidence, not a checked-in allowlist.
Never overwrite foreign changes or prune earlier generations. Re-discovery reads
validated originals for installed/prepared generations; reinstall is idempotent.
Restore uses the journal-bound original URL/hash, including older resources.
The watcher receives notifications after cache writes: it cannot guarantee that a
new asset is patched before the renderer first evaluates it. A new installation
is restart-required; unchanged cache is load-not-verified, never proof of live
reception. By user decision `crates/claudex-cli/src/claude_relaunch.rs` makes that restart
once, automatically, only while Claude Desktop has just been opened: every
enabled adapter is installed for the entry and at least one was written since
the watcher started (or saved by an earlier watcher: claude-relaunch.json keeps
the entry, its written adapters and the last write time until Desktop has been
started after that write, another frontend replaces it or the restart is made),
the single verified Desktop process is at most one minute
old, no Claude prompt was submitted since it started and Claudex is not stopped.
A Code session process beneath it is not work: Desktop starts one for the
session it reopens (observed eight seconds after launch, before any input). It quits through the application
(never a signal), reopens it, records the attempt in claude-relaunch.json and
never restarts more than twice in ten minutes. Each restart answers one write
and Desktop must be newly started, so that limit ends any loop after two
restarts; a frontend may use both, which loads a file that arrived after the
first. A declined quit, or one whose outcome was never recorded, is final for
its frontend. Outside that window the user performs the restart and
the resource stays restart-required; no other automatic reload or quit exists.
rendererAdapters.relaunchAfterUpdate: false disables only the automatic restart.
Whenever the user must restart instead, the decision is published as watcher
claudeDesktopRestart {entry, requiredSince, reason, notBefore?}: requiredSince is
the last write, and a still-incomplete adapter set is held back until Desktop is
no longer newly started. No pass may follow a manual restart, so the reader ends
the request: the status model asks only while the running Desktop was launched
at or before requiredSince, shows "Restart Claude to finish updating" as an
attention state below real synchronization problems and sends that text as the
notification. A Desktop started after the last write is `current`. When the
controller reports `relaunched` or `current`, maintenance republishes the pass
with those adapters as load-not-verified. A Desktop restart changes no frontend
file, so unrelated cache writes ask the controller again (at most every ten
seconds, only while a restart-required label is published); this inspects no
cache entry and never reports another write. The production watcher
supplies the controller; tests inject process data and never touch a real
application. Composer drafts are not observable from outside the renderer.
Unsupported structural/API changes remain explicit skipped adapters.

Each resource logs its bounded loaded asset name, the command catalogue as
`[Claudex commands] loaded <asset>` when its module is evaluated; owner/chat wake also log started.
These lines prove bootstrap execution, never native receipt or owner reconnect.
Owner wake keeps API availability, exact stdio lookup/connection and selection/
submit received, matched, ignored, called, accepted/deferred or fixed failure
reasons. Never log native error/receipt text, IDs, paths or input. Limit duplicate
lines to once per second and runtime diagnostics to 64 per thirty seconds, without
diagnostic timers/retries. Synthetic, syntax and copied-cache checks are not live
renderer acceptance. Earlier native reception evidence remains historical; each
new graph requires separate live reception acceptance before claiming delivery.
Local archival adds `[Claudex native handoff status]` with fixed content-free
subscription, rows, manifest, anchor-read, replacement/guard, dispatch and outcome
phases. This diagnostic repeats each code at most once per five seconds, with
the same 64-per-thirty-second cap. Callback failures are contained; phase reports
add no native calls, archive authority, timers or retry. An evaluated folder
module is distinct from a started subscription, a finished native read and a
verified archive outcome.

The frontend engine is Rust: `crates/claudex-app/src/frontend_*.rs` owns graph
proofs, selection, transformation, installation and maintenance. The six files
under `crates/claudex-app/host/renderer/` are injected browser-host runtimes,
not another engine. JavaScript developer tools download/copy assets, run the
Rust checker and independently inspect its output with Acorn and `node --check`.
They never import the archived JavaScript engine.

Build the developer checker explicitly before using these tools:

```sh
npm ci --include=dev
cargo build --locked -p claudex-app --example frontend-check
node dev/verify-claude-frontend-builds.mjs --last-builds 2 --report /tmp/frontend-report.json
```

Both checkers and `dev/frontend-watch/watch.mjs run|regress` use the already-built
`target/debug/examples/frontend-check`, or an absolute `--rust-checker` override.
A missing executable fails with the build instruction; no tool implicitly runs
Cargo or switches engines. The service needs the development dependencies for
its independent Acorn checks. For a persistent service or large real corpora,
explicitly build with `cargo build --locked --release -p claudex-app --example frontend-check`
and pass `--rust-checker /absolute/checkout/target/release/examples/frontend-check`;
the optimized codec and proofs avoid development-build overhead. The legacy
`--rust-only true` verifier option is accepted for existing callers; all modes now use Rust.

`dev/verify-claude-frontend-builds.mjs` inventories real cached entries and all
current/legacy renderer journals through the Rust checker, validates immutable
originals, and copies exact reachable graphs into temporary homes. It runs the
production Rust selection, complete transforms and installer, `node --check`,
and independent AST/native-preservation/wiring contracts. It proves idempotent
reinstall, unchanged journal bytes and exact container restoration. With at
least two selected entries, actual `fs.watch` notifications feed production
Rust maintenance in the isolated home and prove reapplication without changing
earlier originals or receipts. A selected adapter refusal explicitly skips the
transition and keeps the report failing; it never waits for an impossible ready
state. One selected entry has no transition claim.
Every mutation operation of the developer checker requires the explicit private
sandbox marker and root/home descendants; ordinary inventory/check operations
never write into the supplied native home or state.

The historical hand-pin JavaScript oracle is archived on
`codex/javascript-legacy`, not loaded from Git and executed by this checkout.
Every legacy journal is still validated and inventoried, including resources
not selected by a current graph. Obsolete shared Chat/Cowork owner-wake pins are
not equivalent to the required Code/attached-stdio design: keep their evidence,
never restore directMcpCallTool or the wrong component to pass acceptance.
Only metadata reports survive. Vendor modules are never evaluated; the checker
performs no inference, app/service control or live cache/state mutation. List
exact missing assets and explicit failures.

`dev/check-claude-frontend-entry.mjs` checks one named entry without Claude
Desktop: it downloads the complete published import graph from the public
asset origin, then passes the exact static module list to the same Rust
resolver and transforms. Independent syntax and wiring contracts inspect the
returned sources. Published-graph bounds are developer-only; they do not relax
production cache bounds. Exit status 0 means every adapter passed, 1 an adapter
failed, 2 the graph was unavailable; never treat 2 as an adapter failure. The
entry name must come from a real Claude Desktop (renderer status `entry.asset`):
the page naming it sits behind a browser check, which must not be circumvented.
A published graph is a superset of any cache (2,558 to 2,919 modules against about
1,200 cached), so selections must not depend on which lazy chunks a user loaded;
a difference between cached and published targets is a selection defect. Keep
its vendor-code store outside the repository and publish only metadata reports.
It proves selection and transform, never real-cache installation or reception.

`dev/verify-rust-frontend-fixtures.mjs /absolute/frontend-check [/absolute/report.json]`
checks the synthetic compiler, conditional, shared, split and helper-call forms
through that same copied-cache route. Competing actions and ambiguous helper
forms must be refused by exactly the affected adapter; a refusal is not a
positive transform acceptance. The host tests in
`test/claude-frontend-{published-check,watch}.test.mjs` cover the Rust tool bridge,
copy/install/notification/restore path, queue/report behavior and missing-checker
failure without model inference.

dev/frontend-watch/watch.mjs is the maintainer service around that check, for a
machine without Claude Desktop. `submit` queues an entry name once, `run`
checks every queued entry and keeps one report per entry, and `regress`
rechecks every reported entry with the current checkout: an adapter that
passed must pass again with the same vendor file and hash, while an entry that
failed may now pass. Reports identify `engine: "rust"`; regression rows expose
`baselineEngine` and `currentEngine`, with earlier unlabelled reports identified
as `javascript-legacy`. The regression acceptance rule is unchanged. An unavailable graph stays queued and is never reported
as a failure. `sightings` lists when each source first reported each entry, so
sources can be compared by how soon they see a new frontend. Entry names come only from real Claude Desktop installations
(observed identical on macOS and Windows for one build); the service never
requests one from claude.ai. A failed entry starts the executable named in
CLAUDEX_FRONTEND_ON_FAILURE once. on-failure.sh only notifies; by user
decision (2026-10-22) the service never starts a model to draft a repair. A
maintainer repairs the adapters and verifies them in a real Claude Desktop
before release. Host names, paths, schedules and
notification settings are deployment details and stay out of tracked files.
dev/frontend-watch/read-windows-entry.ps1 reads the newest entry name from a
Windows Claude Desktop, read-only. Windows keeps its HTTP cache in the
blockfile format, where the entry was not found by name after an app update
(2026-10-12, Claude 2.31226.1: 1,003 module keys, none of the entry or the
modules it loads statically). The script code cache beside it uses the
simple-cache v5 header with keys of the form `_key<URL> \n<top origin>`, and
holds the entry Claude Desktop evaluated. Compare its magic as bytes: Windows
PowerShell reads the 64-bit literal as a negative number.

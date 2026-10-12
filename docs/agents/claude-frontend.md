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
src/claude-frontend-scope.mjs, never by comparing minified names: hoisted vars,
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
test/claude-frontend-mutations.test.mjs inserts one or two binding forms into
synthetic components: every accepted mutant must behave exactly like its
unpatched source and never signal a session the send did not use. Extend its
names, forms and places when a new construct is recognized. Before changing
recognition, also run dev/verify-claude-frontend-builds.mjs over the saved real
build corpora and compare the patch each build receives with the previous
resolver; an unexplained difference is a regression.
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
hint (every other check applies); the watcher handles it under the lock after
that delivery and keeps refusing a transaction that is really left pending.

src/claude-frontend-graph.mjs discovers the latest fetched index entry from the
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

src/claude-renderer-maintenance.mjs is owned by the normal Desktop watcher under
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
reception. By user decision src/claude-desktop-relaunch.mjs makes that restart
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

dev/verify-claude-frontend-builds.mjs is a developer-only static acceptance script.
It inventories real cached entries and all current/legacy renderer journals,
validates immutable originals, copies exact import graphs into temporary homes,
and runs production discovery/installation plus node --check and AST/wiring
comparison. It compares historical hand-pin transforms with the current runtime
supplied to both, excluding diagnostic label spelling, and exercises actual
fs.watch re-application, original/receipt preservation, reinstall and restore.
It never executes vendor modules, performs inference or mutates live cache/state;
only metadata reports survive. List exact missing assets and explicit failures.
Obsolete shared Chat/Cowork owner-wake pins are not equivalent to the required
Code/attached-stdio design: report their refusal/comparison failure and preserve
them, never restore directMcpCallTool or the wrong component to pass acceptance.

dev/check-claude-frontend-entry.mjs checks one named entry without Claude
Desktop: it downloads the entry's complete published import graph from the
public asset origin and runs resolveClaudeFrontendAdapters, the production
transforms, node --check and the wiring contracts on static copies. Exit status
0 means every adapter passed, 1 an adapter failed, 2 the graph was unavailable;
never treat 2 as an adapter failure. The entry name must come from a real
Claude Desktop (renderer status `entry.asset`): the page naming it sits behind a
browser check, which must not be circumvented. A published graph is a superset
of any cache (2,558 to 2,919 modules against about 1,200 cached), so it shows
selections that depend on which lazy chunks a user happened to load; a
difference between the cached and the published target of one build is a
defect in the selection, not noise. Its store holds vendor code: keep it
outside the repository and publish only metadata reports. It proves selection
and transform, never installation into a real cache or live reception.

dev/frontend-watch/watch.mjs is the maintainer service around that check, for a
machine without Claude Desktop. `submit` queues an entry name once, `run`
checks every queued entry and keeps one report per entry, and `regress`
rechecks every reported entry with the current checkout: an adapter that
passed must pass again with the same vendor file and hash, while an entry that
failed may now pass. An unavailable graph stays queued and is never reported
as a failure. Entry names come only from real Claude Desktop installations
(observed identical on macOS and Windows for one build); the service never
requests one from claude.ai. A failed entry starts the executable named in
CLAUDEX_FRONTEND_ON_FAILURE once. on-failure.sh notifies, then lets Claude
Code draft a repair from repair-prompt.md on a `frontend-repair/<entry>` branch
in a separate worktree. It never pushes, changes versions or touches the
checkout the service runs from; a maintainer reviews the branch and verifies
it in a real Claude Desktop before release. Host names, paths, schedules and
notification settings are deployment details and stay out of tracked files.

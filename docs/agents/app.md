# macOS app and status display

Contributor rules moved out of AGENTS.md; they are binding. Scope: Claudex.app setup, Mod installation ownership, window layout, localization, menu bar, Quit, and the CLI-only status display.

## macOS app setup

The graphical app now owns Mod installation and updates, by explicit product
decision. Setup and normal startup maintain only its bundled Claudex Mod through
the official native plugin manager and a private app-mod installation journal;
inspection/status timers never install, configure or start model work. Preserve
legacy verified sources, previous versions, other plugins, both configuration
identities and explicit disabled/wake preferences. Use same-name marketplace add
for verified source migration; never marketplace remove, which deletes native
plugin state. Newer installed versions are not downgraded. Explicit receiver or
enable requests must not report success if newer-version preservation refused them.
Missing management capabilities use a separately pinned, integrity-checked Mod
manager, not replacement of an existing inference CLI. Its bootstrap disables
package scripts and selects the exact native platform package, not the wrapper's
postinstall placeholder. Bundled source/runtime and the signed app bundle/executable
may be owned by the current user or root, protected from foreign writes. Private
state, login files and plugin caches must remain owned by the current user. Native package downloads use a clean environment and verified registry integrity;
the registry integrity must equal the SHA-512 pinned in source for each bootstrap
wrapper and native package, so a version bump updates its pins together;
never inherit npm configuration, run package scripts or copy credentials. Native runtime guards and accounts remain.
Show installed payload/version and fresh loaded-Mod self-report separately.
mod_wake_status is controller-only, bounded and content-free, never a dispatch
lease or delivery proof. Old/expired observers cannot certify current activation.
Since Mod 0.8.30, installation/setup/startup fill nativeWake/selfWake=true only
for never-configured keys, independently for both native identities; preserve
explicit false, disabled plugins and selected routes. Native replies may consume
model allowance. App receiver controls require explicit confirmation, preserve
per-task notification policy,
and never change native routes/policy or restart Claude. Existing SDK sessions may
retain old plugin roots; a new ordinary session loads the installed update.

The main window uses one outer scroll view, with a width-constrained natural-height
document. Never restore fixed-height nested checklist/diagnostic panes. Healthy
operation shows only Codex/Claude prerequisite summaries; actual missing/login/
blocked components automatically expose setup actions. The full checklist and
technical details stay in an explicitly expanded advanced section. A prerequisite
summary is not proof that messages have synced. Resize smoke checks must verify
viewport growth, natural content width, a single scroll view, and compact ready mode.
Fit window height to natural document height (including its padding) when opening,
changing content or toggling advanced diagnostics. Preserve width and the top edge
where possible; cap height to the current screen's visible frame and retain the
outer scroll view for overflow. Do not resize fullscreen or during live dragging.
Runtime history/ownership blocks offer diagnostics, not setup retries. Show the
global setup retry only for actionable installation/account requirements or a
failed setup operation; keep the instructions consistent with available actions.
Mod installation, enablement and loaded-session waiting use their scoped actions.
Show Mod activation waits in the main window without implying a setup retry or
restarting existing sessions; keep installed and loaded versions distinct.
Initial verification reports unique checked/total conversations and the known
current conversation with elapsed seconds. A ten-second status-only heartbeat
keeps long native operations observable; it must never publish archival intents,
inspect histories concurrently, advance checkpoints, or imply synchronization
completion. Stop and drain the heartbeat before leaving the operation.
Keep initialSweepCompletedAt separate from foregroundCompletedAt: completing the
foreground queue must not hide initial verification of the cold backlog.
An explicit initialSweepCompletedAt, including null before completion, governs
the Rust watcher's initial-check state even without conversation-count fields.
Unenrolled sources waiting for their first complete turn stay in diagnostic
details, not the action-needed list. Only the three exact first-turn wait
reasons qualify; unknown, unreported and tracked-history failures stay visible.

Distinguish setup `waiting` from `needs-action`: only missing components or sign-in
requirements request user action, while normal runtime waits need no setup retry.
Save folder/renderer maintenance intent before the guarded cache installation,
preserving explicit disabled choices and other adapter settings. Cache absence,
validation refusal and skipped installation must retain that intent and expose a
typed, content-free last attempt in `app-folder-setup-status.json`; installation
never certifies renderer activation. The normal watcher cache lifecycle performs
later validation, with no setup retry timer or guessed frontend. A newer live
renderer maintenance report supersedes an older installation-attempt refusal.
Waiting setup summaries must not promise that no setup changes are required.
Keep the `completion-delivery` checklist row and the separate `completionDelivery`
report field independent of broker write readiness and loaded Mod activation.
Use the broker's diagnostic origin-hook trust, selected provider routes,
recipient readiness and concrete next step. Missing/stale/unobserved evidence
stays unknown/waiting. By user decision (2026-10-15) the row is ready once both
origin hooks are trusted and a loaded, enabled Claude receiver is observed
admitting own-inbox delivery; Codex recipients are knowable only per task and do
not gate it, but an explicit Codex waiting state does. A row that can never be
ready hides real faults behind a permanent waiting state. These
observations grant no dispatch authority or delivery guarantee, enable no
receiver preference and bypass no native trust review. Present known broker
next-step codes as readable localized instructions while preserving the original
diagnostic report; in the report a global `observed` receiver never means an
exact recipient is `ready`, which only the task's own status check establishes.
Predecessor archival without a verified idle replacement owner (including an
evicted owner) is a typed `owner_not_idle` wait after archive intents are revoked,
not a history conflict or an actionable setup failure. Keep idle verification
mandatory and do not start owners just to archive; real identity errors still block.
Keep bounded per-pass waitingContexts with exact known conversation identity,
title and reason. The main window shows reasons and next steps without opening
details, and orders non-ready setup rows first. Never infer a missing identity,
hide a real conflict, or change synchronization semantics for a friendlier status.

Claudex.app localizes presentation using complete English-keyed JSON catalogs
under native/ClaudexApp/Locales for en, zh-Hant, zh-Hans, ja, ko, es, de, fr and it.
Keep key and %@ placeholder parity; the builder rejects incomplete catalogs.
System-language selection distinguishes Chinese scripts and regions. Runtime
switches rebuild presentation only, never run setup or restart services. Raw
unknown native diagnostics remain verbatim with a translated diagnostic label.
Read-only/synthetic modes must not persist language or onboarding preferences.

The graphical app owns the sole menu bar item, a combined setup/health window, and
notifications. It reuses the bounded native status model and an icon-only,
square-width menu bar button with the bidirectional-arrow
template symbol; never restore a visible app name or status suffix. Keep health
details in the tooltip, accessibility label, menu and window. Its owned login item
launches the same bundle in background inspection mode, not setup. Migrate only
the verified legacy status-display login item and native display process; preserve
its recoverable artifacts and never restart service or native conversation owners.
CLI-only installations may retain the standalone status display.
The approved app artwork is native/ClaudexApp/Assets/AppIcon.png. The app builder
derives standard 1x/2x icon sizes and packages Claudex.icns with CFBundleIconFile;
keep this raster app icon separate from the monochrome menu bar symbol.
The combined window contains setup retries and account actions; menus expose Open Claudex,
not a separate retry action. First launch automatically presents the main window and
starts setup, including a fresh background launch. Subsequent login starts stay
quiet; prior setup reports preserve existing-install behavior. Read-only and
synthetic UI modes must not mark onboarding as presented or run setup.
Live health appears above setup, with timestamps, recovery, notifications and
diagnostics under advanced diagnostics. Notification clicks open the same window;
the status controller must never create a separate window.
Graphical Quit (menu, Command-Q and native termination) now stops the owned sync
and collaboration services and exits only after read-only native ownership/process
checks confirm shutdown. Keep the UI responsive while draining; never kill user
native work or report a merely unloaded launchd job as fully stopped.
applicationShouldTerminate returns terminateLater and replies once the stop is
verified (false on failure); never terminateCancel a first request, which aborts
a logout or restart. While draining, poll read-only status but also repeat the idempotent
stop every few seconds: owners that were busy at the first stop and became idle
later are only closed by a stop, never by a status poll. The runtime closes idle Claude owners concurrently; a busy
owner still refuses after the idle ones are closed. Failures
remain visible in the app. Closing the window still only hides it. Persist the
private app-stop.json hold before stopping; hooks must not record events while
held. Reopening resumes only exact installed owned services, using a recoverable
resuming marker for partial starts, and clears the hold after successful starts.
Do not delete native data, credentials, or login definitions. Inspect/smoke and
duplicate-instance exits must never stop services. CLI-only status display Quit
retains its display-only behavior.

`native/ClaudexApp` and the Rust `claudex app` command provide automatic setup for users
who already have signed ChatGPT/Codex and Claude desktop apps. Never download or
replace those apps. Reuse native CLIs or fill missing CLI components from pinned
official npm packages in the private root. Keep normal native credential
namespaces, never copy credentials, and do not auto-start model work during setup.
Private state and status reads use non-blocking, no-follow file descriptors and
reject non-regular files before reading. Read-only AppSetup inspection refuses
setup, account, service and model-setting mutations before any native operation.
Service control verifies the loaded launchd job's definition path, program and
exact arguments against the owned installation before reporting readiness or
starting, stopping or removing it; a matching on-disk plist alone is insufficient.
Completion-event history holds have no scheduled retry countdown. Only actual
supervisor backoff supplies the next recovery time in that scheduler.
The app profile enables all projects and task-scoped writes; explicit read-only
requests and child permission bounds remain strict. Do not loosen existing
writer, version, resource, account or macOS guards to report a ready checklist.
An active or incompatible existing deployment must be preserved and explained.
By user decision, Claude.app is accepted with the official Anthropic team or
as a locally patched build: official bundle identifier, ad-hoc signature, no
team, and a passing strict deep verification; it is labeled as a local build.
Codex keeps its vendor-only check. Any other publisher blocks only its own
desktop-integration row; never skip to another copy or show unrelated
prerequisites as missing.
Package the complete Rust executable at `Resources/engine/bin/claudex` and
explicitly allowlisted host-required Mod assets so end users need no Git, Node
installation, compiler or terminal setup. Swift invokes the executable with `app`.
The builder checks native architecture, system-only dylib dependencies, complete
UI/Mod catalogs, the icon and nested signatures. Do not package the JavaScript
engine or npm dependencies. Codex Desktop's OpenAI-signed Node remains the native
process host through the embedded narrow bootstrap; never replace that signed
ancestry with the Rust executable. Development signing is not notarized
public distribution. `--inspect-only` is read-only UI validation; `--ui-smoke`
checks native layout with synthetic data, not installed service acceptance.
The 20-second setup inspection runs only while the window is visible or a
setup/login flow is active. Clear that activity after failures or when no provider
installation/sign-in follow-up remains. Stop the inspection timer when neither
condition applies and recreate it when needed. By user decision, report inspection
may reuse a successful deep desktop-app signature verification recorded in the private
app-signatures.json for at most one hour, keyed by the expected publisher and
nanosecond identities of the bundle, Contents, Info.plist, MacOS and the code
seal. Setup and sign-in always verify again; failures and bundles that changed
during verification are never recorded; `--read-only` (used by --inspect-only)
never writes it. The cache is a scheduling optimization, not publisher proof.

For CLI-only installations, `status-app install|status` manages a separately signed macOS menu-bar app in
the private root, with independent login startup. It only reads bounded private
status files, distinguishes readiness from liveness/stale data, and reports
waiting, paused, recovering or offline states. Its status window exposes
diagnostics and notification permission/test feedback. Persistent issues are
debounced 15 seconds and deduplicated with a 60-second minimum notice interval;
recovery generates a notice too. Notifications contain no transcript or paths.
Graphical installations use the unified Claudex app instead; standalone display
installation is blocked after graphical login migration. Quit stops only the display. Signed, journaled upgrades require the old UI to
exit and preserve one previous artifact. No built bundles belong in Git.

# Claudex for macOS

[Back to README](../README.md)

Current development build: **Claudex.app 1.2.0**, with **Claude Mod 0.8.0** bundled.
For the latest published release, **1.1.1**, see [release notes](releases/1.1.1.md) and the
[published download/checksums](https://github.com/jamie950315/claudex/releases/tag/v1.1.1).

## Who this is for

Claudex.app is for Mac users who already have the official ChatGPT/Codex and
Claude desktop applications installed. It connects those existing installations;
it does not install, replace, or upgrade the vendor desktop apps.

The app bundles Node.js, its package manager, and the Claudex engine. End users
do not need Git, a separate Node.js installation, or terminal configuration.

## First launch

Claudex.app supports English, Traditional Chinese, Simplified Chinese, Japanese,
Korean, Spanish, German, French and Italian. The **Language** picker follows the
system by default; a manual choice takes effect immediately and is remembered.
Switching languages only changes presentation, never services or conversation
contents. Menus, health summaries, setup guidance and notifications are localized.
Unrecognized native diagnostic details remain verbatim beneath a localized label
so troubleshooting evidence is not changed. CLI output remains English.

1. Put Claudex.app in a stable Applications location before opening it. Background
   services reference the bundle; do not move it while those services are running.
2. Open Claudex. On first launch, the main window opens automatically and setup verifies
   the installed vendor apps, including when first started in background mode.
3. Complete an official browser sign-in if requested. Desktop sign-in and CLI
   sign-in are not assumed to be interchangeable. Credentials are never copied.
4. Review and trust the exact Claudex completion hooks through Codex's native hook
   review (`/hooks` in Codex CLI). Setup preserves existing hooks and never bypasses
   native trust. A configured-but-untrusted hook remains an explicit readiness issue.
5. Let the checklist report which integrations are ready and which require an
   account, compatible runtime, idle native process, or normal app restart.

Conversation synchronization wakes on native completion hooks/events, not a recurring
two-second history scan. Startup/reconnection reconciliation and a status-only
heartbeat remain; the heartbeat does not inspect conversations.

The single Claudex window shows live synchronization status and compact Codex and
Claude connection summaries. Setup actions appear automatically when a component
is missing, sign-in is required, or a fault needs attention. Healthy operation does
not show redundant sign-in buttons or Retry setup. **Show advanced diagnostics**
reveals the complete checklist, versions, signatures, timestamps and notification
controls. Notification clicks open this same window, not a separate status page.
The page has one outer scroll area: content wraps with the window width and a
taller window reveals more content. There are no fixed-height inner checklists
or diagnostic scrolling panes.
Waiting and fault details are shown directly beneath the health summary, including
known conversation names, exact reasons, next steps, and copy/diagnostic actions.
Normal runtime waits do not request setup changes. Missing components, required
sign-in and actual faults appear before ready rows in the checklist; ordinary
waiting does not offer a misleading setup retry button.
After resolving a missing requirement, use that button to continue configuration;
it does not resend messages or bypass synchronization guards. The menu has one
**Open Claudex…** entry, not separate status, settings or retry entries. Later login starts stay quiet,
and opening an already configured app does not rerun full setup or restart live
owners. Normal startup does maintain its bundled Mod as described below;
periodic inspection remains read-only.
Read-only inspection and synthetic UI checks do not mark onboarding as presented.

Under **Show advanced diagnostics**, **Collaboration models** provides separate
Codex and Claude default model ID fields. Enter a model ID supported by the
provider's native CLI, then choose **Save model settings**. Leave a field blank
to use that CLI's default model. These settings apply to new work and handoffs;
an explicitly selected task or handoff model takes precedence. **Reload model
settings** reads the saved configuration again. Saving does not rerun setup or
restart services. Model IDs are entered directly so vendor model updates do not
depend on a bundled catalog.

Each provider also has a **Reasoning effort** selector. **Native effort default**
leaves effort unspecified; otherwise the selected native effort is captured for
new work and handoffs unless the request explicitly overrides it. Follow-ups keep
their task's selection. Saving model settings saves both models and efforts.
Changing a model does not silently change its effort. Levels depend on the selected
model and are not equivalent across providers; native validation errors remain
visible rather than silently lowering effort. Existing work is not changed.

All projects are available by default, with task-scoped file editing. Users do
not enroll directories one at a time. This is not unrestricted access to the
entire Mac: native sandbox rules, macOS permissions, explicit read-only requests,
and the scope of the assigned task still apply. Children inherit a read-only
parent's restriction even when the app's root-task default permits editing.

The app reuses working CLI components. If a necessary CLI is missing, it installs
a pinned official npm package under the private Claudex state directory using
its bundled runtime. The provider desktop apps must already be present before
this step. Installation uses the public npm registry, not a copied account key
or the user's global Node.js installation.

## What setup configures

- The bundled Claude Mod through the official native plugin manager, including
  automatic initial installation and updates on app startup. Existing plugin
  preferences, older versions and verified previous marketplace sources remain.
- An independent collaboration broker and the `claudex-work` MCP connections.
- The narrow `claudex-desktop-wake` MCP endpoint and supported Claude frontend
  bridge for authorized messages to existing native chats.
- A separately validated conversation adapter that requests reconnection when an
  exact managed Claude entry is opened or submitted to. It requires the native
  MCP device grant and a published owner map. Claude RC delivers queued messages;
  this activation does not submit model input or require Codex to be connected.
- All-project Desktop synchronization using the original OpenAI-signed native
  launcher runtime, not Claudex's own Node binary for that protected integration.
- Native folder presentation and Local predecessor handoff when the existing
  frontend resource and lifecycle checks permit them.

## Claude Mod lifecycle

No separate CLI installation is needed for the Mod. The app stages its bundled
version in private `app-mod/releases` storage, strictly validates it, installs or
updates it through the native manager, and checks its complete payload hashes.
Its durable installation journal retains the previous source and records progress
for interrupted configuration recovery. It never edits native plugin caches,
removes a marketplace, clears plugin data, or downgrades a newer installed Mod.
Unexpected or modified installations stay explicit instead of being overwritten.

An existing manager is selected by actual configure/validate capabilities. If no
supported native manager is present, the app installs a separate pinned official
management CLI with its bundled Node/npm, checks package integrity and disables
installation scripts. This does not change the CLI used for existing model work.
Initial component downloads require network access; vendor desktop apps and
native account access are still prerequisites. No credentials are copied.

The main window distinguishes installation from a fresh loaded-session observation.
Open a new Claude Code session and submit the literal `/claudex` command after an update;
the supported frontend catalogue adapter exposes `/claudex` before that first
submission when Claude's native catalogue already lists the enabled companion's
`claudex:claudex-workflow`. The latter remains a separate skill. The adapter adds
only menu metadata; selecting `/claudex` uses the ordinary native Mod command,
not a model prompt. An existing native command or alias takes precedence, and
initialized-session lists remain native. After installing this frontend update,
a normal idle Claude restart is required; first-use menu rendering remains a
separate acceptance check from package installation. On earlier frontend builds,
the first command could leave an invalid-command warning even though the pane
opened. Confirm the pane and loaded-version report, not a menu item alone. Native SDK
sessions may retain their old plugin root even after reload-plugins. The app does
not restart them. Activation observations expire, contain no conversation content,
and never prove message delivery or that every open session uses the new version.

Advanced diagnostics shows bundled, installed, manager and observed Mod versions,
plus **Install or update Claude Mod**. An intentionally disabled Mod stays disabled
until **Enable Claude Mod** is selected. Receiver permission has a separate explicit
confirmation and preserves per-task notification opt-in and the existing delivery
route. Normal status refresh is read-only; it never starts installation, a model,
or a native test suite. Runtime feature-flag overrides used in explicitly authorized
developer tests are never applied by setup.

## Background operation and permissions

- Background startup through the existing owned, journaled LaunchAgents.
- One Claudex app and one menu bar item for setup, live synchronization status,
  diagnostics, and notification controls. Login opens the same app quietly;
  it does not rerun setup or open another status application.

Graphical setup migrates an owned legacy status-display login item to the unified
app. It exits only that verified display, preserves its files for recovery, and
does not stop synchronization, collaboration, or native conversations. Unknown
or modified login items block migration instead of being overwritten.

Setup itself never sends a model prompt. Collaboration begins only when work is
requested through the protocol. Closing the window keeps background services
running. **Quit Claudex** (including Command-Q) stops synchronization and the
collaboration broker, waits for owned processes/native work to exit safely, then
closes the app. The app stays visible while shutdown drains; an unverified stop
shows an error rather than falsely claiming completion. In-flight collaboration
work receives the broker's normal cancellation; file edits are not rolled back.
Native user work is never force-killed. Installed hooks remain registered but
do not record wake events while the app is stopped. No conversations or settings
are deleted. Opening Claudex again resumes its verified installed services;
ordinary reopen without a preceding Quit does not restart running services.
Login startup remains installed. The legacy CLI-only status display is unchanged.

An app update replaces files, not every already-running process or native session.
An old Claudex window may retain its loaded executable, a running broker its
engine modules, and a native client its MCP tool catalog. Verify installed and
active state separately. Use normal, safe Quit/reopen for Claudex when its engine
needs replacement; this stops its services as described above. Reconnect native
MCP clients through their normal lifecycle after active work has finished. An
accepted reload request alone is not proof that an existing connection exposes
the current tools. Do not force-close native work or replay input to refresh a client.

Advanced diagnostics include collaboration defaults: a model and reasoning effort
per provider, and the **Sub-agent permission** for new top-level tasks (Read only,
Workspace write or Full access). New installations use Workspace write. Full
access runs workers like your own agent, without a sandbox or permission prompts
and with your settings, plugins and hooks; see the
[collaboration guide](collaboration.md#full-access) before choosing it.

When the broker cannot confirm that a collaboration task stopped, only related
work waits. Claudex closes such tasks automatically once their processes are
gone. If one stays open, the collaboration row offers **Resolve…**: after you
confirm that no agent from it is still working, Claudex closes it as failed. File
changes are kept, nothing is rerun, and tasks with running processes stay open.

The checklist refreshes through read-only inspection. An observed prerequisite
or sign-in transition can continue setup automatically; it does not blindly
repeat a failed model request or overwrite another application's settings.

## Messages to existing chats

Ask a model to send a note to a chat by its exact title. A unique match can be
addressed directly; duplicate or partial matches require recipient selection.
This continues the original conversation, not a newly created replacement.
Sending normally requests a native wake and can consume model account allowance;
callers may choose hook-only queued delivery with `wake: false`.

Keep Claude Desktop open with the selected delivery route available. The renderer
route can open an unloaded recipient; Mod routes need the eligible recipient
session to be loaded. `mod-self` does not create a new owner for a closed session,
and the older `mod` route also requires another loaded sender. Native policy,
busy work, drafts or permission prompts can postpone or refuse delivery; a closed
app cannot receive an immediate frontend wake. Known ended chats can retain queued notes until resumption, subject
to message expiry. Check the message receipt: queued, native acceptance and the
recipient's ACK are different states. ACK means receipt, not completion of the
requested action.

The Desktop watcher automatically follows the latest fetched frontend entry and
its cached import graph for folders, chat wake and owner wake. It resolves unique
structural bindings, checks transformed module syntax and keeps an immutable
original plus recovery journal for each cache filename. Earlier originals and
receipts remain. Missing/ambiguous anchors or foreign cache changes skip that
adapter explicitly in `renderer-adapters-status.json`; no older graph is guessed.

Older builds can retain two implementations under one conditional binding; both
must validate and are patched. When folders and chat actions share a cache entry,
the all-adapter installer publishes their complete combined patch once, with one
original and recovery journal under `ui-folders/<cache filename>/ui-folder-compat`.
Disabling folders retains only chat wake. Restoring a shared entry removes both
adapters from that entry; separate resource journals remain independent.

Cache notifications arrive after writes, so patching cannot be guaranteed before
first renderer evaluation. Loading each newly installed graph requires a normal
idle Claude restart. The watcher never reloads/quits Claude or restarts native
work. A successful cache installation is not proof of renderer reception or
message delivery. The 30-second history-watcher heartbeat remains status-only.
An interrupted cache inventory or resource publication retains a revalidation request for the next cache
notification, even if its filename has already disappeared. A verified recovery
updates the folder-resource status on the existing heartbeat without another
conversation event or history scan. Missing immutable originals/manifests,
permission errors and foreign changes remain explicit blocks, not cache churn.
See [native-chat messaging](collaboration.md#messages-to-existing-native-chats)
for supported discovery, delivery and recovery boundaries.

## Existing work and compatibility

An existing installation is not a license to take over its active writers. Setup
preserves running work, pending operations, private state and unrelated MCP
connections. Earlier CLI-managed services whose paths or policy differ can need
a safe migration before this app can adopt them. The app reports that hold
instead of force-closing processes or claiming an upgrade succeeded.

New graphical installations permit newer native versions without version-only
warnings. The existing `warn` configuration name is retained; an explicitly
selected `strict` policy remains available. Actual protocol and history failures
still pause unsafe operations. A missing or changed frontend resource prevents the folder patch;
there is no guessed resource or signature bypass. Refer to
[synchronization](synchronization.md) for the exact boundaries.

Developer diagnostics can invoke `node bin/claudex-app.mjs inspect --read-only`
for a non-mutating JSON report. Plain `inspect` does not run setup or models but
may record a successful signature-verification cache entry; `--read-only` forbids
that write too. `Claudex.app --inspect-only` exposes that report in the native UI
without setup or login actions. `--ui-smoke` renders a synthetic checklist and
tests native layout without invoking the backend; it is not deployment evidence.
`--diagnose` reads the same bounded health report used by the menu bar.
`--ui-language <locale>` overrides the language only with `--inspect-only` or
`--ui-smoke`; these modes do not persist the language preference.

From a developer checkout, run `node dev/verify-claude-frontend-builds.mjs` to
check every locally available cached entry graph and renderer original journal.
Optional `--home`, `--root` and `--report` specify source locations and a metadata
report outside live state. The script uses temporary cache copies and the real
installer/watcher, checks syntax with `node --check`, compares native AST/wiring
with historical hand-pin transforms, and lists exact missing assets and failures.
Current runtime code is supplied to both transforms; this does not attest to an
older installed runtime or live renderer reception. Obsolete owner-wake pins into
Chat/Cowork fail that comparison explicitly; they are never used to restore the
superseded channel. The script exits nonzero if any required check fails.

## Packaging and distribution

The current build target is Apple Silicon and macOS 13 or later. The app has a
development signature; it is not a notarized public release. Developer ID signing
and notarization are still required before advertising a download that launches
without additional Gatekeeper handling on other users' Macs. No OS verification
is disabled as a workaround.

For maintainers, obtain an official portable macOS Node distribution and verify
its published checksum, then build with Xcode's Swift compiler and an available
signing identity:

```sh
node bin/build-claudex-app.mjs \
  --output /absolute/output/Claudex.app \
  --node-distribution /absolute/node-distribution \
  --identity "$CLAUDEX_SIGNING_IDENTITY" \
  --zip /absolute/output/Claudex-macOS-arm64.zip
```

The builder requires Node.js 22.15+ (22.x) or 23.8+ and probes the portable
runtime's Zstandard/CRC32 APIs before staging. It refuses an incompatible runtime
instead of packaging an app whose Desktop adapters would fail later.
It uses an explicit engine-file allowlist, lockfile-based production
dependency installation, portable Mach-O dependency checks, and nested code
signatures. Existing output bundles are not overwritten. Transcripts, account
files, the general repository test suite, local Git history and private configuration
are not bundled. The Mod's explicitly allowlisted native test fixture is included
with its plugin payload for native validation.
Generated bundles, archives and signing details stay outside the repository.

Automated setup tests use isolated private directories and injected installers.
They verify scope defaults, missing prerequisites, account holds, ownership
guards and compatibility reporting without installing vendor apps or invoking
models. Native packaging, UI, live account inspection and clean-user deployment
are separate verification steps; none substitutes for the others.

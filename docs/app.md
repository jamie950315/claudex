# Claudex for macOS

[Back to README](../README.md)

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
4. Let the checklist report which integrations are ready and which require an
   account, compatible runtime, idle native process, or normal app restart.

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
and reopening Claudex inspects the configuration rather than rerunning setup.
Read-only inspection and synthetic UI checks do not mark onboarding as presented.

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

- An independent collaboration broker and the `claudex-work` MCP connections.
- All-project Desktop synchronization using the original OpenAI-signed native
  launcher runtime, not Claudex's own Node binary for that protected integration.
- Native folder presentation and Local predecessor handoff when the existing
  frontend resource and lifecycle checks permit them.
- Background startup through the existing owned, journaled LaunchAgents.
- One Claudex app and one menu bar item for setup, live synchronization status,
  diagnostics, and notification controls. Login opens the same app quietly;
  it does not rerun setup or open another status application.

Graphical setup migrates an owned legacy status-display login item to the unified
app. It exits only that verified display, preserves its files for recovery, and
does not stop synchronization, collaboration, or native conversations. Unknown
or modified login items block migration instead of being overwritten.

Setup itself never sends a model prompt. Collaboration begins only when work is
requested through the protocol. Closing the setup window or quitting the display
does not stop the background services.

The checklist refreshes through read-only inspection. An observed prerequisite
or sign-in transition can continue setup automatically; it does not blindly
repeat a failed model request or overwrite another application's settings.

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

Developer diagnostics can invoke `bin/claudex-app.mjs inspect` for a read-only
JSON report. `Claudex.app --inspect-only` exposes that report in the native UI
without setup or login actions. `--ui-smoke` renders a synthetic checklist and
tests native layout without invoking the backend; it is not deployment evidence.
`--diagnose` reads the same bounded health report used by the menu bar.
`--ui-language <locale>` overrides the language only with `--inspect-only` or
`--ui-smoke`; these modes do not persist the language preference.

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

The builder uses an explicit engine-file allowlist, lockfile-based production
dependency installation, portable Mach-O dependency checks, and nested code
signatures. Existing output bundles are not overwritten. Transcripts, account
files, tests, local Git history and private configuration are not bundled.
Generated bundles, archives and signing details stay outside the repository.

Automated setup tests use isolated private directories and injected installers.
They verify scope defaults, missing prerequisites, account holds, ownership
guards and compatibility reporting without installing vendor apps or invoking
models. Native packaging, UI, live account inspection and clean-user deployment
are separate verification steps; none substitutes for the others.

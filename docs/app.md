# Claudex for macOS

[Back to README](../README.md)

## Who this is for

Claudex.app is for Mac users who already have the official ChatGPT/Codex and
Claude desktop applications installed. It connects those existing installations;
it does not install, replace, or upgrade the vendor desktop apps.

The app bundles Node.js, its package manager, and the Claudex engine. End users
do not need Git, a separate Node.js installation, or terminal configuration.

## First launch

1. Put Claudex.app in a stable Applications location before opening it. Background
   services reference the bundle; do not move it while those services are running.
2. Open Claudex. Setup starts automatically and verifies the installed vendor apps.
3. Complete an official browser sign-in if requested. Desktop sign-in and CLI
   sign-in are not assumed to be interchangeable. Credentials are never copied.
4. Let the checklist report which integrations are ready and which require an
   account, compatible runtime, idle native process, or normal app restart.

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

Synchronization retains its version policy. Newer native apps can be available
for collaboration while synchronization remains blocked pending compatibility
validation. A missing or changed frontend resource prevents the folder patch;
there is no guessed resource or signature bypass. Refer to
[synchronization](synchronization.md) for the exact boundaries.

Developer diagnostics can invoke `bin/claudex-app.mjs inspect` for a read-only
JSON report. `Claudex.app --inspect-only` exposes that report in the native UI
without setup or login actions. `--ui-smoke` renders a synthetic checklist and
tests native layout without invoking the backend; it is not deployment evidence.

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

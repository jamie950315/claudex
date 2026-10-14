# Codex transport, launcher and version policy

Contributor rules moved out of AGENTS.md; they are binding. Scope: The shared Codex backend and launcher, signed bundled Node, Desktop install, CUA/Browser Use helpers, validated baselines and the strict/warn version policy.

Do not emit warnings merely because Codex/Claude versions are outside the
validated baseline. The existing `warn` policy name is retained for config
compatibility, but version-only status warnings and events are silent.
New graphical installations default to this permissive policy; an explicitly
configured strict policy is preserved.
Actual protocol, schema, history, ownership and native operation failures still surface
and keep their safety guards. Do not relabel unknown runtimes as verified.

Validated native baselines are Codex `0.155.0-alpha.16.3`/`.16.4` and Claude Code
`2.1.210`/`2.1.281`. Low-level/CLI versionPolicy defaults to strict; new graphical
installations select warn while preserving an existing explicit strict choice.
Warn permits unvalidated runtime versions without version-only pauses or warnings.
Never label an unvalidated version as verified. Codex has cross-process writer locks.
Check both spawned descendants and ordinary forks before retirement: this Codex
version omits fork ancestry from `thread/list`, so use metadata-only `thread/read`.
Include `thread/loaded/list`: a fresh fork can be loaded before the stored list
exposes it. Normal original archival and owned-snapshot retirement share these guards.
That loaded inventory may retain a hint for a transient thread already deleted.
After its metadata read fails, ignore only a loaded-only identity that is not a
parent, stored/ancestor witness or enrolled record, whose exact native rollout is
absent (plain, compressed and rollover representations), and whose fresh loaded,
stored and parent-specific ancestor inventories all prove disappearance. Recheck
rollout absence and enrollment after those native reads. Directory aliases,
unstable listings and permission errors cannot prove absence. Existing native
relationships and uncertain reads still block explicitly with the source's exact
identity; no retry, native loading or write is used to establish disappearance.

Shared Codex transport installs for the next normal app start: `bin/claudex-codex.mjs` preserves
native Desktop args/env, starts a public Unix WS listener, and forwards JSONL
unchanged. Do not use a prestarted WS_URL override: it loses Desktop app-tools
injection. The native CODEX_CLI_PATH launcher is the intended activation path;
never restart active user work. Login window restoration can start Desktop
before LaunchAgents, bypassing the launcher; src/codex-desktop-relaunch.mjs then
quits (never kills) and background-reopens that exact process once, immediately
when the override is active and no Codex turn is running (user activity does
not delay it). WS clients share the backend and can retire idle
owned projections immediately (native isolated proof). The CLI's raw proxy is
not compatible with the WS listener. Native socket aliases need strict UID,
private-directory, inode and target validation, not blanket symlink following.
An ENOENT during endpoint inspection is a transport-unavailable wait, not a
fatal history failure. Recheck all socket/manifest identities on the next
connection; permission/alias failures remain strict. Never apply this exception
to missing transcript/archive files or resend uncertain native writes.

`desktop install` selects Desktop mode only for roots with no legacy records.
The generated fixed-Node shim configures CODEX_CLI_PATH without changing or
restarting the app. The watcher reapplies its exact override at login and waits
for a private verified shared-backend manifest. Never silently start another
stdio writer. CLI status selects the configured ledger. `desktop uninstall`
preserves transcripts and ledgers; it is not a reverse migration. Do not remove dependency guards for retirement.

The pinned Desktop CUA and Browser Use helpers invoke exactly
`app-server --listen stdio://`. CUA inherits the app-tools pipe; Browser Use
does not. Preserve both independent auxiliary processes instead of claiming the
shared owner lock. Both routes are verified, including live browser startup.
If Claude has no capturable primary window, its official web session's
Open in > Desktop app action can restore the window. Chrome's external-app
confirmation is a native browser window, not part of the webpage snapshot.
This route restored real Claude Desktop observations without restarting it.

Desktop launchers must use the original OpenAI-signed bundled Node, not the
installing shell's process.execPath. The app's native peer authorizer checks
the peer, parent and grandparent signing identities. A Homebrew/ad-hoc wrapper
breaks codex_app startup and browser policy verification despite a signed leaf
runtime. The installer verifies the bundled Node signature and journals exact
owned-runtime upgrades. Never
disable peer checks or substitute an unsigned client. Stdio close does not
schedule immediate reconnect; next-request recovery is not proof that killing
an active backend is safe.
The observed 0.158 package relocates Resources/codex into
Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex; bin/codex is a shell entry.
Resolve only the observed same-bundle layouts, verify package metadata/native
OpenAI signatures and journal exact owned launcher migration. Bundled Node stays
at Resources/cua_node/bin/node. Normal startup detects this package even with a
stale recorded flat path. Unknown packaging fails explicitly, never selecting
an unrelated CLI. This does not certify every new protocol or migrate credentials.

Runtime compatibility is centralized in src/codex-versions.mjs. The .16.4 app
update passed isolated native contracts and signed-Node launcher initialization.
Under strict policy an unknown runtime uses original native Desktop transport under the same
exclusive owner lease, labeled transportMode:native, with no shared socket.
The watcher refuses that mode and reports synchronization paused pending version
validation. Only this pre-launch version decision may select native-only mode;
never fall back after an ownership/shared-start/transport failure or bypass a
live owner. Release the lease after the native child exits, including signals.
The projection codec's .16.3 schema label is not a runtime version assertion.

The user can suspend version-only enforcement with `version-policy warn` and
restore it with `version-policy strict`; the setting is saved per state root.
Launcher, DesktopRuntime, legacy adapters and ClaudeOwner honor the same policy.
Warn mode keeps shared transport for unknown Codex versions and attempts unknown
Claude CLI/SDK versions. Native version tags in the existing exact image/reset
formats honor this choice too; no structural/provenance/receipt checks are removed.
Version-only watcher warnings remain silent; actual protocol, schema, ownership
and history failures still surface. Settings take effect for
newly loaded workers; never replace active work to apply them. Claudex no longer
injects DISABLE_AUTOUPDATER=1; preserve explicit inherited/override preferences.
Runtime updater behavior and npm dependency upgrades remain the native tools'
responsibility. Keep schema versions, signatures, locks, identity and conflict
checks strict even when runtime version enforcement is suspended.

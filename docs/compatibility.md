# Command line and compatibility

[Back to README](../README.md) · [Desktop synchronization](synchronization.md)

Claudex.app performs every step below automatically. This guide is for source
checkouts, manually managed installations, and installations that synchronize
local CLI session stores without the shared Desktop backend. For cross-model subagents or whole-work
handoff, use the [collaboration guide](collaboration.md); it does not depend on
this synchronization mode.

## Source checkout

```sh
git clone https://github.com/jamie950315/claudex.git
cd claudex
cargo build --locked --release -p claudex-cli
```

Run the commands below from the repository directory. `bin/claudex` executes
`target/release/claudex`; it never builds or downloads an engine at startup.
Use an absolute `CLAUDEX_RUST_ENGINE` to select another already-built binary.
The npm `claudex` command uses the same native launcher; `npm run build` is a
convenience alias for the Cargo command above. Existing explicit
`node bin/*.mjs` commands are thin compatibility hosts for Rust, not the old
JavaScript engine. Collaboration and synchronization are installed separately;
installing one does not enable the other.

### Collaboration from the command line

```sh
bin/claudex collaboration install
bin/claudex collaboration status
```

This installs an independent background broker and registers the `claudex-work`
MCP connection with Codex and Claude Code. Reload the clients' MCP connections
through their normal lifecycle; installation does not restart active apps.

Manual CLI installation defaults to read-only work. Choose writable work at
first installation with `bin/claudex collaboration install --allow-write`. Do
not apply it as a hot policy change to a loaded broker; stop an existing
installation safely first. See
[permissions and limits](collaboration.md#permissions-and-limits).

### Desktop synchronization from the command line

For a **fresh synchronization state root**:

```sh
bin/claudex init --all-projects
bin/claudex desktop install
bin/claudex service install
bin/claudex status
bin/claudex doctor
```

Initialization does not overwrite existing configuration. Desktop installation
does not migrate an existing CLI-only ledger; see
[Desktop migration boundaries](#desktop-migration-boundaries). The shared Codex
backend activates on the next normal desktop-app start. Desktop
`untrack CONVERSATION_ID` and `resume-tracking CONVERSATION_ID` require the
owned watcher to be stopped; see
[history-preserving maintenance](synchronization.md#stop-tracking-while-preserving-history).

### Claude Mod from the command line

Stage the Mod with
`bin/claudex mod stage --root /absolute/private/root --output /new/marketplace`,
then follow the [Mod guide](claude-mod.md) for native validation and plugin
installation. Staging does not install or enable it. Inspect native-wake routes
with `bin/claudex collaboration native-wake`; change a route only after its own
native activation acceptance.

## Verified versions

Compatibility is feature-specific. Collaboration acceptance does not expand the
synchronization runtime allowlist.

| Capability | Version evidence | Verified behavior |
| --- | --- | --- |
| Cross-model collaboration | Codex CLI `0.158.0-alpha.2.1`; Claude Code `2.1.283` | Both-direction child delegation and result return, parent resumption after file edits, and consecutive owner transfers under one task ID. |
| Cooperative in-flight follow-up | Codex CLI `0.159.0-alpha.12.1`; Claude Code `2.1.283` | Both real supervisor/child directions accepted a proactive instruction and completed in generation one, without a child blocker or duplicate invocation. |
| Claude Mod | Bundled `0.8.68`; Desktop Code `2.1.286`, documented Mod API baseline `2.1.287` | Pane, commands and cache settings; native activation is verified separately from source checks. Installed and loaded versions are separate. See the [Mod guide](claude-mod.md) and [cache-warming guide](cache-warming.md). |
| Codex cache warming | Desktop native runtime `0.160.0` or later, experimental best-effort | Default-off CLI opt-in and a separately trusted `/claudex:warm` hook. See [limits and confirmation](cache-warming.md#codex-desktop-experimental-best-effort). |
| Desktop synchronization | Strict Codex baseline `0.155.0-alpha.16.3` / `.16.4`; Claude Code `2.1.281` with SDK `0.3.281` | Native conversation delivery, real Desktop alternation, supported compaction and image cases, identity preservation, and bounded snapshot retirement. |

Manual CLI initialization defaults to `versionPolicy: "strict"`; new graphical
installations use `warn`, preserving an explicitly selected existing policy.
`warn` permits attempts on other runtimes without version-only warnings; it does
not certify them or relax history, ownership, authentication, or conflict
checks. See [version-only enforcement](synchronization.md#version-only-enforcement).

## Existing mode and configuration

The CLI-only coordinator remains implemented. Existing configuration calls this
mode `legacy`; that stored value is retained for compatibility, not a product-wide
maturity label. A synchronization configuration without `mode` selects this path.
The `desktop install` command selects the shared Desktop coordinator instead.

CLI-only synchronization uses the Codex runtime allowlist in
`crates/claudex-core/src/version.rs` and validated Claude Code baselines `2.1.210` and
`2.1.281`. Manual initialization defaults to strict version checks. An explicit
`warn` policy permits attempts on other versions without version-only warnings;
it never waives native writer or history checks. New graphical installations use
`warn` unless an existing policy was explicitly selected.

## CLI-only setup

```sh
cargo build --locked --release -p claudex-cli
bin/claudex init --all-projects
bin/claudex watch
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

## Background operation

Stop a foreground watcher before installing the synchronization service:

```sh
bin/claudex service install
bin/claudex service status
```

The service manages the coordinator selected by the root's configuration.
Read [background service and status](synchronization.md#background-service-and-status)
for startup, shutdown, notifications, and bounded status reporting.

## Desktop migration boundaries

- Desktop installation requires a root with no tracked CLI-only conversations
  or pending CLI-only work. It refuses automatic migration of those records.
- Do not edit a ledger or clear pending work to make it eligible for another mode.
  Preserve the original root and its native histories.
- CLI discovery alone does not register a conversation in Claude Desktop.
  Adopted Desktop Local transcripts remain protected even after archival.
- `desktop uninstall`, after safe watcher shutdown, removes the owned next-start
  launcher override and selects the CLI-only configuration. It preserves Desktop
  state and native histories; it does **not** migrate them back to the CLI-only
  coordinator or change a running application.

The [Desktop boundary](synchronization.md#claude-desktop-boundary) explains why
native archival, visibility, and a writer lease are different things.

## Earlier titles and encodings

Earlier generated titles may contain an owned `[Claudex]` prefix. The current
guarded title migration removes only that exact owned prefix; unrelated manual
names survive. Display names do not authorize writes or identify a native session.

Older authenticated packets and prepared operations keep their recorded encodings
during recovery. They are not rewritten just to match a new display format.
See [same-title handoff](synchronization.md#same-title-handoff-and-preserved-originals)
and [native integration](synchronization.md#native-integration).

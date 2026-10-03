# CLI-only compatibility

[Back to README](../README.md) · [Desktop synchronization](synchronization.md)

This guide is for installations that synchronize local CLI session stores
without the shared Desktop backend. For cross-model subagents or whole-work
handoff, use the [collaboration guide](collaboration.md); it does not depend on
this synchronization mode.

## Existing mode and configuration

The CLI-only coordinator remains implemented. Existing configuration calls this
mode `legacy`; that stored value is retained for compatibility, not a product-wide
maturity label. A synchronization configuration without `mode` selects this path.
The `desktop install` command selects the shared Desktop coordinator instead.

CLI-only synchronization uses the Codex runtime allowlist in
`src/codex-versions.mjs` and validated Claude Code baselines `2.1.210` and
`2.1.281`. Manual initialization defaults to strict version checks. An explicit
`warn` policy permits attempts on other versions without version-only warnings;
it never waives native writer or history checks. New graphical installations use
`warn` unless an existing policy was explicitly selected.

## CLI-only setup

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

## Background operation

Stop a foreground watcher before installing the synchronization service:

```sh
node bin/claudex.mjs service install
node bin/claudex.mjs service status
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

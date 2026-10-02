# Claudex native companion, 0.1.1

This plugin is staged from the Claudex repository with:

```sh
node bin/claudex-mod.mjs stage --root /absolute/private/claudex-root --output /new/marketplace
```

Use the resulting `plugins/claudex` directory for native validation and local
installation. Staging bundles the existing Unix-socket transport together with
the new bounded helper. It creates no service and requests no inference. The
source directory alone intentionally has no configured state root or bundled
runtime.

Run `/claudex` in an interactive Code session. The pane provides task inventory,
exact-ID status, chat lookup with duplicate titles preserved, delegation and
follow-up previews, cancellation previews, provider default updates, and durable
operation receipts. `/claudex receipt UUID` reads a receipt without redispatching.
Use `/claudex:claudex-workflow` for the accompanying collaboration guidance.

The native receipt adapter is disabled by default. After separate runtime and
Desktop acceptance, it can claim a pending mailbox message and queue the original
quoted peer context to an exact Claude session ID using `session.send`. The
recipient's native policy and queue stay authoritative. Queue acceptance and the
receiving model's Stop-hook ACK remain separate observations. A refused or
uncertain dispatch stays offered for operator inspection; it is never
silently placed back in the queue.

The existing MCP tools, synchronization engine, history storage, Desktop
organization patches, lifecycle hooks, and unloaded-session fallbacks remain in
place. The integration preserves the repository's existing runtime allowlists.
The documented public Mod API baseline is 2.1.287, not a companion version gate.
Native loading and the real Desktop pane also work on the tested 2.1.286 build.
Full synchronization with a new runtime still needs its own acceptance evidence.

See `docs/claude-mod.md`, `docs/claude-mod-handoff.md`, and
`docs/claude-mod-acceptance.md` in the source repository. Review source and trust
the Node executable and configuration: a native Mod runs with the current user's
local permissions. Helper requests carry operation data on stdin; controller
capabilities stay in the private broker root.

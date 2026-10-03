# Claudex native companion, 0.6.0

The Tasks view now exposes the bounded broker work hierarchy, generation-bound
progress, blockers, instruction adoption, cooperative pause, declared checks and
artifacts. Exact-task timelines and report histories are read on demand with
separate event cursors; viewing them never acknowledges a child result. File
inspection and working-tree-versus-index diffs retain unknown authorship rather
than attributing shared-checkout edits to one worker. Every intervention still
uses the complete prepare/confirm workflow. Public collection and blocker wakes
remain separate per-task opt-ins, disabled by default.

AI collaboration uses the existing MCP delegation, multi-task wait, structured
worker report and handoff tools. The pane remains optional for human inspection
and reviewed intervention. Session-local observations of policy, capabilities
and context usage expire at the broker and never authorize dispatch or fallback.
See [the workflow](skills/claudex-workflow/SKILL.md) for the model-driven path.

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

The pane groups status, work, conversations, composition and inbox controls into
sections. Technical records are collapsed by default; action confirmation always
shows the complete reviewed parameters. Its language picker supports English,
Traditional/Simplified Chinese, Japanese, Korean, Spanish, German, French and
Italian. Follow system reads the macOS preferred-language list, including Chinese
script/region selection. An explicit choice is saved in the native plugin store.
This preference is independent of the Claudex app's own language setting. Changing
it only redraws the pane and usage band; it does not dispatch work, restart services
or discard unsubmitted form text or a pending action preview. Native identifiers,
model names, user content and unknown diagnostics stay unchanged.

Automatic delivery is off by default. After the separate runtime and Desktop
acceptance gates, configure both `nativeWake: true` and `selfWake: true`, and
select `collaboration native-wake --route mod-self` for newly queued wake-enabled
messages. The same Mod in the recipient session receives its own authorized
broker messages: no second loaded session, extra Mod or SendMessage tool is
required. A closed/unloaded recipient still waits for its normal native resume;
the feature does not create an extra model session.

The macOS-only own-inbox helper uses Claude's documented own-child socket
ingress. It verifies the native parent process and its exact private socket,
inherits the native authentication token without storing or exposing it, and
writes once. This is not `session.send` to self and is not a `prompt.submit`
fallback. Native inbound `hold` and `refuse` settings remain authoritative; the
Mod does not change settings, approve permissions or impersonate user input.

The socket has no delivery ACK. `submitted` means only that the write completed,
not that the native queue accepted it or the model read it. The receiving Mod
checks the exact one-use broker claim, current session, route and app-stop state
before admitting the original quoted peer text. The real recipient Stop-hook
ACK remains separate. Durable dispatch intents and receive-once records prevent
replay across concurrent helpers and restarts. Uncertain outcomes stay recorded.

The earlier `mod` route remains available for cross-session `session.send` and
still requires another loaded sender with SendMessage. `renderer` remains a
separate route. Route changes affect new messages only: existing routes, claims
and receipts are preserved, with no automatic fallback between them. Bounded
event-backed waits inspect mailbox metadata, never native history. Only outcome
receipt publication may be retried, never the native dispatch.

The existing MCP tools, synchronization engine, history storage, Desktop
organization patches, lifecycle hooks, and unloaded-session fallbacks remain in
place. The integration preserves the repository's existing runtime allowlists.
The documented public Mod API baseline is 2.1.287, not a companion version gate.
Validate the actual runtime's emitted API declarations, strict validator and
native test kit before activation. Own-inbox wire behavior requires its own
native acceptance; full synchronization with a new runtime remains a separate
gate. Linux and Windows own-inbox delivery are not implemented.

See `docs/claude-mod.md`, `docs/claude-mod-handoff.md`, and
`docs/claude-mod-acceptance.md` in the source repository. Review source and trust
the Node executable and configuration: a native Mod runs with the current user's
local permissions. Helper requests carry operation data on stdin; controller
capabilities stay in the private broker root.

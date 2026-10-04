# Claudex native companion, 0.8.4

Cache warming is default-off and separately confirmed in the selected loaded
conversation: `/claudex warm on` prints a bounded confirmation command;
`/claudex warm status` reads status and `/claudex warm off` revokes it. Optional
`ttl=1h` (default) or `ttl=5m` synchronizes the real native main-cache TTL in the
current Claude process, then enables the matching warming window after readback.
Global settings and the separate subagent TTL variable stay unchanged. Forced
five-minute/managed restrictions are respected. Off retains the native TTL;
partial failures stop local warming and report a possibly applied native change.
Use `/claudex warm preference remember ttl=1h` to remember later confirmed TTL
choices, `preference default ttl=5m` for a fixed startup TTL, or `preference session`
to stop restoration. Both TTLs are supported. Each prints a confirmation; saving
a preference stops local warming without enabling inference. Preferences persist
in the native plugin store and apply to future loaded primary sessions sharing
that store, not other running sessions. Unset preferences remain session-only.
Open `/claudex` and select **Cache settings** to change TTL and startup behavior
using native controls. Selection only edits the form; preview and confirm apply
the exact displayed change. The complete confirmation survives language changes.
TTL-only changes (`/claudex warm ttl 1h|5m`) stop local warming without enabling
inference. Read actual native TTL, saved preference and warming status separately.
Optional
`maxMinutes`, `maxRefreshes`, `maxReadTokens` and `maxOutputTokens` key=value
bounds default to 60, 3, 250000 and 256. Warming creates real plugin-origin OK
turns using the existing native account/model, not a fork or another API key.
Budgets are admission estimates and observed stop thresholds, not hard native
output caps. Busy/draft/context changes suppress submission. Native acceptance
must be verified separately from installation and static validation; no feature
gate is overridden. Codex warming is unsupported.

Claudex.app 1.1.2 installs and maintains this bundled companion during setup and
normal startup through the official native plugin manager. Read-only inspection
never installs or configures it. Existing disabled/receiver preferences, other
plugins and newer installed versions are preserved. Installed files and fresh
loaded-session evidence are separate: an existing session can retain an older
plugin root until its supported native lifecycle loads the update.

The loaded observer reports its literal companion version and observation build
alongside the existing content-free receiver flags. The broker's controller-only
`mod_wake_status` private RPC returns at most 64 live observer counts grouped by
version/build, plus bounded receiver-policy counts; it exposes no session IDs,
paths or message content. Observations expire after 60 seconds and are never
restored after restart. Older observers without version evidence remain unknown.
This diagnostic read does not renew observations or prove delivery, ACK, or work
completion, and it cannot dispatch, change receiver settings, or start inference.

The Tasks view now exposes the bounded broker work hierarchy, generation-bound
progress, blockers, instruction adoption, cooperative pause, declared checks and
artifacts. Exact-task timelines and report histories are read on demand with
separate event cursors; viewing them never acknowledges a child result. File
inspection and working-tree-versus-index diffs retain unknown authorship rather
than attributing shared-checkout edits to one worker. Human mutations in the pane
still use the complete prepare/confirm workflow; this is not a confirmation gate
for a managed worker's authorized MCP workflow. Public collection and blocker wakes
remain separate per-task opt-ins, disabled by default.

AI collaboration uses the existing MCP delegation, multi-task wait, structured
worker report and handoff tools. The pane remains optional for human inspection
and reviewed intervention. Session-local observations of policy, capabilities
and context usage expire at the broker and never authorize dispatch or fallback.
See [the workflow](skills/claudex-workflow/SKILL.md) for the model-driven path.

The 15-tool MCP interface supports proactive follow-ups while a child runs.
Workers receive queued instructions through explicit `work_control` check-in or
a separate inbox block at eligible managed-worker MCP response boundaries, then
acknowledge accepted/rejected instruction IDs in the same generation. Milestone
opt-in can resume a waiting managed parent before child completion; it does not
enable an external native-chat wake. Delivery is not adoption or completion, and
neither path forcibly interrupts a long native tool or opens a second writer.

For developer validation or a CLI-only installation, stage from the repository:

```sh
node bin/claudex-mod.mjs stage --root /absolute/private/claudex-root --output /new/claudex-0.8.4-marketplace
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
it only redraws the pane; it does not dispatch work, restart services
or discard unsubmitted form text or a pending action preview. Native identifiers,
model names, user content and unknown diagnostics stay unchanged.

Automatic delivery is off by default. After the separate runtime and Desktop
acceptance gates, configure both `nativeWake: true` and `selfWake: true`, and
select `collaboration native-wake --route mod-self` for newly queued wake-enabled
messages. The same Mod in the recipient session receives its own authorized
broker messages: no second loaded session, extra Mod or SendMessage tool is
required. A closed/unloaded recipient still waits for its normal native resume;
the feature does not create an extra model session.
The app's receiver controls require explicit confirmation and change only those
receiver options, not the route, native inbound policy or per-task notification
choice. Installing the companion does not opt a task into content collection or
native wake, and it does not restart Claude.

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
organization patches, lifecycle hooks, and unloaded-session waiting rules remain in
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

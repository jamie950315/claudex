# Claude native Mod companion

## Current companion: 0.8.15

Claudex.app 1.2.30 installs, updates and checks its bundled Mod automatically;
see the [app lifecycle guide](app.md#claude-mod-lifecycle). The standalone commands
below remain available for CLI-only installations and developer validation.
Version 0.8.15 aligns the companion's shipping documentation and version metadata
with Claudex.app 1.2.20. Mod delivery and cache-warming behavior is unchanged.
The app verifies exact nanosecond identities during native project relocation
and accepts the reviewed Codex Desktop primary-origin schema while preserving
the complete native call/result proof requirements.
Version 0.8.14 updates only the companion's shipping documentation and version
metadata for Claudex.app 1.2.19. The app accepts a protected, signed bundle and
executable owned by root when installing its login entry; private state remains
owned by the current user. Mod delivery and cache-warming behavior is unchanged.
Version 0.8.13 clears the preparation notice when confirmation consumes the
preview or an exact matching receipt shows it is no longer prepared. Completed
and uncertain receipts retain their separate states; receipt reads never dispatch.
Version 0.8.12 exposes `NATIVE_CHAT_DISCOVERY_INCOMPLETE` in the pane when a
native title query exceeds the bounded complete inventory. Use a longer, more
specific title; the refusal still returns no partial candidates or message.
Version 0.8.11 gives invalid MCP arguments a stable `CLAUDEX_INVALID_ARGUMENTS`
code while preserving their message and existing specialized error codes.
Version 0.8.10 removes the read-token ceiling and displays counted/unlimited
warm reads. Duration, refresh-count and output-token limits are unchanged.
Version 0.8.9 labels warm reads as counted/limit instead of a read budget in all
nine languages. Only wording changes; limits and accounting remain unchanged.
Version 0.8.8 replaces the namespaced warming command's JSON with four compact
localized lines. It shows state/TTL, token budgets, first cache result and next
warm time without exposing native IDs, paths, fingerprints or internal policy.
Version 0.8.7 makes `/claudex:warm on [5m|1h]` enable directly, without a
second user confirmation. It retains the internal exact-session, idle, native
TTL-policy and one-use transaction guards. Legacy advanced commands and the
Cache settings pane retain their preview/confirm flows.
Version 0.8.6 introduced `/claudex:warm on [5m|1h]`, `off` and `status` for the
current Claude session. Its namespaced skill is intercepted locally by the Mod,
not executed as a model prompt. That release required the exact printed
confirmation. This shortcut leaves shared startup preferences and remembered
TTL choices unchanged. The older `/claudex warm` settings commands remain.
Version 0.8.5 refreshes the staged private transport for the separate Codex
Desktop experimental best-effort warmer. The Mod Cache settings pane still
controls only its own Claude session's TTL and preferences; it does not enable
Codex warming or edit Codex TTL. Use the separately confirmed
[Codex CLI controls](cache-warming.md#codex-desktop-experimental-best-effort).
Version 0.8.4 adds the localized Cache settings tab to the native pane. It shows
native TTL separately from saved startup preferences and offers exact-context
preview/confirm controls for TTL-only and persistence changes without enabling
warming. Language changes retain form edits and pending confirmations.
Version 0.8.3 adds confirmed TTL persistence: session-only, remember-last and
fixed-default 1h/5m. Native startup restores only an explicitly saved preference
without enabling warming; status and /clear never apply it. See the
[preference commands](cache-warming.md#ttl-preferences-across-restarts).
Version 0.8.2 defaults the warming window to one hour and accepts `ttl=5m` or
`ttl=1h` in the explicit per-conversation confirmation. The choice also sets and
verifies the current native process's real main-cache TTL before warming is
enabled. Global files and the separate subagent TTL variable stay unchanged;
forced/managed restrictions are respected. Turning warming off retains the TTL.
Version 0.8.1 accounts for native suppression of a plugin's own prompt hook.
Cache-warming attribution retains the one-use dispatch, exact text/context,
activity epoch and expiry checks rather than relying on observing that hook.
Version 0.8.0 adds explicit, bounded cache warming for a selected loaded Claude
conversation. It is disabled by default and uses the native owner's ordinary
prompt path, not a fork or an API key. See [cache warming](cache-warming.md)
for confirmation, budgets, TTL evidence and activation limits.
Version 0.7.3 removes the above-prompt Claudex status band. Context usage remains
in the `/claudex` pane; native and other plugins' prompt-area content is unchanged.
Version 0.7.2 gives the refreshed shipping documentation its own payload version,
preserving exact-file installation checks and earlier native cache versions.
Version 0.7.0 adds content-free loaded-version observations for the app; these
observations are self-reported diagnostics, not delivery or work-completion proof.
Version 0.7.1 packages cooperative running-worker follow-ups: a supervisor can
send a direction before a child finishes, and that child can receive it in the
same invocation through explicit check-in or an eligible managed-worker MCP
response boundary. Delivery, worker-reported adoption and completion remain
separate. This does not inject input into a long-running native tool or interrupt
the model. See [decisions and instructions](collaboration.md#decisions-instructions-and-cooperative-pause).

Version 0.6.2 added the bounded work views described in
[the collaboration guide](collaboration.md#opt-in-work-visibility), generation-bound
report/event history, instruction and blocker state, and declared artifact/diff
inspection. Its standalone package includes the transport's complete dependency
set; the pane and API share the 64 KiB artifact read bound.

Version 0.5.2 introduced bounded configuration diagnostics inside the existing technical
session details: registration option types/values, this plugin's name/root, and
only its two wake options for the marketplace and inline identities in the native
user/flag/policy layers. It never displays
complete settings or secrets and does not override registration or inbound policy.
If saved and loaded options differ, use the native configuration/activation flow;
an installed manifest or a reload acknowledgement is not enabled-receiver proof.

The AI-first workflow uses the existing MCP start/wait/status/report/handoff
protocol; the panel is an optional observation and intervention surface. The
Mod reports bounded session-local policy, capability and context-usage
observations through `mod_wake_observe` and existing event-backed waits. These
are diagnostic only, expire after 60 seconds and are never restored as online
state after broker restart. Unmapped targets, missing receivers, disabled self
delivery, hold/refuse and missing SendMessage remain explicit; no route fallback,
permission change or native dispatch is authorized by an observation.

The changed observer has isolated Node/Unix RPC coverage, strict native validation
and actual loaded-session evidence. The official kit runs with a separate
test-only opt-in stage. The reviewed installation also passed fresh native
task-origin binding, Codex queue receipt and automatic Claude mod-self receipt
with real Stop ACK. These bounded results are separate from the earlier 0.4.1
acceptance and do not certify every runtime or route; see the validation record
and collaboration protocol.

## Panel and language support

Version 0.4.1 keeps the existing delivery and confirmation protocol and improves
the native panel's presentation: selected two-row navigation, grouped status and
actions, readable task/receipt summaries, empty states, and explicitly expandable
technical records. Confirmation still displays every reviewed parameter and exact
target identity before dispatch. Long labels wrap in narrow panes.

The language picker offers the same nine languages as Claudex.app: English,
Traditional Chinese, Simplified Chinese, Japanese, Korean, Spanish, German,
French and Italian. Follow system resolves the macOS preferred-language list with
script/region-aware Chinese selection. The native plugin store persists the Mod's
choice independently of the graphical app. If system-language discovery fails,
the pane explains it and still allows an explicit choice. Language switching
changes presentation only, preserving form edits, prepared actions and receipts.
Native IDs, paths, protocol JSON, models, user text and unknown diagnostics are
not translated. Complete catalogs and placeholder parity are checked before
staging or app packaging.

## Single-session delivery

Version 0.3.1 provides an explicit `mod-self` route in the existing Mod. It does not
require another Mod, another loaded sender session or the SendMessage tool.
The recipient's own loaded Mod obtains its already-authorized broker message and
uses native own-child inbox delivery. Historical 0.3.1 acceptance used
both opt-ins enabled and route `mod-self`; a single Desktop session produced the
requested Sonnet 5.5 reply and real Stop ACK after normal restart. Its original
unsent draft remained unchanged. Source defaults remain off. Exact native policy,
RPC, test and Desktop evidence is recorded in [validation](claude-mod-validation.md).

Three settings are distinct: plugin `nativeWake: true` starts the listener,
plugin `selfWake: true` enables own-inbox delivery, and
`collaboration native-wake --route mod-self` selects that route for newly queued
Claude messages whose `wake` is true. Queue-only messages remain queue-only.
Existing `mod` and `renderer` messages keep their original route and receipts;
changing the setting never migrates or replays them.

The Mod uses one long-poll helper call per loaded session. The broker wakes that
call on a new message or route/shutdown event; its twenty-second bounded timeout
also allows reconnection and lifecycle checks. This reads mailbox metadata, never
native conversation histories. There is no two-second transcript sweep. For
`mod-self`, the recipient session must itself be loaded with the enabled Mod;
otherwise its message waits for normal native resume. The earlier `mod` route
still requires a distinct loaded sender with SendMessage. Neither route creates
an extra native model process or silently falls back to another transport.

Before taking a self claim, check native inbound policy, exact current context
and the owned native inbox. Explicit `hold` or `refuse` leaves the message waiting;
the native receiver's policy still applies if it changes after this preflight.
The cross-session `mod` route instead checks SendMessage availability. Claiming
binds the durable message to that controller and route. Recheck target metadata,
route, expiry and app-stop before dispatch. Renderer consumers cannot
take Mod claims, including from stale manifests. Native hooks share the mailbox's
atomic offer guard; only one consumer can offer the queued message. Ordinary
SessionStart/UserPromptSubmit/Stop hooks cannot consume queued `mod-self` messages:
otherwise a normal hook could bypass native hold/refuse while the own-inbox route
waits. Real Stop ACK scanning remains enabled; queue-only and older routes keep
their existing hook behavior.

Own-inbox delivery is initially macOS-only. The helper verifies the parent Claude
PID, birth identity and UID with bounded native process inspection and verifies
that this parent owns the exact owner-private socket. It rejects user-controlled
symlink paths; Darwin's root-owned `/tmp` and `/var` aliases are resolved safely.
The native socket and authentication token are inherited only by the child,
never copied into requests, argv, logs or durable state. Native own-child ingress
is documented; the precise wire behavior still requires runtime-specific native
acceptance. This is neither self-addressed `session.send` (which the tested
runtime refuses) nor a `prompt.submit` fallback.

The helper persists a dispatch intent before writing once. Only claim identifiers
cross the native socket. The receiving Mod verifies current context and lifecycle,
route, expiry and app-stop, then consumes a durable receive-once authorization
before retrieving the original broker-quoted peer text. Clear/end callbacks and
late asynchronous results cannot redirect delivery into another session.

After a native result, write an owner-private receipt outbox before contacting
the broker. Lost responses recover by publishing that same outcome, never by
dispatching again. The own-inbox socket supplies no native ACK: `submitted` means
only the write completed, not queue acceptance, model reception or work completion.
The real recipient Stop ACK is still required. For cross-session `mod`, accepted
means queued, and explicit false is rejected without retry. Exceptions,
lifecycle changes after claim and abandoned sends remain uncertain.
They do not fall back to another transport. Unavailable target metadata is deferred
without blocking other targets; connection recovery backs off to thirty seconds.
Unsafe receipt storage stops the listener and remains visible for inspection.

The outbox is `<root>/mod-wake-receipts/`; own-inbox dispatch intents are in
`<root>/mod-self-dispatch/`. Each has a 2048-record bound (the mailbox limit is
lower). Completed outcomes and receive-once evidence are retained. Keep them and
the original mailbox when investigating. Never remove a claim to force redelivery.

Claudex.app handles ordinary installation, updates and explicit receiver controls;
these do not automatically change the broker route or certify delivery on a new
runtime. The following is the developer acceptance procedure for another target
runtime, not a requirement for every end user to run tests manually:

1. Run affected tests, stage the candidate with `--native-wake --self-wake`, and run that runtime's strict
   validator and native test kit. Do not override a vendor/policy refusal.
2. Update the broker through the normal owned installation path at a safe idle
   boundary; preserve the installed definition, current work and previous artifact.
3. Install/configure the staged plugin using its native manager. Open a fresh
   normal session or use a supported reload, verifying the actual loaded version.
4. Configure both native opt-ins, select
   `node bin/claudex.mjs collaboration native-wake --route mod-self`, and inspect
   its status. Run a separately authorized canary with only the recipient loaded,
   checking the exact claim, native reception, real reply and Stop ACK. Verify
   inbound hold/refuse, lifecycle fencing and no replay; a socket write alone
   proves none of these.
5. Keep renderer support for legacy messages and other Desktop functions. Route
   rollback is `native-wake --route renderer`; unresolved Mod messages keep their
   original route and evidence. Never automatically replay them on rollback.

Rollback here means changing the route while retaining a current broker, not
downgrading its data reader. Older brokers do not understand `mod-self`, submitted
outcomes or receive-once records. Do not restore an old broker binary
over a mailbox that has used the new route, or rewrite the mailbox to make an
older version accept it. Preserve the modern reader and all message evidence.

The renderer is intentionally retained. Earlier 0.2.3 cross-session acceptance
includes native queue, reply, Stop ACK, busy delivery, draft preservation and
offline no-replay observations. Those results do not certify the 0.3 own-inbox
route. Keep historical and new evidence separate in the
[validation record](claude-mod-validation.md).

## Architecture and scope

```text
Claude Desktop Code tab / Claude Code CLI
    native Mod: pane, user-confirmed actions, workflow skill
        $.process.run(fixed Node argv, JSON stdin)
            packaged, bounded Claudex helper
                existing private collaboration/rpc.sock
                    existing CollaborationHub
                    existing worker scopes, journals and process fences
                    existing mailbox and native session metadata

Automatic authorized delivery (or separately reviewed Inbox delivery):
    broker identity-only manifest -> exact mailbox claim
        mod-self: own native child -> authenticated own inbox (claim IDs only)
            -> native inbound policy -> Mod receive-once broker verification
                -> original quoted peer text -> real recipient Stop ACK
        mod: $.session.send({to: {sessionId}, text: originalQuotedPeerContext})
            -> native recipient policy and queue -> real recipient Stop ACK

Existing synchronization, turn checkpoints, assets, native histories,
Desktop folder/title organization and unloaded-session fallbacks stay intact.
```

The pane deliberately binds every controller operation to one configured
synchronization root. Agents continue using the existing `claudex-work` MCP
connection. A second MCP registration or an independently authenticated service
is unnecessary. This also avoids sending a UI request to one MCP installation
while inspecting another installation's local state.

| Area | Current implementation | Boundary |
| --- | --- | --- |
| Native UI | `/claudex` pane; no above-prompt status band | Desktop Code and CLI; local runtime validation required |
| Context/plan use | Native `session.usage()` at load, completed turns, and Refresh | Unknown values display as unknown; no fabricated weekly figures |
| Work inventory | Exact task IDs, summary status, pagination, original broker limits | Large UI results are explicitly marked as preview-truncated |
| Delegation | Reviewed `start`, default read-only, exact model/effort values | Broker workspace/permission checks remain authoritative |
| Follow-up/cancel | Reviewed `send` and `cancel` with durable request IDs | Broker response acceptance and actual worker exit differ |
| Defaults | Read and reviewed update of models, efforts, and bounded permission default | Full-access remains outside the companion |
| Native chat lookup | Search, exact ID selection, expected title, page cursor | Duplicate titles and unavailable metadata stay visible |
| Peer messages | Reviewed `chat_send`, queue-only default | `wake: true` is an explicit escalation to potentially billable native work |
| Native receipt | Explicit own-inbox `mod-self` or cross-session `mod` adapter | Disabled by default; socket submission, queue acceptance and Stop ACK differ |
| Handoff | Appends a reviewed instruction draft; bundled workflow skill | Owning workers keep the existing handoff protocol and revision fence |
| Lossless conversation sync | Existing core and complete-turn checkpoints | No transcript export/import is implemented through Mod APIs |
| Sidebar folders/archive/title organization | Existing structural integrations | New native pane complements these features |

The limited transcript view exposed by Mods is unsuitable as a lossless history
store. This implementation never substitutes a truncated Mod transcript for the
existing synchronization and native asset pipeline.

## Installation prerequisites

The companion uses the native Mod API documented for Claude Code 2.1.287.
This is the public baseline, not an enforced version check in the companion.
Earlier companion acceptance on Desktop-bundled 2.1.286 passed strict validation,
nine native tests and SDK 0.3.286 no-inference initialization with `/claudex`
registered, without additional feature flags. Native UI evidence then verified
the pane and broker response on that engine. These historical checks do not
replace the current candidate's complete native kit or own-inbox acceptance.
Test the installed runtime's actual capabilities before requiring an upgrade.
The repository also records a separate earlier synchronization acceptance baseline:
Claude Code 2.1.281, SDK 0.3.281, and the repo's allowlisted Codex builds.
Consult [current collaboration evidence](collaboration.md#verification-scope) and
the actual source version policy and installed executables before deployment;
these independent records must not be inferred from the Mod version.

Keep three independent gates:

1. The installed runtime understands and validates this Mod.
2. Collaboration workers and their existing native account/permission settings
   pass the repository's regression and targeted integration tests.
3. The synchronization engine has explicit acceptance evidence for the actual
   executables and Desktop bundle in use.

A successful native Mod test establishes gate 1 test coverage only. Keep the
existing version allowlists and the configured version policy unchanged. Use an isolated pinned
2.1.287+ CLI for validation rather than automatically upgrading the executables
used by a running synchronized installation. In Desktop, inspect the engine
version shown by the Mod; a separate terminal executable's version alone does
not identify the embedded runtime.

The helper uses POSIX ownership, modes, no-follow file opens, and Unix sockets,
matching the existing broker. General companion CLI use and isolated tests may
run on Linux, but `mod-self` requires the implemented macOS parent/socket checks.
Linux own-inbox delivery and Windows named-pipe support are not implemented.
Desktop WSL plugin support must be confirmed against current official runtime
support before use.

## Standalone staging and developer validation

From a source checkout:

```sh
node --version
npm ci --ignore-scripts --no-audit --no-fund
node --test --test-concurrency=4 test/claude-mod-*.test.mjs
# Run npm test when the change affects shared core, persistence, or concurrency.
```

Select the **synchronization root**, with `collaboration/` underneath it. The
usual repo default is `$HOME/.local/share/claudex`; read the actual installation's
configuration and use its canonical existing path. State directories must already
be owned by the current user with mode 0700. Preserve any mismatching state for
inspection instead of recursively changing permissions or moving native data.

```sh
ROOT="$(realpath "$HOME/.local/share/claudex")"
PARENT="$HOME/.local/share/claudex-mod-marketplaces"
mkdir -p -m 700 "$PARENT"
STAGE="$PARENT/claudex-0.8.15-review"
node bin/claudex-mod.mjs stage --root "$ROOT" --output "$STAGE"
```

`STAGE` must be new. Staging refuses replacement, validates its explicit source
allowlist, bundles the existing transport and its effort module, writes fixed
canonical Node/root defaults, and produces `stage-report.json` with hashes. It
changes no native app, service, settings file, transcript or runtime allowlist.
The Node executable must be regular, executable, and free of group/world write
permission; provide a trusted alternative with `--node /absolute/node` when
necessary. Keep its architecture and supported Node version appropriate for the
local host. Shared CI executable permissions are handled with isolated test
fixtures, without weakening the production check.

Use the independently selected native validation executable:

```sh
CLAUDE_VALIDATE=/absolute/path/to/reviewed/claude
"$CLAUDE_VALIDATE" --version
"$CLAUDE_VALIDATE" plugin validate "$STAGE/plugins/claudex" --strict --json
# The own-inbox test explicitly exercises both opt-ins. Use a separate,
# never-installed test candidate; keep the ordinary shipping stage off.
TEST_STAGE="$PARENT/claudex-0.8.15-native-tests"
node bin/claudex-mod.mjs stage --root "$ROOT" --output "$TEST_STAGE" --native-wake --self-wake
"$CLAUDE_VALIDATE" plugin validate "$TEST_STAGE/plugins/claudex" --strict --json
"$CLAUDE_VALIDATE" plugin test "$TEST_STAGE/plugins/claudex"
```

Those commands are offline Mod validation/test operations, not model prompts.
The full kit requires that test-only opt-in configuration; running its own-inbox
acceptance case against the default-disabled shipping stage correctly cannot
deliver peer text. Test staging does not enable either option in an installed Mod.
Inspect emitted types for that exact build when an API differs from the public
GitHub type snapshot. Preserve the report and resolve validation errors before
installation; preserve the existing synchronization policy throughout.

For CLI-only installations, use the same capability-verified manager after all
applicable gates are satisfied. Graphical users use the app's managed lifecycle
instead of these manual commands:

```sh
"$CLAUDE_VALIDATE" plugin marketplace add "$STAGE"
"$CLAUDE_VALIDATE" plugin install claudex@claudex-local --scope user
```

Use `/plugin configure claudex@claudex-local` to verify the state root, Node
executable and intended `nativeWake` and `selfWake` values, including overrides
retained from prior installs. Keep them false for an unvalidated installation.
For own-inbox activation, both must be true. Open a fresh suitable native Code
session or reload plugins using the runtime's normal command. The deployer should preserve active work and avoid
restarting apps/services merely to make a validation screenshot.

The native installer may report options as unset despite staged defaults. Save
them through its supported configuration command instead of editing settings:

```sh
"$CLAUDE_VALIDATE" plugin configure claudex@claudex-local --values-stdin --json
```

Provide a JSON object on stdin with single-line string values for `stateRoot`,
`nodeBinary`, `nativeWake`, and `selfWake` (booleans supplied as the string
`"false"` or authorized `"true"`). Verify the result has no
unconfigured options. The native writer parses the declared boolean type.

On the reviewed Desktop Code 2.1.286, Desktop delivers installed plugins to the
SDK as local plugin paths. The Mod's native configuration identity is therefore
`claudex@inline`, separate from the marketplace manager's `claudex@claudex-local`.
Use the actual installed cache path reported by the native plugin manager:

```sh
"$CLAUDE_VALIDATE" --plugin-dir="$INSTALLED_PLUGIN" plugin configure claudex@inline --json
"$CLAUDE_VALIDATE" --plugin-dir="$INSTALLED_PLUGIN" plugin configure claudex@inline --values-stdin --json
```

Save the intended state root, Node executable and wake preferences for both
identities. False/false supports a default-disabled installation; only explicitly
authorized receiver changes should enable the wake options. Keep source
defaults intact; do not copy credentials, edit native registries or change the
Mod's permission decisions. The reviewed host activated the new options through
its normal module reload and reported true/true from exact live session observers,
without an app restart. Verify the actual registration values and observer after
configuration; marketplace configured status alone does not establish Desktop
activation. An expired or uncertain message must never be resent to test it.

For a CLI-only temporary smoke test, use a separate harmless checkout and
`"$CLAUDE_VALIDATE" --plugin-dir "$STAGE/plugins/claudex"`. The source plugin directory itself
has blank configuration and no packaged runtime by design.

## Using the pane

`/claudex` opens Overview. Status refresh inspects the helper and existing broker.
The displayed socket flag means a private socket pathname exists; a successful
work-inventory response provides broker response evidence.

Tasks provides exact-ID status, follow-up composition, and cancellation preview.
Its work detail also provides generation-bound reports, public-event history,
blockers, instruction state, cooperative controls and declared artifact reads.
Opening these views never implies adoption of an instruction or review of a result.
Chats preserves duplicate titles and unavailable-title records, offers explicit
recipient selection, and follows `nextCursor`. Compose accepts one JSON object;
Enter prepares a durable preview and the separate confirmation button dispatches
it once. The confirmation displays the complete body and the configured root.
An oversized action stays uncommitted and points to the operator workflow.

Read-only delegation example:

```json
{
  "method": "start",
  "params": {
    "provider": "codex",
    "cwd": "/absolute/project-or-checkout",
    "permission": "read-only",
    "model": "gpt-6-sol",
    "effort": "high",
    "prompt": "Review the renderer and report defects with exact files and tests. Preserve all files."
  }
}
```

Use the actual model ID selected by the user or configured on the provider.
The example preserves the literal ID; availability remains a native-account
concern. Omitting model/effort captures the broker defaults at preview time.
An explicit `null` selects native CLI defaults. Values are never translated into
a supposedly equivalent provider's reasoning level.

Follow-up and cancellation:

```json
{"method":"send","params":{"taskId":"EXACT_TASK_ID","message":"Report the current test result and remaining blocker."}}
```

```json
{"method":"cancel","params":{"taskId":"EXACT_TASK_ID"}}
```

A cancellation request has its own receipt; read the exact task again until the
existing broker reports the actual fenced exit/outcome. Existing edits remain.
For workspace-write delegation, obtain the user's authorization and use a
dedicated checkout or explicitly disjoint writable paths. The external native
foreground chat is outside the broker's managed worker process group, so the
human/agent must avoid concurrent edits to the same files.

Queue-only chat example:

```json
{
  "method": "chat_send",
  "params": {
    "provider": "claude",
    "sessionId": "EXACT_NATIVE_SESSION_ID",
    "expectedTitle": "Exact currently verified title",
    "message": "Please report the current status when this session next processes messages.",
    "wake": false
  }
}
```

Provider defaults require both provider keys when changing a pair:

```json
{"method":"models","params":{"defaultModels":{"codex":"gpt-6-sol","claude":null}}}
```

Full-access, direct worker ownership handoff and uncertainty resolution remain
in their existing, more specialized operator/agent workflows. The handoff button
appends instructions to the current draft and leaves submission to the user.
It preserves existing draft text. The owning managed worker uses the existing
MCP handoff and revision protocol; the broker retains the outgoing process fence.

## Durable action protocol

A reviewed mutation follows:

```text
prepare -> private prepared receipt -> explicit confirmation
    -> exclusive per-action lock -> fsynced dispatching receipt
        -> one original broker RPC -> completed OR uncertain receipt
```

`requestId` is generated once and persisted before the original broker sees the
request. Canonical payload fingerprints point to the same outstanding intent
across UI reloads and exact-session changes. An equivalent uncertain intent is
blocked, including from another native controller session. Prepared previews
expire after ten minutes; a completed operation can be deliberately prepared
again as new work. The configured root stores at most 2048 action receipts.

`completed` describes the broker request's successful return. It establishes no
claim that a delegated task finished, a recipient acknowledged, or cancellation
completed. `dispatching`, `uncertain`, a stale lock or a lost helper response all
require inspection. The helper never retries a mutation automatically.

Receipts and intent pointers live under `<root>/mod-companion/`. They contain
private action bodies and bounded broker results, with mode 0600 in an
owner-private directory. They contain no copied controller token. Preserve this
directory during investigation; manage retention explicitly after all uncertain
requests are reconciled. A stale action lock is evidence to inspect, not a reason
to blindly remove a file or resend a prompt.

Use `/claudex receipt UUID` in the original exact controller session/cwd to read a
receipt. An operator can inspect the private JSON locally after a session has
ended. Compare its saved requestId, task/message ID, broker journal and live
process evidence. The first version deliberately provides no UI button that
clears an uncertainty barrier. Do not clear the broker's own uncertainty fence
or mark work resolved simply to make the pane appear healthy.

## Native delivery and manual Inbox inspection

For a new installation, keep `nativeWake` and `selfWake` false until the automatic
acceptance gate above is completed. The Mod never fabricates SessionStart/Stop,
approves permissions or invokes `prompt.submit`. Own-inbox native ingress is
framed as non-human peer input, not as the user's words. Automatic delivery handles
only existing wake-authorized broker messages and can cause the recipient's normal model work; that is not free of
inference. It does not initiate unrelated work or inspect native histories.

When explicitly enabled, Inbox reads only the broker's bounded identity manifest.
Chats can select a Claude recipient and inspect its pending messages. The
controller's session/cwd and the recipient's session/cwd are distinct fields;
`mod-self` requires them to match exactly, while `mod` requires another session.
The helper verifies the exact recipient against the manifest and existing broker
metadata, then obtains a source-bound `mod_wake_claim`. Mod and renderer route
fences plus the hooks' atomic offer guard prevent duplicate consumers.

Own-inbox delivery uses the current session's verified native child ingress and
the receive-once guard described above. A successful write is `submitted`, not
native acceptance. No composer fill, submission or permission-setting mutation
is used. Native policy and queue behavior stay authoritative; verify actual
busy-session and draft behavior on the deployed Desktop runtime.

Cross-session `mod` delivery uses `$.session.send({to: {sessionId}, text})` with
the exact recipient and original broker-quoted peer context. It still requires
SendMessage in another loaded sender. A native `isDelivered: true` means queued,
not read. An explicit false is retained as `rejected` without switching routes.

Both routes require the exact verified native Desktop title/identity, preserve
uncertain outcomes, and recognize only the original recipient's real standalone
`CLAUDEX_ACK:<messageId>` from Stop. A socket write, helper result or native queue
receipt is never work completion. Legacy renderer messages retain their original
consumer; a renderer cannot claim either Mod route. See the exact
[validation scope](claude-mod-validation.md).

## Security and maintenance

The Mod is trusted local code and shares the current user's permissions. These
checks narrow accidental exposure and preserve Claudex invariants; they do not
sandbox a malicious program running as the same user with access to the broker's
private controller capability.

The helper uses a fixed argv with no shell. Request bodies go through bounded
stdin. Its operation allowlist rejects arbitrary commands, extra capability
fields, full-access requests and worker-only mutations. Managed workers are
rejected before any root/key read. Credential reads are no-follow, size-bounded,
owner/mode/link checked, and revalidated against exact file identity. Capability
contents and raw backend exception strings never enter normal UI errors.

Root, stopped/resuming state, exact controller context, payload fingerprint and
preview expiry are rechecked at relevant helper boundaries. The existing broker
remains authoritative for native targets, directory grants, task revisions and
process ownership. Acknowledgement completion bookkeeping can still finish an
already claimed dispatch after an application Stop; new claims/operations stay
blocked.

New versions should bump the plugin version, regenerate the stage, validate its
hashes and installed configuration, and run both native surfaces. Review API
changes against the installed build's declarations. General Chat/Cowork UI,
lossless history migration and the main app's sidebar organization stay outside
this native control-pane implementation.

## Sources and verification

Implementation notes for future changes: `$`-taking helpers must be declared
at module top level for the native compiler. `$.plugin.root` is a string property;
do not invoke or mock it as an event. Strict validation alone does not execute
callbacks: retain the native compose/confirm, duplicate-title selection, and clear
tests, which caught defects the initial six tree-only tests did not detect.

Official API/format sources read on 2026-10-02:

```text
https://code.claude.com/docs/en/plugins/mods/overview
https://code.claude.com/docs/en/plugins/mods/reference
https://code.claude.com/docs/en/plugins/mods/interface
https://code.claude.com/docs/en/plugins/mods/api
https://code.claude.com/docs/en/plugins/mods/test
https://code.claude.com/docs/en/plugins/manifest-reference
https://code.claude.com/docs/en/plugins/components
https://code.claude.com/docs/en/cross-session-messaging
https://code.claude.com/docs/en/agent-sdk/typescript
```

Repository contracts reviewed at the pinned commit: README.md, AGENTS.md,
package.json, collaboration transport/hub/effort, ChatMailbox, the Claude wake
manifest, application Stop state, and the native synchronization hook. Treat the
archived test report as the exact record of what was executed; synthetic tests
are deliberately separate from native deployment evidence.

## Current app engine packaging

`src/app-bundle.mjs` includes both companion commands and the companion runtime
modules through explicit allowlists, including the Mod broker route, own-inbox
transport and receipt outbox modules. `ENGINE_PLUGIN_FILES` includes the manifest,
hooks declaration, controller, register, delivery, panel, localization and catalog
modules, workflow skill, plugin README and native test fixture.
`copyAllowed` copies only these assets and validates plugin directories from the
source root downward. A symlinked parent is rejected before inspecting descendants.

The packaging tests cover dependency coverage, staging from copied engine resources,
exclusion of unlisted files, and symlink rejection. The existing full-runtime
allowlist test also passes with these additions. Current graphical setup uses the
separate app-owned installation journal and official manager described in the app
guide; the stager itself still only produces files. A signed build verifies
packaging, not installation or native Mod painting.

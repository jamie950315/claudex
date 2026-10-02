# Claude native Mod companion

Status: integrated and regression-tested on macOS; the official Claude Code
2.1.287 strict validator and nine native test-kit cases pass. A development-signed
macOS app build is verified. Real terminal/Desktop painting and optional recipient
delivery remain separate deployment gates. See [validation](claude-mod-validation.md).

Baseline reviewed: `jamie950315/claudex` at
`eb12d2e1d82624be4b1dc94f8f53e9a6aa85a000` (package version 1.0.3).
Companion version: 0.1.0. Review date: 2026-10-02.
The supplied revision-2 bundle is integrated with native compiler/API repairs,
clear/end UI invalidation, and stage source-directory symlink protection.

## Architecture and scope

```text
Claude Desktop Code tab / Claude Code CLI
    native Mod: pane, band, user-confirmed actions, workflow skill
        $.process.run(fixed Node argv, JSON stdin)
            packaged, bounded Claudex helper
                existing private collaboration/rpc.sock
                    existing CollaborationHub
                    existing worker scopes, journals and process fences
                    existing mailbox and native session metadata

Optional reviewed receipt:
    broker identity-only manifest -> exact mailbox claim
        -> $.session.send({to: {sessionId}, text: originalQuotedPeerContext})
            -> native recipient policy and queue
                -> original recipient Stop hook -> exact CLAUDEX_ACK

Existing synchronization, turn checkpoints, assets, native histories,
Desktop folder/title organization and unloaded-session fallbacks stay intact.
```

The pane deliberately binds every controller operation to one configured
synchronization root. Agents continue using the existing `claudex-work` MCP
connection. A second MCP registration or an independently authenticated service
is unnecessary. This also avoids sending a UI request to one MCP installation
while inspecting another installation's local state.

| Area | Implementation in this change | Boundary |
| --- | --- | --- |
| Native UI | `/claudex` pane and composed AbovePrompt band | Desktop Code and CLI; local runtime validation required |
| Context/plan use | Native `session.usage()` at load, completed turns, and Refresh | Unknown values display as unknown; no fabricated weekly figures |
| Work inventory | Exact task IDs, summary status, pagination, original broker limits | Large UI results are explicitly marked as preview-truncated |
| Delegation | Reviewed `start`, default read-only, exact model/effort values | Broker workspace/permission checks remain authoritative |
| Follow-up/cancel | Reviewed `send` and `cancel` with durable request IDs | Broker response acceptance and actual worker exit differ |
| Defaults | Read and reviewed update of models, efforts, and bounded permission default | Full-access remains outside the companion |
| Native chat lookup | Search, exact ID selection, expected title, page cursor | Duplicate titles and unavailable metadata stay visible |
| Peer messages | Reviewed `chat_send`, queue-only default | `wake: true` is an explicit escalation to potentially billable native work |
| Native receipt | Optional exact-recipient `session.send` adapter | Disabled by default; preserves mailbox claim/ACK rules |
| Handoff | Appends a reviewed instruction draft; bundled workflow skill | Owning workers keep the existing handoff protocol and revision fence |
| Lossless conversation sync | Existing core and complete-turn checkpoints | No transcript export/import is implemented through Mod APIs |
| Sidebar folders/archive/title organization | Existing structural integrations | New native pane complements these features |

The limited transcript view exposed by Mods is unsuitable as a lossless history
store. This implementation never substitutes a truncated Mod transcript for the
existing synchronization and native asset pipeline.

## Installation prerequisites

The companion uses the native Mod API documented for Claude Code 2.1.287.
The reviewed repo records a stricter, earlier synchronization acceptance baseline:
Claude Code 2.1.281, SDK 0.3.281, and the repo's allowlisted Codex builds.
Its collaboration evidence also predates 2.1.287. Check the actual source version
policy and current installed executables before deployment.

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
matching the existing broker. macOS is the intended deployment target; Linux
supports isolated tests and CLI use. Windows named-pipe support is outside this
patch. Desktop WSL plugin support must be confirmed against current official
runtime support before use.

## Stage and validate

From a source checkout:

```sh
node --version
node --test --test-concurrency=4 test/claude-mod-*.test.mjs
npm ci --ignore-scripts --no-audit --no-fund
npm test
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
STAGE="$PARENT/claudex-0.1.0-review"
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
"$CLAUDE_VALIDATE" plugin test "$STAGE/plugins/claudex"
```

Those commands are offline Mod validation/test operations, not model prompts.
Inspect emitted types for that exact build when an API differs from the public
GitHub type snapshot. Preserve the report and resolve validation errors before
installation; preserve the existing synchronization policy throughout.

After all applicable gates are satisfied, installation is a separate explicit
local operation:

```sh
claude plugin marketplace add "$STAGE"
claude plugin install claudex@claudex-local --scope user
```

Use `/plugin configure claudex@claudex-local` to verify the state root, Node
executable and `nativeWake: false`, including overrides retained from prior
installs. Open a fresh suitable native Code session or reload plugins using the
runtime's normal command. The deployer should preserve active work and avoid
restarting apps/services merely to make a validation screenshot.

For a CLI-only temporary smoke test, use a separate harmless checkout and
`claude --plugin-dir "$STAGE/plugins/claudex"`. The source plugin directory itself
has blank configuration and no packaged runtime by design.

## Using the pane

`/claudex` opens Overview. Status refresh inspects the helper and existing broker.
The displayed socket flag means a private socket pathname exists; a successful
work-inventory response provides broker response evidence.

Tasks provides exact-ID status, follow-up composition, and cancellation preview.
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

## Optional native receipt adapter

Keep `nativeWake` false until `claude-mod-acceptance.md` is completed. This patch
includes no automatic polling, prompt submission, synthetic SessionStart/Stop,
permission auto-approval, or background inference.

When explicitly enabled, Inbox reads only the broker's bounded identity manifest.
Chats can select another Claude recipient and inspect its pending messages. The
controller's session/cwd and the recipient's session/cwd are distinct fields.
The helper verifies the exact recipient against the manifest and existing broker
metadata, then competes with the legacy renderer/hooks through the existing
atomic `desktop_wake_claim`.

A confirmed delivery uses `$.session.send({to: {sessionId}, text})` with the exact
recipient and the original broker-quoted peer context. It leaves the composer
untouched and lets the native recipient policy and queue handle busy sessions.
A native `isDelivered: true` means the queue accepted the message. It differs from
recipient ACK and work completion. The original recipient Stop hook is still
required to recognize the exact standalone `CLAUDEX_ACK:<messageId>`.

Some builds or account/session configurations may refuse self-delivery or lack
reachability to a selected session. Test a second synthetic recipient from a
separate controller session first. A refusal, missing API, exception, failed
receipt or context change after claim preserves the offered message and an
uncertain outcome. It does **not** requeue or replay the message. Keep the old
consumer installed; it can continue handling messages that the Mod has not
claimed. Neither path may duplicate a message already claimed by the other.

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
```

Repository contracts reviewed at the pinned commit: README.md, AGENTS.md,
package.json, collaboration transport/hub/effort, ChatMailbox, the Claude wake
manifest, application Stop state, and the native synchronization hook. Treat the
archived test report as the exact record of what was executed; synthetic tests
are deliberately separate from native deployment evidence.

## App engine packaging in bundle revision 2

`src/app-bundle.mjs` includes both companion commands and all four companion
runtime modules through its existing explicit allowlists. `ENGINE_PLUGIN_FILES`
adds seven exact resources: the manifest, hooks declaration, controller and
register modules, workflow skill, plugin README and native test fixture.
`copyAllowed` copies only these assets and validates plugin directories from the
source root downward. A symlinked parent is rejected before inspecting descendants.

Four added tests cover dependency coverage, staging from copied engine resources,
exclusion of unlisted files, and symlink rejection. The existing full-runtime
allowlist test also passes with these additions. No app setup step automatically
installs or enables the Mod; the standalone stage/install flow stays explicit.
A signed build verifies packaging, not installation or native Mod painting.

# Cross-model collaboration

[Back to README](../README.md)

Run commands from the repository directory. This guide covers execution, not
history synchronization; the two capabilities use separate services and state.

## Work protocol

`claudex collaboration` is an opt-in execution layer alongside history synchronization.
It provides one durable work graph for both delegation and whole-work handoff:
starting child work records its parent, while handing off changes the owner of the
same task. Both Codex and Claude Code can initiate either operation. This layer
requests real model inference and uses native account authentication; history
synchronization still never requests inference.

On macOS, install the independent broker and the `claudex-work` native MCP connection:

```sh
node bin/claudex.mjs collaboration install
node bin/claudex.mjs collaboration status
```

Native clients must reload their MCP connections through their supported lifecycle;
installation does not restart an active app or replace an ongoing conversation.
The broker also runs in the foreground with `collaboration serve`. Its `--root`
is a separate private work root (default `~/.local/share/claudex/collaboration`),
not the history synchronization ledger. Installation, startup, inventory and reads
do not invoke models. This service neither owns nor stops the synchronization watcher.

The MCP interface exposes:

| Tool | Operation |
| --- | --- |
| `claudex_start` | Start work with `provider`, `cwd`, `prompt`, and a stable `requestId`; worker calls create children. |
| `claudex_send` | Queue a follow-up for the next completed boundary of an existing task. |
| `claudex_handoff` | Transfer the same task to the other provider using its current `revision`, a handoff message, and an optional destination `model`. |
| `claudex_status` | Read progress, messages, last native identity and results. |
| `claudex_wait` | Wait up to 30 seconds for a revision change or terminal result. |
| `claudex_cancel` | Cancel owned work and its active descendants. |
| `claudex_list` | Read the bounded work inventory and broker limits. |
| `claudex_chat_list` | List exact native chat identities observed by installed hooks. |
| `claudex_chat_send` | Queue an authorized coordination note for an existing native chat. |
| `claudex_chat_status` | Inspect queued, offered, acknowledged, or expired message state. |

For example, ask Codex to “use Claude to review this change and bring back its
findings,” or ask Claude to “hand this work to Codex with the current progress
and remaining steps.” The caller supplies relevant context; this is not automatic
access to its private native conversation. A root caller obtains results through
status/wait. Inside managed work, each worker receives tools scoped to its own
task and descendants. Handoff preserves the task ID, messages and workspace, not
a native model session or UI chat ID. An external caller relinquishes its own
work by ending its turn; the protocol cannot forcibly stop an unrelated native chat.

A running worker's handoff is recorded first. The next owner starts only after
the outgoing native execution finishes successfully, its primary process group
closes and all recorded owned descendants exit.
The outgoing worker must stop work after handoff acknowledgement. It cannot issue
further mutations with that generation's capability. No handoff occurs after a
failure or an uncertain outcome. Idempotency keys reject changed request payloads
and prevent duplicate dispatch; transport errors never cause automatic replay.
Follow-ups reconstruct the bounded work record in a fresh native invocation.

Handoff receipts include `nextAction: "end-turn"` and the short
`finalResponse` token `CLAUDEX_HANDOFF`. At that boundary the
worker emits only the token, with no further tools or duplicate progress report.
The normal changed-files/checks report belongs to actual task completion, not to
the outgoing boundary. These tokens are instructions, not completion receipts:
the broker still waits for successful native completion and process-group exit.
Model response and shutdown latency is not an instantaneous-transfer guarantee.

## Reading progress and results

`status`, `wait`, and list entries expose `phase`, `terminal`, `cancelPending`,
`resultFinal`, `resultRole`, and `resultGeneration` in addition to existing fields.
`phase` distinguishes queued, waiting-for-children, handoff-pending and cancelling
from running and terminal states. `terminal` includes uncertain; it never means
success by itself. Only `resultFinal: true` identifies the completed answer for
the current task. Legacy `result` remains intact for compatibility and can be an
older generation, a yield boundary, or output retained during cancellation.
Sending a follow-up makes an old result non-final even before generation advances.

`cancel` reports `cancelAccepted`, `cancelPending`, `cancelRequested`, and
`terminal`. Acceptance does not prove native process exit. Wait for settlement;
an unverified shutdown may remain uncertain. Cancelling an already completed,
failed or cancelled task does not change its revision; uncertain work still
requires operator inspection. Request receipts retain their normal idempotency.

`status` and `wait` accept `view: "summary"`; omission keeps the full response.
Summary responses omit message history and include execution input metadata.

Each finished invocation records the native token usage its CLI reported, when
the report is well formed: `inputTokens` (all input, including cache reads and
writes), `cacheReadInputTokens`, `cacheWriteInputTokens`, `outputTokens`, Codex
`reasoningOutputTokens` (part of output) and Claude's own `reportedCostUsd`. Full
status keeps it on `lastExecution.usage`; summary status returns it as
`execution.usage`. `usageTotals` accumulates invocations per provider across
follow-ups, failures and handoffs. Usage is accounting evidence only; a missing
or malformed report never changes an outcome, and it is not a billing statement.
For incremental waits, supply `afterRevision` from the last response. `changed`
compares against that revision (or the revision at the start of an uncursored
wait), and `timedOut` records whether the bounded wait timer expired. A caught-up
terminal response omits repeated result/error bodies. An unseen terminal child
outcome is always delivered to its parent worker even when the supplied cursor
is caught up. A child revision is marked observed only in the same transaction
that returns that outcome, never for an omitted result. Full status remains
available for explicit history inspection. The 30-second wait limit is unchanged.

Each new native invocation persists `active.inputs` with a zero-based,
end-exclusive message range and `kinds` (request, message, child-result, handoff).
The range begins at the preceding invocation's input boundary, not at its final
response; multiple triggers may coexist. The prompt exposes this as
`execution.inputs`, with the generation. Old executions without this metadata
remain valid and are not backfilled or replayed. Workers must read back edited
files before reporting success, but never add checks after an end-turn receipt.

For independent retrospectives, finish child reviews while their parent stays
terminal, then send the parent an explicit summary; alternatively start a separate
root review with the relevant source task IDs and context. Reopening a child while
its parent is active intentionally notifies that parent. This is not a detached
review mode. Parent edges and generation-scoped request IDs are unchanged.

## Messages to existing native chats

Native-chat coordination is separate from managed work and history synchronization.
An external Codex/Claude caller can use `claudex_chat_list` with `query` (a full
title or substring), optional `provider`, and `match: "exact"` or `"contains"`
(default). Select an exact `provider` plus `sessionId`, then call
`claudex_chat_send` with `message` and a
stable `requestId`. Do this only for user-authorized coordination, such as asking
another chat to stop creating work and report whether maintenance is safe.
Managed worker capabilities cannot send to unrelated native chats.

Claude recipients must have been observed by the installed native hooks; Codex
also supports the bounded native metadata discovery described below. Follow
`nextCursor` for additional bounded `chat_list` pages (default 50, maximum 100). The list
contains IDs, cwd, last observed phase/event and time, plus native title metadata
when available. Codex titles come from the newest matching native session-index
record; Claude titles use the exact Desktop registry CLI-ID mapping. No title is
inferred from message content, folder names or synchronized copies. Lookups are
read-only and bounded; missing, conflicting or unsafe metadata produces a title
error rather than a guessed name. Activity is a hint, not proof a process is alive.
Claude search covers hook-registered chats. Codex title queries also inspect
bounded, unarchived native metadata, so a chat need not have fired a hook first.
Metadata discovery is explicitly distinguished from hook registration.
The broker reads the synchronization root beside its private collaboration root
to select the configured Desktop launcher's shared listener. Keep custom
collaboration roots directly inside their synchronization root when using that
integration. An absent shared listener remains an explicit transport error;
discovery does not start another backend. Without a configured launcher, it uses
the native Desktop control endpoint.
Never guess between duplicate or partial matches. Ask the user to disambiguate
using provider and project/cwd. `exactMatchCount`, `titleMatch`, `titleSource` and
`unavailableTitleCount` make the search coverage explicit. Pass the selected
verbatim title as `expectedTitle` when sending: it is rechecked before enqueueing,
and a rename, unavailable mapping or archived Claude entry fails without sending.
Delivery always resolves to an exact native session ID; a title is not a durable
routing identity.
For a unique exact title, `chat_send` also accepts `title` directly (optionally
with `provider`), instead of `sessionId`/`expectedTitle`. It resolves and rechecks
the native title before enqueueing. Duplicate matches return `needs-selection`
with candidates; no match returns `not-found`. Neither queues a message.
The target stays the exact native session: no replacement chat, external writer,
archival, registry/SQLite mutation or direct transcript append is performed.

Hook delivery occurs at the recipient's next SessionStart, UserPromptSubmit, or Stop
hook, using native hook context. At Stop, Codex uses its documented continuation
decision and Claude uses additionalContext, allowing the same chat to reply.
This can consume the recipient's normal model allowance. It does not change that
chat's model, effort, permissions or human instructions. Coordination content is
explicitly labeled and quoted as peer-originated text, not as human/system
authority. It cannot grant new permissions or forcibly interrupt native work.

Sending defaults to `wake: true`; this can consume native account allowance.
`wake: false` only queues for hooks. Codex uses the existing Desktop owner's
untrusted-app input route, inheriting settings. An unloaded original is opened by
exact native deep link before owner discovery; no CLI writer is created. A busy
owner refuses before injection and the message stays queued. Claude uses a
version-pinned renderer plus the dedicated `claudex-desktop-wake` Desktop MCP
bridge, with exact identity, idle, draft, permission and terminal guards. Setup
registers that narrow endpoint; loading an upgraded renderer requires an idle
Claude restart. Claude Desktop must remain open with the bridge loaded, but the
specific recipient chat does not need to be selected or open. Busy work, drafts
and permission prompts may delay dispatch. A vendor frontend update can require
bridge adaptation. Bridge unavailability is not delivery and must not be presented
as successful wake. Its separately pinned asset starts independently of sidebar
visibility or folder grouping, with a recoverable private installation journal.
Lifecycle and wait-reason diagnostics contain no message text or native metadata
values. Authorized acceptance on the current pinned resource verifies one wake,
one native input, the rendered requested reply and a matching ACK in the same
original Claude conversation, without a manually submitted prompt or ACK. Every
new frontend pin needs separate native reception acceptance; synthetic tests or
an installed cache alone do not establish this.
A running tool is not interrupted; a
message can wait until the current turn ends. SessionEnd never consumes messages.
Known ended chats may still receive queued messages. Their computed
`deliveryStatus` is `waiting-for-resume`; a genuine SessionStart or UserPromptSubmit
reactivates the recipient. A late Stop cannot reactivate an ended session.
Other queued messages report `waiting-for-hook`. These are delivery explanations,
not successful receipt or an automatic wake claim; normal expiry still applies.
A Stop already continued by hooks can acknowledge a previous note but cannot
consume another, avoiding a continuation loop. Ordinary hooks with no queued
message remain inference-free and produce no additional context. A Stop offering
a message emits a started hint instead of a completed synchronization hint; the
later true completion remains subject to the normal history/lifecycle guards.

Receipts distinguish:

- `queued`: persisted, awaiting a usable native hook or wake; not delivered.
- `offered`: claimed for a hook or native wake; consumption is not proven. This state
  never retries automatically, including after a hook crash or lost stdout.
- `acknowledged`: the same exact recipient's native Stop reported a standalone
  `CLAUDEX_ACK:<messageId>` line. This confirms receipt, **not completion of the
  requested action**. Check actual work/process state before restarting services.
- `expired`: queued message exceeded its TTL before being offered.

Native wake atomically claims the same queue used by hooks. A generation-bound
claim is persisted before dispatch; lost/unknown outcomes are never resent.
`wake.state: accepted` means the native call was accepted, not that the model
completed the requested work. The recipient's exact hook ACK remains separate.

Messages are capped at 1,500 UTF-8 bytes, with a default 15-minute TTL (up to one
hour). The private `collaboration/chat-mailbox/state.json` is bounded to 1,024
chats/messages/receipts and 8 MiB; it preserves receipts rather than silently
pruning or replaying work. No raw hook prompt or transcript is stored. Hook
registration and delivery stop when the graphical app's Quit hold is active.

Native clients may need to refresh MCP tool discovery to see the three new tools;
the CLI can use `collaboration request chat_list|chat_send|chat_status` in the
existing source conversation meanwhile. For example, pass this JSON to
`claudex collaboration request chat_send --peer codex` on stdin:

```json
{
  "provider": "claude",
  "title": "Exact recipient title",
  "message": "Please stop creating new tasks and report when your current work is safe to pause.",
  "requestId": "maintenance-note-1"
}
```

This is cooperative messaging, not an automatic restart negotiation or permission
to kill a recipient's work. Task IDs from `claudex_list` are not native chat IDs.
Existing hook configuration and its native trust checks remain unchanged.

## Model selection

Claudex stores separate Codex and Claude default model IDs in the private broker
state. Configure them in the app's advanced settings or through the running broker:

```sh
node bin/claudex.mjs collaboration models
node bin/claudex.mjs collaboration models --codex-model MODEL_ID --claude-model MODEL_ID
```

Supply both options when saving; an empty string resets that provider to its
native CLI default. Saving settings starts no model work and does not restart
services. The controller-only `models` request accepts `{}` for a read or
`{"defaultModels":{"codex":null,"claude":null}}` to reset both providers.
Worker capabilities cannot change these global defaults.

For `claudex_start` and `claudex_handoff`, an explicit `model` overrides the
destination provider's saved default. Omission uses that provider's saved default;
explicit `null` chooses the native CLI default even when a saved default exists.
Children use their destination provider's default, not their parent's model ID.
A handoff captures its selected destination model when requested. Later preference
changes cannot alter pending handoffs, queued tasks, or running invocations.
Follow-ups retain the task's selected model. Native-default selection remains a
delegation to the installed CLI, not a pinned model version.

Model IDs are passed directly to the selected vendor CLI. Claudex does not assume
that a model available in one account is available in another, silently substitute
models, or change permissions when choosing a model. Invalid or unavailable model
errors remain visible. Defaults do not inherit the model selected in the Desktop
chat UI. Existing tasks retain their saved selection when upgrading.

### Reasoning effort

The same settings panel provides separate provider-native reasoning effort defaults.
`models` returns `defaultModels` and `defaultEfforts`; settings requests may update
either complete provider pair without replacing the other. For example:

```sh
node bin/claudex.mjs collaboration models --codex-effort high --claude-effort medium
```

An empty effort resets that provider to its native default. `claudex_start` and
`claudex_handoff` accept optional `effort`: omission selects the destination
provider's saved default, while explicit `null` requests the native default.
Selections are captured with the request, not changed by later preferences.
Follow-ups retain the task effort; children do not inherit another provider's
effort. Existing tasks and pending handoffs missing effort retain native defaults.

Codex receives `-c model_reasoning_effort="LEVEL"`; Claude receives `--effort LEVEL`.
The recognized Codex values are none, minimal, low, medium, high, xhigh, max, ultra;
Claude values are low, medium, high, xhigh, max. Individual models may support only
a subset. Unsupported provider values fail explicitly; Claudex does not translate
effort levels between providers or silently substitute a different value.
Model-specific support is enforced by the native runtime, not inferred from names.
These are **requested** levels, not evidence of the model's effective internal
reasoning budget. Native account/organization policy still applies; Claude may
cap effort silently in stream-json mode. No guard or policy is bypassed.
An inherited `CLAUDE_CODE_EFFORT_LEVEL` environment override is removed from the
isolated worker so it cannot override the task selection. Native default selection
does not imply inheriting the effort shown in the parent Desktop conversation.

See the [Codex configuration reference](https://developers.openai.com/codex/config-reference)
and [Claude model configuration](https://code.claude.com/docs/en/model-config)
for vendor-specific semantics and policy limits.

## Permissions and limits

For a first-time write-enabled installation, use
`node bin/claudex.mjs collaboration install --allow-write`. For an existing
installation, wait for all work to finish and safely stop its collaboration
LaunchAgent before reinstalling with a different policy. The installer refuses
to replace a loaded job whose configuration changes. `service stop` controls the
synchronization watcher, not this broker; the collaboration install result
identifies its separate LaunchAgent. Stopping a broker during work cancels its
owned invocations and does not undo their edits.


Manual CLI installation defaults to read-only. The macOS app profile enables all
projects and sets the default task permission to `workspace-write`; an explicit
read-only request and a read-only parent's child remain read-only. File editing
requires a broker installed or started with
`--allow-write` **and** task `permission: "workspace-write"`. A child cannot elevate
its parent's permission or expand its directory grants. Use a dedicated checkout for
writable work: the protocol does not create worktrees, merge edits, or prevent an
unrelated editor from modifying the same files. Tasks may run concurrently in the
same or overlapping directories, including writable parent/child tasks and a
writer overlapping another task's reference directory. The broker does not lock
workspaces or merge conflicting edits. Assign disjoint file responsibilities and
coordinate shared-file changes explicitly. Children may start while their parent
is running; use status/wait to collect their results. A parent that ends its turn
with outstanding children resumes with their durable results after they finish.

### Project and additional directory access

`claudex_start` resolves `cwd` to the nearest enclosing Git checkout root by
default, including linked worktrees. This uses bounded filesystem metadata, not
a required Git executable. Non-Git directories retain their supplied `cwd`.
Optional `projectRoot` explicitly selects a directory containing `cwd` (including
`projectRoot: cwd` to keep a subdirectory scope). The effective working directory
and grants are returned in the start receipt and task status.

Optional `readOnlyDirs` and `writableDirs` are arrays of existing absolute paths,
up to 16 per kind. They are task-specific grants, not global settings. Supply only
paths authorized for the user's task, never automatically include neighboring
projects. Read-only tasks cannot request writable directories. Canonical symlink
targets are resolved at admission and rechecked before dispatch; changed saved
roots fail rather than being silently retargeted. Read-only reference directories
must not overlap writable grants. Filesystem-root grants and write access covering
the entire home directory are rejected.

Children inherit the parent's grants unless explicitly narrowed. They may select
a contained primary directory but cannot turn a read-only reference into a write
grant or add a path outside the parent's authorization. Read-only children convert
inherited additional write grants into read access. Handoff retains the same
directory grants; expanding scope requires a newly authorized root task. Legacy
tasks without scope metadata keep their original exact working directory.

Codex uses its native sandbox and `--add-dir` only for additional writable paths;
references are never passed as writable roots. When reference grants are present,
implicit `/tmp` and `$TMPDIR` write grants are excluded to preserve read-only
references there. Codex retains its native read access; these reference declarations
are not a claim of an OS-level read allowlist. Claude keeps `--restricted` and
bounded file tools, adds authorized directories, and supplies native absolute
`Edit` deny rules for references (these also cover Write). Unrepresentable native
permission patterns fail explicitly. No Bash or permission-bypass flag is added.

Example start parameters:

```json
{
  "provider": "claude",
  "cwd": "/work/app/src",
  "readOnlyDirs": ["/work/reference-docs"],
  "writableDirs": ["/work/shared-package"],
  "permission": "workspace-write",
  "prompt": "Update the app and shared package using the reference documentation.",
  "requestId": "app-package-update-1"
}
```

Codex runs `exec --ephemeral --json` with an explicit native read-only or workspace-write
sandbox, user configuration disabled, and the collaboration MCP connection supplied
explicitly. Claude runs nonpersistent print mode with restricted file tools and
explicit MCP configuration. Its read-only mode has Read/Glob/Grep; its write mode
also has Edit/Write, **not Bash**. Unattended approval requests are not auto-granted.
These profiles do not inherit arbitrary hooks, plugins, MCP connections or model
settings. With no requested or saved provider model, each native CLI selects its default. Workers
are instructed to read applicable repository guidance. Native account login is
reused without copying credentials; inherited API-key variables are removed.

Private Unix sockets, controller/worker capabilities, and generation checks prevent
accidental cross-task control. They are not a security boundary against hostile
processes running as the same OS user. Prompts and results are text-only, stored
under the private root, never in the repository. Native ephemeral/nonpersistent
sessions do not become synchronization sources. No Desktop renderer integration,
image transfer, exact native-context migration, or automatic source-chat archival
is implied by the work protocol.

Defaults allow up to 64 concurrent workers, delegation depth three, twelve native executions per
task, 1,000 tasks, 10,000 idempotency receipts and a 32 MiB ledger. Context and native
output are separately bounded. Capacity errors are explicit; no history or receipt
is silently pruned. Work has no elapsed-time execution timeout; long-running
native invocations continue until completion, failure or explicit cancellation.
The bounded wait/socket request timeouts only end the caller's wait, not the work.
These limits are not a monetary spending guarantee; native account quotas still apply.
The 64-worker ceiling is not evidence of a 64-worker native load certification.

After a broker crash, in-flight work becomes `uncertain` and blocks new dispatch.
No native input or pending handoff is replayed. Inspect the last recorded native
process/session and workspace before operator recovery; do not clear the ledger
to regain availability. Completed work remains readable. Cancellation targets only
the invocation's verified owned processes and does not undo file changes.
Native tools can create separate process groups. One shared metadata sampler
records observed same-user descendants through exact ancestry, PID, UID, process
group and UTC start identity. A descendant whose start identity is absent from a
complete sample has exited and is retired, so the 256-record bound applies to
descendants that are still unresolved, not to every short-lived test or tool
process of a long invocation. Individual signals recheck those identities. This does not capture every instantaneous fork
or provide isolation against hostile same-user processes. Primary-group closure
remains required. Missing, changed or incomplete inventories retain uncertainty;
they never authorize replay or a successful shutdown report.

A controller can explicitly close an inspected uncertain task as
failed through `claudex collaboration request resolve --peer codex`, supplying
JSON on stdin with `taskId`, the current `revision`, a stable `requestId`,
`outcome: "failed"` and a nonempty `reason` of at most 2,048 bytes. This operation
is not an MCP worker tool. The broker checks that the recorded native PID and its
process group and every recorded descendant are absent, refuses permission or inspection errors, active
in-memory workers, missing process evidence and unfinished
descendants. The original messages, error, native execution evidence and result
are preserved together with a durable resolution and inspection timestamp.
It never claims success or reruns that task. Removing the last uncertainty allows
other queued work and waiting parents to proceed; inspect or cancel unwanted
queued work before resolving. For writable work, first inspect and reconcile all
affected files, then also supply `workspaceReconciled: true` and nonempty
`reconciliationNotes` (at most 4,096 bytes) describing retained/validated outputs,
partial changes and their disposition. This is an explicit controller attestation,
not an automatic filesystem validation. The receipt preserves these notes and the
task's exact directory grants. It never deletes files, rolls back edits or bypasses
the process-absence and revision checks.

An interrupted descendant inventory (for example, one that exceeded its bound)
cannot prove that unrecorded descendants exited. After inspecting the machine for
processes still working in the task's directories, the controller may also supply
`processInventoryReconciled: true` and nonempty `processInventoryNotes` (at most
4,096 bytes) describing that inspection. The leader, its process group and every
recorded descendant must still be absent; the receipt keeps the notes and the
original incomplete inventory. Only a resolved, attested task stops blocking the
collaboration shutdown check used by Quit.

## Verification scope

The protocol, native command profiles, cancellation and both-direction handoff
contracts have synthetic tests, plus a real broker/stdio MCP process smoke test
without inference. Separately user-authorized native acceptance on Codex CLI
`0.158.0-alpha.2.1` and Claude Code `2.1.283` verifies both directions of model-created
child delegation, exact child-result return, and a Codex-to-Claude-to-Codex whole-work
handoff under one logical task ID. Seven real native executions completed across
five task records in an isolated read-only workspace, with unchanged test files,
no replay, closed owned process groups, and no observed enrollment of the checked
native IDs by the history watcher. Existing native account logins were used.
Separately authorized writable acceptance on the same runtimes verifies both
directions of child file editing, parent yield and automatic resumption, and
Codex-to-Claude-to-Codex sequential edits of one file under the same task ID.
Nine native executions completed across five task records in a separate temporary
broker with writes enabled. Exact final bytes, one child per parent, recorded
parent/child execution ordering and exited process groups were checked. The
temporary broker was stopped afterward; the installed service kept its read-only
default. This validates bounded text-file editing, not arbitrary builds, shell
availability in Claude, Desktop UI chat transfer, arbitrary future runtimes, or
synchronization compatibility for every feature of these versions. Automated
tests still never start inference.

Additional isolated native checks on Codex `0.159.2` and Claude Code `2.1.283`
cover writable bidirectional delegation, parent resumption, consecutive handoffs,
completed-task follow-up, native reference-write denial, cancellation, broker
shutdown and crash recovery. Eighteen native invocations include the reproducer
for a separate-process-group cancellation leak. After its repair, live recorded
descendants block uncertain resolution until verified cleanup; queued work then
dispatches once. These checks preserve the same Desktop UI and general
synchronization compatibility limits stated above.

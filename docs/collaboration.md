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
| `claudex_handoff` | Transfer the same task to the other provider using its current `revision` and a handoff message. |
| `claudex_status` | Read progress, messages, last native identity and results. |
| `claudex_wait` | Wait up to 30 seconds for a revision change or terminal result. |
| `claudex_cancel` | Cancel owned work and its active descendants. |
| `claudex_list` | Read the bounded work inventory and broker limits. |

For example, ask Codex to “use Claude to review this change and bring back its
findings,” or ask Claude to “hand this work to Codex with the current progress
and remaining steps.” The caller supplies relevant context; this is not automatic
access to its private native conversation. A root caller obtains results through
status/wait. Inside managed work, each worker receives tools scoped to its own
task and descendants. Handoff preserves the task ID, messages and workspace, not
a native model session or UI chat ID. An external caller relinquishes its own
work by ending its turn; the protocol cannot forcibly stop an unrelated native chat.

A running worker's handoff is recorded first. The next owner starts only after
the outgoing native execution finishes successfully and its process group closes.
The outgoing worker must stop work after handoff acknowledgement. It cannot issue
further mutations with that generation's capability. No handoff occurs after a
failure or an uncertain outcome. Idempotency keys reject changed request payloads
and prevent duplicate dispatch; transport errors never cause automatic replay.
Follow-ups reconstruct the bounded work record in a fresh native invocation.

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
its parent's permission or change its workspace. Use a dedicated checkout for
writable work: the protocol does not create worktrees, merge edits, or prevent an
unrelated editor from modifying the same files. Within a broker, overlapping
writable tasks in the same canonical directory are serialized. Writable delegation
returns `deferredUntilParentExit`: the parent ends its native turn to release the
workspace, the child runs, then the parent resumes with the child's result. This
also covers a read-only child of a writable parent. Read-only workers may run
concurrently. Waiting on a deferred child before releasing its workspace is refused.

Codex runs `exec --ephemeral --json` with an explicit native read-only or workspace-write
sandbox, user configuration disabled, and the collaboration MCP connection supplied
explicitly. Claude runs nonpersistent print mode with restricted file tools and
explicit MCP configuration. Its read-only mode has Read/Glob/Grep; its write mode
also has Edit/Write, **not Bash**. Unattended approval requests are not auto-granted.
These profiles do not inherit arbitrary hooks, plugins, MCP connections or model
settings. With no requested model, each native CLI selects its default. Workers
are instructed to read applicable repository guidance. Native account login is
reused without copying credentials; inherited API-key variables are removed.

Private Unix sockets, controller/worker capabilities, and generation checks prevent
accidental cross-task control. They are not a security boundary against hostile
processes running as the same OS user. Prompts and results are text-only, stored
under the private root, never in the repository. Native ephemeral/nonpersistent
sessions do not become synchronization sources. No Desktop renderer integration,
image transfer, exact native-context migration, or automatic source-chat archival
is implied by the work protocol.

Defaults allow three workers, delegation depth two, twelve native executions per
task, 1,000 tasks, 10,000 idempotency receipts and a 32 MiB ledger. Context and native
output are separately bounded. Capacity errors are explicit; no history or receipt
is silently pruned. Tasks time out after 15 minutes. These are execution limits,
not a monetary spending guarantee; native account quotas still apply.

After a broker crash, in-flight work becomes `uncertain` and blocks new dispatch.
No native input or pending handoff is replayed. Inspect the last recorded native
process/session and workspace before operator recovery; do not clear the ledger
to regain availability. Completed work remains readable. Cancellation targets only
the invocation's owned process group and does not undo file changes.

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

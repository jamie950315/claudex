# Claudex

Let Codex and Claude Code delegate work to each other, hand off a task, and
continue supported conversations across their native tools.

Claudex provides two independent capabilities:

- **Cross-model collaboration:** agents create child tasks, exchange messages,
  return results, and transfer responsibility through one work protocol.
  Authorized coordination notes can also target an existing native chat by its
  unique exact title and wake it through supported Desktop integrations, without
  creating or archiving a replacement chat.
- **Conversation synchronization:** completed conversation turns become available
  in the other tool, with original history preserved and bounded generated copies.

Collaboration runs models using your native accounts. Synchronization transports
history without asking a model to generate a reply or summarize it.

Current development build: **Claudex.app 1.2.27**, bundling **Claude Mod 0.8.15**.
Latest published release: **1.2.27** — [download and checksums](https://github.com/jamie950315/claudex/releases/tag/v1.2.27)
· [Release notes](docs/releases/1.2.27.md).
App and Mod versions are separate. Guides on `main` describe current behavior;
documents viewed under a release tag remain that release's original snapshot.

## Requirements

- Apple Silicon and macOS 13 or later for the published app, with ChatGPT/Codex
  and Claude desktop apps already installed.
- Native account access for the Codex and Claude Code workflows you want to use.
- Node.js `22.15+` (22.x) or `23.8+`, and Git only for command-line/source installation; the macOS app
  bundles its runtime and can supply missing CLI components.
- For Desktop synchronization, the native desktop applications and compatible
  runtimes listed under [Compatibility and verification](#compatibility-and-verification).

Claudex does not copy credentials or require a separate API key for these native
account workflows. Model work consumes the account's available usage; execution
limits are not a monetary spending guarantee.

## macOS app

Claudex.app is the graphical setup path for people who already use the two desktop
apps. Place it in a stable Applications location, open it, and let setup configure
the integrations. All projects and task-scoped file editing are enabled by default;
there is no project-by-project enrollment. The app reuses existing native tools,
adds missing CLI components, and guides any required official sign-in.
It also installs and updates the bundled Claude Mod, preserves existing plugin
preferences, and reports installed and loaded-session versions separately.
No separate terminal Mod installation is needed; use `/claudex` in a Claude Code
session for its work pane. Existing sessions may need a new session to load an update.

It does not download or replace ChatGPT/Codex or Claude Desktop, copy credentials,
force-close active work, or bypass macOS permissions and compatibility checks.

The current Apple Silicon app build is development-signed, not notarized for
frictionless public distribution. See the [app guide](docs/app.md) for setup,
verification boundaries, and developer packaging instructions. Do not treat a
successful build as clean-machine or notarized-release acceptance.

## Command-line installation

### Optional Claude Mod control pane

The optional [native Mod companion](docs/claude-mod.md), using the public Claude
Code **2.1.287** Mod API baseline,
adds `/claudex` in the terminal and Desktop **Code** tab: context/usage display,
task and exact-chat lookup, reviewed delegation/follow-up/cancellation, model
defaults, and durable action receipts. Writes require preview and confirmation.
It uses the existing broker; it does not replace conversation synchronization,
MCP, native hooks, or Desktop folder/archive integrations.

The bundled Mod is **0.8.15**. It provides opt-in native delivery, public work
views and loaded-version diagnostics. `mod-self` delivers to the recipient's own
loaded Mod; the older `mod` route requires another eligible loaded sender.
Route selection, receiver opt-ins and per-message wake intent remain separate.
Inspect them with `node bin/claudex.mjs collaboration native-wake`; change a route
only after its own native activation acceptance. Defaults remain off and there
is no feature-flag, permission or native inbound-policy bypass.

Stage it with `node bin/claudex-mod.mjs stage --root /absolute/private/root --output /new/marketplace`,
then follow the guide's native validation and plugin installation steps. Staging
does not install or enable it. Native peer delivery requires explicit opt-in and
separate recipient/ACK acceptance; do not upgrade a running sync runtime merely
to load the pane. See the [Mod guide](docs/claude-mod.md) for current setup and
the [historical handoff](docs/claude-mod-handoff.md) for earlier rollout evidence.
The installed Desktop 2.1.286 runtime also passed native validation and command
registration without extra flags. Inspect actual Mod availability before deciding
that a runtime upgrade is needed. Real Desktop pane/usage-band rendering and a
read-only broker response are also verified on that 2.1.286 build, with the
existing Traditional Chinese app unchanged. Native delivery stays opt-in.

### Source checkout

This remains available for development and manually managed installations.

```sh
git clone https://github.com/jamie950315/claudex.git
cd claudex
npm ci --ignore-scripts
```

Run the commands below from the repository directory. Choose collaboration,
synchronization, or both; installing one does not enable the other.

## Collaborate across models

```sh
node bin/claudex.mjs collaboration install
node bin/claudex.mjs collaboration status
```

This installs an independent background broker and registers the `claudex-work`
MCP connection with Codex and Claude Code. Reload the clients' MCP connections
through their normal lifecycle when needed; installation does not restart active
apps or replace an ongoing conversation.

You can then ask either agent to use the other, for example:

- “Ask Claude Code to review this change and bring back its findings.”
- “Delegate this file-editing task to Codex, then verify its result.”
- “Hand this task to Claude with the progress, constraints, and remaining work.”
- “Send a message to the chat named Release review asking for its current status.”

Delegation and handoff share the same work graph. A child task records its parent
and returns a result. A handoff changes the owner of the existing logical task;
it does not swap the model inside an unrelated native chat. Callers pass the
relevant context explicitly and use the protocol to read progress and results.
The MCP interface exposes 15 tools. A supervisor can proactively send direction
while a worker is running; cooperative check-in and eligible worker MCP responses
deliver it in the same invocation. Exact acceptance/rejection receipts prevent
consumed instructions from scheduling duplicate work. Opted-in managed-child
milestones can resume a waiting parent before child completion. This does not
interrupt a running native tool or enable an external native-chat wake by itself.

### Allowing file edits

Manual CLI installation defaults to read-only. Writing requires effective broker
authorization and a writable task permission. An explicit controller-saved
permission default also authorizes that level; a child never exceeds its parent.
Choose the workspace-write-enabled option at first
installation if required:

```sh
node bin/claudex.mjs collaboration install --allow-write
```

Do not run this as a hot policy change against an already loaded broker. Existing
installations must be stopped safely before changing their configuration; see
[permissions and limits](docs/collaboration.md#permissions-and-limits).

Use a dedicated checkout for writable work. Multiple tasks, including writable
parents and children, may run in the same directory at once. Assign disjoint files
and coordinate shared edits: the protocol does not lock workspaces, create
worktrees, or merge conflicts. Work has no fixed execution timeout; explicit
cancellation remains available. In read-only/workspace-write profiles, Claude
workers have bounded file tools without Bash and Codex uses its native sandbox.
Explicit **Full access** uses the user's normal tools, settings and hooks without
a sandbox or permission prompts; it is not the default for new installations.

### Messages to existing chats

Models can send a coordination note using a unique exact chat title; ambiguous
titles require selection. Claude Desktop must remain open with its supported
delivery route available. The renderer route can open an unloaded recipient;
Mod routes require their eligible sessions to be loaded and do not create a
replacement owner. Native inbound policy, busy work, drafts or permission prompts
can delay or refuse delivery. Ended chats may queue messages for
resumption; a queued note is not a delivered note. A recipient ACK confirms receipt,
not completion of the requested action. Claude's renderer adapters follow cached
frontend deployments through unique structural anchors. Newly installed graphs
require an idle Claude restart; unsupported structural changes are reported.

See the [collaboration guide](docs/collaboration.md) for the MCP tools, follow-ups,
cancellation, workspace ownership, and failure handling.

## Synchronize conversations with Desktop

For a **fresh synchronization state root**:

```sh
node bin/claudex.mjs init --all-projects
node bin/claudex.mjs desktop install
node bin/claudex.mjs service install
node bin/claudex.mjs status
node bin/claudex.mjs doctor
```

Initialization does not overwrite existing configuration. Desktop installation
does not migrate an existing CLI-only ledger. See the
[compatibility guide](docs/compatibility.md) if you already have one.

The shared Codex backend activates on the next normal desktop-app start; do not
interrupt active work to apply it. Wait for service readiness before switching:

1. Let the current reply finish in Codex or Claude Desktop's supported Code entry.
2. Wait for delivery, then open the current same-title continuation in the other app.
3. Continue on only one side of that logical conversation at a time.

Synchronization happens at completed-turn boundaries, not token by token.
Originals are preserved; a continuation can have a different native session ID.
Folder placement and archival of a superseded Claude Local entry are separate,
opt-in integrations. Claude Remote Control transmits the selected conversation
through your Claude account; it is not a local-only transport.

See the [synchronization guide](docs/synchronization.md) for activation, daily use,
optional folder integration, retention, and recovery.

Desktop synchronization automatically stops tracking conversations whose saved
working directory is confirmed absent, preserving their histories, checkpoints
and assets. They remain stopped after restart or restoration of the directory.
Desktop `untrack CONVERSATION_ID` also stops one enrollment manually.
`resume-tracking CONVERSATION_ID` verifies and restores that enrollment. Both
commands require the owned watcher to be stopped; see
[history-preserving maintenance](docs/synchronization.md#stop-tracking-while-preserving-history)
for retention limits and explicit branch repair.

## Compatibility and verification

Compatibility is feature-specific. Collaboration acceptance does not expand the
synchronization runtime allowlist.

| Capability | Version evidence | Verified behavior |
| --- | --- | --- |
| Cross-model collaboration | Codex CLI `0.158.0-alpha.2.1`; Claude Code `2.1.283` | Both-direction child delegation and result return, parent resumption after file edits, and consecutive owner transfers under one task ID. |
| Cooperative in-flight follow-up | Codex CLI `0.159.0-alpha.12.1`; Claude Code `2.1.283` | Both real supervisor/child directions accepted a proactive instruction and completed in generation one, without a child blocker or duplicate invocation. |
| Claude Mod | Bundled `0.8.15`; Desktop Code `2.1.286`, documented Mod API baseline `2.1.287` | Cache settings pane and commands for native 1h/5m TTL and session-only, remember-last or fixed-default persistence. Warming remains default-off. Source/synthetic checks and native activation are separate; see the [cache-warming guide](docs/cache-warming.md). Installed and loaded versions are separate. |
| Codex cache warming | Desktop native runtime `0.160.0`, experimental best-effort | CLI opt-in and a separately trusted `/claudex:warm` text-command hook for the current loaded primary chat. Native backend acceptance verified seven local command turns without model output or usage; rendered UI remains unverified. No draft-state or per-turn no-tools control; no native TTL setting. A prior native enrollment verified one refresh but not retention extension. See [limits and confirmation](docs/cache-warming.md#codex-desktop-experimental-best-effort). This does not expand the synchronization allowlist. |
| Desktop synchronization | Strict Codex baseline `0.155.0-alpha.16.3` / `.16.4`; Claude Code `2.1.281` with SDK `0.3.281` | Native conversation delivery, real Desktop alternation, supported compaction and image cases, identity preservation, and bounded snapshot retirement. |

Manual CLI initialization defaults to `versionPolicy: "strict"`; new graphical
installations use `warn`, preserving an explicitly selected existing policy.
`warn` permits attempts on other runtimes without version-only warnings; it does not certify them or relax
history, ownership, authentication, or conflict checks. See
[version-only enforcement](docs/synchronization.md#version-only-enforcement).

Important boundaries:

- Collaboration currently exchanges text work records, not full native chat
  state, image inputs, or native permissions.
- Sandboxed Claude collaboration workers cannot run arbitrary shell-based builds
  or tests; explicit Full access is a different, less restricted execution profile.
- Desktop synchronization targets the supported Code/Remote Control paths,
  not ordinary Chat or Cowork conversations.
- Opaque or incomplete histories, unsupported assets, conflicting changes, and
  active native writers can block synchronization. They are not silently discarded.
- Folder presentation depends on a verified frontend resource; an app update
  can require revalidation.
- Failed or uncertain writes are not automatically replayed. Cancellation is not
  rollback. Uncertain work blocks its own task tree and overlapping writable access,
  not unrelated dispatch; proven-exited uncertain work can be closed as failed.

## Documentation and development

- [Collaboration](docs/collaboration.md): tools, execution profiles, permissions,
  limits, and live acceptance scope.
- [macOS app](docs/app.md): existing-app prerequisites, automatic setup, and packaging.
- [Synchronization](docs/synchronization.md): Desktop setup, native integration,
  lifecycle guards, storage, and recovery.
- [CLI-only compatibility](docs/compatibility.md): existing installations and
  migration boundaries.
- [Contributor instructions](AGENTS.md): implementation and verification contracts.

```sh
npm test
```

Automated tests use synthetic work or no-inference native checks. Real model
acceptance is separately authorized; passing a fixture is not proof of a live
native workflow. Runtime state, transcripts, and credentials stay outside the
repository.

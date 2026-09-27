# Claudex

Let Codex and Claude Code delegate work to each other, hand off a task, and
continue supported conversations across their native tools.

Claudex provides two independent capabilities:

- **Cross-model collaboration:** agents create child tasks, exchange messages,
  return results, and transfer responsibility through one work protocol.
- **Conversation synchronization:** completed conversation turns become available
  in the other tool, with original history preserved and bounded generated copies.

Collaboration runs models using your native accounts. Synchronization transports
history without asking a model to generate a reply or summarize it.

## Requirements

- macOS and Node.js 22 or later.
- Codex CLI and Claude Code installed and signed in to the accounts you want to use.
- For Desktop synchronization, the native desktop applications and compatible
  runtimes listed under [Compatibility and verification](#compatibility-and-verification).

Claudex does not copy credentials or require a separate API key for these native
account workflows. Model work consumes the account's available usage; execution
limits are not a monetary spending guarantee.

## Install

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

Delegation and handoff share the same work graph. A child task records its parent
and returns a result. A handoff changes the owner of the existing logical task;
it does not swap the model inside an unrelated native chat. Callers pass the
relevant context explicitly and use the protocol to read progress and results.

### Allowing file edits

The default is read-only. Writing requires both broker `--allow-write` and task
`permission: "workspace-write"`. Choose the write-enabled option at first
installation if required:

```sh
node bin/claudex.mjs collaboration install --allow-write
```

Do not run this as a hot policy change against an already loaded broker. Existing
installations must be stopped safely before changing their configuration; see
[permissions and limits](docs/collaboration.md#permissions-and-limits).

Use a dedicated checkout for writable work. Writable child tasks wait for the
parent to end its native turn; the child runs, then the parent resumes with its
result. The protocol does not create worktrees or merge changes. Claude workers
have file-reading and editing tools, not Bash; Codex uses its native sandbox.

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

## Compatibility and verification

Compatibility is feature-specific. Collaboration acceptance does not expand the
synchronization runtime allowlist.

| Capability | Version evidence | Verified behavior |
| --- | --- | --- |
| Cross-model collaboration | Codex CLI `0.158.0-alpha.2.1`; Claude Code `2.1.283` | Both-direction child delegation and result return, parent resumption after file edits, and consecutive owner transfers under one task ID. |
| Desktop synchronization | Strict Codex baseline `0.155.0-alpha.16.3` / `.16.4`; Claude Code `2.1.281` with SDK `0.3.281` | Native conversation delivery, real Desktop alternation, supported compaction and image cases, identity preservation, and bounded snapshot retirement. |

Synchronization uses `versionPolicy: "strict"` by default. An explicit `warn`
policy permits attempts on other runtimes; it does not certify them or relax
history, ownership, authentication, or conflict checks. See
[version-only enforcement](docs/synchronization.md#version-only-enforcement).

Important boundaries:

- Collaboration currently exchanges text work records, not full native chat
  state, image inputs, or native permissions.
- Claude collaboration workers cannot run arbitrary shell-based builds or tests.
- Desktop synchronization targets the supported Code/Remote Control paths,
  not ordinary Chat or Cowork conversations.
- Opaque or incomplete histories, unsupported assets, conflicting changes, and
  active native writers can block synchronization. They are not silently discarded.
- Folder presentation depends on a verified frontend resource; an app update
  can require revalidation.
- Failed or uncertain writes are not automatically replayed. Cancellation is not
  rollback, and an uncertain collaboration task blocks new dispatch.

## Documentation and development

- [Collaboration](docs/collaboration.md): tools, execution profiles, permissions,
  limits, and live acceptance scope.
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

# Claudex

Let Codex and Claude Code work together on your Mac: ask one to delegate a task
to the other, hand a task over, message an existing chat, and continue a
conversation in the other app.

Current build: **Claudex.app 2.0.17**, bundling **Claude Mod 0.8.75**.
Latest published release: **2.0.17** · [Download](https://github.com/jamie950315/claudex/releases/tag/v2.0.17)
· [Release notes](docs/releases/2.0.17.md)

## Requirements

- A Mac with Apple Silicon, macOS 13 or later.
- The official **ChatGPT/Codex** and **Claude** desktop apps, installed and signed in.

You do not need Git, Node.js, Rust or the Terminal. Claudex uses your existing
accounts; it does not copy credentials or need an API key. Model work consumes
your accounts' normal usage.

## Install

1. Download `Claudex-v2.0.17-macOS-arm64.zip` from the
   [release page](https://github.com/jamie950315/claudex/releases/tag/v2.0.17),
   unzip it, and drag **Claudex.app** into **Applications**. Do not move it later.
2. Open Claudex. The build is development-signed, not notarized, so macOS may
   block the first launch. Go to **System Settings › Privacy & Security** and
   choose **Open Anyway**.
3. Setup runs automatically and shows a checklist. Allow what it asks for:
   - **Sign-in:** complete the official browser sign-in if a row requests it.
   - **Codex hooks:** type `/hooks` in Codex and trust the listed Claudex hooks.
     Codex never runs an untrusted hook, and Claudex cannot approve it for you.
   - **macOS prompts:** allow notifications and the Claudex background/login item.
   - **Restart:** when a row asks, quit and reopen Claude or Codex after your
     current replies finish. Claudex never force-closes your work.
4. When the checklist is ready, you are done. Claudex lives in the menu bar and
   starts quietly at login.

Setup installs any missing Codex/Claude CLI components, the collaboration
service, the Claude Mod and the synchronization service. All projects are
enabled, with task-scoped file editing. Details: [macOS app guide](docs/app.md).

## Use

Ask either agent in plain language, for example:

- “Ask Claude Code to review this change and bring back its findings.”
- “Delegate this file-editing task to Codex, then verify its result.”
- “Hand this task to Claude with the progress, constraints and remaining work.”
- “Send a message to the chat named Release review asking for its status.”

In Claude Code, type `/claudex` for the Claudex pane (tasks, usage, model
defaults). Open a new session after an update to load the new Mod.

To continue a conversation in the other app, let the current reply finish, then
open the chat with the same title in the other app. Use one side at a time.
Synchronization happens after each completed turn and keeps the original history.

**Show advanced diagnostics** in the Claudex window sets default models,
reasoning effort and sub-agent permission (Read only, Workspace write or Full
access). **Quit Claudex** stops its services safely; closing the window does not.

## Limits

- Collaboration exchanges text work records, not full chat state, images or
  native permissions. Sandboxed Claude workers cannot run shell builds or tests.
- Writable tasks in one folder are not locked against each other; give
  parallel tasks separate files.
- Synchronization covers Claude Desktop's Code/Remote Control paths, not
  ordinary Chat or Cowork conversations. Remote Control carries the selected
  conversation through your Claude account; it is not a local-only transport.
- Incomplete or opaque histories, conflicting edits on both sides and active
  native writers pause synchronization instead of discarding anything. Failed
  or uncertain writes are never replayed automatically.
- Newly enrolled Codex voice chats preserve saved speaker transcripts and native
  handoffs, not original audio. Existing checkpoints keep their representation;
  open realtime sessions wait for a persisted closed boundary.
- Vendor app updates can require Claudex to revalidate its integrations; the
  checklist reports this.

Verified runtime versions are listed in the
[compatibility guide](docs/compatibility.md#verified-versions).

## Documentation

- [macOS app](docs/app.md): setup, diagnostics, background services, packaging.
- [Collaboration](docs/collaboration.md): MCP tools, permissions, limits.
- [Synchronization](docs/synchronization.md): daily use, retention, recovery.
- [Claude Mod](docs/claude-mod.md): the `/claudex` pane and native delivery.
- [Command line and compatibility](docs/compatibility.md): source builds,
  CLI-only setup and migration boundaries.
- [Runtime architecture](docs/rust-migration.md) and
  [contributor instructions](AGENTS.md).

## Development

```sh
cargo build --locked --release -p claudex-cli
cargo test --locked --workspace
npm ci --ignore-scripts && npm run test:hosts
```

Rust 1.88+ builds the engine; Node.js 22.15+ (22.x) or 23.8+ is needed only for
host tests and tooling. Automated tests use synthetic data and never start
model inference. Runtime state, transcripts and credentials stay outside the
repository.

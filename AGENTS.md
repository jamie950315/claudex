# Claudex

Local turn-boundary conversation bridge between Codex desktop/CLI and Claude Code CLI.
Use English for repository content. Keep private transcripts, state, logs, credentials,
and generated sessions outside the repository.

Claudex.app 2.0.3 packages Claude Mod 0.8.61. Keep application and Mod versions
distinct; their authoritative manifests are package.json and
plugins/claudex/.claude-plugin/plugin.json. Historical release notes describe
their own releases, not the current setup or permission defaults.
Before a release, compare current guide headings, staging examples, CLI help and
release notes against both manifests and the packaged payload. Do not update only
the manifest while leaving a previous-version heading as the current guide.
Every shipping MOD_STAGE_FILES change, including README or skill text, needs a
new Mod version and matching loaded-observer version. Equal-version installation
checks compare the entire payload; never weaken them or overwrite a live cache
to accommodate a documentation-only rebuild.

## Documentation

Keep README.md focused on current capabilities, requirements, setup and concrete
limits. Put graphical setup in docs/app.md, the work protocol in docs/collaboration.md, native synchronization
details in docs/synchronization.md, and command-line setup, verified versions,
existing CLI-only installations and migration boundaries in docs/compatibility.md.
README.md installation stays app-only: download, open, grant the checklist's
requests; no Terminal steps. Contributor contracts per area
are in docs/agents/ (see Topic guides below); they are not user documentation.
Do not use broad maturity labels
as substitutes for version requirements or explicit unsupported behavior.
Keep collaboration acceptance separate from the synchronization allowlist, and
distinguish synthetic checks from authorized native model or Desktop evidence.
This checkout's history is published directly to origin main with a normal
push. Keep secrets, credentials and private transcripts out of commits; test
fixtures use placeholder paths and IDs.

## Development

- Rust 1.88+ implements the runtime in the Cargo workspace. Read `docs/agents/rust.md`
  before changing its crates, integration entry points or packaging.
- Run `cargo test --locked --workspace` for runtime contracts. Node.js 22.15+
  (22.x) or 23.8+ is development-only; `npm ci --ignore-scripts` installs host
  test, static frontend verification and pinned native-schema tooling.
  `npm test` runs the Rust workspace and the remaining host/native/tooling tests.
- The frozen `codex/javascript-legacy` branch preserves the complete pre-cleanup
  checkout, including the former JavaScript engine and reference suite. The
  `v1.4.8` tag is the last JavaScript-only release. Main must not restore an
  alternate engine or depend on that branch for builds or tests. Host-required
  JavaScript belongs under `crates/*/host/` or `plugins/claudex`, never a second
  runtime source tree.
- Native integration checks use isolated temporary homes and synthetic transcripts.
- Machine-specific notes (hosts, local paths, archives) belong in the untracked `AGENTS.local.md`; read it when present and keep such details out of tracked files.
- Automated tests never start model inference. Real Desktop reply acceptance requires explicit user authorization; never overwrite live sessions or modify user databases as a test.

- Product repairs must apply through normal installation and runtime paths on
  other users' machines. Do not depend on one account, UID, project path, native
  conversation ID or manually repaired local state. Reproduce relevant failures
  in fresh isolated roots and cover environment-dependent paths, permissions and
  restart recovery. Establish fixture permissions explicitly when they matter,
  so the test process's umask cannot hide the failing native state. Keep local
  recovery evidence separate from clean-profile and other-machine acceptance.
- The synchronization coordinator has one owner per conversation and commits only complete turns.

- Fail explicitly on conflicts, partial history, or unsupported lifecycle states.
- Native format tolerance, by user decision: the native apps change with every
  release, and a conversation must not pause only because a reader does not
  recognize something. A reader of native data names the conditions that are
  a real problem and accepts the rest; it never lists the forms it knows and
  refuses the others. Real problems are: content that cannot be carried over
  (an external asset, an opaque summary, a lossy conversion), a contradiction
  with what the native API reports or with a saved checkpoint, an identity or
  ownership that does not match, evidence of activity where none is claimed,
  an unstable or unsafe file, and any uncertain write. Not problems: an
  unknown record or event type, an extra or missing optional field, a new
  label, kind, trigger or state, a different order of context. Unknown content
  is kept whole as inert labeled data rather than dropped or refused. Compare
  the fields a proof uses and ignore the others. This governs reading only:
  writes, retirement, archival, ownership and the frontend
  patches (which change vendor code) keep their exact proofs. When a reader
  is loosened, run it over real local histories in both directions and record
  the counts; a refusal found in real use is first checked against this rule.
  Checkpoints keep their exact bytes for writes, archival, retirement and
  identity proofs, but reads that decide whether a conversation continues
  compare the saved dialogue, and late native items match their API item by
  identity (docs/agents/sync-events.md, Checkpoints).
- Read transcript snapshots through a no-follow file descriptor and compare its
  nanosecond file identity with the named file before and after reading. Size and
  modification time alone do not prove stability after a replacement or rewrite.
  Relocation evidence uses the same exact identity, including mode; millisecond
  timestamps are presentation values only.
- Before truncating a reusable staging file, verify its opened inode is an owned
  regular file with exactly one link and still matches the named file. No-follow
  alone does not protect originals against hardlink staging aliases. Controlled
  fixture appends compare exact serialized nanosecond identities, never converted
  floating-point millisecond timestamps.
- Preserve original contents and never prune originals as generated backups. Authorized same-title handoffs may archive an unchanged superseded original only after verifying its replacement and the applicable native lifecycle guards; archival never grants an external transcript writer lease.

## Topic guides

The detailed contracts live in `docs/agents/`. They are as binding as this file;
many record explicit user decisions. Before changing, diagnosing or reviewing an
area, read its guide in full, and read every guide a change touches. Do not load
guides for areas the task does not touch. When a rule changes, edit its guide;
keep this file to project-wide rules and this index, and add a row for a new guide.

| Guide | Read before working on |
| --- | --- |
| [rust.md](docs/agents/rust.md) | Rust workspace, migration parity, native command integration and Rust packaging |
| [app.md](docs/agents/app.md) | `native/ClaudexApp`, `bin/claudex-app.mjs`, app-owned Mod installation, window/menu/Quit, localization, signature checks, the CLI-only status display |
| [sync-events.md](docs/agents/sync-events.md) | `claudex-sync` hooks, event source, watchers and scheduling, Codex/Claude adapter rules, late command completions and native command envelopes |
| [lifecycle.md](docs/agents/lifecycle.md) | Rust CLI commands, discovery and enrollment, untrack/resume, project moves, holds and pending recovery, dependency anchors, collection, `split-original`, `archive-original`, supervisor and locks |
| [cold-import.md](docs/agents/cold-import.md) | `claudex-sync` cold import, cold-verification proofs, sweep/foreground scheduling, collection cost, anchor header proofs |
| [claude-history.md](docs/agents/claude-history.md) | Decoding Claude transcripts: ancillary tails, compaction, forks and tool graphs, image originals and sidecars |
| [codex-history.md](docs/agents/codex-history.md) | Reading Codex histories: `history_base`, history limits, display screenshots, localImage recovery, goals, subagent exclusion |
| [codex-transport.md](docs/agents/codex-transport.md) | `claudex-cli` launcher and signed host, the shared backend, `desktop install`, `claudex-core` version policy, validated baselines |
| [desktop-owner.md](docs/agents/desktop-owner.md) | `ClaudeOwner`, DesktopBridge/DesktopRuntime, context packets and archive mode, reverse delivery, owner reset and idle eviction, no-query receipts |
| [claude-desktop-ui.md](docs/agents/claude-desktop-ui.md) | The Claude Desktop registry, Local sessions, `desktop folders`, `desktop handoffs`, folder map and Local archival |
| [claude-frontend.md](docs/agents/claude-frontend.md) | `claudex-app` frontend modules and renderer host resources, owner wake, chat-wake/commands/folder cache adapters, `claudex-cli` renderer maintenance and relaunch, static frontend verification tools |
| [cache-warming.md](docs/agents/cache-warming.md) | `claudex-app` warm managers and Codex adapters, `/claudex:warm`, warm limits and broker settings, the Codex warm hook |
| [collaboration.md](docs/agents/collaboration.md) | `claudex-work`, MCP work tools, chat mailbox and native wake, worker permissions, observability, notifications, uncertain work |
| [claude-mod.md](docs/agents/claude-mod.md) | `plugins/claudex`, `bin/claudex-mod.mjs`, Mod staging/validation, nativeWake/selfWake routes, own-inbox delivery |

Past authorized acceptance runs are recorded in
[evidence.md](docs/agents/evidence.md). It holds no rules; read it only when a
task asks what was verified, and add new acceptance records there.

Rules that hold everywhere, whatever the guide: never resend an uncertain native
write or invocation; never edit native transcripts, registries or databases;
recover a pending transaction, never drop or replay it outside its documented
cases; keep every exact proof on writes, archival, retirement and ownership.

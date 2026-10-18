# Runtime architecture and JavaScript archive

Claudex has one engine: the Rust Cargo workspace on `main`. JavaScript remains
only for native hosts, compatibility entry points and developer tooling. The
former JavaScript engine and behavioral reference suite are preserved on the
frozen `codex/javascript-legacy` branch, not imported or executed by `main`.

## Capability-preservation contract

- Preserve synchronization, collaboration, setup, installation, recovery,
  retention, cache warming, diagnostics and their existing entry points.
- Preserve native accounts, existing state formats, exact checkpoint and
  ownership proofs, permissions, original histories and uncertain-write handling.
- Keep the native Swift macOS UI and the JavaScript required by native hosts.
- Package the Rust executable through the normal app installation path;
  migrate existing owned launch definitions without interrupting native work.
- Exercise affected Rust contracts and complete synthetic end-to-end paths.
  Native model and installed Desktop acceptance remain separate evidence.
- Source cleanup does not authorize replacing the installed app or native work.

## Workspace ownership

| Crate | Responsibility |
| --- | --- |
| `claudex-core` | Safe storage, identities, locks, configuration and common protocol primitives |
| `claudex-sync` | History codecs, projections, coordinator, native owners, discovery, events and recovery |
| `claudex-work` | Collaboration broker, MCP, workers, mailbox, permissions and notification delivery |
| `claudex-app` | App setup, native packaging, Mod, renderer adapters, cache controls and UI integration |
| `claudex-cli` | Command entry points, Codex launcher, shared transport and service integration |

All crates use the workspace edition and dependency versions. Boundary payloads
retain unknown native fields as inert JSON data; safety-critical internal
transitions use explicit Rust types. A native record reader names actual unsafe
conditions rather than allowlisting recognized record kinds.

The command crates expose `pub async fn run(args: &[String]) -> anyhow::Result<()>`.
Arguments are the original subcommand arguments without the executable name.
Domain modules expose typed APIs as well as command entry points. Shared storage
and authenticated JSON serialization live in `claudex-core`; they preserve durable
file identities and the existing checkpoint bytes, including legacy formats.

## Host code is separate from the engine

| Location | Purpose |
| --- | --- |
| `crates/claudex-app/host/renderer/` | Six renderer programs embedded by Rust and injected into the native Claude frontend |
| `crates/claudex-cli/host/codex-host.mjs` | Thin signed-Node process-chain adapter for Codex Desktop |
| `plugins/claudex/` | Native Claude Mod UI, hooks, commands and skills |
| `native/` | Swift macOS app and status-display presentation |
| `bin/*.mjs` | Explicit Node compatibility entry points that forward to Rust |
| `dev/` and `test/` | Host and maintenance-tool checks; engine contracts live with the Rust crates |

Codex Desktop's app-tools authorizer checks native process ancestry. Its
OpenAI-signed bundled Node remains the direct host that starts the native Codex
backend. Rust runs as a sibling sidecar over inherited control pipes, not between
the backend and its signed parent. Policy, ownership journals, socket validation
and framing belong in Rust. Never substitute an unsigned Node runtime or insert
a development-signed Rust parent into that protected ancestry.

The renderer programs and native Mod use their host applications' JavaScript
APIs. They are retained host assets, not a legacy engine or fallback. App packaging
includes the Rust executable and allowlisted host assets, not a Node distribution
or engine npm dependencies. The packaged executable is
`Contents/Resources/engine/bin/claudex`; Swift invokes its `app` subcommand.

## Build and check the current source

```sh
cargo build --locked --release -p claudex-cli
bin/claudex --help
cargo test --locked --workspace

# JavaScript hosts and maintenance tooling only:
npm ci --ignore-scripts
npm run test:hosts
```

`npm run build` aliases the Cargo build. The npm `claudex` executable is the same
no-Node `bin/claudex` launcher. It resolves checkout symlinks and executes
`target/release/claudex`, or the absolute executable selected by
`CLAUDEX_RUST_ENGINE`. A missing engine fails with the build instruction; startup
never compiles, downloads or invokes a different engine.

Explicit `node bin/*.mjs` commands forward standard streams, exit status and
signals to the corresponding Rust subcommand. `bin/claudex-codex.mjs` loads the
signed-Node sibling host instead of directly spawning Rust as the backend's
parent. The app builder forwards to `claudex app build`; use `--executable` for a
built engine, not the removed `--node-distribution` option.

`npm test` runs `cargo test --locked --workspace` followed by `npm run test:hosts`.
`npm run test:entrypoints` selects the compatibility-entry tests alone. Node
packages are development dependencies: `acorn` supports vendor-frontend AST
checks, and `@anthropic-ai/claude-agent-sdk` supports the maintenance schema tool.
Neither supplies the product engine. Host tests may use Rust test helpers in
isolated roots; automated checks never start model inference.

## Read the archived JavaScript implementation

The frozen [`codex/javascript-legacy` branch](https://github.com/jamie950315/claudex/tree/codex/javascript-legacy)
keeps the complete pre-cleanup source, including `src/`, `test/reference/`,
`dev/test-reference.mjs`, the old engine tests and manual cache-warming probes.
It includes the Rust migration state as well as the final JavaScript references.
The earlier [`v1.4.8` tag](https://github.com/jamie950315/claudex/tree/v1.4.8)
preserves the release before the Rust engine migration.

Use the archive for source history and old experiments; it is not a second
maintained runtime. For example, inspect an old module without changing the
current checkout:

```sh
git fetch origin codex/javascript-legacy
git show origin/codex/javascript-legacy:src/cold-import.mjs
```

The old reference command and its dependency lockfile belong to that branch.
Do not restore them as a fallback on `main`, run the archive against live state,
or downgrade an installed engine over newer journals or uncertain outcomes.
Historical release notes and acceptance records retain the commands and versions
that were actually tested; they are not current build instructions.

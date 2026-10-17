# Rust migration

Claudex's runtime implementation is written in Rust. The preserved
JavaScript implementation remains the behavioral reference;
it must not become a fallback called by the Rust runtime.

## Completion contract

- Preserve all synchronization, collaboration, setup, installation, recovery,
  retention, cache-warming and diagnostics capabilities and their entry points.
- Preserve native accounts, existing state formats, exact checkpoint and
  ownership proofs, permissions, original histories and uncertain-write handling.
- Keep the native Swift macOS UI. JavaScript may remain only where the host
  requires it (Claude Mod and injected vendor frontend code), not as the engine.
- Package the Rust executables through the normal app installation path;
  migrate existing owned launch definitions without interrupting native work.
- Exercise the affected Rust contracts and complete synthetic end-to-end paths.
  Keep native model/installed Desktop acceptance distinct from synthetic evidence.
- Do not publish or replace the installed app as part of developing this branch.

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
transitions use explicit Rust types. A native record reader must not introduce
an allowlist of recognized record kinds.

## Integration interfaces

The command crates expose `pub async fn run(args: &[String]) -> anyhow::Result<()>`.
Arguments are the original subcommand arguments without the executable name.
They must report unsupported commands explicitly, never dispatch the legacy
JavaScript runtime. Domain modules expose testable typed APIs in addition to
their command entry point.

Shared synchronous storage functions live in `claudex_core::storage`:
`read_json`, `read_json_or`, `write_json`, `write_diagnostic_json`, `atomic_write`,
`publish_exclusive`, `private_directory`, `snapshot`, `hash_bytes`, `hash_json`,
and `FileLock::acquire`. `FileIdentity` stores nanosecond identity fields as
decimal strings, matching the existing durable representation. Hashing exists
to preserve the existing authenticated checkpoint and ownership contracts.

Migration progress is not release acceptance. Remaining implementation and
integration gaps must remain explicit until the completion contract is met.

## Signed Desktop transport host

Codex Desktop's app-tools authorizer checks native process ancestry. Its
OpenAI-signed bundled Node must remain the direct host that starts the native
Codex backend; a development-signed Rust process cannot replace that identity.
The host-required JavaScript bootstrap must therefore remain a thin process
adapter. Rust runs as a sibling sidecar over inherited control pipes, rather
than being inserted between the backend and its signed parent. Policy,
ownership journals, socket validation and framing belong in Rust. This
integration requirement does not justify retaining the JavaScript engine or
substituting an unsigned Node runtime.

## Developer entry points

Build the native executable with
`cargo build --locked --release -p claudex-cli` (or `npm run build`), then run
`bin/claudex`. The npm `claudex` executable points to that same no-Node launcher.
It resolves checkout symlinks and executes `target/release/claudex`, or the
absolute executable selected by `CLAUDEX_RUST_ENGINE`. A missing engine fails
with the build command; startup never compiles, downloads, or dispatches the
JavaScript engine.

Explicit `node bin/*.mjs` commands remain thin compatibility hosts that route to
the corresponding Rust subcommand and forward standard streams, exit status,
and signals. `bin/claudex-codex.mjs` is the exception to direct spawning: it loads
the signed-Node sibling transport host described above, keeping the native
backend's required ancestry. The app builder forwards to `claudex app build`;
use `--executable` for a built native engine instead of the former
`--node-distribution` option.

`npm test` runs `cargo test --locked --workspace` and the thin entry-point tests.
The former JavaScript entry points live only in `test/reference/bin/`.
`npm run test:reference` overlays them into its own temporary source fixture and
runs the existing behavioral tests there; individual test paths may be supplied
after `--`. Node dependencies remain development/reference tooling, not Rust
runtime dependencies. Reference success and Rust parity are separate evidence.

# Rust migration

This branch migrates Claudex's runtime implementation to Rust. The existing
JavaScript implementation remains the behavioral reference during migration;
it must not become a fallback called by the completed Rust runtime.

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

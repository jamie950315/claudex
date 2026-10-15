# Rust runtime migration

The `codex/rust-refactor` branch is migrating the complete runtime, not adding
a Rust wrapper around the JavaScript engine. `docs/rust-migration.md` defines
the full completion contract and crate ownership. The migration is incomplete
until the original product capabilities work through the Rust entry points.

Use `cargo test -p <affected-crate>` during implementation. Run integrated
workspace checks when shared interfaces or complete workflows change. Do not
format another active owner's crate or stage its unfinished files implicitly.
Keep Cargo.lock tracked and build output under ignored `target/`.

Existing JavaScript code and tests remain behavioral references until equivalent
Rust contracts and complete flows are proven. Do not delete an existing
capability, replace a native lifecycle proof with a stub, invoke the legacy
engine as a fallback, or claim a narrow test proves full parity. Preserve
durable state formats and JavaScript checkpoint serialization bytes. Use
`claudex_core::json` for existing authenticated JSON serialization and
`claudex_core::storage` for exact file identities and safe publication.

Keep Swift for native presentation. Host-required JavaScript may remain for
Claude Mod, injected vendor frontend code, and the original signed Codex
Desktop Node process-chain host. The host must not contain the migrated engine.
Never insert a development-signed Rust process into ancestry that the native
app-tools authorizer requires to be OpenAI-signed. Keep signature and activation
acceptance separate from isolated transport tests.

The native app resource path for the Rust executable is
`Contents/Resources/engine/bin/claudex`; Swift invokes it with the `app`
subcommand. Packaging must supply the actual complete executable and required
host assets, not produce an apparently usable bundle with missing commands.
Do not replace the installed app, restart native work, run model inference or
publish this branch as part of source migration.

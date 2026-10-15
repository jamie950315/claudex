# Rust runtime migration

The `codex/rust-refactor` branch implements the complete runtime in Rust, not
a wrapper around the JavaScript engine. `docs/rust-migration.md` defines the
capability-preservation contract and crate ownership. Keep the original product
capabilities working through the Rust entry points; synthetic parity, candidate
packaging and installed native acceptance remain distinct evidence.

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

The root CLI composes the domain crates directly. `app` uses the concrete native
setup runtime; `warm-hook` and `mod-bridge` use the ordinary authenticated broker
transport with their own Codex and Claude controller identities. The companion
RPC contract takes the exact collaboration root, not the synchronization root.
Never append a second `collaboration` component in the transport adapter.

CacheRuntime belongs to the serving broker. Construct it only from
Integration::start after the broker's exclusive lock and stale-endpoint proof;
help, status, installation and a competing serve process must not open its
ledgers or scheduler. Preserve the actual collaboration `--root`, including a
non-default basename. Timer fences reread the five shared cache settings from
that broker's bounded private work.json. Drain the integration on both normal
shutdown and a later startup failure.

The source and npm command entry is `bin/claudex`, a shell launcher that directly
executes the already-built native engine. Build explicitly with
`cargo build --locked --release -p claudex-cli`; a missing engine must fail with
that instruction, not invoke Cargo or a legacy runtime automatically. Preserve
symlink resolution and the absolute-only `CLAUDEX_RUST_ENGINE` override.
Explicit Node entry points are transport-only compatibility hosts, including
stdio/exit/signal forwarding. Codex's signed Node sibling host retains its
separate ancestry contract. Never import `src/` or `test/reference/` from them.

Use `npm run test:entrypoints` for those hosts. `npm test` runs the Rust workspace
and entry-point checks. Run the preserved JavaScript behavioral suite explicitly
with `npm run test:reference [-- test/<name>.test.mjs]`; its temporary overlay is
test-only and never a fallback or native acceptance claim.

The Desktop watch command injects renderer maintenance through WatchLifecycle.
Subscribe to the shared Source before its first hold check; cache notifications
never enter the history inbox. Watch existing native cache ancestors so directory
creation and inode replacement rearm the same OS watcher. Stop the hint consumer,
fence the restart controller and drain maintenance before releasing watch.lock.
Keep rendererAdapters, folder-map proof and claudeDesktopRestart independent in
watcher status; the existing Swift reader ends a restart request after a newer
native Desktop start. An interrupted normal quit retains its write-ahead outcome
and is never replayed. Tests inject native process data and never quit live apps.
The same WatchLifecycle owns the Codex launcher override and relaunch monitor:
neither starts before watch.lock admission, and shutdown fences native actions
before draining both restart controllers. A hold arriving during a normal quit
must leave its write-ahead outcome intact and must not reopen the app.

Source app and standalone status-display commands locate assets from the
executable's checkout, not the caller's working directory or target directory.
An out-of-tree build supplies --source-root explicitly. Packaged app commands
use only Contents/Resources/engine and reject external source overrides.

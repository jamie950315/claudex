# Claude Desktop renderer resources

These JavaScript modules run inside Claude Desktop's existing renderer, not as
the Claudex engine. `src/frontend_runtime.rs` embeds their source into the Rust
executable and injects it only through the proved frontend adapter bindings.
They have no npm dependencies. Keep their sibling imports usable by the host
tests and keep every lifecycle, identity and native-write guard intact.

Synchronization, storage, discovery, adapter selection and installation belong
to the Rust crates. The archived JavaScript engine is on
`codex/javascript-legacy`; it is not a runtime dependency or fallback.

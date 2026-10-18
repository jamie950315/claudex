A Claude frontend entry failed the published-graph adapter check. Draft a
repair in this checkout. A maintainer reviews it and verifies it in a real
Claude Desktop before anything is released; you only prepare the branch.

Entry: {{ENTRY}}
Report: {{REPORT}}
State directory (vendor module store and saved reports): {{STATE}}

Do this, in order:

1. Read AGENTS.md and all of docs/agents/claude-frontend.md. They are binding.
2. Build the developer checker explicitly with
   `cargo build --locked -p claudex-app --example frontend-check`. Read the report. For each failed adapter, reproduce the failure with
   `node dev/check-claude-frontend-entry.mjs --entry {{ENTRY}} --store {{STATE}}/store`
   and find the cause in the vendor modules under {{STATE}}/store. State the
   cause from evidence; do not guess.
3. Change the recognition in the Rust frontend modules under
   crates/claudex-app/src/frontend_*.rs so the adapter finds
   the real target in this build. Name the condition that is a real problem
   and accept the rest. Never weaken a proof to make a check pass, never pick
   a target by minified name, argument position or file name, and never
   change the injected runtime, the installer, journals or any write path.
4. Add or extend a synthetic Rust frontend test that fails without your change.
   Never copy vendor source into the repository; use the fixture builders.
5. Verify, and fix what fails:
   - `cargo test --locked -p claudex-app frontend_`
   - `cargo build --locked -p claudex-app --example frontend-check`
   - `node --test test/claude-frontend-{published-check,watch}.test.mjs`
   - `node dev/check-claude-frontend-entry.mjs --entry {{ENTRY}} --store {{STATE}}/store` exits 0
   - `node dev/frontend-watch/watch.mjs regress --state {{STATE}}` exits 0:
     every entry that passed before still passes with the same vendor files.
6. Update docs/agents/claude-frontend.md with the new observed form and date.
7. Commit on the current branch with a message that says what changed in
   the frontend and what the recognition now requires. Do not push, do not
   change versions, do not write release notes.

If no correct repair exists without weakening a proof, change nothing and
say so. End with a short report: the cause, what you changed, each
verification command with its result, and anything a maintainer must check
in a real Claude Desktop.

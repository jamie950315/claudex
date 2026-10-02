# Claude Mod acceptance and deployment gates

This checklist is for the next local Claude Code/Codex agent. Start with
`claude-mod-handoff.md`. Mark a gate as passed only with observed evidence on the
specified runtime. A written test is not an executed test; a stubbed UI tree is
not a painted Desktop pane.

## A. Source and synthetic tests (no inference)

1. Confirm the reviewed base, clean worktree and patch hashes. Review all added
   files and the existing `AGENTS.md`. Preserve package/lockfile/runtime policy.
2. Install the original locked dependencies with `npm ci --ignore-scripts`.
3. Run `node --test --test-concurrency=4 test/claude-mod-*.test.mjs` in the complete
   checkout: expect 66 tests with zero failures and **zero skips**. The real
   private transport test must execute. Its dispatcher is still a synthetic
   server; it intentionally starts no model runner.
4. Run the entire existing `npm test`. Compare failures with an untouched base
   checkout under the same Node/OS, without modifying live native stores.
5. Recheck the controller key, state and receipt fixtures reject symlinks,
   hardlinks, FIFO, changed file identities, wide permissions and oversized data.
6. Verify tests cover duplicate click, concurrent commit, reload deduplication,
   commit ambiguity, context/cwd switches, expired preview, Stop/resuming hold,
   managed worker exclusion and missing broker behavior.
7. Verify the stage is create-only and contains only its allowlisted files. Move
   an isolated source copy away and verify the staged helper's no-inference
   doctor still works. Check the production Node executable's canonical path and
   group/world write bits; select a trusted runtime rather than weakening checks.

## B. Official native validator and test kit (no inference)

Record the exact `claude --version` used; it must support Mods. The public baseline
is 2.1.287; actual 2.1.286 Desktop runtime validation/registration also passed
without added flags. Verify capabilities rather than inferring a hard refusal
from the version number alone. Stage against an
isolated private root with nativeWake=false. The source plugin intentionally has
empty configuration defaults and is not the installable machine configuration.

Run the intended build's supported forms of:

```sh
claude plugin validate "$STAGE/plugins/claudex" --strict --json
claude plugin test "$STAGE/plugins/claudex"
```

Read the emitted types and validation errors. The candidate includes nine native
kit tests, executed on Claude Code 2.1.287. They stub process execution, native state and other external calls;
no sign-in, model request or real network is required. Resolve any native kit or
UI/event schema mismatch before installation. Keep this evidence separate from
the Node contract tests and real terminal/Desktop painting.

The source-level expected inventory is:

```text
Hooks:
  session.start, classic.SessionStart, session.end, turn.complete,
  command.run (claudex), ui.render (AbovePrompt and Pane)
Calls:
  env.get (literal CLAUDEX_COLLABORATION_WORKER)
  session.id, session.cwd, session.usage, session.version, session.send
  process.run (plugin.root is an intrinsic property, not a call)
  command.register
  ui.invalidate, ui.resolve, ui.open
  prompt.fill (append-only handoff draft)
```

The validator may include intrinsic UI element methods or normalized names; audit
what the actual build prints rather than string-matching this list blindly.
`session.send` is statically declared even with nativeWake=false. Installation
therefore grants trusted Mod code this capability; the flag gates this
implementation's use of it. There should be no prompt.submit, permission approval,
model.complete, direct fs.write or recurring timer call in the Mod.

Inspect the fixed `process.run` target: the packaged Node helper. Its deeper
private file/RPC effects must be reviewed in source; the Mod validator's call list
is not a transitive security audit of child processes.

## C. Read-only terminal and Desktop UI

Use isolated test sessions. Record terminal runtime and actual Desktop Code
runtime separately. Loading in the CLI does not establish Desktop availability.

- Open `/claudex` with nativeWake=false. Confirm overview, task pages, exact task
  detail, chat title search/pagination, compose and inbox all render. Check a
  narrow terminal and resized Desktop pane; tabs/controls remain reachable.
- Confirm AbovePrompt preserves the next mod/native subtree. Long titles and
  JSON text stay within native element bounds. Native missing usage values show
  unknown instead of fabricated zero, and rate-limit labels retain their native
  kind. Empty, errored and unavailable states remain distinguishable.
- Invoke read-only refresh while native work runs. It starts no model, edits no
  conversation and touches no user draft. Request/response limits remain bounded.
- Show duplicate titles with distinct native IDs, errors and archived metadata.
  Exact ID and expected title must survive into the complete action preview.
- Append a handoff draft with existing typed text. Verify append semantics, no
  automatic submission, no displaced draft, and a truthful refusal when the
  composer cannot accept input.
- Open a second native session; clear/resume/fork where supported. Hold a
  synthetic asynchronous refresh, then change session or cwd. Stale results and
  pending confirms must not appear in or execute against the new context.
- A managed worker marked `CLAUDEX_COLLABORATION_WORKER=1` must not read the
  controller capability or draw actionable controller UI. Its existing MCP
  worker capability remains its sole work authority.
- Test an isolated stopped/resuming root: new operations refuse, receipt
  inspection remains available and no recovery/service action runs automatically.

Retain screenshots only in a private acceptance folder. UI tree tests cover
structure and callbacks; these observations establish actual painting/layout.

## D. User-confirmed collaboration (authorized inference only)

Use a dedicated test workspace and explicitly authorized account allowance. Start
with read-only tasks. Keep any existing sync watcher and user work unchanged.

1. Prepare a Codex read-only task; verify the preview has exact context, cwd,
   permission, destination model/effort and all directory grants. Preparing and
   discarding cause no model dispatch. Change broker defaults afterward; the
   existing preview must retain the captured model/effort.
2. Confirm once. Verify one broker request with the saved requestId and one
   native invocation. Double-click and reload the pane; the same request is not
   dispatched again. Completed receipt means the broker RPC answered, while task
   completion remains a separately inspected task status/result.
3. Test the Claude destination under the same constraints. Use follow-up and
   explicit cancellation. Verify cancellation accepted/pending/terminal are
   reported separately; removing the Mod does not cancel accepted work.
4. Inject a **synthetic** transport failure around commit. Preserve dispatching or
   uncertain evidence. Restart/reload the controller and repeat the same intent;
   it must be refused or return its existing receipt, with no second native work.
   Never interrupt real user work simply to manufacture this fault.
5. Test model/default updates through an explicit full-pair preview. Exact model
   IDs are preserved. Native rejection stays visible; no substituted model is
   selected. Full-access is rejected by this new pane's allowlist.
6. For authorized workspace-write acceptance, use disjoint files in a dedicated
   checkout and inspect exact final bytes. Keep existing broker permission and
   scope ceilings; record the requested grants and native outcomes.
7. Test the included workflow skill with existing MCP. Managed-task handoff must
   come from its current generation-scoped owner using the latest revision;
   controller drafts do not transfer an unrelated native chat's ownership.

## E. Optional exact-recipient session.send adapter

This gate remains separate and optional. Keep nativeWake=false in ordinary
installation until all required recipient cases below have actual evidence.
Enabling native receipt can trigger recipient model work and uses account quota.

Create a separate controller session and recipient test session whose real
SessionStart hook registered its identity. Verify the broker's exact mapping and
use its normal user-authorized chat_send request to queue one wake-enabled note.
Do not fabricate native registry rows, manifest entries, Stop ACKs or transcripts.

| Case | Required evidence |
| --- | --- |
| Exact different recipient | Controller and recipient IDs/cwds are distinct and explicit; one claim matches broker metadata; session.send targets the exact recipient. |
| Accepted queue | `isDelivered: true`, then the exact recipient's real Stop hook records the standalone ACK; separately inspect the requested reply/outcome. |
| Busy recipient | Native peer queue controls delivery; sender draft is unchanged and native work is not interrupted. |
| Recipient inbound policy refuses/holds | Native policy remains effective. Refusal/exception does not turn an offered message back into queued or cause an automatic retry. Approval-held input is not treated as completed work. |
| Offline/unreachable/self target | Observe the actual build's result. Preserve unknown/offered receipt states; do not claim generic support for all these cases. |
| Legacy renderer claims first | Mod sees claimed=false and does not send. |
| Mod claims first | Original renderer/settings hook cannot consume the same queued item again. |
| Context change after claim | Preserve original controller/target receipt identities. No delivery is redirected to the newly selected tab/session. |
| Accepted send, receipt write lost | Preserve the claim and unknown outcome. Inspect real native receipt before any operator-led reconciliation. |
| Helper/process interrupted after claim | No claim replay or synthetic ACK; state remains for investigation. |
| Application Stop during receipt | No new claim is allowed. An already initiated receipt can be recorded without starting new work. |
| Expired/wrong cwd/wrong ID manifest | Refused before native delivery; no guessed target or title substitution. |

A true session.send result proves native queue acceptance only. Existing Stop
ACK instrumentation must actually fire for peer-message turns on the tested
build. If it does not, leave nativeWake disabled and design/test a separate
origin-verified acknowledgment integration before enabling this path.

The current adapter is explicit refresh and confirm, not an unattended inbox.
It preserves a refusal as uncertain even when native refusal looks conclusive;
this conservative first-version policy keeps the existing offered item from
being delivered by a different consumer without operator reconciliation.

## F. Synchronization compatibility and production deployment

The public Mods baseline 2.1.287 and sync baseline 2.1.281/SDK 0.3.281 are separate
facts. Complete the repository's native history, asset, turn-completion, owner,
compaction, relocation, cancellation and recovery acceptance for an actual new
sync runtime before updating its strict compatibility evidence. Preserve the
Codex side's independent pinned requirements.

Never change `versionPolicy`, native trust receipts, ownership checks or original
history bytes to produce a green checklist. A read-only Mod pane working on a
new terminal runtime is not evidence that a Claudex-owned sync process can be
upgraded. Keep production binaries and SDK dependencies unchanged until this
gate is resolved.

Install via the local marketplace only after the default-off candidate passes
its relevant gates. Inspect installed configuration and stage hashes. Keep the
existing settings hooks, MCP, folder/archive/activation adapters and services.
Retire any old adapter only with a documented replacement scope and separate
migration/rollback proof. The app engine packaging allowlist and resource-copy tests are included in bundle revision 2.
A development-signed macOS app build is verified; installation and real native
painting remain separate. Native localization and graphical opt-in setup require
additional source changes outside this companion's current scope.

## G. Rollback acceptance

Disable/uninstall the companion through the normal plugin lifecycle. Verify the
original collaboration/sync configuration and native history remain intact.
Ensure the new band/pane disappears after normal reload, while original MCP and
settings hooks still work. Preserve action receipts/locks and broker work already
accepted. Test cancellation separately with explicit authorization; do not
infer cancellation from the absence of the pane.

## Evidence record template

Keep private evidence outside the checkout. Add only a redacted summary to source
control if a later release needs one.

```text
Date / operator:
Reviewed base and final commit/diff SHA256:
OS / architecture / Node executable identity and version:
CLI Claude version / Desktop Code version / SDK version / Codex version:
Mod stage hashes / installed configuration / nativeWake:
New Node tests (pass/fail/skip):
Original npm test (pass/fail/skip):
Native validator (exit code, warnings, declared capabilities):
Native kit (pass/fail):
Terminal painting and behavior:
Desktop painting and behavior:
Authorized model executions and task results:
Native claim / queue / recipient ACK / requested result:
Actual-runtime sync acceptance evidence and configured version policy:
Rollback evidence:
Remaining blocked gates and exact reasons:
```

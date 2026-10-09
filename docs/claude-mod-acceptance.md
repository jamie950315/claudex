# Claude Mod acceptance and deployment gates

This is the reusable checklist for the current Claudex.app 1.2.30 / Mod 0.8.15
workflow. Start with [the current handoff](claude-mod-handoff.md) and
[app lifecycle](app.md#claude-mod-lifecycle). Mark a gate as passed only with
observed evidence on the
specified runtime. A written test is not an executed test; a stubbed UI tree is
not a painted Desktop pane.

## Current app-managed lifecycle gate

1. Verify app-owned initial installation, update and repeated-startup idempotence
   through the official manager. Read-only inspections must perform no install,
   configuration write or model work.
2. Preserve verified legacy sources, other plugins, previous caches, both native
   configuration identities and explicit disabled/wake preferences. Same-name
   marketplace add may migrate a verified source; never remove the marketplace.
3. Exercise an empty-profile manager bootstrap using its pinned package integrity,
   disabled package scripts and distinct private npm configuration files. A
   manager help/version response alone does not prove the installation path works.
4. Verify bundled/installed payload hashes separately from a fresh loaded-version
   observation and actual Desktop pane. Existing native sessions may retain old
   roots; use a normal new session without restarting active user work.
5. Verify explicit receiver controls require confirmation, preserve per-task
   opt-in and do not change routes or native inbound policy. A newer installed
   version is never downgraded; refused explicit changes must not report success.

See [validation](claude-mod-validation.md) for completed, version-scoped evidence.
The procedures below remain applicable when their respective behavior changes;
old counts and observations are not a claim that every current gate was rerun.

## Historical 0.3.1 single-session main-route evidence

The historical review installed 0.3.1 with nativeWake=true, selfWake=true and broker
route=mod-self. Actual 2.1.286 strict validation and 12 native kit cases passed in a
fresh normal process, with no rollout override. All 16 installed plugin assets
match the final stage. After normal Claude restart, one Desktop session and one
eligible waiter delivered to that same session; Sonnet 5.5 replied with the nonce
and real Stop ACK in 4.253 seconds. Native UI/accessibility evidence shows the
peer message, reply, ACK and unchanged unsent draft. This is not a new screenshot
pixel claim. Isolated tools:[] native tests confirmed hold/refuse with zero model
turns and no global settings edits. Full regression passed 1,325 tests, with zero
failures and 23 existing opt-in skips before the final narrow queued-hook exclusion;
affected mailbox/Mod tests cover that backend delta. See [validation](claude-mod-validation.md)
for boundaries; these historical numbers do not describe the current installed
version or test inventory.

## Single-session main-route acceptance procedure

1. Run `test/mod-self-wake.test.mjs`, `test/claude-mod-self-inbox.test.mjs`,
   `test/mod-wake.test.mjs` and affected core/transport tests. Verify full
   regression for these shared persistence/concurrency changes.
2. Stage the candidate with nativeWake and selfWake enabled, validate it with the actual target native
   compiler, and run the official test kit. A static validator pass is not loading.
3. At a safe idle boundary, install the matching broker and plugin without
   replacing Claude Desktop or its translation. Verify loaded plugin version,
   both explicit opt-ins, and one live event-backed waiter in the recipient's
   own session. A second sender or SendMessage is not required for mod-self.
   Managed workers must remain excluded.
4. Explicitly select `collaboration native-wake --route mod-self`. In a dedicated,
   authorized Sonnet 5.5 session, queue a new wake-enabled message and verify
   automatic claim, socket submission, receive-once authorization, target reply
   and native Stop ACK without manually invoking Inbox dispatch. Confirm only
   that native session is required, and no legacy renderer consumes the claim.
5. Check a receiver that is busy and one that refuses inbound messages. Preserve
   native policy: accepted-but-held is not ACK; a definite refusal is never routed
   around that policy. An unloaded recipient waits for its normal resume, not an
   invisible fallback or extra model process. Keep the cross-session mod route's
   distinct SendMessage requirement intact.
6. Test helper/broker disconnection and restart with synthetic fault injection:
   known outcome receipts may be republished idempotently, but uncertain dispatches
   must remain offered and must never write the native inbox again. Verify context
   changes, app-stop holds, malformed private files and source-bound claim checks.
   Include concurrent helpers, duplicate receive envelopes, persisted receive-once
   records and actual private Unix RPC ingress; direct hub tests alone missed the
   omitted mod_wake_receive allowlist entry in the first integration.
7. Switch the route back to renderer for new messages and verify pending Mod
   records retain their original route and evidence. Never reset claims or rewrite
   native transcripts to make rollback appear successful.

Only promote automatic nativeWake after the applicable native gates pass. Preserve
the prior working installation until then; retain original route/claim evidence
and a modern mailbox reader when rolling back.

## A. Source and synthetic tests (no inference)

1. Confirm the reviewed base, clean worktree and patch hashes. Review all added
   files and the existing `AGENTS.md`. Preserve package/lockfile/runtime policy.
2. Install the original locked dependencies with `npm ci --ignore-scripts`.
3. Run affected `test/claude-mod-*.test.mjs`, `test/mod-wake.test.mjs` and
   `test/mod-self-wake.test.mjs` cases in the
   complete checkout with no failures or newly skipped cases. The real
   private transport test must execute. Its dispatcher is still a synthetic
   server; it intentionally starts no model runner.
4. For shared core/persistence/concurrency changes, run the complete `npm test` or
   reuse still-valid unchanged core evidence with focused tests for the changed
   surface. Compare unrelated failures without modifying live native stores.
5. Recheck the controller key, state and receipt fixtures reject symlinks,
   hardlinks, FIFO, changed file identities, wide permissions and oversized data.
6. Verify tests cover duplicate click, concurrent commit, reload deduplication,
   commit ambiguity, context/cwd switches, expired preview, Stop/resuming hold,
   managed worker exclusion and missing broker behavior.
7. Verify the stage is create-only and contains only its allowlisted files. Remove
   an isolated source copy and verify the staged helper can read the real private
   Unix RPC without inference; a doctor-only check does not establish transport
   completeness. Check the Node executable's canonical path and
   group/world write bits; select a trusted runtime rather than weakening checks.

## B. Official native validator and test kit (no inference)

Record the exact `claude --version` used; it must support Mods. The public baseline
is 2.1.287; actual 2.1.286 Desktop runtime validation/registration also passed
without added flags. Verify capabilities rather than inferring a hard refusal
from the version number alone. Stage against an
isolated private root. Keep nativeWake/selfWake false in the shipping stage; use
a separate never-installed test stage with both enabled for the kit's own-inbox
case. The source plugin intentionally has empty configuration defaults and is not
the installable machine configuration.

Use the separate `STAGE` and `TEST_STAGE` directories from
[the staging guide](claude-mod.md#standalone-staging-and-developer-validation),
then run the intended build's supported forms of:

```sh
claude plugin validate "$STAGE/plugins/claudex" --strict --json
claude plugin validate "$TEST_STAGE/plugins/claudex" --strict --json
claude plugin test "$TEST_STAGE/plugins/claudex"
```

Read the emitted types and validation errors. The current source includes 23 native
kit tests; record the executed count and candidate version rather than reusing
the historical 0.3.1 count of 12. The 0.7.1 kit passed on Desktop Code 2.1.286 with
an explicitly approved isolated test-process function-hooks option. Do not apply
that option to end-user setup or infer default availability on every runtime.
They stub process execution, native state and other external calls;
no sign-in, model request or real network is required. Resolve any native kit or
UI/event schema mismatch before installation. Keep this evidence separate from
the Node contract tests and real terminal/Desktop painting.

The source-level expected inventory is:

```text
Hooks:
  session.start, classic.SessionStart, session.end, session.receive,
  prompt.submit, turn.start, turn.step, turn.complete, tool.call, config.set,
  command.run (claudex and claudex:warm), ui.render (Pane)
Calls:
  env.get (worker marker, native TTL/force/effort), env.set (current-process TTL)
  session.id, session.cwd, session.usage, session.version, session.model, session.send
  settings.read (native inbound/TTL policy and bounded option diagnostics)
  store.get, store.set (independent language and explicit TTL preferences)
  tool.list, clock.now, clock.after (bounded wait/reconnection/warm scheduling)
  process.run (plugin.root is an intrinsic property, not a call)
  command.register
  ui.invalidate, ui.resolve, ui.open
  prompt.fill (append-only handoff draft), prompt.read (warm draft guard)
  prompt.submit (explicitly opted-in, one-use cache-warming dispatch only)
```

The validator may include intrinsic UI element methods or normalized names; audit
what the actual build prints rather than string-matching this list blindly.
`session.send` is statically declared even with nativeWake=false. Installation
therefore grants trusted Mod code this capability; the flag gates this
implementation's use of it. `prompt.submit` is limited to the separately authorized
cache-warming path; it is never a fallback for peer delivery or a generic pane
action. There should be no permission approval, model.complete or direct fs.write
call in the Mod. tool.list and clock.after are expected for SendMessage preflight,
bounded event-backed wait/reconnection and authorized warming, not history polling.

Inspect the fixed `process.run` target: the packaged Node helper. Its deeper
private file/RPC effects must be reviewed in source; the Mod validator's call list
is not a transitive security audit of child processes.

## C. Read-only terminal and Desktop UI

Use isolated test sessions. Record terminal runtime and actual Desktop Code
runtime separately. Loading in the CLI does not establish Desktop availability.

- Open `/claudex` with nativeWake=false. Confirm overview, task pages, exact task
  detail, chat title search/pagination, compose and inbox all render. Check a
  narrow terminal and resized Desktop pane; tabs/controls remain reachable.
- Confirm native and peer-Mod prompt-area content remains unchanged, with no
  Claudex AbovePrompt band. Long titles and JSON text stay within native element
  bounds. Native missing usage values show
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
   selected. Full-access is rejected by the pane's allowlist.
6. For authorized workspace-write acceptance, use disjoint files in a dedicated
   checkout and inspect exact final bytes. Keep existing broker permission and
   scope ceilings; record the requested grants and native outcomes.
7. Test the included workflow skill with existing MCP. Managed-task handoff must
   come from its current generation-scoped owner using the latest revision;
   controller drafts do not transfer an unrelated native chat's ownership.
8. For changed cooperative-follow-up behavior, send a direction while a worker
   is still running, without waiting for a blocker. Verify exact-generation
   check-in or eligible worker MCP-return delivery, explicit instruction adoption
   and the requested result separately. Preserve the original tool response,
   end-turn precedence and child-outcome acknowledgement state. A long native
   tool has no instantaneous-delivery guarantee, and no second writer or forced
   interruption may be introduced to make this test pass.

## E. Exact-recipient native delivery

### Own-inbox mod-self route

Source defaults are nativeWake=false and selfWake=false. Enabling both and
selecting mod-self authorizes only already wake-enabled messages for the exact
current native session. The same Mod receives its message; do not install a
second Mod or create another model process to satisfy this gate.

| Case | Required evidence |
| --- | --- |
| One loaded recipient | Exactly matching source/target context, one eligible waiter, native reply and real Stop ACK; no second sender required |
| No SendMessage | Own-inbox transport works independently of that outbound tool; normal native receiver permissions remain unchanged |
| Parent and socket | Exact native parent PID/birth/UID owns the private socket; symlinks, wrong owner and changed identities refuse; Darwin listener and accepted FDs at the same path are valid |
| Native token/provenance | Inherited token remains in memory only; native receive is peer-originated, never human; actual wire behavior is validated for the runtime |
| Submitted is not ACK | Socket flush records submitted only; native receive authorization and real recipient Stop ACK are inspected separately |
| Hold/refuse | Native controls remain effective, including changes after preflight; no setting change, approval or alternate transport defeats them |
| Ordinary hook exclusion | SessionStart/UserPromptSubmit/Stop cannot offer queued mod-self messages; real Stop ACK scanning remains available and older/queue-only routes retain their behavior |
| Receive-once | Duplicate envelopes and a lost receive reply cannot obtain a second durable authorization, before or after ACK and restart |
| Dispatch-once | Concurrent helper calls or a crash after intent persistence cannot cause a second socket write |
| Lifecycle and authorization | Clear/end, changed exact context, app-stop, route revocation and expiry fence late work, including after awaited receive persistence |
| Unsent draft | Observe the original native composer contents unchanged after actual receipt; a source/API claim is insufficient |
| Closed/unloaded recipient | Visible wait for normal native resume, never a newly created model session |
| Legacy data | Earlier submitted/no-ACK messages and old mod/renderer routes remain unchanged; a successful retry scenario uses a distinct authorized message |

The own-inbox path is macOS-only. The documented own-child ingress does not turn
the observed wire payload or absent receipt into a stable API promise. Neither
self-addressed session.send nor prompt.submit is a fallback. Keep native queue
semantics, user permissions and all original histories intact.

### Retained cross-session mod route

For an unvalidated installation, keep nativeWake=false until its required
recipient cases have actual evidence. The reviewed local installation has passed
the documented cases; its current primary route is mod-self, while this earlier
cross-session route remains separately available.
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
| Legacy renderer route | Renderer cannot claim Mod-routed messages; Mod cannot claim legacy renderer-routed messages. |
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

The automatic listener and explicit Inbox confirmation share the same dispatch
fence. A literal native false is rejected; an exception or unknown outcome remains
uncertain. Neither is automatically replayed or handed to another consumer.
The historical manual-only, all-refusals-uncertain behavior is not current.

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

Use the app-owned installer for graphical installations and the supported local
marketplace manager for CLI-only installations, after the candidate passes
its relevant gates. Inspect installed configuration and stage hashes. Keep the
existing settings hooks, MCP, folder/archive/activation adapters and services.
Retire any old adapter only with a documented replacement scope and separate
migration/rollback proof. The app engine packaging allowlist and resource-copy
tests cover the current staged runtime. Nine-language presentation, app-managed
installation and graphical receiver controls are implemented. Build, installation,
loaded-version observation and painting remain separate evidence; receiver
configuration does not establish delivery or new synchronization compatibility.

## G. Rollback acceptance

For routing rollback, select renderer for future messages while retaining the
modern broker. Existing Mod claims, submitted outcomes and receive-once records
must not be downgraded, rewritten or replayed. No older reader may overwrite the
new mailbox format.

Prefer disabling the companion through the normal plugin lifecycle, which the
app preserves. Removing an app-managed installation is not a persistent opt-out:
normal app maintenance can reinstall a missing Mod. Never use marketplace removal
as a rollback shortcut because it can delete native plugin state. Verify the
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
Mod stage hashes / installed configuration / nativeWake / selfWake / route:
New Node tests (pass/fail/skip):
Original npm test (pass/fail/skip):
Native validator (exit code, warnings, declared capabilities):
Native kit (pass/fail):
Terminal painting and behavior:
Desktop painting and behavior:
Authorized model executions and task results:
Native claim / socket submission / receive authorization / queue / recipient ACK / requested result:
Actual-runtime sync acceptance evidence and configured version policy:
Rollback evidence:
Remaining blocked gates and exact reasons:
```

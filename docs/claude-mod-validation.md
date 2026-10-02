# Claude Mod integration validation

Source candidate is now 0.5.0; installed-companion acceptance below remains the
historical 0.4.1 review from 2026-10-03. The reviewed Mac
uses `nativeWake=true`, `selfWake=true` and broker route `mod-self`. Source
defaults remain false. Installation, native invocation and actual Desktop display
were checked separately; no second Mod or sender session is required.
Private IDs, transcripts and evidence directories remain outside this repository.

## 0.5 AI-first observation candidate (2026-10-03)

- 106 affected Mod Node tests passed, including real Unix RPC observation and
  typed-error ingress, per-session expiry/end/disconnect/restart behavior,
  unmapped target diagnosis and unchanged hook/claim/receive/ACK boundaries.
- All 22 final staged hashes match. The independent packaged transport import
  and helper doctor work without source-checkout dependencies; both wake opt-ins
  remain false in this candidate. It was not installed or activated.
- Desktop Code 2.1.286 strict validation has zero errors and warnings. Initial
  kit launches were refused by the vendor rollout; a later normal kit process
  became available without any rollout override or app restart. Its own-inbox
  case correctly could not deliver against the default-disabled shipping stage.
  A separate never-installed test stage with both required opt-ins enabled passed
  all 16 cases, including the new lifecycle observer case. The quickstart now
  distinguishes those configurations. No new Desktop painting, policy or model
  inference acceptance is claimed.
- The signed app candidate packages all new broker modules through its normal
  allowlist; 109 engine/plugin hashes and nested strict signatures were checked.
  It is development-signed, not notarized, and does not replace the installed app.
- The broker now implements default-off origin binding and notifications after
  read-only native-pair feasibility checks. Four integrated synthetic cases cover
  both providers with immediate and delayed native result flush: real MCP facade,
  private RPC, random start receipt, production verifier, actual hook subprocess,
  synthetic worker completion and one exact-origin queue-only notification.
  Replay does not start a second invocation or send a second notification.
- Separate regressions cover missing proof, worker denial, late verification,
  lost notification response, restart, absolute expiry across async discovery,
  native pre-dispatch shutdown fences, app-stop release and bounded storms.
  New PostToolUse trust remains separate from the legacy synchronization gates.
  These tests do not certify fresh native nonce-to-notification delivery; no new
  model inference, live hook installation or recipient wake was performed.
- Final repository regression: 1,479 cases, 1,456 passed, zero failed and 23
  existing opt-in skips. The final P4 package passed strict native validation
  without errors/warnings and imported its packaged broker, origin verifier and
  standalone Mod transport without source-checkout dependencies.
- A subsequent narrow diagnostic correction preserves an unavailable native tool
  inventory as unknown instead of claiming SendMessage is absent; 35 related
  tests passed and the updated seven observation cases passed. No dispatch policy
  or permissions changed, and the valid full-suite evidence is retained.

### Read-only Codex origin-path probe

On the configured existing Codex 0.159.0-alpha.12.1 listener, a real
`claudex-work/claudex_list` call issued through code mode was read back through
bounded `thread/items/list`. Its completed `mcpToolCall` retained the exact
server/tool, empty arguments, native call ID and turn ID; the saved result
content exactly matched the actual MCP response. No new model invocation,
thread resume, hook installation or native-store write was involved.

This establishes the availability of an independent native call/result read
path for this Codex runtime, including nested code-mode calls. It does not yet
validate a fresh start receipt challenge, PostToolUse-to-task binding, Claude
provenance, automatic notification or recipient wake. Those gates remain open;
do not infer an origin from a supplied session ID or upgrade the read-only probe
to end-to-end notification acceptance.

### Read-only Claude origin-path probe

An exact native Desktop registry mapping identified one existing primary Claude
session. A stable no-follow transcript snapshot contained a unique native
`claudex_chat_send` call/result pair: matching tool-use ID, session/cwd,
non-sidechain records, source assistant UUID and parent chain. The result matched
the persisted mailbox receipt and message, including request identity, sender,
target, payload and timestamps. This was a historical 2.1.281 call reverified
read-only, not a new runtime invocation or a start-challenge acceptance.

Together these probes justify independent stored call/result verification for
the two provider paths. The production verifier still requires exact
`claudex_start` identity, the original arguments fingerprint and full one-use
receipt. The complete new live flow and optional-hook native trust remain
unverified until separately authorized acceptance.

## 0.4 panel and localization acceptance (2026-10-03)

- The package provides 170 English-keyed strings in all nine app languages,
  grouped panel summaries, wrapping navigation and collapsed technical details.
  Native IDs, protocol bodies and unknown diagnostics remain verbatim.
- 73 affected Node cases passed: controller/bridge/RPC contracts (55), and
  localization/staging/packaged-engine contracts (18). Catalog validation rejects
  missing language columns and changed placeholders before staging.
- Desktop Code 2.1.286 strict validation passed with no warnings. Its official
  native kit passed all 15 cases, including all nine locales on terminal/Desktop
  trees, unsubmitted form retention, complete preview retention across language
  changes, and the unchanged self-inbox receive fences. A first added test used
  a store accessor absent from the test harness; that assertion was removed,
  leaving persistence covered through the dedicated host-adapter unit test.
- Earlier kit launches reported vendor rollout disabled, without an environment
  override. After normal Desktop restart/resume, the normal kit command became
  available. This was not a companion version gate or a synchronization-policy
  change. The final 0.4.1 differs from the passing candidate only in package
  version and README heading; runtime and test bytes are unchanged.
- Normal native marketplace/update commands installed 0.4.1. All 19 staged-file
  hashes match the installed package, including the corrected native fixture.
  Existing opt-ins and the broker's mod-self route were retained.
- Actual Desktop pixels showed Traditional Chinese selected from macOS system
  preferences, all five navigation controls fitting two rows, readable broker,
  work and runtime sections, and collapsed diagnostics. The broker inventory
  responded. These pixels do not certify mouse interaction with every control;
  native test-kit callbacks establish the multilingual switching contract.
- During UI automation, a duplicated reload command was mistakenly submitted as
  plain chat text and produced one short model reply, with no tools or workspace
  edits. It was disclosed and retained in the original test history. Subsequent
  correctly formed slash commands used native command handling. No history or
  uncertain message record was erased to clean up the acceptance transcript.

## Single-session own-inbox evidence

| Check | Observed result | Evidence boundary |
| --- | --- | --- |
| Full repository regression | 1,325 passed, zero failures, 23 existing opt-in skips; 1,348 total, before the final narrow queued-hook exclusion | Final hook-fence delta uses affected mailbox/Mod regression; synthetic tests never start inference |
| Own-inbox transport | 16 focused cases pass | Includes exact parent/socket checks, Darwin listener plus accepted FD, timeout drainage and no retry |
| Broker/bridge/pump integration | 15 focused cases pass after the real RPC and queued-hook repairs | Includes actual private Unix RPC; synthetic model/native delivery |
| Final queued-hook fence regression | All 54 affected mailbox, own-inbox and prior Mod-route tests passed | The one-line final backend delta preserves Stop ACK and old routes; no additional model calls |
| Final native validator and kit | 0.3.1 strict validation and all 12 official native cases passed in a fresh normal process | Earlier isolated processes reported rollout disabled; none was overridden, and process-specific availability is not account-wide proof |
| Installed plugin assets | All 16 installed plugin assets match the final 0.3.1 stage | Artifact equality, separate from native display and delivery evidence |
| Final bundle verification | Installed Claudex and Claude app deep signature verification passed; Claude app.asar remained unchanged | Traditional Chinese Claude bundle retained; not notarization or public release |
| Installed 0.3.1 automatic delivery | After normal Claude restart, one Claude Code process and one eligible `mod-self` waiter remained; source and target were the same exact native session | Actual Desktop-owned listener, not a second sender, command-driven dispatch or synthetic broker |
| Recipient result | A newly authorized Sonnet 5.5 canary replied with the requested nonce and actual Stop ACK in 4.253 seconds | Exact claim, `submitted`, receive-once timestamp, reply and ACK inspected independently |
| Actual Desktop display | Native accessibility inspection after normal UI refresh showed peer framing, requested reply and Stop ACK; the original unsent draft remained unchanged | Actual rendered session and composer evidence, not only transcript/source checks |
| Native explicit refusal | Isolated Desktop-binary 2.1.286 session with `tools: []` and per-invocation `crossSessionInbound: refuse` received one production-transport write; native logs explicitly refused it before receive-hook delivery | Zero assistant turns and zero model turns; no global setting edit |
| Native explicit hold | Equivalent isolated session with `crossSessionInbound: hold` retained one message with `cause=explicit-setting`, then expired it at normal shutdown | Zero model turns; native hold was not released or bypassed |
| Native receive shape | Hold probe observed `origin.kind=peer`, no agent ID, and the exact routing prefix followed by JSON at `session.receive` | Observed 2.1.286 wire behavior, not a permanent public wire-format guarantee |
| Earlier failed delivery preservation | The earlier 0.3.0 claimed message remains `submitted` without receive authorization or ACK and was not resent | Success used a distinct newly authorized message; no reset, migration or replay of uncertain evidence |
| Final broker restart/no replay | Owned services were verified stopped and resumed normally; mod-self persisted, one waiter reconnected and the same single Claude Code process remained. Successful nonce appeared once, earlier undelivered nonce zero times, and the outbox had no pending receipt | Actual restart evidence; draft never became a submitted prompt; no claim reset or retransmission |

The documented native own-child inbox is distinct from `session.send`, which
explicitly refused self-addressing in the native probe, and from `prompt.submit`,
which is not used. This route is macOS-only. The helper verifies the native
parent's PID, birth identity and UID and its exact private socket. The per-session
token stays in inherited environment and the in-memory auth line: never in argv,
receipts or logs. Native kernel peer evidence can be unavailable after a fast
child exits; the documented own-session token supplies the native own-child
authentication in that case. Explicit inbound hold/refuse remains authoritative.

There is no native delivery ACK on the socket. `submitted` means the bounded write
completed, not that the model read it. Durable one-dispatch and receive-once
records prevent duplicate helpers and duplicate envelopes from replaying work.
Only the real recipient Stop hook records receipt. Neither that receipt nor a
socket write proves completion of arbitrary requested work.

### Failures reproduced and repaired

- Darwin `lsof` lists the listener and its accepted connection under the same
  socket pathname. Requiring exactly one matching FD falsely rejected a valid
  connected parent. The repair accepts one or more exact-parent/exact-path FDs
  while preserving independent socket ownership, type, path and identity checks.
- The private collaboration transport allowlist initially omitted
  `mod_wake_receive`. A live 0.3.0 socket write succeeded, but receive validation
  failed before reaching the broker. A real private-RPC regression reproduced
  `Invalid collaboration request`, then passed after the method was added. Tests
  that called the hub directly could not expose that transport boundary.
- Duplicate receive authorization and concurrent helper dispatch were fenced by
  durable one-use records. Route/shutdown is checked again after the awaited
  receive transaction. Synthetic tests cover each fence and restart behavior.
- Final safety review reproduced ordinary SessionStart/UserPromptSubmit/Stop
  hooks consuming queued mod-self messages, which could bypass native hold/refuse.
  A failing regression became green after excluding only that route from hook
  offer selection. Real Stop ACK scanning, queue-only messages and older routes
  retain their behavior. This backend-only delta does not change the validated
  native plugin assets or require replaying the live canary.

No native-store edits, fabricated ACKs, held-message approvals or hidden replay
were used. New-runtime synchronization acceptance, arbitrary pane-button flows,
Linux/Windows own-inbox delivery and closed-session automatic startup are outside
this evidence. Busy-delivery evidence below belongs to the older cross-session
route, not a new certification of every own-inbox busy-session case.
Collaboration remains ready. A post-upgrade renderer-maintenance inspection
reported `cache-entry-missing`; the own-inbox path does not use that renderer
adapter. Existing unfinished-tool synchronization and predecessor-archival waits
also remain separate from the completed own-inbox acceptance. This is not an
all-components-healthy claim.

## Historical 0.2.3 cross-session automatic-route evidence

| Check | Observed result | Evidence boundary |
| --- | --- | --- |
| Focused delivery/controller/bridge regression | 72 passed, no failures | Includes await-boundary lifecycle and authorization regressions; no inference |
| Actual Desktop Code 2.1.286 strict validator and native kit | Strict validation and 9 cases passed again | Earlier rollout-off refusal not reproduced; no vendor flag override |
| 0.2.2 local installation | Development-signed Claudex app installed with previous app backed up; native manager updated plugin 0.1.1 to 0.2.2 | Not notarization or public release |
| Configuration | Native manager saved nativeWake=true; matching installed broker uses route=mod | New wake-enabled messages capture that route |
| Automatic native delivery | Untouched listener in an SDK-owned sender claimed and called real session.send without a sender prompt/model input | Not manual acceptWake or Inbox-button acceptance |
| Recipient completion | Native queue accepted; Sonnet 5.5 returned the requested nonce and real Stop hook ACK in about 4.2 seconds | Exact source, claim and completed outbox receipt matched separately |
| Busy recipient | Second native send accepted before the first message's ACK; both replies and ACKs observed separately | Native queue controls timing; acceptance alone is not completion |
| Offline recipient | Native API returned false, recorded rejected; reopening the recipient did not replay it | One observed refusal mode, not every inbound policy variant |
| Desktop activation | Normal authorized Claude restart; 0.2.2 pane shows Engine 2.1.286, nativeWakeEnabled=true, waiting-for-authorized-message and real broker limits | Actual Desktop accessibility evidence and helper response |
| Draft preservation | Native screenshot shows the busy-delivery reply/ACK and the exact unsubmitted draft retained | Observed native composer behavior, not only a synthetic API contract |
| Translation and bundle preservation | Claude app.asar hash unchanged and signature verified after restart | Traditional Chinese application retained; Claude app was not replaced |
| Final 0.2.3 validation/installation | Strict native validator and 9 kit cases passed; 15 installed plugin assets match stage; installed broker, delivery, registration and manifest hashes match the repository and deep signature passes | Final executable artifact evidence; the packaged README predates this final documentation update |
| Final Desktop-owned delivery | After normal broker stop/start and Claude restarts, two Desktop-owned listeners remained; a new exact-recipient Sonnet 5.5 reply and real Stop ACK completed in 4.276 seconds | One reply, matching claim/outcome, no pending outbox; SDK sender had exited normally |
| Restart/no replay | nativeWake=true and route=mod persisted; earlier offline rejection remained unchanged with no native replay | Normal restart evidence, not injected loss during an in-flight native call |
| Final pane layout | Actual 0.2.3 screenshot shows all five tabs in two rows, Engine 2.1.286, nativeWakeEnabled=true and accepted outcome for the final message | Real painting; not every button-flow acceptance |

No direct native-store edits, fabricated ACKs, claim reset or replay were used.
That cross-session `mod` route requires another eligible loaded sender; the
new explicit `mod-self` route removes that dependency. Pending-receipt fault recovery remains synthetic coverage; a normal
restart with no pending outbox is not proof of every interrupted-send case. The
temporary upgrade-time folder-cache diagnostic cleared through normal maintenance.
Final read-only inspection shows collaboration, folders and renderer adapters ready,
with no active or uncertain managed collaboration tasks. Synchronization still
reports an unfinished-tool handoff pause and normal predecessor-archival lifecycle
wait; these separate guards were not altered or waived by Mod acceptance.
Pane-origin model delegation and new synchronization-runtime compatibility are
also outside this evidence.

## Reproduced repairs

Version 0.2.1 added two malformed-reply regressions: dispatch requires literal
ready:true and receipt publication must confirm the exact message, claim, source,
recipient, route and outcome. Both failed before their fixes; the affected suite
then passed 69 cases. Its full regression passed 1,292 tests with zero failures
and 23 existing opt-in skips. Unchanged regression evidence is reused.

Version 0.2.2 added three cases around revocation during awaited native reads.
The lifecycle and readiness failures were reproduced before repair. Context is
rechecked after awaited helpers; broker claim/readiness rechecks route, shutdown,
claim outcome and expiry after metadata verification. This prevents stale
readiness or dispatch after clear/end. All 72 affected tests passed.

Real 0.2.2 Desktop inspection found that a single five-tab row clipped Inbox in
a normal narrow pane. Version 0.2.3 uses two rows of native Box elements, preserving
the existing controls and avoiding unsupported layout properties. Final native
pixels verify the repaired layout; unreliable accessibility-control frames were
not treated as proof of a product failure or of every button interaction.

Earlier integration repairs retained their tests: Darwin socket fixture length,
module-top-level $ helpers, intrinsic $.plugin.root property access, complete
native callback coverage, clear/end redraw, source-parent symlink rejection and
strict manifest attribution. Automated tests never start model inference.

## Native capability and availability boundaries

Claude Code 2.1.287 is the documented public Mod baseline, not a load gate.
The installed Desktop Code 2.1.286 actually validates and runs this companion.
Earlier CLI test processes on 2.1.286 and 2.1.287 reported the rollout switch off;
that applied to those processes, not every loaded Desktop session. Later isolated
native kit processes also reported rollout disabled while the installed Desktop
successfully ran 0.3.1. No override was introduced. Neither observation establishes
account-wide availability.

Hooks cover session.start, classic.SessionStart, session.end, session.receive,
turn.complete, command.run and ui.render. Calls include command.register, env.get, process.run,
prompt.fill, session.cwd/id/send/usage/version, settings.read, tool.list, clock.after and
ui.invalidate/open/resolve. The only environment read is the managed-worker marker.
plugin.root is intrinsic metadata. Timers drive bounded broker waits/reconnection,
not conversation-history sweeps. No prompt submission, permission approval or
new sender model process is introduced. Recipient delivery can trigger authorized
model work and consume account allowance.

The native kit stubs external operations; passing its tree/callback cases is not
Desktop painting or delivery evidence. The validator does not transitively audit
the child helper. The helper's private file/RPC effects retain source-level and
Node contract coverage. Declared session.send capability exists even with the
default nativeWake=false; that flag gates use, not trust granted to installed code.
Own-inbox delivery additionally requires selfWake; its native socket and token
are inherited by the helper without exposure to the Mod's public result.

## Historical manual acceptance

The earlier 0.1.1 test used a temporary native command invoking the unchanged
production controller's wakeList/previewWake/acceptWake, installed helper and real
broker. It verified actual queue acceptance, a Sonnet 5.5 reply and recipient Stop
ACK, but was not automatic-listener or mouse-driven Inbox acceptance. Its sender
test command performed zero model turns. Untitled imported recipients were refused;
native SDK-created titled recipients passed exact metadata checks.

A distinct all-tools-removed sender attempt returned false because SendMessage
was unavailable. The old controller retained that offered/uncertain evidence;
it was never reset or replayed. The successful case used a new message. Later
versions preflight SendMessage and classify explicit false as rejected.

At that stage nativeWake was restored to false and installed 0.1.1 remained in use.
The current authorized automatic deployment supersedes that snapshot. Prior
/reload-plugins success did not always replace an existing session's module;
verify the actual pane after a supported lifecycle boundary, never rewrite an
old cache to force loading.

Follow [the guide](claude-mod.md), [handoff](claude-mod-handoff.md) and
[acceptance checklist](claude-mod-acceptance.md). Development signing is not a
notarized public release; native Mod acceptance does not change synchronization
allowlists, ownership guards, existing holds or other Desktop adapters.

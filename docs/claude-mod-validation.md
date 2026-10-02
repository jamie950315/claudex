# Claude Mod integration validation

Reviewed on 2026-10-02. Source and installed companion: 0.2.3. Initial automatic
acceptance used 0.2.2; final 0.2.3 native acceptance also verifies the narrow-pane
tab repair, installed assets, restart persistence and Desktop-owned delivery.
Private IDs, transcripts and evidence directories remain outside this repository.

## Automatic-route evidence

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
Another eligible loaded sender is still required; the recipient alone cannot
self-deliver. Pending-receipt fault recovery remains synthetic coverage; a normal
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
that applied to those processes, not every loaded Desktop session. Current tests
pass without overrides. Neither observation establishes account-wide availability.

Hooks cover session.start, classic.SessionStart, session.end, turn.complete,
command.run and ui.render. Calls include command.register, env.get, process.run,
prompt.fill, session.cwd/id/send/usage/version, tool.list, clock.after and
ui.invalidate/open/resolve. The only environment read is the managed-worker marker.
plugin.root is intrinsic metadata. Timers drive bounded broker waits/reconnection,
not conversation-history sweeps. No prompt submission, permission approval or
new sender model process is introduced. Recipient delivery can trigger authorized
model work and consume account allowance.

The native kit stubs external operations; passing nine tree/callback cases is not
Desktop painting or delivery evidence. The validator does not transitively audit
the child helper. The helper's private file/RPC effects retain source-level and
Node contract coverage. Declared session.send capability exists even with the
default nativeWake=false; that flag gates use, not trust granted to installed code.

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

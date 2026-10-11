# Claude Mod companion

Contributor rules moved out of AGENTS.md; they are binding. Scope: Staging and validating the Mod, configuration identities, the panel, nativeWake/selfWake routes and own-inbox delivery.

The Claude Mod companion is staged by `bin/claudex-mod.mjs` and documented
in `docs/claude-mod.md`. Claude Code 2.1.287 is the documented public baseline,
not a companion load gate. Earlier Desktop 2.1.286 acceptance passed the native
validator, the then-current 17 kit tests and no-inference command registration
without added feature flags; test the actual runtime before requiring an upgrade. This does not
certify new synchronization runtimes. Keep the explicit app/stage allowlists and
the app-owned journaled installation path described above. `plugins/claudex/hooks/register.mjs` uses
top-level `$` helpers required by the native compiler, and `$.plugin.root` is a
property, not an event or function. Run the official strict validator and complete
native test kit against a staged plugin after UI/API changes, in addition
to affected Node tests. Native tree tests are not real Desktop painting evidence.
Standalone staging must include the transport's pure notification-policy, wait
and worker-boundary modules. Keep broker-only imports out of that transport
dependency graph.
Verify an actual staged helper read over Unix RPC after its source copy is
removed; doctor-only checks and mocked transports do not prove a deployable
companion. Pane artifact reads share the broker's 64 KiB limit and retain a
bounded, typed scope/identity/size refusal instead of claiming service failure.
The Mod does not render an AbovePrompt status band; usage remains in its pane.
The native panel uses grouped summaries, two wrapping navigation rows and collapsed
technical records; never collapse or truncate the complete confirmation payload.
Its native plugin-store language preference is independent of the app's preference,
with the same nine languages and script/region-aware macOS system resolution.
Language changes only redraw presentation, preserving form edits and pending
confirmations. Keep native IDs, models, user content and unknown diagnostics raw.
The catalog's static JSON rows are validated without executing candidate source;
stage and app packaging reject missing translations or mismatched placeholders.
Desktop Code 2.1.286 loads installed plugins through SDK local delivery, whose
configuration identity is claudex@inline rather than claudex@claudex-local.
Configure only the intended public options through the native manager with the
verified installed plugin path; preserve both identities, source defaults and
inbound policy. Confirm actual registration/observer values, not only saved
marketplace settings. Technical diagnostics expose only these two known identities
and wake booleans/types, never complete settings or secrets. The local /claudex
command returns explicit handled text after opening its pane, not an empty reply.
User-authored controller writes use exact-context prepare/confirm and durable
no-replay receipts; managed workers cannot borrow controller authority. Since
0.3.1, explicit selfWake accompanies nativeWake; both default to false.
`collaboration native-wake --route mod-self|mod|renderer` captures the route on
new wake-enabled Claude messages; existing messages and receipts keep their
original route. The same loaded recipient Mod can receive with both opt-ins and
mod-self; no second Mod, sender session or SendMessage tool is required for that
route. Closed/unloaded recipients wait for normal native resume, not a new owner.
Never flip an unvalidated installation's route until native activation acceptance
passes. The reviewed Mac has App 1.2.13 and Mod 0.8.10 installed through normal
Quit/reopen and app-owned Mod management; both native configuration identities'
receiver opt-ins were retained. Existing Claude sessions were not restarted;
installation is verified but existing Desktop sessions can retain older loaded
Mod code until a normal new session/reload. Isolated native 0.8.7 direct-on
acceptance passed without model turns; it does not prove those existing sessions reloaded.
The earlier reviewed 0.7.1 installation used route=mod-self. Earlier acceptance after a normal Claude
restart verified that one Desktop native session and one waiter delivered
a newly authorized message to the same session, with a Sonnet 5.5 reply and real
Stop ACK. Native UI evidence retained the unsent draft. Explicit native hold and
refuse passed in isolated tools:[] sessions with zero model turns. Preserve the
earlier failed submitted/no-ACK message; success used a new message, never replay.
Keep exact evidence in docs/claude-mod-validation.md. Isolated CLI rollout refusal
does not invalidate a loaded Desktop Mod and must not be overridden to pass a
test. New installations still default off; keep the Traditional Chinese bundle.
Verified broker stop/start retained mod-self and one waiter without replay; the
same native Claude process and unsent draft remained. Open the installed Claudex
app by its exact /Applications/Claudex.app path, not a same-named test bundle.
Each loaded eligible session makes one bounded event-backed broker wait, never a
history sweep. The retained mod route requires another loaded sender and checks
SendMessage before claiming. The mod-self route checks exact own context, native
inbound policy and inbox capability. Do not create a model session or silently
fall back. Verify exact recipient and app-stop again before native dispatch.
Own-inbox delivery is macOS-only: validate the native parent PID/birth/UID and
its exact private owned socket with bounded process inspection and stable
no-follow identities; only root-owned Darwin /tmp and /var aliases are allowed.
Darwin lsof may list both listener and accepted FDs with that exact pathname;
require at least one exact-parent match, preserving independent socket proofs.
Use the documented native own-child ingress and inherited token in memory only,
never token copies in requests/argv/files/logs. This is not session.send self
(the tested runtime refuses it) or prompt.submit fallback. Native hold/refuse
remain authoritative; never change inbound settings or fabricate human origin.
Ordinary SessionStart/UserPromptSubmit/Stop hooks cannot consume queued mod-self
messages, which would bypass its receiver-policy wait. Keep actual Stop ACK
scanning intact; queue-only and older message routes retain their hook behavior.
Persist a one-dispatch intent before the socket write; duplicate helpers return
saved evidence, never resend. The socket provides no native ACK: submitted means
written only. The receiving Mod checks exact context/lifecycle and app-stop, then
obtains durable receive-once authorization before admitting original broker peer
text. Recheck route/shutdown after awaited receive authorization; a lost reply
consumes the authorization without replay. Only real recipient Stop ACK proves
reception; no helper/socket response proves model or work completion.
Keep mod_wake_receive in the private transport allowlist and test the actual
Unix RPC path, not only direct hub.dispatch; a missing ingress method previously
allowed socket submission but blocked receive authorization before the broker.
Clear/end fences late callbacks, including after awaited context reads. Recheck
broker route, shutdown, claim outcome and expiry after metadata verification.
Unknown sends never retry. Explicit native false
is rejected, not requeued through hooks (which could defeat recipient policy).
Persist outcome receipts before RPC, and recover only idempotent receipt writes.
Require literal ready:true before dispatch and exact message/claim/source/target,
route and outcome confirmation before marking an outbox receipt complete.
Malformed/private storage blocks rather than being discarded. Unavailable target
metadata must not starve other recipients. Keep existing MCP, hooks, renderer
adapters, version policy and live runtimes; no permission approval, native store
editing or automatic app restart is introduced.
Bounded authorized automatic nativeWake acceptance on 2.1.286/Sonnet 5.5 verifies
SDK-owned and Desktop-owned senders, exact claim, real session.send acceptance,
recipient reply and actual Stop ACK. The final Desktop-owned case passed after
normal broker/Claude restarts, with one reply and no pending outbox receipt.
Busy delivery accepted a second message before the first ACK; both ACKs arrived.
Offline rejection stayed rejected after reopening/restarts without replay. Native
pixels verify the unsubmitted draft remained and all five 0.2.3 tabs fit two rows.
Keep the two-row layout for narrow panes. This is not every button flow or policy
denial scenario or new synchronization-runtime acceptance. Own-inbox acceptance
does not certify renderer/cache readiness; preserve its independent diagnostics.
Unfinished-tool handoff and predecessor-archival lifecycle waits remain separate,
unchanged guards.
Those historical cross-session results do not certify mod-self. Preserve earlier manual
all-tools-removed offered/uncertain evidence; never reset or replay it. Untitled
or unverified Desktop metadata remains refused.

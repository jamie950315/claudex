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
The Tasks inventory defaults to most recent activity, with a native Select for
Task ID order. Fetch the selected order from the broker on every inventory page;
switching order refetches the first page and resets the local ten-card offset.
Task cards show a compact local last-update time. API callers retain ID ordering
by default; live inventory pages are not a frozen snapshot.
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
no-replay receipts; managed workers cannot borrow controller authority. The
Mod start defaults to read-only and only permits sandboxed levels; previews
and receipts must expose capabilities and SANDBOX_NO_NETWORK before confirmation.
Omitting permission here retains read-only, not the broker default; network work
uses the existing agent/operator workflow with an authorized full-access default.
Since 0.8.30, nativeWake and selfWake default to true. By explicit user decision
(2026-10-15), setup/startup fill only never-configured keys, independently for
both known native identities; preserve explicit false and disabled plugins.
Native replies may consume model allowance. New brokers default to mod-self;
preserve existing selected routes and every queued message's captured route.
`collaboration native-wake --route mod-self|mod|renderer` captures the route on
new wake-enabled Claude messages; existing messages and receipts keep their
original route. The same loaded recipient Mod can receive with both opt-ins and
mod-self; no second Mod, sender session or SendMessage tool is required for that
route. Closed/unloaded recipients wait for normal native resume, not a new owner.
Never flip an unvalidated installation's route until native activation acceptance
passes. Isolated CLI rollout refusal
does not invalidate a loaded Desktop Mod and must not be overridden to pass a
test. Keep native policy/trust guards and the Traditional Chinese bundle.
Open the installed Claudex
app by its exact /Applications/Claudex.app path, not a same-named test bundle.
Each loaded eligible session makes one bounded event-backed broker wait, never a
history sweep. The retained mod route requires another loaded sender and checks
SendMessage before claiming. The mod-self route checks exact own context, native
inbound policy and inbox capability. Do not create a model session or silently
fall back. Verify exact recipient and app-stop again before native dispatch.
Policy observations distinguish an explicit allow/hold/refuse from an unset
crossSessionInbound setting, a failed settings read and an unrecognized value.
An unset setting leaves the effective native default unverified; do not infer
allow or a current delivery guarantee from an earlier ACK. These content-free
details affect diagnostics only, never receiver defaults, native admission,
claims, dispatch guards or replay. Older unknown observations retain their
explicit missing-evidence diagnosis until a fresh observer reports the reason.
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

Keep the two-row layout for narrow panes. This is not every button flow or policy
denial scenario or new synchronization-runtime acceptance. Own-inbox acceptance
does not certify renderer/cache readiness; preserve its independent diagnostics.
Unfinished-tool handoff and predecessor-archival lifecycle waits remain separate,
unchanged guards.
Those historical cross-session results do not certify mod-self. Preserve earlier manual
all-tools-removed offered/uncertain evidence; never reset or replay it. Untitled
or unverified Desktop metadata remains refused.

## Companion journal capacity

The action, self-dispatch and wake-outbox journals retain at most 2048 active
records each. Capacity pressure archives one settled record before publishing a
new one. Preserve exact ID/fingerprint/claim lookup and conflicts across active
and archive storage; never scan archives or discard their evidence. Completed
actions and expired uncommitted previews are settled. A self-dispatch is settled
only after proven pre-write refusal, or submitted plus its exact confirmed
submitted receipt. Done outbox records are eligible except uncertain outcomes.
Pending, dispatching and uncertain records never retire. Archive publication is
durable before active removal; interrupted duplicates must match exactly.
Per-record locks fence archival against mutations; a private journal lock
serializes capacity reservations and can reclaim only proven-dead holders.
Unverifiable/stale action locks remain protected. Unsafe/malformed storage fails
closed. Expose typed counts and capacity states through doctor/app diagnostics;
JOURNAL_CAPACITY_EXHAUSTED refuses a new record and never authorizes dispatch
or replay. A receipt-storage failure after dispatch remains uncertain.

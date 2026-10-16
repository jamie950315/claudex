# Cache warming

Contributor rules moved out of AGENTS.md; they are binding. Scope: Claude and Codex cache warming: commands, limits, broker settings, TTL preferences, ledgers, evidence rules and the developer probes.

- `dev/cache-warm-probe` is a manual, authorization-gated Sonnet 5.5/medium
  cache-retention experiment, not an installed warming service. It uses private
  nonpersistent sessions and a no-refresh control. Explicit `--strategy main`
  sends one real refresh turn through the same live SDK session without a Mod;
  the default fork strategy uses one native Mod fork. Neither is an automatic
  fallback for the other. Main-mode effort is requested configuration, not
  independent effective-effort proof; actual main-response models are verified.
  Keep its runtime evidence outside Git and its inference outside automated tests.
  Fork usage and unchanged main messages must be verified; a cached hit alone
  does not establish TTL extension. Native fork has no independent output cap.
  `--strategy one-token` separately measures native output-limit recovery with
  two explicit user submissions and content-free, deduplicated response usage.
  A one-token cap or `maxTurns: 1` is not a one-request guarantee; preserve
  native errors and distinguish continuation from transport retries.
- `dev/cache-warm-probe/codex.mjs` is a read-only Desktop capability/usage
  prototype, not an enabled warmer. Optional observation only rejoins an
  already-loaded active thread; never start a thread, dispatch input or override
  native settings. The reviewed 0.160.0 owner route has no composer-state or
  per-warm-turn no-tools contract; this read-only probe never dispatches.
  Usage accounting needs an observed baseline and exact cumulative/last deltas;
  duplicate events do not renew cache evidence. Local sample IDs are not upstream
  response IDs. The separate shipping best-effort adapter requires explicit
  acceptance, not a silent fallback or a change to this probe.

Cache warming is separately opt-in per loaded Claude session. The Mod exposes
`/claudex:warm on [5m|1h]`, `off` and `status` for the current native session
only. By user decision, the explicit namespaced on command directly enables;
run the one-use prepare/confirm transaction internally, with the original
origin and an unchanged initial session binding/epoch across awaits. Never ask
for a second confirmation token on this shortcut. Ship `skills/warm/SKILL.md`
in both allowlists for native catalogue discovery; intercept `claudex:warm`
locally in `command.run`, preserving native origin and never delegating to a
model. Its TTL override must not update shared remember/default preferences.
Keep legacy `/claudex warm` persistence controls and Codex native hook controls distinct.
Normal namespaced on/off/status replies use the shared pure cache-warm-display
formatter: four localized text lines, plus a fifth with the used and chosen
limits whenever a policy exists, never raw policy JSON. The same file's pure
parseWarmLimits turns the user's one chosen limit into the existing
maxRefreshes/maxMinutes bounds for both providers' `on` commands (Claude
interval 4 or 55 minutes by TTL, Codex 25). By user decision exactly one of
`rounds=N` (at most 500), `for=DURATION` (at most 168 hours) or
`until=HH:MM|DD:HH:MM` (the next occurrence, within 168 hours) is accepted,
never a combination. By user decision an `on` command without a limit warms
for four hours, exactly as `for=4h` (up to 5 requests at a 1h TTL, 60 at 5m,
10 on Codex, including an initial cold-cache request when needed); the advanced
`/claudex warm on` and CLI keep their 60-minute, 3-request defaults. By user
decision that default is one broker setting
shared by Claude, Codex and the app: `defaultWarmLimit` in the collaboration
ledger, read and written only through controller `cache_warm_settings` (never
a managed worker, and writes refuse while the app is stopped). The Mod Cache
tab offers fixed choices and `/claudex warm limit WORD` accepts any `rounds=`,
`for=` or `until=HH:MM` valid for at least one TTL, never a day of the month,
through the same preview/confirm path; the Codex hook reads the setting when
its `on` command has no limit; the app's Cache settings window (its own
window, opened by the footer button or the menu) saves a fixed choice with
Save and writes nothing on open, reload or selection. By user decision that
window also carries Claude-Code-only settings, labeled as such: the startup
TTL preference now lives in the same broker record (`cacheTtlPreference`,
`cacheTtlLastChoice`, one remembered choice bound to its preference revision).
The Mod host reads and writes it through `cache_warm_settings`; a preference
an earlier Mod left in the plugin store is only read until one is saved in
Claudex, and nothing writes the store again. The app builds a remember
revision itself; the session TTL of a running process still changes only
inside that session. The window lists enrollments that are enabled and not
past their end, by exact session and directory, and its Stop uses the
controller's existing off/disable request for exactly that one. It never
enables warming, and read-only modes can look but not save or stop.
By user decision the same record holds `warmOnUserMessage`: `continue` (the
default: the reply to a message of the user starts the whole chosen limit
over: `restartedAt` is set, only later attempts count, and `until` moves to
that reply plus maxMinutes unless the policy is `fixedEnd`, which an `until=`
limit sets so its clock time stays; a tool step, a failed reply and a limit
already out of time or requests restart nothing) or `stop` (that message ends
the schedule with reason `user-message`). Both managers read it when the response arrives, so it
applies to running schedules. By user decision the same record holds
`compactAfterWarm` (boolean, default true; both apps): a schedule that
reached its limit compacts its conversation once, never through a prompt or
`/compact` text. Claude runs the native command with
`$.command.run({ command: 'compact' })` and takes the main conversation's
`session.compact` hook result during that call as the outcome (messages:
compacted, skip: skipped, none: uncertain); the command's own return proves
nothing. Real 2.1.295 refuses `$.session.compact()` in SDK sessions ("not
available in a headless (-p / SDK) session yet"), which Desktop uses, and
refuses a `/`-prefixed `$.prompt.submit`. Codex
asks the Desktop owner with its own follower request
`thread-follower-compact-thread` (v1, `{ conversationId }`, answered
`{ ok: true }`; read from the shipped Desktop bundle, where the owner then
sends `thread/compact/start`) on the same one-use, re-proved owner handle as a
warm turn. The observer calls `expectCompaction()` inside the final dispatch
fence; from then `thread/compacted` and a `contextCompaction` item are
`compacted` evidence instead of an invalidation, and only the native turn
seen from its start to a `completed` completion with that evidence settles
the attempt as compacted. Anything else, and ten minutes without a
completion, is uncertain. No manager observation is sent while it runs. The
limit's expiry timer must not end a schedule whose compaction is still due
(`compactionAt`).
The time is the last sample's next-refresh time (`compaction()` in the
manager), offered as `compactAt` beside a null `nextAt`; it applies when the
time or request limit is used up or the next request would fall after
`until`, and never once that sample's cache window has expired. `compact=on|off`
on an `on` command is the session's own choice (`policy.compact`), cleared by
the next enrollment; absent, the shared setting is read when the limit ends.
Only a client that can compact claims with `kind: 'compact'`, so an older
loaded Mod never receives one. The native compiler refuses a `$` event read
as a value; call it, never probe it with `typeof`. The attempt reuses the one-use
reserve/check/receipt path with `kind: 'compact'`, is no warm request in
totals, and ends the schedule on every outcome (`compacted`, `compact-skipped`,
`native-uncertain`); it is never repeated. The client turns local warming off
before the call because a compaction restarts the classic session hooks. A
message of the user after the limit ran out ends the schedule with its limit
reason instead of compacting. The summary adds a sixth line for a policy whose
broker reports `compactAtEnd`. The advanced Codex CLI has no flag and follows
the shared setting. The message is a response that is not a warm
request, in a later turn than the one that first gave the binding evidence;
the first observed request (including an own prime) supplies timing rather than
restarting the limit, and a turn start or a command that makes no model request
never counts. Saving changes neither
the TTL nor a running policy and enrolls nothing. Whether the saved limit fits
a session's interval is decided, and refused explicitly, when warming is
enabled; an unreachable broker fails the `on` command instead of guessing. A time
limit allows the requests that fit in it; rounds must fit in 168 hours. A duration
limit includes the initial request at time zero when needed; its request cap is
ceil(duration / interval). Rounds keep their conservative
floor(168 hours / interval) fit because an existing cache may defer the first
request. A limit needing more than 500 requests is refused with its reason
instead of being shortened. The
broker bounds are maxRefreshes 1..500 and maxMinutes 1..10080. The attempt
ledger keeps its 2048-record, 2 MiB size: a new enrollment drops that
conversation's settled attempts (rejected, revoked, verified, failed) of
earlier enrollments. Once the attempts, the request receipts or the 64
policies are half used, it also retires other conversations whose enrollment
is stopped and past its end: their settled attempts, then the policy and its
request receipts when nothing unsettled remains. Uncertain and unfinished
attempts are never dropped and keep their policy; running or unexpired
enrollments are untouched; a ledger still full refuses. Keep its Mod file
in both packaging allowlists. Select only the exact session/cwd policy; respect
local suspension and unavailable scheduling evidence. First cache-result timing
comes from native actual-read observations in the complete current-generation
ledger, never a reservation or a truncated attempt listing. Formatting and
language discovery cannot enroll, refresh or change budgets. Advanced diagnostic
commands retain their structured response for operators.
Native binding capacity is 64 concurrent bindings, not a lifetime session count.
Detach ended/settled Codex observers and remove their live binding entries; an
uncertain attempt remains in the durable ledger without replay. Keep at most 64
retired instance tombstones in each manager. Before forgetting a tombstone,
advance the admission floor for the shipping `warm-<creationMs>-<nonce>` IDs;
unknown instances at or below that floor cannot bind again. Already admitted
older instances retain their sequence/epoch checks. Once opaque legacy IDs have
been forgotten, refuse unknown opaque IDs rather than accepting an old callback.
Codex allocates monotonically increasing instance times and additionally fences
every queued callback by exact observer object identity. This is stale-callback
fencing, not dispatch authority. List exposes `providerStatus.closed`, `reason`
and `code`; a provider-wide async failure cancels every timer, stops all policies
and closes observers, revoking reservations and preserving dispatched attempts as
uncertain. Storage-publication failures stop all in-memory policies even when
their durable shutdown cannot be saved. No failed service automatically restarts
or retries native input.
By user decision, read tokens have no admission or actual-usage limit on either
provider. Keep their reservations and native usage accounting, exposing
maxReadTokens:null and counted/unlimited in summaries. Validate legacy numeric
fields for existing clients/journals and preserve exact requestId payload replay,
but never enforce the old cap or re-enable stopped work. New UI/CLI commands
reject the removed read-limit option. Duration, refresh-count, output limits
and every native identity/lifecycle/no-replay check remain unchanged.
`src/cache-warm.mjs` owns bounded durable policies and one-use attempts; the Mod's cache-warm client
observes per-request native usage and submits only into its own native owner.
Never reuse legacy diagnostic observers, ACKs or activity timestamps as cache
proof. A Claude warm request is a hit when it read the whole preceding prefix,
or read more than the preceding request itself read (`priorReadTokens`, saved
with the attempt) while its read plus write covers that prefix again: real
2.1.293 and 2.1.295 sessions never re-read the last user message of the
preceding request. Reading no more than was cached before that request is
not a hit; an attempt without `priorReadTokens` and Codex keep the
whole-prefix rule. A completed request without a measured hit still supplies timing and continues
warming; call it `native-cache-refreshed`, never a hit. Codex measures the prior
prefix against the whole inputTokens count, not only its cached subset.
Keep plugin origin, final idle/draft/lifecycle fences, no replay after an
uncertain submission, read-only status and explicit bounded authorization. The
Claude warming window defaults to one hour; users can choose
`ttl=5m` or `ttl=1h` in the confirmed native command. Confirmation synchronizes
the current process's real CLAUDE_CODE_PROMPT_CACHE_TTL through the official Mod
environment API, never global files or the separate subagent TTL variable.
Lock timer dispatch, respect forced/managed constraints, pause the old policy on
change, check exact idle/context immediately before writing and verify readback
before enabling. Report partial application without rollback or replay; off
retains the native TTL choice. Label an assumed window `configured-window`, not
verified provider retention. Changes retire prior local evidence. By user decision (2026-10-15), an explicit
`on` never requires another ordinary user message. If enrollment has no usable
recent request (including an expired cache or a changed TTL), it authorizes its
own initial request as soon as the control command finishes and the native
conversation is idle. Keep this `kind: prime` in the same durable one-use
claim/check/receipt path, with a two-minute enable-time dispatch deadline bounded
by the policy end. Its unknown model/effort/sample and prefix stay null/zero;
never fabricate usage. Capture the current independent native configuration
fingerprint before arming the timer. Its actual successful completion and usage
seed the next interval; `native-cache-primed` is not a cache-hit claim. The prime
counts toward rounds, duration and actual output. A fresh existing request can
still schedule normally. Never use this path to catch up missed refreshes,
retry uncertain delivery or auto-resume after restart. A native configuration
invalidation immediately suspends the Claude client and disables its broker
policy, even during the first request; later accounting cannot re-enable it.
Token reservations limit admission, not native output; count recovery requests even after a policy
stops. A native accepted prompt has no atomic dequeue API; preserve that limit.
Native 2.1.286 suppresses a plugin's own prompt hook and frames its text before
turn.start. Require the existing one-use dispatch plus exact original/native
envelope, unchanged epoch/context and deadline; never treat matching text alone
as authority. Fence stale awaited callbacks before replacing turn state. Native
SDK catalogs/results can precede registration/completion-hook settlement; wait
for actual loaded-code and broker evidence without repeating model input.
TTL persistence is a separate confirmed plugin-store preference: session-only
(the unset default), remember-last or fixed-default 1h/5m. Only native
session.start restores an explicitly saved preference, with context/idle and
native-policy guards; command/status lazy binding and /clear never restore it.
Restoration never enrolls warming or starts inference. Remember tracks only
confirmed Claudex TTL choices, not external environment edits; fixed defaults
survive temporary selections. Shared-store changes affect future loaded primary
sessions, not other running sessions. Expose restore failures and partial writes,
never retry automatically or change a managed/subagent setting. Global native
settings remain untouched; the plugin's own preference store is persistent.
The Mod Cache settings tab uses the same bounded native preview/confirm path as
the commands. Selection/render/status never write configuration. Current-TTL
changes (`warm ttl 1h|5m`) are settings-only, stop local warming and never enable
model work; remember updates and fixed defaults retain their existing semantics.
Keep displayed native state, saved preference and edited form distinct. Preserve
form/confirmation on language switches, consume confirms once, and fence stale
panel contexts. Always show the complete preview, including effects and expiry.
Discard revokes the native confirmation; no UI-only permission or second ledger.
No startup/inspection path enables warming, starts another owner, changes the
model/effort or resumes expired work. See docs/cache-warming.md for operation and
native activation limits. The older developer probe remains separate evidence.

Codex Desktop warming is a separate experimental best-effort opt-in through the
CLI or a separately trusted UserPromptSubmit command hook. Only loaded persistent
primary threads on native 0.160.0 or later qualify (0.160.0 is the first reviewed
schema; a later runtime is accepted by the exact settings, metadata and usage
validation, never by its number alone); reject forks, subagents and active goals.
This does not expand the synchronization allowlist. Dispatch once through the
same native owner without navigation, new owners, API keys or model/effort
overrides. Composer draft visibility and per-turn no-tools enforcement are
unavailable: prompts are advisory, tool observations stop future warming but
cannot undo already executed tools. Budgets are not hard native caps; native
outputTokens already includes reasoning. Defaults are refreshMinutes=25
(integer 1..25), maxMinutes=60, maxRefreshes=3, maxReadTokens=null and
maxOutputTokens=256. The 30-minute configured-window is a local evidence bound,
not native TTL configuration or retention proof; measure from native turn start
and refuse expired long-turn evidence. Model/effort observations are configured
metadata, not independent response-model proof. A baseline counter is not a
sample: require fresh exact native request usage and completion. For an own prime observed
from exact start and matched returned turn ID, the first native last-request
usage is directly accounted and its cumulative total becomes the baseline;
never fabricate previous totals. Subsequent samples keep exact cumulative/last
agreement. Preserve native
settings-snapshot semantics: idle resume fields are not an already-observed
prompt baseline. Validate the independent permission/provider/plugin hash from
resume, then bind the first native snapshot to confirmed model/cwd and any known
effort. Native default instructions may resolve on the initial warm turn. The
independently validated resume security/model/directory/known-effort baseline
permits that first dispatch without a prompt-settings snapshot or human turn. Codex 0.162 reports settings only when they
change (observed: none on two unchanged turns, one on an effort change before
its turn). A model turn (including the own prime) observed from its start, with native
usage and no snapshot, therefore makes the rejoin response the baseline, and the next
snapshot is a change that revokes warming. The enrollment turn and turns
without usage never establish this. Identical subsequent snapshots are not changes;
later full-fingerprint changes still revoke warming. Keep instruction text out
of diagnostics and retained state by hashing it. Preserve native
second-precision starts and equal-time distinct socket deltas; exact returned
turn ID plus service-owned accounting supplies attribution, never timestamp
alone. Candidates become verified only after all warm samples and exact own
successful completion. Use the isolated codex-cache-warm.json ledger; no public
Codex observe/claim RPC, worker controls, uncertain replay, restart auto-resume
or catch-up bursts. Claude Mod Cache settings remain Claude-only. Source tests and native observer evidence are not proof of
real warming inference or TTL extension.
The Codex `/claudex:warm on|off|status` text command runs in
`bin/claudex-codex-warm-hook.mjs`, never the notification-only sync hook.
Setup installs its own UserPromptSubmit group and native trust remains a human
review; report `warmCommand.ready` independently of sync readiness. No model
prompt skill or custom slash menu is registered. By user decision, on directly
enables and accepts the documented best-effort limits: keep prepare/confirm
internal, recheck the exact native command context before activation, and never
replay an uncertain enable request. Legacy explicit confirmations remain
compatible; advanced CLI controls keep their own confirmation workflow.
Verify primary metadata, hook/native transcript-path equality and exact active
turn without reading arbitrary transcript paths; subagent hooks can report the
parent session ID. Never relax these guards to pass an untested hook lifecycle.
The hook's `--root` is the synchronization root for stop and native-owner checks;
send every broker RPC to its `collaboration` child exactly once. Keep failure
diagnostics action-specific and retain the failing operation and error chain.
Recognized commands return blocking output on success or failure, with a
25-second handler deadline before the 30-second native timeout. Native startup
failure or untrusted/disabled hooks can still skip interception; document that
limit. Ordinary input is a no-op. CLI controls remain unchanged; Codex TTL is not
configurable. Keep the manual `codex-command.mjs` probe outside
automated tests; it submits literal native input, never the wrapped app-origin
wake payload, and stops on uncertainty or model activity. Composer keystrokes,
autocomplete and rendered pixels remain unverified; do not promote native
backend/output evidence into visual UI or cache-retention proof.
A control-only enrollment turn is not usage evidence. After its idle completion,
an enabled prime schedules itself without an ordinary message or settings
snapshot; owner, identity, permission and final dispatch proofs stay mandatory.

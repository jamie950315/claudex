# Opt-in native cache warming

Claudex 1.2.6 and Claude Mod 0.8.5 provide bounded, per-conversation cache warming.
It is **off by default**. It does not enroll all conversations, start a second
owner, change the model or effort, extract credentials, or use another API key.
Claude uses a loaded Code Mod session. Codex Desktop has a separate
[experimental best-effort adapter](#codex-desktop-experimental-best-effort),
enabled only after accepting its weaker controls. Claude acceptance does not
establish Codex behavior.

Claude warming is a real, visible plugin-origin conversation turn requesting only `OK`.
It consumes native plan usage and remains in the conversation. It is not a
zero-output request or a free cache read. The broker owns authorization,
deadlines, token accounting and durable one-use dispatch intents; the Mod
observes and submits only into its own existing native session.

## Enable one Claude conversation

Use the intended existing conversation with a freshly loaded 0.8.5 companion and
a 1.2.6 broker. Older loaded sessions can retain the previous Mod until a normal
new session or native reload; an installed manifest alone is not loaded-code
acceptance. Do not restart active work merely to activate warming.

```text
/claudex warm status
/claudex warm on ttl=1h maxMinutes=60 maxRefreshes=3 maxReadTokens=250000 maxOutputTokens=256
```

Without a saved preference, the native main-cache TTL and warming window default
to `1h` when `ttl` is omitted. A saved remember/fixed-default preference instead
supplies the omitted TTL. Use
`/claudex warm on ttl=5m` to select five minutes, or `ttl=1h` to switch back.
After confirmation, Claudex sets the real `CLAUDE_CODE_PROMPT_CACHE_TTL` through
the official Mod environment API in the current Claude Code process (and future
children inheriting that environment). This affects subsequent ordinary main
requests too, not just the warming timer. It does not rewrite global settings,
change other running Claude processes or change the separate subagent TTL
variable. Without an explicit persistent preference, the change is session-only.
One-hour cache writes may cost more than
five-minute writes under the account's billing mode.

Changing TTL requires an idle native turn. Claudex locks the timer, pauses the
old policy when changing configuration, applies the native setting and verifies
readback before enabling the matching policy. A changed TTL retires old samples
and waits for fresh response evidence. Forced-five-minute and managed-policy
constraints are respected; conflicting choices fail explicitly. If application
or readback fails, local warming stops and reports that the native TTL may have
changed; there is no silent rollback or retry. Status reports native configuration
separately from the broker policy so partial outcomes remain visible.

`on` only prepares a confirmation. Review the returned exact session, directory,
bounds, TTL source/margin, observed cached-prefix size, effects and expiration,
then run the exact `confirm` command it prints.
The confirmation expires after two minutes and is bound to that session's
current lifecycle. The broker deduplicates its request ID so a repeated receipt
does not reset a budget. Uncertain submission is never automatically retried.

The four numeric limits shown are also the defaults. `maxMinutes` is a fixed enrollment
lifetime, not an inactivity counter that can extend forever. `maxRefreshes`
counts reserved attempts, including attempts refused later. The token limits
govern admission and stop future warming after observed use. They are **not
provider-enforced per-request caps**: native output or recovery can exceed a
reservation. Each reservation includes the preceding cached prefix plus 256
read tokens and 128 output tokens; final native usage replaces that estimate.

An ordinary completed native request must supply usable usage evidence before
warming can be scheduled. Enabling does not send an immediate model request or
reconstruct old history. Missing evidence remains an explicit waiting state.

Stop the current conversation with:

```text
/claudex warm off
```

Turning warming off revokes refreshes but leaves the selected native TTL in place.

Inspect all policies, or revoke one exact target from the local CLI:

```sh
claudex collaboration cache-warm status
claudex collaboration cache-warm off --session NATIVE_SESSION_ID --cwd /exact/project/path
```

For Claude, the CLI does not enable a conversation remotely. Select it in the native client
and confirm there. Status is read-only and does not start models or renew a
cache. Native command output is structured technical JSON; the pane provides
equivalent controls for TTL and startup preferences.

## Claude native Cache settings tab

Open `/claudex`, then **Cache settings**. The tab shows the current native TTL,
saved startup mode/TTL and warming status separately. Choose 1h or 5m and a
startup mode in the form; selecting values does not apply them.
These controls affect only the pane's own Claude session, not Codex.

- **Preview current TTL change** changes this process's TTL without enabling
  warming. Remember mode also saves the choice; a fixed startup default remains
  unchanged. The equivalent command is `/claudex warm ttl 1h` (or `5m`).
- **Preview startup preference** saves the selected startup behavior. Remember
  and fixed-default also apply the selected TTL now. Session-only stops startup
  restoration without reverting the current native TTL.
- Review the complete, exact-session preview and press **Confirm cache change**.
  **Discard preview** revokes that confirmation. Edits and confirmations survive
  language changes, but not a native session/context change.
- **Refresh status** is read-only. **Stop cache warming** revokes warming while
  preserving the native TTL and saved startup choice.

Settings-only confirmations stop local warming. They never authorize inference;
enable warming separately with its bounded `warm on` confirmation. The pane
shares the command implementation and its policy/race/readback protections, not
a second settings writer. Technical preview values and native diagnostics remain
verbatim; controls are localized in all nine supported languages.

## TTL preferences across restarts

Choose one mode in a loaded primary session, then run the exact confirmation
command printed by the preview:

```text
/claudex warm preference remember ttl=1h
/claudex warm preference default ttl=5m
/claudex warm preference session
```

- `remember ttl=1h|5m` applies and saves that TTL now. Later confirmed Claudex
  TTL choices update it; new native processes restore the latest saved choice.
- `default ttl=1h|5m` applies and saves a fixed startup TTL. A later explicit
  `warm on ttl=...` may override the current process without replacing the
  saved default. An omitted TTL uses the saved default again.
- `session` disables restoration. It does not undo the current process's TTL;
  a new process uses its ordinary native configuration. This is the initial mode
  for existing and new installations until a preference is explicitly confirmed.

Preference confirmation stops local warming and never enables it. Enable warming
separately with `warm on` and its own confirmation. Neither restart nor preference
restoration authorizes a model request. Status/preview/inspection and `/clear`
do not apply or save settings; `/clear` keeps the process's current TTL.

Preferences use the native plugin's persistent key-value store, shared by future
primary sessions using that store. They do not edit Claude global configuration
files or broadcast changes to other running sessions. Remember tracks Claudex
confirmations, not manual changes outside Claudex. Concurrent explicit writes use
the native store's last completed write. Remembered TTL updates use a separate,
revision-bound record so a stale session cannot overwrite a newer mode choice.
A changed preview or mismatched readback
fails rather than silently enabling warming. Forced-five-minute and managed
policies still win. Startup failure leaves warming off and is exposed by
`/claudex warm status` in `local.ttlRestore`, alongside the saved `ttlPreference`
and separately read `nativeCache`. No automatic retry or rollback is performed.

## Codex Desktop experimental best-effort

Codex warming is separately opt-in and currently controlled through the CLI,
not the Claude Mod pane. It requires native runtime `0.160.0` and an already-loaded,
persistent primary Desktop conversation. Forks, subagents, unloaded threads and
threads with an active goal are refused (`active-goal-unsupported`). The adapter
uses the existing native owner; it does not start a second owner, fork, invoke
`codex exec resume`, navigate the app, extract credentials or use an API key.
This capability gate does not change the synchronization runtime allowlist.

Prepare a bounded preview for the exact native thread UUID and directory:

```sh
claudex collaboration cache-warm on --provider codex --session NATIVE_THREAD_UUID --cwd /exact/project/path --accept-best-effort
```

Review the returned identity, limits, effects and expiration, then run the exact
confirmation it prints:

```sh
claudex collaboration cache-warm confirm TOKEN --provider codex --accept-best-effort
claudex collaboration cache-warm status --provider codex
claudex collaboration cache-warm off --provider codex --session NATIVE_THREAD_UUID --cwd /exact/project/path
```

Both preview and confirmation require `--accept-best-effort`. Neither a preview
nor status authorizes inference. The controller-only confirmation is bounded
and one-use; workers cannot enable or control this warmer.

Optional CLI bounds are `--refresh-minutes 25`, `--max-minutes 60`,
`--max-refreshes 3`, `--max-read-tokens 250000` and `--max-output-tokens 256`.
These are the defaults. `refreshMinutes` accepts integers from 1 through 25.
The 25-minute default applies only to new previews/enrollments, not saved policies.
The other bounds have the same admission semantics as Claude warming. Native
`outputTokens` already includes reasoning tokens and is not added twice.
The output budget is an admission reservation and observed stop threshold,
**not a hard native output cap**.

### Accepted limitations

Stopping means stopping **future automatic refreshes**, not interrupting normal
user work. Ordinary native activity cancels an old timer; a fresh completed
request can establish a new deadline while enrollment remains enabled. If busy
state is discovered at the final dispatch boundary, that attempt is refused and
warming is disabled rather than inserted into the active turn. Tool activity
stops warming only when it belongs to the exact warm turn, not during ordinary
coding work. Budget exhaustion also stops future dispatches. An uncertain native
receipt means a request might already have been accepted; it is never resent.
An already-running turn is not killed and completed tool actions are not undone.

- There is no reliable composer-draft read and no per-warm-turn no-tools control.
  The instruction requests only `OK`, but the turn retains the conversation's
  native permissions and tools. Observing tool activity stops future warming;
  it cannot undo tools already executed or guarantee no side effects.
- The same-owner dispatch can refuse a busy conversation. Busy, expired or
  ambiguous opportunities do not produce catch-up bursts, uncertain retries or
  interruption of the user's work. There is no atomic draft/idle/dispatch
  guarantee.
- No Codex native TTL configuration is written. The 30-minute
  `configured-window` is an assumed local evidence deadline, not proof of
  server TTL or a 30-minute retention promise. Refreshes are due at the observed
  turn start plus `refreshMinutes`. A turn already lasting 30 minutes cannot
  supply fresh evidence for this window.
  Different models and native account routes may retain caches for less time;
  choose the interval accordingly. A miss stops subsequent warming rather than
  certifying the assumed window.
- The initial cumulative counter is only a baseline. Scheduling waits for fresh
  exact native usage deltas and successful native completion; it does not infer
  usage from an old transcript, status timestamp or duplicate notification.
Model/effort metadata describes configured values, not independently verified
execution-model evidence.

The private service matches the exact returned native turn ID before attributing
warm usage. Native turn starts have second precision, while multiple distinct
usage deltas in one socket batch can share a completion timestamp. Accounting
preserves these clocks without inventing timestamps or upstream response IDs;
increasing observations and exact counter deltas distinguish samples. It rejects
counter inconsistencies, timestamp regressions and changed duplicate samples.
Per-request hits remain candidates until the entire successfully completed warm
turn's buffered usage has been accounted. A submitted turn or one partial hit
does not certify warming.

Codex uses its own bounded `codex-cache-warm.json` journal, isolated from Claude's
`cache-warm.json`. App-stop, disconnect, broker shutdown and restart revoke native
authorization; restart never automatically resumes warming. Only the private
native service supplies observations and consumes claims: there is no external
Codex usage/claim RPC. Interrupted dispatch remains uncertain, without replay.

Source/synthetic tests and native observer checks are separate from real
warm-turn inference and controlled retention experiments. Neither proves TTL
extension. The Claude native acceptance records below do not certify Codex.

## Claude scheduling and evidence

The Mod records content-free metadata from each main request: identity, start
and completion times, model, effort, stop reason and input/cache/output counts.
It never saves prompts, replies, tool arguments or reasoning in the warming
ledger. Every native recovery response is accounted separately and repeated
observations of the same response do not renew the deadline or count twice.

The confirmed warming window matches the native main-cache setting: one hour or
five minutes. If native configuration later becomes shorter, the adapter never
extends its evidence beyond that shorter setting; configuration changes revoke
the old timer. Without explicit native evidence, the pure resolver labels a window
`configured-window`, not verified provider retention. A five-minute window
schedules 60 seconds early; a one-hour window schedules five minutes early.
These are local
estimates from native activity, not a server cache probe or retention guarantee.

Normal activity cancels the old timer. A new usable response can establish a new
deadline. Warming is withheld while busy, while an unsent draft exists, after
configuration/context changes, on expired evidence, or after a missed wakeup.
There is no sleep catch-up burst, fork fallback or history sweep. A pending
draft is never edited; after skipping that opportunity, normal new activity can
establish a fresh schedule.

A dispatch requires a current enabled policy, exact instance and activity epoch,
fresh cache evidence, remaining budget and an unexpired deadline. The broker
durably consumes its dispatch authorization before the Mod submits once through
the official `prompt.submit` API, retaining plugin origin rather than pretending
to be a human. Known warm-turn tool calls are refused without changing the
model's tool definitions. A queued/submitted receipt is not a cache hit.
Only fresh native usage covering the preceding cached prefix verifies warming.
Cache miss, output-limit recovery, model/effort/TTL changes, uncertainty or an
actual budget overrun stop future warming rather than silently retrying.

App-stop, broker shutdown, session end and lifecycle changes revoke authorization.
The broker does not restore stale native observations after a restart; interrupted
dispatches remain uncertain. The private journal is bounded to 64 policies and
2,048 attempts/confirmation receipts and fails explicitly at capacity; it never
prunes native history or silently deletes old intent records.

## Claude native limitations and acceptance

Idle/draft and lifecycle checks fence observed activity before submission.
Native 2.1.286 suppresses the originating plugin's own prompt hook as re-entry
and frames its message before `turn.start`. Attribution therefore requires an
existing one-use dispatch plus exact original text or the verified idle-plugin
envelope, with unchanged context/epoch and an unexpired deadline. The envelope
alone is never authority; observed competing prompts revoke the pending intent.
An awaited callback superseded by a newer turn cannot overwrite that turn.
TTL synchronization rechecks context/idle state immediately before its native
environment write. The host does not expose an atomic idle-check-and-write
transaction; activity after that final check can still race with the host write.
Post-write checks stop local warming and report the possibly applied setting.
Once the native host accepts a prompt, no public dequeue API
exists. A human action racing **after native acceptance** cannot be atomically
excluded by this adapter. Ambiguous turn attribution stays uncertain, with no
automatic resubmission or interruption of the user's work.

Source, synthetic state-machine tests, Unix RPC and strict staged validation are
separate from actual native acceptance. An authorized isolated 0.8.1 native
acceptance verified on/confirm, one timer-triggered plugin-origin prompt, a
full-prefix cache hit, broker verification, the refresh limit and off under one
session identity. See [the validation record](claude-mod-validation.md).
Separate authorized 0.8.2 acceptance switched 5m to 1h and back in one native
process and verified the actual per-request cache-creation TTL buckets. It did
not wait an hour or prove one-hour retention duration.
The earlier isolated Sonnet 5.5/medium
main-conversation experiment established cache reuse after the original TTL; it
did not exercise this new Mod timer and admission path. The one-token diagnostic
established that an artificially low output cap can trigger multiple native
continuations, so this feature never sets the native cap to one.

The native Mod test kit may be rollout-disabled. A documented process-only Mod
opt-in may be used only with explicit user authorization; it is not evidence of
default availability and must not change account policy or global preferences.
Do not describe static validation or an app
build as proof that a loaded session can dispatch and complete a warm turn.
Enable real conversations only after the selected runtime's normal loaded-Mod
path passes an authorized, bounded acceptance check.

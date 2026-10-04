# Native cache-retention experiment

This development-only harness measures either a normal same-session main turn
(`--strategy main`) or native `$.model.fork` (`--strategy fork`, the default)
against a no-refresh control. It is not a shipping Claudex feature, an installed
plugin, or an unattended cache-warming service. It never uses an extracted OAuth
token or another API route. It requires explicit authorization before `--run`.

The separate `--strategy one-token` diagnostic tests native output-limit recovery
with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1`. It submits at most two user messages to one
new, nonpersistent, plugin-free session, without waiting through another TTL.
Truncated/error outcomes are observations, not a reason for harness retries.
Native continuation requests can exceed both the user-message count and the
SDK's `maxTurns: 1`; inspect the response-level evidence rather than assuming a
one-token cap also means one request. It does not claim TTL-extension acceptance.

## Protocol

- Use the supplied, unmodified Claude Code executable and its normal native sign-in.
- Fix the model to `claude-sonnet-5-5` and requested effort to `medium`.
- Create two new, nonpersistent sessions in separate private directories, with
  distinct system prefixes, synthetic input, no model tools or MCP servers, and
  no user/project settings. Existing native sessions and installed plugins are
  not modified. No native application restart is needed.
- Explicitly request 5-minute main and fork TTLs for this experiment only.
  Check the actual main receipt's cache-write counts and its five-minute bucket
  before proceeding.
- Seed the control and warm arms. In main mode, 240 seconds after its first
  request starts, the runner sends one real user turn through the same live SDK
  query. This adds a real exchange to that test conversation. No plugin or Mod
  capability is needed: the observation is host dispatch timing/configuration
  plus native SDK responses, not a claim of independently observed effective
  reasoning effort. Both arms must retain one native session ID and report only
  Sonnet 5.5 as their actual main-response model.
- In fork mode only, the warm arm runs one native Mod timer after 240 seconds and
  calls `$.model.fork` once. Compare the main API-message snapshot before and
  after the fork in memory; retain only equality, length, timestamps and token
  counts, never the content.
- After 360 seconds, send one normal final measurement turn to each session.
  Compare cache reuse with the control, then close both owned processes.

There are at most five explicit main requests (main mode), or four explicit main
requests and one explicit fork (fork mode), with no harness-level retries.
Native auxiliary requests can still appear in native
accounting and must be reported separately from Sonnet main-response evidence.
The harness requests a 128-token output limit through the native environment and
a $0.50 estimated query budget per session. **The installed Mod fork API has no
independent output/budget cap**: do not describe those settings as a verified
hard bound for fork spend. The finite invocation count is the experiment's
primary bound. Native helpers are outside that explicit invocation count.
The one-token diagnostic uses the same per-session estimated budget and timeout,
but a cap of 1 rather than 128. Its two-submission limit does not disable or
override native output-limit recovery. Native helpers can use different models
and are separately visible in the cumulative native model usage.

`--run` uses subscription quota (or whatever normal native authentication selects).
Native dollar fields are estimates, not a billing statement. This is not a
zero-output or free cache refresh. No inference is part of `npm test`.

## Running

First run the offline checks:

```sh
node --test dev/cache-warm-probe/probe.test.mjs
"$CLAUDE_BINARY" plugin validate dev/cache-warm-probe/plugin --strict --json
"$CLAUDE_BINARY" plugin test dev/cache-warm-probe/plugin
```

The native plugin checks apply to fork mode. A native rollout refusal is not
overridden, and does not prevent main mode, which does not use the Mod system.

Create a new private output directory for each invocation. The runner refuses
an existing arm directory, so uncertain calls cannot be replayed by restarting it.
`--root` must point outside the repository. With no `--run`, the harness loads
and checks the control plugin (fork mode), or only initializes the control SDK
session (main mode), then closes it without sending a model prompt:

```sh
node dev/cache-warm-probe/run.mjs --root "$NEW_PRIVATE_DIRECTORY" --claude "$CLAUDE_BINARY"
```

For the main-conversation experiment, after explicit authorization:

```sh
node dev/cache-warm-probe/run.mjs --run --strategy main --root "$NEW_PRIVATE_DIRECTORY" --claude "$CLAUDE_BINARY"
```

To run the separately authorized one-token diagnostic, use a new private directory
and replace `--strategy main` with `--strategy one-token`.

Only after authorization, use another new private directory and add `--run`.
Allow approximately seven minutes. The default load-only path does not validate
server cache behavior. No feature-rollout override is applied. A missing Mod
load report stops fork mode before any model prompt. Main mode explicitly loads
no plugin; it is not an automatic fallback after an uncertain fork.

## Evidence and limits

### Codex Desktop guarded prototype

`node codex.mjs --session NATIVE_THREAD_UUID` probes the existing Desktop owner
and reads thread metadata without history. Optional `--observe-ms 45000` joins
only an already-loaded active thread to observe its existing token events. It
never starts a thread/turn, forks, writes settings or extracts credentials.
Run its offline tests with `node --test dev/cache-warm-probe/codex.test.mjs` from
the repository root. Run the probe with the full script path from that root.

This probe never dispatches automatically. Reviewed Desktop
26.930.31730 (12947), CLI 0.160.0: owner discovery exposes untrusted-app-input
support but no composer draft state; the turn request has no per-turn no-tools
field. The owner can refuse busy turns, but that does not prove draft safety.
Neither an OK-only instruction nor a budget reservation is a native tool/output
cap. The separately accepted shipping experimental best-effort adapter uses
explicit CLI preview/confirmation and its own bounded journal; it does not
silently weaken this probe. See
[the Codex warming guide](../../docs/cache-warming.md#codex-desktop-experimental-best-effort)
for same-owner scope, 25-minute default refresh, the local 30-minute evidence
window, and the missing draft/no-tools controls. Claude native TTL and Mod pane
controls remain separate.

Read-only native observation confirmed cumulative/last token events, including
duplicate notifications. The counter requires an observed baseline and exact
six-field delta agreement, never invents missing fields, and stops on reset or
inconsistent data. Its sample ID is local accounting identity, not an upstream
response ID or cache-retention proof. The observed public stream did not emit
`rawResponse/completed`; this does not prove every runtime suppresses it.
Those earlier read-only observations did not perform cache-refresh inference or
establish retention. See the version-scoped validation record for subsequent
manual inference experiments; a runnable harness alone is not acceptance proof.

`codex-retention.mjs` is the separately authorized native-inference harness.
`--prepare --root NEW_PRIVATE_ROOT` creates two isolated persistent test threads
without inference. Load those exact test threads normally in Desktop, then
`--run --root SAME_ROOT` uses the shipping warmer for one refresh at 25 minutes
and compares both arms at about 31 minutes. It allows six explicit measurements
plus one automatic warm turn, retains only metadata/token counts/OK predicates,
and never uses an API key. It preserves failed candidates without replay.
Only the test threads' settings are normalized before their first input; native
creation responses and loaded Desktop defaults can differ. The live observation
must settle after each warm-arm seed before the harness sends another prompt.
An optional `--reuse-from` preparation accepts only completed seed evidence from
a stopped candidate with zero warm attempts and a still-valid control window;
it creates a new report and new request identities, not a retry of old input.
Different loaded settings or an expired control window refuse reuse.

Static evidence: `ChatGPT.app/Contents/Resources/app.asar` SHA-256
`87a934de9a00a04d2e534693db87756321ca4f3413f6caa55d3a0d32a5543836`.
In `.vite/build/bootstrap-D3_zvIvQ.js`, UTF-8 asset offsets 1752773 (owner
discovery), 1064248 (start-turn checks), and 1055477 (request field whitelist)
establish these limits. This is build-scoped evidence, not a vendor API promise.

Official references:
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/hooks
- https://developers.openai.com/api/docs/guides/prompt-caching

### Native preference persistence without inference

`preferences.mjs --run --root "$NEW_PRIVATE_DIRECTORY" --claude "$CLAUDE_BINARY"`
uses four sequential native processes and one isolated native configuration
directory to check fixed-default restoration, remember-last updates and return
to session-only behavior. It loads the shipping Mod and a real private broker,
but submits only verified local `/claudex warm` commands. Every result must report
zero model turns and no warming attempt may occur. No credentials are copied;
the existing user configuration and installed plugin store are untouched.
The same explicitly authorized process-only function-hooks option is required.

Native local commands can return synthetic assistant envelopes; those are not
model responses. The harness still refuses non-synthetic assistant activity and
requires zero-turn results. Loaded-code readiness uses the exact newly observed
native context, not aggregate observer counts: a closed process's diagnostic
observer may remain until its TTL expires. Failed test roots are preserved and
never resumed or replayed.

### Actual native Mod acceptance

`native.mjs` runs the shipping companion and real Unix broker in a new private
root. It verifies native `warm status`, `on`, and `confirm` as zero-model local
commands, then allows one seed turn and one timer-triggered warm turn. It requires
an explicit, user-authorized process-only `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`;
it never writes that setting globally. Use `--run` only after inference approval.

`native.mjs --run --ttl-sync --root "$NEW_PRIVATE_DIRECTORY" --claude "$CLAUDE_BINARY"`
instead verifies real native TTL synchronization without waiting for a timer.
In one isolated process it confirms 1h, sends one ordinary fixture request,
checks the one-hour cache-creation bucket, then confirms 5m and checks the
five-minute bucket with one more request. Local commands must use zero model
turns, off must preserve the selected TTL, and no automatic attempt may occur.
This is exactly two explicit model requests, not a one-hour retention experiment.
It uses the same separately authorized process-only function-hooks option.

The native initialization catalog can precede dynamic command registration, so
the harness waits for the staged Mod's actual loaded-version observer. It also
waits for completion-hook settlement after the SDK result: that result can arrive
while the broker still reports busy. Neither wait sends another model prompt.
The harness preserves failed candidates and does not replay their dispatches.
Its private report and debug log are never committed. Keep the broker outcome
separate from a model reply: successful inference alone is not verified warming.

`report.json` contains main receipts, actual main-response model labels, the
requested effort, cache token usage, one-session identity counts, an offline
assessment and owned-process exit evidence. Fork mode also records native
request effort, the fork receipt and before/after main equality. Its `probe.json`
contains content-free Mod observations; main mode records host dispatch/native
response observations in the report instead. Do not commit runtime output or
native generated declarations. Only fork mode copies and loads the source plugin.

One-token mode adds `tokenLimitEvidence`: unique native response counts, the
submitted turn each response belongs to, stop reasons, token totals, transport
retry notices, and typed native errors. It deduplicates streaming/final frames
by response ID in memory and saves neither those IDs nor generated text.
An empty transport-retry list does not rule out output-limit continuation:
several `max_tokens` responses can belong to one user submission. Result-envelope
`subtype: success` also does not establish success when `is_error` is true.

A positive experiment needs full-prefix reuse during the selected refresh and
reuse of the seed prefix in the warm arm after the original TTL, while the control
rebuilds it. Fork mode additionally requires unchanged main messages. Main mode
requires the same native session and stable model/effort configuration; it
deliberately adds one exchange. A partial prefix or a control that stays warm is
inconclusive, not a success. One isolated CLI experiment does not certify
Desktop painting, normal 1-hour subscription caches, compaction/model changes,
other native versions or providers, or long-running unattended behavior.

The official Mod declarations are the API contract for the selected runtime;
they describe fork as replaying the last main request's prefix without caching
its own tail. They do not expose a zero-output fork option. See:

- https://code.claude.com/docs/en/plugins/mods/api
- https://code.claude.com/docs/en/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

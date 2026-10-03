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

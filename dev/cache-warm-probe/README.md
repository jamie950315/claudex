# Native cache-retention experiment

This development-only harness measures Claude Code's native `$.model.fork`
against a no-refresh control. It is not a shipping Claudex feature, an installed
plugin, or an unattended cache-warming service. It never uses an extracted OAuth
token or another API route. It requires explicit authorization before `--run`.

## Protocol

- Use the supplied, unmodified Claude Code executable and its normal native sign-in.
- Fix the model to `claude-sonnet-5-5` and requested effort to `medium`.
- Create two new, nonpersistent sessions in separate private directories, with
  distinct system prefixes, synthetic input, no model tools or MCP servers, and
  no user/project settings. Existing native sessions and installed plugins are
  not modified. No native application restart is needed.
- Explicitly request 5-minute main and fork TTLs for this experiment only.
  Check the actual main receipt's cache-write counts, and native request
  model/effort, before proceeding.
- Seed the control and warm arms. The warm arm runs one native Mod timer, 240
  seconds after its first main request starts. It calls `$.model.fork` once.
- Compare the main API-message snapshot before and after the fork in memory;
  retain only equality, length, timestamps and token counts, never the content.
- After 360 seconds, send one normal final measurement turn to each session.
  Compare cache reuse with the control, then close both owned processes.

There are at most four explicit main requests and one explicit fork, with no
harness-level retries. Native auxiliary requests can still appear in native
accounting and must be reported separately from Sonnet main-response evidence.
The harness requests a 128-token output limit through the native environment and
a $0.50 estimated query budget per session. **The installed Mod fork API has no
independent output/budget cap**: do not describe those settings as a verified
hard bound for fork spend. The finite invocation count is the experiment's
primary bound. Native helpers are outside that explicit invocation count.

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

Create a new private output directory for each invocation. The runner refuses
an existing arm directory, so uncertain calls cannot be replayed by restarting it.
`--root` must point outside the repository. With no `--run`, the harness loads
and checks the control plugin and closes it without sending a model prompt:

```sh
node dev/cache-warm-probe/run.mjs --root "$NEW_PRIVATE_DIRECTORY" --claude "$CLAUDE_BINARY"
```

Only after authorization, use another new private directory and add `--run`.
Allow approximately seven minutes. The default load-only path does not validate
server cache behavior. No feature-rollout override is applied. A missing Mod
load report stops the harness before any model prompt.

## Evidence and limits

`report.json` contains main receipts, actual main-response model labels, native
request effort, cache token usage, the single fork receipt, before/after main
equality, and owned-process exit evidence. `probe.json` contains content-free
observations within each arm directory. Do not commit runtime output or native
generated declarations. The source plugin is copied privately before loading.

A positive experiment needs a cache-read hit in the fork, unchanged main
messages, and reuse of the seed prefix in the warm arm after the original TTL,
while the control rebuilds it. A partial prefix or a control that stays warm is
inconclusive, not a success. One isolated CLI experiment does not certify
Desktop painting, normal 1-hour subscription caches, compaction/model changes,
other native versions or providers, or long-running unattended behavior.

The official Mod declarations are the API contract for the selected runtime;
they describe fork as replaying the last main request's prefix without caching
its own tail. They do not expose a zero-output fork option. See:

- https://code.claude.com/docs/en/plugins/mods/api
- https://code.claude.com/docs/en/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

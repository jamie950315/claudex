# Opt-in native cache warming

Claudex 1.2.0 and Claude Mod 0.8.0 add bounded, per-conversation cache warming.
It is **off by default**. It does not enroll all conversations, start a second
owner, change the model or effort, extract credentials, or use another API key.
The first adapter is a loaded Claude Code Mod session. Codex is explicitly
unsupported; Claude acceptance does not establish Codex behavior.

This is a real, visible plugin-origin conversation turn requesting only `OK`.
It consumes native plan usage and remains in the conversation. It is not a
zero-output request or a free cache read. The broker owns authorization,
deadlines, token accounting and durable one-use dispatch intents; the Mod
observes and submits only into its own existing native session.

## Enable one conversation

Use the intended existing conversation with a freshly loaded 0.8.0 companion and
a 1.2.0 broker. Older loaded sessions can retain the previous Mod until a normal
new session or native reload; an installed manifest alone is not loaded-code
acceptance. Do not restart active work merely to activate warming.

```text
/claudex warm status
/claudex warm on maxMinutes=60 maxRefreshes=3 maxReadTokens=250000 maxOutputTokens=256
```

`on` only prepares a confirmation. Review the returned exact session, directory,
bounds, TTL source/margin, observed cached-prefix size, effects and expiration,
then run the exact `confirm` command it prints.
The confirmation expires after two minutes and is bound to that session's
current lifecycle. The broker deduplicates its request ID so a repeated receipt
does not reset a budget. Uncertain submission is never automatically retried.

The four shown values are also the defaults. `maxMinutes` is a fixed enrollment
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

Inspect all policies, or revoke one exact target from the local CLI:

```sh
claudex collaboration cache-warm status
claudex collaboration cache-warm off --session NATIVE_SESSION_ID --cwd /exact/project/path
```

The CLI does not enable a conversation remotely. Select it in the native client
and confirm there. Status is read-only and does not start models or renew a
cache. Native command output is structured technical JSON, not another pane.

## Scheduling and evidence

The Mod records content-free metadata from each main request: identity, start
and completion times, model, effort, stop reason and input/cache/output counts.
It never saves prompts, replies, tool arguments or reasoning in the warming
ledger. Every native recovery response is accounted separately and repeated
observations of the same response do not renew the deadline or count twice.

TTL comes from an explicit native main-cache environment/setting value when
available. Otherwise the adapter uses the conservative five-minute policy and
labels it `conservative-minimum`; it does not infer a one-hour entitlement from
subscription presence. A five-minute window schedules 60 seconds early; an
explicit one-hour window schedules five minutes early. These are local
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

## Native limitations and acceptance

Idle/draft checks and a native prompt-admission hook fence observed activity
before submission. Once the native host accepts a prompt, no public dequeue API
exists. A human action racing **after native acceptance** cannot be atomically
excluded by this adapter. Ambiguous turn attribution stays uncertain, with no
automatic resubmission or interruption of the user's work.

Source, synthetic state-machine tests, Unix RPC and strict staged validation are
separate from actual native acceptance. The earlier isolated Sonnet 5.5/medium
main-conversation experiment established cache reuse after the original TTL; it
did not exercise this new Mod timer and admission path. The one-token diagnostic
established that an artificially low output cap can trigger multiple native
continuations, so this feature never sets the native cap to one.

The native Mod test kit may be rollout-disabled. Do not change native feature or
policy gates to make a test pass, and do not describe static validation or an app
build as proof that a loaded session can dispatch and complete a warm turn.
Enable real conversations only after the selected runtime's normal loaded-Mod
path passes an authorized, bounded acceptance check.

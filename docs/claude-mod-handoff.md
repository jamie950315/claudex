# Claude Mod integration: deployment handoff

Current operational handoff: Claudex.app 1.2.34 and Mod 0.8.15. Version-scoped
observations below retain their original review dates. The companion is integrated;
do not reapply any historical downloaded patch. Read AGENTS.md, [the guide](claude-mod.md),
[acceptance gates](claude-mod-acceptance.md) and [validation](claude-mod-validation.md).

## Current state and next maintenance steps

- The graphical app owns bundled Mod installation, updates and checks through
  the official manager. Use [its lifecycle controls](app.md#claude-mod-lifecycle),
  not a separate manual install, for normal graphical deployments.
- The current work views include generation-bound reports/events, blockers,
  instruction adoption, declared artifacts, explicit result review and
  cooperative pause. Same-invocation follow-ups use worker check-in and eligible
  MCP response boundaries, not a forced native interruption.
- Keep bundled/installed integrity, fresh loaded-version observations, actual
  pane rendering and delivery/Stop ACK evidence separate. Actual Desktop 0.7.1
  panel evidence is recorded in validation; it does not manufacture a new wake ACK.
- Preserve both known plugin identities, language preferences, explicit disabled
  and wake settings, previous versions and app-owned journals. New installations
  keep wake defaults off, and the app never changes native routes automatically.
- Reuse applicable unchanged evidence and test changed inputs. Do not alter
  runtime allowlists, native trust, accounts or user work to make checks pass.

## Historical 0.3.1 deployment checkpoint

The following checkpoint records the earlier single-session rollout. Its versions,
test counts and machine status are historical, not the current installation.

Version 0.3.1 was installed with nativeWake=true, selfWake=true and broker
route=mod-self. After normal Claude restart, one Desktop-owned native session and
one eligible waiter automatically delivered a new authorized message to that same
session. Sonnet 5.5 returned the requested nonce and real Stop ACK in 4.253 seconds;
the actual Desktop displayed the peer message and reply while retaining its
original unsent draft. No second sender or SendMessage tool is needed for this
route. Source defaults remain false.

The full repository regression passed 1,325 cases with zero failures and 23
existing opt-in skips before the final narrow queued-hook exclusion; the final
backend delta is covered by affected mailbox/Mod regression. Final 0.3.1 strict validation and all 12 official native
kit cases passed in a fresh normal process; all 16 installed plugin assets match
the final stage. Earlier isolated processes reported rollout disabled, without
any override. Keep process-specific availability distinct from loaded Desktop
behavior; see validation for exact evidence boundaries.
Final verified service stop/start preserved mod-self, reconnected one waiter and
kept the same single Claude Code process. The successful nonce remained present
once, the earlier undelivered nonce remained absent, and no pending outbox receipt
remained. Both installed app signatures verified deeply; Claude app.asar stayed
unchanged. Collaboration/folder inspection is ready; existing synchronization
waits remain separate.

### Scope and evidence at that checkpoint

- /claudex Overview, Tasks, Chats, Compose, Inbox, task details and durable receipts.
- AbovePrompt context/rate-limit display composed with the native tree.
- Existing broker delegation, follow-up, cancellation, defaults and exact native
  chat lookup; user-authored writes retain preview/confirmation and bounded grants.
- Automatic delivery of already-authorized wake-enabled messages through the
  recipient's own Mod and verified native child inbox. It is not session.send
  to self or a prompt.submit fallback. No extra model session is started.
- Real Sonnet 5.5 nonce reply and Stop ACK from the installed single-session
  listener. Claim, socket submission, receive-once authorization, reply and ACK
  were inspected separately; the socket alone supplies no native delivery ACK.
- Actual native tools:[] policy probes verified explicit refuse and hold with
  zero model turns and no global settings edits. Hold retained the message until
  normal shutdown expired it. These probes used the production own-inbox helper.
- Historical cross-session busy/offline results remain recorded separately;
  they are not new certification of every own-inbox queue or policy scenario.
- Native manager installation/configuration, development-signed Claudex app with
  previous app backed up, normal authorized Claude restart and actual new pane.
  Traditional Chinese Claude app.asar and signature were preserved.

The loaded recipient alone is sufficient for mod-self; a closed/unloaded one
waits for normal native resume. The earlier mod route still requires another
loaded sender with SendMessage. Existing mod/renderer messages keep their route;
there is no implicit fallback or migration. A failed 0.3.0 submitted message
remains unacknowledged and was not replayed; the successful canary used a new
authorized message. Fault-injected receipt recovery remains synthetic evidence.
Unfinished-tool handoff and predecessor-archival lifecycle waits remain separate
synchronization guards, outside this feature's acceptance.

The own-inbox transport is macOS-only. It verifies parent PID/birth/UID and the
exact private socket, inherits native token authentication in memory without
logging or persistence, and honors native inbound policy. The observed user-line
wire format is version-tested, not a permanent public API guarantee. Durable
dispatch intent and receive-once markers enforce no replay, including after
lost responses or restart. Preserve submitted, receive authorization and Stop
ACK as distinct evidence.
Ordinary SessionStart/UserPromptSubmit/Stop hooks do not offer queued mod-self
messages, so a normal hook cannot bypass native hold/refuse. Actual Stop ACK
scanning remains enabled; queue-only and older message routes are unchanged.

Two actual integration failures were repaired: Darwin lsof legitimately lists
the listener and accepted connection at one socket pathname; and the private
RPC allowlist initially omitted mod_wake_receive. The latter failed a new real
Unix-RPC regression before repair; direct hub-dispatch tests had missed it.
Final safety review also reproduced the queued-message hook-policy bypass before
the route-specific exclusion fixed its regression. The backend-only repair leaves
the already validated native plugin assets unchanged.

Task execution, native SDK dependencies, synchronization allowlists, history/assets,
compaction, writer ownership, folder/archive adapters, hooks and MCP remain intact.
General Chat/Cowork customization and new-runtime synchronization acceptance are
not included. No public release or notarization is implied.

## Validate changed inputs

```sh
node --test test/mod-self-wake.test.mjs test/claude-mod-self-inbox.test.mjs test/mod-wake.test.mjs test/claude-mod-controller.test.mjs test/claude-mod-bridge.test.mjs
node bin/claudex-mod.mjs stage \
  --root /canonical/private/claudex-state \
  --output /canonical/new/claudex-mod-stage \
  --node /canonical/trusted/node --native-wake --self-wake
claude plugin validate /canonical/new/claudex-mod-stage/plugins/claudex --strict --json
claude plugin test /canonical/new/claudex-mod-stage/plugins/claudex
```

Use the actual intended runtime's compiler/test kit and a create-only stage.
The source plugin has blank machine defaults and no bundled helper. The documented
public API baseline is 2.1.287, not an automatic rejection of tested 2.1.286.
The native kit cases stub external operations; they are not rendering or
model-work evidence. Reuse unchanged valid tests rather than rerunning a full
suite solely for installation or handoff.

Keep $ helpers at module top level and treat $.plugin.root as a property.
Retain context/lifecycle checks after awaited native helpers and revalidate broker
authorization after metadata reads. Do not weaken private-file checks or route
fences to make a candidate pass.

## Installation and recovery

For graphical installations, use the app's Install or update Claude Mod action
and its explicit Enable/receiver controls. The installer preserves app-owned
stages and verified legacy sources, uses same-name marketplace add for migration,
and never downgrades newer installed versions. Read-only inspection never installs.

For CLI-only installations, use a capability-verified native local marketplace
manager, preserving active work:

```sh
claude plugin marketplace add /canonical/persistent/claudex-mod-stage
claude plugin install claudex@claudex-local --scope user
```

For an existing installation use its native update flow. Verify the exact
synchronization root, trusted Node executable and intended nativeWake/selfWake options
for both claudex@claudex-local and claudex@inline, including retained overrides.
Use a fresh suitable session when an existing module remains loaded; do not
restart active apps merely to update a pane. Install receipts and cache versions
alone do not establish the running version. Inspect the real pane and broker
response. Keep safe recoverable app backups and private evidence outside Git.
Open the installed `/Applications/Claudex.app` by its exact path: development
bundles can share its display name, so name-only application lookup is insufficient.

New installations keep both options off until authorized target-runtime acceptance.
The reviewed Mac uses the explicit mod-self route after native and Desktop acceptance.
Do not alter a shared native CLI or versionPolicy merely to load the companion.

## Rollback boundaries

collaboration native-wake --route renderer changes routing for future messages;
existing Mod messages and unknown outcomes retain their original evidence. Keep
the modern broker reader: older brokers do not understand mod-self, submitted
outcomes and receive-once records. Never downgrade over new mailbox data or reset a claim.

Prefer disabling the companion through the native manager when opting out;
the app preserves explicit disablement. Removing an app-managed Mod is not a
persistent opt-out because normal maintenance can reinstall it. Never remove the
marketplace as a recovery shortcut: that native command can delete plugin data.
Retain its stage while loaded sessions use it, action receipts/locks, own-dispatch
journal, outbox and mailbox. Removing the pane does not cancel accepted work; use normal explicit
cancellation and verify process closure separately. Preserve histories, credentials,
settings hooks, MCP and existing adapters.

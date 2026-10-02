# Claude Mod integration: deployment handoff

Reviewed on 2026-10-02. The companion is integrated; do not reapply the downloaded
revision-2 patch. Read AGENTS.md, [the guide](claude-mod.md),
[acceptance gates](claude-mod-acceptance.md) and [validation](claude-mod-validation.md).

Version 0.2.3 is installed with nativeWake=true and broker route=mod. It fixes the
real narrow-pane tab layout; final native pixels verify all five tabs in two rows.
Strict validation, nine native kit tests, installed asset hashes and app signature
pass. A new Desktop-owned automatic send passed after normal broker/Claude restarts
with one Sonnet 5.5 reply and real Stop ACK; no pending outbox receipt remained. Earlier
rollout-off CLI refusals were not reproduced by the current actual 2.1.286 runtime.
Do not treat historical 0.1.1/manual evidence as current automatic evidence.

## Current scope and evidence

- /claudex Overview, Tasks, Chats, Compose, Inbox, task details and durable receipts.
- AbovePrompt context/rate-limit display composed with the native tree.
- Existing broker delegation, follow-up, cancellation, defaults and exact native
  chat lookup; user-authored writes retain preview/confirmation and bounded grants.
- Automatic delivery of already-authorized wake-enabled messages through a loaded
  sender's real session.send, with source-bound claims and receipt-only recovery.
- Real Sonnet 5.5 nonce reply and Stop ACK from an untouched automatic listener;
  the SDK-owned sender received no prompt/model input. Claim, native acceptance,
  reply, ACK and completed outbox receipt were inspected separately.
- Busy-recipient second queue acceptance before first ACK, followed by both ACKs;
  offline rejection retained without replay after reopening; exact native draft
  preserved in the actual Desktop screenshot.
- Native manager installation/configuration, development-signed Claudex app with
  previous app backed up, normal authorized Claude restart and actual new pane.
  Traditional Chinese Claude app.asar and signature were preserved.

Another eligible sender with SendMessage is required. No sender or only the
recipient means waiting-for-mod, not a new model process or silent fallback.
Normal restart preserved the route and earlier rejected receipt without replay;
fault-injected pending-receipt recovery remains synthetic coverage. Do not imply
every native inbound policy scenario or pane button flow passed. Final read-only
inspection shows collaboration, folders and renderer adapters ready, and no active
or uncertain managed collaboration tasks. The temporary folder-cache diagnostic
cleared normally. Unfinished-tool handoff and predecessor-archival lifecycle waits
remain separate synchronization guards, outside this feature's acceptance.

Task execution, native SDK dependencies, synchronization allowlists, history/assets,
compaction, writer ownership, folder/archive adapters, hooks and MCP remain intact.
General Chat/Cowork customization and new-runtime synchronization acceptance are
not included. No public release or notarization is implied.

## Validate changed inputs

```sh
node --test test/mod-wake.test.mjs test/claude-mod-controller.test.mjs test/claude-mod-bridge.test.mjs
node bin/claudex-mod.mjs stage \
  --root /canonical/private/claudex-state \
  --output /canonical/new/claudex-mod-stage \
  --node /canonical/trusted/node --native-wake
claude plugin validate /canonical/new/claudex-mod-stage/plugins/claudex --strict --json
claude plugin test /canonical/new/claudex-mod-stage/plugins/claudex
```

Use the actual intended runtime's compiler/test kit and a create-only stage.
The source plugin has blank machine defaults and no bundled helper. The documented
public API baseline is 2.1.287, not an automatic rejection of tested 2.1.286.
The nine native kit cases stub external operations; they are not rendering or
model-work evidence. Reuse unchanged valid tests rather than rerunning a full
suite solely for installation or handoff.

Keep $ helpers at module top level and treat $.plugin.root as a property.
Retain context/lifecycle checks after awaited native helpers and revalidate broker
authorization after metadata reads. Do not weaken private-file checks or route
fences to make a candidate pass.

## Installation and recovery

Use the native local marketplace and plugin manager, preserving active work:

```sh
claude plugin marketplace add /canonical/persistent/claudex-mod-stage
claude plugin install claudex@claudex-local --scope user
```

For an existing installation use its native update flow. Verify the exact
synchronization root, trusted Node executable and intended nativeWake option,
including retained overrides. A fresh suitable session or supported restart is
needed when an existing module remains loaded; install receipts and cache versions
alone do not establish the running version. Inspect the real pane and broker
response. Keep safe recoverable app backups and private evidence outside Git.

New installations keep nativeWake off until authorized target-runtime acceptance.
The reviewed Mac has passed the automatic-delivery gate and uses the Mod route.
Do not alter a shared native CLI or versionPolicy merely to load the companion.

## Rollback boundaries

collaboration native-wake --route renderer changes routing for future messages;
existing Mod messages and unknown outcomes retain their original evidence. Keep
the modern broker reader: older brokers do not understand rejected outcomes and
Mod route fencing. Never downgrade over new mailbox data or reset a claim.

Disable/uninstall only the companion through the native manager if required.
Retain its stage while loaded sessions use it, action receipts/locks, outbox and
mailbox. Removing the pane does not cancel accepted work; use normal explicit
cancellation and verify process closure separately. Preserve histories, credentials,
settings hooks, MCP and existing adapters.

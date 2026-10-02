# Claude Mod integration: deployment handoff

The revision-2 companion based on `eb12d2e` is integrated into this repository.
Do not reapply the downloaded patch. Read `AGENTS.md`, [the guide](claude-mod.md),
[acceptance gates](claude-mod-acceptance.md), and [validation](claude-mod-validation.md).
Source plugin version: 0.2.1; installed version: 0.1.1. Reviewed on 2026-10-02.

The automatic native route is implemented but not activated. Start with the
0.2 section in `claude-mod.md`: new CLI test processes report the rollout switch
off. Do not infer that already-loaded Desktop instances stopped. Preserve the
existing installation until new native activation acceptance succeeds.
Do not mistake the earlier manual Sonnet acceptance for automatic-loop acceptance.

## Implemented scope

- `/claudex` Overview, Tasks, Chats, Compose, Inbox, task detail and action receipts.
- AbovePrompt context/rate-limit display composed with the native tree.
- Existing broker operations for delegation, follow-up, cancellation, defaults,
  exact native chat lookup and queue-only messages.
- Exact controller session/cwd binding, complete preview before confirmation,
  durable receipts, duplicate-click/reload fencing and no uncertain replay.
- Append-only handoff drafts and the generation-scoped MCP workflow.
- Default-off `session.send` adapter using the existing atomic mailbox claim.
- Create-only local marketplace staging and explicit app-engine packaging.

Version 0.2 changes broker/mailbox delivery routing and receipts. Task execution,
synchronization, SDK dependencies and version policy remain unchanged. History, images,
compaction, native writer ownership, folder/archive adapters and existing hooks
remain in their original paths. General Chat/Cowork customization is unsupported.

## Repairs from actual native validation

The original bundle's synthetic tests did not prove native callbacks worked:

1. The native compiler rejects a `$` helper nested inside `register`. Keep `api`
   at module top level and pass configuration explicitly.
2. `$.plugin.root` is a string property, not a function or interceptable event.
3. Strict validation now has clean manifest metadata, including author attribution.
4. Clear/end handlers invalidate the UI after resetting controller state, so a
   stale confirmation does not remain visible after a native session boundary.
5. The stager rejects symlinked source directories before creating output.
6. The RPC test uses a short temporary prefix for Darwin's socket path limit.

Nine native tests exercise both element trees, fixed helper argv, compose/preview/
confirm/receipt, duplicate-title exact-ID selection, and native clear. External
calls are stubbed; this is not actual Desktop painting or model-work evidence.

## Revalidate changed inputs

```sh
node --test --test-concurrency=4 test/claude-mod-*.test.mjs
node bin/claudex-mod.mjs stage \
  --root /canonical/private/claudex-state \
  --output /canonical/new/claudex-mod-stage \
  --node /canonical/trusted/node
claude plugin validate /canonical/new/claudex-mod-stage/plugins/claudex --strict --json
claude plugin test /canonical/new/claudex-mod-stage/plugins/claudex
```

Use the intended runtime's own validator/test kit. Claude Code 2.1.287 is the
documented public baseline; the installed Desktop 2.1.286 also passes these tests
and registers `/claudex` at initialization without additional feature flags.
The source plugin
has blank machine defaults and no packaged helper; validate the stage. Tests have
no model runner. Native full-suite tests remain opt-in. Reuse unchanged regression
evidence; run broader checks for actual core/permission/persistence changes.

## Runtime and installation gates

Do not mistake the documented 2.1.287 baseline for a local hard load gate. Record the
terminal, actual Desktop Code, Claudex owner and SDK versions separately. Do not
replace a shared CLI or change `versionPolicy` just to load the Mod.

The inspected target Mac's user CLI is 2.1.283. Its Desktop local-runtime cache
contains 2.1.284 and 2.1.286; cache names do not prove the active session version.
No existing runtime, app, service or history was replaced. The companion is now
installed and enabled through the native user-scope plugin manager, with all three
configuration options saved and nativeWake false. User-supplied screenshot and
accessibility evidence verifies the real Desktop pane, usage band and broker
response on engine 2.1.286 with the Traditional Chinese app UI preserved.
Reinspect these mutable facts before deployment.
Private stage/build paths belong in the local operator handoff, not this repository.

Once the target runtime supports Mods and applicable compatibility/UI gates pass:

```sh
claude plugin marketplace add /canonical/persistent/claudex-mod-stage
claude plugin install claudex@claudex-local --scope user
```

Verify `/plugin configure claudex@claudex-local`: exact synchronization root,
trusted Node and `nativeWake: false`. Use the next normal session or safe native
`/reload-plugins`; never force-close active work. Confirm real `/claudex` painting
and a read-only response from the intended broker. Installation success or a
cached frontend resource is not Desktop loading evidence.

The signed app includes the stager/resources, but app replacement is unnecessary
for the independently staged companion. Development signing is not notarization.

## Native receipt stays off

Do not enable `nativeWake` before independently authorized model/recipient tests.
Use distinct controller/recipient sessions. Inspect claim, native queue result,
same-recipient Stop ACK and requested result separately. `isDelivered` means
queue acceptance, not acknowledgement or work completion.

Exercise refusal, competing consumers, context changes and lost receipts with
synthetic fixtures before native acceptance. Preserve unknown/offered evidence;
never reset or replay a message. Unloaded-session activation and legacy-adapter
cases need separate replacement proof. No old adapter is retired.

## Rollback and later scope

Disable/uninstall only `claudex@claudex-local` through the plugin manager. Retain
its stage while any session uses it, and retain `mod-companion` receipts/locks.
Removing the plugin does not cancel accepted work: use normal explicit cancellation
and verify actual terminal/process evidence. Preserve histories and credentials.

Optional graphical setup integration, localization and new synchronization
runtime acceptance remain separate changes. Version 0.2 adds automatic delivery
of already-authorized messages; new user-authored operations still require
preview/confirmation and retain bounded permissions.

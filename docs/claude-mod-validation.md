# Claude Mod integration validation

Reviewed on 2026-10-02. Source 0.2.1 is staged for automatic delivery; installed
0.1.1 remains the previously verified manual implementation.

## Automatic-route validation gate

The 0.2 implementation adds durable per-message routes, source-bound atomic
claims, event-backed waits, lifecycle fences, SendMessage preflight, native
refusal classification and receipt-only recovery. Synthetic checks cover routing
across restart, legacy-reader exclusion, competing senders, disconnect/shutdown,
expiry, unavailable targets, unknown dispatch, lost receipt responses, busy queue
completion, source-context change, connection backoff and unsafe-storage blocking.

Final 0.2.1 full regression: 1,292 passed, zero failed, 23 original opt-in skips.
The initial automatic-route suite had 13 passing cases. Version 0.2.1 adds two
reproduced malformed-reply regressions: dispatch requires ready:true and outcome
publication must match the exact message, claim, source, recipient, route and
status. Both failed before the repair; 69 affected tests now pass.
Static native validation passed on 2.1.286 with the new clock/tool APIs declared.
The corrected 0.2.1 candidate also completed the development-signed App build.
Direct Desktop plugin-manager inspection still lists the installed 0.1.1 enabled;
that confirms it was not uninstalled/disabled locally, not that 0.2.1 has loaded.

New CLI test processes on both 2.1.286 and 2.1.287 report that the rollout
switch served off. This does not prove that already-loaded Desktop instances
stopped: direct UI inspection still shows the installed Mod and prior delivered
test result. Process/user/project settings did not contain an explicit
disable flag. No override was set, and the installed broker route/plugin were
not switched. Prior nine-test/manual-delivery acceptance below remains historical;
it does not validate the new automatic loop or establish current availability.

## Current macOS evidence

Environment: macOS/Apple Silicon, Node v23.11.0; isolated official Claude Code
2.1.287 native executable from its pinned npm platform package. Initial contract
validation performed no inference; the later explicitly authorized Sonnet test
is recorded below. Existing runtimes, SDK dependencies and services were preserved.

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Supplied patch `git apply --check --whitespace=error-all` | Passed | Matched clean base before integration |
| Complete `npm test`, concurrency 4 | 1,276 passed, 0 failed, 23 skipped | Initial integration with repaired Darwin socket fixture |
| Final focused `test/claude-mod-*.test.mjs` | 66 passed, 0 failed, 0 skipped | Includes source-parent symlink regression |
| Official staged plugin strict validator | Passed, no warnings/errors | Actual 2.1.287 compiler and manifest |
| Official staged plugin test kit | 9 passed, 0 failed | Native terminal/Desktop trees and callbacks; external operations stubbed |
| Installed Desktop CLI 2.1.286 validator and kit | Strict validation and 9 tests passed | No extra feature flags or version-policy changes |
| SDK 0.3.286 with actual 2.1.286 runtime and Mod | Initialization and `/claudex` registration passed | Isolated, network denied, no model input, child exited |
| Native user-scope plugin installation/configuration | Installed, enabled, all options configured | Native CLI receipts and read-back of installed configuration; not painting evidence |
| Real Desktop Code pane and usage band | Verified by user-supplied pixels and accessibility tree | Actual engine 2.1.286, five pane tabs, broker limits/defaults response, Traditional Chinese app retained |
| Authorized nativeWake delivery | Native queue acceptance, exact-recipient reply and Stop ACK passed | 2.1.286, Sonnet 5.5, one independent test message through the unchanged production controller |
| Packaged helper against the existing local broker | Passed | Read-only doctor and task inventory; no inference or mutation |
| Development-signed Apple Silicon app build | Passed | Explicit packaging, portable Node v24.21.0, nested signing |
| `codesign --verify --strict --deep` | Passed | Integrity/signature, not notarization or installed acceptance |

Focused/native runs cover subsequent Mod-only repairs; unchanged core regression
evidence is reused. The 23 skips are original opt-in native/environment cases, not
newly skipped Mod tests. The real private-socket test uses the original transport
with a synthetic dispatcher, never a model runner.

## Failures repaired

- The RPC fixture exceeded Darwin's socket pathname limit; its temporary prefix
  is shortened without changing runtime transport behavior.
- The native compiler refused the nested `$` helper; it is now module-level.
- The original test incorrectly intercepted `plugin.root` as an event. Additional
  callback tests then proved the implementation must read `$.plugin.root` as a
  property, rather than invoke the bundle's erroneous function call.
- The first six native cases could pass while helper calls displayed errors.
  Three added cases assert successful compose/confirm, duplicate-title exact-ID
  selection and clearing old confirmation controls.
- Controller reset did not invalidate the tree. Clear/end now redraw explicitly.
- The standalone stager followed symlinked source parents; top-down validation
  now rejects them before creating output, covered by a regression test.
- Strict validation reported absent author metadata; attribution is now included.

## Native capability inventory

The validator reports hooks for `session.start`, `classic.SessionStart`,
`session.end`, `turn.complete`, `command.run` (`claudex`) and `ui.render`
(`AbovePrompt`, `Pane`). Calls are `command.register`, `env.get`, `process.run`,
`prompt.fill`, `session.cwd/id/send/usage/version` and `ui.invalidate/open/resolve`.
The only environment read is `CLAUDEX_COLLABORATION_WORKER`; there are no
environment writes. `plugin.root` is intrinsic metadata, not an event call.

`session.send` remains statically declared with `nativeWake: false`. The flag
gates the implementation, not the trust granted to installed code. The validator
does not transitively audit the child helper; private file/RPC effects are covered
by source contracts and Node tests. No automatic prompt submission, model call,
permission approval hook or periodic timer is added.

## Remaining boundaries

Real terminal painting, new-runtime synchronization and model delegation from
the pane are not established by these tests. Native receipt evidence is scoped below.
Keep nativeWake off. No app replacement, runtime upgrade, service restart or
direct native history editing was performed. The companion has been installed and
enabled through the native user-scope plugin manager;
state root, Node executable and nativeWake=false were saved with no unset options.
The earlier claim that installation must wait for a runtime upgrade was too broad:
the existing 2.1.286 runtime already loads this Mod without additional flags.

Native UI automation initially failed to target the composer with
`noWindowsAvailable`. The user then invoked `/claudex` and supplied a screenshot
and accessibility tree showing the real pane and successful broker response.
This closes the Desktop painting/read-only connection gate, not mutation or ACK
acceptance. The earlier `/claudex:claudex-workflow` invocation was a separate
user-triggered model interaction; it is not the pane-opening command.

Version 0.1.1 corrects the misleading `Mod minimum` presentation and diagnostic
field to a documented public API baseline, explicitly not a load gate. No runtime,
permission, synchronization policy or native API behavior is changed.
The native manager installed 0.1.1 and all 13 cached assets matched the stage.
The existing Desktop session retained its 0.1.0 module after `/reload-plugins`
reported success and `/claudex` was reopened; the installer explicitly requested
a restart to apply changes. Keep that working session intact and load the update
at its normal native lifecycle boundary. Do not claim the new label painted yet,
rewrite the old cache in place, or interrupt an owner for a presentation update.

## Authorized nativeWake acceptance

An external, temporary test Mod invoked the unchanged production controller's
`wakeList`, `previewWake` and `acceptWake` methods, using the installed 0.1.1
helper and real broker. It called the actual `$.session.send`, not a stub. The
sender was an independently owned native session; the recipient was opened in
Desktop through native `--desktop --resume` after its bootstrap process exited.
Both used `claude-sonnet-5-5`. No original user session was repurposed.

The normal-path case acquired the exact mailbox claim, returned
`isDelivered: true`, saved an accepted wake receipt, and reached `acknowledged`
through the recipient's actual Stop hook. Read-only native history inspection
verified one assistant reply containing the requested nonce and exact standalone
ACK, with model `claude-sonnet-5-5`. The sender's test command reported zero model
turns. This verifies native delivery and reply/ACK, not mouse-driven Inbox controls,
arbitrary delegated work, busy/offline recipients or draft preservation.

Two preconditions were observed. An imported Desktop entry without a native title
was correctly refused by exact metadata validation; a new test session with its
title set through native SDK startup passed. Also, removing all sender tools made
the native API return `isDelivered: false` because it had no SendMessage tool.
The controller preserved that separate attempt as offered/uncertain without ACK
or replay. A new, distinct test message with only SendMessage enabled succeeded;
the earlier claim was not reset or resent. Model file/command tools remained
unavailable to the sender; the trusted Mod still used its reviewed process API
for the production helper. Preserve that refusal receipt as evidence.

The persistent nativeWake preference was restored to false through the native
plugin manager after testing. Existing loaded test sessions can retain their
prior options until their normal lifecycle boundary; no automatic delivery loop
was installed. Temporary evidence and exact native IDs stay outside the repository.

Follow [the handoff](claude-mod-handoff.md) and
[acceptance checklist](claude-mod-acceptance.md). Record the actual target engine;
cache versions do not prove a running session's version. Development signing is
not a notarized public release.

## Historical bundle evidence

Revision 2 reported 65 Mod tests passing on Linux ARM64/Node 22.22.2. Its full runs
retained Linux/macOS-only and timing-sensitive baseline failures. Those are prior
agent observations, not current Mac failures: the full Mac run passed unchanged
original assertions. The supplied external bundle retains its historical records.

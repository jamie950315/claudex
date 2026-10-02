# Claude Mod integration validation

Reviewed on 2026-10-02 against base `eb12d2e`, companion 0.1.0.

## Current macOS evidence

Environment: macOS/Apple Silicon, Node v23.11.0; isolated official Claude Code
2.1.287 native executable from its pinned npm platform package. No model inference
was performed. Existing runtimes, SDK dependencies and services were preserved.

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Supplied patch `git apply --check --whitespace=error-all` | Passed | Matched clean base before integration |
| Complete `npm test`, concurrency 4 | 1,276 passed, 0 failed, 23 skipped | Initial integration with repaired Darwin socket fixture |
| Final focused `test/claude-mod-*.test.mjs` | 66 passed, 0 failed, 0 skipped | Includes source-parent symlink regression |
| Official staged plugin strict validator | Passed, no warnings/errors | Actual 2.1.287 compiler and manifest |
| Official staged plugin test kit | 9 passed, 0 failed | Native terminal/Desktop trees and callbacks; external operations stubbed |
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

Real terminal/Desktop painting, new-runtime synchronization, native model work
from the pane and recipient queue/Stop ACK are not established by these tests.
Keep nativeWake off. No user-account plugin activation, app replacement, runtime
upgrade, service restart or native history mutation was performed.

Follow [the handoff](claude-mod-handoff.md) and
[acceptance checklist](claude-mod-acceptance.md). Record the actual target engine;
cache versions do not prove a running session's version. Development signing is
not a notarized public release.

## Historical bundle evidence

Revision 2 reported 65 Mod tests passing on Linux ARM64/Node 22.22.2. Its full runs
retained Linux/macOS-only and timing-sensitive baseline failures. Those are prior
agent observations, not current Mac failures: the full Mac run passed unchanged
original assertions. The supplied external bundle retains its historical records.

# Frozen native provenance contracts

These expectations were captured from the JavaScript engine at `05e4d02`,
preserved on `codex/javascript-legacy`, before removing that engine from main.
The synthetic inputs remain in `codex_provenance::tests`; no private native
history is included.

- `native-image-content.json`: the result of `createCodexLocalImageResolver`
  and `hydrateNativeLocalImages` for `fixture()`. It binds text, recovered
  persisted image bytes, the original inert attachment descriptor and detail,
  and the unchanged inline original. The same content contract applies to
  interruption, retained-origin and inherited-prefix variants; their remaining
  API turn/item fields must stay exactly as supplied.
- `late-command-proof.json`: `createNativeLateItemResolver` for `late_fixture()`.
- `late-subagent-proof.json`: the same input with the late command replaced by
  the explicitly constructed `SubAgentActivity` in the Rust test.
- `late-empty-command-proof.json`: the shell-projection variant without
  `started_at_ms`, `stdout` or `formatted_output`, with empty raw output and
  `aggregatedOutput:null` in the API item.

Late inputs use `/fixture/project` as cwd so canonical source bytes and digests
are deterministic. Only `sourceIdentity` was replaced by null in the captures;
the tests fill it from the fixture file's independent filesystem metadata.
Item/evidence digests, placement identities and boundaries remain the exact
JavaScript results. Tests never invoke Node or derive expected semantic values
from the Rust implementation.

The opt-in real-local audit now checks native API preservation and repeatable
proofs across two complete passes instead of invoking the retired engine. It
remains ignored in automated tests and requires an explicit live state root.

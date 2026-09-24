# Claudex

Native compatibility adapters for automatic turn-boundary handoffs between
Codex and Claude Code. **This is a compatibility prototype, not an installed
or complete synchronization service.** It does not watch or alter existing user
conversations. No daemon or hooks are installed.

## Run the checks

Requires Node.js 22 or newer:

```sh
npm ci
npm test
```

Opt into native Codex checks with an installed Codex binary:

```sh
CLAUDEX_NATIVE_TEST=1 npm test
```

`CLAUDEX_CODEX_BINARY` can select an explicit binary. Native checks use temporary
homes and synthetic transcripts. They do not start model inference. Temporary
evidence is retained for inspection and is not committed.

## Verified integration boundaries

Verified against Codex CLI `0.155.0-alpha.16.3` and Claude Code `2.1.210`:

| Operation | Observed result |
| --- | --- |
| Codex history injection | Persists user/assistant items for model context; does not create visible turns, including after restart |
| Refresh an untouched imported Codex thread | Official importer can update the same target ID with visible turns |
| Refresh a loaded imported Codex thread | Import is skipped |
| Refresh an imported thread after Codex-native history is added | Import remains skipped after restart; native history is preserved |
| Create a native Claude projection | CLI resumes the synthetic user/assistant history |
| Append a second Claude projection batch | Preserves original bytes and links new records through unique UUIDs |

These results rule out using history injection or the official importer alone
to implement visible, in-place, bidirectional roundtrips. A logical conversation
with successive native session copies is a different possible product contract;
it is not implemented here. Neither is a custom unified conversation interface.

## Modules and safety

- `src/codex.mjs`: bounded app-server JSON-RPC client; no automatic write retries.
- `src/claude.mjs`: native session creation and append-only conversion using pinned
  `txcript` codecs. A caller must guarantee the target is not open in Claude before
  appending; hash checks alone are not an external process lock.
- `src/storage.mjs`: private atomic files, source snapshots, and bridge-operation locks.

Claude project paths must be canonicalized by callers (for example, macOS `/var`
and `/private/var` resolve to the same location but yield different session keys).
Imported model identifiers are not used as Claude launch settings. Compacted Claude
transcripts are rejected rather than flattened without preserving their meaning.

Conversion is not byte-for-byte parity: encrypted reasoning, approval state,
live processes, and provider-specific state are not portable. Existing settings,
authentication, and permissions remain the destination tool's responsibility.

Do not connect a standalone app-server to a live user's home and assume it shares
the desktop app's in-memory state. Direct SQLite mutations and replacement of live
transcripts are outside this prototype's supported operations.

## References

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Official import flow](https://learn.chatgpt.com/docs/import)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [txcript usage](https://github.com/skillsynchq/txcript/blob/main/docs/usage.md)

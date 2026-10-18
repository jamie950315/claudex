# Frozen runtime contracts

`warm-prime-compaction.json` was captured from `CacheWarmManager` in the
JavaScript engine at `05e4d02` (preserved on `codex/javascript-legacy`). The
Rust test `warm::tests::prime_usage_and_one_compaction_match_frozen_contract`
contains the complete input sequence and explicit millisecond clock values:
observe, enable one request, prime claim/check/submitted receipt, successful
native usage, then one compact claim/check/compacted receipt.

Only random attempt IDs are normalized to `attempt-0`, `attempt-1`, in the
attempt list's order, including their references in policy usage samples.
Every other field, timestamp, token count, policy state and attempt outcome
is the original JavaScript result. Tests read this expectation as fixed data;
they do not start Node or regenerate it from the Rust implementation.

# Cold import, verification proofs and sweep scheduling

Contributor rules moved out of AGENTS.md; they are binding. Scope: Historical backfill, cold-verification proofs, the cold sweep and foreground scheduling, collection cost rules, and anchor header proofs.

Historical backfill is the explicit `Importer` API in
`crates/claudex-sync/src/cold_import.rs`, not a public CLI command or a changed
discovery cutoff. Its private journal reserves one target per source before
publication. `DesktopBridge::track_imported_pair()` verifies equal canonical
digest/count/cwd and enrolls two unmanaged originals with `discoveryMode: cold-import`.
The Claude original uses `importPacket: true`, packetVersion 2; runtime reads must
authenticate its archive without creating an SDK owner. Never overwrite its
bootstrap, replace a Desktop-owned file, or collect either original as a backup.
Native UI acceptance of the official `claude://resume` handoff adopts the published
CLI transcript. `paired` is not Desktop visibility; `adopted` requires read-only
registry evidence, and visible project/title/history require UI verification.
Do not inject registry/database/IPC state. One real Local adoption is verified
without inference, not the completeness of a bulk migration. Missing cwd/assets,
empty or unsupported histories remain explicit exclusions; incomplete tails are
withheld. Do not label a partial import as all-history success.
Claude Local continuations use normal Codex snapshot/original-dependency guards;
the return from Codex creates a separate managed Remote Control entry with the
same title. The opt-in native Local handoff archives the verified superseded
Local entry while preserving its contents; it never reuses the Local writer. Cold imports
avoid idle SDK workers only until that transition; active owners remain long-lived.
Cold-import hints require stable, complete no-change verification. Pure pairs of
two verified current unmanaged originals may persist a signed verification proof
under cold-verification. Bind exact ledger/native file observations, inactive
Codex identity/path/cwd/update metadata, decoder code/runtime/configuration, and
all authenticated archive files and their directory with nanosecond identities.
Reuse survives restart without a timer-driven full export; changes, uncertainty,
missing files or invalid proof require full verification. This is a no-op scheduling
optimization, never mutation, archival, collection or checkpoint authorization.
Exclude managed records, dependency anchors, relocation and retained-image chains.
An inactive original's byte-identical unfinished tail may remain withheld while
reusing its verified canonical-prefix no-op proof. This never completes the tail;
new bytes or native activity require full verification again.
Proof storage is bounded to 4096 entries, 16 MiB per entry and 64 MiB total, plus
one bounded temporary file. Save only after full no-change verification and stable
post-read observations. No native history or credential is copied into the proof.
Other eligible cold pairs retain ephemeral hints covering all lifecycle/checkpoint
fields and native file identities, including superseded originals, with a fixed
60-second full-verification deadline. Pending work suspends proof use until verified
recovery; errors revoke the affected proof. New and active
conversations and dirty cold imports run before the fair cold-validation sweep.
Proof misses run full verification directly; only failed reads require durable
revocation. A successful refresh replaces its proof once, without a preceding
tombstone flush. Restoring an old context never revives a failed proof.
The cache's content-free `diagnostics()` is published as `coldVerificationCache`
in watcher status, including after shutdown: state/reason, entry and byte usage,
limits, capacity and disabled flags, and reclaimed-entry count. Counts are the
last bounded write inventory, not a new scan on every status read. Capacity
refusal leaves existing valid proofs usable; misses still run full verification.
On capacity pressure, reclaim only authenticated tombstones or proofs already
revoked by the persistent generation fence. Before deleting a current-generation
tombstone, atomically publish and fsync a fresh authenticated `.revocation.json`
generation. Earlier proofs then need full verification; their files remain
untouched until a later capacity pass can reclaim the revoked entries. Bind
fresh proofs to that generation and recheck it on reads/publication, so restoring
old proof bytes or context after tombstone collection cannot revive them.
Keep the fence across restarts and interrupted reclamation, serialize proof
mutations, and recheck exact private single-link file identities before removal.
This reclamation touches only the derived cold-verification directory, never
dependency anchors, native histories or authoritative history-assets.
The injected non-event test harness refreshes discovery and changed work between
complete cold operations after two seconds, not the entire unchanged foreground
queue. Production completion-event mode instead services bounded exact durable
event targets between startup checks as described above; streaming metadata
alone never triggers broad rediscovery. Every scheduled managed owner retains
its full lifecycle check once per pass; changed owners are prioritized. Running
Claude owners use live lifecycle state. Stopped current owners use matched saved
state under the native writer lock and stable transcript reads, without starting a
process. Pending appends/resets require explicit recovery. Preserve archive,
image restoration and retained-generation checks. Idle assertions and maintenance
discovery must not start an owner; actual reset plans still require a fresh cold
native owner. Reconcile legacy display titles only when an owner runs for work.
In that non-event harness, discovery and new deliveries also refresh between
individual foreground syncs, using their own clock; a long active-owner sweep
must not block new enrollment. Its stable file/lifecycle observations also
prioritize changed existing conversations
between native operations. This includes superseded originals and both current
sides, not just new enrollment or cold imports. These observations only reorder
full syncs; unchanged managed owners still receive normal lifecycle verification.
Serve at most one queued existing change per boundary and keep the regular sweep
advancing, so repeated busy activity cannot starve other conversations.
Keep the original sweep moving after each nonrecursive discovery refresh; never
restart it recursively or parallelize writers. Post-enrollment errors retain
tracked-history severity, not unsupported-discovery warning classification.
Raw observations select priority only; unsuccessful dirty work stays foreground
until stable full verification. One in-flight native operation can exceed this
interval, so it is not an end-to-end latency guarantee. Never advance semantic
checkpoints from hints or skip a current managed Claude owner's lifecycle checks.
Within the coordinator lock, the two current Codex/Claude history inspections
may overlap. Superseded-original inspections use batches of at most four;
dependency-anchor checks retain their ordering. Drain every started read before
reporting the first input-ordered error, starting another batch, planning writes
or releasing the lock. Relocation, recovery, maintenance, native writes and
checkpoint commits remain serial. Concurrent Codex readers share one pending
transport initialization and receive a client only after it fully initializes;
initialization failures reach all waiters without replaying native work.
Full fingerprints stream the existing canonical JSON digest by message. Raw
archive reads retain canonical byte, reference, portable-shape, asset and semantic
digest validation without regenerating the chunk/page tree; custom message
resolvers still require independent deterministic archive binding. Never change
persisted digest bytes or treat this optimization as a cross-snapshot content cache.
Bounded watcher timing fields report discovery gaps and last/slowest syncs,
without transcript content; they are operation timings, not UI latency promises.
Ordinary progress diagnostics coalesce at two-second intervals. Initial status,
changed health/conflict reasons, completion boundaries and final shutdown remain
visible promptly; the ten-second in-flight heartbeat remains. Durable transaction
ledgers and expiring Desktop handoff proofs never use this diagnostic throttle.
Normal discovery scope is unchanged.
Ordinary appends to the same managed Claude owner skip collection
before and after delivery, including recovery: they allocate no Codex backup.
Keep conversation-scoped source/original/target and native idle checks intact.
New allocations, relocation, context maintenance and explicit GC still collect.
Collection validates both current sides only for conversations owning managed
snapshots, avoiding full exports of unrelated cold pairs with no backups. Keep
the superseded-original guards global (frozen conversations are deferred), retain every managed snapshot in the
global quota, and preserve exact previous-snapshot/native retirement checks.
Within one collection, previous Codex snapshots share one fresh initial global
metadata dependency inventory; each parent still has its own ancestor queries.
Actual dependency anchors retain independent fresh inventory, canonical and raw
proof revalidation. Never reuse this inventory for a later collection or as
mutation authorization; native hide/remove guards still recheck independently.
Native sorting of a Claudex projection's first JSON header may be recognized only
by reconstructing its original serialization and matching the saved whole-file
SHA256, with every subsequent byte unchanged. Preserve actual raw proofs and
native files; never rebaseline an anchor from canonical message equality alone.
By user decision the provider label of a rollout header is not history: a
provider switch (observed: Cockpit Tools rewriting model_provider in every
rollout's first line) must not pause an anchored conversation. The anchor
proof also saves a label-free identity (raw.labelFree: the whole-file hash and
size with that one field removed from a sorted header). When the exact bytes
differ, the anchor still holds if that identity matches and the aggregate
storage moved by exactly the header's size difference. Any other header
value, any body byte and a header that does not round-trip exactly (a hidden
duplicate key) remain changes. An anchor saved before this identity existed
gains it only at the start of its conversation's own sync, while its exact
bytes are still proven; until then it keeps the exact proof alone.
Native initial-goal exports likewise retain legacy prefix-hash serialization only
when the observed native/key-sorted header forms reproduce the entire saved
canonical checkpoint. Keep all post-header bytes and context/turn checks intact;
never replace a saved hash, select a branch, or alter a native transcript to match.
Missing native paths invalidate persistent cold-cache reuse and proceed to full
inspection for per-conversation diagnostics, rather than crashing the watcher.
Native cwd resolution in discovery, tracked inspection, owner startup and archive
preflight uses typed per-source/per-conversation failures for missing paths.
Never classify unrelated transport, permission or malformed-metadata errors as
missing projects, and never automatically untrack a missing project.
Reuse the verified read returned by assertUnchanged for that snapshot's byte
count instead of immediately exporting the same history a second time.

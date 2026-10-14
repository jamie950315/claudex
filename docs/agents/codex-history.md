# Reading Codex histories

Contributor rules moved out of AGENTS.md; they are binding. Scope: history_base, contextCompaction controls, byte and page limits, display screenshots, localImage recovery, subagent exclusion, goals and delegation envelopes.

Codex (0.162+) compresses a rollout left unchanged for seven days to
`<name>.jsonl.zst`, in sessions/ and archived_sessions/, and restores a new plain
`.jsonl` before its next append; the plain file wins when both exist. The API,
records and history_base lookups keep the logical `.jsonl` path. Every rollout
reader resolves the present representation through `src/codex-rollout-file.mjs`,
proves identity on that physical file and reads the decompressed bytes; byte
offsets, sizes, digests, limits and reported storage bytes apply to the
decompressed content. A rollout
is unavailable only when neither representation exists. A representation change
between checks is a changed source, never a silent switch.
Raw rollout proofs (empty-turn, goal, late-item) compare the working directory,
not its spelling: Codex records the path it was started in, which may be an
alias (symlink) of the canonical directory, and its API may report either form.
A recorded string is accepted only when it resolves to that exact directory.

Reject unresolved Codex history_base references without a self-contained readable
summary; do not silently export only their local tail. Earlier readable originals
can remain in prior rollouts, but prefix ordinals, byte boundaries, item identity,
and complete-turn coverage must agree before publishing a reconstruction.

An exact singleton completed contextCompaction item with only type/id is inert
control metadata when prior request context exists, not a completion boundary.
Publish it only inside a prefix ending with a real completed assistant response;
withhold trailing control turns and unfinished tails. Initial, mixed, malformed
or error-bearing control turns retain normal rejection; never fabricate a reply.

DesktopRuntime reads optional `nativeHistoryMaxBytes` and `nativeHistoryPageSize`
from the private root's config.json. Defaults remain 16 MiB and 100 turns/page;
explicit bounds are 1024..268435456 bytes (raised from 64 MiB by user decision) and 1..100 turns/page. Both original and
owned native exports enforce the configured raw/converted byte budget. Keep the
256-page and 25,000-item limits unchanged. The history client's frame limit is
64 MiB or the configured byte budget, whichever is larger, and an oversized
response is reported as such. The Desktop-to-backend launcher only forwards
Codex Desktop's own traffic and uses a 1 GiB sanity bound: stopping there would
end the user's backend. Context packets keep their 64 MiB cap, so the packet
limit is the smaller of the budget and that cap. Rollout sources read for
empty-turn, goal and late-item proofs may be up to 480 MiB. Limit errors
identify the source thread; never add automatic retries, truncation or fallback.
Codex Desktop attaches a display-only data-URL screenshot at mcpToolCall
result._meta["codex/toolSurface"].screenshot.url (Browser Use/CUA); it is not
model input and can be ~90% of a history. Conversations enrolled from now on
carry displayScreenshots:'omitted' (on the conversation and every Codex record
it creates), and their reads replace exactly that data URL with an explicit
{reason,mimeType,bytes,sha256} record before the byte budget. Existing
conversations keep their exact representation; never apply the policy to a
conversation whose checkpoints were made without it.

Native Codex localImage recovery for originals and owned continuations reads
metadata.path's current owned regular rollout. After a native rollover, it may
also read exact previously verified ledger origins, never discover candidate
files. Persist `localImageRollouts` per turn/item/canonical-message identity at
verified promotion, filtering out later source turns beyond the committed count.
A legacy verified record's saved path can establish those origins once. Retained
images must remain inside the saved canonical prefix and match its full digest;
new image messages require current-rollout evidence. Preserve origins across
later path updates, without adding image-free rollovers. Conflicting duplicate
proofs, partial provenance, missing files, aliases or moved message identities
fail explicitly. Use O_NOFOLLOW and stable identity/stat checks across at most
256 explicit files, with a 512 MiB aggregate scan cap and 64 MiB row cap.
Native archival may relocate the current file. A missing former path is not
required when the exact requested images are already completely proven by the
authoritative/retained sources and the saved canonical checkpoint still matches;
an origin still needed for any image remains mandatory. Image-free reads do not
probe obsolete paths. Existing conflicting evidence is never ignored.
A rollover can leave turns written after the last checkpoint in the previous
rollout, which is read as the saved path. Such an image belongs to a new
message only when the current rollout's declared history_base link to that
exact file proves the same bytes within its ordinal and byte prefix; otherwise
retained evidence still cannot supply a message outside its checkpoint.
An image turn may close with its exact turn_aborted (reason interrupted) event
instead of task_complete; the API reports it as an interrupted closed turn.
Require exact translated completed-item
equality with the full API item, matching thread/turn/context/passthrough IDs,
one earlier embedded user response, exact text, and image wrapper path/number/order
agreement before a closed turn. Keep image descriptors as inert metadata and
validate the recovered data URI and converted-history budget. Never read API
image paths, fetch URLs, search for rollout files or silently choose a candidate.
By user decision, images the current and retained rollouts do not prove may come
from the declared history_base chain (fork or rollover), nearest segment first.
Each link is located only by its exact segment ID in the native layout
(sessions/YYYY/MM/DD or archived_sessions; root <thread>.jsonl or
<thread>_<segment>.jsonl, exactly one match), and its session_meta must belong
to the forked_from thread (fork, with matching forked_from_ordinal_exclusive) or
the same thread (rollover). Rows carry contiguous native ordinals; only rows
before end_ordinal_exclusive count. Observed end_byte_offset values can land a
few bytes inside an adjacent row, so the offset must fall within the last
included or first excluded row. The referenced segment may keep growing; only
its inode and covered prefix length are rechecked. The source thread_id in those
rows is the owning thread's, and every image still matches the exact API item.
Mixed local attachments and inline images retain their exact native order. Inline
bytes come from the full API item and must match the translated persisted user
completion; validate the normalized model-input image without substituting its
possibly resized bytes for the inline original.
This preserves native persisted model-input bytes, not proven unresized uploads.
Owned bootstraps must still be inline authenticated checkpoints before hydration;
only subsequent native inputs can use this recovery path. Packet authentication,
exact transport receipts and all continuation provenance checks remain mandatory.
Accept only the observed passthrough key sets: turn_id alone, plus create_time,
or plus create_time and content_item_kinds. Validate every present value; never
invent absent timestamps. A raw response may omit its own id, but a present id
must remain nonempty and the completed-event/API item identity is always exact.
Only absent raw client_id normalizes to API clientId:null; explicit values must
match exactly, and raw clientId aliases are rejected rather than overwritten.

Native metadata, not the rollout header, determines subagent exclusion; ordinary
forks remain eligible. Goal continuations may begin with assistant items and
receive user steering later. Full native reads preserve this order when earlier
verified user context exists, still requiring a final answer and withholding
active tails. Never fabricate a user message to force role alternation.
Desktop create_thread can deliver the first request as a codex_app function
output instead of a userMessage. Only its exact initial delegation envelope
establishes request context; preserve the event's assistant role and full inert
payload. The same narrow predicate permits its owned Codex checkpoint. Generic
assistant-only history, arbitrary tool outputs and malformed envelopes still fail.
An initial native goal may have no API user item. Accept only a stable owned
authoritative rollout proving the exact initial active goal, marked goal context,
thread/turn/cwd identities, every API assistant completion and its final boundary.
Recheck the source inode and goal prefix across both API passes. Preserve the goal
as inert assistant-role historical data, never a fabricated user prompt or an
instruction to run inference. Missing, ambiguous or changed proof still blocks.
Carry the additional canonical message offset into native image evidence and
include the resolver in packaged engines and cold-verification cache identity.

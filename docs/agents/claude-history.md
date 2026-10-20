# Reading Claude transcripts

Contributor rules moved out of AGENTS.md; they are binding. Scope: Ancillary tails, compaction, forks and parallel-tool graphs, and Claude image originals and sidecars.

Canonical messages contain authored turns and the native local-command envelopes
that the codec projects into turns. Known native context and bookkeeping rows
(`mode`, `permission-mode`, `attachment`, `cost-state`, `atis-latch`, `agent-name`,
`relocated`, `ai-title`, and `file-history-delta`) do not become additional
canonical messages. In particular, attachments can carry queued prompts, images,
file contents, instructions and hook context; they are not necessarily empty or
duplicates of an authored turn. Preserve their original native bytes, but do not
change the existing packet or checkpoint contract to transport them as authored
messages. Truly unknown semantic content remains whole as inert labeled data,
under the project-wide native reading rule.

A native assistant response ending with `stop_reason: refusal` and persisted text
is a completed read boundary too. Preserve its original text and refusal metadata;
do not rewrite it into a successful answer. A refusal with only withheld/empty
reasoning supplies no reply boundary. Keep any later input, companion notice or
unfinished tool call withheld under the normal complete-prefix rules. This read
boundary does not change cold-reset, archival, retirement or other write proofs.

- Unmanaged Claude originals may end in native transcript-only task notifications.
  Accept these as ancillary tails only with system provenance, exact queue evidence
  and a parent chain from the completed assistant. Preserve their original bytes
  and the canonical checkpoint; ordinary input and ambiguous tails still wait.
  A tail of finished native local commands is ancillary too: each command record
  directly follows native's own local-command caveat with the same prompt ID,
  optionally with its printed output, and a compaction summary hangs from a
  compact boundary in that tail. A command without the caveat expands into a
  prompt and still waits, as does any authored prompt or assistant output.

Owned Claude image-source annotations may use the exact parent timestamp or
the observed one-millisecond-later timestamp. The latter requires an immediately
adjacent physical parent, queueTranscriptOnly, identical native version, and all
existing signed packet, prompt, session, cwd, image ID/path and graph checks.
Apply this predicate consistently to completed tails and later delta decoding;
never drop arbitrary image-like text or infer a general timestamp tolerance.

Before capturing an authenticated owned image append, a native cache project
created with the observed 0755 mode is tightened to 0700 through a stable
no-follow owned directory descriptor. Its cache root must already be private;
reject symlinks, foreign owners and other modes. Keep exact asset byte and
append provenance checks, and preserve pending evidence on any failure.

Readable native compaction summaries plus complete continuation are supported.
Owned Claude history retains its complete authenticated prefix through a fresh,
explicitly linked native compaction. The observed single preserved SDK no-query
packet is accepted only with exact native identities, summary anchors and an
authenticated packet already present once in that prefix; it is not replayed.
Semantic baseline resets require a new boundary after an unchanged saved byte
prefix; checkpoints advance only on successful promotion. Opaque Codex summaries,
replacement histories, and general Claude preserved-segment chains remain blocked.
Native Claude originals (Desktop Local, CLI /compact) and owned histories the
user compacts from Desktop keep every earlier row in the file. By the
tolerance rule the retained-history reader checks only what would be a real
problem: something precedes the boundary in the same session and directory,
and a row the boundary names that is in the file is the last one before it
(otherwise earlier history is missing), the summary is readable and belongs
to the same session and directory, and no identity repeats with different
content. Claude Code 2.1.295 /compact after a completed turn was observed
naming a row it never wrote to the file; every row it kept still precedes the
boundary, so that is not missing history. How native flags the summary,
links it, or describes the
segment it preserved (preservedSegment, preservedMessages, in any shape) is its
own bookkeeping and is not compared.
Claude Code 2.1.295 /compact was observed appending, before its new boundary,
a second copy of rows of an earlier generation (same uuid, type, time and
message; relinked parent, new prompt ID and slug, emptied display tool
result, usage). In a native original such a copy is an inert placeholder at
its position and the first record stays the history. A reused identity with
any other difference is still ambiguous, and owned histories keep refusing
every repeated identity.
An owned history the user compacts from Desktop writes the same interactive
summary and keeps its complete prefix too, so it uses that same retained-prefix
proof. A queued summary (queueTranscriptOnly true) in an owned history is
Claudex's own context reset, a write, and keeps its exact form and the single
authenticated packet rule. Nothing is replayed.
The Local archival publisher skips an original left in its old project by a
Codex project move (no same-project continuation); other cwd mismatches fail.
Watcher status lists each blocked conversation once, even when several held
callers report the same global guard.

The observed Claude split-response parallel-tool graph is supported without
choosing a branch: require one request/response/model/session identity, ordered
apiBlockIndex records, unique tool IDs and exactly one native result per call,
matching sourceToolAssistantUUID, prompt, cwd and version. Only result and
PreToolUse hook rows may carry another absolute cwd, because a tool in the wave
(for example Bash `cd`) can move the native cwd before they are persisted. Validate one final
join and reject intervening authored input or alternate continuations. Only
virtual graph-validation parents change; native bytes, codec input, message
order and every tool record remain untouched. Saved semantic prefixes must
still match.
By user decision no fork is refused for its shape. The decoded history is the
branch ending at the last authored row, as in the native app. Where it forks
on a real user prompt (a rewind or an edited prompt) every sibling branch was
replaced and is left out. Elsewhere a sibling that is a tool result, or a
block of a response on the active branch, is the same wave of work and stays
at its physical position; any other sibling (a regenerated reply, an
abandoned prompt) was replaced and is left out. The exact parallel-tool and
streamed-wave proofs above only relink what they recognize; an unrecognized
wave is read in physical order. Real problems keep their own checks: a
missing parent, an unfinished or unpaired tool call (assertComplete), and a
replaced branch that held synchronized turns (the prefix check). Decoding the
local transcripts before and after a change to this must give identical
messages for every file that decoded before.
The observed empty-display successful PreToolUse hook attachment may occur
between results when its tool, native parent, session and pending-result position
all match. Its historical command/stdout remain inert and are never executed.
One response may stream later blocks after earlier tool results. CLI 2.1.284
persists a later block of the same response after a partial result while another
call still runs (the model cannot have seen that result). Require contiguous
response block indices, identical response identity, exact call/result pairing,
every result before the final join, and each block parenting the preceding
physical member. Only virtual result parents change; physical order is kept and
misparented continuations and competing joins remain blocked.

Claude 2.1.281 stores original input images under its private per-UID temporary
project/session image cache, but may persist resized previews in JSONL. When an
exact pending intent proves an original PNG/JPEG, retain its bytes once in the
content-addressed private image-assets store and bind the native preview hash.
Logical reads restore the original and validate the packet; native files are
never rewritten. Missing originals, altered previews or changed text fail closed.
Image bindings grow with actual image occurrences, not image-free sync rounds;
identical originals deduplicate across owners. The observed large PNG-to-JPEG
native preview is restored only with matching PNG/JPEG magic bytes, exact paste
identity, saved preview hash and original pending-intent hash. Regression and
isolated native checks cover roughly 5.5 MiB PNG/JPEG inputs, subsequent deltas,
restart and archived reconstruction. Archive assets are authoritative content,
not disposable rollback snapshots. Other format conversion and ambiguous cache
identities still pause synchronization.

The CLI also appends an `isMeta` image-source sidecar after an imported image
packet, including one text block per image on multi-image inputs (or the observed
single-block newline representation). It is excluded from logical history only
with the exact pinned text
format, matching parent packet, prompt ID/time/cwd, paste IDs and authenticated
packet. Other metadata or user text is retained. The native parent graph is
validated before this exclusion, and ambiguous codec identity mappings fail.
This keeps the following no-query placeholder and next delta on the same digest
chain without editing native files or resending an already persisted packet.

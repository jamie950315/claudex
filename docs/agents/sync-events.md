# Completion-event synchronization and adapters

Contributor rules moved out of AGENTS.md; they are binding. Scope: Hooks, the durable event inbox, watchers, initial verification scheduling, and the Codex/Claude adapter rules (late command completions, empty turns, native command envelopes).

## Adapters

Desktop synchronization is completion-event driven, not a recurring two-second
history sweep. Native Stop/lifecycle hooks publish bounded identity-only hints to
the private durable sync-events inbox and wake the owner through a private Unix
socket. Native SDK/app-server events join the same queue. Configuration events
recheck hook readiness and liveness. After a successful empty-scope publication
revokes archival commands, configuration-only passes with an unchanged ledger
reuse presentation without renewing manifest timestamps or proof lifetimes.
Pending recovery, changed state, native events and deferred/failed publications
still use normal publication. Known managed session registration and started events
never start a sync. Resuming an original reconciles that conversation for offline
completions. Hook definitions are merged with existing settings and require the
native Codex trust review; never bypass or forge trust receipts. Another tool or a manual edit may
put its handlers into an owned hook group. The exact owned handler still counts
as configured inside a group that is otherwise identical (same matcher, no
other fields); installation leaves that working group as written, removes only
a superseded owned handler from it and never adopts an altered handler or a
differently shaped group. CLI hooks install
and hooks status configure/inspect them; graphical setup installs them too.
Perform one startup/reconnection reconciliation, then sleep until an event.
Map exact native IDs, including preserved originals, to affected logical work.
Discovery may return only side/path. In event-filtered discovery, obtain a Claude
ID from its validated UUID filename and a Codex ID from its native header, then
pass that explicit nativeId into track so the adapter verifies the actual identity.
Recover an existing pending transaction first, preserve all write/history guards,
and acknowledge only the consumed inbox revision. Newer events survive a sync.
Completion-before-flush gets at most three event-scoped follow-ups at 250/1000/3000
ms and a completion-armed exact-file notification; started disarms streaming files.
Never infer completion from a hook alone or resend uncertain native input.
Socket notifications are primary: macOS fs.watch registration can lose events.
Use one OS watcher per parent directory with subscriber fanout; filesystem signals
are hints, never checkpoint or mutation evidence. Release retired subscribers and
recheck lifecycle after awaited path inspections. Anonymous directory signals use
exact-file metadata to suppress unchanged transcript hints; root/config/backend
signals must still check their exact target rather than discard unknown filenames.
A 30-second idle status heartbeat does no native history reads, discovery or
archival proof renewal. Scope Desktop
handoff history checks to event targets; empty scope revokes commands while keeping
validated presentation anchors. Test-only dependency injection retains the former
bounded polling harness, not a production fallback.

- Codex publishes only new independent rollouts and registers them with `thread/resume(path)`; no direct SQLite mutations or external-agent imports.
- Claude uses native resumable session projections with pinned `txcript` codecs.
- Filesystem events are hints; durable checkpoints and source identities determine work.
- Late native command completions and sub-agent notifications (a
  `SubAgentActivity` row native records on the turn that spawned the agent,
  whenever it arrives) are rendered at their proven arrival boundary
  without changing native turn grouping: the newest turn already closed when
  the completion row was written, idle or while a later turn was running. Closed
  means completed (also compaction-only, without a reply), failed with its
  error, or interrupted. A boundary not exported yet withholds the command until
  it is; a proven empty turn is skipped. A late item whose own closed turn
  lies after the last exported turn (a failed or interrupted tail) is outside
  that export and is proven when its turn is exported; an unknown turn inside
  the exported range still blocks. Require an exact stable raw/API item
  match and lifecycle proof, then authenticate the entire existing portable
  checkpoint. The checkpoint selects the representation: all native, all at
  their boundary, or the first arrivals native and the rest at their boundary.
  Row position is the arrival evidence; a completion time may precede its row
  but never follow it. Compare only fields the proof uses: unknown fields of
  any record are ignored, a time the rollout did not record is not a
  contradiction, and the projected item must still equal the API item. A
  command starts inside its turn; a notification has no duration and starts
  when it arrives.
  Rollouts readable by others are accepted; group or world write access is
  refused, as for the empty-turn reader. Keep image positions bound to
  exact native item identities. A rollover (the same thread continuing in a
  new segment, as after an edited message) is read through its declared
  history_base chain: every inherited segment passes the same stable read, is
  located only by its exact identity, contributes exactly the rows before its
  referenced ordinal with the byte offset inside the adjoining row, and joins
  the others by contiguous native ordinals, so a boundary and its completion
  may lie in different segments. A runtime that stops mid-turn (a backend
  restart) writes no closing record, so the next start follows a turn that is
  still open. That is not an overlap: the turn stays open, is never a
  boundary, and does not hide arrivals proven before it. The API reports it
  in progress while a later turn runs and interrupted once the thread is
  idle. An arrival whose newest closed turn lies before the open one, a late
  item of the open turn and any record closing it afterwards still block.
  Forked histories, overlapping lifecycles,
  redacted command text, late items of any other type and real history edits still
  block. Never drop a late result, rebase a checkpoint or repair native
  transcripts to clear a block.
  Request this extra proof only after normal API export fails its whole verified
  checkpoint match. Exact normal matches and initial enrollment retain their
  existing export path; do not impose proof-reader bounds on ordinary histories.
- Native completed turns with no full API items require independent stable
  rollout proof (`native-empty-turn.mjs`) before exclusion from dialogue. Match
  the turn's identities and times and find no activity. By the tolerance rule
  under Development the proof names what activity is and accepts everything
  else: a reply, reasoning, a tool call or output, a token or usage record, an
  item completion, a compaction, authored input (a user-role kind beginning
  `user.`, or unlabeled user text that is not a runtime frame), a completion
  with a message or an error, and any record anywhere in the file that names
  the turn outside its segment. Unknown records, events, state fields,
  context kinds, triggers and extra fields are context. Identity stays
  exact where it is recorded: turn, root, thread and cwd, and a time the
  rollout records must equal the API's. Before changing this, run the proof
  over real rollouts in both directions: every empty turn accepted and no
  turn with activity accepted.
  Compare raw proof across both history reads. Empty controls never close a
  pending request, fabricate a reply, alter checkpoints or authorize history writes.
  An all-control new chat still waits for its first real completed dialogue.
- Imported history must not loop back as newly authored history.
- Native user slash-command and skill-invocation records can omit stdout. Decode only
  unpaired, identity-bound native string command envelopes as inert full text;
  never synthesize tool results or exempt actual assistant tool calls from
  completion checks. Support native name-first and message-first envelopes,
  including indentation, without changing the retained original text.
  Paired commands (including verified reset transport) retain
  their existing canonical representation. Late or rewritten output still obeys
  normal unpaired-result and checkpoint-conflict guards.

In completion-event mode, initial verification reads each scheduled conversation
normally but does not repeat full reads or broad discovery because streaming file
metadata changed. Between startup checks, inspect bounded durable event metadata
and service at most one exact completion/session target, with fair ordering and
revision rechecks. Only consumed revisions are acknowledged; started, control and
newer events survive. Unknown-source discovery is exact-key and revision-bounded.
Retain the old activity-interleaved scheduler only for the injected non-event
harness. Do not defer all new completions until a long cold sweep finishes.

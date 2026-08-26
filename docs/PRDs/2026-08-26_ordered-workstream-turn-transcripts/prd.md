# Ordered, range-addressable work-stream turns

> Created 2026-08-26.
>
> Preserve model-turn order across assistant text and tool activity, and require
> the same gap-aware durable transcript substrate wherever the work-stream
> harness saves a replayable LLM conversation. Add durable response, plugin,
> tool, and observable-thinking timing without server clock ticks, plus a
> lossless reconstruction of Bind's exact loop state; the automation wizard
> remains a separate change. Companion:
> [state](state.md). Subsystem references:
> [agent harness](../../agent-harness.md),
> [work-stream Durable Objects](../../workstream-durable-object.md),
> [streaming reveal](../../streaming-reveal.md), and
> [transcript scrolling](../../transcript-scrolling.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

The work-stream feed uses one durable, ordered transcript contract for live
streaming, canonical history, reconnect, model replay, and paginated loading.
Its ordering unit is a model turn rather than a whole harness run. An assistant
turn has a stable identity and contains ordered text and tool-call blocks; tool
results update their matching blocks without moving them. A later assistant
turn is a later transcript turn even when it belongs to the same run.

That contract is a shared durable LLM-transcript substrate, not logic private to
the desktop route. Within the work-stream/harness architecture covered by this
PRD, every Durable Object that authoritatively saves an ordered LLM conversation
for later continuation or replay must compose the substrate and expose its
range/coverage contract. Today the transcript authority is `SubstreamAgent`. A
future in-scope transcript-owning Durable Object joins the same contract rather
than creating another opaque message array.

The backend also describes exactly which half-open turn ranges each response
covers. The desktop merges those ranges into a coverage set, so it can tell the
difference between a loaded interval, an intentional tombstone, a range not yet
requested, and a newly arrived realtime turn beyond the original snapshot.

On first open, the same boot/snapshot response carries two named range slices:
the first unread turn with up to five turns before and five after it, and the
five latest turns in the work stream. The first slice makes the reader's return
position paint immediately; the second makes **Jump to latest** instantaneous.
The uncovered middle remains an explicit gap and loads lazily as scrolling
approaches it.

Text still reaches the feed token by token. Parallel tools still start and
settle independently. The change is where those events attach and how their
durable order is represented, not a conversion of streaming or tool execution
into a serialized batch.

The same contract adds participant-visible activity timing. The response
execution envelope and each plugin block receive durable working-started and
working-stopped edges; an observable provider reasoning item receives thinking
edges. While an edge is open, the desktop advances **Working for …** or
**Thinking for …** from a local monotonic clock. The backend does not stream
clock ticks. Every active interval also carries its authoritative UTC start;
first join and reconnect snapshots carry the UTC observation time and elapsed
baseline, so a client joining work already in progress paints prior elapsed time
immediately before continuing locally. Once stopped, the authority supplies the
canonical duration used for **Worked for …** or **Thought for …** on every
historical load.

The substrate also owns a restricted, lossless model-protocol projection. At
every accepted Bind loop boundary, Rally must either durably store the exact
ordered message state Bind uses or durably store lossless ordered parts whose
versioned projector recreates that state with perfect semantic accuracy. The
participant feed is an authorized projection of the same committed facts, not
the source from which private protocol-only messages or model-facing derivatives
are guessed.

## Terminology and definitions

These terms are normative. A persisted record has one explicit kind; callers
may not choose a different classification based on the provider role or whether
the content would be useful in the participant feed.

- **Participant transcript turn:** a top-level item in the canonical
  participant-visible work-stream projection, returned only after reader
  admission. It has a stable `turn_sequence` and may contain ordered text,
  thinking, and tool blocks. It is not filtered or re-authorized row by row and
  is not the source of truth for reconstructing private Bind state.
- **Reader admission:** the single authorization decision for one external
  transcript read operation or admitted socket. It binds the reader to the
  authenticated session/membership generation, workspace, work stream,
  substream, participant/scope epochs, and regional authority. Every range
  slice, active checkpoint, lifecycle record, and bulk hydration within that
  operation reuses the same admission.
- **Bind loop state:** the complete ordered, post-healing provider-message array
  Bind will submit at a model-call boundary, or the complete ordered array after
  Bind accepts an assistant or tool-result transition. It includes the current
  system projection and every active non-system message.
- **Protocol-only message:** an exact non-system message created by the harness
  for loop control or private protocol context, recorded with
  `origin_kind = protocol` and no participant/source-event identity. Examples
  are a continuation nudge and a compaction-summary checkpoint encoded with a
  `user` role. A provider role such as `user` does not make it a participant
  turn.
- **Model-facing derivative:** an exact non-system provider message or wrapper
  produced from another durable product fact, recorded with
  `origin_kind = derived` and a required source-event, source-turn, or tool
  receipt identity. Examples are the provider-facing form of recalled memory, a
  scheduled trigger, a human interrupt, or a tool result. The durable source and
  the member-visible rendering do not substitute for this exact wrapper.
- **System projection:** the single leading system message rendered from durable
  versioned prompt inputs, authorization state, and plugin/skill activation
  revisions. It is neither a protocol-only message nor a model-facing
  derivative and is not appended to `loop_sequence`. Loading or unloading a
  plugin or skill durably advances the system-projection revision before Bind
  uses the replacement head.
- **Lossless reconstruction / perfect semantic accuracy:** canonicalizing the
  substrate projection and the Bind array at the provider boundary produces the
  same ordered encoding and hash. Message order, content-part order, roles,
  names, IDs, exact strings, and provider continuation fields are significant;
  JSON object-key order is not.

The classification boundary is provenance: a derivative must point to the
durable fact it wraps; a protocol-only message is itself the durable harness
control fact. The system message always uses the separate system-projection
contract. No record can be both protocol-only and derived.

## Motivation

The current work-stream transcript has three different ordering models:

1. Bind processes an ordered sequence of assistant messages and tool-result
   messages. An assistant message may contain text and one or more tool calls.
2. The work-stream host immediately persists tool activity as individual
   transcript rows, but concatenates text from every assistant turn in a run
   into one run-level `content` value and persists one assistant message only
   when the run terminates.
3. The desktop streams that combined content into one transient assistant row
   keyed by the harness run. Realtime tool rows are attached before that active
   row, regardless of which model turn produced them.

Those choices erase the boundary the model actually used. Given this provider
history:

```text
assistant: text A + tool 1
tool:      result 1
assistant: text B + tool 2
tool:      result 2
assistant: final C
```

the member can see both tools followed by one assistant bubble containing
`text A + text B + final C`. A cold reload reproduces the same distortion
because canonical storage has already lost the assistant-turn boundaries. The
model-protocol replay assembled for a later run is therefore not a faithful
projection of the history that the provider originally processed.

This is not primarily a renderer placement bug. Flipping a tool card from
`before_anchor` to `at_anchor`, or sorting current rows differently, cannot
recover boundaries that were collapsed before the final assistant row was
written. The durable transcript has to represent the causal unit the model
produced.

History loading has a related ambiguity. A page returns rows and continuation
cursors, but the desktop has no first-class statement of which sequence
interval was inspected. When independently requested blocks are combined with
socket arrivals, absence can mean not loaded, no visible turn existed, a turn
was retracted, or a response was shortened. Inferring coverage from the first
and last returned rows or from the row count makes those cases
indistinguishable and can create silent holes or repeated fetch loops.

Fixing only the work-stream REST response would leave the underlying transcript
substrate undefined and the next durable work-stream agent surface free to
reproduce the same pagination failure. The range contract therefore belongs
beside the canonical turn store used by `SubstreamAgent`, below REST, socket,
model replay, and desktop projections.

Timing has the same live-versus-history problem. Today execution timestamps and
durations exist in operational run and tool ledgers, but they are not an ordered,
participant-visible transcript contract. Recomputing a live label from repeated
server strings would waste traffic and drift after sleep or reconnect; deriving
history from whatever lifecycle rows happen to remain would make the live and
cold-load views disagree. Timing therefore needs durable lifecycle edges and a
canonical terminal duration beside the turn and tool identities they describe.

Bind itself maintains the exact ordered `state.messages` array while a run is
executing, but that array lives only in the Worker isolate. Rally currently
initializes it from a projected transcript, concatenates every completed
assistant message into one host string, persists tool lifecycle rows separately,
and discards the array when the run ends. A compaction replaces the live array
with a summary checkpoint. The correct history therefore exists transiently,
but the current host boundary does not make it a durable product invariant.

The current open/snapshot path can already verify the session at the object
boundary and then enter product methods whose detail and message reads each
authorize again. Adding unread and latest ranges above that shape could turn one
open into several serial regional authorization round trips. This PRD must
remove that multiplication: authorization is an operation-level admission, not
a turn, block, slice, or hydration loop.

## Goals

1. Render assistant narration and tool activity in the order of the original
   model protocol, during the run and after a cold reload.
2. Preserve immediate response-text token streaming, route-reset behavior,
   smooth reveal, scroll following, reconnect, canonical reconciliation, and
   first opening of a work stream while its response is already streaming.
3. Allow independent tools from one assistant turn to start, complete, or fail
   in parallel while their cards remain in the model-declared order.
4. Make the durable substrate sufficient to recreate, with perfect semantic
   accuracy, the complete ordered message state Bind used at every accepted
   model-call boundary and the state produced by each accepted assistant/tool
   transition. Store the exact state when lossless reconstruction from parts
   cannot be proven.
5. Let a client load arbitrary blocks of complete turns and compute every gap
   inside a known snapshot without inferring coverage from returned content.
6. Deliver both initial range slices in the first work-stream boot/snapshot
   response: the first unread turn with up to five preceding and five following
   turns, and the five latest turns. Opening at unread and jumping to the bottom
   must require no follow-up fetch before those messages can paint.
7. Put turn persistence, snapshot fencing, range scanning, actual-coverage
   reporting, tombstones, and canonical model projection in one shared durable
   transcript substrate rather than reimplementing them in each route.
8. Require every in-scope Durable Object that saves an authoritative replayable
   LLM transcript to use that substrate. The current required adopter is
   `SubstreamAgent`; REST, socket, replay, and desktop paths may not implement
   competing notions of coverage or model-loop reconstruction above it.
9. Keep turn identities and sequence positions stable across retries,
   reconnects, tool lifecycle updates, pagination, and realtime delivery.
10. Preserve regional authority and each transcript surface's existing
    visibility rules.
11. Show live and historical elapsed wall-clock time for the full response and
    for each plugin activity block, including correct behavior when plugins or
    calls execute in parallel.
12. Send only lifecycle edges and authoritative first-join/reconnect baselines
    for timing. Every active interval includes its UTC start, and every snapshot
    includes its UTC observation time plus elapsed-at-snapshot; the desktop then
    advances the label from a local monotonic clock without server clock ticks or
    interference with response-text token streaming.
13. When a provider exposes an observable reasoning item, render a separate,
    ordered, generically labeled thinking block with the same live and historical
    timing guarantees, without exposing private chain-of-thought.
14. Keep restricted protocol-only messages and model-facing derivatives—such as
    compaction replacements, synthetic nudges, trigger/memory wrappers, interrupt
    wrappers, exact model-facing tool results, and provider continuation
    envelopes—durable without exposing them through participant range bounds or
    feed payloads. Recreate the system message from durable versioned prompt and
    plugin/skill activation state.
15. Prove the lossless projection continuously: before each provider call, the
    canonical reconstruction and Bind's post-healing message array must have the
    same ordered canonical encoding and hash.
16. Deliver the complete happy-path, edge-case, failure-injection, recovery, and
    visible-desktop test suite specified in this PRD. The implementation is not
    complete when behavior exists without its named test objective, required
    assertions, correct runtime layer, and proof that the new test fails when
    the protected production behavior is deliberately broken.
17. Keep transcript-read authorization cost constant with respect to returned
    turns, blocks, gaps, and initial slices. A REST boot/range operation performs
    one reader admission; unread, latest, active-state, coverage, and hydration
    reads reuse it. An admitted socket snapshot reuses its epoch-fenced admission
    until revocation invalidates and closes that admission. No per-turn or
    per-block authorization calls or regional authorization joins are allowed.
    Session, membership, participation, or scope revocation invalidates the
    admission rather than waiting for a row-level recheck.

## Non-goals

1. **Change the automation-wizard feed or its saved transcript.** The wizard is
   the one explicit exception to this PRD's transcript-substrate adoption. Its
   persistence, range loading, streaming, interleaving, migration, and UI will
   be handled in a separate PR; nothing here changes
   `automation_subscriptions.draft_conversation_json` or its owning paths.
2. **Change model prompts, route selection, plugin availability, tool
   authorization, or tool execution semantics.** Tool calls remain proposals
   subject to the current receipt, authority, and idempotency contracts.
3. **Serialize parallel tools to make display order easy.** Display order comes
   from the assistant turn's declared call indexes, not completion timing.
4. **Write canonical transcript content on every token.** The bounded active
   stream checkpoint remains the recovery mechanism while a turn is open; the
   canonical turn commits at the model-turn boundary.
5. **Guess historical interleaving without complete evidence.** A legacy Global
   run may be backfilled when its raw inference records, accepted turn IDs, and
   durable tool receipts form a complete, internally consistent protocol and
   reconcile with its stored aggregate text. A run with missing evidence remains
   visibly legacy; Rally does not infer placement from timestamps. The Global
   inference archive is migration evidence, never a runtime transcript
   dependency, and EU runs without such evidence are not fabricated.
6. **Introduce cross-work-stream transcript search, a global transcript index,
   or cross-region transcript movement.** The owning `SubstreamAgent` remains
   authoritative.
7. **Make compaction delete or reorder the durable participant transcript.**
   Compaction continues to affect model context only.
8. **Define new defensive page, duration, tool, or token ceilings.** Existing
   reviewed transport bounds remain in force. Any new number requires its own
   product decision.
9. **Provide a point-in-time snapshot of mutable tool status.** A snapshot
   freezes turn membership and order; authorized lifecycle revisions may
   continue to update those turns.
10. **Treat every stored sequence of text as an LLM transcript.** Note
    speech-to-text segments, inference-lakehouse request/response captures,
    compaction checkpoints, active-output checkpoints, and final derived block
    results are not authoritative replayable conversations and do not adopt the
    range substrate merely because they contain model-related text.
11. **Stream elapsed-time strings or clock ticks from the backend.** The backend
    sends authoritative start, stop, snapshot-baseline, and revision data. The
    desktop owns presentation ticking while an activity is open.
12. **Claim CPU time, provider-billed time, or summed child duration.** These
    labels describe participant-observed wall-clock intervals. Overlapping
    plugin or tool calls do not make the full-response duration grow twice as
    fast.
13. **Infer or reveal hidden chain-of-thought.** Rally does not fabricate a
    thinking block from generic response latency, display raw reasoning text,
    decrypt encrypted reasoning, or relabel ordinary provider wait time as
    thinking.
14. **Require a duplicated full-array snapshot after every mutation.** A
    normalized append-only protocol ledger plus exact replacement checkpoints is
    acceptable when its projector is versioned and proven lossless. The
    requirement is equality with Bind state, not one prescribed physical shape.

## Product behavior

When an assistant explains what it is doing, calls a tool, explains the result,
and calls another tool, a participant sees that same sequence. Text emitted
before a tool remains above that tool. Text from the next model turn begins a
new assistant turn below the preceding tool activity. The final response is not
merged into earlier narration merely because all three turns share one harness
run.

Within one assistant turn, tool cards appear in the call order declared by the
model. If tools run concurrently, each card changes independently from planned
to running and then to completed or failed. A fast later call does not jump
ahead of a slow earlier call. A stale start or completion event cannot regress a
newer terminal state.

Response text remains visible as it arrives. Committing the finished turn
reconciles the existing transient row in place; it does not replace the row,
restart its reveal animation, move the viewport, or wait for the whole run.
Route fallback resets only the abandoned text for that model turn and retains
already committed turns and tool cards.

On a first open while a response is already streaming, the boot snapshot paints
the active turn's accumulated checkpoint, ordered text/tool/thinking blocks,
current lifecycle revisions, and activity baselines before accepting catch-up
frames. It also returns a socket event fence from the same snapshot. The client
then applies only newer frames, so opening mid-stream neither starts from an
empty bubble nor duplicates the boundary token or tool update. Reconnect uses
the same snapshot-plus-fence rule. On cold reload after completion, the feed
reads the same canonical turn and block structure used by live delivery. These
paths therefore converge on one ordering rather than applying separate
placement rules.

### Working, worked, and thinking timing blocks

The response started by a participant turn has one response-level activity
indicator. It changes to **Working for …** when the harness run is admitted and
actually begins work, excluding time spent queued before execution. It stops
only after the final assistant turn is canonically committed, when one exists,
and the run reaches a terminal outcome. A run that pauses for member input,
cancellation, or another non-working state closes its current interval;
resumption opens a new interval. The live label shows the sum of completed
intervals plus the locally advancing active interval. History shows that
canonical sum as **Worked for …**.

Durations render at whole-second precision in the compact style shown by
**Working for 7m 42s** and **Worked for 7m 42s**. The desktop may refresh only
when the displayed value changes and must not make every tick an assistive-live
announcement; the authoritative start/stop lifecycle remains accessible.

Each plugin activity block follows the same rule. It starts when the first tool
invocation in that plugin block actually starts and stops when every invocation
declared for that block has completed, failed, been cancelled, or reached an
ambiguous terminal receipt state. Multiple invocations from the same plugin in
one assistant turn form one plugin block; a later assistant turn creates a new
block so intervening narration remains in the right place. For parallel calls,
the plugin duration is the wall-clock union from the earliest child start to the
last child settlement, not the sum of child durations. Different plugin blocks
may be active at the same time, while the response-level timer advances only
once. Individual invocation timestamps remain available to render or diagnose
each tool card, but do not control its display order.

The backend emits one monotonic-revision `activity_started` edge for each opened
interval and one `activity_stopped` edge for every normal or abnormal terminal
transition. It never emits periodic elapsed-time updates. The desktop snapshots
its local monotonic clock when it receives an active interval and updates the
formatted label locally. The edge includes the interval's authoritative
`startedAtUtc`. A first-join, reconnect, or canonical snapshot includes that
same start, a server-generated `snapshotAtUtc`, and authoritative
`elapsedMsAtSnapshot`. The desktop initializes or rebases to the elapsed
baseline—thereby including work before it subscribed—and advances from its
local monotonic receipt point. It does not derive the canonical baseline solely
from `Date.now() - startedAtUtc`, because client/server wall clocks can disagree.
The UTC values preserve the real chronology and allow consistency checks; the
server-computed elapsed baseline is authoritative for display. The stop edge
supplies authoritative `durationMs`, `startedAtUtc`, and `stoppedAtUtc`, after
which the local clock is no longer consulted. Duplicate or late edges are
ignored by revision.

When the provider exposes an actual reasoning output item, it appears as a
separate ordered thinking block. Its live label is **Thinking for …** and its
terminal label is **Thought for …**. The interval starts on the first normalized
reasoning-item, reasoning-summary, or reasoning-detail event and normally stops
on that item's done boundary. When a provider streams reasoning details without
an explicit done event, the adapter closes the interval at the next
non-reasoning output boundary or response terminal and records that the boundary
was normalized. No observable reasoning start means no thinking block, even if
the provider took a long time to return ordinary output.

This is supported by current provider protocols, with different fidelity. The
[OpenAI Responses streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming)
defines reasoning output items plus reasoning-summary and reasoning-text stream
events with added/delta/done boundaries. The
[OpenRouter reasoning-token guide](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
defines ordered `reasoning_details`, including streamed summary, encrypted, and
raw-text variants, while noting that some models do not return reasoning tokens.
Rally normalizes only the lifecycle evidence common to those protocols. The
member-visible block remains generic and timed; provider summaries, raw text,
encrypted bytes, and signatures are not displayed as chain-of-thought.

A history request asks for a half-open range of top-level turn sequences. For
example, `[1, 21)` means turns 1 through 20, and `[21, 41)` means turns 21
through 40. Each response says which interval the server actually inspected.
The desktop unions those intervals and can show or request the complement as
known gaps. Empty covered ranges and retracted tombstones count as covered;
they do not cause an endless request for rows that will never appear.

Realtime delivery extends coverage one turn at a time. Receiving turn 88 says
that `[88, 89)` is present; it does not imply that turns 41 through 87 were
loaded. A participant can therefore move among older pages, a live tail, and a
reconnected snapshot without the client silently treating an unobserved middle
as complete.

### First-open dual-range loading

The initial authorized `SubstreamAgent` boot/snapshot returns two independently
described slices from one transcript snapshot:

1. **Unread slice.** When the unread high-water anchor—represented by
   `firstUnreadSequenceNumber` today—exists, include that anchored turn, up to
   five preceding displayable turns, and up to five following displayable
   turns. Clip naturally at the beginning or snapshot end. When there is no
   unread turn, this named slice is `null`; the work stream opens on the latest
   slice.
2. **Latest slice.** Include the five latest displayable turns at or below
   `snapshotThroughSequence`, clipped when the transcript contains fewer than
   five.

Each slice carries its own actual half-open `coverage`, even when the two slices
overlap or touch. The desktop upserts turns by stable turn ID and unions the
coverage intervals, so overlap never creates duplicate rows. It retains both
loaded islands rather than discarding the latest slice when it initially draws
the unread slice.

The five-message counts refer to displayable top-level transcript turns, the
canonical message unit after this migration. Nested text and tool blocks do not
consume additional positions in either prefetch count.

If a response is active when the work stream opens, its reserved active turn is
included in the latest slice with its accumulated checkpoint revision and
stream epoch. The same boot response includes the active response/plugin/tool/
thinking lifecycle revisions, UTC timing baselines, and
`resumeAfterEventSequence` captured at the snapshot boundary. The unread slice
may still be the initial viewport, but the active latest island is ready for an
instant **Jump to latest**. Neither the active checkpoint nor its event fence
claims coverage for any otherwise unloaded middle range.

If unread is outside the latest slice, the interval between them remains a
known gap. Approaching either edge through virtualized infinite scrolling asks
only for the missing adjacent range and preserves the reader's visible anchor
as turns are inserted. Pressing **Jump to latest** (the go-to-bottom action)
switches immediately to the already loaded latest slice, without waiting for a
network request and without pretending the middle gap was loaded. Scrolling
upward from there lazily fills that gap. Realtime turns arriving after the
snapshot extend the latest island through their singleton coverage and remain
immediately reachable by the same action.

Tombstones encountered while selecting either slice count as covered sequence
positions but not as one of the requested displayable turns. Existing encoded
response bounds may shorten a slice; if they do, its returned `coverage` and
turn count describe only what was actually scanned and loaded.

## Impact on the product contract

None—this makes the existing Rally work-stream contract truthful across live
and historical views. It does not change who participates, what an agent may
do, what a tool result means, or which content a participant is authorized to
see. It makes the order shown to a participant match the order the agent used.

## Decision log

None yet.

## Key design decisions

1. **Make a model turn the top-level durable ordering unit.** A harness run is
   an execution envelope that may contain many assistant turns and tool-result
   exchanges. It is not a display row. The rejected alternative was retaining
   one assistant row per run and trying to splice tool cards into substrings of
   mutable text; that creates synthetic anchors the provider never supplied and
   still cannot make durable replay exact.
2. **Keep ordered blocks inside each assistant turn.** An assistant turn owns
   ordered text blocks and tool-call blocks. Tool results are lifecycle data on
   the corresponding call and project back into model-protocol `tool` messages
   after that assistant message. The rejected alternative was making every text
   fragment and tool state a top-level transcript row, which would expose
   transport batching as product order and let a page split one semantic turn.
3. **Reserve the turn before inference.** Before a provider request begins, the
   owning object allocates the stable participant-visible sequence and turn ID
   for `(run ID, model-turn index)`. Streaming frames, retries, the canonical
   commit, and later tool updates all address that identity. The rejected
   alternative was assigning order only after completion, when concurrent
   socket events have already needed an anchor.
4. **Commit the assistant turn before dispatching its tools.** Provider
   completion atomically records the canonical text blocks, all declared tool
   blocks in call-index order, and their durable execution plans before any tool
   begins. This prevents an observable tool start from preceding the assistant
   turn that proposed it and preserves the existing rule that effects are
   planned durably before execution.
5. **Separate stable order from mutable lifecycle.** `turnSequence` and block
   indexes never change. Every tool invocation carries a monotonic revision;
   `started`, `completed`, `failed`, and ambiguous-effect updates apply in place
   only when newer. Parallel timing therefore changes status but never order.
6. **Keep active streaming separate from canonical content.** Coalesced token
   frames and the bounded active-output checkpoint continue to provide low
   latency and hibernation recovery. A `turn_committed` event upserts the same
   desktop entity and reconciles canonical content against received stream text.
   The rejected alternatives were delaying display until commit and performing
   one SQLite canonical-content write per token.
7. **Describe coverage explicitly as half-open ranges.** The server returns the
   interval it scanned, independent of the number or sequence span of turns in
   the payload. Half-open ranges compose without overlap ambiguity and support
   a normal range-set union/complement. The rejected alternative was inferring
   coverage from cursors or returned rows, which cannot distinguish empty,
   retracted, filtered, and unrequested positions.
8. **Fence page membership by transcript sequence, not mutable status.** The
   first request establishes `snapshotThroughSequence`; subsequent range reads
   are bounded by it. New turns arrive beyond the fence through realtime or a
   new snapshot, while lifecycle revisions may update already known turns. The
   rejected alternative was freezing a copy of every tool status, which adds a
   second history authority without improving transcript order.
9. **Prefetch unread context and the live tail together.** One initial
   boot/snapshot returns the unread-centered `5 + anchor + 5` slice and the five
   latest turns from the same snapshot fence. The rejected alternatives were
   fetching the latest slice only after **Jump to latest**, which makes the
   action network-bound, and downloading the entire interval between the two
   slices, which delays first paint and defeats gap-aware lazy loading. These
   counts are product-selected prefetch sizes, not defensive ceilings.
10. **Implement the contract once in the durable transcript substrate.** The
   substrate owns stable turn/block identities, sequence allocation, snapshot
   fences, range scans, actual coverage, tombstones, and model-protocol
   projection. `SubstreamAgent` and any future in-scope transcript-owning
   Durable Object supply their authority and visibility policy through adapters.
   The rejected alternative was duplicating range arithmetic and transcript
   reconstruction in each route or object, which would make equal gaps mean
   different things on different agent surfaces.
11. **Use an audience-specific sequence domain.** Private model instructions,
   operational events, and rows a participant could never read do not consume
   advertised turn positions. Coverage metadata is therefore not a side
   channel for hidden internal records. A tombstone occupies a position only
   when a previously participant-visible reserved turn produced no displayable
   content or was retracted.
12. **Backfill only from a complete protocol proof.** Eligible legacy Global
    runs are deterministically rebuilt from accepted raw inference turns and
    durable tool receipts, then reconciled against the stored aggregate text and
    tool cardinality before becoming canonical. Every other legacy run retains
    its stored ordering through a legacy envelope. The rejected alternative was
    heuristically distributing old text around tool timestamps, which would turn
    an unprovable guess into canonical history.
13. **Signal activity edges; do not stream a clock.** Durable start/stop edges
    and snapshot baselines make the backend authoritative about work while the
    desktop's monotonic clock makes the active label smooth and cheap. The
    rejected alternative was emitting a new string or token every second, which
    couples presentation cadence to transport health and competes with response
    text streaming.
14. **Measure wall-clock interval unions, not child sums.** Response timing is
    the union of its working intervals. A plugin block spans its earliest child
    start through its last child settlement. This preserves the time a member
    actually waited when tools overlap; adding parallel child durations would
    overstate elapsed time.
15. **Keep response, plugin, and invocation timing at distinct scopes.** The
    response execution envelope owns the full-response total, each ordered
    plugin block owns its group duration, and each tool invocation retains its
    own lifecycle timing. The rejected alternative was deriving every label
    from one run total or one tool row, neither of which can represent parallel
    work truthfully.
16. **Create thinking blocks only from provider evidence.** Provider reasoning
    events establish a generic timed block and its order. Rally does not infer
    reasoning from silence or display provider reasoning payloads. The rejected
    alternative was treating all pre-text latency as thinking, which would
    mislabel queueing, network delay, moderation, and provider work that the
    protocol does not identify.
17. **Keep participant order and model-protocol order as separate projections of
    one authority.** Participant `turn_sequence` excludes private protocol-only
    messages and model-facing wrappers; restricted `loop_sequence` includes every
    non-system message Bind consumes or accepts. The current system message is a
    versioned projection of durable prompt inputs and activated plugins/skills.
    The rejected alternatives were leaking private rows through feed coverage
    and rebuilding model state from an intentionally filtered UI view.
18. **Persist accepted protocol transitions before Bind advances.** The exact
    accepted assistant message and declared tool calls become durable before any
    tool dispatch; each exact model-facing tool result becomes durable before
    Bind receives it; a compaction replacement becomes durable before the old
    active generation is discarded. A failed required write fails the run. The
    rejected alternative was reconstructing these facts after completion from
    callbacks that had already flattened them.
19. **Prove reconstruction at the provider boundary.** The substrate defines a
    canonical message encoding and hashes both its reconstruction and the
    post-healing ordered array Bind is about to submit. A mismatch is a protocol
    integrity failure and prevents inference. The rejected alternative was
    relying on unit tests alone while runtime projection code, prompt rendering,
    or stored schemas could drift independently.

## Data model

The shared durable transcript substrate is a storage/projection component, not
a new global authority. It runs inside the Durable Object that already owns the
conversation and uses that object's SQLite transaction, authorization, region,
and lifecycle. No cross-object transcript database is introduced.

The required authority inventory at the time of this PRD is:

| Saved LLM conversation | Authority | Scope in this PRD |
| --- | --- | --- |
| Work-stream main feed and any future independently addressable substream | `SubstreamAgent` | In scope: replace direct `parts` pagination/projection with canonical turns, blocks, range coverage, and a restricted lossless Bind-loop projection. |
| HyperSight execution | Source `SubstreamAgent` | In scope through its source transcript. `BlockDashboardAgent` stores only derived dispatch/output state and does not create a second transcript. |
| Automation-creation draft conversation | `WorkspaceDO` | Explicitly out of scope: a separate PR will migrate its saved transcript, range loading, streaming, and UI. |

**Within the work-stream/harness architecture, wherever Rally saves an
authoritative ordered LLM conversation for later continuation or replay,
adopting this substrate's participant-range and lossless-loop contracts is in
scope and mandatory.** Saving such a conversation in an object-local JSON blob,
bespoke table, or cursor-only API outside the substrate is not a conforming
implementation. The automation wizard is the sole explicit exception in this
PRD and moves in its separate PR.

### Restricted Bind loop projection

The substrate stores a restricted model-protocol record alongside the
participant transcript. It is not returned by participant history APIs and does
not use `turn_sequence`. Its job is to make the state Bind actually consumes and
produces durable across Worker loss, retry, code deployment, and compaction.

At run initialization, Rally persists the exact post-healing ordered non-system
message state that will seed Bind, or lossless ordered components that project
to it. This includes every protocol-only prompt-context message and model-facing
derivative in addition to participant-derived history. The system message is the
deliberate exception to payload storage: Rally recreates it from durable prompt
inputs, authorization state, activated plugin/skill revisions, and a versioned
renderer. Loading a plugin or skill advances that projection and replaces the
head system message just as Bind does today. A template name or a reference to
whatever rendering code is current is insufficient. The recorded renderer
version and inputs must reproduce the selected revision byte-for-byte at the
provider boundary, and historical renderer versions remain available for as
long as their loop generations are replayable. A plugin or skill activation
must durably commit `system_projection_changed` before Bind may use the newly
rendered head.

Thereafter the record is an ordered protocol ledger. Conceptual transitions are:

- `state_initialized`: the exact post-healing initial non-system generation plus
  the system-projection revision used to create its head message.
- `system_projection_changed`: the durable prompt-input, authorization, and
  plugin/skill activation revisions plus renderer version needed to recreate the
  new system head after an authorized runtime activation.
- `assistant_accepted`: the complete accepted provider assistant message,
  including exact content-part order, tool-call IDs, tool names, argument
  strings, refusal fields, and any opaque provider continuation/reasoning fields
  Bind must replay.
- `tool_result_accepted`: the exact model-facing tool message, including role,
  tool-call ID, content-part order, and exact serialized content. This is not the
  raw provider response or the separately sanitized member card.
- `protocol_user_appended`: an exact protocol-only or derived user message such
  as a self-bounded continuation nudge, memory/trigger wrapper, or the
  model-facing wrapper around a drained human interrupt, with its provenance and
  any participant-source identity.
- `state_replaced`: an exact compaction replacement plus its source revision and
  checkpoint metadata. It starts a new active loop generation without deleting
  the immutable earlier transitions or the participant transcript.

Each transition has a stable `loop_id`, `loop_generation`, monotonic
`loop_sequence`, `state_revision`, transition kind, exact protocol payload or
lossless content-addressed reference, projector version, source turn/receipt
identity where applicable, and a canonical payload hash. JSON object property
order is not meaningful, but message order, content-part order, roles, names,
IDs, exact strings—including tool argument/result strings—and provider-defined
ordered continuation fields are meaningful and must survive round-trip.

An out-of-line payload is lossless only when it is immutable, region-local,
content-addressed, transactionally linked before Bind advances, and retained for
at least as long as the loop state claims to be replayable. A missing or changed
payload is a protocol-integrity failure; Rally may not substitute a summary,
display payload, placeholder, or newly fetched provider result and still claim
perfect reconstruction.

Before every provider request, the substrate renders the selected system
projection, prepends it to the exact active non-system generation, and applies a
named loop-projector version. Rally canonicalizes that full projection and the
post-`validateAndHealMessages` array Bind is about to submit, then requires:

```text
canonicalize(project(loop_id, state_revision))
  = canonicalize(bind_messages_at_request_boundary)
```

The request-boundary record stores the loop revision, system-projection revision,
renderer/projector versions, and both hashes. For newly canonical state, the
healer changing the reconstructed array is itself a mismatch; legacy input may
be healed once only as part of `state_initialized`, after which the healed output
is the durable baseline. A mismatch fails before provider inference rather than
silently allowing Bind and the durable transcript to fork.

Failed or abandoned provider attempts, partial response bytes, and route-reset
text do not enter the accepted Bind loop state because Bind did not accept them
into `state.messages`. They remain attempt/stream recovery evidence. A successful
assistant message becomes durable before `callModel` returns it to Bind, and an
exact tool-result message becomes durable before `runToolCall` returns it to
Bind. Parallel tools may settle in any order, but their accepted protocol
messages project in the call order Bind uses.

The Global raw-inference lakehouse may seed a one-time or background legacy
backfill, but the live projector never queries it. A backfill promotes a legacy
run only after proving one accepted successful response per Bind turn, stable
turn/call ordering, complete required payloads, agreement with durable receipts,
and equality with the stored aggregate assistant text and tool count. Capture
gaps, retention gaps, ambiguous attempts, or absence of an EU archive leave the
run in its honest legacy envelope.

### Participant transcript projection

Each owning authority stores one audience-visible transcript turn with these
conceptual fields:

- `turn_id`: stable opaque identity.
- `turn_sequence`: monotonic sequence allocated once and never reused.
- `role`: `human`, `assistant`, or participant-visible `system`.
- `run_id` and `model_turn_index`: present for assistant turns and unique
  together within a run.
- `state`: `streaming`, `committed`, or `retracted`.
- `created_at`, `committed_at`, and the existing attribution/visibility data.

Each assistant turn has ordered blocks:

- A text block has `block_index`, canonical Markdown text, and the render-safe
  structured representation already used by the feed.
- A tool block has `block_index`, provider call ID, stable Rally invocation or
  receipt ID, model `call_index`, plugin/tool attribution, display summary,
  lifecycle state, lifecycle revision, and the existing durable result/error
  reference.
- A thinking block has `block_index`, provider-turn/stream-epoch attribution,
  lifecycle revision, and one or more timing intervals. It contains no
  member-visible reasoning payload. It exists only when normalized provider
  events prove an observable reasoning item occurred.

`block_index` is display order inside the assistant turn. `call_index` is tool
order inside the provider assistant message and remains the source for returning
parallel results to Bind. Neither is derived from start or completion time.
Large or sensitive raw result bodies stay in their current regional authority;
the participant turn stores only authorized display references. If Bind saw a
model-facing derivative of that result, the restricted loop projection stores
that exact derivative or a lossless pinned reference to it.

The harness run remains an execution envelope even though it is not a transcript
row. It has a stable `response_id` linked to the initiating participant turn,
and every assistant turn it produces references that response. Any range that
returns a member turn also returns the referenced response envelope metadata,
deduplicated by `response_id`; doing so provides the full-response timing label
without claiming that unloaded transcript turns inside the response are
covered.

Activity timing is stored in the same regional authority as conceptual records
with these fields:

- `activity_id`, `response_id`, and `kind`: `response_work`, `plugin_work`,
  `tool_work`, or `thinking`.
- Optional scope keys as appropriate: `assistant_turn_id`, `block_index`,
  `plugin_id`, and `tool_invocation_id`. Internal provider-attempt data is not a
  member-visible key.
- One or more intervals with stable identity, monotonic `revision`, an
  authoritative RFC 3339 UTC `started_at`, nullable RFC 3339 UTC `stopped_at`,
  and terminal `duration_ms`.
- Canonical `total_duration_ms` equal to the union of the activity's completed
  intervals; active snapshots add the current interval separately.
- Lifecycle state: `active`, `completed`, `failed`, `cancelled`, `ambiguous`, or
  `abandoned`, plus the existing authorized display outcome.
- `boundary_source`: `rally`, `provider`, `normalized`, or `recovered`, and
  `timing_accuracy`: `observed` or `upper_bound`.

Normal starts and stops have observed timing. If a crash or ambiguous external
effect leaves only the later recovery/reaper boundary known, the stored duration
is an upper bound and the historical UI must qualify it rather than presenting
false precision. Repeated working episodes—for example, a response paused for
member input and later resumed—are separate intervals. The response's displayed
total is the union of its non-overlapping intervals, including a locally
advancing active interval; it is never inferred by adding plugin or tool totals.

Realtime lifecycle edges are conceptually:

```json
{
  "type": "activity_started",
  "activityId": "activity_123",
  "intervalId": "interval_2",
  "kind": "plugin_work",
  "responseId": "response_9",
  "assistantTurnId": "turn_34",
  "pluginId": "github",
  "revision": 3,
  "startedAtUtc": "2026-08-26T17:00:00.000Z",
  "observedAtUtc": "2026-08-26T17:00:00.000Z",
  "activeIntervalElapsedMsAtEvent": 0,
  "completedDurationMsAtEvent": 0
}
```

```json
{
  "type": "activity_stopped",
  "activityId": "activity_123",
  "intervalId": "interval_2",
  "kind": "plugin_work",
  "revision": 4,
  "outcome": "completed",
  "startedAtUtc": "2026-08-26T17:00:00.000Z",
  "stoppedAtUtc": "2026-08-26T17:07:42.000Z",
  "intervalDurationMs": 462000,
  "totalDurationMs": 462000,
  "timingAccuracy": "observed"
}
```

A boot, first join, reconnect, or range response returns `snapshotAtUtc`, the
canonical completed total, and each active interval's `startedAtUtc` plus
`elapsedMsAtSnapshot` at that snapshot boundary. The desktop atomically rebases
its monotonic presentation clock on those values. Thus opening a work stream
seven minutes into an existing run starts near seven minutes rather than zero;
the UTC start is transmitted even though the server-computed elapsed value—not
the client's wall-clock subtraction—is the display authority.
Activity edges and response-text deltas are independent ordered event types:
neither waits for, batches, or acknowledges the other, and parallel plugin/tool
lifecycle edges may arrive in any completion order.

Provider adapters retain any exact opaque reasoning envelope required for
lossless provider continuation—including OpenRouter detail order, signatures,
or encrypted fields—in the existing regional model-protocol authority, separate
from the participant projection. Retries close or abandon the old stream
epoch's open thinking interval before a new epoch can start another. The visible
thinking duration is the union of the observable intervals attached to that
ordered block; provider route or attempt identity is not exposed.

The range request is conceptually:

```json
{
  "startInclusive": 1,
  "endExclusive": 21,
  "snapshotThroughSequence": 87
}
```

The response is conceptually:

```json
{
  "snapshot": {
    "earliestAvailableSequence": 1,
    "throughSequence": 87
  },
  "coverage": {
    "startInclusive": 1,
    "endExclusive": 21
  },
  "turns": []
}
```

The first-open boot/snapshot groups two such responses under stable purposes:

```json
{
  "initialTurnRanges": {
    "unread": {
      "anchorSequence": 32,
      "coverage": { "startInclusive": 27, "endExclusive": 38 },
      "turns": []
    },
    "latest": {
      "coverage": { "startInclusive": 83, "endExclusive": 88 },
      "turns": [{
        "turnId": "turn_active_9",
        "sequence": 87,
        "state": "active",
        "streamEpoch": 2,
        "checkpointRevision": 14,
        "blocks": []
      }]
    }
  },
  "activeResponses": [{
    "responseId": "response_9",
    "activeTurnId": "turn_active_9",
    "streamEpoch": 2,
    "checkpointRevision": 14,
    "startedAtUtc": "2026-08-26T17:00:00.000Z",
    "snapshotAtUtc": "2026-08-26T17:07:42.000Z",
    "elapsedMsAtSnapshot": 462000
  }],
  "resumeAfterEventSequence": 412
}
```

The example has no tombstones and enough turns on both sides, so the unread
slice covers five turns before sequence 32, the anchor, and five after it. The
latest slice abbreviates the accumulated active turn's ordered block payload;
the real response includes its checkpointed blocks and lifecycle revisions.
The actual endpoints may be wider when selecting five displayable turns scans
across tombstones, or narrower at transcript and transport boundaries. `unread`
is nullable when `firstUnreadSequenceNumber` is null. Both entries use the same
`snapshot.throughSequence`; they are never assembled from different transcript
moments.

`coverage` is the range the authority actually scanned. If an existing
transport-size rule shortens a response, `endExclusive` stops at the scanned
boundary rather than echoing the requested bound. The client stores normalized
non-overlapping intervals and computes gaps as the complement inside
`[earliestAvailableSequence, throughSequence + 1)`. For example, coverage of
`[1, 21)` and `[41, 61)` inside `[1, 88)` has gaps `[21, 41)` and `[61, 88)`.

The shared substrate defines this request/response and range arithmetic once.
An owning Durable Object may expose it through a surface-specific authenticated
RPC or socket message, but may not change the meaning of the snapshot fence,
coverage, tombstone, or sequence. A conformance suite runs the same empty,
shortened, disjoint, overlapping, and realtime-extension cases against every
adapter.

Reserved turns are durable sequence slots. A request can return a streaming
turn plus its checkpoint. If the attempt ends without participant-visible
content, the slot becomes a lightweight retracted tombstone. Sequences are
never renumbered after deletion, retry, or migration.

Run terminal state references `finalAssistantTurnId` and the committed-through
turn sequence rather than owning a concatenated assistant body. The final turn
reference may be null for an outcome with no final assistant response. Delivery
and export surfaces that require only the final answer read that explicit turn;
the work-stream feed reads all turns.

The restricted model-protocol projection obeys this invariant at every accepted
state revision:

```text
project(persist(bind accepted transitions)) = bind state.messages
```

There are no redaction or missing-payload exceptions inside this equality. Any
security filtering or result reduction that Bind receives is already part of
the exact model-facing message and is stored as such. A later authorized
deletion may make an old loop intentionally unreplayable, but Rally must then
mark that state unavailable and must not claim or attempt perfect reconstruction
with substituted content.

A tool-using turn projects as one complete assistant message with its ordered
`tool_calls`, then one exact model-facing `tool` result per call in the order
Bind consumes, then the next assistant turn. The separate participant projection
may sanitize, summarize, or omit private fields; it cannot feed those lossy
choices back into the restricted loop projection.

## Regional impact

Global and EU use the same object-local substrate and protocol in their
respective `SubstreamAgent` instances. No participant transcript, restricted
loop state, tool result, range request, snapshot, or coverage metadata crosses
regions. Regional D1 remains routing and migration control rather than a
transcript fallback, and EU history is never loaded from Global when its
authority is unavailable.

## Security and trust model

Every external boot or range read performs one reader admission before returning
any bounds or content. The operation then passes that admitted capability to all
unread/latest scans, active-state reads, lifecycle hydration, and response
assembly; none re-runs authorization. A socket performs reader admission at
upgrade/subscription and attaches its participant/scope epochs to the admitted
connection. Initial and later snapshots reuse that admission while its session,
membership, participant, and scope generations remain current. Revocation
advances or invalidates the relevant generation and closes the socket before it
can receive another snapshot; revocation propagation/sweeping replaces repeated
read-time checks, not security.

The participant `turn_sequence` domain is materialized at write time from
participant-visible turns only. Restricted system/protocol rows and other
substreams never occupy it, so an authorized range read is a direct indexed scan
rather than a per-row authorization filter or join. The number of authorization
decisions and regional authorization queries is therefore constant as page size,
block count, and gap count grow. The unread and latest slices in one boot share
the same decision. Bulk author/resource hydration may remain batched, but may not
introduce per-turn authorization calls.

Because the participant sequence domain excludes restricted rows, its gaps and
upper bound do not disclose private system prompts, hidden operational rows, or
another substream. If Rally later introduces genuinely viewer-specific transcript
turns, that feature must define a write-time audience sequence/projection rather
than post-filtering a shared range row by row; it is not introduced by this PRD.

The restricted loop projection is a separate authorization surface inside the
same regional authority. Participant REST, socket, export, search, range,
coverage, and telemetry paths cannot read its system-projection inputs,
protocol-only messages, model-facing derivatives, exact tool results, provider
continuation envelopes, or `loop_sequence` bounds. Ordinary logs may record opaque loop and
system-projection revisions, projector versions, and hashes, but never restricted
payloads.

Tool arguments, results, and failures retain their existing display
sanitization and result-reference rules. Lifecycle events are accepted only for
the matching run, turn, invocation, and newer revision; model-supplied IDs do
not select another turn. Structured logs and telemetry may carry opaque turn,
run, range, and invocation identifiers, but not response text, tool arguments,
tool output, or provider error prose.

Provider reasoning is not participant content. Raw reasoning text, encrypted
reasoning, signatures, and provider-only attempt metadata are never rendered,
included in participant snapshots, or copied into ordinary logs or telemetry.
If exact opaque reasoning details must be retained for provider continuation,
they stay in the regional model-protocol authority under the transcript's
existing access controls. The participant projection exposes only the generic
thinking lifecycle and its timing.

No new defensive limit is introduced. The existing authorized page and encoded
frame bounds continue to shorten actual coverage explicitly. Any future
retention boundary must advance `earliestAvailableSequence` and preserve a
tombstone or other unambiguous explanation at the contract boundary; it cannot
silently make an unloaded range look complete.

## Agent behavior

No tool, plugin, skill, or authority is added. The agent continues to choose and
execute tools under the current Bind and receipt contracts. The visible feed
now preserves narration that occurred between model turns instead of moving it
into a final run-level answer. Timing signals observe those existing lifecycle
transitions; they do not authorize a call, change dispatch order, or keep a run
alive.

Subsequent inference reads the restricted lossless loop projection, not the
desktop projection or participant feed. Its participant-visible facts share
identities with the authorized turn projection. Resume, retry, and compaction
therefore preserve every exact assistant/tool boundary Bind used while the
member sees the authorized subset. A route retry keeps the same turn identity
and increments its existing stream epoch; it may reset only that turn's
uncommitted text. A new provider turn always receives a new turn identity and
sequence even when the harness run is unchanged.

## Test objectives and required test suite

The tests below are implementation deliverables, not examples or optional
follow-up work. The implementation pull request must map every test ID to its
actual test file and test name in the PR description. An implementer may split a
listed target file when that makes ownership clearer, but may not omit or weaken
the stated objective or assertions. Tests use fixed protocol fixtures and
literal expectations; they do not generate the expected result by calling the
projector or reducer under test.

### Test objectives

| Objective | What the suite must prove |
| --- | --- |
| `T1 Protocol fidelity` | The restricted substrate reconstructs the exact accepted Bind loop state, including the freshly rendered system head, message/content-part order, roles, IDs, exact strings, and provider continuation fields. |
| `T2 Causal durability` | Every state transition required for later inference is durable before Bind, tool dispatch, terminal publication, or compaction can advance past it. |
| `T3 Live ordering and concurrency` | Response tokens remain immediately streamable while text, thinking, and multiple tool calls start and settle independently without changing model-declared display order. |
| `T4 Range and gap truth` | Snapshot-fenced range responses report what was actually inspected, and the desktop computes loaded islands and gaps correctly for empty, shortened, overlapping, disjoint, and realtime-extended history. |
| `T5 Activity-time truth` | Response, plugin, invocation, and observable-thinking timers use authoritative UTC starts, first-join/reconnect elapsed baselines, lifecycle edges, and interval unions; local ticking never requires server clock frames and survives late join, pause, sleep, reconnect, and history load. |
| `T6 Recovery and idempotency` | Worker loss, Durable Object eviction/hibernation, socket replay, retries, duplicate events, compaction, and cutover resume without loss, duplication, reordering, or identity reuse. |
| `T7 Authorization and locality` | Participant APIs reveal neither restricted payloads nor restricted bounds, and Global/EU authorities never use one another as transcript or inference-archive fallbacks. |
| `T8 Compatibility and migration` | Capable and legacy clients receive their declared protocols, complete legacy evidence can be reconciled deterministically, and incomplete evidence remains an honest legacy envelope. |
| `T9 Visible product behavior` | A real desktop window visibly preserves interleaving, gap loading, unread opening, instant jump-to-latest, smooth streaming, parallel activity, and historical timing labels. |
| `T10 Constant-cost reader admission` | One external boot/range operation or socket admission authorizes once and reuses an epoch-fenced capability across all slices, active state, and hydration; authorization work never scales with returned turns, blocks, or gaps. |

### Required test layers and artifacts

| Layer | Required target | Responsibility |
| --- | --- | --- |
| Pure harness protocol | `packages/agent-harness/src/bind-loop-projection.test.ts` | Fixed-message canonicalization, projector round trips, system-projection revision changes, provider continuation fields, protocol/derivative classification, and mismatch detection. |
| Substrate and SQL | `apps/api/test/workstream-transcript-substrate.test.ts` using the real object schema through `createTestSqlStorage()` | Schema constraints, transactions, exact range scans, tombstones, immutable payload references, transition ordering, and legacy reconciliation queries. |
| Real Cloudflare runtime | `apps/api/test-workers/workstream-transcript-runtime.test.ts` | Real `SubstreamAgent`, object-local SQLite, RPC, WebSocket, eviction/hibernation, concurrency, failure boundaries, and snapshot fencing. This suite may not replace the Durable Object or its storage with a double. |
| Desktop range/state reducer | `apps/desktop/src/renderer/lib/workstream-turn-ranges.test.ts` | Range union/complement, stable identity reconciliation, stream epochs, stale lifecycle rejection, timers, and realtime singleton coverage. |
| Desktop component | `apps/desktop/src/renderer/screens/workstream-turn-feed.test.tsx` | Ordered DOM blocks, streaming updates, dual initial islands, jump/scroll behavior, generic thinking/timing labels, and accessibility names. |
| Full local member pipeline | Extend `scripts/e2e-local.mjs` and `scripts/e2e-local-oracles.test.mjs` | Public API/socket behavior against opened Durable Object authority, including real provider interleaving when credentials are configured and a fixed scripted-provider fixture in CI. |
| Visible desktop acceptance | Add this feature's flow to `docs/e2e.md` and capture the exercised desktop window as required by the repository's visible-change rule. | Human-visible order, scroll anchoring, live clocks, parallel cards, reconnect, cold reload, and historical labels. |

Provider HTTP streams, clocks, and fault injectors may use typed capability
doubles because they cannot be controlled deterministically otherwise. The
transcript substrate, Durable Object, SQLite, socket, range projector, and
desktop reducer themselves are not doubled in the test that claims to prove
their behavior. Anything dependent on Cloudflare storage, hibernation,
WebSockets, transactions, or RPC runs in the real workerd suite.

### Required happy-path tests

| ID and required test name | Layer | Required setup and assertions |
| --- | --- | --- |
| `H01 interleaves_text_and_tools_live_and_after_reload` | workerd + desktop + E2E | Drive `text A → tool 1 → text B → tool 2 → final C`; assert that exact visible order while streaming, after socket reconnect, after cold reload, and in restricted replay. |
| `H02 streams_first_text_token_before_turn_commit` | workerd + desktop | Hold provider-turn completion after the first token; assert the token paints, no tool dispatch has occurred, and the eventual canonical commit reconciles the same turn without duplication. |
| `H03 runs_parallel_tools_in_declared_order` | workerd + desktop | Declare multiple tools in one assistant message, settle them out of order with success and failure, and assert cards stay in call-index order while lifecycle states advance independently. |
| `H04 persists_assistant_before_dispatch_and_tool_result_before_bind` | workerd | Read durable rows at both execution fences; assert the full assistant/tool plan exists before dispatch and the exact model-facing tool result exists before the next model call. |
| `H05 reconstructs_fixed_bind_fixture_exactly` | harness + SQL | Persist a literal fixture containing system, participant, protocol-only, derived, assistant/tool, and continuation fields; assert the literal canonical encoding and hash at each boundary. |
| `H06 regenerates_system_after_plugin_activation` | harness + workerd | Activate a plugin during the loop; assert a durable projection revision precedes use, the regenerated system head contains the new activation, non-system ordering is unchanged, and both hashes match. |
| `H07 records_protocol_and_derivative_provenance` | harness + SQL | Persist a continuation nudge, compaction summary, recalled-memory wrapper, trigger wrapper, interrupt wrapper, and tool result; assert their explicit kinds and required/no-source identities match the definitions. |
| `H08 compacts_and_resumes_the_same_loop_generation` | workerd | Commit an exact compaction replacement, evict the object, resume, and assert the next provider array equals the pre-eviction projected generation while earlier ledger/history remains queryable. |
| `H09 loads_disjoint_ranges_and_reports_middle_gap` | SQL + desktop | Load `[1,21)` and `[41,61)` against snapshot 87; assert exact actual coverage, gaps `[21,41)` and `[61,88)`, stable ordering, and no inferred coverage from row count. |
| `H10 merges_overlapping_ranges_idempotently` | SQL + desktop | Load overlapping ranges in both arrival orders; assert one copy per stable turn, normalized coverage union, and identical final state. |
| `H11 opens_with_unread_and_latest_islands` | workerd + desktop | Return unread `−5/+5` and five latest turns from one fence; assert unread paints first, both islands are cached, and the uncovered middle remains a gap. |
| `H12 jumps_to_prefetched_latest_without_fetch` | desktop + E2E | From a disjoint unread opening, invoke **Jump to latest**; assert the latest island paints immediately and the range transport receives no request. |
| `H13 lazy_loads_only_adjacent_gap_and_preserves_anchor` | desktop | Scroll toward each loaded edge; assert only the adjacent uncovered interval is requested, inserted turns do not move the visible anchor, and overlap is de-duplicated. |
| `H14 extends_latest_coverage_with_realtime_singletons` | workerd + desktop | Receive turns newer than the opening fence; assert each adds only its singleton interval and remains immediately reachable from **Jump to latest**. |
| `H15 times_response_and_plugin_from_edges` | workerd + desktop | Emit response/plugin start and stop edges; assert local **Working for …** advances without clock frames and cold history renders the canonical **Worked for …** duration. |
| `H16 unions_parallel_plugin_and_invocation_intervals` | harness + desktop | Overlap calls within and across plugins; assert each plugin spans earliest start through last settlement and response time is the wall-clock union rather than a sum of children. |
| `H17 pauses_and_resumes_response_work` | workerd + desktop | Pause for member input and resume; assert two intervals, no ticking during the gap, and historical duration equal to the union of working intervals. |
| `H18 renders_openai_thinking_lifecycle_generically` | harness + desktop | Replay fixed OpenAI reasoning-item edges; assert one correctly ordered generic thinking block and stable terminal duration with no reasoning payload in the DOM. |
| `H19 renders_openrouter_thinking_lifecycle_generically` | harness + desktop | Replay fixed OpenRouter reasoning-detail edges; assert the same normalized lifecycle/order/timing contract without exposing text, encrypted details, or signatures. |
| `H20 rebases_active_timers_after_reconnect` | workerd + desktop | Miss lifecycle edges, reconnect with the original `startedAtUtc`, `snapshotAtUtc`, and `elapsedMsAtSnapshot`, and assert the local monotonic baseline rebases once and later terminal `durationMs` becomes authoritative. |
| `H21 survives_hibernation_during_active_stream` | workerd | Stream text and parallel activity, hibernate/evict the object, reconnect, and assert exact checkpoint prefix, lifecycle state, loop revision, and subsequent frames appear once. |
| `H22 backfills_complete_global_legacy_proof` | SQL | Supply complete inference turns, receipts, aggregate text, and counts; assert deterministic canonical turns/ledger and reconciliation hashes without runtime lakehouse reads. |
| `H23 serves_legacy_and_capable_clients_concurrently` | workerd + desktop | Subscribe one client per capability; assert each receives only its declared projection while both converge on equivalent participant content and terminal state. |
| `H24 keeps_participant_and_restricted_projections_linked` | SQL + workerd | Read participant ranges and resume inference from the same committed facts; assert shared opaque identities, authorized visible content, and exact private replay without deriving either projection from the other. |
| `H25 compacts_twice_across_distinct_events_and_resumes_second_generation` | workerd | Accept activity, commit compaction event A, accept additional assistant/tool activity, then commit distinct compaction event B. Assert two `state_replaced` transitions with distinct event/source revisions, three ordered loop generations, retention of both exact replacements, unchanged participant history, and post-eviction replay from B with the exact next provider array. Replay either event ID and assert idempotency rather than a third replacement generation. |
| `H26 joins_existing_stream_with_utc_start_and_elapsed_baseline` | workerd + desktop + E2E | Start a response before a second client opens the work stream. On first join, assert the active snapshot carries the original `startedAtUtc`, a server `snapshotAtUtc`, and the full prior `elapsedMsAtSnapshot`; the label paints the already-accrued duration immediately, continues from the local monotonic receipt point, and is replaced by canonical terminal duration. |
| `H27 opens_workstream_mid_stream_with_atomic_checkpoint_and_catchup` | workerd + desktop + E2E | Before the client opens the work stream, stream accumulated text and produce planned, running, completed, and failed parallel tool states plus an active thinking block. Assert the first boot paints the exact accumulated ordered state and timing baselines, retains unread/latest islands, records `resumeAfterEventSequence`, and then applies subsequent text/tool/thinking frames once without waiting for another fetch. |
| `H28 authorizes_boot_once_for_all_ranges_and_active_state` | API Node + workerd | Open with disjoint unread/latest slices, active stream checkpoints, lifecycle timing, authors, mentions, attachments, and tool blocks. Instrument the typed reader-admission boundary and assert one admission decision for the complete boot, zero per-turn/block calls, and the same admitted capability identity on every internal scan/hydration. Repeat through the initial socket snapshot and assert it reuses the socket admission. |

### Required edge-case and failure tests

| ID and required test name | Layer | Required setup and assertions |
| --- | --- | --- |
| `E01 rejects_bind_advance_when_assistant_commit_fails` | workerd | Inject the required assistant-transition write failure; assert no tool dispatch, later model call, terminal completion, or participant canonical commit occurs. |
| `E02 rejects_bind_advance_when_tool_result_commit_fails` | workerd | Fail exact tool-result persistence; assert Bind never receives it and no continuation inference occurs, while the receipt remains truthful. |
| `E03 fails_provider_boundary_on_any_canonical_mismatch` | harness + workerd | Table-drive changes to role, message order, content-part order, name, ID, argument string, result string, refusal, and continuation field; every mutation must fail before provider I/O. |
| `E04 detects_system_renderer_or_activation_drift` | harness | Change renderer version/input/activation revision independently; assert the regenerated system hash mismatch is explicit and inference is blocked. |
| `E05 replays_historical_system_renderer_revision` | harness | Make a newer renderer current while replaying an older generation; assert the recorded historical renderer revision recreates the old head exactly rather than silently upgrading it. |
| `E06 rejects_invalid_protocol_derivative_classification` | SQL | Attempt a protocol-only row with a source identity, a derivative without a source identity, and a system row in `loop_sequence`; assert storage rejects all three. |
| `E07 fails_closed_for_missing_or_tampered_payload_reference` | SQL + workerd | Delete, change, or cross-region an immutable out-of-line payload; assert protocol-integrity failure and no summary, display value, refetch, or placeholder substitution. |
| `E08 excludes_abandoned_provider_bytes_from_bind_state` | workerd | Stream partial text/tool syntax, reset the route, and assert only the active checkpoint changes; the accepted loop revision and committed prior turns remain unchanged. |
| `E09 closes_stale_thinking_on_provider_retry` | harness + desktop | Retry/reset during thinking; assert the stale interval closes or is abandoned, the next epoch starts independently, and committed text/tool/timing blocks do not regress. |
| `E10 emits_no_thinking_block_without_provider_evidence` | harness + desktop | Provide latency and ordinary text but no reasoning event; assert no inferred thinking block or duration. |
| `E11 never_streams_server_clock_ticks` | workerd + desktop | Hold an active response/plugin interval while inspecting socket frames; assert only lifecycle/content events arrive and the visible timer still advances locally. |
| `E12 handles_every_tool_terminal_outcome_once` | harness + workerd | Exercise success, error, timeout, cancellation, ambiguous receipt, and intervention; assert one matching terminal transition and plugin interval closure for each. |
| `E13 ignores_duplicate_late_and_regressive_lifecycle_events` | workerd + desktop | Deliver duplicate starts/stops, lower revisions, and a late completion after terminal state; assert no reopen, double duration, status rollback, or card movement. |
| `E14 projects_parallel_tool_results_in_bind_call_order` | harness + workerd | Settle tools in reverse and mixed order; assert durable completion facts retain real timing while Bind's accepted tool messages project in its defined call order. |
| `E15 commits_terminal_state_only_after_final_turn` | workerd | Race run settlement against final assistant persistence; assert terminal publication references the committed final turn and never exposes concatenated or missing narration. |
| `E16 reports_empty_range_as_covered` | SQL + desktop | Scan an interval containing no displayable rows; assert actual coverage advances and the client does not refetch it indefinitely. |
| `E17 reports_shortened_range_actual_coverage_only` | SQL + desktop | Trigger the existing response-size shortening boundary; assert claimed coverage stops at the last inspected sequence, not the requested end or returned-row count. |
| `E18 preserves_tombstone_and_never_reuses_sequence` | SQL + workerd | Reserve a turn that becomes non-displayable; assert a covered tombstone, stable sequence, and a later turn receiving a new sequence. |
| `E19 does_not_fill_old_gaps_from_new_realtime_turn` | desktop | Start with an earlier gap and receive a newer socket turn; assert only the new singleton is covered and the old gap remains requestable. |
| `E20 fences_range_against_concurrent_append_and_mutation` | workerd | Append a turn and update tool status during a range scan; assert membership/order remain at the snapshot fence while authorized mutable status follows its declared revision rule. |
| `E21 handles_unread_near_start_end_and_missing` | SQL + desktop | Test unread at first sequence, within five of either edge, already inside latest five, absent, and beyond retained history; assert bounded slices, correct de-duplication, and declared fallback. |
| `E22 rejects_stale_range_response_after_new_snapshot` | desktop | Resolve an older range request after a newer snapshot; assert it cannot lower bounds, replace newer revisions, or erase singleton coverage. |
| `E23 recovers_timer_after_sleep_and_clock_skew` | desktop | Advance client wall clock independently of monotonic time, suspend, and resume with authoritative UTC timestamps plus elapsed baseline; assert the client does not use naive local `Date.now() - startedAtUtc`, produces no negative/jumped duration, and accepts canonical terminal replacement. |
| `E24 does_not_double_count_nested_or_overlapping_intervals` | harness + desktop | Duplicate and overlap response/plugin/tool intervals; assert normalized unions and idempotent terminal totals at every scope. |
| `E25 hides_restricted_payloads_and_bounds_from_all_participant_surfaces` | API Node + workerd | Exercise REST, socket, range, export, search, logs, and telemetry fixtures; assert no system inputs, protocol/derived payloads, exact private results, reasoning details, or `loop_sequence` bounds escape. |
| `E26 rejects_unauthorized_range_before_returning_bounds` | workerd | Request an existing and nonexistent range as a nonparticipant; assert authorization failure reveals neither snapshot bounds nor existence through coverage shape. |
| `E27 never_falls_back_across_regions` | API Node + workerd | Make the owning regional authority unavailable with the other region populated; assert no transcript, restricted state, payload, legacy archive, or range read crosses regions. |
| `E28 keeps_incomplete_and_eu_legacy_runs_legacy` | SQL | Remove each required Global proof component and supply an EU run without archive evidence; assert no guessed interleaving and an explicit legacy envelope. |
| `E29 rolls_back_activation_if_system_projection_commit_fails` | workerd | Fail `system_projection_changed`; assert the plugin/skill activation is not visible to Bind and the previous system revision remains current. |
| `E30 survives_crash_at_every_compaction_boundary` | workerd | Crash before replacement commit, after commit/before old-array discard, and after discard; assert restart selects exactly one valid generation and never combines old/new arrays. |
| `E31 replays_socket_frames_without_duplicate_tokens_or_blocks` | workerd + desktop | Disconnect at token, tool-start, tool-stop, and turn-commit boundaries; assert replay plus snapshot reconciliation produces each token/block/lifecycle revision once. |
| `E32 preserves_streaming_under_parallel_start_complete_error_burst` | workerd + desktop | Burst parallel tool start/success/error events while text tokens continue; assert token delivery is not blocked or batched behind lifecycle processing. |
| `E33 keeps_old_client_protocol_stable_during_cutover` | workerd | Mix legacy envelopes before the cutover and canonical turns after it; assert one stable participant order and unchanged old-client decoding until the supported floor advances. |
| `E34 makes_substrate_conformance_mandatory_for_new_authority_adapter` | harness/API contract | Run the shared adapter suite against `SubstreamAgent` and a deliberately incomplete fixture adapter; assert the real adapter passes and the missing range/replay capability fails conformance. |
| `E35 excludes_automation_wizard_from_all_new_paths` | API Node + desktop | Exercise automation draft storage and UI fixtures; assert no new substrate schema, protocol event, range contract, or renderer behavior is invoked for the explicitly out-of-scope wizard. |
| `E36 does_not_conflate_duplicate_compaction_delivery_with_a_second_event` | SQL + workerd | Deliver compaction event A twice and a distinct event B once, including out-of-order retry delivery. Assert A creates exactly one replacement generation, B creates exactly one later generation, event/source identities remain distinguishable, and the active generation never rolls back from B to A. |
| `E37 rejects_inconsistent_active_interval_timestamp_baseline` | workerd + desktop | Supply a snapshot whose `startedAtUtc`, `snapshotAtUtc`, and `elapsedMsAtSnapshot` cannot describe the same interval revision, then deliver an older consistent snapshot. Assert the inconsistent snapshot is rejected/resynced without resetting the label to zero, and the older revision cannot roll back a newer valid baseline. |
| `E38 races_midstream_open_with_frame_and_terminal_commit` | workerd + desktop | Publish a token/tool lifecycle frame immediately before, during, and after first-open snapshot assembly, then commit the active turn. Assert snapshot fencing plus catch-up yields every byte/block/revision exactly once, canonical commit reconciles the reserved turn in place, no active overlay survives terminal state, and no middle range is falsely marked covered. |
| `E39 keeps_authorization_work_constant_across_range_shapes` | API Node + workerd | Run empty, shortened, tombstone-heavy, overlapping, disjoint, and maximum-existing-bound range fixtures with different returned turn/block counts. Assert each external read makes exactly one reader-admission decision, no row hydration triggers authorization, and a participant/scope epoch change invalidates the admitted socket before another snapshot is returned. |

### Required algebraic, race, and failure-proof checks

In addition to the named examples, three deterministic generated suites are
required:

1. **Range-set algebra:** for generated ordered combinations of overlapping,
   adjacent, disjoint, empty, and singleton intervals, union is commutative and
   idempotent, complement never overlaps coverage, and every sequence within the
   snapshot is exactly covered or a gap.
2. **Protocol-ledger state machine:** for generated valid sequences of
   initialization, activation, assistant, tool-result, protocol/derived append,
   and compaction transitions, reconstruction after every prefix equals the
   literal reference reducer. Invalid transition orders fail closed.
3. **Lifecycle reducer:** for generated duplicate, reordered, and stale
   start/stop revisions across response, plugin, invocation, and thinking scopes,
   the terminal state is monotonic, intervals are normalized, and call-index
   display order never changes.

Every new or substantially changed automated test must be proven capable of
failing: deliberately break the production behavior it names, run the smallest
relevant file, observe the expected assertion fail for that reason, and revert
the break. The implementation PR records that failure proof by test ID. Merely
changing a fixture, making a mock throw, or observing a timeout is not proof.
The final validation runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, the updated
script tests, the local behavioral lane when provider credentials are available,
and the real-window desktop flow. Any flaky failure encountered is fixed or
explicitly reported under the repository's flaky-test rule; retries are not an
accepted implementation of this requirement.

## Rollout

1. Add the shared durable transcript substrate, its authority adapter contract,
   restricted loop ledger/generations, participant projection, canonical
   message encoding, and conformance suite. Cover stable turn/block/activity
   storage, exact loop reconstruction, snapshot fencing, range scanning, actual
   coverage, tombstones, and start/stop revision fencing.
2. Change the Bind host boundary so post-healing non-system initialization,
   system-projection revisions, exact accepted assistant messages, protocol-only
   and model-facing derived messages, exact tool results, and compaction
   replacements are required durable commits before Bind advances. Compare
   canonical projection hashes before every provider call.
3. Normalize observable OpenAI reasoning-item events and OpenRouter
   `reasoning_details` lifecycle boundaries into generic thinking blocks. Keep
   provider-only reasoning payloads in the restricted projection when replay
   requires them, keep them out of the participant projection, and emit no
   thinking block for providers or models without observable evidence.
4. Adopt the substrate in `SubstreamAgent` without changing the existing feed.
   Replace repeated nested `authorize()` calls with one explicit reader
   admission passed through detail, unread/latest range, active-state, and bulk
   hydration reads; attach the epoch-fenced form to admitted sockets. Historical
   rows remain readable. Deterministically backfill only legacy Global runs that
   pass the complete-evidence reconciliation; retain every other run as a legacy
   envelope.
5. Teach the desktop to understand both the legacy message protocol and the new
   turn/activity protocol. It stores coverage as ranges, reconciles streamed and
   committed versions by stable ID, ignores stale lifecycle revisions, and uses
   a local monotonic clock for active labels after applying authoritative UTC
   start plus elapsed-at-snapshot baselines, including on first join to an
   already-running response.
6. Replace first-open `messageFeed`/`resumeFeed` behavior for capable clients
   with the two named initial turn ranges from one snapshot. Retain both islands
   in the desktop cache, open at unread when present, and make **Jump to latest**
   select the prefetched latest island without fetching.
7. Advertise the new protocol in the work-stream socket subscription. The
   backend emits turn and activity-edge events only to a client that declares
   support; older desktop releases continue receiving their current projection
   during the compatibility window.
8. Enable new-turn, loop-transition, and activity persistence at an object-local
   cutover sequence. A snapshot may contain legacy envelopes before the cutover
   and canonical turns after it, but one stable participant-visible sequence
   orders the combined result.
9. Move canonical REST pages, socket snapshots, realtime events, model replay,
   terminal delivery, and exports to the turn projection. Remove the legacy
   emission path only after the supported desktop floor understands the new
   protocol.
10. Implement the required test IDs alongside the behavior each rollout step
    introduces. No phase is complete with deferred coverage: its harness, SQL,
    real-workerd, desktop, E2E, failure-injection, and visible-window cases must
    pass at the layer assigned by this PRD before the next phase relies on it.

The cutover is deploy-driven and idempotent. It requires no dashboard mutation,
manual data rewrite, or cross-region coordination. Rollback leaves already
committed canonical turns readable and resumes the compatible projection; it
never rewrites their sequence positions.

## Acceptance

1. For `text A → tool 1 → text B → tool 2 → final C`, the work-stream feed
   displays that order during live execution, after reconnect, across disjoint
   page loads, and after a cold reload.
2. The restricted canonical Bind replay contains the exact assistant message
   carrying `text A` plus tool 1, the exact model-facing tool result 1, the exact
   assistant message carrying `text B` plus tool 2, exact tool result 2, and the
   exact `final C` assistant message in that order.
3. The first response token can render without waiting for provider-turn or
   run completion. Coalesced streaming, smooth reveal, follow/release behavior,
   and active-checkpoint recovery remain functional.
4. A route reset replaces only the current turn's abandoned partial text. It
   does not duplicate or retract committed earlier turns or tool cards.
5. Multiple tools preappear in model call order, may start and settle in
   parallel, update in place, and cannot be reordered or regressed by late,
   duplicate, failed, or ambiguous lifecycle events.
6. No tool is dispatched before its assistant turn, ordered tool blocks, and
   durable execution plan are committed.
7. Run completion is not published before the final assistant turn is
   canonically committed, when one exists. Final-only delivery uses the explicit
   final-turn reference rather than concatenating narration.
8. A client that loads `[1, 21)` and `[41, 61)` against a snapshot through 87
   computes `[21, 41)` and `[61, 88)` as gaps, including when either loaded
   range contains no displayable turn.
9. A shortened page reports only its actually scanned coverage. Tombstones and
   empty covered positions do not trigger repeated fetches.
10. Receiving realtime turn 88 adds only `[88, 89)` to coverage and leaves
    every unobserved earlier interval marked as a gap.
11. Tests exercise live streaming, activity timing, parallel
    success/failure/ambiguous tools, retry resets, hibernation/reconnect,
    canonical snapshots, disjoint range merge, legacy/new cutover history,
    compaction generations, Worker-loss reconstruction, and exact Bind-state
    projection on the real Durable Object pipeline where runtime behavior is
    involved.
12. The transcript-substrate conformance suite passes against `SubstreamAgent`,
    including empty ranges, tombstones, response shortening, disjoint ranges,
    overlap, snapshot fencing, and realtime extension.
13. No in-scope work-stream/harness LLM conversation remains behind a
    cursor-only pagination implementation outside the shared substrate. New
    in-scope Durable Object transcript authorities cannot be added without
    implementing the same participant-range, restricted-loop, and conformance
    contracts. The automation wizard remains unchanged for its separate PR.
14. A first open with an unread anchor returns, in one boot/snapshot response,
    an unread slice containing the anchor plus up to five displayable turns on
    each side and a latest slice containing five displayable turns. Both slices
    share one snapshot fence and report independent actual coverage.
15. A first open with no unread anchor returns a null unread slice and the five
    latest displayable turns, and positions the transcript at that latest slice.
16. Overlapping initial slices render each turn once and union their coverage.
    Disjoint slices leave the middle marked as a gap rather than downloading or
    claiming it.
17. From an unread-centered opening, **Jump to latest** paints the prefetched
    latest slice without a network request. Infinite scrolling toward any
    loaded edge requests only the adjacent uncovered range and preserves the
    visible scroll anchor when inserting it.
18. Realtime turns received after the opening snapshot extend the latest loaded
    island one singleton range at a time and remain immediately reachable by
    **Jump to latest**.
19. When a response starts actual execution, the feed paints **Working for …**
    from one start edge and advances it locally. No periodic server frame or
    response token is required to update the label.
20. A response stop edge freezes an authoritative duration. Cold reload and a
    disjoint range load show the same **Worked for …** value without replaying
    live timing events.
21. Each plugin block independently shows **Working for …** and **Worked for
    …**. Parallel calls within one plugin measure earliest start through last
    settlement; overlapping plugins advance simultaneously; the response total
    equals elapsed response wall time rather than the sum of plugin durations.
22. Tool completion, failure, cancellation, and ambiguous receipt outcomes all
    close the matching invocation/plugin interval exactly once. A late or
    duplicate start/stop edge cannot reopen or regress a newer terminal state.
23. Pausing for member input closes the current response-work interval, and
    resumption opens a new one. The live and historical response label sums the
    non-overlapping working intervals and excludes the paused gap.
24. After application sleep, hibernation, socket reconnect, or a missed edge,
    an active snapshot rebases the desktop from its original `startedAtUtc`,
    server `snapshotAtUtc`, and `elapsedMsAtSnapshot`; a terminal snapshot
    replaces local elapsed time with canonical `durationMs`.
25. Response-text token deltas remain immediately renderable while response,
    plugin, tool, and thinking start/stop edges arrive independently. Parallel
    tool start/complete/error traffic neither blocks nor batches text streaming.
26. OpenAI reasoning-item events and OpenRouter reasoning-detail streams each
    produce an ordered generic **Thinking for …** block when observable and a
    stable **Thought for …** duration when closed. A model that exposes no
    reasoning event produces no thinking block.
27. Provider retries and route resets close or abandon stale thinking intervals
    before accepting the next stream epoch. Their lifecycle cannot reset
    committed narration, tool blocks, or response-work timing.
28. Participant snapshots, rendered DOM, logs, and telemetry contain no raw or
    encrypted reasoning payload, signature, or hidden provider-attempt detail.
    Recovery-only timing boundaries are marked as upper bounds rather than
    displayed with false precision.
29. At initialization, the restricted projection recreates the complete
    post-healing Bind message array by rendering the system head from its durable
    versioned prompt/activation state and appending the exact participant-derived
    messages, compaction prefix, and protocol-only prompt context. The
    pre-healing `input.messages` array is not treated as equivalent.
30. Immediately before every provider call, canonical encodings and hashes of
    the projected active loop generation and Bind's post-healing ordered message
    array are equal. Deliberately changing any role, order, ID, content-part,
    tool argument string, tool-result string, or provider continuation field
    makes the test and the runtime boundary fail.
31. A successful assistant response—including text, ordered tool calls, and
    required opaque continuation fields—is durable before `callModel` returns it
    to Bind. A persistence failure prevents tool dispatch and further inference.
32. Every exact model-facing tool success, failure, timeout, cancellation, or
    ambiguity message is durable before `runToolCall` returns it to Bind.
    Parallel settlement order does not change the call-order projection Bind
    consumes.
33. Plugin/skill activation changes advance a durable system-projection revision
    whose versioned renderer recreates Bind's replaced system head. Protocol-only
    continuation nudges and model-facing derivatives such as memory, trigger,
    and interrupt wrappers are exact restricted transitions with provenance;
    none is exposed as a participant turn unless it independently satisfies that
    projection's visibility contract.
34. Compaction durably commits the exact replacement generation before discarding
    the prior active array. Reconstructing after Worker loss produces the same
    next provider message array, while the pre-compaction restricted ledger and
    participant transcript remain intact.
35. An immutable out-of-line model-facing payload is changed, deleted, or made
    unavailable in a fault-injection test. Replay fails with a protocol-integrity
    error and never substitutes a summary, display payload, placeholder, or
    refetched result.
36. Failed provider attempts, abandoned partial output, and route-reset bytes do
    not enter accepted Bind state. The next epoch may replace transient display
    text without changing the last durable loop revision.
37. A complete Global legacy fixture is deterministically backfilled only when
    accepted inference turns, durable receipts, aggregate assistant text, and
    tool count all reconcile. Removing or altering any required record leaves
    the run in its legacy envelope. An EU fixture without an archive is never
    inferred.
38. Participant range reads and coverage metadata reveal neither restricted
    loop payloads nor `loop_sequence` bounds. Subsequent inference nevertheless
    reconstructs from the restricted projection without consulting the desktop
    projection or Global inference lakehouse.
39. Every required `H01`–`H28` and `E01`–`E39` test is mapped to an actual test
    name and file, passes at its required layer, and has an implementation-PR
    failure-proof record showing the named assertion fails when its protected
    production behavior is deliberately broken. The three generated algebraic
    and state-machine suites, updated local behavioral lane, and real-window
    desktop acceptance flow also pass; none is deferred to a follow-up PR.
40. A client that first opens or reconnects to a response already in progress
    receives the active interval's original UTC start and a server-observed UTC
    snapshot plus elapsed baseline. It immediately displays the time accrued
    before subscription, then advances locally without periodic server ticks;
    client wall-clock skew cannot reset, make negative, or become the authority
    for that duration.
41. Opening a work stream mid-response paints its accumulated text, ordered
    tool/thinking blocks, current lifecycle states, and already-accrued timing
    from the initial boot snapshot. The snapshot's event fence makes subsequent
    socket catch-up and live frames exact-once at the boundary, while the unread
    and latest range islands retain truthful coverage and **Jump to latest**
    remains immediate.
42. A complete REST boot or range request performs one reader-admission decision
    regardless of the number of turns, blocks, gaps, or initial slices it
    returns. Both first-open ranges and active state reuse it. A socket snapshot
    reuses the connection's epoch-fenced admission, and revocation invalidates
    that admission; neither path performs per-row authorization or regional
    authorization joins during the transcript scan.

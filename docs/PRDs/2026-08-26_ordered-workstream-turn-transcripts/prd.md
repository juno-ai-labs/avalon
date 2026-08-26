# Ordered work-stream turn transcripts

> Created 2026-08-26.
>
> Preserve model-turn order across assistant text and tool activity while making
> work-stream transcript loading explicitly gap-aware. Companion:
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

The backend also describes exactly which half-open turn ranges each response
covers. The desktop merges those ranges into a coverage set, so it can tell the
difference between a loaded interval, an intentional tombstone, a range not yet
requested, and a newly arrived realtime turn beyond the original snapshot.

Text still reaches the feed token by token. Parallel tools still start and
settle independently. The change is where those events attach and how their
durable order is represented, not a conversion of streaming or tool execution
into a serialized batch.

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

## Goals

1. Render assistant narration and tool activity in the order of the original
   model protocol, during the run and after a cold reload.
2. Preserve immediate response-text token streaming, route-reset behavior,
   smooth reveal, scroll following, reconnect, and canonical reconciliation.
3. Allow independent tools from one assistant turn to start, complete, or fail
   in parallel while their cards remain in the model-declared order.
4. Make the durable transcript sufficient to reconstruct the exact ordered
   model protocol for later inference, modulo deliberate result redaction or
   unavailable large result bodies.
5. Let a client load arbitrary blocks of complete turns and compute every gap
   inside a known snapshot without inferring coverage from returned content.
6. Keep turn identities and sequence positions stable across retries,
   reconnects, tool lifecycle updates, pagination, and realtime delivery.
7. Preserve regional authority and existing work-stream visibility rules.

## Non-goals

1. **Change the automation-wizard feed.** This PRD specifies the work-stream
   side. The wizard may adopt the same turn contract in a separate proposal,
   but its persistence and delivery path do not change here.
2. **Change model prompts, route selection, plugin availability, tool
   authorization, or tool execution semantics.** Tool calls remain proposals
   subject to the current receipt, authority, and idempotency contracts.
3. **Serialize parallel tools to make display order easy.** Display order comes
   from the assistant turn's declared call indexes, not completion timing.
4. **Write canonical transcript content on every token.** The bounded active
   stream checkpoint remains the recovery mechanism while a turn is open; the
   canonical turn commits at the model-turn boundary.
5. **Invent historical interleaving that was never stored.** Legacy runs are
   projected faithfully from their existing rows and remain visibly legacy;
   Rally does not guess where concatenated text used to sit between tools.
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

On reconnect, the feed restores the active turn from its checkpoint before
accepting catch-up frames. On cold reload, it reads the same canonical turn and
block structure used by live delivery. The two paths therefore converge on one
ordering rather than applying separate placement rules.

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
9. **Use a participant-visible sequence domain.** Private model instructions,
   operational events, and rows a participant could never read do not consume
   advertised turn positions. Coverage metadata is therefore not a side
   channel for hidden internal records. A tombstone occupies a position only
   when a previously participant-visible reserved turn produced no displayable
   content or was retracted.
10. **Do not backfill guessed interleaving.** Existing combined run messages
    retain their stored ordering and are projected through a legacy envelope.
    Exact model-turn ordering begins at the cutover boundary. The rejected
    alternative was heuristically distributing old text around tool timestamps,
    which would turn an unprovable guess into canonical history.

## Data model

The owning `SubstreamAgent` stores one participant-visible transcript turn with
these conceptual fields:

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

`block_index` is display order inside the assistant turn. `call_index` is tool
order inside the provider assistant message and remains the source for returning
parallel results to Bind. Neither is derived from start or completion time.
Large or sensitive result bodies stay in their current regional authority; the
turn stores only the authorized display and replay references.

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

`coverage` is the range the authority actually scanned. If an existing
transport-size rule shortens a response, `endExclusive` stops at the scanned
boundary rather than echoing the requested bound. The client stores normalized
non-overlapping intervals and computes gaps as the complement inside
`[earliestAvailableSequence, throughSequence + 1)`. For example, coverage of
`[1, 21)` and `[41, 61)` inside `[1, 88)` has gaps `[21, 41)` and `[61, 88)`.

Reserved turns are durable sequence slots. A request can return a streaming
turn plus its checkpoint. If the attempt ends without participant-visible
content, the slot becomes a lightweight retracted tombstone. Sequences are
never renumbered after deletion, retry, or migration.

Run terminal state references `finalAssistantTurnId` and the committed-through
turn sequence rather than owning a concatenated assistant body. The final turn
reference may be null for an outcome with no final assistant response. Delivery
and export surfaces that require only the final answer read that explicit turn;
the work-stream feed reads all turns.

The canonical model-protocol projection obeys this invariant:

```text
project(persist(original provider turns)) = original provider turns
```

The only permitted differences are documented content redaction and a result
body that its existing large-output authority can no longer supply. A tool-using
turn projects as one assistant message with its text and ordered `tool_calls`,
then one `tool` result per call in declared order, then the next assistant turn.

## Regional impact

Global and EU use the same object-local schema and protocol in their respective
`SubstreamAgent` instances. No transcript, tool result, range request, snapshot,
or coverage metadata crosses regions. Regional D1 remains routing and migration
control rather than a transcript fallback, and EU history is never loaded from
Global when its authority is unavailable.

## Security and trust model

Every snapshot and range read reuses the current work-stream participant and
workspace authorization before returning bounds or content. The advertised
sequence domain contains participant-visible turns only, so its gaps and upper
bound do not disclose private system prompts, hidden operational rows, another
substream, or another participant's inaccessible content.

Tool arguments, results, and failures retain their existing display
sanitization and result-reference rules. Lifecycle events are accepted only for
the matching run, turn, invocation, and newer revision; model-supplied IDs do
not select another turn. Structured logs and telemetry may carry opaque turn,
run, range, and invocation identifiers, but not response text, tool arguments,
tool output, or provider error prose.

No new defensive limit is introduced. The existing authorized page and encoded
frame bounds continue to shorten actual coverage explicitly. Any future
retention boundary must advance `earliestAvailableSequence` and preserve a
tombstone or other unambiguous explanation at the contract boundary; it cannot
silently make an unloaded range look complete.

## Agent behavior

No tool, plugin, skill, or authority is added. The agent continues to choose and
execute tools under the current Bind and receipt contracts. The visible feed
now preserves narration that occurred between model turns instead of moving it
into a final run-level answer.

Subsequent inference reads the canonical turn projection, not a separate
display-only ordering. Resume, retry, and compaction therefore see the same
assistant/tool boundaries that the member can inspect. A route retry keeps the
same turn identity and increments its existing stream epoch; it may reset only
that turn's uncommitted text. A new provider turn always receives a new turn
identity and sequence even when the harness run is unchanged.

## Rollout

1. Add the turn/block storage and range contract without changing the existing
   feed. Historical rows remain readable, and no guessed backfill is performed.
2. Teach the desktop to understand both the legacy message protocol and the new
   turn protocol. It stores coverage as ranges, reconciles streamed and
   committed versions by turn ID, and ignores unknown stale lifecycle
   revisions.
3. Advertise the new protocol in the work-stream socket subscription. The
   backend emits turn events only to a client that declares support; older
   desktop releases continue receiving their current projection during the
   compatibility window.
4. Enable new-turn persistence at an object-local cutover sequence. A snapshot
   may contain legacy envelopes before the cutover and canonical turns after it,
   but one stable participant-visible sequence orders the combined result.
5. Move canonical REST pages, socket snapshots, realtime events, model replay,
   terminal delivery, and exports to the turn projection. Remove the legacy
   emission path only after the supported desktop floor understands the new
   protocol.

The cutover is deploy-driven and idempotent. It requires no dashboard mutation,
manual data rewrite, or cross-region coordination. Rollback leaves already
committed canonical turns readable and resumes the compatible projection; it
never rewrites their sequence positions.

## Acceptance

1. For `text A → tool 1 → text B → tool 2 → final C`, the work-stream feed
   displays that order during live execution, after reconnect, across disjoint
   page loads, and after a cold reload.
2. The canonical model replay contains assistant `text A` plus tool 1, tool
   result 1, assistant `text B` plus tool 2, tool result 2, and assistant
   `final C` in that order.
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
11. Tests exercise live streaming, parallel success/failure/ambiguous tools,
    retry resets, hibernation/reconnect, canonical snapshots, disjoint range
    merge, legacy/new cutover history, and exact model-protocol projection on
    the real Durable Object pipeline where runtime behavior is involved.

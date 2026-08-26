# Ordered, range-addressable work-stream turns

> Created 2026-08-26.
>
> Preserve model-turn order across assistant text and tool activity, and require
> the same gap-aware durable transcript substrate wherever the work-stream
> harness saves a replayable LLM conversation. Add durable response, plugin,
> tool, and observable-thinking timing without server clock ticks; the automation
> wizard remains a separate change. Companion:
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
clock ticks. Once stopped, the authority supplies the canonical duration used
for **Worked for …** or **Thought for …** on every historical load.

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
   competing notions of coverage above it.
9. Keep turn identities and sequence positions stable across retries,
   reconnects, tool lifecycle updates, pagination, and realtime delivery.
10. Preserve regional authority and each transcript surface's existing
    visibility rules.
11. Show live and historical elapsed wall-clock time for the full response and
    for each plugin activity block, including correct behavior when plugins or
    calls execute in parallel.
12. Send only lifecycle edges and authoritative reconnect baselines for timing;
    let the desktop advance an active label locally without server clock ticks or
    interference with response-text token streaming.
13. When a provider exposes an observable reasoning item, render a separate,
    ordered, generically labeled thinking block with the same live and historical
    timing guarantees, without exposing private chain-of-thought.

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
formatted label locally. A reconnect or canonical snapshot supplies an
authoritative `elapsedMsAtSnapshot`; the desktop rebases to it instead of
trusting wall-clock time accumulated while the process was asleep or offline.
The stop edge supplies authoritative `durationMs`, after which the local clock
is no longer consulted. Duplicate or late edges are ignored by revision.

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
12. **Do not backfill guessed interleaving.** Existing combined run messages
    retain their stored ordering and are projected through a legacy envelope.
    Exact model-turn ordering begins at the cutover boundary. The rejected
    alternative was heuristically distributing old text around tool timestamps,
    which would turn an unprovable guess into canonical history.
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

## Data model

The shared durable transcript substrate is a storage/projection component, not
a new global authority. It runs inside the Durable Object that already owns the
conversation and uses that object's SQLite transaction, authorization, region,
and lifecycle. No cross-object transcript database is introduced.

The required authority inventory at the time of this PRD is:

| Saved LLM conversation | Authority | Scope in this PRD |
| --- | --- | --- |
| Work-stream main feed and any future independently addressable substream | `SubstreamAgent` | In scope: replace direct `parts` pagination/projection with canonical turns, blocks, and range coverage. |
| HyperSight execution | Source `SubstreamAgent` | In scope through its source transcript. `BlockDashboardAgent` stores only derived dispatch/output state and does not create a second transcript. |
| Automation-creation draft conversation | `WorkspaceDO` | Explicitly out of scope: a separate PR will migrate its saved transcript, range loading, streaming, and UI. |

**Within the work-stream/harness architecture, wherever Rally saves an
authoritative ordered LLM conversation for later continuation or replay,
adopting this substrate and range contract is in scope and mandatory.** Saving
such a conversation in an object-local JSON blob, bespoke table, or cursor-only
API outside the substrate is not a conforming implementation. The automation
wizard is the sole explicit exception in this PRD and moves in its separate PR.

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
Large or sensitive result bodies stay in their current regional authority; the
turn stores only the authorized display and replay references.

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
- One or more intervals with stable identity, monotonic `revision`,
  `started_at`, nullable `stopped_at`, and terminal `duration_ms`.
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
  "intervalDurationMs": 462000,
  "totalDurationMs": 462000,
  "timingAccuracy": "observed"
}
```

A boot, reconnect, or range response returns the canonical completed total and
each active interval's `elapsedMsAtSnapshot` at the response's snapshot boundary.
The desktop atomically rebases its monotonic presentation clock on those values.
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
      "turns": []
    }
  }
}
```

The example has no tombstones and enough turns on both sides, so the unread
slice covers five turns before sequence 32, the anchor, and five after it. The
actual endpoints may be wider when selecting five displayable turns scans
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

The canonical model-protocol projection obeys this invariant:

```text
project(persist(original provider turns)) = original provider turns
```

The only permitted differences are documented content redaction and a result
body that its existing large-output authority can no longer supply. A tool-using
turn projects as one assistant message with its text and ordered `tool_calls`,
then one `tool` result per call in declared order, then the next assistant turn.

## Regional impact

Global and EU use the same object-local substrate and protocol in their
respective `SubstreamAgent` instances. No transcript, tool result, range
request, snapshot, or coverage metadata crosses regions. Regional D1 remains
routing and migration control rather than a transcript fallback, and EU history
is never loaded from Global when its authority is unavailable.

## Security and trust model

Every snapshot and range read reuses work-stream participation authorization
before returning bounds or content. The advertised sequence domain contains
only turns visible to that audience, so its gaps and upper bound do not disclose
private system prompts, hidden operational rows, another substream, or another
participant's inaccessible content.

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

Subsequent inference reads the canonical turn projection, not a separate
display-only ordering. Resume, retry, and compaction therefore see the same
assistant/tool boundaries that the member can inspect. A route retry keeps the
same turn identity and increments its existing stream epoch; it may reset only
that turn's uncommitted text. A new provider turn always receives a new turn
identity and sequence even when the harness run is unchanged.

## Rollout

1. Add the shared durable transcript substrate, its authority adapter contract,
   and one conformance suite for stable turn/block/activity storage, snapshot
   fencing, range scanning, actual coverage, tombstones, canonical projection,
   and start/stop revision fencing.
2. Normalize observable OpenAI reasoning-item events and OpenRouter
   `reasoning_details` lifecycle boundaries into generic thinking blocks. Keep
   provider-only reasoning payloads out of the participant projection, and emit
   no thinking block for providers or models without observable evidence.
3. Adopt the substrate in `SubstreamAgent` without changing the existing feed.
   Historical rows remain readable, and no guessed interleaving or historical
   timing backfill is performed.
4. Teach the desktop to understand both the legacy message protocol and the new
   turn/activity protocol. It stores coverage as ranges, reconciles streamed and
   committed versions by stable ID, ignores stale lifecycle revisions, and uses
   a local monotonic clock for active labels after applying authoritative
   baselines.
5. Replace first-open `messageFeed`/`resumeFeed` behavior for capable clients
   with the two named initial turn ranges from one snapshot. Retain both islands
   in the desktop cache, open at unread when present, and make **Jump to latest**
   select the prefetched latest island without fetching.
6. Advertise the new protocol in the work-stream socket subscription. The
   backend emits turn and activity-edge events only to a client that declares
   support; older desktop releases continue receiving their current projection
   during the compatibility window.
7. Enable new-turn and activity persistence at an object-local cutover sequence.
   A snapshot may contain legacy envelopes before the cutover and canonical
   turns after it, but one stable participant-visible sequence orders the
   combined result.
8. Move canonical REST pages, socket snapshots, realtime events, model replay,
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
11. Tests exercise live streaming, activity timing, parallel
    success/failure/ambiguous tools, retry resets, hibernation/reconnect,
    canonical snapshots, disjoint range merge, legacy/new cutover history, and
    exact model-protocol projection on the real Durable Object pipeline where
    runtime behavior is involved.
12. The transcript-substrate conformance suite passes against `SubstreamAgent`,
    including empty ranges, tombstones, response shortening, disjoint ranges,
    overlap, snapshot fencing, and realtime extension.
13. No in-scope work-stream/harness LLM conversation remains behind a
    cursor-only pagination implementation outside the shared substrate. New
    in-scope Durable Object transcript authorities cannot be added without
    implementing the same adapter/conformance contract. The automation wizard
    remains unchanged for its separate PR.
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
    an active snapshot rebases the desktop from `elapsedMsAtSnapshot`; a terminal
    snapshot replaces local elapsed time with canonical `durationMs`.
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

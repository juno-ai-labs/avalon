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
turn is a later transcript turn even when it belongs to the same run. The same
top-level sequence can also contain typed participant-safe status entries, such
as a context-compaction lifecycle marker; those are not model messages and never
enter Bind state.

That contract is a shared durable LLM-transcript substrate, not logic private to
the desktop route. Within the work-stream/harness architecture covered by this
PRD, every Durable Object that authoritatively saves an ordered LLM conversation
for later continuation or replay must compose the substrate and expose its
range/coverage contract. Today the transcript authority is `SubstreamAgent`. A
future in-scope transcript-owning Durable Object joins the same contract rather
than creating another opaque message array.

The backend also describes exactly which half-open transcript-entry ranges each
response covers. The desktop merges those ranges into a coverage set, so it can tell the
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
versioned projector recreates that state with perfect semantic accuracy. There
is one regional authority and one atomic persistence boundary over the shared
canonical facts. `transcript_sequence` and `loop_sequence` are two necessary
orderings over those facts, not two owners or two copies of a transcript. The
participant feed is an authorized projection of the same committed facts, not
the source from which private protocol-only messages or model-facing derivatives
are guessed.

Deployment is a single coordinated breaking protocol cutover followed by an
explicit object-local projection backfill. The implementation does not carry a
legacy feed, dual-read or dual-write path, capability-negotiated protocol, or
infer history that the old stores never retained. It does preserve every
participant-visible pre-cutover `parts` row in its durable legacy order and
every exact legacy compaction checkpoint through canonical references to their
existing owning rows. Historical Bind interleaving is marked unavailable rather
than fabricated. The backend may require the new desktop version immediately;
downloading that version is an acceptable prerequisite to opening a work stream.

### Terminology and definitions

These terms are normative. A persisted record has one explicit kind; callers
may not choose a different classification based on the provider role or whether
the content would be useful in the participant feed.

- **Regional transcript authority:** the one Durable Object instance and its
  object-local SQLite database that own a work-stream/substream's transcript
  facts and both ordering projections. Canonical fact creation and every
  required participant/Bind projection reference commit in one SQLite
  transaction; there is no second transcript owner or cross-region copy.
- **Canonical semantic fact / canonical payload:** the sole owning record for
  one semantic datum, identified by a stable opaque `fact_id` or `payload_id`.
  Examples include one assistant text block, one exact model-facing tool-result
  message, one participant-safe tool summary, one compaction-status lifecycle,
  and one private compaction replacement. A datum shared unchanged by multiple
  projections is stored once and referenced by ID; equality of bytes is not
  permission to create independent projection-local copies.
- **Projection row:** ordering, visibility, generation, or lifecycle metadata
  that references canonical fact/payload IDs. A projection row does not become
  the owner of referenced text, result, or provider payload merely because an
  API flattens the join when returning it.
- **Legacy transcript projection backfill:** the one-time, object-local operation
  that adds canonical ordering/reference rows for participant-visible legacy
  `parts` and exact legacy compaction checkpoints. It does not copy their
  payloads, query the inference archive, or create a Bind-loop generation from
  aggregate rows. The v27 schema receipt is its cutover fence; a v28 receipt
  records the exact source digest, counts, pre-write PITR bookmark, operator run,
  and the explicit `not_reconstructable_from_legacy_aggregate_rows` Bind-history
  status.
- **Pre-cutover run cleanup receipt:** the schema-v29 singleton committed in the
  same object-local transaction that terminalizes provably lease-less active
  runs predating v27. It owns the original operator run ID, cutover version and
  timestamp, abandonment count, and completion time. Cleanup success followed
  by backfill failure returns this same evidence on every retry; a fleet receipt
  may reference or flatten it but may not replace its operator or count.
- **Field naming:** conceptual storage records and SQL columns use
  `snake_case`; TypeScript properties and JSON wire fields use `camelCase`.
  Thus `transcript_sequence` and `timing_accuracy` are exposed as
  `transcriptSequence` and `timingAccuracy`. Symbolic names in equations are
  definitions rather than wire fields. A spelling change across layers never
  creates a second semantic field.
- **Participant transcript entry:** a top-level ordering/lifecycle row in the
  participant-visible work-stream projection, returned only after reader
  admission. It has a stable `transcript_sequence`, references its canonical
  fact(s), and has exactly one kind:
  `conversation_turn` or `status_event`. It is not filtered or re-authorized row
  by row and is not the source of truth for reconstructing private Bind state.
- **Participant transcript turn:** a `conversation_turn` entry representing a
  human, assistant, or participant-visible system message. It may contain
  ordered text, thinking, and tool blocks and is never split across ranges.
- **Participant status event:** a participant-safe lifecycle entry ordered
  between conversation turns. The first required kind is `context_compaction`.
  It carries only generic lifecycle, revision, UTC timing, and optional display
  duration metadata; it never carries the compacted messages, summary, token
  counts, provider reasoning, or restricted loop bounds.
- **Activity scope and product nesting:** one independently timed unit of work
  with stable identity, lifecycle revisions, and zero or more child scopes. The
  minimum product hierarchy is response → assistant turn → plugin block → tool
  invocation; thinking is a child of its assistant turn, and compaction attaches
  to the response or assistant turn that causally owns it. Sibling scopes may be
  active in parallel. This is a presentation/behavior contract, not a mandate
  for recursive storage: a flat schema is conforming when stable ownership keys
  let the projector reconstruct the same tree without ambiguity.
- **Reader admission:** the single authorization decision for one external
  transcript read operation or admitted socket. It binds the reader to the
  authenticated session/membership generation, workspace, work stream,
  substream, participant/scope epochs, and regional authority. Every range
  slice, active checkpoint, lifecycle record, and bulk hydration within that
  operation reuses the same admission.
- **Unread high-water line and unread anchor:** the participant's durable read
  state identifies the first unread attention ordinal; today it is exposed as
  `firstUnreadSequenceNumber`. After admission, the substrate adapter resolves
  that ordinal to the first matching displayable conversation turn and exposes
  its participant `transcript_sequence` as the slice's `anchorSequence`.
  Participant-safe status entries never become unread anchors. If there is no
  unread state, the unread slice is `null` with
  `unreadReason = no_unread`. If the source ordinal is below retained history,
  beyond the snapshot, or resolves only to missing/retracted turns with no later
  displayable turn at the fence, the slice is `null` with
  `unreadReason = anchor_unavailable`; the initial viewport is the prefetched
  latest slice in both null cases.
- **Bind loop state:** the complete ordered, post-healing provider-message array
  Bind will submit at a model-call boundary, or the complete ordered array after
  Bind accepts an assistant or tool-result transition. It includes the current
  system projection and every active non-system message.
- **Bind loop identity and generation:** `loop_id` is the existing harness run
  identity—`harnessRunId` on the TypeScript/wire boundary and `run_id` in
  storage—because one admitted harness run owns one Bind loop.
  `loop_generation` starts at 1 for `state_initialized` and increments exactly
  once for each successfully committed `state_replaced` compaction.
- **Bind loop projection row:** a restricted ordering/generation row with a
  monotonic `loop_sequence` that references the exact canonical facts Bind
  consumes or accepts, including private protocol facts, model-facing
  derivatives, and compaction replacements. It does not copy a participant fact
  when the semantic datum is identical.
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
- **Provider request boundary / `bind_messages_at_request_boundary`:** the exact
  ordered `prepared.messages` array returned by
  `validateAndHealMessages` immediately before provider I/O in
  `packages/agent-harness/src/bind-runtime.ts`. It is the live Bind value
  compared with the substrate projection; it is not pre-healing
  `input.messages`.
- **Socket event fence / `resumeAfterEventSequence`:** the
  `SubstreamAgent` room's durable monotonic `realtime_state.event_sequence`
  captured in the same object-local snapshot as transcript bounds, both initial
  slices, active checkpoints, and activity baselines. It is independent of
  `transcript_sequence`, `loop_sequence`, and checkpoint revisions. The
  snapshot represents every relevant event at or below the fence; catch-up and
  live delivery accept only room events with `sequence` strictly greater than
  it.
- **Recovered upper-bound timing:** an interval has an authoritative start but
  no observed stop. Its stop is the earliest recovery or reaper observation
  after which Rally knows the work had ended, so `duration_ms` means “at most
  this long,” not an exact duration. Participant history qualifies that value
  and never presents it with observed precision.
- **Lossless reconstruction / perfect semantic accuracy:** canonicalizing the
  substrate projection and the Bind array at the provider boundary produces the
  same ordered encoding and hash. Message order, content-part order, roles,
  names, IDs, exact strings, and provider continuation fields are significant;
  JSON object-key order is not.

The classification boundary is provenance: a derivative must point to the
durable fact it wraps; a protocol-only message is itself the durable harness
control fact. The system message always uses the separate system-projection
contract. No record can be both protocol-only and derived. A participant-safe
tool summary and an exact model-facing tool result are different semantic facts;
so are a safe compaction status and its private replacement, or render-safe
content and provider continuation metadata. Identical assistant text is not
different: it has one canonical payload ID referenced from both orderings.

The normative ownership invariant is:

> Every semantic datum has exactly one owning record. Participant and Bind-loop
> rows are ordering, visibility, generation, and lifecycle projections that
> reference those canonical facts. Identical payloads may not be independently
> copied into both projections.

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
beside the canonical transcript-entry store used by `SubstreamAgent`, below
REST, socket, model replay, and desktop projections.

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
4. Give every semantic datum exactly one canonical owning record, then make the
   durable substrate sufficient to recreate, with perfect semantic accuracy,
   the complete ordered message state Bind used at every accepted model-call
   boundary and the state produced by each accepted assistant/tool transition.
   Participant and Bind-loop projections reference shared stable payload IDs;
   store a distinct projection-specific fact only when its content is genuinely
   different, and store the exact state when lossless reconstruction from parts
   cannot be proven.
5. Let a client load arbitrary blocks of complete transcript entries and
   compute every gap inside a known snapshot without splitting a conversation
   turn or inferring coverage from returned content.
6. Deliver both initial range slices in the first work-stream boot/snapshot
   response: the first unread turn with up to five preceding and five following
   turns, and the five latest turns. Opening at unread and jumping to the bottom
   must require no follow-up fetch before those messages can paint.
7. Put transcript-entry persistence, snapshot fencing, range scanning,
   actual-coverage reporting, tombstones, and canonical model projection in one
   shared durable transcript substrate rather than reimplementing them in each
   route.
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
    envelopes—durable without exposing their payloads through participant range
    bounds or feed payloads. A separate participant-safe compaction status event
    may expose only that compaction started/stopped and its timing. Recreate the
    system message from durable versioned prompt and plugin/skill activation
    state.
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
18. Make first-open transcript work independent of total transcript length.
    Unread-anchor lookup, five-before/five-after selection, latest-five
    selection, snapshot bounds, and child hydration must use declared
    object-local SQLite indexes with bounded candidate reads, no offset walk,
    no transcript-wide scan or temporary sort, and no intermediate network or
    regional-authority round trip between the two slices.
19. Preserve enough participant-safe, durably ordered compaction lifecycle data
    to render **Context automatically compacting** while active and **Context
    automatically compacted** after success in a future desktop release, with
    optional elapsed copy such as **Context automatically compacting for 2m
    34s** or **Context automatically compacted in 2m 34s**. Starts, reconnect
    baselines, terminal durations, failures, retries, and two distinct
    compactions must be reconstructable without exposing the compacted context
    or changing Bind's private projection.
20. Make activity timing product-nestable. The response-level activity can own
    assistant-turn activity; an assistant turn can own thinking, plugin, and
    compaction activity; a plugin block can own independently starting and
    settling tool-call activities. Every edge retains its own lifecycle and
    timing while parent totals remain wall-clock unions rather than sums. Live,
    reconnect, range, and historical projections must reconstruct the same
    hierarchy without requiring a nested physical persistence model.
21. Meet an end-to-end successful work-stream-open performance objective of
    p50 ≤ 1,000 ms and p90 ≤ 2,000 ms. Measure from the member's click, keyboard
    activation, or equivalent open intent in an already-running authenticated
    desktop through the correct initial viewport being visibly painted, both
    required initial range islands being resident, the snapshot/socket fence
    being armed, and the composer reaching its correct usable state. API-only,
    first-row-only, or cached-shell timing does not satisfy this goal.

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
5. **Reconstruct pre-cutover Bind interleaving that was never stored.** The
   backfill preserves the participant-visible ordering and exact compaction
   checkpoint arrays that exist in object-local SQLite. It does not query the
   Global inference archive, synthesize protocol messages from aggregate text,
   or claim that the old participant order is the exact provider order.
6. **Introduce cross-work-stream transcript search, a global transcript index,
   or cross-region transcript movement.** The owning `SubstreamAgent` remains
   authoritative.
7. **Make compaction delete or reorder prior participant entries.** Compaction
   changes model context and adds/updates its own participant-safe status event;
   it never changes the identity, sequence, content, or coverage of earlier
   conversation turns or status events.
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
15. **Ship the final compaction-status presentation in this PR.** This PR must
    persist and transport the typed lifecycle needed by a future renderer, and
    the current desktop must tolerate/store it without corrupting ranges. Exact
    iconography, whether active elapsed time is shown, and final visual treatment
    are deferred. The future copy may use **Context automatically compacting**,
    **Context automatically compacted**, and optionally **… for 2m 34s** while
    active or **… in 2m 34s** after completion.
16. **Include app launch, update download, sign-in, or workspace bootstrap in the
    work-stream-open latency SLO.** The clock starts from an interactive,
    authenticated desktop when the member chooses a work stream. These broader
    startup paths may have their own goals; excluding them does not permit the
    work-stream metric to stop at an API response or placeholder paint.

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

### Work-stream-open performance objective

For successful authorized opens from an already-running, authenticated desktop,
the end-to-end distribution must satisfy:

- p50 ≤ 1,000 ms.
- p90 ≤ 2,000 ms.

The client starts a monotonic timer at the originating click, keyboard
activation, deep-link dispatch, or equivalent member intent before route/cache
work begins. It stops only after one renderer commit has made the correct target
viewport visible—unread-centered when unread exists, otherwise latest—both the
unread and latest range results are resident and reconciled, any initial active
response/status checkpoint and its socket fence are installed, and the composer
has reached its correct sendable or authorized read-only state. It does not wait
for future response tokens or lazy loading of the intentionally uncovered middle
gap. A skeleton, header-only route, first returned row, API completion, or paint
of stale cached content is not completion.

The percentile population includes successful warm-cache, cold-client-cache,
cold/hibernated Durable Object, unread, latest, disjoint-range, and mid-stream
opens in configured deployments. Implementations report those cohorts separately as well
as the combined distribution so a fast cache-hit majority cannot hide a slow
cold or mid-stream path. Slow successful samples remain in the percentile; a
client may not restart the clock after navigation, authorization, retry,
snapshot, or render work has begun. Failed/cancelled opens emit their outcome
and elapsed duration separately and are never recorded as successful fast opens.

One privacy-safe client measurement records the monotonic duration, outcome,
region, app/protocol version, cache/DO state when known, unread-versus-latest
target, whether the two initial islands overlap, and whether an active response
was present. It contains no transcript content, tool payload, prompt, reasoning,
or restricted identifiers. The SLO is not a network timeout or defensive limit;
crossing it records a slow open rather than aborting otherwise valid work.

Before production samples exist, the implementation PR supplies a controlled
real-window Electron benchmark using the production open path and representative
cold/warm, unread/latest, disjoint, large-history, and mid-stream fixtures. It
reports the environment and raw durations plus p50/p90 rather than asserting on
an API microbenchmark. Once real samples exist, the client-measured production
distribution is the product authority.

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

These scopes form a product hierarchy. The response activity is the root. Each
assistant turn has an `assistant_turn_work` child scope that starts when work on
that reserved turn actually begins. A final/no-tool assistant turn stops after
its canonical commit. A tool-declaring assistant turn remains the product parent
of its declared plugin/tool activity until every declared invocation is
terminal; the next assistant turn is a later sibling under the same response.
Canonical turn content may therefore be committed while its activity scope is
still active; lifecycle terminality never reopens or mutates that content.
Thinking is ordered within and timed under the assistant turn. Plugin blocks are
ordered children of that turn, and each tool invocation is an independently
timed child of its plugin block. Parallel calls are sibling children: they may
start and settle in any order without changing their declared display order.

Nesting does not mean parent duration is the sum of child durations. Every scope
keeps its own start/stop intervals. A parent remains active while any required
child is active, cannot terminalize before those children, and displays the
wall-clock union of its own work and descendant work. Overlapping children count
once at the parent. A child completion cannot stop a parent while a sibling is
still active, and a child cannot be reparented by a late or duplicate edge.
Compaction attaches to the causally active assistant turn when one exists and
otherwise to the response; it remains a separate safe status entry in transcript
order.

The product tree may be materialized from flat lifecycle rows and stable scope
keys. No recursive SQL table, nested JSON write model, or parent-driven execution
serialization is required. The invariant is that live edges, active snapshots,
cold history, and range loads project the same stable ancestry and sibling order.
A snapshot containing an active descendant includes enough ancestor metadata to
render it without an orphan. Loading a child later merges it under the same
parent rather than duplicating either scope.

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

### Future context-compaction status

Before automatic compaction begins mutating the active Bind generation, the
substrate durably reserves one `context_compaction` participant status entry at
its exact `transcript_sequence` and opens its lifecycle revision. The safe entry
contains an opaque `compactionEventId`, `trigger = automatic`, optional
`responseId`, lifecycle state, authoritative `startedAtUtc`, and timing
accuracy. It does not contain the old messages, replacement summary, token
counts, prompt content, `loop_sequence`, or provider payload.

The same object-local SQLite transaction that commits the exact restricted
`state_replaced` transition advances the safe entry to `completed`; neither
projection can observe only its half of that completion. Its terminal revision
records `stoppedAtUtc` and canonical `durationMs`. A future desktop can therefore render
**Context automatically compacting** from the active revision and **Context
automatically compacted** from the completed revision, optionally appending a
formatted active **for 2m 34s** or terminal **in 2m 34s** duration. Timing is
always stored when observed; whether to show it is a presentation choice. If
compaction fails, is cancelled, or is abandoned during recovery, the lifecycle
closes with that truthful state instead of being rewritten as completed or
remaining active forever.

When linked to an active response, compaction time lies within the response's
wall-clock work union and is never added again as a child duration.

Socket delivery uses the same monotonic-revision start/stop edges as other
activities and never streams clock ticks. A first open or reconnect during
compaction includes the original UTC start, `snapshotAtUtc`, and authoritative
elapsed baseline, so a future active label can begin at the already-accrued
duration. Recovery after a durable replacement but before its stop edge closes
the event idempotently with a recovered upper-bound timestamp. Duplicate start,
completion, or recovery delivery cannot create another entry or change its
sequence.

Compaction status entries share participant transcript ordering and range
coverage but are not conversation turns and never project into Bind. The
five-before/five-after and latest-five selection counts remain counts of
displayable conversation turns; every status entry inside the selected
`transcript_sequence` span is returned as well. The latest span runs from the
fifth-latest conversation turn, or the earliest available entry when fewer
exist, through the snapshot fence; an active compaction newer than the latest
conversation turn is therefore included with its active-state baseline. The
current desktop range reducer must retain and reconcile this typed entry but may
leave it visually hidden until the dedicated presentation ships. Two separate
compactions create two separate stable entries and lifecycle histories.

A history request asks for a half-open range of top-level transcript-entry
sequences. For example, `[1, 21)` means entries 1 through 20, and `[21, 41)`
means entries 21 through 40. Each response says which interval the server
actually inspected.

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

1. **Unread slice.** Resolve the durable unread high-water line to the
   participant `transcript_sequence` described in the definitions, then include
   that anchored displayable turn, up to five preceding displayable turns, and
   up to five following displayable turns. Clip naturally at the beginning or
   snapshot end. A missing/retracted target normalizes to the first later
   displayable turn at the same snapshot fence. When no unread state exists, or
   when an expired/beyond-fence target has no retained displayable successor,
   this named slice is `null` with `unreadReason = no_unread` or
   `anchor_unavailable` respectively; the work stream opens on the already
   prefetched latest slice.
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

### 2026-08-28 — The test contract proves the product being shipped

**Decided:** The release contract covers the persistent substream loop,
reserve-before-await ordering, safe steer/queue/stop boundaries, exact
tool/elicitation settlement, failure after observable work, immutable canonical
history, conservative receipt recovery, atomic realtime delivery, bounded
ranges with indivisible manifest hydration, authority/locality, and renderer
convergence. It does not require compatibility migration or fleet operations,
provider-specific thinking matrices, a generic adapter program, synthetic
Electron percentile gates, or exhaustive generated/fault catalogs.

**Why:** Rally has no users to migrate and this is an authorized forward-only
cutover. The earlier 94-case catalog expanded acceptance into systems the
product does not need and obscured the incident being fixed: asynchronous work
could claim transcript order before the authority reserved it. Useful tests
must prove that product behavior across the real boundaries, not maximize the
number of theoretical combinations or require operational evidence for a fleet
that does not exist.

**Changes:** The former `T1`–`T14`, `H01`–`H38`, and `E01`–`E56` catalog is
replaced by ten architectural objectives and twelve behavior scenarios mapped
to actual suites. The original semantic-ordering and observable-failure gaps
remain explicit scenarios; their named tests are now implemented and await
exact-head CI. Shipped in #378.

### 2026-08-28 — Pending inputs are immutable ordered facts

**Decided:** A server-admitted pending input cannot be edited or cancelled. A
changed or withdrawn request is admitted as a new ordered input; delivery never
rewrites the earlier input's identity, payload, provenance, or arrival order.

**Why:** Edit and cancellation would add mutable lifecycle states and race them
against safe-boundary promotion. Immutable pending facts make replay,
server-authoritative overlays, and FIFO delivery converge on one answer without
another revision protocol.

**Changes:** This supersedes the earlier definition that allowed editing or
cancelling before promotion. Canonical-message immutability is unchanged.
Shipped in #378.

### 2026-08-28 — One persistent loop owns every substream activation

**Decided:** A substream-derived `loop_id` survives messages, idle intervals,
execution receipts, retries, and isolate replacement. A step ends only after one
accepted provider response and its already-declared tools settle. Steer input is
eligible there; queue input waits for terminalization to make the loop idle.
Stop prevents the next step but does not cancel provider or tool work already in
flight. Provider retry and fallback stop permanently after output or an effect
becomes observable.

**Why:** Per-message run identity let independent activations compete for
conversation order and made a safe step able to release the singleton while its
receipt was still running. Observable fallback could likewise produce two
semantic answers for one reserved position.

**Changes:** This supersedes the per-run loop identity, retry-reset, and
safe-step-idle requirements below. Execution receipts remain durable evidence,
failed partial output becomes a typed status pill, and the breaking cutover
retains valid canonical message history without a compatibility reader. Shipped
in #378.

### 2026-08-28 — The agreed sections stand; changes live here

**Decided:** An earlier revision of this change edited the agreed sections in
place — narrowing the substrate to `SubstreamAgent`, dropping the legacy
backfill and cleanup-receipt definitions that shipped with v27–v29, and
rewriting the deployment section around the forward-only cutover. Those edits
are reverted; the agreed text stands as written, and the entries above are the
record of what actually moved.

**Why:** The house rule for PRDs is append-only: sections 1–6 are the proposal
as it was agreed, and a reader needs both the original and the log to see what
happened. The in-place rewrite also erased definitions of receipts that had
already shipped, which made the document disagree with deployed history.

**Changes:** Nothing beyond restoring the text; the substantive supersessions
are the three entries above. Shipped in #378.

### 2026-08-28 — Oversized indivisible turns ship as payload-free envelopes

**Decided:** The "Oversized indivisible turns" mechanism in the agreed spec —
immutable per-revision turn manifests, participant-safe payload refs, a
chunked `load_transcript_blob` socket operation, and client-side byte-resume
hydration with hash verification — is not built. An indivisible turn that
exceeds the shared realtime-frame limit keeps its exact transcript sequence as
an envelope carrying `blocksOmitted: true` and the true block count, and the
desktop renders a "too large to display" placeholder in its canonical
position. `E45` and the manifest rows in the test-layer tables are superseded
accordingly: the shipping proof is that an oversized turn advances coverage as
a sequence-owning placeholder, on real workerd and in the renderer.

**Why:** Nothing in the product can produce an indivisible oversized turn
today — provider output is chunked well below the frame limit and pending
inputs are bounded at admission. The hydration protocol was roughly eight
hundred lines of transport, two schema tables, and a client engine serving a
row no code writes, in a seed-stage codebase whose rule is to build for the
product that exists. What the ordering bug actually requires is that an
oversized turn can never corrupt sequence coverage; the envelope alone proves
that.

**Changes:** The two manifest tables leave the v33 schema; the blob socket
operations leave the contracts; the desktop hydration engine is removed. The
`blocksOmitted` envelope is the entire contract a future delivery mechanism
would build behind, if a producer of such turns ever exists. Shipped in #378.

## Key design decisions

1. **Make a transcript entry the top-level durable ordering unit and a model
   turn the conversational unit.** A harness run is an execution envelope that
   may contain many assistant turns and tool-result exchanges. It is not a
   display row. Conversation entries preserve complete model turns; typed safe
   status entries can occupy the same feed sequence without pretending to be
   model messages. The rejected alternative was retaining one assistant row per
   run and trying to splice tool cards or operational markers into substrings of
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
5. **Separate stable order from mutable lifecycle.** `transcript_sequence` and
   block indexes never change. Every tool invocation carries a monotonic revision;
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
   substrate owns stable entry/turn/block identities, sequence allocation,
   snapshot fences, range scans, actual coverage, tombstones, safe status
   lifecycles, and model-protocol projection. `SubstreamAgent` and any future
   in-scope transcript-owning Durable Object supply their authority and
   visibility policy through adapters. The rejected alternative was duplicating
   range arithmetic and transcript reconstruction in each route or object,
   which would make equal gaps mean different things on different agent
   surfaces.
11. **Use an audience-specific sequence domain.** Private model instructions,
    private operational events, and rows a participant could never read do not
    consume advertised transcript positions. Typed participant-safe status
    events do. Coverage metadata is therefore not a side channel for hidden
    internal records. A tombstone occupies a position only when a previously
    participant-visible reserved turn produced no displayable content or was
    retracted.
12. **Make one breaking protocol cutover.** The canonical turn/range/activity
    protocol replaces the existing work-stream feed in one coordinated backend
    and desktop release. The server accepts only the new protocol; old desktops
    are unsupported and may fail closed without a guaranteed error shape. There
    is no capability negotiation, dual emission, dual read/write, or
    compatibility window. A separate one-time object-local operation projects
    the faithful legacy participant order and checkpoint references into the
    new substrate; it is not a compatibility reader. The rejected alternative was paying
    implementation and test cost for transitional behavior when Rally has no
    production users or transcript continuity to preserve.
13. **Signal activity edges; do not stream a clock.** Durable start/stop edges
    at every product scope and snapshot baselines make the backend authoritative
    about work while the desktop's monotonic clock makes active parent and child
    labels smooth and cheap. An edge carries or can be joined through stable
    ownership identities so nesting is reconstructable without requiring nested
    persistence. The rejected alternative was emitting a new string or token
    every second, which couples presentation cadence to transport health and
    competes with response text streaming.
14. **Measure wall-clock interval unions, not child sums.** Response timing is
    the union of its own and descendant working intervals. Assistant-turn and
    plugin parents follow the same recursive product rule; a plugin block spans
    its earliest child start through its last child settlement. This preserves
    the time a member actually waited when tools overlap; adding parallel child
    durations would overstate elapsed time.
15. **Keep response, assistant-turn, plugin, and invocation timing distinct but
    product-nestable.** The response execution envelope owns the full-response
    total, each assistant turn can own ordered thinking/plugin/compaction
    children, each plugin block owns its group duration, and each tool invocation
    retains its own lifecycle timing. The projector must reproduce stable
    ancestry, but storage may remain flat. The rejected alternatives were
    deriving every label from one run total or one tool row, neither of which can
    represent nested parallel work truthfully, and requiring recursive storage
    merely because the product renders a hierarchy.
16. **Create thinking blocks only from provider evidence.** Provider reasoning
    events establish a generic timed block and its order. Rally does not infer
    reasoning from silence or display provider reasoning payloads. The rejected
    alternative was treating all pre-text latency as thinking, which would
    mislabel queueing, network delay, moderation, and provider work that the
    protocol does not identify.
17. **Use two orderings over one canonical fact authority, never two transcript
    owners.** Participant `transcript_sequence` orders participant-visible turns
    and safe status events. Restricted `loop_sequence` orders every exact
    non-system message Bind consumes or accepts, including private protocol
    facts, model-facing derivatives, and compaction replacements. Both
    projections reference stable canonical fact/payload IDs. Identical assistant
    text is stored once; participant-safe tool summaries versus exact
    model-facing results, safe compaction status versus private replacement, and
    render-safe content versus provider continuation metadata are separate facts
    only because their semantics genuinely differ. The current system message
    remains a deterministic versioned projection of durable prompt inputs and
    activated plugins/skills. Creation of a canonical fact and all projection
    rows required for that accepted transition is one regional object-local
    SQLite transaction. The rejected alternatives were dual-writing identical
    payloads into two transcript stores, leaking private rows through feed
    coverage, and rebuilding model state from an intentionally filtered UI view.
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
20. **Index the boot query shapes, not merely their columns.** The participant
    sequence and displayable-sequence indexes support forward and reverse
    bounded traversal for unread neighbors, latest turns, snapshot bounds, and
    arbitrary ranges. The boot selects both islands inside one admitted
    object-local operation, unions their turn/response identities, and bulk
    hydrates children once. The rejected alternatives were an unverified index
    that SQLite does not select, `OFFSET` pagination, scanning tombstones to find
    five displayable turns, and independently hydrating overlapping slices.
21. **Project compaction lifecycle, never compacted context.** Reserve a typed
    participant status entry when compaction begins; the transaction that
    commits the restricted replacement terminalizes that same safe entry. Store safe UTC
    timing and lifecycle revisions so a future client can render active and
    completed labels. The replacement messages, summary, token counts, private
    bounds, and provider payload remain restricted. The rejected alternatives
    were deriving a historical marker from a later checkpoint, which loses live
    and failure state, and exposing the private summary as a participant system
    message.
22. **Measure the complete visible open, not a convenient subsystem.** The SLO
    begins at member navigation intent and ends only when the target transcript,
    both prefetched islands, active-state fence, and usable composer have
    converged in the renderer. Client monotonic timing is authoritative; cohorts
    remain visible and slow successful opens stay in the percentile. The
    rejected alternatives were timing only REST/DO work, stopping at first paint
    or a skeleton, and allowing warm cache hits to hide cold or mid-stream
    latency.

## Data model

The shared durable transcript substrate is a storage/projection component, not
a new global authority. It runs inside the Durable Object that already owns the
conversation and uses that object's SQLite transaction, authorization, region,
and lifecycle. No cross-object transcript database is introduced.

There is exactly one regional source of truth for transcript semantics. Its
physical model has three conceptual layers:

| Layer | What it owns | What it must not own |
| --- | --- | --- |
| Canonical facts/payloads | Each assistant text/block payload, participant-safe summary/status lifecycle, exact model-facing derivative, protocol-only message, private replacement, and provider-continuation datum exactly once. | Sequence position in either projection or a second copy made only for reader convenience. |
| Participant projection | `transcript_sequence`, participant visibility/kind, stable fact references, and participant lifecycle placement. | A duplicate of canonical text or of any restricted payload. |
| Bind-loop projection | `loop_sequence`, loop generation/revision, transition kind, stable fact references, and projector metadata needed for exact replay. | A duplicate of participant text or a sanitized replacement for an exact private fact. |

The two projections are indexes over different sequence domains, not
independently writable transcript documents. A committed semantic fact is
referenced by one or both projections according to its visibility and
lifecycle. Where both need identical
assistant text or another identical payload, both rows reference the same
stable payload ID. Projection-specific canonical facts exist only for genuine
semantic differences: participant-safe tool summary versus exact model-facing
tool result, compaction status versus private replacement, and render-safe
content versus provider continuation metadata.

Every canonical fact records `origin_kind`. `canonical` and `protocol` facts
have no source identity; `derived` facts require non-empty `source_kind` and
`source_id` plus an optional non-negative `source_revision`; system projection
facts use the separate `system_projection` kind and identify their prompt-input
hash and renderer revision. These are provenance fields on the fact, not copied
payload bytes or a third ordering projection. The authority indexes
`(source_kind, source_id, source_revision)` so ownership audits and replay
diagnostics do not scan the fact ledger. Provider adapters must strip provenance
metadata before network serialization and prove that the provider-boundary hash
still covers only the exact model message array.

For every accepted transition, the authority creates any new canonical fact
records and every required participant/Bind ordering or lifecycle row in one
object-local SQLite transaction. A failure in either projection rolls back the
fact and the other projection; no outbox, compensating write, or later repair is
the normal consistency mechanism. Subsequent inference and participant reads
therefore select different indexes over one committed fact graph. API responses
may flatten referenced payloads for transport, but that denormalization is not
durable ownership and may not be written back as another source of truth.

The required authority inventory at the time of this PRD is:

| Saved LLM conversation | Authority | Scope in this PRD |
| --- | --- | --- |
| Work-stream main feed and any future independently addressable substream | `SubstreamAgent` | In scope: replace direct `parts` pagination/projection with canonical conversation turns, safe status entries, blocks, range coverage, and a restricted lossless Bind-loop projection. |
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

The substrate stores restricted model-protocol ordering/generation rows beside
the participant ordering rows inside the same authority and transaction domain.
Those rows reference canonical facts; they are not a second payload store. They
are not returned by participant history APIs and do not use
`transcript_sequence`. Their job is to make the state Bind actually consumes
and produces durable across Worker loss, retry, code deployment, and compaction.

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

Thereafter the rows form an ordered protocol ledger. Each transition below is
reconstructed from its canonical fact references; listing the complete message
shape does not authorize an inline projection-local payload copy. Conceptual
transitions are:

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
`loop_sequence`, `state_revision`, transition kind, stable canonical fact/payload
references, projector version, source turn/receipt identity where applicable,
and canonical payload hashes. Exact protocol content lives in its one canonical
owning record, not inline in a second loop-owned copy. A protocol-only message or
model-facing derivative may itself require a new restricted canonical fact;
shared assistant text references the already-owned text payload while distinct
provider continuation metadata references its own restricted fact. JSON object
property order is not meaningful, but message order, content-part order, roles,
names, IDs, exact strings—including tool argument/result strings—and
provider-defined ordered continuation fields are meaningful and must survive
round-trip.

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
healer changing the reconstructed array is itself a mismatch. Initial input may
be healed before `state_initialized`; the exact post-healing output becomes the
first durable baseline. The backfill does not create a pre-cutover Bind
generation because the legacy aggregate rows cannot reproduce one exactly. A
mismatch fails before provider inference rather than silently allowing Bind and
the durable transcript to fork.

Failed or abandoned provider attempts, partial response bytes, and route-reset
text do not enter the accepted Bind loop state because Bind did not accept them
into `state.messages`. They remain attempt/stream recovery evidence. A successful
assistant message becomes durable before `callModel` returns it to Bind, and an
exact tool-result message becomes durable before `runToolCall` returns it to
Bind. Parallel tools may settle in any order, but their accepted protocol
messages project in the call order Bind uses.

Neither deployment nor replay queries the Global raw-inference lakehouse to
construct participant turns or Bind state. Pre-cutover participant-visible rows
are first projected from their owning object-local `parts` records, in
`parts.sequence_number` order, without copying their payloads. Exact legacy
compaction arrays are initially reached through a canonical reference to
`compaction_checkpoints`. A separate explicit ownership transfer then moves
every retained message, attachment, mention, and exact checkpoint payload under
canonical facts, reusing an already-canonical post-cutover checkpoint fact
rather than copying it. Only after every object reconciles that transfer may the
legacy owners be dropped. Neither operation turns a pre-cutover aggregate row
into a Bind message or loop generation, and neither invents or changes a
compaction status/activity edge.

### Participant transcript projection

The single regional authority stores participant ordering/lifecycle rows with
the following conceptual fields. These are the flattened product/API shape; a
field that belongs to a referenced canonical fact is not duplicated into the
physical projection row:

- `entry_id`: stable opaque identity.
- `transcript_sequence`: monotonic sequence allocated once and never reused.
- `entry_kind`: `conversation_turn` or `status_event`.
- `turn_id` and `role`: present for conversation turns; role is `human`,
  `assistant`, or participant-visible `system`.
- `status_event_id` and `status_event_kind`: present for status entries; the
  first kind is `context_compaction`.
- `run_id` and `model_turn_index`: present for assistant turns and unique
  together within a run.
- `attention_ordinal`: nullable participant read/unread order for displayable
  conversation turns; safe status entries and non-attention-bearing turns carry
  `null`. It is distinct from `transcript_sequence`.
- `state`: `streaming`, `committed`, or `retracted` for conversation turns;
  `active`, `completed`, `failed`, `cancelled`, or `abandoned` for status events.
- `lifecycle_revision`, UTC start/stop timestamps, canonical duration, timing
  accuracy, and safe trigger metadata for status events.
- `created_at`, `committed_at`, and the existing attribution/visibility data.

Each assistant turn projects ordered blocks by stable canonical payload IDs:

- A text block has `block_index`, one shared canonical Markdown payload ID, and
  a reference to any genuinely distinct render-safe structured representation
  already used by the feed. The Bind envelope references the same Markdown
  payload when its text is identical.
- A tool block has `block_index`, provider call ID, stable Rally invocation or
  receipt ID, model `call_index`, plugin/tool attribution, a participant-safe
  display-summary fact reference, lifecycle state, lifecycle revision, and the
  existing durable result/error reference.
- A thinking block has `block_index`, provider-turn/stream-epoch attribution,
  lifecycle revision, and one or more timing intervals. It contains no
  member-visible reasoning payload. It exists only when normalized provider
  events prove an observable reasoning item occurred.

`block_index` is zero-based, dense display order and restarts inside each
assistant turn; `(turn_id, block_index)` uniquely identifies one block.
`call_index` is zero-based and dense within the provider assistant message's
ordered tool-call array and remains the source for returning parallel results to
Bind. It restarts for each provider assistant message. Neither index is derived
from start or completion time.
Large or sensitive raw result bodies stay in their current regional authority;
the participant projection references only authorized display facts. If Bind saw
a model-facing derivative of that result, the restricted loop projection
references that derivative's one canonical fact or its lossless pinned payload.

Assistant acceptance is the clearest atomicity example: one SQLite transaction
creates the canonical assistant/block facts, participant
`transcript_sequence` references, restricted `loop_sequence` references,
provider-only continuation facts when present, and durable tool execution plan.
Tool dispatch cannot observe only one ordering. The same rule applies to exact
tool-result acceptance and compaction replacement/status transitions: facts
whose content differs have separate owning records, while all unchanged shared
payloads remain single records referenced from the necessary projections.

#### Required indexed access paths

The substrate schema must make the initial two-range boot and later range reads
index-driven. Physical table and index names may follow repository conventions,
but the following access paths are normative:

- A unique B-tree over participant `transcript_sequence`. If one physical table
  ever holds more than one sequence domain, the domain key precedes
  `transcript_sequence` in every index and query below. In today's
  one-domain-per-`SubstreamAgent` authority, `transcript_sequence` alone is the
  key. This index serves exact anchors, snapshot `MIN`/`MAX`, tombstone-aware
  range membership, and forward or reverse bounded scans.
- A partial B-tree over `transcript_sequence` for displayable conversation turns
  where `entry_kind = 'conversation_turn'` and
  `state IN ('streaming', 'committed')`. SQLite may traverse the same B-tree in
  either direction; a duplicate descending index is not required. This index
  serves the normalized unread anchor, five displayable-turn predecessors, five
  displayable-turn successors, and the five latest displayable turns without
  walking tombstones or counting status entries against the requested five.
- A partial B-tree over `(attention_ordinal, transcript_sequence)` for
  conversation turns where `attention_ordinal IS NOT NULL`. The authority first
  compares the source ordinal with the retained attention floor; a lower value
  is `anchor_unavailable`. Otherwise this index resolves the existing
  participant unread high-water ordinal to the first retained displayable
  `transcript_sequence` at or after that ordinal with ascending `LIMIT 1`; it
  never scans turns or treats a status event as unread.
- A partial B-tree over `(status_event_kind, state, transcript_sequence)` for
  rows where `entry_kind = 'status_event'`. It finds active compaction newer than
  the latest conversation turn without scanning historical entries. The
  full-sequence range read returns terminal/intervening status entries inside
  selected spans.
- A partial unique identity index over `(run_id, model_turn_index)` where both
  values are non-null for assistant turns, plus ordered child indexes/keys over
  `(turn_id, block_index)` and response/activity lookup keys beginning with
  `response_id` and then `assistant_turn_id`. These make hydration proportional
  to the selected turns and responses rather than transcript length.
- The member read-state row that supplies the unread high-water line is a point
  lookup by `user_id` inside the one-work-stream authority. The substrate
  resolves that attention ordinal through the declared attention index to one
  `transcript_sequence`; it does not reinterpret the ordinal as a transcript
  sequence. An adapter that stores multiple work streams together must prefix
  that primary/unique key with the work-stream/domain identity. It may not scan
  participant/read-state rows to discover the member's anchor.

Within the shared snapshot fence, the substrate first rejects an ordinal below
the retained attention floor, then resolves an in-range attention ordinal to a
retained displayable turn through the attention index. If that
turn is missing or retracted, it normalizes by finding the first displayable
`transcript_sequence >= anchor` and `<= snapshotThroughSequence` with ascending
`LIMIT 1`. If neither lookup can produce a retained turn, it returns the
declared `anchor_unavailable` fallback rather than silently clamping to an
unrelated oldest row. It otherwise reads up to five displayable predecessors
with descending `LIMIT 5`, up to five successors with ascending `LIMIT 5`,
and the live tail with
`transcript_sequence <= snapshotThroughSequence`, descending `LIMIT 5`.
The unread boundary-to-boundary span and the latest span from its earliest
selected conversation turn—or earliest available entry when it selects no
turn—through the snapshot fence are then read through the full-sequence index,
so intervening or trailing status events and tombstones have truthful coverage.
No query uses `OFFSET`.

The unread and latest selectors run in the same admitted Durable Object storage
operation and snapshot. Their stable turn IDs and referenced response IDs are
unioned with stable status-entry IDs before blocks, activity, authors, mentions,
attachments, and resources are bulk hydrated, so overlap is fetched once. SQL
statement count and authorization work remain constant as total transcript
length grows; returned payload work remains proportional to the selected
entries/blocks and existing transport-size rules.

Index presence alone is insufficient. The implementation tests the production
SQL with `EXPLAIN QUERY PLAN` against a large fixture containing tombstones and
compaction status entries. Every anchor, predecessor, successor, latest, bound,
status-event, and range selector must use its declared sequence index, with no
full transcript/read-state scan and no `USE TEMP B-TREE` sort. The test also
asserts the bounded `LIMIT` query shapes, batched union hydration, and constant
statement count. Wall-clock thresholds are not used as correctness assertions
because they are noisy and cannot prove the access path.

The harness run remains an execution envelope even though it is not a transcript
row. It has a stable `response_id` linked to the initiating participant turn,
and every assistant turn it produces references that response. Any range that
returns a member turn also returns the referenced response envelope metadata,
deduplicated by `response_id`; doing so provides the full-response timing label
without claiming that unloaded transcript turns inside the response are
covered.

Activity timing is stored in the same regional authority as conceptual records
with these fields:

- `activity_id`, optional `response_id`, and `kind`: `response_work`,
  `assistant_turn_work`, `plugin_work`, `tool_work`, `thinking`, or
  `context_compaction`.
- Optional scope keys as appropriate: `assistant_turn_id`, `block_index`,
  `plugin_id`, `tool_invocation_id`, and `status_event_id`. Internal
  provider-attempt or compaction-payload data is not a member-visible key.
- A stable parent relation in the participant projection, either stored directly
  or derived without ambiguity from those scope keys. Current product ancestry
  is response → assistant turn → plugin → tool, with thinking and compaction
  attached to their causal response/turn scope. A physical recursive tree is not
  required.
- Stable sibling order from transcript/block/call indexes, never lifecycle
  arrival time.
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
effect leaves only the later recovery/reaper boundary known, Rally uses the
earliest observation after which it knows work had ended. The stored duration
is an upper bound and the historical UI qualifies it as **at most …** rather
than presenting false precision. Repeated working episodes—for example, a response paused for
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

Each edge exposes its stable scope identity and enough ownership/order keys to
place it under the same product parent on every client. A protocol may include
an explicit `parentActivityId` or deterministically derive the parent from
`responseId`, `assistantTurnId`, plugin-block identity, and invocation identity;
the product result must be identical. Edge arrival order never defines ancestry
or sibling order.

A boot, first join, reconnect, or range response returns `snapshotAtUtc`, the
canonical completed total, and each active interval's `startedAtUtc` plus
`elapsedMsAtSnapshot` at that snapshot boundary. The desktop atomically rebases
its monotonic presentation clock on those values. Thus opening a work stream
seven minutes into an existing run starts near seven minutes rather than zero;
the UTC start is transmitted even though the server-computed elapsed value—not
the client's wall-clock subtraction—is the display authority.
The snapshot includes the complete ancestry and sibling-order metadata for every
active scope, including parents that have no new edge in the replay window, so a
mid-stream open cannot receive an orphan tool or plugin timer.
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
  "entries": []
}
```

The first-open boot/snapshot groups two such responses under stable purposes:

```json
{
  "snapshot": {
    "earliestAvailableSequence": 1,
    "throughSequence": 87
  },
  "initialTranscriptRanges": {
    "unreadReason": null,
    "unread": {
      "anchorSequence": 32,
      "coverage": { "startInclusive": 27, "endExclusive": 38 },
      "entries": []
    },
    "latest": {
      "coverage": { "startInclusive": 83, "endExclusive": 88 },
      "entries": [{
        "entryId": "entry_turn_active_9",
        "entryKind": "conversation_turn",
        "turnId": "turn_active_9",
        "transcriptSequence": 87,
        "state": "streaming",
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
    "activities": [{
      "activityId": "activity_response_9",
      "intervalId": "interval_response_9_1",
      "kind": "response_work",
      "state": "active",
      "revision": 3,
      "completedDurationMs": 0,
      "startedAtUtc": "2026-08-26T17:00:00.000Z",
      "snapshotAtUtc": "2026-08-26T17:07:42.000Z",
      "elapsedMsAtSnapshot": 462000,
      "timingAccuracy": "observed"
    }]
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
is nullable with the declared `unreadReason` when no usable anchor exists. The
active response array carries one normalized activity record in this shape for
each active response, assistant-turn, plugin, tool, thinking, and compaction
scope; completed prior intervals contribute `completedDurationMs`, while
`checkpointRevision` remains content-only. Both named slices, every active
checkpoint/lifecycle baseline, `resumeAfterEventSequence`, and the advertised
earliest/through bounds are captured against the one top-level `snapshot`;
they are never assembled from different transcript moments. The client verifies
both slices against that shared descriptor, installs activity baselines by
`activityId`, `intervalId`, and `revision`, and then accepts room events only
when `event.sequence > resumeAfterEventSequence`.

`coverage` is the range the authority actually scanned. If an existing
transport-size rule shortens a response, `endExclusive` stops at the scanned
boundary rather than echoing the requested bound. The client stores normalized
non-overlapping intervals and computes gaps as the complement inside
`[earliestAvailableSequence, throughSequence + 1)`. For example, coverage of
`[1, 21)` and `[41, 61)` inside `[1, 88)` has gaps `[21, 41)` and `[61, 88)`.

### Oversized indivisible turns

A complete conversation turn can exceed the existing encoded response/socket
bound even when each individual text or tool block is valid. Range shortening
cannot solve that case: returning the same one turn again would strand the
client at its sequence. The canonical protocol therefore never uses
`message_page_too_large` as the terminal result for an authorized canonical
turn.

When the inline turn would exceed an existing transport bound, the range
response returns a small complete turn envelope at that
`transcriptSequence`: stable entry/turn identity, role/state/revision,
attribution, block count, and an immutable `turnManifestRef`. The referenced
manifest preserves every `block_index`, block kind, lifecycle identity, and
canonical payload ID without copying payload bytes into the projection.
Individual large participant-safe payloads are likewise represented by opaque
`payloadId`, byte length, media type, and canonical hash. The IDs are
authority-scoped handles, not raw R2/object keys.

The admitted client hydrates the manifest and payloads through a region-local
authorized byte-range stream whose chunks obey the existing transport rules.
One hydration operation performs one reader admission and reuses it for all
chunks; it never performs authorization per block or byte range. Manifest and
payload chunks are not transcript entries and consume no
`transcript_sequence`. The client verifies the pinned revision, byte length,
and hash before replacing the loading presentation.

Receiving the envelope truthfully covers that transcript sequence, so the
client can continue loading both older and newer turns while the large turn
hydrates. It tracks payload hydration separately from transcript range
coverage. A missing, changed, unauthorized, or failed payload produces a
retryable block/turn-specific error and never causes the transcript gap loader
to request the same sequence forever or substitute restricted/model-facing
content. This is an out-of-line representation of the same canonical facts,
not permission to split one conversation turn across transcript ranges.

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

The participant `transcript_sequence` domain is materialized at write time from
participant-visible conversation turns and safe status entries only. Restricted
system/protocol rows, compaction payloads, and other substreams never occupy it,
so an authorized range read is a direct indexed scan rather than a per-row
authorization filter or join. The number of authorization decisions and
regional authorization queries is therefore constant as page size, block count,
and gap count grow. The unread and latest slices in one boot share the same
decision. Bulk author/resource hydration may remain batched, but may not
introduce per-entry authorization calls.

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

Participant turn-manifest and payload hydration reuses the same work-stream
reader-admission contract and returns only participant-safe canonical facts.
Opaque hydration handles reveal neither regional object keys nor restricted
payload existence; authorization failure is indistinguishable from unavailable
participant content at that read boundary.

Tool arguments, results, and failures retain their existing display
sanitization and result-reference rules. Lifecycle events are accepted only for
the matching run, turn, invocation, and newer revision; model-supplied IDs do
not select another turn. Structured logs and telemetry may carry opaque turn,
run, range, and invocation identifiers, but not response text, tool arguments,
tool output, or provider error prose.

The work-stream-open performance event may carry duration, outcome, region,
app/protocol version, coarse cache/DO cohort when known, open target, range
overlap, and active-response presence. It may not carry transcript content,
titles, prompts, tool/reasoning payloads, or restricted projection identities.

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
follow-up work. The implementation pull request must map every named `H*` and
`E*` test ID to its actual test file and test name, and map every `T*`
objective to the target suites/files that collectively prove it. An implementer
may split a listed target file when that makes ownership clearer, but may not
omit or weaken the stated objective or assertions. Tests use fixed protocol
fixtures and literal expectations; they do not generate the expected result by
calling the projector or reducer under test.

Acceptance criteria and named tests have a many-to-many relationship: one
criterion may require several runtime layers, and one fixture may prove several
criteria. Their counts are not expected to match; the implementation PR's
mapping makes the coverage explicit.

### Test objectives

| Objective | What the suite must prove |
| --- | --- |
| `T1 Protocol fidelity` | The restricted substrate reconstructs the exact accepted Bind loop state, including the freshly rendered system head, message/content-part order, roles, IDs, exact strings, and provider continuation fields. |
| `T2 Causal durability and single ownership` | Every semantic datum has one canonical owner; required participant and Bind-loop rows reference that fact and commit atomically before Bind, tool dispatch, terminal publication, or compaction can advance past it. |
| `T3 Live ordering and concurrency` | Response tokens remain immediately streamable while text, thinking, and multiple tool calls start and settle independently without changing model-declared display order. |
| `T4 Range, gap, and payload-hydration truth` | Snapshot-fenced transcript-entry ranges report what was actually inspected, the desktop computes loaded islands and gaps correctly for empty, shortened, overlapping, disjoint, status-bearing, and realtime-extended history, and an oversized indivisible turn advances coverage through its manifest while its canonical payload hydrates independently. |
| `T5 Activity-time truth` | Response, plugin, invocation, and observable-thinking timers use authoritative UTC starts, first-join/reconnect elapsed baselines, lifecycle edges, and interval unions; local ticking never requires server clock frames and survives late join, pause, sleep, reconnect, and history load. |
| `T6 Recovery and idempotency` | Worker loss, Durable Object eviction/hibernation, socket replay strictly beyond the durable `resumeAfterEventSequence`, retries, duplicate events, and compaction recover without loss, duplication, reordering, or identity reuse. |
| `T7 Authorization and locality` | Participant APIs reveal neither restricted payloads nor restricted bounds, and configured deployment authorities never use one another as transcript or inference-archive fallbacks. |
| `T8 Breaking cutover and faithful backfill` | One coordinated release establishes the canonical-only protocol without dual paths, capability negotiation, or a compatibility window; a separate idempotent, quiescent object-local backfill projects all retained pre-v27 participant rows and exact checkpoint references, records a PITR bookmark/receipt, and explicitly leaves unavailable Bind history unavailable. |
| `T9 Visible product behavior` | A real desktop window visibly preserves interleaving, gap loading, unread opening, instant jump-to-latest, smooth streaming, parallel activity, and historical timing labels. |
| `T10 Constant-cost reader admission` | One external boot/range operation or socket admission authorizes once and reuses an epoch-fenced capability across all slices, active state, and hydration; authorization work never scales with returned entries, blocks, or gaps. |
| `T11 Indexed initial loading` | Attention-ordinal resolution, unread-anchor, neighbor, latest, bounds, and arbitrary-range production queries choose declared SQLite indexes; the two initial islands share one snapshot and one deduplicated bulk-hydration pass without a full scan, temporary sort, offset walk, or transcript-length-dependent statement count. |
| `T12 Future compaction status` | Every automatic compaction has one durably ordered participant-safe status entry with active/terminal revisions, UTC timing and reconnect baselines, truthful failure/recovery, and no compacted-context disclosure; the current reducer preserves it so future UI can render happening/happened labels without a storage migration. |
| `T13 Product-nested activity` | Response, assistant-turn, plugin, tool, thinking, and compaction scopes project as one stable hierarchy across live edges, reconnect, ranges, and history; siblings remain parallel/ordered, parents use wall-clock unions, and equivalent flat or nested persistence shapes produce the same product tree. |
| `T14 End-to-end open performance` | Client-monotonic click-to-usable-open measurement covers the correct visible target, both prefetched islands, active snapshot/socket fence, and composer state; controlled real-window evidence meets p50 ≤ 1,000 ms and p90 ≤ 2,000 ms and production telemetry preserves cohort visibility without content. |

### Required test layers and artifacts

| Layer | Target | Responsibility |
| --- | --- | --- |
| Pure harness protocol | `packages/agent-harness/src/bind-loop-projection.test.ts` | Fixed-message canonicalization, projector round trips, system-projection revision changes, provider continuation fields, protocol/derivative classification, and mismatch detection. |
| Substrate and SQL | `apps/api/test/workstream-transcript-substrate.test.ts` using the real object schema through `createTestSqlStorage()` | Single-owner fact schema, projection references, atomic cross-projection transactions, exact attention/range index scans, `EXPLAIN QUERY PLAN` assertions, tombstones, immutable turn-manifest/payload references, transition ordering, and idempotent clean-cut schema installation. |
| Real Cloudflare runtime | `apps/api/test-workers/workstream-transcript-runtime.test.ts` | Real `SubstreamAgent`, object-local SQLite, RPC, WebSocket, eviction/hibernation, concurrency, failure boundaries, and snapshot fencing. This suite may not replace the Durable Object or its storage with a double. |
| Desktop range/state reducer | `apps/desktop/src/renderer/lib/workstream-turn-ranges.test.ts` | Range union/complement, stable turn/status-entry reconciliation, independent manifest/payload hydration state, nested activity ancestry and sibling order, stream epochs/event fences, stale lifecycle rejection, timers, hidden compaction-entry retention, and realtime singleton coverage. |
| Desktop component | `apps/desktop/src/renderer/screens/workstream-turn-feed.test.tsx` | Ordered DOM blocks, streaming updates, dual initial islands, jump/scroll behavior, generic thinking/timing labels, and accessibility names. |
| Full local member pipeline | Extend `scripts/e2e-local.mjs` and `scripts/e2e-local-oracles.test.mjs` | Public API/socket behavior against opened Durable Object authority, including real provider interleaving when credentials are configured and a fixed scripted-provider fixture in CI. |
| End-to-end performance acceptance | Extend the production-path local E2E driver with a work-stream-open benchmark mode and write its raw timing/report artifact outside the repository. | Real Electron click-to-visible-and-usable durations across declared warm/cold, unread/latest, disjoint, large-history, and mid-stream cohorts; report combined and cohort p50/p90. This is release evidence, not an API microbenchmark or a new per-test timeout. |
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
| `H05 reconstructs_fixed_bind_fixture_exactly` | harness + SQL | Persist a literal fixture containing system, participant, protocol-only, derived, assistant/tool, and continuation fields; assert `loop_id = harnessRunId = run_id`, generation 1 at initialization, and the literal canonical encoding/hash at each boundary. |
| `H06 regenerates_system_after_plugin_activation` | harness + workerd | Activate a plugin during the loop; assert a durable projection revision precedes use, the regenerated system head contains the new activation, non-system ordering is unchanged, and both hashes match. |
| `H07 records_protocol_and_derivative_provenance` | harness + SQL | Persist a continuation nudge, compaction summary, recalled-memory wrapper, trigger wrapper, interrupt wrapper, and tool result; assert their explicit kinds and required/no-source identities match the definitions. |
| `H08 compacts_and_resumes_the_same_loop_generation` | workerd | Commit an exact compaction replacement, assert `loop_generation` advances exactly once from 1 to 2 under the same `loop_id/run_id`, evict the object, resume, and assert the next provider array equals the pre-eviction projected generation while earlier ledger/history remains queryable. |
| `H09 loads_disjoint_ranges_and_reports_middle_gap` | SQL + desktop | Load `[1,21)` and `[41,61)` against snapshot 87; assert exact actual coverage, gaps `[21,41)` and `[61,88)`, stable ordering, and no inferred coverage from row count. |
| `H10 merges_overlapping_ranges_idempotently` | SQL + desktop | Load overlapping ranges in both arrival orders; assert one copy per stable transcript entry, normalized coverage union, and identical final state. |
| `H11 opens_with_unread_and_latest_islands` | workerd + desktop | Resolve the durable attention ordinal, then return five turns before/after the unread anchor and five latest turns. Assert the one top-level earliest/through snapshot descriptor fences both slices, active state, and `resumeAfterEventSequence`; unread paints first, both islands are cached, and the uncovered middle remains a gap. |
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
| `H22 deploys_canonical_protocol_as_the_only_feed` | workerd + desktop | Install the new object schema, backend protocol, and current desktop fixture; assert first open, range loading, streaming, replay, and terminal history use only canonical transcript entries/activity and register no legacy emitter, reader, or capability branch. |
| `H23 backfills_legacy_participant_order_before_canonical_suffix` | SQL + workerd | Seed participant-visible pre-v27 human, assistant, external, text, and tool rows with non-contiguous legacy sequence numbers plus post-cutover canonical turns. Run the backfill and assert the old rows occupy the exact ordered prefix, the existing suffix shifts without changing turn identity/content, the counter advances correctly, and no Bind head or message is invented. |
| `H24 keeps_participant_and_restricted_projections_linked_without_copying_payloads` | SQL + workerd | Commit an assistant turn used by both views, an exact model-facing tool result plus participant-safe summary, provider continuation metadata plus render-safe content, and compaction status plus private replacement. Inspect durable rows and read participant ranges/resume inference: assert identical assistant text exists under one canonical payload ID referenced by both orderings; genuinely different safe/private facts have different owners and visibility; no projection table contains an independent payload copy. Exact private replay must not derive from the participant view, and the participant view must not expose the restricted fact. |
| `H25 compacts_twice_across_distinct_events_and_resumes_second_generation` | workerd | Accept activity, commit compaction event A, accept additional assistant/tool activity, then commit distinct compaction event B. Assert two `state_replaced` transitions with distinct event/source revisions, three ordered loop generations, retention of both exact replacements, unchanged participant conversation turns plus two separately ordered safe compaction status entries, and post-eviction replay from B with the exact next provider array. For each event, assert the restricted replacement and terminal safe-status revision commit atomically while retaining separate canonical facts. Replay either event ID and assert idempotency rather than a third replacement generation or status entry. |
| `H26 joins_existing_stream_with_utc_start_and_elapsed_baseline` | workerd + desktop + E2E | Start a response before a second client opens the work stream. On first join, assert every active scope carries `activityId`, `intervalId`, lifecycle `revision`, `completedDurationMs`, original `startedAtUtc`, server `snapshotAtUtc`, full prior `elapsedMsAtSnapshot`, and `timingAccuracy`; the label paints completed plus active duration immediately, continues from the local monotonic receipt point, and is replaced by canonical terminal duration. |
| `H27 opens_workstream_mid_stream_with_atomic_checkpoint_and_catchup` | workerd + desktop + E2E | Before the client opens the work stream, stream accumulated text and produce planned, running, completed, and failed parallel tool states plus an active thinking block. Assert the first boot paints the exact accumulated ordered state and revision-fenced timing baselines, retains unread/latest islands, and captures one top-level earliest/through snapshot plus `resumeAfterEventSequence` from the same object-local boundary. Apply only later room events and assert subsequent text/tool/thinking frames appear once without another fetch. |
| `H28 authorizes_boot_once_for_all_ranges_and_active_state` | API Node + workerd | Open with disjoint unread/latest slices, active stream checkpoints, lifecycle timing, authors, mentions, attachments, compaction status, and tool blocks. Instrument the typed reader-admission boundary and assert one admission decision for the complete boot, zero per-entry/block calls, and the same admitted capability identity on every internal scan/hydration. Repeat through the initial socket snapshot and assert it reuses the socket admission. |
| `H29 uses_indexed_bounded_queries_for_initial_ranges` | SQL + workerd | Populate a large attention/tombstone/status history with overlapping unread/latest islands and an active compaction after the latest conversation turn, inspect the exact production SQL with `EXPLAIN QUERY PLAN`, and instrument statement/hydration boundaries. Assert the member read state is a point lookup; retained-attention-floor comparison, attention-to-transcript resolution, anchor normalization, predecessor, successor, latest, active-status, bounds, and coverage/range selectors use the declared indexes in forward/reverse order with their bounded limits; neither selector uses `OFFSET`, a full transcript scan, or a temporary B-tree; and the union of both islands/status is bulk hydrated once with a statement count independent of total history length. |
| `H30 persists_compaction_lifecycle_for_future_rendering` | SQL + workerd + desktop reducer | Begin automatic compaction between two conversation turns. Assert one participant-safe `context_compaction` entry is durably ordered before mutation, its active snapshot/reconnect state includes the original UTC start plus elapsed baseline, and one SQLite transaction commits the exact restricted replacement fact/loop reference plus that same safe entry's `completed` revision. Assert canonical duration survives cold/range load, the current reducer retains but need not paint it, and a fixed future-view projection can produce **Context automatically compacting** or **… compacting for 2m 34s**, then **Context automatically compacted** or **… compacted in 2m 34s**, without reading restricted payloads. |
| `H31 projects_nested_activity_with_parallel_tool_children` | SQL + workerd + desktop reducer | Run one response with two assistant turns. Under the first turn, stream thinking plus two ordered plugin blocks whose tool children start and settle in parallel/out of order; place compaction under the second turn. Assert live, reconnect, range, and cold projections produce response → assistant turn → plugin → tool ancestry with thinking/compaction at their causal turn, stable sibling order, independent child labels, parent wall-clock unions, no double counting, and uninterrupted response-text token streaming. Run the same fixture through a flat-row adapter and a nested in-memory fixture and assert identical product projection without requiring identical persistence. |
| `H32 benchmarks_complete_workstream_open_distribution` | real Electron + local E2E performance lane | From an already-running authenticated desktop, exercise declared warm/cold cache and object, unread/latest, overlapping/disjoint, large-history, and mid-stream cohorts through the production click/navigation path. Stop each client-monotonic sample only when the target range is visibly committed, both islands and active fence are resident, and the composer is usable. Preserve raw samples and environment metadata; assert the combined distribution is p50 ≤ 1,000 ms and p90 ≤ 2,000 ms and report every cohort separately. |
| `H33 backfills_legacy_tool_cards_by_reference` | SQL + workerd | Seed completed, failed, ambiguous, and in-progress legacy tool rows with participant-safe structured summaries. Assert stable tool identities, plugin/tool names, statuses, inputs/results/errors, and old display order hydrate from the owning `parts` rows while new payload rows contain only stable references and no copied summary/result. |
| `H34 transfers_two_exact_legacy_compactions_without_changing_edges` | SQL + workerd | Seed two distinct legacy compaction events and exact message arrays. First assert projection backfill references the old owning rows without a payload copy. Then run the ownership transfer and assert both arrays/summaries resume exactly from canonical model-only facts, an already-canonical mirrored checkpoint retains its original fact/event identity, attachments/mentions and message metadata reconcile row-for-row, and participant status/activity rows and Bind generations are unchanged. Replay the transfer and assert the original receipt plus `applied=false`; abort a raced source edit with no partial fact/projection/receipt. |
| `H35 records_empty_and_populated_backfill_receipts` | SQL + workerd | Backfill an empty object and a populated object. Assert each commits exactly one v28 receipt containing v27 cutover time, exact source counts/digest, operator run, non-empty real PITR bookmark, completion time, and explicit unavailable-Bind-history status. |
| `H36 replays_backfill_idempotently_and_reconciles_every_fact` | SQL + workerd | Invoke the same object through two operator runs. Assert the second call writes nothing, returns the first receipt with `applied=false`, recomputes source integrity, and verifies exact participant prefix/checkpoint counts and order. |

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
| `E17 reports_shortened_range_actual_coverage_only` | SQL + desktop | Trigger the existing response-size shortening boundary with multiple inline-eligible turns; assert claimed coverage stops at the last inspected sequence, not the requested end or returned-row count. The indivisible-turn case belongs to E45 and may not terminate here as `message_page_too_large`. |
| `E18 preserves_tombstone_and_never_reuses_sequence` | SQL + workerd | Reserve a turn that becomes non-displayable; assert a covered tombstone, stable sequence, and a later turn receiving a new sequence. |
| `E19 does_not_fill_old_gaps_from_new_realtime_turn` | desktop | Start with an earlier gap and receive a newer socket turn; assert only the new singleton is covered and the old gap remains requestable. |
| `E20 fences_range_against_concurrent_append_and_mutation` | workerd | Append a turn and update tool status during a range scan; assert membership/order remain at the snapshot fence while authorized mutable status follows its declared revision rule. |
| `E21 handles_unread_near_start_end_and_missing` | SQL + desktop | Resolve unread attention ordinals at the first retained turn, within five of either edge, already inside latest five, on a missing/retracted turn with a later displayable successor, below retained history, beyond the snapshot, and absent. Assert indexed resolution, bounded slices, de-duplication, successor normalization, and exact null fallbacks: `anchor_unavailable` for expired/beyond-fence/no-successor anchors and `no_unread` for absent state, with the prefetched latest slice as initial viewport. |
| `E22 rejects_stale_range_response_after_new_snapshot` | desktop | Resolve an older range request after a newer snapshot; assert it cannot lower bounds, replace newer revisions, or erase singleton coverage. |
| `E23 recovers_timer_after_sleep_and_clock_skew` | desktop | Advance client wall clock independently of monotonic time, suspend, and resume with authoritative UTC timestamps plus elapsed baseline; assert the client does not use naive local `Date.now() - startedAtUtc`, produces no negative/jumped duration, and accepts canonical terminal replacement. |
| `E24 does_not_double_count_nested_or_overlapping_intervals` | harness + desktop | Duplicate and overlap response/plugin/tool intervals; assert normalized unions and idempotent terminal totals at every scope. |
| `E25 hides_restricted_payloads_and_bounds_from_all_participant_surfaces` | API Node + workerd | Exercise REST, socket, range, export, search, logs, and telemetry fixtures; assert no system inputs, protocol/derived payloads, exact private results, reasoning details, or `loop_sequence` bounds escape. |
| `E26 rejects_unauthorized_range_before_returning_bounds` | workerd | Request an existing and nonexistent range as a nonparticipant; assert authorization failure reveals neither snapshot bounds nor existence through coverage shape. |
| `E27 never_falls_back_across_regions` | API Node + workerd | Make the owning regional authority unavailable with the other region populated; assert no transcript, restricted state, payload, inference archive, or range read crosses regions. |
| `E28 never_queries_inference_archive_during_cutover_or_replay` | SQL + workerd | Make configured deployments inference archives unavailable and seed misleading pre-cutover records. Assert schema cutover, first open, range reads, and Bind replay make no archive request and never fabricate a participant turn or model message from those records. |
| `E29 rolls_back_activation_if_system_projection_commit_fails` | workerd | Fail `system_projection_changed`; assert the plugin/skill activation is not visible to Bind and the previous system revision remains current. |
| `E30 survives_crash_at_every_compaction_boundary` | workerd | Crash before replacement commit, after commit/before old-array discard, and after discard; assert restart selects exactly one valid generation and never combines old/new arrays. |
| `E31 replays_socket_frames_without_duplicate_tokens_or_blocks` | workerd + desktop | Disconnect at token, tool-start, tool-stop, and turn-commit boundaries; assert replay plus snapshot reconciliation produces each token/block/lifecycle revision once. |
| `E32 preserves_streaming_under_parallel_start_complete_error_burst` | workerd + desktop | Burst parallel tool start/success/error events while text tokens continue; assert token delivery is not blocked or batched behind lifecycle processing. |
| `E33 rejects_old_desktop_protocol_after_cutover` | API Node + workerd | Connect with the prior desktop protocol after cutover. Assert it cannot receive transcript bounds/content or socket admission, no legacy fallback/emission path executes, no particular compatibility error body is required, and the current desktop connects successfully to the same authority. |
| `E34 makes_substrate_conformance_mandatory_for_new_authority_adapter` | harness/API contract | Run the shared adapter conformance suite against `SubstreamAgent`, which must pass, and a deliberately incomplete test-only adapter implementing only part of the required range/replay contract, which must fail for the omitted capability. |
| `E35 excludes_automation_wizard_from_all_new_paths` | API Node + desktop | Exercise automation draft storage and UI fixtures; assert no new substrate schema, protocol event, range contract, or renderer behavior is invoked for the explicitly out-of-scope wizard. |
| `E36 does_not_conflate_duplicate_compaction_delivery_with_a_second_event` | SQL + workerd | Deliver compaction event A twice and a distinct event B once, including out-of-order retry delivery. Assert A creates exactly one replacement generation, B creates exactly one later generation, event/source identities remain distinguishable, and the active generation never rolls back from B to A. |
| `E37 rejects_inconsistent_active_interval_timestamp_baseline` | workerd + desktop | Supply a snapshot whose `activityId`, `intervalId`, lifecycle `revision`, `completedDurationMs`, `startedAtUtc`, `snapshotAtUtc`, and `elapsedMsAtSnapshot` cannot describe the same interval revision, then deliver an older consistent snapshot. Assert the inconsistent snapshot is rejected/resynced without resetting the label to zero, and the older interval/revision cannot roll back a newer valid baseline or completed total. |
| `E38 races_midstream_open_with_frame_and_terminal_commit` | workerd + desktop | Publish a token/tool lifecycle frame immediately before, during, and after first-open snapshot assembly, then commit the active turn. Assert both slices, top-level transcript bounds, active checkpoint/activity revisions, and `resumeAfterEventSequence` share one object-local boundary; applying only room events strictly above that fence yields every byte/block/revision exactly once, canonical commit reconciles the reserved turn in place, no active overlay survives terminal state, and no middle range is falsely marked covered. |
| `E39 keeps_authorization_work_constant_across_range_shapes` | API Node + workerd | Run empty, shortened, tombstone/status-heavy, overlapping, disjoint, and maximum-existing-bound range fixtures with different returned entry/block counts. Assert each external read makes exactly one reader-admission decision, no row hydration triggers authorization, and a participant/scope epoch change invalidates the admitted socket before another snapshot is returned. |
| `E40 keeps_indexed_plan_for_missing_anchor_tombstones_and_boundaries` | SQL + workerd | Exercise attention-ordinal resolution, a missing/retracted unread anchor, an expired attention floor, long tombstone runs, fewer than five turns on either side, empty history, and a snapshot fence below the physical tail. Assert attention/anchor normalization and all directional/latest/range reads retain the declared indexed plans, coverage remains truthful across skipped tombstones, no linear fallback or temporary sort appears, overlap hydrates once, and deliberately removing each required index makes the plan/failure-proof test fail for that access path. |
| `E41 closes_compaction_status_truthfully_without_leaking_payload` | SQL + workerd + desktop reducer | Fail start-entry persistence; separately crash/fail/cancel after start but before replacement; inject failure between the replacement write and terminal safe-status update inside their transaction; then exercise duplicate/out-of-order delivery. Assert a failed required start write prevents compaction mutation; the injected partial completion rolls back both replacement and terminal status; otherwise there is one stable entry per compaction, monotonic active-to-completed/failed/cancelled/abandoned state, recovered upper-bound timing where exact stop is unavailable, no permanently active marker, no participant summary/messages/token counts/private bounds, no Bind projection of the safe marker, no compaction marker counted against the five requested conversation turns, and indexed range/reconnect recovery without duplication. |
| `E42 rejects_or_repairs_orphaned_and_regressive_nested_activity` | SQL + workerd + desktop reducer | Deliver child-before-parent, stale reparenting, duplicate child stops, one sibling stop while another remains active, a parent terminal edge before required children settle, and a reconnect snapshot missing an active child's ancestor. Assert arrival order cannot define/reparent siblings; stale/duplicate edges are ignored; the parent stays active and counts overlap once; an inconsistent snapshot is rejected/resynced or repaired from canonical ancestry; range merges never duplicate nodes; and no storage implementation is required to persist a recursive tree. |
| `E43 does_not_finish_open_metric_at_partial_stale_or_failed_state` | desktop + E2E | Independently delay authorization, unread/latest ranges, active checkpoint/fence, renderer commit, and composer readiness; begin with stale cached content; then fail and cancel separate opens. Assert the monotonic clock starts once at member intent, never restarts, and cannot stop on API completion, skeleton/header/first-row/stale paint, or only one range. Success records exactly once after the full usable condition; failed/cancelled opens record their outcome and elapsed time but never enter successful percentiles. |
| `E44 rolls_back_canonical_fact_and_required_projections_atomically` | SQL + workerd | For assistant acceptance, exact tool-result acceptance, and compaction completion, inject failure after canonical fact insertion and after each required participant/Bind projection write. Assert the object-local SQLite transaction leaves no orphan fact, independent duplicate payload, advanced sequence/revision, one-sided projection, dispatchable tool plan, completed safe status without a replacement, or replacement visible without its completed safe status. Retry each transition and assert exactly one owning fact plus the required stable projection references commit. |
| `E45 hydrates_oversized_indivisible_turn_without_stranding_range` | workerd + desktop | Create one valid turn whose combined text/tool blocks and then whose block manifest exceed the existing encoded page/socket bound. Assert the range returns one small envelope with stable sequence and immutable `turnManifestRef` rather than `message_page_too_large`; accepting it advances transcript coverage exactly once and permits older/newer range loading. Hydrate manifest and payload byte ranges under one admission, verify revision/length/hash, then inject missing, tampered, unauthorized, interrupted, duplicate, and out-of-order chunks. Assert only the turn/payload hydration state retries or errors, no restricted fallback appears, and transcript gap coverage never regresses or loops. |
| `E46 prevents_pre_cutover_run_from_crossing_schema_boundary` | workerd + release-contract | Seed queued, active, paused, and externally unsettled old-protocol runs while racing new admission with the coordinated cutover. Assert admission is fenced first; the release operation either observes quiescence/cancelled-abandoned non-production state and installs the canonical-only schema or aborts before schema mutation. No run reads/writes both protocols, no legacy dual-write/reader remains, and a new post-cutover run uses only canonical facts/projections. |
| `E47 aborts_backfill_when_source_moves_during_preparation` | SQL + workerd | Pause PITR-bookmark/hash preparation, edit or append a legacy source row, then resume. Assert the transaction's full source re-read detects the change and commits no fact, projection, counter shift, or receipt. |
| `E48 abandons_only_provably_orphaned_pre_cutover_runs_then_repairs_terminal_receipts` | SQL + workerd | Seed an active pre-v27 run with no attempt ID, lease owner/deadline, heartbeat, or open receipt. Invoke the explicit operator cleanup and assert it alone becomes terminal `failed` with `migration_cutover_abandoned` and atomically commits a singleton cleanup receipt containing the original operator and count. Force the following backfill to fail, retry under a different operator, and assert both the object RPC and protected fleet receipt still report the original cleanup evidence before backfill succeeds. Separately add each disqualifier and a post-v27 start, assert cleanup aborts atomically and leaves the run active, and mutation-test every fence. Seed a terminal run whose pending legacy tool card is backed by an admitted/executing receipt and assert the first-time backfill invokes only the established terminal residual-receipt phase, projects the repaired terminal lifecycle, and records one receipt; delete the repair call and prove this test fails with `legacy_transcript_backfill_not_quiescent`. Seed an expired nonterminal root and a reapable child and assert backfill itself neither terminalizes nor otherwise mutates them and still rejects as non-quiescent; replace the narrow call with the general stale-run reaper and prove the test fails. Separately seed each write-capable run/activity state, a receipt that remains open after repair, an orphaned historical pending card with no open receipt, and a connected socket retaining an immutable transcript snapshot; also race a new write or snapshot open with backfill preparation. Assert the operation fails before renumbering or receipt creation while a source can still settle or an existing snapshot fence could change meaning, but preserves the immutable orphan as `started`; after settlement and snapshot disconnect, the same source backfills once. Replay an already-receipted object and assert neither cleanup nor repair has a side effect. |
| `E49 rejects_partial_or_conflicting_legacy_projection` | SQL | Preinsert one legacy turn projection, a mismatched fact identity, and a conflicting compaction uniqueness key in separate cases. Assert each aborts the complete object transaction instead of skipping the conflict or producing a mixed projection. |
| `E50 detects_tampered_legacy_owner_before_retirement` | SQL + workerd | Change referenced legacy text, structured tool data, relation rows, or checkpoint bytes after projection backfill and after ownership transfer in separate cases. Assert replay reconciliation fails against the recorded source digest/row comparison rather than blessing changed history, and the retirement migration refuses to drop any source table when a canonical owner or verified receipt is missing. |
| `E51 handles_cutover_timestamp_boundary_without_loss_or_duplication` | SQL | Create an unprojected legacy row at the v27 `applied_at` millisecond and a post-v27 row already carrying a canonical projection at that same millisecond. Assert the first is included exactly once, the second remains only in the suffix, and all other source predicates are strict and deterministic. |
| `E52 preserves_receipts_when_a_fleet_batch_partially_fails` | script | Return success and error outcomes in one regional batch. Assert the mode-0600 local receipt durably contains every completed per-object bookmark/error before the command exits nonzero; rerunning safely reconciles prior successes and applies only missing object receipts. |
| `E53 rejects_inventory_or_jurisdiction_drift_before_mutation` | script + remote-preview contract | Change the eligible count, duplicate/omit a classifier result, return a wrong jurisdiction, or expose an ambiguous namespace. Assert apply fails before the first object RPC and never treats an expected Cloudflare parser failure as an eligible target. |
| `E54 fails_replay_if_any_fleet_object_is_unverified` | operator acceptance | On the post-apply fleet audit, return one missing receipt, empty bookmark, digest/count/order mismatch, or object RPC error. Assert the run cannot report success and identifies the object in the protected local receipt without printing transcript content or secrets. |

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

## Implementation and deployment

Implementation may be developed in dependency order, but deployment has one
coordinated cutover and no compatibility phases:

1. Implement the shared durable transcript substrate, `SubstreamAgent` adapter,
   restricted Bind ledger/generations, participant projection, exact provider
   boundary checks, reasoning/activity normalization, constant-cost reader
   admission, product-nested activity projection, participant-safe compaction
   status persistence, the required sequence/displayable/status/child/read-state
   indexes, canonical REST/socket protocol, and desktop range/feed reducer. The
   old feed is replaced, not retained beside the new one. The reducer retains
   compaction status entries; their dedicated visual component may ship later.

2. Implement every required test ID alongside its behavior. The harness, SQL,
   real-workerd, desktop, E2E, failure-injection, and visible-window suites must
   pass before release. Capture the declared real-window work-stream-open
   performance artifact and confirm its p50/p90 goal before release;
   compatibility work is not a prerequisite because it is deliberately absent.

3. Run one idempotent release operation. Before schema mutation, it fences
   admission of new old-protocol runs and verifies that no queued, active,
   paused, or externally unsettled pre-cutover harness run can cross the
   boundary. Existing non-production runs may finish before the fence or be
   explicitly cancelled/abandoned and discarded; if quiescence cannot be
   established, the operation aborts before changing transcript storage. It then
   installs the object-local schema, deploys the backend that accepts only the
   new transcript protocol, and publishes the matching desktop version. The app
   may require that version to be downloaded before a work stream opens. Older
   desktops are unsupported and are not served a fallback feed; this PRD does
   not require a special compatibility response.

5. Before the first backfill receipt, explicitly abandon an active pre-v27 run
   only if it has no attempt ID, lease owner/deadline, heartbeat, or open tool
   receipt; record `migration_cutover_abandoned` and the per-object count, and
   abort on every other active shape. Commit the original operator and count in
   the same object-local cleanup receipt; preserve and return it if the following
   backfill fails or retries. Then invoke only the runtime's established
   terminal-run residual-receipt repair phase, without running stale-root or
   stale-child reaping. Repair failure aborts the object; do not run repair
   during receipt replay. Then backfill only quiescent objects.
   Quiescence includes no write-capable run or activity, no pending legacy tool
   card still backed by an admitted/executing receipt, and no connected client retaining a
   transcript snapshot whose sequence mapping would be changed by prefix
   insertion. Each object captures a pre-write PITR
   bookmark, hashes the complete v27-fenced source, re-reads it inside the same
   SQLite transaction that adds the ordered projections and v28 receipt, and
   aborts on movement or conflict. The operator writes every outcome/bookmark to
   a mode-0600 local receipt. Any object error makes the fleet command fail.

6. Replay the operation across the complete eligible fleet. Every object must
   return `applied=false` and `verified=true`, with source/projection totals
   matching the first run. Inspect representative raw SQLite rows and the fleet
   receipt before declaring the migration complete.

7. Deploy the schema that stages canonical message records and the explicit
   payload-ownership RPC. Run its separate fleet mode against the same reviewed
   regional IDs. The operation must refuse active writers, admitted/executing
   tool receipts, connected immutable transcript snapshots, and source movement;
   it hashes outside the transaction, re-reads inside it, moves every exact
   payload/relation, reuses already-canonical compaction facts, and commits one
   object-local receipt plus PITR bookmark. Replay the whole fleet and require
   `applied=false`, `verified=true`, and exact source/projection counts.

8. Only after step 7 is complete, deploy the stacked cleanup release. Its schema
   migration must prove the transfer receipt and row-for-row canonical ownership
   before it switches all readers/foreign keys and drops `parts`,
   `part_attachments`, `part_mentions`, `compaction_checkpoints`, and the
   one-time migration surfaces. Missing evidence aborts the object migration;
   it never treats an empty or partially copied canonical table as permission to
   delete the old owner. Canonical-only post-cutover checkpoints are not a
   mismatch: the proof is that every legacy checkpoint has an exact canonical
   owner, not that both tables have equal totals. The cleanup must not update,
   delete, synthesize, or reorder participant compaction status rows, compaction
   activities/intervals, or Bind generations. Real-workerd coverage must commit
   two separate compactions and retain both completed edges, while the existing
   mid-compaction reconnect case remains green.

The completed release has no inference-archive backfill, legacy protocol reader,
dual write, dual read, capability negotiation, compatibility window, staged
client floor, or cross-region step. The temporary dual population between steps
7 and 8 exists only to keep source and destination current during the explicit
fleet transfer; it is not a client protocol or reader fallback. The one-time
object-local operations are required and recoverable from each receipt's PITR
bookmark. A backend rollback is not required to understand new
canonical rows; use a forward fix rather than preserving the removed protocol
solely for rollback.

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
    canonical snapshots, disjoint range merge, the breaking protocol cutover,
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
    share one top-level earliest/through snapshot descriptor with active state
    and `resumeAfterEventSequence`, and report independent actual coverage. Safe
    status entries within either selected transcript span are returned in
    sequence but do not count against those conversation-turn quantities.
15. A first open with no unread state returns a null unread slice with
    `unreadReason = no_unread`; an expired/beyond-fence/missing anchor with no
    retained displayable successor returns `anchor_unavailable`. Both return
    the five latest displayable turns and position the transcript there. A
    missing/retracted anchor with a retained successor normalizes to that
    successor instead of becoming a status event or an unrelated oldest turn.
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
    The product can place those plugin scopes beneath their assistant-turn scope
    and each invocation beneath its plugin without serializing siblings.
22. Tool completion, failure, cancellation, and ambiguous receipt outcomes all
    close the matching invocation/plugin interval exactly once. A late or
    duplicate start/stop edge cannot reopen or regress a newer terminal state.
23. Pausing for member input closes the current response-work interval, and
    resumption opens a new one. The live and historical response label sums the
    non-overlapping working intervals and excludes the paused gap.
24. After application sleep, hibernation, socket reconnect, or a missed edge,
    an active snapshot identifies each baseline by `activityId`, `intervalId`,
    and lifecycle `revision`, then rebases the desktop from
    `completedDurationMs`, original `startedAtUtc`, server `snapshotAtUtc`,
    `elapsedMsAtSnapshot`, and `timingAccuracy`; a terminal snapshot replaces
    local elapsed time with canonical `durationMs`.
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
29. At initialization, `loop_id` equals the admitted
    `harnessRunId`/`run_id`, `loop_generation` starts at 1 and advances once
    per successful compaction replacement, and the restricted projection recreates the complete
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
    participant conversation turns remain intact. The separately ordered safe
    compaction status entry contains lifecycle/timing only and never projects
    into that provider message array.
35. An immutable out-of-line model-facing payload is changed, deleted, or made
    unavailable in a fault-injection test. Replay fails with a protocol-integrity
    error and never substitutes a summary, display payload, placeholder, or
    refetched result.
36. Failed provider attempts, abandoned partial output, and route-reset bytes do
    not enter accepted Bind state. The next epoch may replace transient display
    text without changing the last durable loop revision.
37. One idempotent coordinated release first fences old-protocol run admission
    and establishes a quiescent boundary, then installs the canonical schema,
    deploys the canonical-only backend protocol, and publishes the matching desktop.
    The subsequent object-local operation faithfully projects all retained
    pre-v27 participant rows and exact checkpoint references, but creates no
    historical Bind state and queries no inference archive. An older desktop
    cannot receive transcript bounds or content through a compatibility
    projection. No stable old-client error shape is required.
38. Participant range reads and coverage metadata reveal neither restricted
    loop payloads nor `loop_sequence` bounds. Subsequent inference nevertheless
    reconstructs from the restricted projection without consulting the desktop
    projection or Global inference lakehouse.
39. Every `T1`–`T14` objective is mapped to its proving suites/files, and every
    required `H01`–`H38` and `E01`–`E54` test is mapped to an actual test
    name and file, passes at its required layer, and has an implementation-PR
    failure-proof record showing the named assertion fails when its protected
    production behavior is deliberately broken. The three generated algebraic
    and state-machine suites, updated local behavioral lane, and real-window
    desktop acceptance flow also pass; none is deferred to a follow-up PR.
40. A client that first opens or reconnects to a response already in progress
    receives each active scope's stable activity/interval identity, lifecycle
    revision, completed duration, original UTC start, server-observed UTC
    snapshot, elapsed baseline, and timing accuracy. It immediately displays the time accrued
    before subscription, then advances locally without periodic server ticks;
    client wall-clock skew cannot reset, make negative, or become the authority
    for that duration.
41. Opening a work stream mid-response paints its accumulated text, ordered
    tool/thinking blocks, current lifecycle states, and already-accrued timing
    from the initial boot snapshot. The top-level transcript bounds, both
    slices, active state, and durable room `resumeAfterEventSequence` share one
    boundary; accepting only greater room sequences makes subsequent socket
    catch-up and live frames exact-once, while the unread
    and latest range islands retain truthful coverage and **Jump to latest**
    remains immediate.
42. A complete REST boot or range request performs one reader-admission decision
    regardless of the number of turns, blocks, gaps, or initial slices it
    returns. Both first-open ranges and active state reuse it. A socket snapshot
    reuses the connection's epoch-fenced admission, and revocation invalidates
    that admission; neither path performs per-row authorization or regional
    authorization joins during the transcript scan.
43. The unread high-water lookup is a keyed point read. Attention-ordinal
    resolution, unread anchor normalization, five-before/five-after,
    latest-five, snapshot-bound, and
    arbitrary-range production queries use their declared SQLite indexes with
    bounded traversal and no `OFFSET`, full transcript scan, or temporary sort.
    Both initial islands are selected within one object-local snapshot and their
    union is hydrated once; query/statement count does not grow with total
    transcript length. Required query-plan tests fail when any required index is
    removed.
44. Automatic compaction reserves one stable participant-safe status entry
    before mutation. Active snapshots carry its original UTC start and elapsed
    baseline; one SQLite transaction commits the distinct private replacement
    fact/loop reference and terminal safe-status revision, so neither projection
    can observe half of a successful completion. Failure/cancellation/recovery
    closes the same entry truthfully. Range and realtime delivery can
    therefore support future **Context automatically compacting** and **Context
    automatically compacted**, optionally **… compacting for 2m 34s** or **…
    compacted in 2m 34s**, without a storage migration or disclosure of compacted
    context. The current desktop preserves the typed entry but its final visual
    rendering remains out of scope.
45. Activity is product-nestable at least as response → assistant turn → plugin
    block → tool invocation, with thinking and compaction attached to the causal
    response/turn. Each scope has independent lifecycle edges and timing;
    parallel siblings retain declared order and parents use wall-clock unions,
    never child sums. Mid-stream snapshots include active ancestry, range/cold
    projections reconstruct the same tree, and response tokens remain
    independently streamable. A flat durable representation is acceptable when
    it projects these semantics exactly; recursive physical storage is not an
    acceptance requirement.
46. Successful work-stream opens from an already-running authenticated desktop
    meet p50 ≤ 1,000 ms and p90 ≤ 2,000 ms from member intent to the correct
    target transcript being visibly painted, both initial islands and the
    active-state/socket fence being resident, and the composer reaching its
    correct usable state. The implementation PR supplies raw controlled
    real-window samples and combined/cohort percentiles; production client
    telemetry becomes authoritative when samples exist. The metric never stops
    at an API response, skeleton, stale cache, first row, or only one range, and
    slow successes are not discarded or restarted.
47. One regional authority owns every transcript semantic datum exactly once.
    `transcript_sequence` orders participant-visible turns and safe status
    events; `loop_sequence` orders the exact non-system messages Bind consumes
    or accepts. Both projections reference shared stable fact/payload IDs and
    commit with new facts in one object-local SQLite transaction. Identical
    assistant text is not copied between them. Participant-safe tool summaries,
    compaction statuses, and render-safe content have distinct owning records
    from exact model-facing tool results, private compaction replacements, and
    provider continuation metadata only because those semantics genuinely
    differ. A failed projection write rolls back the whole transition rather
    than leaving dual sources, an orphan fact, or a one-sided accepted state.
48. A participant-visible turn that exceeds the existing inline frame/page
    bound returns one covered turn envelope and immutable
    `turnManifestRef`/payload IDs instead of `message_page_too_large`. Manifest
    and payload bytes hydrate through one admitted regional byte-range stream,
    with revision/length/hash verification. Transcript coverage advances on the
    envelope and remains independent of payload hydration, so missing or failed
    payload bytes can show a turn-specific retry/error without stranding every
    older or newer sequence or exposing restricted content.
49. No queued, active, paused, or externally unsettled old-protocol run crosses
    the breaking schema boundary. The single release operation fences admission
    first and either reaches quiescence—finishing or explicitly
    cancelling/abandoning disposable non-production runs—before mutation, or
    aborts without installing the new schema. It never introduces legacy
    dual-write, a downgrade reader, or a compatibility phase.

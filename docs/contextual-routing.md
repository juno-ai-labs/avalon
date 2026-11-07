# Suggested context (retired)

**Status:** Removed on 2026-08-30. Rally no longer classifies connector activity for an existing work stream, creates Suggested context cards, exposes accept or dismiss APIs, projects suggestion events, or stores suggestion feedback.

This page is the historical record for the retired feature. Suggested Work, the separate home-screen product, was deleted on 2026-11-07. Resource watches and automation triggers also remain active.

## Retirement boundary

| Boundary | Current behavior |
| --- | --- |
| Unclaimed connector activity | Goes directly to Suggested Work batching after watches and automations run. |
| Suggested Work admission | Existing work streams are duplicate-detection context only and can never be destinations. |
| Work-stream detail | Emits an empty `suggestions` rollout tombstone for older desktop builds; current desktop code ignores the field. |
| Realtime protocol | Old suggestion event names remain parse-only during rolling deployment and have no producer or consumer. |
| SubstreamAgent storage | Migration 35 drops `suggested_actions`, removes its outbox rows, converts old `suggested_activity` links to `attachment`, and retains accepted items' source audiences as generic immutable content fences. Those fences continue to block participant or scope widening that would expose the attachment. |
| WorkspaceDO | Forward migrations discard stored suggestion-feedback state. Parse-only tombstones acknowledge an in-flight feedback envelope from an older isolate without applying or persisting it. |
| Desktop | Does not construct, render, resolve, or cache Suggested context cards. Canonical blocks from an older Worker are filtered out. A parse-only resource relationship accepts an old Worker's snapshot/event and immediately normalizes it to `attachment`. |

The rollout tombstones are compatibility boundaries, not a dormant implementation or a re-enable switch. Reintroducing a work-stream suggestion product would be a new feature with new contracts and storage rather than a reversal of these migrations.

### 2026-08-30 — Suggested context was removed

**What changed:** Both producers, the activity classifier, acceptance and dismissal routes, realtime handling, desktop card, feedback projection, and object-local suggestion state were removed. Forward migrations discard pending feedback and cards while retaining accepted resource relationships as ordinary attachments. The accepted content's source audience survives only as an immutable generic privacy fence. Rolling-deploy parsers consume old resource and feedback envelopes without restoring the retired product vocabulary.

**Why:** The work-stream card was an unsolicited interruption and was not useful enough to keep as a parallel destination beside watches, automations, and Suggested Work.

**Considered and rejected:** Hiding the renderer while retaining classifiers and storage, or leaving Suggested Work able to route into an existing work stream. Both keep a dormant second product path and its authorization and rollout burden.

**Consequences:** Deterministic matching durably claims an event before Suggested Work sees it, including on retries after every matching delivery settles. Unclaimed activity has one speculative destination, Suggested Work on the home screen. Old wire names and an empty snapshot field remain only long enough to make mixed-version deployment safe.


### 2026-08-24 — Suggested context returns behind source-to-target audience fences

**What changed:** Both card producers and the desktop card surface are enabled
again. WorkspaceDO candidate selection now requires either a workspace audience,
which admits only workspace-scoped work streams, or a concrete user set, which
admits only private targets whose entire reader audience is contained in that
set. Every producer persists the source audience and WorkstreamDO revalidates it;
legacy cards without that proof stay hidden. The old nullable
`restrictedUserIds` bypass is gone. Canonical feeds, pagination, realtime events,
and the disconnected accept/dismiss fallback render one card state consistently.

**Why:** The retained router was useful, but its workspace activity path selected
every work stream when its user restriction was null. Re-enabling that path as it
stood would have sent private titles and objectives to the classifier. An
any-authorized-reader check would also let a restricted title and resource move
into a room shared with unauthorized readers. A missing viewer and one permitted
viewer are both insufficient authorization for a wider target.

**Considered and rejected:** Re-enabling only the classifier while continuing to
hide cards, filtering private rows after the SQL limit, and treating a workspace
activity as if an arbitrary workspace member were its viewer. Those respectively
produce invisible state, shrink the candidate set, or make one person's private
access available to workspace processing.

**What a future change has to respect:** Candidate audience is required data, not
an optional predicate, and content may move only to an audience no broader than
its source. Any new producer must carry that source audience through persistence,
and every card surface must preserve dismissal across canonical and realtime
reconciliation.

### 2026-08-18 — Routing feedback and candidates use WorkspaceDO indexes

**What changed:** Post-cutover candidate selection, dismissal-run exclusion, and
resolved-action labels now come from authoritative WorkspaceDO SQL. The feedback
reader joins only those indexed activity IDs to regional D1 to recover the
connector provider/event classification.

**Why:** Candidate and feedback selection are cross-work-stream product queries,
so keeping their projections in D1 would preserve a second work-stream serving
authority. Connector activities themselves remain a genuinely relational,
workspace-owned D1 workload.

**Considered and rejected:** Copying full connector events into WorkspaceDO and
fan-out reads to each WorkstreamDO. The first duplicates the ingestion store;
the second makes every classification depend on an unbounded object graph.

**Consequences:** WorkstreamDO must deliver resolved feedback to WorkspaceDO
before acknowledging its outbox. D1 activity retention must remain long enough
for the feedback windows, but D1 no longer stores or serves the work-stream
label/index after authority opens.

### 2026-08-12 — Suggested context was paused end to end

**What changed:** One shared switch now prevents the per-activity router and
suggested-work's `route_existing` branch from creating cards. REST and room
snapshots return no pending suggestions, the desktop no longer renders the card
or its controls, and rollout-era suggestion socket events are ignored. Existing
rows, feedback, schemas, and the dormant classifier remain in place.

**Why:** The cards were too noisy and their relevance was not tuned well enough
to earn space inside an active work stream. Deleting stored decisions or the
whole implementation was rejected because this is a temporary product pause:
the existing accept/dismiss record and testable routing code are useful inputs
to a future tuning pass. A future re-enable must restore all four guarded
boundaries together — both producers, both snapshot paths, transcript synthesis,
and realtime handling — rather than exposing only part of the surface.

### 2026-08-12 — Dismissing a suggestion removes it from the message feed

**What changed:** The desktop now removes dismissed Suggested context cards on
the live resolution event and after a successful dismissal request when the
socket is unavailable. Canonical and paginated message responses filter
dismissed rows, and every reconciliation consults a session-lived dismissal ID
before committing a response that may have started earlier. Accepted cards
remain visible as confirmation that their resource was added, and the dismissed
database row remains stored for routing feedback.

**Why:** A resolution event replaced the pending card with a resolved card whose
footer said “Dismissed.” Repeating the action therefore accumulated rejected
suggestions in the message feed—the surface the person was trying to clear—and
made the routing feedback improvement feel like more noise rather than less.

**Considered and rejected:** Hiding the resolved content only inside the card
component. The virtualized feed would still own and measure an empty transcript
row, and stale dismissed messages would remain in its cache. Also rejected was
keeping a compact dismissal receipt: acceptance has a durable side effect worth
confirming, while dismissal is specifically the decision that this unsolicited
context does not belong in the work stream.

**Consequences:** Every path that introduces or reconciles suggestion messages
must preserve the same visibility rule. Dismissal IDs remain in the renderer's
query cache for the app session; they are UUIDs that cannot be reused, so this
small monotonic set closes every overlapping page-fetch race without a cleanup
timer or another server read. Dismissal is presentation removal only; future
cleanup must not delete the `activity_suggestions` row, because its status and
resolver are the evidence used to reduce later routing noise.

Shipped in #135.

### 2026-08-12 — The workspace's own dismissals set the bar; the manifest only nudges it

**What changed:** Contextual routing stopped comparing every match against a
constant. An event type's confidence floor now starts from its connector's
digestibility declaration — 0.8 for a digestible type, 0.9 for one its connector
classified as machinery, no change for a connector that classified nothing — and
is then replaced outright by this workspace's own accept rate over ninety days,
in either direction. A type with four or more resolutions, zero acceptances, and
dismissals from two or more distinct people is turned off before the inference
is bought. A work stream with three dismissals in thirty days and no acceptance
since drops out of the candidate pool. Both that exclusion and the pre-existing
already-routed exclusion moved inside the candidate query.
`activity_suggestions` gained a `source` column naming which producer wrote each
card, which both feedback reads filter on, and two indexes leading with it.

**Why:** The only quality control was a constant compared against a number the
model made up about its own answer, and nothing ever read the resolution back.
`resolveSuggestion` had written `dismissed` since the feature shipped and no code
anywhere read that column, so a workspace could dismiss the same suggestion every
day and the next one arrived with identical odds — the pipeline documented
"persist accepted/dismissed routing feedback" as a step and persisted it into a
column nothing consumed. Meanwhile the candidate query never looked at the
activity at all: any of the twelve most recently touched work streams was a
candidate for any event, so the model was asked "does this fit one of these
twelve?" for every unclaimed activity, including the eleven check runs a single
pull request starts. The observed failure was a `review_requested` card routed to
an unrelated work stream whose stated reason cited no shared entity — a correct
classification of a real event, offered to the wrong place, with no way for the
person dismissing it to affect the next one.

**Considered and rejected:** Using `digestible` as a hard gate — no card, at any
confidence, for a type no digest would carry. This was written, tested, and
reverted before shipping, and the reasoning is worth keeping because it is
seductive: a card *is* a stronger interruption than a digest line, so the
inference that it deserves at least as strong a declaration feels airtight. It is
wrong because `digestible` encodes three different noes and only one of them is
about relevance. `generic_webhook` declares `digestible: []` because Rally
cannot parse an arbitrary payload well enough to render it into somebody's
morning email — and it is the connector [PRD flow 4](e2e.md#prd-flow-4--contextual-routing)
uses to test contextual routing, so the gate broke the feature's own acceptance
flow while every unit test passed. Google's Drive, Docs, and Sheets events are
operational because a change feed reports every save, which is a statement about
digest volume; a document being edited is close to the most useful thing this
feature could possibly offer. The gate would have removed all of them
permanently, and the invariant forbidding "just mark it digestible" would have
left no way back.

Also rejected: requiring `matchedEntities` to be non-empty. It is the obvious
code-level version of the prompt's "a shared generic keyword is not sufficient",
and it fails because the field is produced by the same model whose judgement is
in question — a model inclined to suggest is equally inclined to name an entity.

Also rejected: raising the constant to 0.9 for everyone. It trades recall
everywhere for precision in the workspaces that were complaining, and still
compares against a self-reported score.

Also rejected: reading `activity_suggestions` as though it were this module's
table. It is not, and review caught the assumption before it shipped:
`createActivitySuggestion` has a second caller in suggested work's
`routeExistingDecision`, writing rows that are identical in the transcript and
resolved by the same endpoint. Unscoped, four dismissals of *that* agent's
whole-window decisions would have suppressed an event type here, and a work
stream could have lost its place in the candidate pool over cards this module
never produced — a feedback loop that also re-armed its own counters, since a
suppressed activity falls through to batching where the other producer can
publish the same card. Attributing the pre-column rows to either producer was
rejected for the same reason: they cannot be told apart, and a guess would seed
the gates with the wrong agent's record.

Also rejected: an unwindowed accept rate, and workspace-wide suppression on a
single person's dismissals. The first makes suppression permanent, because a
suppressed type can never earn the acceptance that would lift it. The second lets
one member clear four cards on a quiet afternoon and turn a type off for
everybody, with the same no-way-back problem one level down.

**Consequences:** Suppression is a promise about this module's output, not about
the card type: the suggested-work path can still publish a card for a suppressed
event type, and deliberately keeps its own record. Whether one agent's
suppression should silence the other is a real product question this change does
not answer, and answering it belonged to Suggested Work, since deleted.
Anything added to `activity_suggestions` from here has to declare its `source`,
and any new read of that table as evidence has to filter on it.

`digestible` is now read by two surfaces with different
questions, which is a standing hazard: the next reader outside the digest will be
tempted to treat it as a verdict again, and the invariants above exist to be
quoted at that change. The prior is deliberately weak — 0.1 of confidence —
because its job is to break ties, not to make decisions. A workspace's own
behaviour is the only thing that switches anything off, which means this design
does nothing at all on day one in a new workspace; that is intended, and the
first four resolutions per event type are what it costs. Because a withheld
activity continues to suggested-work batching rather than being dropped, noise
removed from transcripts arrives at the home screen instead; if that surface gets
louder after this, the batching window is where to look, not these thresholds.

Deterministic entity overlap before the inference — shrinking the candidate list
by the resource and entity keys `matchingResourceIds` already computes on the
same activity — is the next thing this design wants, and would let the candidate
pool stop being "twelve most recent" for events that name a resource at all.
Shipped without it because the feedback gates are measurable on their own and
overlap-based selection changes recall in a way that wants a look at real
resolutions first.

Shipped in #109.

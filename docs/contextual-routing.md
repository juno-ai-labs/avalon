# Contextual routing

The speculative half of activity routing. When a connector activity matches no
resource watch and triggers no automation, contextual routing asks whether one
of the work streams somebody is already using is *about* it, and writes a
**Suggested context** card offering the attachment if the answer is a confident
yes. Accepting attaches the activity's resource to the work stream; dismissing
records that it should not have been offered.

Nothing here was asked for. That is the fact the whole design answers to: a card
is an interruption nobody requested, in a transcript somebody is reading for
another reason, so every gate below **withholds** rather than admits, and a
question that cannot be answered is answered no. Read this before changing what
becomes a card, and [`CONNECTORS.md`](CONNECTORS.md#activity-ingestion) for the
ingestion pipeline that feeds it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/queues/activity-consumer.ts` → `routeContextually` | The whole decision: the gates in order, the candidate query, the one inference, the write. The only caller. |
| `apps/api/src/services/activity-routing-feedback.ts` | Every threshold and window, and both reads of past accept/dismiss decisions. The single source of what the feedback means. |
| `apps/api/src/services/activity-suggestion-service.ts` | Inserts the suggestion and publishes `activity_suggestion_created` to the work-stream room. |
| `packages/agent-harness/src/prompts/activity-routing.ts` | The classifier prompt and its output schema. |
| `apps/api/src/services/workstream-service.ts` → `resolveSuggestion` | Records `accepted`/`dismissed`. The only writer of the signal both feedback reads consume. |
| `packages/db/migrations/0066_activity_suggestion_feedback.sql` | The two indexes those reads seek on. |

## How it works

`consumeOne` tries the deterministic routes first — resource watches, then
automation triggers — and calls `routeContextually` only with what neither
claimed. If contextual routing also declines and no watch fired, the activity
falls through to [suggested work](SUGGESTED_WORK.md) instead.

Four gates stand between an activity and a card, ordered so the cheapest and
most decisive run first:

1. **Digestibility.** `activityIsDigestible` asks the connector's manifest
   whether this event type is something a person who was away for a day would
   want read back to them. A card is a *stronger* interruption than the digest
   line the manifest is answering about — it sits in a transcript with two
   buttons and is rebuilt on every refetch until somebody clicks one — so an
   event type denied a digest line is denied a card. This removes the machinery
   (check runs, workflow runs, label moves, edits) before anything is spent on
   it: sixty-one of GitHub's ninety-one declared types.
2. **The event type's record in this workspace.** `suggestionAdmission` scores
   past resolutions for `(workspace, provider, event type)` within ninety days.
   Fewer than four resolutions is no evidence and the base floor stands. Four or
   more with **zero** acceptances suppresses the type outright — no candidates
   are selected and no inference is bought. Otherwise the accept rate sets the
   confidence floor, linearly between 0.8 and 0.95.
3. **The candidate's own run of dismissals.** The candidate query takes the
   twelve most recently active, non-archived, visible work streams — and skips
   any with `DISMISSAL_RUN_LIMIT` dismissals inside thirty days that are newer
   than its most recent acceptance. Evaluated inside the query, so a suppressed
   work stream is *replaced* by the next eligible one rather than costing the
   model a slot.
4. **The confidence floor.** One structured inference (role
   `activity_structured`) returns `candidateWorkstreamId`, `confidence`,
   `reason`, `matchedEntities`, and `suggest`. A card needs `suggest`, a
   confidence at or above the floor gate 2 computed, and an id that is actually
   in the candidate list.

What survives is written by `createActivitySuggestion` as a `pending` row and
published to the work-stream room, where the desktop client renders it as a
transcript block. `resolveSuggestion` later stamps `accepted` or `dismissed`,
which is what gates 2 and 3 read on the next activity.

## Invariants

- **Every gate may only withhold.** A gate that cannot get an answer — an
  unregistered connector, a manifest that dropped an event type, a registry that
  will not build — must produce *no card*, never a default yes. A gate that
  admits on failure turns an outage into a spam campaign in somebody's transcript.
- **`digestible` is consumed here and authored elsewhere.** Never flip a type to
  digestible to change routing: that puts it in everyone's digest to fix one
  surface, and [`connector-digestibility.md`](connector-digestibility.md) is
  reviewed as a statement about a person's inbox. Routing reads that judgement;
  it does not get a vote in it.
- **Suppression must decay.** Both feedback reads are windowed because a
  suppression rule that blocks the only mechanism which could produce positive
  evidence is permanent by construction — a suppressed event type can never earn
  the acceptance that would unsuppress it. Any future rule added here needs its
  own way back, or it is a one-way door.
- **Candidate suppression belongs inside the candidate query.** Filtering after
  `LIMIT 12` silently shrinks the list the model sees, which makes a work stream
  with a dismissal run cost a *different* work stream its chance to be matched.
- **`resolveSuggestion` is the only writer of the feedback signal.** Anything
  else that resolves a suggestion — a bulk cleanup, a cascade, a backfill —
  writes training data for these gates. A migration that mass-dismisses pending
  rows would suppress every event type in the workspace.

## Boundary

Contextual routing owns the decision to *offer* an activity to a work stream, and
nothing else. It never attaches, never posts a message, never starts a run.

It does not own: resource watches or automation triggers (`consumeActivityQueue`,
[`CONNECTORS.md`](CONNECTORS.md#activity-ingestion)), which are deterministic and
deliberately exempt from every gate here because they were asked for by name; the
home-screen suggestions ([`SUGGESTED_WORK.md`](SUGGESTED_WORK.md)), which are a
separate admission agent over a batched window and keep their own per-user
dismissal state; the digest ([`DIGESTS.md`](DIGESTS.md)), which shares the
`digestible` declaration but nothing else; or the accept/dismiss endpoints and
their idempotency ([`CONNECTORS.md`](CONNECTORS.md#activity-ingestion)).

Callers: `consumeOne` only. The feedback module is reachable from anywhere but has
no other caller by design — a second consumer of these thresholds means two
policies that will drift.

## Failure modes and limits

| Limit | Value |
| --- | --- |
| Candidates offered to the model | 12, most recently active first |
| Dismissals that suppress a candidate work stream | 3, within 30 days, since its last acceptance |
| Resolutions before an event type's accept rate counts | 4, within 90 days |
| Confidence floor | 0.8 with no record, up to 0.95 as the accept rate falls |
| Activity snippet / candidate objective sent to the model | 2,000 / 1,000 characters |
| Stored title / summary / reason / matched entities | 300 / 2,000 / 1,200 characters, 100 entities |

- **The connector registry will not build.** Every activity is withheld and
  `activityIsDigestible` logs `connector_registry_unavailable_for_digestibility`.
  One malformed credential disables contextual routing region-wide, silently
  apart from that line — which is why the line exists.
- **No `OPENROUTER_API_KEY`.** Contextual routing is skipped entirely; watches
  and automations are unaffected.
- **A suppressed activity is not dropped.** Gates 1–4 return `false`, which is
  the same answer "the model declined" gives, so the activity continues to
  suggested-work batching. Noise removed here does not vanish from the product;
  it moves to a surface with its own admission agent and its own dismissal
  feedback.
- **A window expiring costs one card.** When a suppressed event type's
  dismissals age out at ninety days, the next matching activity produces a card
  again. That is the price of the decay above, and it is bounded at one card per
  type per window.
- **The floor cannot exceed 0.95.** A floor of 1.0 is unreachable rather than
  strict, and would make the outright-suppression branch dead code.

## Testing

`apps/api/test/activity-contextual-routing.test.ts` covers all four gates against
a migrated in-memory SQLite database:

```bash
pnpm --filter @avalon/api exec vitest run test/activity-contextual-routing.test.ts
```

Two traps. **GitHub credentials in the fake env are load-bearing** — the registry
is what answers digestibility, and `GITHUB_APP_PRIVATE_KEY` must be PEM-shaped or
the registry throws and every activity is withheld for the wrong reason; one test
asserts that withholding deliberately, the rest would pass vacuously. And
**resolution timestamps are relative to the real clock** (`daysAgo`), because the
windows are measured from `new Date()` inside the feedback reads; pinning a base
date makes the suite pass until the date drifts past the window.

## Data model

No tables of its own. `activity_suggestions` (see
[`DATA_MODEL.md`](DATA_MODEL.md)) is both the output and the training data: one
row per card, `UNIQUE (activity_id, workstream_id)`, `status` carrying the label.
A row is written at the moment the card is published, so every row was seen by
somebody and no separate impression count is needed — unlike
`work_opportunity_user_states`, which tracks impressions because an opportunity
can be ranked without ever being shown.

## Operations

A card that should have appeared and did not is one of four gates, in this order:
`contextual_routing_event_type_suppressed` (logged with the dismissal count when
gate 2 suppresses a type), then the absence of a warn line from
`activityIsDigestible`, then the manifest, then the model's own answer. Gates 1,
3, and 4 are deliberately silent — they fire on most activity, and logging them
would bury the one line that means something.

## Changelog

### 2026-08-12 — A suggestion card has to earn its place, and the workspace's own dismissals decide

**What changed:** Contextual routing gained three gates before the one it had.
An event type a connector declares non-digestible no longer produces a card at
any confidence. An event type this workspace has resolved at least four times
and never once accepted stops being asked about at all, before the inference. A
work stream with three dismissals in thirty days and no acceptance since drops
out of the candidate pool. The flat 0.8 confidence floor is now the *base* of a
floor that rises to 0.95 as an event type's accept rate falls. Both feedback
reads are windowed, and `activity_suggestions` gained the two indexes they seek
on.

**Why:** The only quality control was a constant compared against a number the
model made up about its own answer, and nothing ever read the resolution back.
`resolveSuggestion` had written `dismissed` since the feature shipped and no
code anywhere read that column, so a workspace could dismiss the same suggestion
every day and the next one arrived with identical odds — the pipeline documented
"persist accepted/dismissed routing feedback" as a step and persisted it into a
column nothing consumed. Meanwhile the candidate query never looked at the
activity at all: any of the twelve most recently touched work streams was a
candidate for any event, so the model was asked "does this fit one of these
twelve?" for every unclaimed activity, including the eleven check runs a single
pull request starts. The observed failure was a `review_requested` card routed
to an unrelated work stream whose stated reason cited no shared entity — a
correct classification of a real event, offered to the wrong place, with no way
for the person dismissing it to affect the next one.

**Considered and rejected:** Requiring `matchedEntities` to be non-empty before
creating a card. It is the obvious code-level version of the prompt's "a shared
generic keyword is not sufficient", and it was rejected because the field is
produced by the same model whose judgement is in question — a model inclined to
suggest is equally inclined to name an entity, so the gate would be satisfied by
the cases it exists to catch. Deterministic entity overlap between the activity
and each candidate is the version of that idea worth having, and it is not here
yet; see the note below.

Also rejected: raising the constant to 0.9 for everyone. It trades recall
everywhere for precision in the workspaces that were complaining, and it still
compares against a self-reported score, so it moves the number without making it
mean more.

Also rejected: an unwindowed accept rate. Cleaner arithmetic and more stable,
but a suppressed event type can never produce the card that would earn it an
acceptance, so the first four dismissals would have suppressed a type forever.

**Consequences:** `digestible` is now load-bearing for two surfaces. Anyone
tempted to flip a type to digestible so that routing will consider it is
changing what lands in every member's inbox to fix a transcript — the invariant
above says so, and a reviewer should treat that diff as a digest change first.
Any future gate added here needs a way back for the same reason the two windows
exist. And because a withheld activity continues to suggested-work batching
rather than being dropped, noise removed from transcripts arrives at the home
screen instead; if that surface gets louder after this, the batching window is
where to look, not these gates.

Deterministic entity overlap before the inference — shrinking the candidate list
by the resource and entity keys `matchingResourceIds` already computes on the
same activity — is the next thing this design wants, and would let the candidate
pool stop being "twelve most recent" for events that name a resource at all.
Shipped without it because the feedback gates are measurable on their own and
overlap-based selection changes recall in a way that wants a look at real
resolutions first.

Pull request number to be added when this is opened.

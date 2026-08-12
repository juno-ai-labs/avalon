# Suggested work

The four suggestions on the home screen: where they come from, who is allowed to
see one, and — the part that has bitten hardest — when the ranking that orders
them is allowed to run.

Read this before changing admission, ranking, the `work_opportunities` family of
tables, or `GET /work-opportunities`. The candidate ingestion that feeds it is
`work-opportunity-batching.ts`; the model contracts are in
[`AGENT_HARNESS.md`](AGENT_HARNESS.md) and the flags that route them are in
[`FEATURE_FLAGS.md`](FEATURE_FLAGS.md).

## The pipeline

```
connector activity / Avalon mention
  → activity consumer: watches, automations, contextual routing
  → nothing claimed it? enqueueActivityOpportunity()
  → opportunity_batch_windows          (10-minute debounce, 60-minute cap)
  → cron: processDueOpportunityWindows()
  → admission model                    → work_opportunities
  → marks the affected members due
  → cron: processDueSuggestedWork()    → ranking tournament → suggested_work_sets
  → GET /work-opportunities            reads the stored set, nothing more
```

Two properties hold the whole thing together, and both were learned the hard
way in production:

1. **A request never ranks.** `list()` reads `suggested_work_sets` and filters it
   to what is still showable. No model call is on the read path.
2. **Ranking follows attention.** A member seen in the last fifteen minutes is
   ranked first; one not seen in a week is not ranked at all until they return.

### Admission

An activity only becomes a candidate if nothing else claimed it — no resource
watch, no matching automation, and no contextual routing suggestion. That gate
is in the activity consumer, and it is deliberately exclusive: work that already
has a home should not also be offered as new work.

Note that "no contextual routing suggestion" now includes the case where
contextual routing **suppressed** the event type rather than declining it, since
both return the same answer. Admission's `route_existing` decision then writes an
`activity_suggestions` row through the shared `createActivitySuggestion` — the
same Suggested context card contextual routing produces — so this path can
publish a card for an event type that module has stopped producing. The row is
stamped `source = 'suggested_work'` so the two populations stay separable, and
[`contextual-routing.md`](contextual-routing.md) requires every feedback read of
that table to filter on it. Whether suppression on one side should silence the
other is undecided; if it is ever decided yes, the gate belongs here.

Admission itself is a model decision (`work_opportunity_admission`) and is
biased toward `ignore`. It resolves the people named in the evidence against
verified external identities, and it never lets an inference widen access: for a
personal audience, a link may explain a suggestion but can only ever target the
audience member.

Audience is decided by the batch window's partition. A personal connector's
activity is `personal:<owner>` and is visible to that member alone; a workspace
connector's is `workspace` and is visible to every active member.

### Ranking

The tournament groups candidates, ranks each group, and ranks the winners, down
to a final ordered four. Elimination rounds run at low reasoning effort — they
answer "which of these twelve survive", asked several times — and only the final
comparison runs at high effort.

It is bounded on three axes, and every one of them exists because the unbounded
version did not finish:

| Bound | Value | What it stops |
| --- | --- | --- |
| `MAX_RANK_CANDIDATES` / `MAX_RANK_CHARACTERS` | 12 / 80k | A group too large for one call |
| `MAX_RANK_ROUNDS` | 10 | A tournament that will not converge |
| `RANK_BUDGET_MS` | 2 min | A tournament that converges too slowly to matter |
| `SCHEDULER_BUDGET_MS` | 4 min | A whole pass overrunning the cron it lives in |

`SCHEDULER_BUDGET_MS` is the one that has to be safe. The pass runs inside the
scheduled handler's `waitUntil`, on a five-minute cron, beside eleven other jobs
and under a fifteen-minute ceiling; bounding only the per-member budget left a
pass free to cost `MAX_RANKINGS_PER_TICK` times that in sequence. With the pass
bounded by time, the per-tick count is a ceiling rather than the throughput
limit — it is region-wide across every workspace, and the hourly impression
trigger alone wants one ranking per active member per hour.

On exhausting the budget a tournament keeps the finalists it has, in tournament
order, and writes them. **A ranking must always write something, and never an
empty something while candidates exist.** `orderedOpportunityIds` has a maximum
and no minimum, and ids the model invents are filtered out, so a ranking can
select nothing; storing that against the real fingerprint creates a set the read
path calls unranked and the scheduler declines to re-rank, and the two do that to
each other indefinitely. An empty selection therefore falls back to recency
order. A member with nothing stored also gets recency order written first,
against an *empty* fingerprint, so they see four suggestions immediately while
the real ranking stays outstanding.

### Starting one

`POST /work-opportunities/:id/start` creates a work stream whose title and
objective are the `displayPrompt` and whose opening message is the
`executionPrompt` — **written as the selecting member's own turn**, not the
agent's. Selecting is the request, and the brief is that request expanded; the
`suggested_work_expansion` structured content on the message is what records that
the words are Avalon's, and both the transcript label and the model projection
read it from there rather than from the author. The creation path itself belongs
to [`workstream-creation.md`](workstream-creation.md).

## Freshness

`suggested_work_sets.candidate_fingerprint` hashes the id and version of every
candidate the member is eligible for. It is the *only* freshness signal, and it
is sufficient: it detects an admission, a revision, an expiry, a dismissal, and
an opportunity leaving `active`.

The one thing it cannot see is impressions, which feed the ranking but are not
candidates. That is why the impression trigger blanks `candidate_fingerprint`
along with setting `due_at` — asking for a ranking the cache will skip is not
asking for anything.

There used to be a `workspace_opportunity_versions` counter beside it, ANDed
into the same check. It was redundant on every axis and wrong on one — being
workspace-wide, it invalidated every member's set when an opportunity was
admitted for one member's private audience. Because the guard was an AND, it
could only ever cause misses the fingerprint would not. In production it drifted
517 versions ahead of a valid stored set and discarded it on every read, so
every home-screen load re-ran a full tournament that could not finish inside a
request, was cancelled when the client gave up, and stored nothing — leaving a
workspace with 245 live suggestions showing an empty section indefinitely.

The counter and `suggested_work_sets.workspace_version` are no longer read or
written. They are dropped in a follow-up migration, once a release has passed.

### What asks for a ranking

| Trigger | Delay | Who |
| --- | --- | --- |
| Opportunity admitted or revised | `DUE_DEBOUNCE_MS` (2 min) | The window's audience — one member, or every active member |
| Opportunity names a member | none | That member |
| Member dismisses or starts a suggestion | none | That member |
| Impressions, at most hourly | none | That member |
| Read finds eligible candidates the stored set does not account for | none | That member |
| Read finds a ranked suggestion no longer showable | `DUE_DEBOUNCE_MS` | That member |

A workspace-scope admission marks **every** active member, set-based over
`workspace_members` — not the member list admission was given, which is capped
at 250 by name and would leave the rest of a large workspace never re-ranked.

The two read-path rules are what catch a hole nothing on the write path sees: a
workspace suggestion started or dismissed by *somebody else*, or one that simply
expired. Note the second is about a gap, not an absence — a member with no
eligible opportunities has an empty set as their steady state, and asking for a
ranking on that would cost a write and a scheduler claim on every read forever.

A hole is also topped up from the recency fallback for the read that finds it,
rather than rendering a short list until the next pass. The inline ranking this
replaced always returned four, and a home screen quietly losing a row for minutes
is a regression the member can see.

Setting a due time never delays one already outstanding — `MIN` wins.

Which is exactly why a request is identified by **`request_seq`, not by
`due_at`**. Every ask increments the counter; the scheduler records the value it
claimed and clears the request only if that value is still current. Comparing
due times instead does not work, and the reason is subtle enough to be worth
stating: an admission landing mid-tournament debounces two minutes out, which is
*later* than the request being ranked, so `MIN` keeps the existing value and the
column does not move at all. A request that leaves the row byte-identical is
indistinguishable from no request, and the completed run clears it on the way
out — the member keeps a set that was out of date before it was written.

The scheduler claims on the same counter, so a request withdrawn or superseded
between the scan and the claim is declined rather than answered. Clearing
matters as much as setting: a due time left behind is re-claimed on every pass
forever.

### What the scheduler will not do

- **Rank a dormant member.** Their request stays outstanding and is served on the
  first pass after the auth middleware records them again.
- **Starve the less-active tier.** A request waiting longer than
  `RANK_STARVATION_MS` is promoted to the top tier, so a handful of members who
  are always due cannot hold the queue indefinitely.
- **Record a failed settle as a failed ranking.** The settle sits outside the
  catch that marks `status = 'failed'`; a lease left to expire costs one re-rank,
  where marking a good set failed costs the member their suggestions.
- **Push a newer request out on failure.** The retry delay applies only when
  `request_seq` still matches the attempt that failed.
- **Overwrite `status` when it claims.** Claiming is lease-only. `status` is the
  record of how the last ranking ended, and the fingerprint cache reads it — a
  claim that clobbered it would guarantee a full tournament every time.
- **Release the lease before the run is over.** `storeRankingSet` writes the
  ranking and touches neither `due_at` nor the lease, because it is also called
  mid-run for the provisional write. Only `settleRankingRequest` ends a claim.
- **Rank more than `MAX_RANKINGS_PER_TICK` members per cron pass.**

## Member activity

`workspace_members.last_seen_at` is written by `requireAuth`, debounced to
`LAST_SEEN_RESOLUTION_MS` (5 minutes) in the statement rather than by reading
first. It is deferred and its failures are swallowed: it schedules background
work and is never worth failing a request over.

It is on the membership, not the user — someone can be active in one workspace
and dormant in another, and this schedules per-workspace work. `NULL` reads the
same as dormant, which is correct for a member who has not been seen since the
column was added; no backfill.

## Tables

| Table | Holds |
| --- | --- |
| `work_opportunities` | The suggestion: both prompts, audience, provider icon, TTL, start bookkeeping |
| `work_opportunity_user_links` | Who the evidence named, how confidently, and where that is recorded |
| `work_opportunity_user_states` | Per-member impressions, dismissal, and what they started |
| `opportunity_provenance_nodes` / `_edges` | The evidence graph, scoped by visibility |
| `work_opportunity_snapshots` | What a member actually saw at the moment they started one |
| `suggested_work_sets` | The stored ranking, its fingerprint, and its scheduling state |
| `suggested_work_ranking_rounds` | Every tournament round, for explaining a ranking after the fact |

`suggested_work_ranking_rounds` is the first place to look when suggestions are
wrong or missing: rounds accumulating with no corresponding `last_ranked_at`
means tournaments are starting and never finishing.

## Known gap

Batch events that fail admission three times are abandoned (`requeueFailures`
retries below `attempt_count < 3`). There is no dead letter and no alert, so the
activities behind them are silently never considered. In production this had
consumed 1,775 events — mostly admission timeouts — by the time anyone looked.
Not addressed here.

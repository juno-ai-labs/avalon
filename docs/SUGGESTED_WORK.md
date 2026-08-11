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
| `RANK_BUDGET_MS` | 4 min | A tournament that converges too slowly to matter |

On exhausting the budget it keeps the finalists it has, in tournament order, and
writes them. **A ranking must always write something.** A member with nothing
stored gets the recency order written first, against an empty fingerprint, so
they see four suggestions immediately and the next pass still treats the real
ranking as outstanding.

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

Setting a due time never delays one already outstanding — `MIN` wins. Answering
one is the scheduler's job alone, and it answers **only the request it claimed**:
`settleRankingRequest` compares `due_at` against the value it claimed, so a
dismissal arriving during a four-minute tournament survives it. Clearing matters
as much as setting: a due time left behind is re-claimed on every pass forever.

### What the scheduler will not do

- **Rank a dormant member.** Their request stays outstanding and is served on the
  first pass after the auth middleware records them again.
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

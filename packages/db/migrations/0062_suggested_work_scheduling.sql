-- Moves suggested-work ranking off the request path and onto a schedule.
--
-- Ranking a member's four suggestions is a model tournament: the candidate pool
-- is grouped, each group is ranked, the winners are ranked again. At a few dozen
-- live opportunities that is a handful of calls; at a few hundred it is more
-- than a request can hold, and `GET /work-opportunities` was running the whole
-- thing inline on every home-screen load. It did not finish. The client gave up,
-- Cloudflare cancelled the worker mid-tournament, the completed set was never
-- written, and the next request started over from nothing — so a workspace with
-- 245 perfectly good suggestions showed an empty home screen indefinitely.
--
-- The read path now only reads. These columns are what lets something else do
-- the ranking.

-- When this member's set should next be ranked. NULL means it is current and
-- nothing is waiting on it, which is the steady state and the common row.
--
-- Deliberately a timestamp rather than a boolean: "due" and "due at 09:05" cost
-- the same to store, and the timestamp lets a trigger ask for work later than
-- now — the debounce a burst of admissions needs so twenty opportunities landing
-- in one window schedule one ranking rather than twenty.
ALTER TABLE suggested_work_sets ADD COLUMN due_at TEXT;

-- When a ranking last completed. `updated_at` cannot answer this: it moves for
-- every touch, including being marked due and being leased, so it says when the
-- row changed, not when the suggestions in it were last decided. The scheduler
-- needs the latter to keep an active member's set from going stale while nothing
-- in particular has changed.
ALTER TABLE suggested_work_sets ADD COLUMN last_ranked_at TEXT;

-- Counts requests for a ranking, and is the identity of the one outstanding.
--
-- A ranking takes minutes, and anything can ask for another while it runs. The
-- scheduler must answer only the request it claimed and leave a later one
-- standing, which means recognising "the request now outstanding is not the one
-- I picked up". `due_at` cannot carry that: it is a *when*, and it is combined
-- with `MIN` so that asking again never delays a ranking already waiting — so a
-- request raised mid-run against an earlier due time leaves the column
-- byte-identical and is indistinguishable from no request at all.
--
-- A counter has no such collision. Every ask increments it, the scheduler
-- records the value it claimed, and clearing is conditional on that value still
-- being current.
ALTER TABLE suggested_work_sets ADD COLUMN request_seq INTEGER NOT NULL DEFAULT 0;

-- Partial, because a set that is not due is not a scheduling candidate and the
-- steady state is that almost none of them are. This keeps the scheduler's scan
-- proportional to the work outstanding rather than to the number of members.
CREATE INDEX suggested_work_sets_due_idx
  ON suggested_work_sets(due_at)
  WHERE due_at IS NOT NULL;

-- The last time this member was seen using Avalon, written by the API's
-- authentication middleware and debounced there so it is one write per member
-- per few minutes rather than one per request.
--
-- On the membership rather than the user because it is a scheduling input for
-- per-workspace work, and someone can be active in one workspace while dormant
-- in another. Ranking follows attention: a member who was in the app minutes ago
-- gets a fresh set, and a member who has not opened it in a week does not have a
-- model tournament run for them every time an activity lands.
--
-- NULL means never seen since this migration, which is also how a genuinely
-- dormant member reads. The scheduler treats both the same way — rank on demand
-- when they next appear — so no backfill is needed or wanted here.
ALTER TABLE workspace_members ADD COLUMN last_seen_at TEXT;

CREATE INDEX workspace_members_last_seen_idx
  ON workspace_members(workspace_id, last_seen_at);

-- Every existing set is stranded: it was invalidated by a version counter that
-- the code no longer consults, and nothing else will ever come along to mark it
-- due. Making them all due now is what repairs them, on the first scheduler pass
-- after deploy, in the scheduler's own priority order and inside its own budget.
UPDATE suggested_work_sets
   SET due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), request_seq = request_seq + 1;

-- Not dropped here, and not written from this migration forward:
-- `workspace_opportunity_versions` and `suggested_work_sets.workspace_version`.
--
-- They were the freshness signal, and they were redundant from the day they were
-- added. `candidate_fingerprint` already hashes the id and version of every
-- candidate the member is actually eligible for, so it detects everything the
-- counter did — an admission, a revision — and three things it did not: expiry,
-- this member's own dismissal, and an opportunity leaving `active`. The counter,
-- being workspace-wide, also invalidated every member's set when an opportunity
-- was admitted for one member's personal audience, which by construction could
-- never appear in anyone else's candidate list.
--
-- Since the guard was an AND of the two, the counter could only ever cause
-- misses the fingerprint would not: on this workspace it sat 517 versions behind
-- and discarded a valid set on every read. The code stops reading and writing
-- both in this change; the columns come out in a follow-up, once a release has
-- gone by and no deployed worker still refers to them.

# Potential bugs and coverage gaps

Things found while reading the code that look wrong, or that nothing proves are
right. Each entry says what was observed, why it is suspicious, and — the part
that matters — **what would settle it**.

Nothing here is a confirmed defect. A confirmed defect gets fixed in the change
that finds it, or filed as work; this file is for the ones where the evidence
stops short of proof and the next person should not have to rediscover the
question. An entry is deleted when it is resolved, with the resolution recorded
in the owning module document's changelog.

**Read this before assuming a suspicious-looking path is fine because tests
pass.** Several entries below exist precisely because the tests that covered
them were covering unreachable code.

## How entries are written

- **Observed** — what the code does, with `file:line`.
- **Why it is suspicious** — the invariant it appears to break, or the claim
  nothing checks.
- **What would settle it** — the specific evidence that turns this into either
  a fix or a deletion. An entry without this is an opinion, not a finding.
- **Severity** — `data-loss`, `wrong-answer`, `waste`, or `coverage-gap`.

---

## `loadSource` reads a table migration 0090 dropped

**Severity:** wrong-answer

**Observed.** `services/work-opportunity-service.ts` `loadSource` selects
`FROM activity_events` for a `workstream_message` source, on the
`durable_object_open` arm — the live one. `activity_events` was dropped from
regional D1 by `packages/db/migrations/0090_drop_legacy_product_tables.sql:540`,
and it is not in `WORKSPACE_LOCAL_TABLES`, so a routed handle would not reach it
either. The `env` at that call site is the plain Worker env, unrouted.

**Why it is suspicious.** Every other `activity_events` reader in the tree was
on a legacy arm and has been deleted. This one is on the *live* arm, so if the
branch is reachable it raises `no such table: activity_events` rather than
returning a source. The function returns `ModelSource | null`, and callers treat
`null` as "nothing to summarise" — so a throw here is not a quiet degradation,
it fails the opportunity batch.

**What would settle it.** Whether any `opportunity_batch_events` row is written
with `source_kind = 'workstream_message'` post-cutover. If none is, the branch is
dead and should be deleted with its sibling. If some are, this is a live failure
and the query needs to move to whatever now owns work-stream messages. Grep the
producers of that table; the answer is in what they set `source_kind` to.

---

## Slack workspace-session assignment spans two objects in one statement

**Severity:** wrong-answer (if reachable)

**Observed.** `services/slack-agent-service.ts` `assignWorkspaceSessions` has a
fall-through arm that runs one `INSERT INTO workstream_participants … SELECT …
FROM slack_agent_sessions`. `workstream_participants` belongs to the work-stream
object; `slack_agent_sessions` is defined only in
`durable-objects/workspace-domain-schema.ts`. Both were dropped from D1 by 0090
(`:460`, `:483`). No database anywhere holds both.

**Why it is suspicious.** It cannot succeed on any routing path: unrouted it
hits two dropped tables, work-stream-routed it fails on
`slack_agent_sessions`, workspace-routed it is handed down to the work-stream
port and fails the same way.

**What would settle it.** It sits below `if (authority.phase ===
"durable_object_open") { … return }`, so it is unreachable wherever 0090 has
applied — which is everywhere supported. Deleting it is the resolution, and it
is in scope for the dead-arm sweep. Entry stays until that deletion lands.

---

## WorkspaceDO's activity read filter, target marking and dedupe are untested

**Severity:** coverage-gap

**Observed.** Two suites appeared to cover this and did not.
`test/activity-event-projection.test.ts` and the "activity event visibility"
suite in `test/digest-schedule.test.ts` both wrote and read through
`recordActivityEventOrThrow` / `listActivityEventsForUser` — but through their
**D1 arms**, a parallel implementation selected only when the authority was not
open. Production has always taken the other arm, which delegates to
WorkspaceDO. The D1 implementation is now deleted; the projection tests were
retargeted at the input `projectActivityEvent` computes, and the visibility
suite was removed.

**Why it is suspicious.** This is not a gap the deletion opened — it is one the
deletion *revealed*. Audience filtering, `is_target` marking, the cursor's
half-open window, system-work-stream suppression, membership-status filtering
and the `ON CONFLICT` dedupe are all WorkspaceDO's, and none of them has ever
been exercised. Two implementations existed and the tests only ever ran the one
nothing uses.

**What would settle it.** A `test-workers/` suite against a real WorkspaceDO,
porting the assertions the deleted suite made: two records with one `dedupeKey`
yield one row; a `{kind: "user"}` audience is withheld from everyone else; a
work-stream event is withheld from non-participants; a named target comes back
with `is_target`; a system work stream's events are withheld from everyone
including its participants; a membership that stops being active stops the log;
and a cursor excludes what it has already covered, including within one
millisecond.

---

## `changes` means something different either side of a compatibility view

**Severity:** wrong-answer (latent)

**Observed.** `durable-objects/workstream-runtime-sql.ts:178-180` reports
`counted` (a trigger's own counter) for a statement targeting a compatibility
view, and `Math.max(cursor.rowsWritten, counted)` for one targeting a real
table. `rowsWritten` counts index writes: a one-row update of an indexed column
reports 2, which `test-workers/terminal-authority.test.ts` now pins.

**Why it is suspicious.** Every remaining slice of the compatibility-layer
retirement moves statements from views onto real tables. A caller that checks
`changes === 1` — rather than `> 0` — silently changes meaning when its
statement moves, and nothing flags it.

**What would settle it.** A sweep of `d1Changes(...) === ` comparisons against
routed statements. `> 0` is safe; `=== n` is not. Worth doing once, before the
next slice, rather than per slice.

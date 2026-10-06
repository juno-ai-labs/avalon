# Space access sources (retired)

**Retired.** From the Spaces cutover until PR #1119, a Space supplied readers to
the Channels placed in it: an Organization-wide Space made a Channel public, and
a private Space seated its participants. Every Space is Organization-wide now
and grants no reader ([`spaces.md`](spaces.md#every-space-is-organization-wide)),
so the code that applied and withdrew a Space's audience on its Channels was
deleted. WorkspaceDO migration 93 dropped its tables.

This document keeps what that code taught, for whoever builds anything that lets
one object grant access to another. Read it before designing a new "source" of
readers: most of these were learned from a bug.

## What it was

- **Sources and a union.** A Channel had a *direct* audience (its own scope and
  participants) and one *source* per Space it was in. Its readers were the
  union: any Organization-wide source made it public, otherwise the readers were
  every source's participants plus its own (`effectiveChannelAudience`).
- **Plans, not writes.** Joining or leaving a Space computed a *plan* against
  the Channel as observed (widen, seat these people, narrow, remove these
  people). The Channel's own conversation then ran the plan through its ordinary
  scope and participant operations, which is where the retained-content fence
  lives. Nothing else ever wrote a Channel's audience.
- **Provenance.** The Channel's hosted parent recorded each source
  (`parent_space_sources`), the readers each one seated (`parent_space_readers`),
  the Channel's own scope (`parent_direct_audience`), and a receipt per step
  (`parent_access_operations`).
- **Three steps per change.** `SpaceChannelAccess` in WorkspaceDO ran every
  add, removal, move, archive, restore and audience change as one plan
  transaction, the Channel's operations, and one confirm transaction, with a
  `space_intents` row in between for the alarm to resume.

## What it taught

1. **A source may only widen.** If one source could narrow, a Space leaving could
   revoke access another Space still supplied, and every audience change would
   need an audit of every other Space. Widen-only made sources compose; the cost
   was that narrowing had to be expressed as *withdrawing* a source, never as a
   smaller application of one.
2. **Change an audience by retract-then-apply.** Because an application only
   widens, re-applying a smaller roster leaves the dropped readers seated with
   nothing accounting for them. Withdraw first, then apply.
3. **Seat before you narrow, remove last.** A narrowing that runs before the
   surviving readers are seated revokes access a remaining source still
   supplies, even for a moment. The safe order was: seat survivors, narrow the
   scope, then remove the departed.
4. **Record provenance before the side effect.** Survivors were attributed to
   the Space that still supplied them *before* they were seated, so a crash
   between the two left an attribution the resume could finish, not a seat
   nobody owned.
5. **A replayed receipt runs the old rules.** Steps were idempotent by storing
   their plan under an operation id. That made retries safe, but after a rule
   change a stored plan replays the rule that wrote it. Migration 93 had to drop
   those receipts before the tables went. Any receipt that stores a *decision*
   rather than a *result* needs a plan for rule changes.
6. **Fence the retraction too.** A retraction deletes the row that later steps
   fence on, so an older change interleaved behind a newer one found nothing to
   lose to and installed a stale roster. Retractions carried the Space revision
   for that reason, not for symmetry.
7. **A tri-state answer is not a yes.** The containment preview answered `true`,
   `false`, or `null` (not that Channel's main conversation). Treating `null` as
   consent widened a Channel nobody had asked. Only `true` admits.
8. **Preflight is an early-out, not the fence.** The preview ran before any
   Channel changed because widening cannot be undone (somebody may have read).
   The real fence was the canonical operation running the same predicate inside
   the transaction that changed the audience.
9. **Observe archived things from the directory.** An archived Channel's product
   read answers 404, so retractions and restores read the directory's
   projection instead, and skipped the conversation-side seating that an
   archived Channel refuses.
10. **Do not trust a reader's view of the thing you are applying.** A viewer who
    reaches a Space only through one of its Channels is shown an empty roster by
    design. Applying that view would have withdrawn every reader the Space
    supplied and reported success. Refuse a view that is not the
    Organization's answer.
11. **Bound fan-out by the platform, not by guess.** Archive overlapped six
    Channel retractions per page: Cloudflare's limit on simultaneous outgoing
    connections. Walks recorded their cursor on the intent so a page that ran
    out of subrequests resumed where it stopped.
12. **Sticky provenance in grants.** A direct share over a Space-seated grant
    made the Channel responsible for that reader, and a Space withdrawing
    afterwards had to leave it alone; which write arrived last was queue order
    nobody controls. Space-seated grants also stayed out of the scope-grant
    directory, so General's membership did not become Organization size times
    Channel count in one flat index.

## Why it went

It was correct, and expensive: each membership change was two transactions, a
cross-object call per Channel, a staged intent, and a resume path. Once every
Space was Organization-wide and granted nothing, every plan was empty, so the
machinery only cost latency and kept stored plans that could replay the old
rule. Membership changes are now one WorkspaceDO transaction each.

## What is left

- `parent_grants.source_kind = 'space'` rows written before migration 93. They
  stay out of the scope-grant directory; an ordinary removal revokes one, and a
  direct share promotes it to `direct`.
- `space_intents` rows of the old kinds staged before the deploy. The alarm
  finishes each one in a single transaction
  (`WorkspaceSpaceStorage.resumeLegacyIntent`); nothing stages new ones.
- `ChannelAccessSources.spaces`, always `[]`, kept so released desktops still
  parse `GET /workstreams/:id/access`.
- The retired refusal codes in `SpaceErrorCode` and their desktop copy, for an
  older server during a rolling deploy.

## Changelog

### 2026-10-06 — Space access sources removed

**What changed:** `SpaceChannelAccess`, the source plans, the hosted parent's
source tables and protocol, `previewAudienceContainment`, and the
`spaceSourceId` participant path were deleted. Space membership changes are
single WorkspaceDO transactions.

**Why:** Every Space is Organization-wide and grants no reader, so the plans
were always empty and the machinery only added round trips and a replay hazard.

**Considered and rejected:** Leaving it in place with empty plans. It kept two
transactions and a Channel round trip on every drag, archive and restore, and
stored plans that could replay the retired rule.

**Consequences:** If a future feature lets one object grant readers to another,
start from the lessons above rather than from scratch.

Pull request: [#1119](https://github.com/juno-ai-labs/avalon/pull/1119).

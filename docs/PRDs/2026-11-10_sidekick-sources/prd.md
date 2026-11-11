# Sidekick sources and a Sidekick's own identity

> Created 2026-11-10.
>
> A person lets events from one of their accounts start a Sidekick, with a
> filter in their own words, without lending the Sidekick their account. A
> Sidekick with nobody to act as still runs, as itself. Builds on
> [Sidekicks attached to Canvases](../2026-11-10_sidekicks-attached-to-canvases/prd.md)
> and changes parts of [Sidekick delegation](../2026-10-22_sidekick-delegation/prd.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Two people can feed one Sidekick from their own mail. Morgan asks Rally, in a
Canvas, for a deal dashboard built from his and Jane's email about pre-seed
rounds. Rally asks Jane. Jane sees the request in the Canvas, in her Activity
and in her email, and approves or declines it. From then on new mail in either
inbox that matches the filter starts a run that updates the dashboard, and the
run is handed that one message. Jane has lent the Sidekick nothing else: it
cannot search her mailbox or send as her.

Underneath, two things that were one record are now two. A **source** says
whose events may start a Sidekick. **Delegation** says whose accounts its runs
may use. A Sidekick with no delegate is no longer stuck: it runs as itself,
with the Organization's connections and the Canvases it is attached to, and
delegates add their personal accounts on top.

## Motivation

The owner raised it on 2026-11-10 with the deal dashboard as the example. No
support thread or usage number is recorded. A delegation grant was one boolean
per person: it both let that person's events start the Sidekick and lent every
tool on every personal connection they had, and an agent could enroll a member
with no act of theirs. The only filter was the trigger's written condition,
which any manager can edit, so it was a preference and not something the
person agreed to.

## Goals

1. A person can let events from one of their connections start a Sidekick,
   limited to named event types and an optional written filter, without
   becoming a delegate.
2. Only that person gives the permission, by their own act, and nobody who
   edits the Sidekick can widen it.
3. A manager can ask several people at once. Everyone who can open the
   conversation it was asked in sees who was asked and where each stands; only
   the person asked can answer.
4. A person can answer from the conversation, from Activity, or with one click
   in the email.
5. A run started by a person's event is handed what the event is about, for
   mail that one message, and holds no tool on that person's account.
6. A Sidekick with no delegate runs, using the Organization's connections and
   its own reach. Delegates add their personal accounts.
7. Nothing that fires today stops firing.

## Non-goals

1. **Scoped delegation.** Limiting which tools a delegate lends, or filtering
   what a tool returns, is deferred. Delegation stays one boolean. It is the
   next step and now has nothing to untangle from triggers first.
2. **Asking before an agent enrolls a delegate.** Deferred, the owner's call
   to make. `sidekick_set_delegation` is unchanged, so an agent can still
   enroll a member for full access without their act.
3. **The thread around an admitted message.** Rejected for now: the owner
   chose the message alone.
4. **A filter that reads the message body.** Deferred. The filter is judged on
   subject, sender and snippet, which is what the event carries.
5. **Pinning a source to one Canvas.** Deferred. A source names the Sidekick.
6. **A person editing the filter they were asked for.** Deferred. They decline
   and the manager asks again.
7. **Trigger identity for the Sidekick's own condition.** Not needed: each
   person's filter is keyed by their connection. The known gap in
   [`semantic-activity-triggers.md`](../../semantic-activity-triggers.md)
   stands.

## Product behavior

[`sidekick-sources.md`](../../sidekick-sources.md) describes what shipped: the
request and its card, Activity row and email, the Sources section of the
Sidekick's panel, and what a run is handed.
[`automation-lifecycle.md`](../../automation-lifecycle.md#who-a-run-acts-as)
describes a run with no delegate. Platforms: macOS and web, which share the
renderer. The email page is the browser's.

## Impact on the product contract

Three clauses of earlier PRDs move.

- Sidekick delegation said a personal event "requires its source owner's
  eligible grant". It now requires that person's source. Delegation no longer
  decides anything about a trigger.
- Sidekick delegation said runnable work with no eligible delegate shows
  "Needs attention: no delegated user is available". A run a schedule or an
  event starts now runs as the Sidekick itself. A Sidekick that had already
  stopped that way stays stopped until a person acts.
- Sidekicks attached to Canvases said "every write admits the acting person
  again; losing the Canvas stops it". For a run a schedule or an event starts,
  the attachment alone now authorises its reach into a Canvas. A run a person
  asked for is still held to what that person can open.

The tool execution policy is unchanged: a source is asked for once, and its
filter then runs on each event without asking anybody.

## Decision log

The decisions taken during the build, and why, are recorded once, in the
changelogs of [`sidekick-sources.md`](../../sidekick-sources.md#changelog) and
[`automation-lifecycle.md`](../../automation-lifecycle.md#changelog).

## Rollout

Ships to everyone on merge, with no flag. WorkspaceDO migration 146 adds the
tables and backfills a source for every person whose delegation admitted a
configured rule's events.

## Open questions

1. Should an agent enrolling a delegate become a request too? (Non-goal 2.)
2. What threshold should a person's filter use? It shares the trigger gate's
   `0.5`, which was measured for the opposite cost: there a missed run is
   worse than a wasted one, and here a wrongly admitted message is worse.
3. Should a source be pinned to the Canvas it was asked for? (Non-goal 5.)
4. Should the emailed page ask for one click before it answers, since a mail
   scanner that runs JavaScript can otherwise answer?
5. Should an agent's ask for the asker's own account stay pending until they
   click, instead of being approved at once?

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

Two people can feed one Sidekick from their own mail. Adam asks Rally, in a
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

- Sidekick delegation's admission table said, for a personal connector
  event, "The bound connection's owner must be an eligible delegate and
  allowed to read the event", and for a workspace connector event, "At least
  one eligible delegate must be allowed to receive it"
  ([its trigger table](../2026-10-22_sidekick-delegation/prd.md#product-behavior)).
  Both rows move. A personal event now needs the connection owner's source,
  and an event limited to an audience on an Organization connection needs the
  source of somebody in that audience. Delegation no longer decides anything
  about a trigger; it still chooses who the admitted run acts as.
- Sidekick delegation said "When runnable work has no eligible delegate,
  show **Needs attention: no delegated user is available**". A run a
  schedule or an event starts now runs as the Sidekick itself. A Sidekick
  that had already stopped that way stays stopped until a person acts.
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

## Agent behavior

The durable contract is in
[`sidekick-sources.md`](../../sidekick-sources.md#agent-tools); the schemas
are in `apps/api/src/services/sidekick-source-tools.ts`. This section records
what was agreed.

**Plugin.** No new plugin. The three tools join the existing Sidekicks plugin
(canonical id `rally:sidekicks`, model id `rally_sidekicks`, wire prefix
`sidekick_`), after its delegation tools. The plugin's loading is unchanged:
it is preloaded for a Sidekick's wizard and stays behind `list_plugins` in a
Canvas's Chat. Loading it starts nothing, asks nobody
and stores nothing. Its system message gains one paragraph where the tools
are offered: sources are whose events may start a Sidekick, separate from
delegation; only the person asked can approve and an ask is not an approval;
to let someone's events in, ask for a source and never for delegation; load
the `setting-up-a-filtered-trigger` skill before asking.

**Where they are offered.** Only to a turn a person is driving: a person's
message in a Canvas's Chat or in a Sidekick's wizard. A Sidekick run, a
background agent, a run's delegation worker, and a wizard or Chat turn that
another agent's message or Rally's review notice started are not offered
them. Those turns work from content nobody typed, and such content must not
be able to ask in a person's name.

**Tools.**

| Wire name | Capability | Mode | Idempotency | What it does |
| --- | --- | --- | --- | --- |
| `sidekick_sources_list` | `rally.sidekick.sources.list` | read | safe | Input `sidekickId`. Returns each source (`userId`, `name`, `account`, `connectorType`, `eventTypes`, `condition`, `available`) and each request still waiting or declined. |
| `sidekick_request_source` | `rally.sidekick.sources.request` | write, serial | record before execute, re-enterable on its receipt | Input `sidekickId`, `userIds` (at least one), `connectorType`, `eventTypes` (at least one), optional `condition`. Returns `sidekickId` and each request as it stands, `pending` when new: asking approves nobody, the acting person included. It never waits for an answer. The client draws its output as the request's card. |
| `sidekick_test_source_condition` | `rally.sidekick.sources.test` | read | safe | Input `connectorType`, `eventType`, `condition`. Judges the acting person's own ten most recent events of that type with the production judge and returns `judged: true`, how many it let in, and each event's title, summary, snippet and verdict. With no classifier configured, or no recent events of that type, it returns `judged: false` and a reason. |

Every input is a strict object: an unknown field is refused. No tool takes
who is acting, where the card is drawn, or an answer. The host supplies the
acting person from the loop, the card's place from the conversation, and the
ask's `operationId` from the tool call's receipt, so a retried call returns
the requests the first call made.

**Sequence.** The skill's order: settle who and which events, write the
filter as a claim about one event, try it with
`sidekick_test_source_condition`, save the trigger, ask with
`sidekick_request_source`, then check with `sidekick_sources_list`. The
Sidekick's id comes from the conversation's context. Each named person is
resolved to an Organization user first, and the model asks which person is
meant when a name matches nobody or more than one. Event types come from the
connector's declared events.

**Failures.** Each carries a code and a sentence the model can act on:
`sidekick_source_request_requires_manager` (stop: only a manager asks),
`sidekick_source_person_unavailable` (correct the person and retry),
`sidekick_source_connector_unknown` and `sidekick_source_event_unknown`
(correct and retry; the second names the event type),
`sidekick_source_connection_missing` (stop: the acting person connects that
account first). A save of the definition can also be refused
`sidekick_source_owner_must_approve`: a rule names another person's own
connection and that person has not approved a request for the event type.
The sentence says to ask them with a source request and save again once they
approve.

**Forbidden.** No tool approves or declines; only the person asked answers,
in their session or from their email. Asking is not waiting: the tool call
ends at once and nothing pauses, which keeps the tool execution policy.

**Skill.** `setting-up-a-filtered-trigger`, owned by `rally:sidekicks`, is
listed only where a plugin in scope holds `sidekick_request_source`.

**Not done.** No prompt and tool evaluation on the medium fallback model was
run for these tools. `docs/prds.md` asks for one; the tests cover the
schemas, the offering and the transcript output only.

## Rollout

Ships to everyone on merge, with no flag. WorkspaceDO migration 146 adds the
tables and backfills a source for every person whose delegation admitted a
configured rule's events. Its last statement marks every active Sidekick
that has a trigger and no allowed delegate as stopped, so no Sidekick starts
running as itself because of the deploy
([`sidekick-sources.md`](../../sidekick-sources.md#operations)).

## Open questions

This PRD freezes when it completes. The living list, with what each answer
would change, is in
[`sidekick-sources.md`](../../sidekick-sources.md#open-questions); it also
held two questions raised in review after this list was written (whether a
Sidekick run should hold `sidekick_set_delegation`, and who may read an
admitted email's full text). The owner answered both, and questions 4 and 5
below, on 2026-11-11; the answers are in that document's changelog.

1. Should an agent enrolling a delegate become a request too? (Non-goal 2.)
2. What threshold should a person's filter use? It shares the trigger gate's
   `0.5`, which was measured for the opposite cost: there a missed run is
   worse than a wasted one, and here a wrongly admitted message is worse.
3. Should a source be pinned to the Canvas it was asked for? (Non-goal 5.)
4. Should the emailed page ask for one click before it answers, since a mail
   scanner that runs JavaScript can otherwise answer?
5. Should an agent's ask for the asker's own account stay pending until they
   click, instead of being approved at once?

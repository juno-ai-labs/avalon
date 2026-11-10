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
support thread or usage number is recorded.

Reading the code against the request showed three problems:

1. A delegation grant was one boolean per person. It both let that person's
   events start the Sidekick and lent every tool on every personal connection
   they had. There was no way to share mail on one topic without lending the
   whole account.
2. An agent could enroll another member as a delegate with no act of theirs
   (`sidekick_set_delegation`, a 2026-10-23 decision). So the path to "Jane's
   mail feeds this" was to enroll Jane, silently, for everything.
3. The only filter was the trigger's written condition, which lives on the
   Sidekick's definition. Any manager can edit that, and for a Sidekick a
   Canvas made, everyone in the Canvas is a manager. A filter there is a
   preference, not something Jane agreed to.

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

- **Asking.** In a Canvas's Chat or a Sidekick's conversation a manager asks
  for other people's events to start the Sidekick, optionally about a topic.
  Rally writes the filter, tries it on the manager's own recent events, saves
  the trigger, and asks each person. It says who was asked and that their
  events arrive only after they approve.
- **The card.** The request is a card in that conversation. It says what is
  asked (the Sidekick, the account, the events, the filter in quotes) and
  lists each person with **Approve** and **Decline**. The person asked can
  press theirs. Everyone else sees both as outlines while it waits, and the
  chosen one filled once answered: Approve green, Decline red. A manager's own
  row is already approved.
- **Activity.** The person asked has a row that is its actions. Once answered
  it reads as settled. The manager gets a row saying how each person answered.
- **Email.** The person asked gets an email with **Approve** and **Decline**.
  One click records the answer and shows the result. No sign-in and no second
  click.
- **The Sidekick's panel.** A **Sources** section lists each person, their
  account, what it lets in and their filter, and each request still waiting or
  declined. A person can stop their own. **Delegation** stays beside it and
  says the other thing: who the Sidekick may act as.
- **Approving** adds the person to the Sidekick's readers so they can see what
  their events are used for. The source keeps working if they are later
  removed, until they stop it.
- **A run** started by mail opens with the event and the full text of that one
  message.
- **No delegate.** The Sidekick still runs. A run that needs a personal
  account nobody lent asks for it in the run, where the people who manage the
  Sidekick can answer.
- **Empty, loading, error, offline.** The Sources section says nothing lets
  events in from a person's account when that is so. Actions go through the
  acknowledged error popups. Approving before connecting the account is
  refused with "connect that account first", and the request keeps waiting.

Platforms: macOS and web, which share the renderer. The email page is the
browser's.

## Impact on the product contract

Three clauses of earlier PRDs move.

- Sidekick delegation said a personal event "requires its source owner's
  eligible grant". It now requires that person's source. Delegation no longer
  decides anything about a trigger.
- Sidekick delegation said runnable work with no eligible delegate shows
  "Needs attention: no delegated user is available". Such work now runs as
  the Sidekick itself.
- Sidekicks attached to Canvases said "every write admits the acting person
  again; losing the Canvas stops it". The attachment alone now authorises a
  run's reach into a Canvas. The exception is a run somebody asked for under
  their own access, which is held to what that person can open.

The tool execution policy is unchanged: a source is asked for once, and its
filter then runs on each event without asking anybody.

## Decision log

### 2026-11-10 — Delegation and triggers are split completely

**Decided:** Whose events start a Sidekick is its own record, the source.
Registration, matching and admission read sources and nothing about a trigger
reads delegation.

**Why:** The owner's call, replacing the first proposal of one grant with a
scope field covering both. Two consents a person may want to give separately
should not share a prompt or a record.

**Changes:** Goals 1 and 2. Later work on scoped delegation touches tools
alone.

### 2026-11-10 — The message alone, fetched by the host

**Decided:** A run started by new mail is handed that one message. Not its
thread.

**Why:** The owner's call. The event carries no body, and without this a run
would need the mailbox's tools, which is delegation.

**Changes:** Goal 5; non-goal 3.

### 2026-11-10 — A Sidekick has a base identity; delegates add to it

**Decided:** A run with no delegate acts as the Sidekick itself, with the
Organization's connections and its own reach. The attachment alone authorises
a run's reach into a Canvas.

**Why:** The owner's call: "Delegates should provide extra permissions on top
of a base set of permissions". The alternative was to keep such runs waiting
in Needs input.

**Changes:** Goal 6, and the two contract clauses above.

### 2026-11-10 — Approving adds the person as a reader, and does not depend on it

**Decided:** Approving adds the person to the Sidekick's readers. The source
keeps letting events in if they are removed later.

**Why:** The owner's call. They should be able to see what their events are
used for, and a trigger should not stop because of who can read a page.

**Changes:** Product behavior. A source's eligibility asks for membership
only, where a delegate's also asks for reader access.

### 2026-11-10 — One PR for the split and the base identity

**Decided:** Both ship together.

**Why:** The owner's call, against building the split first and keeping Needs
input for the no-delegate case in between.

**Changes:** Rollout.

### 2026-11-10 — One click in the email decides

**Decided:** The email's Approve and Decline each decide with one click, with
no sign-in and no confirmation.

**Why:** The owner's call, against opening Rally signed in with the choice
highlighted. The cost was stated and accepted: anybody holding the email can
answer for that person until the request is settled.

**Changes:** Goal 4. The link is signed and bound to one request, person and
answer.

### 2026-11-10 — The wizard writes the filter, with a way to try it

**Decided:** A new skill, `setting-up-a-filtered-trigger`, and a tool that
tries a draft filter on real recent events.

**Why:** The owner's call: the wizard should have "latitude and agency to set
up a great prompt". A fixed template would not fit the range of topics, and a
filter nobody tried is a guess.

**Changes:** Agent behavior.

## Data model

`WorkspaceDO` migration 145: `sidekick_sources` (keyed by Sidekick, person and
connection) and `sidekick_source_requests`. A backfill gives every person
whose delegation admitted a configured rule's events a source for exactly
those. [`sidekick-sources.md`](../../sidekick-sources.md) owns both.

## Regional impact

None. Every row is in the Organization's own `WorkspaceDO`. The email link
names its region, as the sign-in link does.

## Security and trust model

- A source lends events and nothing else. A run reads the admitted message
  through the host and holds no tool on that account.
- Only the person asked answers. Who answers comes from their session or the
  signed link, never from a tool argument.
- The filter is a classifier's judgement on a subject, a sender and a
  snippet. It is not a hard boundary: it can let in mail the person would not
  have chosen, and the request's words are what they agreed to, not a
  guarantee.
- The emailed link decides for whoever opens it. Forwarding the email forwards
  the decision.
- A source names a Sidekick. A manager who attaches the Sidekick to another
  Canvas sends admitted events' results there too.
- A run nobody is behind uses the Organization's connections, which were
  usable only with a delegate before. It writes its Sidekick's memory and not
  the Organization's.
- An agent can still enroll a member as a delegate without their act
  (non-goal 2).

## Agent behavior

The durable contracts are in [`sidekick-sources.md`](../../sidekick-sources.md#agent-tools).
In short, the `rally:sidekicks` plugin (wire prefix `sidekick_`) gains three
tools wherever its delegation tools are offered:

- `sidekick_sources_list({ sidekickId })`, `read`.
- `sidekick_request_source({ sidekickId, userIds, connectorType, eventTypes, condition? })`,
  `write`, `record_before_execute`, re-entered on its receipt. It asks and
  never waits; its output is the card.
- `sidekick_test_source_condition({ connectorType, eventType, condition })`,
  `read`. It judges the acting person's own ten most recent events.

No tool answers a request. The skill `setting-up-a-filtered-trigger` is the
procedure. A run with no delegate is told so in a prompt section and asks, in
the run, for someone to let the Sidekick act as them when a step needs it.

Evaluations on the medium fallback model have not been run.

## Rollout

Ships to everyone on merge, with no flag. The migration adds two tables and
rows. Regional Workers deploy before Global; during a deploy a new consumer
calling an older object fails its delivery, which the Queue retries.

## Open questions

1. Should an agent enrolling a delegate become a request too? (Non-goal 2.)
2. What threshold should a person's filter use? It shares the trigger gate's
   `0.5`, which was measured for the opposite cost: there a missed run is
   worse than a wasted one, and here a wrongly admitted message is worse.
3. Should a source be pinned to the Canvas it was asked for? (Non-goal 5.)

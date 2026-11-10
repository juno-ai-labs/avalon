# Sidekick sources

A **source** is one person's permission for events they can see on one
connection to start one Sidekick: "new mail in Jane's Gmail may start the
Deals Sidekick, when it is about a pre-seed round". This document owns the
source record, the request that asks a person for one, the person's own
filter, and the rule that decides whether an arriving event may enter.

It is deliberately not delegation. Until 2026-11-10 one record answered two
questions: whose events may start a Sidekick, and whose accounts its runs may
use. They are now two records with two owners:

| | Source | Delegation |
| --- | --- | --- |
| Says | "these events of mine may start it" | "it may act as me" |
| Reaches | events, pushed in | every tool call on my personal connections |
| Scope | one connection, named event types, an optional condition | everything, one boolean |
| Given by | the person, answering a request | the person, or an agent for them |
| Read by | registration, matching, admission | the run's tool accounts and coordinator |

[`automation-lifecycle.md`](automation-lifecycle.md) owns the Sidekick, its
triggers, its runs and delegation;
[`semantic-activity-triggers.md`](semantic-activity-triggers.md) owns the judge
a written condition is tested with; [`activity.md`](activity.md) and
[`push-notifications.md`](push-notifications.md) own what a request's row and
notice are.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/sidekick-sources.ts` | The source and request records, what a reader is shown of each, and the route inputs. |
| `apps/api/src/durable-objects/sidekick-source-storage.ts` | WorkspaceDO migration 145 (`sidekick_sources`, `sidekick_source_requests`, the backfill from delegation) and the rows' reads and writes. |
| `apps/api/src/durable-objects/hosted-sidekick.ts` | Who may ask, answer, read and withdraw (`requestSources`, `decideSourceRequest`, `readSources`, `withdrawSource`); whether an event may enter (`eventSource`); the saver's own sources (`putOwnSources`); `admitExternalEvent`, which enforces both filters. |
| `apps/api/src/durable-objects/sidekick-source-registrations.ts` | Which connections each configured rule is registered on. |
| `apps/api/src/durable-objects/sidekick-source-notices.ts` | The Activity rows and notices a request writes. |
| `apps/api/src/services/semantic-trigger-admission.ts` | The delivery: asks, judges the source's condition and the trigger's, admits with both verdicts. |
| `apps/api/src/services/sidekick-source-service.ts`, `apps/api/src/routes/automations.ts` | The routes a signed-in person and an agent use. |
| `apps/api/src/services/sidekick-source-tools.ts` | The agent's tools: list, ask, and try a filter. |
| `packages/agent-harness/src/filtered-trigger-skill.ts` | `setting-up-a-filtered-trigger`, the wizard's procedure. |
| `apps/api/src/services/sidekick-event-content.ts`, `packages/connectors/src/types.ts` (`readActivityContent`) | The host's read of what an admitted event is about, and the run's opening with it. |

## How it works

### The record

A source is a row of `sidekick_sources`, keyed by Sidekick, person and
connection. It holds the event types it lets in, an optional written
`condition`, and the membership incarnation it was given under. The connection
is either the person's own, or an Organization connection: the second lets in
the events there that are limited to an audience the person is in (a private
Slack channel on the Organization's install).

A source is **eligible** while its person is an active member in the same
membership incarnation. Leaving and rejoining needs a new one. Reading the
Sidekick is not required, unlike delegation: approving adds the person to the
Sidekick's readers so they can see what their events are used for, and the
source keeps letting events in if they are later removed, until they withdraw
it.

Three things write a source:

| Writer | When | `origin` |
| --- | --- | --- |
| `apply`, through `putOwnSources` | A manager saves a rule on their own connection, or on an Organization connection. Event types are added to what they already let in; a condition they set is kept. | `own_definition` |
| `decideSourceRequest` | The person asked approves. One row per connection of that connector they own then. | `request` |
| Migration 145 | Every person whose delegation admitted a configured rule's events gets a source for exactly those. | `migration` |

### Asking

A manager of the Sidekick asks (`POST /automations/:id/source-requests`, or
the agent tool): the people, a connector, the event types and an optional
condition. Each person gets one `sidekick_source_requests` row. Asking for
one's own connection is approved in the same transaction. Everyone else gets a
`pending` request, an Activity row that is its actions, a push and an email.
An ask still waiting for the same person, Sidekick and connector is cancelled
by a new one, so a person answers what was asked last; asking again for the
same thing answers with the request already waiting.

Only the person asked answers
(`POST /automations/:id/source-requests/:requestId/decision`, or the signed
link in the email). Approving writes their sources and adds them as a reader;
declining writes nothing. An answer already given reads back as it stands.

A request names the conversation it was asked from (`place`), and its card is
drawn there for everyone who can open that conversation: they see who was
asked, for what, and where it stands. Only the person asked can act on it.

### Which connections a rule is registered on

A Sidekick's triggers and their evaluator rules stay in its definition, each
configured on one connection. `sidekickSourceRegistrations` decides where each
rule is registered:

- An **Organization connection** needs nobody: the Sidekick watches it as
  itself.
- A **person's connection** is registered only while its owner holds an
  eligible source for that connection and event type.
- A rule about a **whole account** (no resource) reaches every person's
  connection of that connector whose owner let the event in. That is how one
  "new email" trigger covers two people's mailboxes.
- A rule about a **globally addressed resource** (a Google file) reaches every
  connection that can open it, as before.
- A rule about an **account-relative resource** (a mail thread) stays on its
  own connection.

### Whether an event may enter

`eventSource` answers for one event and one registration, at matching and
again at admission:

- An event the whole Organization can see enters with no source.
- An event limited to an audience (a person's own connection, or a private
  place on an Organization connection) enters only through the eligible source
  of somebody in that audience, for that connection and event type.
- If one such source has no condition the event enters unfiltered. Otherwise
  every such source's condition is returned, and any one of them admits.

### Two filters, two owners

`admitExternalEvent` holds two conditions apart:

- The **source's condition** is the person's. It is their permission: no edit
  to the Sidekick, and no manager, widens it. Changing it takes a new request
  and their answer.
- The **trigger's condition** (`semantic_activity`) is the Sidekick's own
  interest, and any manager can change it.

An event enters only when both hold. The delivery judges the source's
condition first and does not ask the trigger's question of an event the
person's filter kept out. Both are judged by the one JEV question
[`semantic-activity-triggers.md`](semantic-activity-triggers.md) owns, on the
event's title, summary and snippet.

### What a run is handed

A connector event carries a title, a summary and a snippet. For new mail the
snippet is a line or two, and a run that has to say what a message said would
otherwise read it with the mailbox's tools, which only a delegate lends. So
the host reads it.

When a run is provisioned, `runProvisioning` names the event that started it
and its connection (`eventContent`), after checking again that a person's
connection still has its owner's eligible source for that event type. The
provisioning consumer then calls the connector's `readActivityContent` with
that connection's credential and adds the result to the run's opening
(`openingWithEventContent`). Google implements it for `email.received`: that
one message's headers, text and attachment names. Never its thread, and never
a search. Content that cannot be read leaves the run its event and a line
saying why; it never blocks the run. A source taken back between admission and
provisioning hands the run the event's summary and nothing more.

The run holds no tool on that account. Its instructions are written for what
it receives, which the skill below says.

### Agent tools

The `rally:sidekicks` plugin (model id `rally_sidekicks`, wire prefix
`sidekick_`) offers three tools wherever it offers its delegation tools: a
Sidekick's wizard, any conversation a person is working in, and a run's
background workers. Loading the plugin starts nothing.

| Wire name | Mode | Input | Output |
| --- | --- | --- | --- |
| `sidekick_sources_list` | `read`, `safe` | `{ sidekickId }` | `{ sidekickId, sources: [{ userId, name, account, connectorType, eventTypes, condition, available }], requests: [{ requestId, userId, name, connectorType, eventTypes, condition, state, requestedByName }] }` |
| `sidekick_request_source` | `write`, `record_before_execute`, serial, re-entered on its receipt | `{ sidekickId, userIds, connectorType, eventTypes, condition? }` | The route's `SidekickSourceRequestResult`: `{ sidekickId, requests: [...] }`, each request with its `state`. The client draws this output as the card. |
| `sidekick_test_source_condition` | `read`, `safe` | `{ connectorType, eventType, condition }` | `{ judged, condition, letIn, total, events: [{ title, summary, snippet, occurredAt, letIn, verdict, confidence }] }` |

- **Where ids come from.** `sidekickId` from the conversation's Sidekick or
  the Sidekick tools; `userIds` from people search; `connectorType` and
  `eventTypes` from inspecting the connector's declared events, as a trigger
  names them.
- **Asking never waits.** `sidekick_request_source` returns each request as
  it stands: `approved` for the acting person's own account, `pending` for
  everyone else. The host derives the card's place from the loop: a Canvas's
  Chat or a Sidekick's shared conversation, and none from a run. A retried
  call carries its receipt as `operationId`, and the object answers with the
  requests that receipt already made, whatever has been answered since.
- **No tool answers.** There is no approve or decline tool, by design.
- **Trying a filter** judges the acting person's own ten most recent events of
  that type with the production judge. It reads nobody else's events. With no
  classifier configured it answers `judged: false`.
- **Refusals** carry a code and a sentence: `sidekick_source_request_requires_manager`,
  `sidekick_source_person_unavailable`, `sidekick_source_connector_unknown`,
  `sidekick_source_event_unknown` (which names the event type), and
  `sidekick_source_connection_missing` when the acting person asks for their
  own account and has none connected.

The skill `setting-up-a-filtered-trigger` is the procedure: settle who and
what, write the filter as a claim about one event, try it, save the trigger
and ask, and write the run's instructions for the one message it receives. It
gives the model the facts a good filter needs (what one event carries, how it
is judged, that the person reads and approves the same words) and leaves the
wording to it.

## Invariants

- **Nothing about a trigger reads `sidekick_delegations`.** Registration,
  matching and admission read sources. A delegate whose source was withdrawn
  feeds nothing; a person with a source and no delegation lends no account.
- **A filtered event without an admitting verdict does not start a run.** The
  enforcement is in `admitExternalEvent`, so a delivery path cannot skip it by
  not asking.
- **Only the person asked answers a request**, and only their own act gives a
  source. `decideSourceRequest` takes who answers from the caller's session or
  signed link, never from a tool argument.
- **A source's condition changes only through a request the person approves.**
  `putOwnSources` keeps an existing condition; nothing else writes one.
- **Withdrawing needs no access.** A person ends their own source whatever
  they can still read.
- **The host reads a person's content only while their source lets the event
  in.** `runEventContent` checks at provisioning, not only at admission.

## Boundary

**Owns:** the source and request records, eligibility, the entry rule, and the
source's condition.

**Deliberately does not:**

- lend accounts. A run reads a source's events and nothing else of that
  person's. Their personal connections are a delegate's to lend.
- decide who a run acts as. That is delegation's, and may be nobody.
- hold the trigger. The rule stays in the definition; a source only extends
  where it is registered.

## Failure modes and limits

| Situation | What happens |
| --- | --- |
| A rule's connection has no eligible source | Not registered. The Sidekick's attention reads `event_no_eligible_delegate` (the stored code predates this split) until a source covers it. |
| The person approves with no connection of that connector | Refused `sidekick_source_connection_missing`; the request keeps waiting. |
| The source's condition is not met, or cannot be judged | Refused `sidekick_source_condition_not_met`, `_not_judgeable`, `_confidence_below_threshold` or `_classifier_unavailable`. No run and no retry. |
| The person leaves the Organization | Their sources stop being eligible; the next reconciliation removes their registrations. |

- **The condition is judged on subject, sender and snippet**, not the body.
  A message whose topic appears only in its body is kept out.
- **The threshold is the trigger gate's**, `0.5`, measured for a cost model in
  which a missed run is worse than a wasted one. For a permission the costly
  error is the opposite one. The number is the team's to set from a
  measurement; none has been made.
- **A source names a Sidekick, not a Canvas.** A manager who attaches the
  Sidekick to another Canvas sends admitted events' results there too.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test-workers/sidekick-sources.test.ts` | Real workerd. A person's mail starts a Sidekick through their source whether or not they are a delegate, and stops when the source is taken back while they stay a delegate; an event matched before a withdrawal is refused at admission; only the person asked answers and only a manager asks; a filtered source refuses without a verdict and with a refusing one, and an unfiltered one needs none; saving a definition keeps a person's own filter; a repeated ask answers with what it already asked; a run with no delegate starts as the Sidekick itself and only a manager continues it; content is withheld once the source is gone. |
| `apps/api/test/workspace-sidekick-sources-migration.test.ts` | Migration 145's backfill over the real migration chain: a delegate gets a source for each connection of theirs a rule is configured or registered on, every delegate gets one on a configured Organization connection, and a withdrawn grant, a grant with no membership and a person with no grant get none. |
| `packages/connectors/src/index.test.ts` | Google's `readActivityContent`: one message for new mail, by one request, and nothing for a label change, a subject with no message, a missing message, or a connection that may not read mail. |
| `apps/api/test/sidekick-event-content.test.ts` | The opening with content, cut content, no content, and unreadable content. |

The workerd file was proved against these breaks, one behavior each:
registration without the source check, `eventSource` admitting everything, the
asked-person check removed, the source verdict check removed, `putOwnSources`
clearing the condition, the operation lookup removed, a null coordinator
admitted as Needs input, the manager check removed, and `runEventContent`
skipping the source. The migration file was proved by letting a withdrawn
grant through.

## Changelog

### 2026-11-10 — A source is its own record, apart from delegation

**What changed:** `sidekick_sources` and `sidekick_source_requests` (WorkspaceDO
migration 145). Registration, matching and admission read sources and no
longer read delegation. A source carries event types and an optional written
condition, judged in the delivery beside the trigger's own. A manager asks a
person for a source and only that person answers.

**Why:** One boolean per person answered both "whose events start this" and
"whose accounts may it use". Asking a colleague to feed a shared dashboard
with their mail on one topic meant enrolling them as a delegate, which lent a
run every tool on every personal connection they had, and an agent could do
that enrolling for them. The owner asked for the two to be split completely.

**Considered and rejected:** One grant with a scope field covering both events
and tools. It was the first proposal, and it keeps one consent prompt for two
different things a person may want to give separately. Also rejected: putting
the person's condition on the Sidekick's trigger. Any manager edits a
definition, and for a Sidekick a Canvas made that is everyone in the Canvas,
so a condition there is a preference and not a permission.

**What a future change has to respect:** the two records answer different
questions and nothing may read one for the other. The person's condition lives
on their source and moves only by their own answer.

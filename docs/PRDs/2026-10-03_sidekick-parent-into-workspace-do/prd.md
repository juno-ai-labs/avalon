# Sidekick parents move into WorkspaceDO

> Created 2026-10-03.
>
> Every Sidekick's parent state moves out of its own `SidekickDO` and into the
> Organization's `WorkspaceDO` as a third hosted parent role, beside Channels
> and Spaces, and the `SidekickDO` class is deleted. Run conversations stay
> `SubstreamAgent`s. Hop, table and caller inventory: [`design.md`](design.md).
> State: [`state.md`](state.md).
> Standing contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [hosted conversation parents](../../hosted-conversation-parents.md),
> which this PRD repeats for a third kind,
> [the automation lifecycle](../../automation-lifecycle.md),
> [Durable Object alarms](../../durable-object-alarms.md) and
> [choosing a Queue or RPC](../../choosing-queues-or-rpc.md).

## Summary

A Sidekick is one object today and its Organization is another, and nearly
every Sidekick request crosses between them. After this change a Sidekick's
definition, revisions, schedules, runs, inbound-email receipts and parent
contract live in `WorkspaceDO`, keyed by Sidekick id, in the same SQLite
database as the Channel it lives in, the people who may see it, the connector
registrations it owns and the sidebar row that shows it. The `SidekickDO` class
and every object in its namespace are deleted once every Organization has
imported its Sidekicks.

Nothing about what a Sidekick does changes. What a person notices is that
opening a Sidekick, its library and its detail answers from one warm object
instead of three or four calls, that the rail and the detail screen can no
longer disagree about whether a Sidekick is available, and that a published
Sidekick can no longer sit "active" with its connector registrations missing.
For engineers, Rally loses its second implementation of the conversation-parent
contract, its last `parent_kind` branch in routing, and the projection, fences
and outbox legs that exist only to copy Sidekick facts into the Organization.

## Motivation

On 2026-09-25 Channel and Space parents moved into `WorkspaceDO`
([hosted conversation parents, changelog 2026-09-25](../../hosted-conversation-parents.md)).
Its reasons were that the parent objects' facts "either came from the
Organization or [were] copied back into it", that every conversation request
paid two sequential parent calls against a cold object, that sidebar state took
two Queue hops, and that cross-object changes needed fences and sagas. That
document then says only "`SidekickDO` is also unchanged; it keeps its own
parent object", with no reason recorded. The external-conversation-bindings
design names the move as "a named follow-up of the hosted-parent change"
([design.md, Run continuation](../2026-09-23_external-conversation-bindings/design.md#run-continuation)).
Every one of the reasons applies to Sidekicks, and the split has cost us
directly:

1. **Publishing can leave a Sidekick active with nothing registered.** `apply`
   writes the definition in `SidekickDO`, then calls
   `WorkspaceDO.applyExternalEventRegistrations` over RPC. Fireflies
   registrations were refused on the far side of that hop and the alarm retried
   forever while the Sidekick showed as published; the `ZodError` that said why
   did not survive the hop
   ([automation-lifecycle.md](../../automation-lifecycle.md), lines 1356 to
   1469). The document still records the "published but registrations missing"
   state as "still true, and is not fixed here". `applied_effects_revision`
   and `registration_generation` exist only to repair this seam.
2. **The rail and the detail screen disagree.** The sidebar and Channel rail
   read `automation_directory`, a copy of the Sidekick row that arrives over two
   Queue legs (`SidekickDO` outbox, `ACTIVITY_QUEUE`, `applyAutomationDirectory`).
   The rail can show a Sidekick as available while its REST summary does not,
   because the copy "cannot see a Sidekick's accepted revision or its owning
   room's archive"; `run_as_user_id` stays null until the next publish, and
   `SidekickDO` migration 10 exists only to force a republish. Every new rail
   field must be added to the row, the projection and the trigger lists, and
   the audience predicate drifted between the two copies inside one pull
   request before `sidekick-audience.ts` was shared.
3. **Opening a Sidekick costs three or four calls.** The Worker asks
   `WorkspaceDO.resolveHostedParent`, misses, asks `SidekickDO.authority`, then
   `SidekickDO.authorizeViewer`, which itself calls `WorkspaceDO` for
   `authorizeViewer`, `readManagementAccess` and `workstreamParticipant`. Every
   management call in `AutomationService.actorRequest` first asks `WorkspaceDO`
   for `automationOwner` and `readManagementAccess` and passes the answer in.
   The library list measured a median of about one second and "checked access
   twice". This is the pattern the Channel move removed, and low latency of
   opening resources is a stated goal of the product.
4. **Cross-object writes are not atomic.** Archiving a room fans out
   `setOwningRoomArchived` to each owned Sidekick "best effort per automation".
   Removing a recommendation is "two object removals [that] remain idempotent,
   not a cross-object transaction". Create once committed a row and skipped
   provisioning on replay, leaving a conversation that could not be opened.
   Deleting an already-deleted Sidekick re-enqueues its directory row to clean
   up after a lost Queue message. `stop_generation` exists because a reopening
   projection "travels the Queue and lands after the continued execution has
   started".
5. **Revocation and retirement pay per Sidekick.** A membership revocation sends
   one `automation` hop per Sidekick in the Organization, most of which do
   nothing; a revoked Channel grant needs an outbox leg to reach owned
   Sidekicks, and per-descendant acknowledgment is recorded as unfinished
   ([access-revocation.md](../../access-revocation.md)). Retirement,
   migration tracking and the engineering MCP each carry a Sidekick-specific
   class, node kind or tool.
6. **We maintain the parent contract twice.** `ConversationParentDurableObject`
   has exactly one subclass left, `SidekickDO`. `HostedParent` is described as
   the port of the same contract. Every fix to `authorizeViewer`,
   `reserveChild`, `receiveChildEffects` or `listChildren` lands twice or
   drifts.

The work in flight makes this more pressing, not less. The
[delivery-reliability PRD](../2026-09-11_sidekick-delivery-reliability/prd.md)
adds a `deliveries` table to `SidekickDO` and projects `paused_by` and
`last_run_error_code` onto `automation_directory`, so each new Sidekick feature
adds another field to copy and another leg to keep consistent.

The parent state is small. Measured in production on 2026-10-03, the busiest
Organization (Juno Labs) has 17 Sidekicks in every lifecycle. Its busiest by
volume, a GitHub pull-request Sidekick, holds 209 runs from eight days at about
7.8 KB each, 7 revisions and 210 children; its busiest by count, a 10-minute
schedule, holds 432 runs from three days at about 120 bytes each. The rest of
what that Organization's `WorkspaceDO` stores is described below under
[Key design decisions](#key-design-decisions).

## Goals

1. A Sidekick's definition, revisions, schedules, runs, inbound-email receipts,
   children and outbox live in the Organization's `WorkspaceDO`, and no
   Sidekick fact is copied from one object into another.
2. Publishing a Sidekick commits its definition, its schedules and its
   connector registrations in one transaction: a Sidekick is never active with
   its registrations missing, and never has registrations while it is not
   active.
3. The rail, sidebar and Sidekick detail read the same row, so they cannot
   disagree about a Sidekick's availability, appearance, run-as person or home.
4. Opening a Sidekick conversation, the Sidekick library and the Sidekick
   detail each cost one call to `WorkspaceDO` from the Worker.
5. Archiving a room pauses its Sidekicks, and removing a recommendation removes
   it, in the same transaction as the change that caused it.
6. Rally has one implementation of the conversation-parent contract.
   `ConversationParentDurableObject` and `conversationParentStub`'s
   `automation` branch are deleted.
7. Every existing Sidekick keeps its id, its conversations, its run history and
   its next scheduled run, and no scheduled or event-triggered occurrence is
   dropped or run twice by the move.
8. The `SidekickDO` class is deleted, and with it `run_sidekick_sql`, the
   Sidekick migration-tracker class, and the Sidekick node kind in retirement.

## Non-goals

1. **Run conversations do not move.** Every Sidekick's authoring chat
   (substream `0`) and every run stays its own `SubstreamAgent`. A transcript
   and an agent loop are a real concurrency and size boundary, which is what
   the small-object design was for. Rejected outright.
2. **No model call runs in `WorkspaceDO`.** The semantic trigger classifier
   stays in the Worker between `externalEventAdmissionPlan` and
   `admitExternalEvent`, as
   [semantic-activity-triggers.md](../../semantic-activity-triggers.md)
   requires. Rejected outright.
3. **No wire or identifier rename.** The parent kind stays `"automation"` on
   the wire and in every `SubstreamAgent` identity, `AutomationId` stays, the
   Global `workstream_email_routes.automation_subscription_id` column stays, and
   run conversation names (`conversationObjectName`) do not change, since a
   rename would orphan every existing run object. The new tables take the
   product's name, as the Channel move did. Deferred to the rebrand inventory.
4. **No change to what a Sidekick does.** Triggers, scopes, homes, attachments,
   drafting, apply, pause, run-now, delivery and the Sidekick surfaces in the
   client behave as they do today. Rejected for this PRD; product changes ride
   their own PRDs.
5. **No new retention for run history.** `runs`, revisions and email receipts
   are imported whole and keep growing as they do today. The arithmetic under
   Key design decisions says they fit; a retention policy is a separate,
   reversible decision if that changes. Deferred.
6. **No client changes.** `SidekickDO` holds no sockets, and the Sidekick row
   already reaches clients on the workspace socket. macOS, web and iOS are
   untouched. Rejected as unnecessary.
7. **No zero-downtime dual write.** Each Sidekick is frozen for the length of
   its import, as each Channel was. Rejected, for the reason the Channel move
   gave: a per-parent export is cheaper to build and to verify.
8. **The reaction ticker, artifact host and other per-thing objects stay.**
   This PRD is about conversation parents. Out of scope.

## Product behavior

This is a backend change. No screen, control or string changes, on any
platform. What changes is when and how fast existing surfaces answer:

- **Opening a Sidekick** from the sidebar or a Channel's rail: the Worker makes
  one `WorkspaceDO` call that resolves the parent, authorizes the viewer and
  returns authority, then seats the reader on the conversation. Today it makes
  up to four sequential calls, the first of which misses.
- **The Sidekick library and detail** read the Sidekick's own row and its last
  runs from `WorkspaceDO` in one call, with access checked once.
- **The rail** shows exactly what the detail shows. A Sidekick whose accepted
  revision is missing or whose room is archived is unavailable in both places
  at once. Appearance, run-as person and home show on the next socket frame
  after the write commits, not after a Queue round trip.
- **Publishing** either commits the definition, schedules and registrations
  together, or fails and leaves the previous revision active. The drafting
  conversation sees that failure with the field it rejected, per
  [naming a schema failure](../../naming-a-schema-failure.md); there is no
  "published, registering" state for it to report.
- **Archiving a room** shows its Sidekicks as paused by the archive in the same
  socket frame that shows the room archived.

States:

| State | Behavior |
| --- | --- |
| Sidekick not yet imported | The first request for it imports it, then answers. A person sees the first open take as long as one import (one export RPC per page and one transaction). |
| Import fails | The request fails with the import's code, named per [naming a schema failure](../../naming-a-schema-failure.md). The Sidekick stays in its legacy object, frozen, and its runs do not fire until an operator repairs and retries it. This is the failure we will notice: the alarm reports it to ops on its third attempt without progress. |
| Organization object unavailable | Sidekicks cannot be opened, listed, changed or fired, along with every Channel and Space. This is already true of the rail and sidebar today. |
| Offline client | Unchanged. |

## Impact on the product contract

None. This refines where state lives within the existing contract. A Sidekick
remains a conversation parent whose runs are conversations, and nothing about
viewing, participation or what the agent may do moves.

## Decision log

None yet.

## Key design decisions

1. **A Sidekick is a third `HostedParent` role, not a new subsystem.** It joins
   `HOSTED_CHANNEL_ROLE` and `HOSTED_SPACE_ROLE` as `HOSTED_SIDEKICK_ROLE` with
   `kind: "automation"`, and its parent state uses the existing `parent_*`
   tables under `parent_id = automationId`: `parent_children`,
   `parent_outbox`, `parent_child_receipts` and the rest. The Sidekick-only
   state (the definition row, revisions, schedules, runs, email receipts) goes
   in new tables that each lead with `sidekick_id`, under the same invariant:
   every statement names it. `WorkspaceDO`'s facade already dispatches every
   parent method by reading the kind from `parent_metadata`; this adds one
   role. This is the platform answer: one parent primitive with roles, rather
   than one per product noun. Rejected: a separate `SidekickHost` beside
   `HostedParent`, which would keep two implementations of the contract, the
   problem this PRD exists to remove.

2. **The definition row is the directory row.** `automation_directory` is
   replaced by `sidekicks`, which holds what `SidekickDO`'s single `automation`
   row holds plus the directory's own columns (`next_run_at`). The rail, the
   sidebar, the search keys, the retirement graph and the engineering MCP read
   it directly. The `directory_automation` effect, `applyAutomationDirectory`,
   its `source_version` and `payload_hash` fence, and
   `registration_generation` are deleted. Rejected: keeping
   `automation_directory` as an in-transaction projection of the new row. It
   removes the Queue legs but keeps two copies of each field, which is how the
   audience predicate drifted.

3. **Connector registrations commit with the definition.** `apply` writes the
   accepted revision, replaces `sidekick_schedules`, arms their alarm entries
   and writes `workspace_external_event_registrations` in one
   `parentWrite` transaction. A registration that fails validation fails the
   publish with its field named. `applied_effects_revision`, the
   `sidekick_publication` alarm kind that replays the tail, and the
   `external_registration_generations` rows for Sidekick destinations are
   deleted. Rejected: keeping the tail as a `parent_outbox` row so publish
   succeeds even when a registration is refused. That is the current failure
   mode moved inside one object.

4. **Authorization is one function over local tables.** `authorizeViewer`,
   `assertManager` and the library's audience check read the Organization's
   relationship table, Channel and Breakout membership and the `sidekicks` row
   in one place, through the shared `sidekickAudienceAllows`. The Worker stops
   precomputing `participantOfOwningWorkstream` and stops calling
   `automationOwner` and `readManagementAccess` before each Sidekick method.
   `listSidekickDirectoryForAuthorizedMember` gains the `run_as` check it lacks
   today by using the same function.

5. **Alarms keep their per-Sidekick independence.** The 2026-08-25 lifecycle
   PRD moved automation scheduling out of `WorkspaceDO` because "each
   automation has an independent lifecycle, trigger stream, compiler history,
   and run-idempotency domain", and holding them together "enlarges the
   workspace-wide failure and serialization boundary"
   ([prd.md, Motivation 5](../2026-08-25_durable-automation-lifecycle/prd.md)).
   That argument was sound against what existed then: a workspace scheduler
   with no per-entry failure isolation, and automation state split between the
   workspace and hidden work streams. Two things have changed since. The shared
   `_internal_durable_alarms` list (2026-08-28) gives every stored entry its own
   backoff, so one Sidekick's failing schedule does not hold another's, and the
   Channel move showed a hosted parent can keep its own transactions inside the
   Organization object. So `automation_schedule` and `automation_run` become
   stored `WorkspaceDO` entries keyed by `<sidekickId>:<scheduleId>` and
   `<sidekickId>:<runId>`, and the Sidekick outbox drains through the
   existing `parent_outbox` lane. Each run's idempotency stays per Sidekick:
   `sidekick_runs.occurrence_key` is unique per `sidekick_id`.

6. **Run provisioning stays out of the transaction and off the request path.**
   `provisionRun` bootstraps the child `SubstreamAgent`, appends its opening
   message, admits the harness run and activates its loop: four RPCs to the
   child. It runs from the `WorkspaceDO` alarm entry with no transaction open,
   so the Organization object serves other requests while it waits, and
   records the outcome in one write afterwards. This respects the Channel
   move's consequence that "the Organization object now answers every Channel
   viewer check, so its handlers have to stay short".

7. **The serialization cost is affordable, by arithmetic.** A Durable Object
   serves about 1,000 requests a second
   ([choosing a Queue or RPC](../../choosing-queues-or-rpc.md)). The busiest
   Organization's Sidekicks admit on the order of 200 runs a day today; each run
   adds a handful of short parent calls (admission, `continueRun`,
   `readRunState` per provider write, child effects), so a few thousand calls a
   day against a budget of tens of millions. The Sidekick calls removed by
   this change (the `WorkspaceDO` calls that `SidekickDO.authorizeViewer` and
   `actorRequest` already make) offset part of what is added. The
   `WorkspaceDO` alarm, which woke about 1,500 times an hour in that
   Organization on 2026-09-28, gains at most one wake per due Sidekick entry.

8. **The storage cost is affordable, by arithmetic.** The pull-request
   Sidekick adds about 26 runs a day at about 7.8 KB, about 75 MB a year; the
   10-minute schedule adds about 145 small runs a day, under 20 MB a year at a
   generous 300 bytes a row. All 17 of that Organization's Sidekicks together
   are well under 1 GB a year, against a 10 GB object that holds about 3.3 GB of
   connector events at steady state. Child-effect receipts (about 8 per run) are
   not imported and age out of `parent_child_receipts` at its existing 180-day
   retention. A full object refuses every write, including every Channel's, so
   this budget is owned by
   [hosted-conversation-parents.md](../../hosted-conversation-parents.md#performance-and-cost)
   and this change adds a line to it there.

9. **Import on touch, then by alarm, with the Sidekick frozen.** This repeats
   the Channel move's mechanism exactly
   ([How the parents moved](../../hosted-conversation-parents.md#how-the-parents-moved)).
   A `WorkspaceDO` migration seeds `sidekick_imports` with one `pending` row
   per `automation_directory` row. The legacy object gains one method, an
   export that freezes the object on its first page, clears its native alarm
   and returns its rows and its alarm entries a page at a time. `WorkspaceDO`
   inserts each page, and the last page's transaction re-arms the alarm entries
   at their exported due instants and marks the import done. A request for a
   Sidekick imports it first; the alarm imports the rest. A frozen legacy
   object answers every other method with `sidekick_parent_moved`, which a
   Queue consumer treats as retryable so that a message routed by an older
   Worker during deploy is delivered again to the new route. Because run
   occurrence keys are imported with their uniqueness, an occurrence that was
   due during the freeze fires once, on import. Rejected: one RPC for the whole
   export, as Channels did. A year of the pull-request Sidekick's runs would be
   about 68 MB, over the platform's 32 MiB RPC message limit; paging costs one
   cursor.

10. **Children do not change.** A run `SubstreamAgent` keeps
    `{ kind: "automation", id }` as its parent identity. Only routing changes:
    `conversationParentStub` returns the Organization's `WorkspaceDO` for every
    kind, and `receiveChildEffects` stops refusing `automation` envelopes with
    `conversation_effect_parent_kind_unhosted`. The child-to-parent
    `conversation_effect` Queue leg stays: the Queue is still the durable
    handoff out of a `SubstreamAgent`.

11. **Every `SidekickDO` call into `WorkspaceDO` becomes local.** Today
    `SidekickDO` calls `authorizeViewer`, `readManagementAccess`,
    `workstreamParticipant` and `applyExternalEventRegistrations` on the
    Organization's stub. Moved verbatim, each would be a self-call, which the
    self-RPC guard throws on in development and test and which once took a
    work stream down through the subrequest depth limit
    ([the self-RPC audit](../../durable-object-self-rpc-audit-2026-08-22.md)).
    Each becomes a direct read inside the hosted parent. The same goes for the
    other direction: `WorkspaceDO`'s call to `setOwningRoomArchived` becomes a
    write in the archive's own transaction.

## Data model

New `WorkspaceDO` tables, one migration, sketch level. Every primary key leads
with `sidekick_id`; the authoritative record will be the migration and
[`data-model.md`](../../data-model.md).

| New table | From | Notes |
| --- | --- | --- |
| `sidekicks` | `SidekickDO.automation` and `WorkspaceDO.automation_directory` | One row per Sidekick. Replaces both. Drops `registration_generation`, `applied_effects_revision` and the directory fence columns. |
| `sidekick_revisions` | `definition_revisions` | Immutable, as today. |
| `sidekick_schedules` | `schedules` | Replaced whole on apply, as today. |
| `sidekick_runs` | `runs` | `UNIQUE (sidekick_id, occurrence_key)`, `UNIQUE (harness_run_id)`. History index on `(sidekick_id, created_at DESC, run_id)`. |
| `sidekick_email_receipts` | `inbound_email_receipts` | Keyed by Resend id. |
| `sidekick_imports` | none | The import ledger. Dropped by a later migration once every Organization has imported. |
| `parent_*` rows with `parent_id = sidekick_id` | `conversation_children`, `substream_directory`, `substream_user_directory`, `projection_keys`, `workstream_state_clock`, `workstream_state_changes`, `durable_outbox` | The existing hosted-parent tables. `child_effect_receipts` is not imported. |
| `parent_metadata` row with kind `automation` | none | How the facade finds the role. |

`sidekick_conversation_attachments`, `parent_sidekicks`,
`channel_sidekick_attachments`, Space `space_defaults` of kind `sidekick` and
`workspace_external_event_registrations` already live in `WorkspaceDO` and are
unchanged, except that the code writing them now writes them in the same
transaction as the Sidekick change that causes them.

If the delivery-reliability PRD's `deliveries` table has landed in
`SidekickDO` before this ships, it becomes `sidekick_deliveries` and is
imported like `runs`; see [Open questions](#open-questions).

## Regional impact

None in placement. A Sidekick's object is already named
`<region>:<workspaceId>:automation:<automationId>` in the same regional
jurisdiction as its Organization's `<region>:<workspaceId>`, so the move is a
data move inside one region, not a relocation
([regionalization.md](../../regionalization.md)). The only cross-region hop a
Sidekick makes, the inbound-email reservation in Global
`workstream_email_routes`, is keyed by Sidekick id and is unchanged; the
regional handler addresses `WorkspaceDO` instead of `SidekickDO`.

## Security and trust model

- **Authorization narrows to one implementation.** Today a Sidekick viewer
  check is computed partly in the Worker, partly in `SidekickDO` and partly in
  `WorkspaceDO`, and the library check misses `run_as`. After the move one
  function decides, over the tables that hold the facts.
- **A hosted statement without its key reads every Sidekick.** The new tables
  inherit the hosted-parent invariant that every statement names its parent
  id. The review rule in
  [durable-object-sqlite.md](../../durable-object-sqlite.md) applies to every
  statement this change writes.
- **Operator SQL widens slightly.** `run_sidekick_sql` is removed; an operator
  inspects a Sidekick with `run_workspace_sql`, which already reaches every
  Channel and Space in the Organization. The engineering MCP's existence
  pre-check for Sidekicks, which kept a work-stream id from creating an empty
  `SidekickDO`, is no longer needed: there is no namespace to create one in.
- **Revocation gets simpler and stricter.** A membership revocation no longer
  sends one `automation` hop per Sidekick; the workspace hop lists every
  Sidekick's children locally. A revoked Channel grant reaches owned Sidekicks
  in its own transaction instead of through an outbox leg, closing the
  per-descendant acknowledgment gap for Sidekicks.

## Rollout

Ships to everybody on merge, with no flag: nothing here is visible as a
feature, and a flag would mean running both parent implementations side by
side, which is the thing being removed. Like the Channel move, it ships only at
100% and rolls back only forward.

1. **Hosted Sidekick parent and import.** One change adds the
   `HOSTED_SIDEKICK_ROLE`, the new tables and the import ledger; routes every
   Sidekick caller to `WorkspaceDO`; reduces `SidekickDO` to its migration
   ledger and the export; and deletes the directory projection, the publication
   tail, `ConversationParentDurableObject` and the `automation` branch of
   `conversationParentStub`. Sidekicks import on first touch and by alarm from
   this deploy on.
2. **Gate.** An operator checks every Organization with `run_workspace_sql`:
   schema at or past the import migration, and no `pending` row in
   `sidekick_imports` other than in retired Organizations. This is the same
   runbook check the `v12` deletion used. A `pending` row with a code is
   repaired and retried before going on.
3. **Delete the class.** The next wrangler tag deletes `SidekickDO`, a later
   `WorkspaceDO` migration drops `sidekick_imports`, and the same change
   removes `run_sidekick_sql`, the Sidekick class from the migration tracker's
   `REPORTING_CLASSES` and dispatcher, the Sidekick node kind and gate in
   retirement, and the `AUTOMATION_DOS` binding. **This step cannot be
   undone**: it destroys every legacy object and its storage, and a build from
   before it can no longer be deployed.

Turning it off: before step 3, a defect is fixed forward; the legacy objects
are frozen but intact, so a Sidekick whose import is wrong can be repaired by
an operator and imported again. After step 3 there is nothing to turn off.

## Acceptance

- A real-workerd test in `apps/api/test-workers/` imports a frozen
  `SidekickDO` holding a definition, two revisions, a schedule due during the
  freeze, a pending run and an outbox row, and shows the schedule fires once,
  the run provisions once, and the outbox drains once. Broken by skipping the
  re-arm, it fails.
- Publishing a Sidekick whose registration is refused leaves the previous
  revision active, no schedules armed and no registrations written, and the
  error names the rejected field.
- Opening a Sidekick conversation from the desktop client makes one
  `WorkspaceDO` call before seating the reader (checked in the Worker's logs).
- Archiving a room shows its Sidekicks paused in the same workspace-socket
  frame, checked in a real window per
  [verifying visible changes](../../../CLAUDE.md).
- A revoked member loses every Sidekick run feed socket without one
  `automation` hop per Sidekick.
- After step 3, `wrangler.global.jsonc` has no `SidekickDO`, and the migration
  tracker, retirement and the engineering MCP have no Sidekick class, node kind
  or tool.

## Open questions

1. **Sequencing with the delivery-reliability PRD.** It is in progress and adds
   a `deliveries` table and two projected columns to `SidekickDO` and
   `automation_directory`. Building its remaining steps after phase 1 means it
   lands directly in `sidekicks` and `sidekick_deliveries` with no projection;
   building them first means one more table to import and two columns to
   delete. Recommendation: land phase 1 first and rebase that PRD's remaining
   work onto it. Blocks only that PRD's ordering, not this build.
2. **Export page size.** The export pages to stay under the platform's 32 MiB
   RPC message limit. The page size is a number for the team to set, not for
   the implementer to guess; it does not block the design.

# Sidekick parents move into WorkspaceDO

> Created 2026-10-03.
>
> Every Sidekick's parent state moves out of its own `SidekickDO` and into the
> Organization's `WorkspaceDO` as a third hosted parent role, beside Channels
> and Spaces, and the `SidekickDO` class is deleted. Run conversations stay
> `SubstreamAgent`s. Hop, table, caller and test inventory: [`design.md`](design.md).
> Build plan: [`plan.md`](plan.md).
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
database as the Channel or Breakout it lives in, the people who may see it, the
connector registrations it owns and the sidebar row that shows it. The
`SidekickDO` class and every object in its namespace are deleted once every
Organization has imported its Sidekicks.

Nothing about what a Sidekick does changes. What a person notices is that
opening a Sidekick, its library and its detail answers from one warm object
instead of three or four calls, that the rail and the detail screen can no
longer disagree about whether a Sidekick is available, and that a published
Sidekick can no longer sit "active" with its connector registrations missing.
For engineers, Rally loses its second implementation of the conversation-parent
contract, its `automation` branches in parent routing, and the projection,
fences and outbox legs that exist only to copy Sidekick facts into the
Organization.

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
   did not survive the hop ([automation-lifecycle.md](../../automation-lifecycle.md),
   the 2026-09-14 changelog entry on a publication that cannot parse). That
   entry still records the "published but registrations missing" state as
   "still true, and is not fixed here". `applied_effects_revision` and
   `registration_generation` exist only to repair this seam.
2. **The rail and the detail screen disagree.** The sidebar and Channel rail
   read `automation_directory`, a copy of the Sidekick row that arrives over two
   Queue legs. The rail can show a Sidekick as available while its REST summary
   does not, because the copy "cannot see a Sidekick's accepted revision or its
   owning room's archive"; `run_as_user_id` stays null until the next publish,
   and `SidekickDO` migration 10 exists only to force a republish. Every new
   rail field must be added to the row, the projection and the trigger lists.
3. **Opening a Sidekick costs three or four calls**, where opening a Channel
   costs one. The library list measured a median of about one second and
   "checked access twice". The calls are listed in
   [`design.md`](design.md#hops-between-the-two-objects-today). Low latency of
   opening resources is a stated goal of the product.
4. **Cross-object writes are not atomic.** Archiving a Channel fans out
   `setOwningRoomArchived` to each owned Sidekick "best effort per automation".
   Removing a recommendation is "two object removals [that] remain idempotent,
   not a cross-object transaction". Create once committed a row and skipped
   provisioning on replay, leaving a conversation that could not be opened.
   Deleting an already-deleted Sidekick re-enqueues its directory row to clean
   up after a lost Queue message. `stop_generation` exists because a reopening
   projection "travels the Queue and lands after the continued execution has
   started".
5. **Access is decided in three places, and they disagree.** The Worker, the
   `SidekickDO` and the `WorkspaceDO` library each compute part of a viewer
   check. The library (`listSidekickDirectoryForAuthorizedMember`) lists a
   Breakout-homed Sidekick to every participant of the Breakout's Channel, not
   only the Breakout's members, and lists Organization-scope Sidekicks to
   guests. The Breakout case is one the Sidekick conversation's own viewer
   check refuses, and the guest case one the management read refuses. It also
   hides a personal Sidekick from the person it runs as.
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
7.8 KB each (about 1.6 MB), 7 revisions and 210 children; its busiest by count,
a 10-minute schedule, holds 432 runs from three days at about 120 bytes each.

## Goals

1. A Sidekick's definition, revisions, schedules, runs, inbound-email receipts
   and children live in the Organization's `WorkspaceDO`, and no Sidekick fact
   is copied from one object into another.
2. Every change to what a Sidekick has registered (publish, pause, resume,
   remove, and the archive of its Channel or Breakout) commits its definition
   state, its schedules and its connector registrations in one transaction. A
   Sidekick is never active with its registrations missing, and never has
   registrations while it is not active.
3. The rail, sidebar and Sidekick detail read the same row, so they cannot
   disagree about a Sidekick's availability, appearance, run-as person or home.
4. Opening a Sidekick conversation, the Sidekick library and the Sidekick
   detail each cost one call to `WorkspaceDO` from the Worker.
5. Who may view and who may manage a Sidekick are each decided by one named
   function over the tables that hold the facts, and the library uses the
   viewer function.
6. Rally has one implementation of the conversation-parent contract.
   `ConversationParentDurableObject` and every `automation` branch in parent
   routing are deleted.
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
   client behave as they do today, except that the two library leaks in
   Motivation 5 close. Product changes ride their own PRDs.
5. **No new retention for run history.** `runs`, revisions and email receipts
   are imported whole and keep growing as they do today. Decision 8 says they
   fit; a retention policy is a separate, reversible decision if that changes.
   Deferred.
6. **No client changes.** `SidekickDO` holds no sockets, and the Sidekick row
   already reaches clients on the workspace socket. macOS, web and iOS are
   untouched. Rejected as unnecessary.
7. **No zero-downtime dual write.** Each Sidekick is frozen for one export RPC,
   as each Channel was. Rejected, for the reason the Channel move gave: a
   per-parent export is cheaper to build and to verify.
8. **No per-descendant revocation tracker.** Run feed sockets still close
   through one Queue hop per run `SubstreamAgent`, as today. Out of scope.

## Product behavior

This is a backend change. No screen, control or string changes, on any
platform. What changes is when and how fast existing surfaces answer:

- **Opening a Sidekick** from the sidebar or a Channel's rail: the Worker makes
  one `WorkspaceDO` call that resolves the parent, authorizes the viewer and
  returns authority, then seats the reader on the conversation.
- **The Sidekick library and detail** read the Sidekick's own row and its last
  runs from `WorkspaceDO` in one call, with access checked once, by the viewer
  function.
- **The rail** shows exactly what the detail shows. Appearance, run-as person
  and home show on the next socket frame after the write commits, not after a
  Queue round trip.
- **Publishing** either commits the definition, schedules and registrations
  together, or fails and leaves the previous revision active. The drafting
  conversation sees that failure with the field it rejected, per
  [naming a schema failure](../../naming-a-schema-failure.md).
- **Archiving a Channel or Breakout** shows its Sidekicks as paused by the
  archive in the same socket frame that shows it archived.

States:

| State | Behavior |
| --- | --- |
| Sidekick not yet imported | Lists, the rail, search, revocation and retirement serve it exactly as today, from `automation_directory` and the legacy object. The first request that reads or changes it alone imports it, then answers; that request takes one export RPC and one transaction longer. |
| Import fails | The request fails with the import's code, named per [naming a schema failure](../../naming-a-schema-failure.md). The Sidekick stays in its legacy object, frozen, and keeps being listed from the directory, but its runs do not fire until an operator repairs it and runs `retry_sidekick_import`. The alarm reports it to ops on its third attempt without progress. |
| Organization object unavailable | Sidekicks cannot be opened, listed, changed or fired, along with every Channel and Space. This is already true of the rail and sidebar today. |
| Offline client | Unchanged. |

## Impact on the product contract

None. This refines where state lives within the existing contract. A Sidekick
remains a conversation parent whose runs are conversations, and nothing about
viewing, participation or what the agent may do moves. Closing the two library
leaks brings the library in line with the detail screen, which already refuses
those viewers.

## Decision log

None yet.

## Key design decisions

1. **A Sidekick is a third hosted parent role, with its own behavior.**
   `HostedParent` already scopes every table to a `parent_id`; this adds
   `HOSTED_SIDEKICK_ROLE` with `kind: "automation"`. Today's roles are
   booleans, and `authority`, `authorizeViewer` and `metadataRow` are shaped
   for a Channel, so the Sidekick role brings its own `authority`,
   `authorizeViewer` (decision 4), `admitChildEnvelope` (only `automation`
   envelopes), `forwardsChildEffect` (false, as today) and
   `onChildCommonProjection`. The last one maps an accepted child's state onto
   `sidekick_runs.state`, `summary` and `completed_at` in the transaction that
   accepts the effect, as `SidekickDO` does today; without it run history stops
   following the run. Parent state uses the existing `parent_*` tables under
   `parent_id = sidekickId`, and Sidekick-only state goes in new tables that
   each lead with `sidekick_id`, under the hosted-parent invariant: every
   statement names it. Rejected: a separate `SidekickHost` beside
   `HostedParent`, which would keep two implementations of the contract.

2. **The kind is found from the Sidekick's own row, before the Channel
   fallback.** `hostedParentKind` returns `"workstream"` for any id it does not
   know, and `reserveChild` then stores that kind, so a run effect for a
   Sidekick not yet imported would make it a permanent Channel parent. The
   facade answers `automation` for an id in `sidekicks` or `sidekick_imports`
   first. Sidekicks get no `parent_metadata` row: its `parent_kind` CHECK allows
   only `workstream` and `space`, and adding a kind would rebuild the table for
   nothing the facade needs.

3. **The definition row is the directory row.** `sidekicks` holds what
   `SidekickDO`'s single `automation` row holds plus the directory's own
   `next_run_at`, and the rail, sidebar, search, retirement graph and
   engineering MCP read it. The `directory_automation` effect, its
   `source_version` and `payload_hash` fence, and `registration_generation` go.
   `automation_directory` stays read-only for Sidekicks not yet imported until
   step 3 (decision 10). Rejected: keeping `automation_directory` as an
   in-transaction projection of the new row, which removes the Queue legs but
   keeps two copies of each field.

4. **Four named access functions.** `sidekickAudienceAllows` is not one of
   them: it decides where a Sidekick's instructions may be *offered*, compares
   only the caller-supplied conversation parent to the owning Channel, and never
   checks participation, a Breakout home, guests or management. It stays for
   skill reads and the rail. The four, each over local tables:
   - **`sidekickViewer`**: the conversation-parent viewer check. Organization
     scope admits any member; personal scope admits the author and the run-as
     person; Channel scope admits the Channel's participants, or, for a
     Breakout home, the Breakout's members through the Breakout's own
     admission. Today's `SidekickDO.authorizeViewer`.
   - **`sidekickGrantViewer`**: the `requireGrantAuthority` path, for a guest
     reaching a Channel- or Breakout-homed Sidekick through that place's grants.
   - **`sidekickReader`**: the management API's read check. Today's
     `assertViewer`: Organization scope admits members with a role, not
     guests; personal scope the author and the run-as person; Channel scope the
     Channel's participants. It gains the Breakout narrowing `sidekickViewer`
     already has. The library uses it, which closes both leaks in Motivation 5
     and lists a personal Sidekick to the person it runs as.
   - **`sidekickManager`**: who may change it. Channel scope admits the
     Channel's participants and the author; personal scope the author and the
     run-as person; Organization scope those two plus owners and admins.
     Today's `assertManager`, without the Worker precomputing
     `participantOfOwningWorkstream`.

5. **Registrations commit with the definition; the rest is listed.** Publish,
   pause, resume, remove and a home's archive each call `replaceRegistrations`
   today; each now writes `sidekicks`, `sidekick_schedules`, their alarm entries
   and `workspace_external_event_registrations` in one `parentWrite`. A
   registration that fails validation fails the change with its field named.
   What `applyEffects` and `applyExternalEventRegistrations` also do, and where
   each goes:
   - **Memory tables** (`materializeAutomationMemoryTables`). The tables live
     in `WorkspaceDO`, so the call is local and inside the transaction; from
     inside `WorkspaceDO` the service's stub would be a self-call. Any part that
     reaches D1 rides a stored entry, `sidekick_memory_tables` keyed
     `<sidekickId>:<revision>`, that retries on its own backoff and clears
     without acting when the revision is no longer the accepted one.
   - **Schedule-kind refresh** (`refreshScheduleKinds`) runs after the commit,
     locally, as it does today.
   - **Slack source joins** (`joinSlackSourceConversations`) are keyed on the
     accepted revision instead of `registration_generation`, so a save that
     does not change the revision does not re-join.

   `applied_effects_revision`, the `sidekick_publication` alarm kind and the
   Sidekick rows of `external_registration_generations` go. Until step 3,
   `applyExternalEventRegistrations` refuses a Sidekick destination whose
   Sidekick is imported, with `sidekick_parent_moved`, so a call from a legacy
   object cannot overwrite registrations a local publish committed. Rejected:
   keeping registrations in a retried tail so publish succeeds even when one is
   refused. That is the current failure mode moved inside one object.

6. **Alarm entries are scoped to one Sidekick.** The 2026-08-25 lifecycle PRD
   moved automation scheduling out of `WorkspaceDO` because "each automation
   has an independent lifecycle, trigger stream, compiler history, and
   run-idempotency domain", and holding them together "enlarges the
   workspace-wide failure and serialization boundary"
   ([prd.md, Motivation 5](../2026-08-25_durable-automation-lifecycle/prd.md)).
   Since then the shared `_internal_durable_alarms` list gives every stored
   entry its own backoff, so one Sidekick's failing schedule does not hold
   another's. So `automation_schedule` and `automation_run` become stored
   `WorkspaceDO` entries keyed `<sidekickId>:<scheduleId>` and
   `<sidekickId>:<runId>`. Pause and remove cancel by that key prefix: today
   they cancel the whole `automation_run` kind, which inside a shared object
   would cancel every Sidekick's pending runs. Run idempotency stays per
   Sidekick: `sidekick_runs` is unique on `(sidekick_id, occurrence_key)`.

7. **The alarm hands run provisioning off instead of awaiting it.** Per-entry
   backoff isolates failures, not latency: `drainDueScheduledAlarms` awaits due
   entries one after another, and `provisionRun` makes five or more RPCs to a
   possibly cold `SubstreamAgent`. Awaited in the Organization's alarm, one slow
   provision would hold every other alarm job behind it: participant
   projections, invitation delivery, connector reaping, Channel outboxes and
   other Sidekicks' schedules. So the `automation_run` entry does only the
   local writes that must come first, as today (`run_as_user_id` and the child
   registration, which `continueRun` relies on), then sends one
   `sidekick_run_provision` message to the activity Queue and returns. The
   consumer bootstraps and provisions the child, appends the opening message,
   admits the harness run, activates the loop and reports back. The entry stays
   armed until that report and re-sends on its own backoff if none comes;
   every step is idempotent on the run id. This follows
   [choosing a Queue or RPC](../../choosing-queues-or-rpc.md), where the Queue
   is the default.

8. **The cost is affordable, by arithmetic.** A Durable Object serves about
   1,000 requests a second
   ([choosing a Queue or RPC](../../choosing-queues-or-rpc.md)). The busiest
   Organization's Sidekicks admit on the order of 200 runs a day; each adds a
   handful of short local calls (admission, `continueRun`, `readRunState` per
   provider write, child effects), a few thousand a day against tens of
   millions, and the `WorkspaceDO` calls `SidekickDO` makes today go away. With
   provisioning handed off (decision 7), no Sidekick work holds an alarm wake
   on a remote call. Storage: the pull-request Sidekick adds about 26 runs a
   day at about 7.8 KB, about 74 MB a year; the 10-minute schedule about 145
   small runs a day, under 20 MB a year at a generous 300 bytes a row. All 17
   of that Organization's Sidekicks are well under 1 GB a year, against a 10 GB
   object holding about 3.3 GB of connector events at steady state. A full
   object refuses every write, including every Channel's, so the budget line
   goes in [hosted-conversation-parents.md](../../hosted-conversation-parents.md#performance-and-cost).

9. **One export, one transaction, one importer at a time.** This repeats the
   Channel move ([How the parents moved](../../hosted-conversation-parents.md#how-the-parents-moved)).
   The largest Sidekick holds about 1.6 MB, so a single export RPC is far
   inside the platform's 32 MiB message limit; an export over it fails with a
   code and stays `pending`, which is the failure we will notice. The steps:
   - **Single flight.** `WorkspaceDO` keeps one in-memory import promise per
     Sidekick, so a request and the alarm reaching the same Sidekick share one
     import.
   - **Freeze.** The reduced `SidekickDO` has two methods: its migration
     ledger and `exportForImport`. The export marks the object frozen in
     storage, clears its native alarm and returns every row and alarm entry.
     Once frozen it returns the same rows again, so a retried import reads the
     same data. Nothing else in the reduced class writes. Writes from the old
     code cannot land after the export: the API deploys through Cloudflare
     Versions at 100%, and each object restarts on the new version, which ends
     every old invocation still awaiting I/O instead of resuming it.
   - **Re-parse.** `WorkspaceDO` parses the export with Zod, reports a
     rejection with `zodDiagnosticCode`, and checks that its `workspace_id` and
     `automation_id` match the ledger row.
   - **Commit.** One transaction inserts the rows, re-arms the alarm entries at
     their exported due instants and marks the import done. A past instant
     fires on the next alarm, once, because occurrence keys keep their
     uniqueness.
   - **Moved.** A frozen object answers every other call with
     `sidekick_parent_moved`, a typed retryable error: a Queue consumer
     retries the message, and the `continueRun` and `readRunState` callers in
     a running agent loop retry once against `WorkspaceDO`.

   Rejected: a paged export. The first draft paged it for a year of runs, but
   runs never accumulate in `SidekickDO` after the import, so the size it
   solved for does not exist.

10. **A Sidekick not yet imported is served the old way until step 3.** The
    Channel move learned this: until every parent had imported, its rail,
    revocation, authorization discovery and Sidekick-default readers each
    checked `parent_imports`. Here, every reader that lists all Sidekicks (the
    rail, the library, search, the engineering MCP, the retirement graph)
    reads `sidekicks` plus the `automation_directory` rows whose import is
    `pending`. Revocation still sends the `automation` hop for a pending
    Sidekick, and retirement still walks its node. So no Sidekick drops out of
    a list or keeps a revoked member's socket open because its import has not
    run.

    The ledger is seeded from `automation_directory`, which is not complete:
    `create` commits the `SidekickDO` before its directory message arrives, a
    directory message can be lost, and during the deploy an older Worker can
    still create one. So until step 3, `applyAutomationDirectory` stays: for a
    Sidekick id it has not seen, it adds a `pending` ledger row and writes the
    directory row as today; for an imported one it acknowledges and does
    nothing. Step 3's gate also checks the ledger against the migration
    tracker's sweep of the `SidekickDO` namespace, which lists every object
    whether or not it has a directory row.

11. **Children do not change.** A run `SubstreamAgent` keeps
    `{ kind: "automation", id }` as its parent identity. Only routing changes:
    `conversationParentStub` and `conversation-service.ts` address the
    Organization's `WorkspaceDO` for every kind, and `receiveChildEffects`
    stops refusing `automation` envelopes. The child-to-parent
    `conversation_effect` Queue leg stays: the Queue is still the durable
    handoff out of a `SubstreamAgent`.

## Data model

New `WorkspaceDO` tables, one migration, sketch level. Every primary key leads
with `sidekick_id`; the authoritative record will be the migration and
[`data-model.md`](../../data-model.md). The full table mapping is in
[`design.md`](design.md#table-mapping).

| New table | From | Notes |
| --- | --- | --- |
| `sidekicks` | `SidekickDO.automation` and `WorkspaceDO.automation_directory` | One row per Sidekick. Replaces both. Drops `registration_generation`, `applied_effects_revision` and the directory fence columns. |
| `sidekick_revisions` | `definition_revisions` | Immutable, as today. |
| `sidekick_schedules` | `schedules` | Replaced whole on apply, as today. |
| `sidekick_runs` | `runs` | `UNIQUE (sidekick_id, occurrence_key)`, `UNIQUE (harness_run_id)`. History index on `(sidekick_id, created_at DESC, run_id)`. |
| `sidekick_email_receipts` | `inbound_email_receipts` | Keyed by Resend id. |
| `sidekick_imports` | none | The import ledger. Dropped in step 3. |

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

- **Access narrows to four named functions** (decision 4), and two library
  leaks close: Breakout-homed Sidekicks listed to the whole Channel, and
  Organization-scope Sidekicks listed to guests.
- **A Sidekick not yet imported keeps every access path it has today**
  (decision 10), including the revocation hop, so a revoked member loses its
  run feed sockets whether or not the import has run.
- **A hosted statement without its key reads every Sidekick.** The new tables
  inherit the hosted-parent invariant that every statement names its parent
  id, and [durable-object-sqlite.md](../../durable-object-sqlite.md) applies to
  every statement this change writes. A workerd test proves one Sidekick's
  reads and writes never touch another's rows.
- **Imported rows are untrusted input.** They were written by an older
  deployment and cross an RPC boundary, so they are parsed and their identity
  checked before they are written (decision 9).
- **Operator SQL widens.** `run_sidekick_sql` is removed, and
  `run_workspace_sql` now reaches Sidekick customer content alongside every
  Channel's: `sidekick_runs.opening_json`, which can hold inbound email text,
  `sidekick_runs.trigger_json` and `sidekicks.connector_bindings_json`. The
  engineering MCP's audit rules apply as they do to the rest of
  `run_workspace_sql`.
- **Revocation is no faster than today.** Removing the `automation` hop after
  step 3 saves one hop per Sidekick, but run feed sockets still close through
  one Queue hop per run `SubstreamAgent` (non-goal 8).

## Rollout

Ships to everybody on merge, with no flag: nothing here is visible as a
feature, and a flag would mean running both parent implementations side by
side, which is the thing being removed. Like the Channel move, it ships only at
100% and rolls back only forward.

1. **Hosted Sidekick parent and import.** Adds the Sidekick role, the new
   tables and the ledger; routes every Sidekick caller to `WorkspaceDO`;
   reduces `SidekickDO` to its migration ledger and `exportForImport`; and adds
   the `retry_sidekick_import` engineering MCP tool. Keeps, for Sidekicks not
   yet imported only: `automation_directory` and its receiver, the `automation`
   revocation hop and the retirement node kind (decision 10). The
   `test-workers/` suites that bind `SidekickDO` move to `WorkspaceDO`.
2. **Gate.** An operator checks every Organization with `run_workspace_sql`:
   schema at or past the import migration, and no `pending` ledger row outside
   retired Organizations. Then the migration tracker's sweep: every
   `SidekickDO` it lists has a ledger row marked done. A `pending` row with a
   code is repaired and retried before going on.
3. **Delete the class and the scaffolding.** A wrangler tag deletes
   `SidekickDO`. A `WorkspaceDO` migration drops `sidekick_imports` and
   `automation_directory`. The same change removes what step 1 kept for pending
   Sidekicks, `exportForImport`, `sidekick_parent_moved`, the
   `applyExternalEventRegistrations` refusal, `retry_sidekick_import`, the
   import tests, and every subsystem's Sidekick class name listed in
   [`design.md`](design.md#subsystems-that-name-the-class). **This step cannot
   be undone**: it destroys every legacy object and its storage, and a build
   from before it can no longer be deployed.

Turning it off: before step 3, a defect is fixed forward; the legacy objects
are frozen but intact, so a Sidekick whose import is wrong can be repaired by
an operator and imported again. After step 3 there is nothing to turn off.

## Acceptance

Each item is a `test-workers/` test unless it says otherwise, and each names
the break that makes it fail, per
[prove the test can fail](../../testing.md#prove-the-test-can-fail).

- **Import.** A frozen `SidekickDO` with a definition, two revisions, a
  schedule due during the freeze, a pending run and a `directory_automation`
  outbox row imports with the schedule firing once, the run provisioning once
  and the outbox row dropped. Fails if the re-arm is skipped.
- **Concurrent import.** A request and the alarm importing the same Sidekick
  at once produce one import. Fails without the single flight.
- **Failed import.** An export that fails to parse leaves the ledger row
  `pending` with a code naming the field, the Sidekick still listed, and
  `retry_sidekick_import` importing it after repair. Fails if the error code is
  generic.
- **Moved object.** A Queue message routed to a frozen object is retried and
  lands in `WorkspaceDO`. Fails if `sidekick_parent_moved` is acknowledged as
  success.
- **Older schema.** An object last migrated before its ledger head migrates to
  head, then exports. **No object.** A directory row whose object never
  materialized imports as done with no `sidekicks` row.
- **Seeding.** A `SidekickDO` with no directory row is seeded when its
  directory message lands, and the gate query reports it until it is imported.
  The seed migration runs against a `WorkspaceDO` with directory rows, in the
  style of `hosted-parent-migration.test.ts`.
- **Pending Sidekicks stay served.** Before its import, a Sidekick is listed on
  the rail, in the library and in search, and a revoked member's run feed
  socket on it closes. Fails if a reader reads only `sidekicks`.
- **Isolation.** Writes to one Sidekick never touch another's rows, in the
  style of `hosted-parent-isolation.test.ts`; pausing one Sidekick leaves
  another's pending run armed. Fails if pause cancels by kind.
- **Access.** Each of the four functions in decision 4 admits and refuses the
  same people `SidekickDO` does today, and the library refuses a Channel
  participant outside a Breakout home and a guest asking for Organization-scope
  Sidekicks.
- **Run state.** A run whose conversation completes shows `completed` with its
  summary, from the transaction that accepted the child's effect.
- **Publish.** A refused registration leaves the previous revision active, no
  schedules armed and no registrations written, and names the rejected field.
  Declared memory tables exist after publish; a refused D1 step retries; an
  older revision's entry does not act after a newer publish.
- **Provisioning off the alarm.** A slow child provision does not delay another
  due alarm entry in the same wake. Fails if the entry awaits the child.
- **One call to open.** A route test opens a Sidekick conversation with the
  `SidekickDO` binding unbound or throwing, and succeeds.
- **Archive.** Archiving a Channel delivers the archived Channel and its paused
  Sidekicks in one workspace-socket frame, observed on a real socket.
- **After step 3**, the API deploys and typechecks with no `SidekickDO` class or
  `AUTOMATION_DOS` binding.

## Open questions

1. **Sequencing with the delivery-reliability PRD.** It is in progress and adds
   a `deliveries` table and two projected columns to `SidekickDO` and
   `automation_directory`. Building its remaining steps after step 1 means it
   lands directly in `sidekicks` and `sidekick_deliveries` with no projection;
   building them first means one more table to import and two columns to
   delete. Recommendation: land step 1 first and rebase that PRD's remaining
   work onto it. Blocks only that PRD's ordering, not this build.

# Automation results delivered into a work stream

> Created 2026-08-29.
>
> A third result destination for an accepted automation — an existing work
> stream the owner participates in — plus the Google manifest declarations
> that make watching a Sheet, Doc, or Drive file actually route events. Together
> they let a standing work stream receive automation output: triggered email
> summaries, tracked-spreadsheet updates, and scheduled briefings land in the
> room where the work lives instead of the owner's inbox. Companion:
> [state](state.md). Subsystem references:
> [automation lifecycle](../../automation-lifecycle.md),
> [connectors](../../connectors.md),
> [work-stream email addresses](../../workstream-email-addresses.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

An automation's run today delivers its final message to at most two frozen
destinations: the owner's email address and their Rally Slack Agent DM. The run
itself executes in a private child work stream only the author can see. That
means an automation can watch a mailbox, read a spreadsheet, and run every
Monday morning — but its output can never reach the shared work stream where
the people doing that work actually are.

This PRD adds a third destination kind to the same frozen delivery set: an
existing work stream. The owner picks it at acceptance, exactly the way they
pick email or Slack today, and when a run completes, Rally posts the run's
final message into that work stream's feed as a message attributed to the
automation. Nothing else about the run changes: it still executes in its own
private child work stream, and the delivery is Rally's own send, not something
the model does with a tool.

The PRD also closes a silent gap in resource watching. The Google connector
declares `supportsWatches: true`, but none of its activity types declare
`resourceRelationships`, so watching an attached Google Sheet passes the UI,
creates a watch row that drives polling — and then routes nothing, ever,
because the registration reconciler produces an empty evaluator set. Declaring
the relationships makes the existing watch toggle real for Google resources
and lets an automation trigger scope itself to one specific Sheet or Doc.

With both pieces in place, a scenario like "a recruiter's work stream for one
search receives candidate emails, pipeline-sheet updates, and a Monday-morning
client agenda" is pure configuration through the existing automation authoring
conversation. No recruiter-specific code exists anywhere.

## Motivation

The concrete case is a recruiting workspace: one work stream per search (for
example, "CFO — Calm Enterprises"), and the person running it wants three
standing behaviors attached to it:

1. When a candidate emails about the role, the email lands in the work stream.
2. When the pipeline-tracking Google Sheet changes, an update lands in the
   work stream.
3. Every Monday at 9:00, an agenda for the 9:30 client meeting, built from the
   current pipeline, lands in the work stream.

Investigating this against the platform (2026-08-29) showed that every
building block already exists except the last hop:

- The automation trigger vocabulary already covers all three cases:
  `connector_activity` on `google` / `email.received` with deterministic
  filters, `semantic_activity` for "from a candidate, about this role",
  `resource_watch` on a named resource, and calendar schedules with a
  timezone. Automation-owned memory tables hold pipeline state across runs,
  and a run's connector tools (`gmail.*`, `sheets.read_values`) read the live
  data.
- But every path *into* an existing work stream falls short. Run results only
  go to the owner's email or Slack DM. The work stream's own email address
  accepts mail only from workspace members, so a candidate's forwarded email
  is (correctly) refused. And the resource-watch path, which is exactly shaped
  for case 2, silently does nothing for Google resources because of the
  missing manifest declarations.

The cost of leaving this alone is that each "automation feeds a room" request
becomes glue outside Rally — forwarding rules, inbox triage, copy-paste — and
the product's own watch toggle lies to the person who uses it on a Google
resource. The silent watch no-op is the kind of failure the rule sheet says to
avoid: nothing errors, nothing arrives, and nobody can tell why.

## Goals

1. The owner of an automation can select an existing work stream they
   participate in as a result destination at acceptance, alongside or instead
   of email and Slack DM, and each completed run's final message then appears
   in that work stream's feed, attributed to the automation, exactly once per
   run.
2. A delivery that cannot land — the work stream was archived or deleted, the
   owner is no longer an active participant, the automation was paused or
   deleted mid-run — is skipped with a receipt naming the reason, visible on
   the automation's run history, and is never re-targeted.
3. Watching an attached Google Sheet, Doc, or Drive file produces
   resource-update rows in the watching work stream when the polled Drive
   change feed reports a change.
4. An automation's external-event trigger can be scoped to one specific Google
   resource (a `resource_watch` trigger or a resource-scoped evaluator), and
   the compiler's validation accepts it.
5. The recruiter scenario above is authorable end to end through the existing
   automation draft conversation, with no code written for it.

## Non-goals

1. **No agent tool for posting into arbitrary work streams.** Delivery is a
   frozen destination resolved at acceptance, like email is today — never a
   model choice at run time. A `send_to_workstream` tool would let anything
   that steers a run (including untrusted trigger content) choose its own
   audience. Rejected.
2. **Delivery does not start a run in the target work stream.** The message
   arrives for the people there, the same way an inbound email or a watched
   resource update does; the target's agent sees it as transcript context the
   next time it runs for its own reasons. Waking the target agent on delivery
   invites automation-to-automation loops and doubles the cost of every
   delivery. Rejected here; a deliberate "act on arrival" behavior would be
   its own PRD.
3. **No row-granular Google Sheets events.** Drive's change feed reports that
   a file was saved, not which cells moved. Row-level triggers need a new
   diffing poll stream with its own cursor state and event types. Deferred —
   and not needed for the scenario, because a triggered run can diff the sheet
   itself with `sheets.read_values` against a snapshot in its memory table.
4. **No automation read access to the target work stream's transcript.** A run
   still sees only its frozen context, its connector tools, and its
   automation-scoped memory. "Read the room and respond" is a different, much
   larger trust conversation. Deferred.
5. **No Google push channels.** Gmail Pub/Sub watches, Drive push
   notifications, and Calendar channels stay unbuilt; Google ingestion remains
   polling, and watch latency is bounded by the poll cadence. Deferred.
6. **No per-work-stream automations panel.** Automations remain workspace- or
   personal-scoped objects in their existing sidebar section. A "show the
   automations that deliver here" filter on the work stream is a later,
   purely-projection change. Deferred.
7. **No recurrence in `workstream_wakeups`.** A work stream agent's wake-ups
   stay one-shot. Recurring schedules belong to automations, which already own
   calendar arithmetic, timezone policy, and missed-occurrence behavior; a
   second recurrence engine inside every work stream would duplicate all
   three. Rejected.

## Product behavior

### Choosing the destination

During authoring, the author can tell the architect to send results into a
named work stream ("post the agenda into my CFO — Calm Enterprises work
stream"). The architect resolves the name through its existing search tools
and records the request in the draft's `requestedDelivery`, which gains a
`workstream` value alongside `email` and `slack_agent_dm`.

At acceptance, the destination picker gains a work-stream option: a searchable
list of work streams the accepting owner actively participates in. The choice
is resolved and frozen at acceptance the way the email address is today, and
`PATCH /automations/:id` rewrites the whole destination set atomically. The
set keeps its existing shape: at most one destination per kind.

### What lands in the work stream

When a run completes with a final message, Rally appends one message to the
target work stream's main feed. The message is attributed to the automation by
name and links to the automation's page; its body is the run's final message,
rendered through `MarkdownBody` like any other agent output. It marks the work
stream unread for participants under the normal marker rules.

Delivery is idempotent per run and target — a retry after a crash lands the
same message once — and writes the same per-target delivery receipt email
delivery writes today. The run's prompt lists the work stream in its
`resultDelivery` section, so the model knows Rally is delivering and does not
send a duplicate through a provider tool.

### When delivery cannot happen

The delivery re-checks the destination at send time: the work stream must not
be archived, the owner must still be an active participant, and the
automation's authority generation must still match (a paused or deleted
automation's in-flight run does not deliver — the same fence provider writes
already respect). Any failed check skips the delivery and records the reason
in the receipt; the automation's run history shows it. Rally never substitutes
a different destination.

### Google watches become real

The Google activity types gain `resourceRelationships`:
`sheets.spreadsheet_changed` names `google_sheet`, `docs.document_changed`
names `google_doc`, and `drive.file_changed` names `drive_file`. With that
declared, the existing machinery does the rest: watching an attached Sheet
registers a resource-scoped evaluator, and each polled change appends a
resource-update row to the watching work stream — the same system row every
other watched connector produces. The events stay classified `operational`,
so nothing new reaches digests, and `connector-digestibility.md` is updated in
the same change.

Two honest caveats surface in the product: updates arrive on the Google poll
cadence, not instantly, and a change means "the file was saved", not a
described diff. An automation with a `resource_watch` trigger is the upgrade
path when someone wants a summarized delta rather than a notification — its
run reads the sheet, diffs against its memory table, and delivers the summary.

### The scenario, assembled

The recruiter creates three automations in the draft conversation, each
delivering to the "CFO — Calm Enterprises" work stream:

1. Trigger: `semantic_activity` on `google` / `email.received` — "an email
   from a candidate about the CFO search at Calm Enterprises". The run
   summarizes the email, attaches the thread, and its final message lands in
   the work stream.
2. Trigger: `resource_watch` on the pipeline Sheet. The run reads current
   values, diffs against its memory table, and posts what moved. (Or, without
   an automation at all: attach the Sheet to the work stream and enable watch
   for plain change notifications.)
3. Trigger: calendar, Mondays 09:00 in the client's timezone. The run reads
   the pipeline and posts a 30-minute agenda, optionally also emailing the
   owner.

## Impact on the product contract

None — this refines behavior within the existing contract. Two clauses are
worth checking explicitly. "Every admitted automation run owns exactly one
work stream" still holds: the run executes in its own child work stream, and
delivery posts a message into another one without the run owning it, the same
relationship email delivery has to an inbox. And "connected activities either
trigger deterministic automation work, enrich an explicitly watched resource,
or appear as an in-stream routing suggestion" is the clause the Google
manifest fix makes true — watching a Google resource today satisfies its
letter and delivers nothing.

## Decision log

None yet.

## Key design decisions

1. **A delivery target, not a tool.** The alternative — giving runs a
   `send_to_workstream` tool — was rejected because it converts prompt
   injection into a cross-room write: anything that steers a run could pick
   its audience. As a frozen destination, the audience is chosen by the owner
   at acceptance and can only be narrowed by the run (by producing no final
   message), never widened.
2. **Appending, not waking.** The delivered message does not launch a run in
   the target work stream. This matches the two existing external ingress
   paths (inbound email, watched resources), keeps delivery cheap, and closes
   the loop where automation A's delivery triggers work that triggers
   automation A. The rejected alternative — configurable "wake on delivery" —
   is deferred to a PRD of its own if a real case appears.
3. **Reuse the watched-resource append shape.** The destination-side write
   follows `SubstreamAgent.appendWatchedResourceEvent`: an idempotent client
   message ID derived from the delivery, an authority-generation fence, and an
   archive check, delivered through the existing delivery/receipt machinery.
   The rejected alternative — delivering by emailing the work stream's own
   address — was seductively zero-schema but wrong twice over: the inbound
   screen exists to refuse non-member senders, and a product feature routed
   through its own anti-abuse channel breaks the moment either side tightens.
4. **Participation is the authorization.** The owner must be an active
   participant of the target at acceptance and at every delivery. Delivering
   is the owner publishing into a room they can already write in — the same
   trust position as pasting the result by hand. The rejected alternative,
   audience-containment checks like restricted connector activity uses, was
   set aside because the owner is making an explicit publish choice about
   their own automation's output, not having third-party content routed for
   them; decision 2 in Security below records the one place this still needs
   care.
5. **Declare the manifest now, add granularity later.** Making
   `sheets.spreadsheet_changed` watchable is a declarative manifest edit that
   the whole existing pipeline honors immediately. A row-granular event family
   (non-goal 3) can be added later without revisiting this change, because
   manifests own the event vocabulary.

## Data model

No new tables. `AutomationRunDeliveryTargetV1` (in
`packages/contracts/src/automation-agent.ts`) gains a third arm,
`{ type: "workstream", workstreamId }`; the acceptance-time
`AutomationDeliveryTargetSetSchema` and the compiler's `requestedDelivery`
enum gain the matching value. Delivery receipts reuse the existing
`automation_delivery_receipts` row per run and target. Existing frozen
delivery sets remain valid as they are — no backfill. The Google
`resourceRelationships` change is connector manifest code, not schema.

## Regional impact

None crosses the boundary. The target work stream belongs to the same
workspace as the automation, so delivery is an in-region object-to-object
hop. The Global email-address registry is untouched.

## Security and trust model

1. **Untrusted triggers can now reach a shared room.** An inbound email or a
   connector event can trigger a run whose final message every participant of
   the target work stream reads. The existing containment holds: inbound
   email is admitted only from active workspace members, email-triggered runs
   already lose all connector write tools and web access, and the delivered
   body renders through `MarkdownBody` with its scheme allowlist and
   non-navigable mention chips. The new exposure is reach, not capability —
   the owner chose that reach at acceptance.
2. **Whose participation gates a workspace automation.** Acceptance of a
   workspace-scoped automation can be performed by an owner or admin who is
   not the author. The destination list offers work streams the *accepting*
   user participates in, and the delivery re-check is against that same
   frozen principal — one answer, resolved at acceptance, like the email
   address. See open question 2.
3. **Authority generation fences delivery** exactly as it fences provider
   writes: a run outliving a pause or delete does not deliver.

## Agent behavior

No plugins or tools are added or changed, so the full tool-contract
documentation in [`prds.md`](../../prds.md) does not apply. Two model-facing
surfaces move: the automation architect's `requestedDelivery` vocabulary gains
`workstream` (with standing-policy guidance to resolve the work stream by
search and never invent an ID), and the run prompt's `# Result delivery`
section lists the work stream so the run treats its final message as the
delivery instead of provider-sending a copy.

## Rollout

No flag. The change is additive: a delivery set without a work-stream entry
behaves exactly as today, and the manifest declaration only causes events to
route where a person has already toggled a watch on. If it goes wrong, an
owner pauses the automation or disables the watch — both existing controls.

## Acceptance

1. Author an automation with a semantic email trigger delivering to a work
   stream; send a matching email to the connected mailbox; the summary appears
   in the work stream's feed, attributed to the automation, once.
2. Attach a Google Sheet to a work stream, enable watch, edit the sheet; a
   resource-update row appears within one poll cycle.
3. Accept a Monday-09:00 automation with work-stream plus email delivery; when
   it fires, the agenda appears in both places and the run history shows two
   delivered receipts.
4. Pause the automation mid-run; the run completes but delivers nothing, and
   the receipt says why. Archive the target work stream; the next run's
   receipt reads skipped-archived and no other destination is substituted.

## Open questions

1. **How the delivered message renders.** A plain system row is buildable
   today; a dedicated automation-attributed row (name, mark, link to the run)
   is better product and touches the feed-row family owned by
   [`conversation-surfaces.md`](../../conversation-surfaces.md). The answer
   decides the `structuredContent` shape the append writes, so it should be
   settled before the destination-side write is built.
2. **Non-author acceptance targeting.** Should an admin accepting another
   member's workspace automation be able to point it at a work stream the
   author is not in? The proposal above says yes (the accepting principal's
   participation gates), but the alternative — requiring the author's
   participation too — is stricter and arguable. Changes only the acceptance
   validation, so it can be settled during review.
3. **Gmail-thread watching.** Whether to declare `resourceRelationships` for
   `gmail_thread` on the email event types in this pass, or ship
   Sheets/Docs/Drive first. Watching one email thread is a plausible want,
   but the email events' filter fields were not designed with per-thread
   scoping in mind and deserve a look of their own.

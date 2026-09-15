# Substream creation

Substreams are private conversations inside an existing work stream. Starting
one looks like starting a work stream: a composer, and the message typed into it
is the substream's first instruction. On the keystroke that submits it, creation
freezes an initial context from the main conversation (`0`), writes the child,
installs that context, admits the turn and wakes the child's loop. It does not
create another work stream, copy running work, or send an instruction on the
creator's behalf.

The platform currently uses summary-based context with
`google/gemini-2.5-flash-lite` and creator-only membership. These are shared
platform policies, not controls offered to the user.

Prepared history may be supplied by the internal coordinator on confirmation.
It uses the same canonical preparation/materialization and resource-reservation
owner as a root conversation, before the parent publishes readiness. The durable
preparation receipt rejects changed replay. The parent freezes the prepared-history
hash (or no-history intent) when confirmation is first claimed, before any child
installation yields. Concurrent and ready confirmations must match that intent;
a ready child may only replay an already committed history installation. This
prevents a confirmation without history from publishing ahead of one that requires
it, and prevents adding initial history after publication. Parent migration 12
treats previously claimed operations as no-history, preserving their original
meaning. An ordinary opening can then start
execution independently. See [prepared conversations](session-import.md).

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/substream-creation.ts` | Versioned recipes, frozen captures, context parts and preview contracts. |
| `apps/api/src/services/substream-context.ts` | Static strategy, selector, transform and membership registries; platform policies; validation and hashes. |
| `apps/api/src/services/substream-context-summary.ts` | Structured Gemini summary through the shared inference gateway. |
| `apps/api/src/services/substream-creation-service.ts` | Authenticated prepare, confirm, cancel, archive and participant coordination, and the model pin confirmation writes onto the child. |
| `apps/api/src/durable-objects/workstream-do.ts` | Creation receipts, ready-child directory and authoritative private membership. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Frozen source export and immutable inert child seed. |
| `apps/api/src/durable-objects/substream-context-transfer.ts` | Frame-sized initial-context snapshot transfer. |
| `apps/api/src/services/substream-initial-context.ts` | Inert seed to model-context conversion. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | Main/child navigation, the creation state machine and its cache seeding, rename and archive dialogs, and `railChildren`, which draws the open substream's row under its own name. |
| `apps/desktop/src/renderer/components/workstream-sidebar.tsx` | The center rail's rows, including the placeholder row a substream being created holds. |
| `apps/desktop/src/renderer/components/substream-launch.tsx` | The launch surface: branch provenance, the composer that starts a substream, its model pin, and the optimistic turn while one is being created. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Renders that surface in place of the conversation's own three rows, and `branchProvenance`, which chooses the turns it fades. |
| `apps/desktop/src/renderer/lib/launched-conversation.ts` | The optimistic opening transcript and the child detail both launchers seed. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Authoritative baseline, initial-context assembly and readiness. |
| `apps/ios/Rally/Network/RallyClient.swift` | Same prepare, confirm, cancel, rename and archive routes the desktop client calls. |
| `apps/ios/Rally/Network/WorkstreamControlSocket.swift` | Parent `workstream_metadata` child directory on iPhone. |
| `apps/ios/Rally/App/AppModel.swift` | iOS creation state machine: nothing reserved until submit, launch composer, then the child's feed socket. |
| `apps/ios/Rally/Features/Chat/SubstreamSwitcher.swift` | Phone-shaped center rail: conversation chip, Main/child sheet, launch surface. |

## How it works

The middle sidebar puts the main conversation first, then one full-width row per
child — including, while one is being created, the child that does not exist
yet — then **New substream**. Every row is the navigation sidebar's work-stream
row — borderless, one 36px leading mark slot — and the mark is what tells them
apart: the work stream's own tinted icon for the main conversation, a Tabler
`corner-down-right` arrow for a child, and a Tabler `plus` for creation. The
arrow is the same shape the main feed's **New substream** control draws as a
text `↳`, but the rail and the feed no longer mean the same thing by it: in the
rail it says *is* a substream, on a turn it says *start* one. The launch
banner draws that same `corner-down-right` arrow, in the feed's sense of it.
Compact hides the titles and swaps a child's arrow for the first character
of its title. It retains the existing sidebar colors, row sizing, drag width and
icon-only collapse. A completed
main-feed message also offers **New substream** with that message as the cutoff:
last in the assistant turn's action row, after Copy, Speak, Image and PDF, and in
a row of its own under any person's bubble — the reader's own turn and a
colleague's alike — ending on the same vertical as the identity line above it.
Both placements appear on hover, alongside the other things a settled turn can be
asked to do. [Conversation surfaces](conversation-surfaces.md) owns the rows
themselves.

The sidebar row and the message control enter the same creation flow; there is no
context-strategy picker, no title field and no preview step.

The main row’s right-click menu offers **Make public to workspace**, **Rename**,
**Copy work stream link**, then a separator and **Archive work stream** in danger
styling. Publication is disabled for an already-public stream and omitted for
system-managed streams. Child rows offer **Rename**, **Copy substream link**, then
a separator and **Archive substream** in danger styling. Actions target the row
that was clicked, including Main while a child is open; rename and archive reuse
the screen’s target-addressed dialogs. Links use the canonical workspace address
and include the child suffix only for child rows.

### The launch surface

Both entry points replace the conversation's three rows — header, transcript,
composer dock — with the launch surface, inside the same column. The work
stream's sidebar, inspector and retained parent socket do not move, because the
work stream has not been left; only its middle column has something else in it.

The geometry is `.workstream-launch-screen`, shared with the work-stream
launcher and described in [`workstream-creation.md`](workstream-creation.md):
while composing, the launcher's own dock padding; on submit, `is-launching` lands
and every value settles on the conversation's own, so the composer travels into
the dock rather than being replaced by it. The composer itself is not one of
those values any more — it is the same message capsule, at the same width, on
both sides of the submit, per
[`conversation-surfaces.md`](conversation-surfaces.md).

What sits above that composer is the difference between the two entry points:

- **From a message** — the turn that was branched from and the four before it,
  faded out upward under a gradient mask and inert to the pointer. They say what
  is being branched out of. They are not what the substream inherits: the
  platform still freezes a summary of the conversation through that cutoff, and
  those turns are the only part of it anybody is shown.
- **From the sidebar** — nothing, exactly as the work-stream launcher's body is
  empty. A substream started there branches from wherever the conversation has
  reached, so there is no particular moment to be looking at.

The composer itself is the work-stream launcher's, and carries the same one
control the launcher does: while Application → Developer → **Debug enabled** is
on, a model pill beside the attachment button pins every run of the substream to
one model ahead of the `agent-model-workstream` flag. It starts on **Default**
and does not inherit the parent's pin — a substream is its own conversation with
its own row, and every substream created before the pill existed follows the
flag whatever its parent named, so seeding it from the parent would change that
silently for work nobody was deciding about. The pin travels with the opening
message on the confirmation, because it is part of the same act, and it cannot be
changed afterwards: the created child shows the same pill locked, naming what it
is running on. [`feature-flags.md`](feature-flags.md#a-conversations-own-model)
owns the pin itself.

Nothing is reserved while the surface is open: no operation, no child id, no
model call. Leaving it before the first submit is a `setState`, and the draft
stays under its own composer key. After a submit that failed there *is*
something reserved — preparation froze a capture and reserved a child — so
leaving then cancels that operation as well, which is the one thing the
renderer still calls `POST …/substreams/cancel` for. This is why there is no cancellation to make — the flow that
prepared on open, and cancelled what it had reserved on the way out, was the
modal one. After submit there is nothing to cancel either, for the opposite
reason: the operation has been claimed, so the control that leaves the surface
is disabled rather than dropping a creation that would carry on without it.

On submit the surface draws the typed turn and a work timer, and the substream
is created behind them: `POST …/substreams/prepare` freezes and
summarizes, then `POST …/substreams/confirm` carries the message. The response
names the canonical turn, which is seeded into the child's transcript with the
child's detail before the navigation, so the child's screen paints the same turn
in the same place rather than showing its opening state. A creation that fails
takes the optimistic turn back off the screen and puts the words back in the
composer.

The rail draws the row from that same keystroke. It is the ordinary child row —
the arrow in the mark slot, selected — carrying the title skeleton the header
above it already shows, placed last in the list, where a child created now will
be listed. **New substream** goes back to being the row that starts the next
one. Two round trips is long enough that the conversation on screen having no
row of its own was the surface saying nothing about the thing it was doing, and
a plus row claiming to be where the reader is says it wrong. The skeleton rather
than the first line of the message because the title is the server's to derive:
a second answer here to what a first line is would disagree the moment either
changed.

The placeholder yields to the child's own row the moment the parent's directory
carries it, which is **before** the navigation rather than at it: readiness
broadcasts from inside the confirmation, so that frame can reach the window
while the response is still in flight. The rail recognizes the row by the id
preparation reserved — `prepare` answers with it, the child is provisioned under
the same one, and `workstream.tsx` holds it for the attempt on screen. Without
that the two would be drawn side by side, one conversation with two rows. While
the published row stands in for a creation the route has not caught up with, it
is the row marked current, because that is the conversation the launch surface
is showing.

The timer is the one thing the swap does not carry across, and deliberately: a
work stream's creation writes its run and answers with the id, while a message
admitted into a conversation leaves a pending input — the run row is written
when the child's loop claims it, after the response. There is no id to seed, so
the child's own timer starts when its room reports the run.

Every section of the center sidebar belongs to the parent work stream. Switching
substreams changes the conversation, not the sidebar's artifact inventory,
parent participant roster or management target. The right side of the conversation title bar shows a participant facepile for the
selected conversation. Main participants appear in both the sidebar and Main
title bar; a child title bar manages only that child. The parent socket remains retained on
direct child links. This shared chrome does not publish private child resources
or replace the child's creator-only conversation membership.

1. The renderer assigns one operation ID and freezes the optional message
   cutoff. Retrying the same attempt keeps that ID.
2. WorkstreamDO reserves one child ID and pins the resolved context recipe and
   membership initializer receipt. Reserved children are not discoverable or
   readable as conversations. The title it reserves them under is a placeholder:
   preparation is about the context, and the message that names the substream
   has not been sent yet.
3. The source SubstreamAgent captures a completed main-conversation prefix in
   a synchronous storage transaction. Subsequent messages and edits do not
   change this operation's capture. An explicit unfinished cutoff is rejected.
4. The coordinator runs the pinned recipe outside the storage transaction.
   Completed parts are durably checkpointed. The summary adapter has no tools
   or fallback model and records requested/resolved model and token usage.
5. Confirmation claims the operation and provisions the same child, titled from
   the first line of the opening message and in `title_status = 'naming'`, then
   installs the immutable seed. None of this is visible to anybody yet.
6. The opening message is admitted through the child's own product
   `create_message`, which writes the canonical turn and wakes the child's
   persistent loop. The people a confirmed mention named travel with it, because
   the child refuses a mention of somebody who is neither a participant nor
   confirmed and it has no participants but its creator yet. **Only then** is the child marked ready — carrying that
   title, so the registry row every sidebar reads and the child object agree in
   the write that makes it visible. Readiness is the publication fence: a
   creation that fails to write its message leaves nothing behind for anybody
   to find. The people a confirmed mention named are seated after it, because
   the parent grants membership only for a ready child, and the first naming
   pass is deferred. Retrying confirmation resumes the same operation, not
   another child, and replays the turn for a `clientMessageId` it already
   admitted rather than saying it twice.
7. The parent's existing control socket publishes viewer-filtered ready
   children. The child's socket supplies its own transcript and initial context.
   The context is carried, not drawn: it is what the child's runs read, and no
   surface renders it — see **What the reader is shown of it** below. Nothing
   else is sent on the creator's behalf: the substream is working on the
   instruction it was created with, and on nothing else.

Confirmation still answers without an opening message, and creates the idle
child it always did. The desktop no longer asks for one.

### The name a substream is given

A substream is named the way a work stream is, by
[the naming pass](workstream-naming.md) — the same code, not a copy of it: its
provisional title is the first line of the opening message, its `title_status`
is `naming`, and its header shows the same skeleton until the pass answers. The icon
that pass chooses is stored on the child like any other, and drawn nowhere: a
substream's rows keep the arrow, and the child directory payload behind
them carries no appearance. Both passes are addressed at the child —
`workstreamId` plus `substreamId` through the identity and message ports, and
the rename event published into the child's own room. The child's rename reaches
the parent's registry through the ordinary common projection, which is what
converges every sidebar's row.

That projection is the authority and it is not quick: the child's directory
effect goes to the Queue and back before the parent knows, about fourteen
seconds after a substream is created — which is exactly when its naming pass
renames it. The child knows its new name at once and the parent does not, so a
window opened in which the header carried the name Rally chose and the rail
beside it still carried the first line of the message. A window in which one
conversation has two names is a defect whichever name is right.

The rail closes it by reading rather than writing. Every row it draws comes from
the parent's directory, except the row for the substream that is **open**, whose
title comes from that child's own detail — the same entry the header renders, so
the two cannot say different things (`railChildren` in `workstream.tsx`). It
follows whatever moves that detail, which is every way a child states its own
name: the rename event its room publishes, and the title its socket's snapshot
carries when a substream is opened after its naming pass already ran and there
is no event left to hear.

Only the open child, and read-time rather than written back into the directory,
and both restrictions are the same decision. The parent's projection stays the
only writer of that cache: a patch into it is replaced wholesale by the next
parent frame, which inside the window still carries the old name, so whether the
rail was right would come down to which socket spoke last — measured in a real
window, the parent's frame on a cold open usually speaks second and wins. And
no other row has a better answer available: nothing in the window subscribes to
a substream it is not showing, so for every child but the open one the parent's
copy is the best there is.

Before this, children were provisioned `settled` and no pass ever ran on one; a
run settling in a child called the refresh pass with the parent's address and
its own dropped, which found the parent's own title and, in the overwhelming
case of a settled work stream, did nothing. That is fixed rather than preserved:
`settleAgentRun` passes the substream it ran in.

### What the reader is shown of it

Nothing. The frozen starting context is model-facing: the child's runs read it,
`sendReady` waits for it to arrive before a substream can send, and the local
cache declines to mirror a conversation whose context it cannot find — but no
surface draws it. It was drawn once, under a **Context from the main
conversation** heading at the top of the child's feed, and in a conversation a
person had just started it was the first and largest thing they saw: a summary
of the work stream they had branched out of moments earlier, restated to them
unasked, above their own opening message. The turns the launch surface fades in
above the composer already say what is being branched out of, and they say it
where the decision is being made.


### Membership, rename, archive and notifications

The child title-bar facepile opens its participant dialog. Adding grants explicit
child membership after checking parent access; removal and self-removal use the
same authority, and the final participant cannot leave. Confirming a mention of
somebody outside the child adds them through that API before sending.

A child row's context menu offers **Rename** and **Archive substream**.
`PATCH /conversations/:parentId/substreams/:substreamId` changes either `title`
or `archived` per request. Rename writes the child's own title; its common
projection updates the parent-owned child registry. The desktop applies a child
rename event to the child's detail and to nothing else — never the workspace's
parent row, whose name a child cannot change — and the rail draws the open
child's row from that same detail, per **The name a substream is given** above.
Archive stores `conversation_children.archived_at`, removes the row from every
member's child directory, and refuses messages, membership changes and new
socket tickets. A durable, versioned delivery mirrors archive state into the child; it commits the agent stop request with the local archive. Already-open sockets check that local state without a parent RPC.
Membership and transcript are retained; the same API accepts `archived: false`
to restore them. Restoration is API-only; the app has no restore control and its confirmation says so. The UI returns an archived conversation's viewer to Main, including when another member archives it.

Mentions and participant-added notifications leave the parent with their child
address. Delivery uses the existing Slack/email pipeline, rechecks current
membership and archive state, and links to that child. Child activity stays out
of the shared activity feed and digests. Parent unread counts, mention markers,
and participant permissions still come only from Main; there are no child unread
dots. The existing notification dependency uses the unchanged Main viewer
projection, or a neutral nonparticipant row if Main has never reported that
viewer, so a child notification can settle without merging two attention clocks.

Notification links include `/substreams/<child-id>` through the website handoff
and desktop workspace activation. This does not create a child email address or
change inbound email reply routing.

### Extending initial context

A strategy plans a recipe; selectors identify source turns; transforms produce
validated summary or history parts. Built-ins include summary, all eligible
history, empty, last-N, range and summary-plus-recent-tail. Add a statically
registered, versioned plugin and change the one platform policy to select it.
Do not add conditionals to the coordinator or expose a user picker.

One caller replaces the summary itself rather than the recipe that produces
it. `SubstreamCreationService` takes an optional `SubstreamSummaryGateway`; the
demo seeder passes one that returns the pack's own text, so a seeded demo's
substream opens on words a person approved instead of on a model's, and
preparing the same pack twice produces the same child. It is not a strategy and
not a policy: the recipe, the capture, the checkpoints and the authority recheck
after inference are all unchanged, and the only thing that differs is where the
summary's prose came from. Every other caller omits it and gets the platform
policy above. [Demo workspaces](demo-workspaces.md) owns why.

Each plugin validates its configuration. Persisted recipes retain plugin
versions and canonical hashes; retries validate the old recipe rather than
substituting the current deployment's policy. Keep old plugin versions available
while their preparations may still be retried. Membership is a separate
initializer receiving the creator and validated configuration; a future policy
that needs the main roster must obtain it from the parent's authority, not infer
it from the current viewer or copy a client-provided list.

“Full history” means eligible participant text, attribution, mentions and
attachment references. It is not a clone of the tool protocol: tool inputs and
results, thinking, run state, elicitation state and queued instructions are not
inherited. [Agent harness](agent-harness.md) owns how these inert records enter
the first model context without becoming executable historical work.

## Invariants

- Parent visibility **and** explicit child membership are required. Parent
  participants cannot enumerate or open someone else's private child; adding a
  child member does not grant parent or sibling access.
- One operation pins one capture, recipe, child ID and membership receipt.
  Replanning a retry would silently change the context that operation froze.
- Context installation writes no live transcript turn, pending input or run.
  Treating inherited text as a new instruction could execute old requests. The
  one turn a new substream holds is the message its creator typed, admitted
  through the ordinary product path after the child is ready — installation and
  instruction stay separate mechanisms even though one request carries both.
- **Readiness is the publication fence.** The opening turn is durable before
  the child is published, exactly as a work stream's route is activated only
  once its own opening turn and run are committed. A child published first is a
  visible empty substream whenever the message behind it fails, which is the
  state this flow exists to not produce.
- Creation is idempotent under retry in both halves: the operation resumes
  rather than making a second child, and the opening turn replays by
  `clientMessageId` rather than being said twice. A confirmation whose response
  is lost is the common case, not the rare one. That only holds if the caller
  keeps the two ids, so the launch surface mints them when it opens and holds
  them until the substream exists or the surface is left — the composer hands
  the words back on a failure and the obvious next thing is to press enter
  again, which fresh ids would turn into a second substream. A retry after a
  failed admission completes the child that was already provisioned.
- **An abandoned attempt is not a successful one.** Leaving the surface while a
  creation is in flight — selecting another conversation, the one exit left
  once submission has begun — does not swallow its failure: the rejection is
  what gives the staged files back, and a resolved one would report a message
  that never landed. A creation that succeeds after its surface was left still
  seeds the caches for the substream it made; it simply navigates nobody.
- An opening message over the ceiling is refused as `message_too_long`, with the
  sentence the composer would have shown, before the confirmation reserves
  anything. It travels one level down in the body, which is where a bound
  quietly stops being the caller's to act on.
- Nothing is reserved while the launch surface is open, and nothing stays
  reserved once it is left. A composer somebody closes must not leave a reserved
  child, a spent summary call, or an operation for a later request to conflict
  with — before the first submit there is nothing to release, and after a failed
  one the cancellation is what releases it.
- **A mention nobody can be seated for is refused before anything is created.**
  Confirmation asks the seating's own two questions first — active workspace
  membership, then whether this work stream admits them — because the answer
  arrives as a sentence about the message ("add this person to the work stream
  first"), and a sentence about the message should not cost a substream.
- **A substream's model pin is its own row's, written once.** Confirmation
  writes it onto the child and never onto the parent, and a retry of a
  confirmation that already reached `ready` replays its answer rather than
  re-provisioning — so the pin a run resolves is the one the first confirmation
  carried. A child that names nothing is unpinned and follows the flag, which is
  what every substream created before the pin existed does. The optimistic seed
  states it too, rather than letting it arrive with the parent's fields it is
  built by spreading: a child of a pinned work stream that inherited the pin
  there would show the parent's model as its own for the frames before the
  room's snapshot lands, which is the inheritance this rule refuses.
- The installed selected parts are the model's context and nobody else's. No
  surface renders them, and the complete source capture is preparation
  provenance rather than a second hidden model-context source.
- Child membership versions fence signed admission and live commands. Removing
  a participant must invalidate an existing socket as well as future tickets.
  Re-adding them does not revive an old ticket: its version must match exactly.
- A substream is named from its own transcript, into its own room. Both naming
  passes and the rename publication carry the substream address; addressed at
  the parent, as they were before children were named at all, they answer for
  the work stream the person is not looking at.
- Child events do not overwrite main-conversation title, activity or roster.
  Child navigation must retain the parent shell while addressing all draft,
  transcript and pending-input state by the selected conversation.
- Execution RPC ports carry the external child address; the child database's
  local `substreams` root remains `0`. Run SQL references that local root while
  its saved workflow input retains the external address. Mixing those identities
  prevents the first instruction from activating.
- Child discovery uses a dedicated control-owned cache, fenced by authority
  generation and `privateChildrenWaterline`. This local `children:<user>` clock
  never advances the workspace notification `user:<user>` clock. Feed snapshots and list-page refreshes cannot
  erase it, even when control metadata arrives before the first feed snapshot.
  Archived readable parents retain child navigation even though they are not listable.
- A canonical reset is socket-only. Reintroducing REST boot recovery would
  create a second baseline authority and resurrect race-prone stale state.

## Boundary

This subsystem owns child creation from main substream `0` of a work stream.
It does not create children from children, expose strategy selection, inherit
participants by default, create another email route, or auto-run the child.
Prepared context is immutable; normal new messages remain editable according to
the existing transcript rules.

The parent owns child discovery and membership; the child owns its transcript,
seed and execution. [Workstream Durable Object](workstream-durable-object.md)
owns that authority hierarchy. [Conversation surfaces](conversation-surfaces.md)
owns shared rendering and lightboxes. Main-addressed managed-resource mutation
controls are not exposed inside child previews.

## Failure modes and limits

An inference failure leaves the operation and capture available for retry, and
reaches the person as an error under the composer with their message still in
it. A completed part is reused rather than intentionally regenerated. No
automatic strategy/model fallback changes the frozen meaning. A lost response
can be retried with the same operation ID; a mismatched cutoff is a conflict.
Confirmation cannot be cancelled after its durable claim; it can be resumed.

Source access is checked before capture and again after preparation. Reserved,
failed or incompletely installed children never become readable. Membership
mirroring must complete before readiness is published, including deliveries
deferred for retry. The parent rechecks authority without an intervening await
at the prepared-context commit and confirmation transitions. Cancellation
accepts the endpoint's empty 204 response, and is now only the API's to make:
the launch surface reserves nothing to cancel.

Context snapshot frames respect the existing realtime frame-byte limit, rather
than imposing a new product history cap. Missing or partial baseline data is
recovered from the canonical socket; the composer does not become ready on a
partially assembled child seed. Large histories still cost source export,
provider context and transfer time: no silent truncation is used to hide it.
The source capture currently crosses the source-agent and parent RPC boundaries
as one value. A history larger than the platform RPC payload allowance therefore
fails preparation visibly; supporting that case requires a durable paged capture
protocol, not a guessed truncation cap. The frame chunker solves only delivery
of the selected seed to a connected desktop and does not remove this RPC limit.

Creation targets remain **P50 <1 second and P90 <2 seconds**, including summary
preparation. The September 4 synthetic ten-call Gemini preflight measured
summary-only P50 1,861 ms and P90 2,221 ms; this is not a production percentile
or an end-to-end success claim, and already misses the combined target.
The chosen model was retained at the user's instruction. See
[performance tracing](performance-tracing.md) for preparation and confirmation
timers and operation correlation. The interval those timers cover is now the
whole of creation — there is no human review step to exclude from it, and the
opening turn is written inside the confirmation — so the same numbers describe
more work than they did. What a person waits in front of is neither: the launch
surface has already drawn their turn.

## Testing

`workstream-open.test.tsx` covers row-addressed parent/child rename and archive,
success-only parent action telemetry, and delayed copy failures after navigation
or opening another action. Inverting the parent/child mutation branches must
fail the target tests; removing telemetry calls and the copy guard fails the
five completion/error cases.

- `apps/api/test/substream-context.test.ts`: plugin extensibility, policies,
  recipe validation, frozen selection, checkpoint provenance and hashes.
- Summary and initial-context unit suites: pinned inference routing, inert
  model rendering and provenance.
- `apps/api/test/substream-context-storage.test.ts`: real SQLite schema,
  completed-prefix capture, frozen retry, excluded execution blocks and idle
  immutable installation. Mutation proof removes the cutoff turn.
- `apps/api/test-workers/substream-creation-runtime.test.ts`: real workerd
  parent/source/child prepare-confirm with provider HTTP doubled;
  duplicate confirmation, creator-only access, cancellation and no initial run
  where no message was sent. Mutation proof skips target seed installation. The
  first-instruction test reaches a provider double through the real loop, checks
  the frozen seed and new child instruction, and excludes a later conflicting
  Main message. Creation-with-a-message covers the provisional title, the
  registry row it converges, the durable turn, the unchanged parent title and
  the replay a retried confirmation gets; its mutation proof addresses the
  naming pass at the parent, which leaves the child in `naming`. The pin test
  drives a chosen model all the way to the provider double and asserts the
  parent's row is untouched; its mutation proofs write `null` in place of the
  pin, skip the override in `resolveWorkstreamModelRouting`, and drop
  `modelOverride` from the detail projection.
- `apps/api/test-workers/demo-seeder.test.ts`: a demo pack opens a substream
  through this service on real workerd — prepare, confirm, and one participant
  add each — with the summary gateway answering from the pack, and asserts the
  child's own roster, initial context, transcript and loop while the parent's
  main conversation stays untouched. Proved to fail with the gateway
  substitution removed, which sends creation's one inference to the provider
  double the suite forbids.
- `apps/desktop/src/renderer/components/substream-launch.test.tsx`: the branch
  turns above the composer, the words enter hands to creation, the optimistic
  turn and skeleton while it runs, the draft coming back on a failure, and the
  model pill — hidden without Debug enabled, carried to creation when a model is
  chosen, and left on **Default** even when the parent is pinned.
  `workstream-open.test.tsx` covers the flow through the screen — the two
  requests, both halves of the destination's cache, and the error path — and
  `workstream.test.tsx` covers which turns `branchProvenance` chooses.
- `apps/api/test-workers/conversation-parent-contract.test.ts`: private child
  readiness, membership and authority fences. Mutation proof removes readiness
  from admission.
- Desktop socket, sidebar, draft, navigation and performance suites exercise
  cache isolation, recovery and operation correlation. Real Electron QA is
  additionally required for expanded/compact sidebar, preview, child navigation,
  themes, drag width and composer readiness.

Run the focused suites with the package-local Vitest paths per
[testing](testing.md), then full lint and typecheck. Runtime tests are not a
substitute for real-provider latency or window-level acceptance.

## Changelog

### 2026-09-15 — Share prepared conversation file ownership

Prepared history may be supplied by the internal coordinator on confirmation.
It uses the same canonical preparation/materialization and resource-reservation
owner as a root conversation, before the parent publishes readiness. The durable
preparation receipt rejects changed replay. The parent freezes the prepared-history
hash (or no-history intent) when confirmation is first claimed, before any child
installation yields. Concurrent and ready confirmations must match that intent;
a ready child may only replay an already committed history installation. This
prevents a confirmation without history from publishing ahead of one that requires
it, and prevents adding initial history after publication. Parent migration 12
treats previously claimed operations as no-history, preserving their original
meaning. An ordinary opening can then start
execution independently. See [prepared conversations](session-import.md).

The separate durable preparation owner prevents file holds from depending on a
live-message mailbox that imported history never creates. Fake pending messages
and generation receipts were rejected because they conflate storage with execution.

### 2026-09-11 — The rail holds a row for a substream being created

**What changed:** From the keystroke that submits the launch composer until the
created child is navigated to, the center rail draws that substream's row: the
child row's arrow and selected background, the title skeleton the launch header
already shows, last in the list. **New substream** stops being the current row
for that stretch.

**Why:** Creation is two round trips, and across them the rail showed no row for
the conversation on screen — the plus row it was opened from was the only thing
claiming to be where the reader was, which is not what that row means anywhere
else. The row now says what is happening in the place the answer will land.

**Considered and rejected:** Drawing the first line of the opening message as
the row's title, which would leave the row unchanged at the swap: the server
derives the provisional title, and a second answer to what a first line is
would disagree the moment either changed — the same reason confirmation answers
with the title rather than letting the caller compute one. Seeding a fabricated
substream id so the row could come from the directory list: an id that names no
conversation is the one thing the creation path refuses to invent. Keeping
**New substream** current as well, which would mark two rows.

**Consequences:** The row is a `div`, not a button — there is nowhere to
navigate to, because the reader is already on the surface it stands for. Its
name is therefore screen-reader-only text on the row itself rather than an
`aria-label` on a control, and it sits outside `.workstream-context-copy`
because the compact rail hides that element with `visibility: hidden`, which
takes what is inside it out of the accessibility tree as well as off the screen;
the skeleton beside it is `aria-hidden`, so the row is named once.

The rail now depends on the id preparation reserves, not only on the creation
being in flight: readiness broadcasts the directory from inside the
confirmation, so the child's real row can arrive before the response does, and a
placeholder that watched only the in-flight state stood beside it. Anything that
changes what `prepare` answers with, or provisions the child under a different
id than it reserved, will show up here as one conversation with two rows.

### 2026-09-11 — Manage conversations from their center-sidebar rows

Added the requested parent and child context menus because navigating a row
should also provide its rename, share-link and archive actions. The center
sidebar menu presentation is owned here alongside the row hierarchy; parent
archive continues to use the landing mechanism owned by
[work-stream pinning](workstream-pinning.md). Publication is deliberately one-way
in this menu, matching the requested action set rather than adding Make private.
One menu component derives its labels from the row target, and one link-copy
helper serves both sidebars and the header. Future changes must keep the clicked
row independent of the selected conversation, preserve successful-action
telemetry, and discard errors from an operation the reader has left.

### 2026-09-11 — The starting context is not drawn, and one substream has one name

**What changed:** Two things a person saw when they opened a substream, both
reported from a real window on the same screen.

The child's feed no longer renders its frozen starting context. The
**Context from the main conversation** section and the `SubstreamContext`
component that drew it are gone; nothing else about the context moved. It is
still frozen at creation, still installed into the child, still carried over the
child's socket, and still what `sendReady` and the local-cache mirror wait for —
so the observer that holds it in the query cache stays, subscribed and never
read, with the reason written at it.

And the rail now draws the row for the **open** substream from that child's own
detail rather than from the parent's copy of it (`railChildren` in
`workstream.tsx`) — the same entry the header renders, so the two cannot
disagree. Every other row still comes from the parent's directory.

**Why:** The context section was the first and largest thing in a conversation
somebody had just started — a summary of the work stream they had branched out
of moments earlier, restated to them unasked, above their own opening message,
and unstyled, because no stylesheet ever claimed `.substream-initial-context`.
The launch surface already shows what is being branched out of, at the moment
that matters. Rejected: styling it, or collapsing it behind a disclosure. Both
keep a model-facing artifact in the reader's transcript and only argue about how
much room it takes; the reader is not the audience for it. Also rejected:
removing the client's context plumbing along with the section. It gates sending
and the offline mirror, so removing it would have been a readiness change
wearing a rendering change's clothes.

The two names were one fact arriving from two objects with very different
clocks. The child knows its new name at once — its room publishes the rename,
and its snapshot carries the title — while the parent's registry, which the rail
reads, only converges after the child's directory effect has been through the
Queue and back. Measured in a real window: header at 4.1s, rail at 18.1s,
fourteen seconds in which the substream had two names.

**Considered and rejected, in this order.** Having the naming pass write the
parent's registry directly: the parent deliberately believes the child about
what the child is called, through the ordinary projection, and a second writer
into that row would be a second authority for it. Then — and this one was built,
pushed, and taken back out — patching the child's title into the *cached*
directory from the rename event and the snapshot. It reads as the obvious fix
and it loses a race: `applyMetadata` replaces `privateChildren` wholesale for
any frame whose waterline is not lower, a frame generated inside the window
still carries the provisional title, and nothing advances that waterline while
the projection is in flight. Staged in a real window it lost the race on the
ordinary path — a cold open inside the window has the parent's frame arriving
after the child's snapshot, so the rail went back to the provisional name — and
closing *that* would have needed either a forged waterline, which would make the
client reject the parent's real frames including membership changes, or a
client-side ledger of not-yet-projected titles, which is the second authority
again in a smaller box. Reading the child's detail at render time has no race to
lose: there is one value, and both the header and the row show it.

**What a future change has to respect:** the starting context stays reachable to
the runs and the readiness gate and unreachable to the reader; the parent's
projection stays the only writer of the cached child directory; and a surface
that shows a conversation's name beside another view of the same conversation
resolves both from one value rather than keeping two that agree eventually.

Shipped in #689.

### 2026-09-10 — A substream carries a model pin of its own

**What changed:** The launch composer offers the same developer-mode model
selector the work-stream launcher does, `POST …/substreams/confirm` accepts a
`modelOverride` beside its opening message, and confirmation writes it onto the
child's own row instead of the `null` it always wrote. The created substream
shows that pin back, locked, in its conversation composer.

**Why:** A pin exists so somebody can ask what a piece of work looks like on
another model, and a substream is where a piece of work most often gets isolated
enough to ask that about. Until now the only way to run one somewhere else was
to start a whole new work stream, losing the branch context the substream exists
to carry.

**Considered and rejected:** Inheriting the parent's pin when the composer names
nothing. It would have made the child follow the model the parent was pinned to
without anybody choosing that, changing what every existing unpinned substream
of a pinned work stream does — those all follow the flag today — and it would
have made the composer's **Default** entry, which says it follows the flag, a
lie. Also rejected: carrying the pin on `prepare` rather than `confirm`.
Preparation runs before the composer has been submitted, so it would reserve a
child under a decision the person had not made yet.

**Consequences:** The pin is decided once, at the first confirmation, and a
retried confirmation replays rather than re-pinning — a pin changed between the
two is ignored, which is what keeps it fixed for runs that may already have
started. Nothing reads a parent's pin on the child's behalf, so a substream that
should run where its parent runs has to name that model itself. That includes
the client: `launchedSubstreamDetail` takes the pin as a required argument
rather than an optional one, because the seed it builds spreads the parent's
detail — which now carries a `modelOverride` — and a caller that omitted it
would hand the child its parent's pin in the one window somebody is looking at
the conversation they just created.

### 2026-09-10 — A substream is started from a composer, not from two modals

**What changed:** The title dialog and the context-preview dialog are gone. Both
entry points now open a launch surface inside the work stream's own column: the
branch point and the four turns before it faded above one composer, or an empty
body when the substream was started from the sidebar. The message typed there is
the substream's first instruction — `POST …/substreams/confirm` carries it,
writes the canonical turn through the child's product path and wakes its loop —
and the child is titled from that message's first line, in `title_status =
'naming'`, so [the naming pass](workstream-naming.md) replaces it exactly as it
does for a work stream. Preparation no longer takes a title.

**Why:** Starting a substream and starting a work stream are the same act, and
only one of them looked like it. The modal flow asked for a title before there
was anything to title it after, then asked the person to review a summary they
had no way to change — a decision presented as a choice, twice, before they
could say what they wanted. Meanwhile the thing they came to do, sending the
first instruction, happened *after* creation, in a second surface, so an
abandoned substream was an ordinary outcome rather than an anomaly.

**What was rejected, and why it matters to the next change:**

- **Preparing when the surface opens, to hide the summary latency behind the
  typing.** It buys perhaps a second, and costs a reserved child, a spent
  Gemini call and a live operation every time somebody opens the composer and
  changes their mind — plus the cancellation path that has to clean all three
  up, which is what the modal flow spent its complexity on. Everything now
  happens on the keystroke that submits, and the optimistic surface is what
  covers the wait. If that wait is ever measured as the problem, prepare early
  *and* bring back cancellation together; one without the other leaks children.
- **Sending the opening message from the client after confirmation, over the
  child's socket.** It is the path an ordinary message takes, but a new child
  has no socket yet, so it would mean opening one and holding the message
  across a navigation — two failures to reconcile where creation has one, and
  an empty substream on screen whenever the second half lost. The message rides
  the confirmation instead, which also hands the client the canonical `turnId`
  it seeds the destination with.
- **Making the faded turns the substream's context.** They are provenance: what
  the child inherits is still the platform's summary policy through the cutoff,
  and the child's feed shows it. Changing what is inherited is a policy change
  under **Extending initial context**, not a side effect of what a surface
  draws.

**What a future change has to respect:** nothing may be reserved while the
launch surface is open; the operation and message ids live with the launch
state, so a retry resumes rather than reserving again; the opening turn stays
idempotent by `clientMessageId`; and a substream's name is written through the
child's address, never the parent's.

### 2026-09-09 — The starting context's prose is an injectable gateway

**What changed:** `SubstreamCreationService` takes an optional
`SubstreamSummaryGateway`. Without one it builds the platform's, exactly as
before; with one, that gateway answers the summary transform instead of the
shared inference stack. `substreamSummaryGateway` is the platform's, now
exported under a name rather than living as a private closure.

**Why:** A demo workspace is seeded by playing a pack through Rally's own write
paths, and the demo pack now opens a substream. Creation's one structured
inference was the only thing in that path that would have reached a model. Three
problems with letting it: the summary is prose a presenter reads, so an
unscripted one is content nobody approved; it is a live call inside the minutes
an operator spends waiting for a workspace they are about to present; and it
makes two preparations of the same pack differ.

**The alternative that was rejected** was a new context strategy — a "verbatim
text" plugin the demo policy selects. That is the extension point this document
points at, and it is the wrong one here: the recipe is a durable, versioned,
hash-pinned record of *how* a context was derived, and the demo does not want a
different derivation. It wants the same derivation with the model's answer
supplied. A strategy would also have to carry the text through the recipe and
the persisted operation, where a retry after a deployment validates old plugin
versions, and the pack would become part of that compatibility surface.

**What a future change has to respect:** the gateway replaces the source of the
summary's prose and nothing else. Every other property — the frozen capture, the
pinned recipe, the durable part checkpoints, the authority recheck after
inference, and creator-only initial membership — is the production path's, and
a caller that passes a gateway gets all of them. Do not widen it into a seam for
skipping the capture, the checkpoints, or the recheck.

### 2026-09-08 — Make child lifecycle and notifications reachable

Added child rename/archive controls and forwarded recipient-addressed child
notifications. Previously membership could succeed while every child notification
was dropped, and no archive control existed. Child rename now updates its own
registry and cache instead of overwriting Main. Parent attention aggregation was
rejected: child and Main counters have independent ordinals, and combining them
would also broaden parent participation. The notification delivery barrier keeps
Main state unchanged. Existing membership rules remain; email reply routing is
outside this change. Runtime tests cover delivery, delayed removal/archive,
archive/restore, open-socket writes and rename; desktop tests cover cache isolation. Real Electron QA confirmed
rename updates the child row and title while preserving Main, and archive removes
the child and returns to Main with both Main participant facepiles retained.

### 2026-09-08 — Expose conversation membership in title-bar facepiles

The selected conversation now displays its title and a right-aligned participant
facepile. One tooltip covers the entire title-bar facepile and reads
“Participants of <conversation name>”; per-person tooltips are suppressed there,
including for present members. While naming is pending the tooltip uses “Participants
of this conversation” to avoid exposing the provisional request. The header keeps
Main’s authoritative appearance while displaying the child title and roster.
Child facepiles omit presence rings because workspace presence is scoped to the
whole work stream and cannot establish that someone is viewing the private child. The parent participant section remains in the sidebar, including while
a child is selected. Previously the compact header omitted participant controls,
so child add/remove APIs had no direct entry point. Both locations reuse the
participant dialog and preserve their parent or child target.
Self-removal from a child returns to Main regardless of the cached scope value.

Confirmed child mentions now call the parent's child-membership API before sending
through the conversation socket. Generic message confirmation only writes the
child's local roster and cannot grant discovery or socket admission; using it alone
could claim to add someone who still could not open the child. Existing members
can be mentioned directly. Adding still requires parent access and cannot remove
the final child participant. If admission fails, the message draft is restored;
if sending fails after admission, accepted membership changes remain in place.
The workstream-open tests cover child add/remove isolation, mention admission
ordering and refusal. The real-workerd creation test now admits another member,
sends a mention through the child, and verifies its durable transcript target;
skipping person-mention writes makes that assertion fail. Real Electron QA covers
creation with the temporary empty-context strategy, child discovery, add/remove,
and expanded/compact controls. Follow-up Electron QA verifies Main facepiles in
both locations, child-only title-bar removal, and parent management from the
sidebar while a child is selected. Provider credentials remain required for live
summary preparation and multiplayer message classification.

### 2026-09-05 — Review closes authority, delivery and ordering gaps

Child admission now requires current parent access as well as exact-version
child membership. Preparation commits and confirmation transitions check the
parent's current authority, and readiness refuses any undelivered membership
effect. Earlier service-level checks alone left gaps across awaited RPCs.
Child-only projections are receipted without aggregating a nonexistent Main
viewer; automation parents keep their local aggregation callbacks. Discovery
has its own control clock because consuming unpublished workspace viewer
versions could strand notifications. The creation dialog locks pending inputs,
clears failed-attempt state on edit and handles cancellation's empty response;
inviters update the selected child's roster cache on successful admission.
Regression tests deliberately remove each backend fix to prove these failures.

### 2026-09-05 — Private substreams with replaceable starting context, shown beneath Main

**What changed:** Added a single parent-owned creation flow with versioned
strategy/selector/transform hooks, independently pinned creator-only membership
and a Gemini summary policy. Preview and feed share one read-only renderer so
history strategies display their actual selected text, not just a message
count.

The center sidebar now groups indented child rows beneath Main, with the create
action last. Corner connectors and creator avatars make the hierarchy visible.
Collapsed mode keeps the same navigable icon rail and the resize logic is
unchanged.

**Why:** The requirement is to evolve how every substream starts without
building multiple creation implementations or offering a strategy picker.
Real-window acceptance exposed a local-root/external-address FK mismatch on the
first instruction and a Main snapshot that erased control-owned child
discovery; both now have regression coverage.

**Considered and rejected:** Copying live transcript and run state instead of a
persisted capture and selected seed: the capture keeps the reviewed context
across retries and stops inherited instructions from executing. Creating
another work stream, or relying on broad parent membership: the parent remains
the discovery and membership authority, and either alternative would break
private child semantics. REST recovery for the baseline reset: socket-only
baseline reset and end-to-end timing prevent REST recovery races and
misleading latency claims. In the sidebar, the reference mockup's separate
palette and oversized cards were not adopted, and connectors use the
sidebar-border token rather than muted text: Grok Bot's packaged weak-border
palette uses approximately 10% foreground opacity, so the hierarchy stays
subordinate to the conversation labels in both appearances.

**Consequences:** Private directory suppression is specific to WorkstreamDO:
automation parents still consume child status locally even when they do not
forward the original child projection. The sidebar presentation must not
change child discovery or membership.

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

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/substream-creation.ts` | Versioned recipes, frozen captures, context parts and preview contracts. |
| `apps/api/src/services/substream-context.ts` | Static strategy, selector, transform and membership registries; platform policies; validation and hashes. |
| `apps/api/src/services/substream-context-summary.ts` | Structured Gemini summary through the shared inference gateway. |
| `apps/api/src/services/substream-creation-service.ts` | Authenticated prepare, confirm, cancel, archive and participant coordination. |
| `apps/api/src/durable-objects/workstream-do.ts` | Creation receipts, ready-child directory and authoritative private membership. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Frozen source export and immutable inert child seed. |
| `apps/api/src/durable-objects/substream-context-transfer.ts` | Frame-sized initial-context snapshot transfer. |
| `apps/api/src/services/substream-initial-context.ts` | Inert seed to model-context conversion. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | Main/child navigation, the creation state machine and its cache seeding, rename and archive dialogs. |
| `apps/desktop/src/renderer/components/substream-launch.tsx` | The launch surface: branch provenance, the composer that starts a substream, and the optimistic turn while one is being created. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Renders that surface in place of the conversation's own three rows, and `branchProvenance`, which chooses the turns it fades. |
| `apps/desktop/src/renderer/lib/launched-conversation.ts` | The optimistic opening transcript and the child detail both launchers seed. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Authoritative baseline, initial-context assembly and readiness. |

## How it works

The middle sidebar puts the main conversation first, then one full-width row per
child, then **New substream**. Every row is the navigation sidebar's work-stream
row — borderless, one 36px leading mark slot — and the mark is what tells them
apart: the work stream's own tinted icon for the main conversation, a Tabler
`border-corner-pill` branch line for a child, and for creation the `↳` the
main feed's **New substream** control is drawn with.
Compact hides the titles and swaps a child's branch line for the first character
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

### The launch surface

Both entry points replace the conversation's three rows — header, transcript,
composer dock — with the launch surface, inside the same column. The work
stream's sidebar, inspector and retained parent socket do not move, because the
work stream has not been left; only its middle column has something else in it.

The geometry is `.workstream-launch-screen`, shared with the work-stream
launcher and described in [`workstream-creation.md`](workstream-creation.md):
while composing, the launcher's own dock padding and raised composer; on submit,
`is-launching` lands and every value settles on the conversation's own, so the
composer travels into the dock rather than being replaced by it.

What sits above that composer is the difference between the two entry points:

- **From a message** — the turn that was branched from and the four before it,
  faded out upward under a gradient mask and inert to the pointer. They say what
  is being branched out of. They are not what the substream inherits: the
  platform still freezes a summary of the conversation through that cutoff, and
  the created child shows it under **Context from the main conversation**.
- **From the sidebar** — nothing, exactly as the work-stream launcher's body is
  empty. A substream started there branches from wherever the conversation has
  reached, so there is no particular moment to be looking at.

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
   Nothing else is sent on the creator's behalf: the substream is working on the
   instruction it was created with, and on nothing else.

Confirmation still answers without an opening message, and creates the idle
child it always did. The desktop no longer asks for one.

### The name a substream is given

A substream is named the way a work stream is, by
[the naming pass](workstream-naming.md) — the same code, not a copy of it: its
provisional title is the first line of the opening message, its `title_status`
is `naming`, and its header shows the same skeleton until the pass answers. The icon
that pass chooses is stored on the child like any other, and drawn nowhere: a
substream's rows keep the branch line, and the child directory payload behind
them carries no appearance. Both passes are addressed at the child —
`workstreamId` plus `substreamId` through the identity and message ports, and
the rename event published into the child's own room. The child's rename reaches
the parent's registry through the ordinary common projection, which is what
converges every sidebar's row.

Before this, children were provisioned `settled` and no pass ever ran on one; a
run settling in a child called the refresh pass with the parent's address and
its own dropped, which found the parent's own title and, in the overwhelming
case of a settled work stream, did nothing. That is fixed rather than preserved:
`settleAgentRun` passes the substream it ran in.

### Membership, rename, archive and notifications

The child title-bar facepile opens its participant dialog. Adding grants explicit
child membership after checking parent access; removal and self-removal use the
same authority, and the final participant cannot leave. Confirming a mention of
somebody outside the child adds them through that API before sending.

A child row's context menu offers **Rename** and **Archive substream**.
`PATCH /conversations/:parentId/substreams/:substreamId` changes either `title`
or `archived` per request. Rename writes the child's own title; its common
projection updates the parent-owned child registry. The desktop applies child
rename events only to the child detail, never the workspace's parent row.
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
- Feed and model use the same installed selected parts. The complete source
  capture is preparation provenance, not a second hidden model-context source.
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
  naming pass at the parent, which leaves the child in `naming`.
- `apps/api/test-workers/demo-seeder.test.ts`: a demo pack opens a substream
  through this service on real workerd — prepare, confirm, and one participant
  add each — with the summary gateway answering from the pack, and asserts the
  child's own roster, initial context, transcript and loop while the parent's
  main conversation stays untouched. Proved to fail with the gateway
  substitution removed, which sends creation's one inference to the provider
  double the suite forbids.
- `apps/desktop/src/renderer/components/substream-launch.test.tsx`: the branch
  turns above the composer, the words enter hands to creation, the optimistic
  turn and skeleton while it runs, and the draft coming back on a failure.
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

### 2026-09-10 — The sidebar's creation mark matches the feed's

Both entry points into a new substream now use the same `↳`; the sidebar's row
previously used a Tabler `plus`. See
[conversation-surfaces.md](conversation-surfaces.md) for why the arrow was the
one to keep. Whichever mark either control uses, they have to stay the same one.

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

### 2026-09-09 — Move the message cutoff into the turn's action row

**What changed:** The per-message entry point left the identity line for the
turn's action row. Nothing about how a substream is created changed — only where
the control that starts one is drawn.

**Why and how:** The row is shared rendering, which
[conversation surfaces](conversation-surfaces.md) owns per this document's
**Boundary**; its entry there carries the reasoning and the constraints a future
change has to respect.


### 2026-09-08 — Review fixes for lifecycle and command boundaries

**What changed:** Child archive now stops the local agent through durable versioned delivery; title validation uses the 180-character contract. Nonparticipants and final-participant removal have distinct errors (`substream_participant_required` and `substream_last_participant`). Other refusals are `substream_member_needs_workstream_access`, `substream_archived`, and `substream_not_found`.

**Why:** Hiding an executing conversation left its agent running, and remote checks added latency to every command. Dialog failures and stale rename completions also needed explicit handling.

**Considered and rejected:** Per-command parent RPCs and a new restore-management screen. Restoration remains available through the existing API, with explicit UI copy. [Work-stream links](workstream-links.md) owns child-addressed links.


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

### 2026-09-05 — Separate parent sidebar context from child conversation context

Sidebar data, previews and management now use the retained parent snapshot. The
previous selected-feed wiring made shared chrome change when a child was selected
and could apply parent API responses to a child cache. Keep the two contexts
explicit; selecting a child must not change the scope of sidebar actions.

### 2026-09-05 — Show the relationship between Main and its substreams

The center sidebar now groups indented child rows beneath Main, with the create
action last. Corner connectors and creator avatars make the hierarchy visible
without adopting the reference mockup's separate palette or oversized cards.
Collapsed mode keeps the same navigable icon rail and the resize logic is
unchanged; this presentation must not change child discovery or membership.
Connectors use the sidebar-border token, not muted text: Grok Bot's packaged
weak-border palette uses approximately 10% foreground opacity, so the hierarchy
stays subordinate to the conversation labels in both appearances.

### 2026-09-04 — Private substreams with replaceable starting context

Added a single parent-owned creation flow with versioned strategy/selector/
transform hooks, independently pinned creator-only membership and a Gemini
summary policy. The requirement is to evolve how every substream starts without
building multiple creation implementations or offering a strategy picker.
Persisted capture and selected seed were chosen over copying live transcript
and run state so retries keep the reviewed context and inherited instructions
cannot execute. The parent remains the discovery and membership authority;
creating another work stream or relying on broad parent membership was rejected
because either would break private child semantics. Socket-only baseline reset
and end-to-end timing prevent REST recovery races and misleading latency claims.
Real-window acceptance exposed a local-root/external-address FK mismatch on the
first instruction and a Main snapshot that erased control-owned child discovery;
both now have regression coverage. Private directory suppression is specific to
WorkstreamDO: automation parents still consume child status locally even when
they do not forward the original child projection. Preview and feed share one
read-only renderer so history strategies display their actual selected text,
not just a message count.

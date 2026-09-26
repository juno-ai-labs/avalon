# Starting a work stream

Between pressing enter in the launcher and a work stream existing, Rally does
real work: it reserves an email address, writes the work stream and its opening
message, and starts a harness run. This document covers what the person who
pressed enter sees while that happens, and what the server does and does not make
them wait for.

The promise is that starting a work stream looks like opening one. The launcher
and the work stream being created are one element tree in one component, so the
change between them is a change of geometry rather than a change of screen, and
the composer is never unmounted across it. On the server, everything the response
does not depend on still waits for it anyway — deliberately, and after one
attempt at the opposite that the changelog records.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/screens/new-workstream.tsx` | Both states of the screen, the `launching` state that switches between them, the create mutation, and `launchedWorkstreamDetail` — the one place a launched work stream's cached detail is built. |
| `apps/desktop/src/renderer/lib/workstreams-cache.ts` | The pending-row rule on the shared list: `addPendingWorkstream`, `confirmPendingWorkstream`, `discardPendingWorkstream`, `keepPendingWorkstreams` (applied by every write that replaces the list), and `releasePendingWorkstreams`, the one path that may remove a pending row. |
| `apps/desktop/src/renderer/lib/launched-conversation.ts` | `optimisticOpeningTranscript`, the one place either launcher's optimistic turn is built, and the detail a launched substream is seeded with. |
| `packages/ui/src/styles/app.css` | The `.workstream-launch-screen` block at the end of the file: every geometry difference between the two states, and the two keyframes. Shared with the substream launcher, which renders the same three rows inside a work stream's own column ([`substream-creation.md`](substream-creation.md)). |
| `apps/desktop/src/renderer/components/composer-input.tsx` | `ComposerInput`, the single composer element the hand-off is built around. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MessageBlock`, which renders the optimistic opening turn exactly as the work-stream screen will render the persisted one. |
| `apps/desktop/src/renderer/components/agent-work-timing.tsx` | `AgentWorkTiming`, the work timer the optimistic surface starts and the created work stream keeps counting from. |
| `apps/api/src/durable-objects/substream-agent.ts` | The authoritative create, opening turn/run, feed snapshot, and synchronous child-effect drain used by the route-activation fence. |
| `apps/api/src/durable-objects/workstream-do.ts`, `workspace-do.ts` | Aggregate the child's metadata, commit the authoritative workspace directory row, and prove it exists before the D1 route becomes active. |
| `apps/api/src/routes/workstreams.ts` | `POST /workstreams`. |
| `apps/api/src/services/workstream-object-creation-service.ts` | Post-cutover creation receipt, identity anchor, the Space memberships the new Channel is born with, verified-to-active route transition, hierarchy drain, and email activation. |
| `apps/api/src/services/workstream-service.ts` | The fenced pre-cutover create path retained until Durable Object authority opens. |
| `apps/api/src/observability/tracing.ts` | The custom spans every step of the create is measured with; the names and the queries are in [`performance-tracing.md`](performance-tracing.md). |

### The launcher and the work stream are one screen

`NewWorkstreamScreen` holds a `launching: LaunchingWorkstream | null` state. It is
set **in the same commit as the create request**, from what the person typed, and
it is what makes the work stream appear to open on the keystroke rather than on
the response.

The component renders one tree in both states, a three-row grid of header, body,
and composer dock:

- **Not launching** — the header is the **Participants** bar, the body row is
  empty, and the dock carries only the composer. The retired Welcome back dashboard,
  attention list, and suggested-work shelf no longer sit between opening Rally
  and starting a work stream.
- **Launching** — the root additionally carries `workstream-screen`, the header
  is 44px around the Channel name (or a title skeleton), and the body holds a
  transcript. The Participants bar leaves with the resting state. 44px because that is the row the conversation this
  becomes actually uses: `.grokbot-workstream-header`, which every conversation
  renders, takes the screen's header track down from the base 55px. The header
  takes that height on the frame the class lands rather than growing into it;
  only the collapse back, which the failure path takes, is eased.

The launching state deliberately declares no geometry of its own. Because its
root carries `workstream-screen`, it inherits that screen's dock padding and
column width from the same rules the real screen uses. Anything restyled for the
launcher is written under `:not(.is-launching)` instead, so the moment the class
lands the element is already dressed as the screen it is about to become and the
navigation that follows changes only the data. The composer is no longer one of
those things: it is the same message capsule at the same width on both sides of
the hand-off, per
[`conversation-surfaces.md`](conversation-surfaces.md).

The sidebar's plus first collects the required Space and Channel name in the
standard creation dialog, then opens the launcher at
`/spaces/:spaceId/workstreams/new` without creating a Channel. That is the only
route to the launcher: there is no Space-less one, because every Channel is
started from a Space. The launcher starts with focus in the opening-message text
input. The Channel name travels with that route and is committed only when the
opening message is sent; participants are chosen in the header's
**Participants** bar before that request. The creator's own chip leads the bar
and has no remove control. In a personal Space the bar shows the Space's roster
read-only and says it is managed by the Space. `NewWorkstreamScreen` remounts
the whole launcher for every navigation that opens it, because React would
otherwise keep one instance across a change of Space or a second opening of the
same one: the people picked for one Channel were sent with the next, and the
composer's autofocus did not run again. Each opening therefore starts with
nobody picked and focus in the message box, never in the Participants bar. The
unsent draft and its attachments are cached by Space, so the remount loses
nothing typed, and the key stays stable throughout the launch hand-off. The sidebar lists existing work streams without
a placeholder row for the unsent draft.

### What moves

Two things animate, and they are the whole transition:

- **The composer stays put.** It is the same DOM element throughout, and now
  also the same width and the same capsule on both sides, so nothing about it
  moves: it is the fixed point the eye holds while the header, the transcript and
  the rows around it change. It used to settle instead — dock padding, stack
  width, background, border, radius, shadow and text height each transitioning
  from a launcher treatment to the conversation's — and the transitions that
  carried it are gone with the difference they existed for.
- **The transcript assembles.** The opening turn and the work timer each rise
  7px into place on a 70ms stagger, so the transcript reads as being built rather
  than revealed.

Nothing here is bespoke motion: `prefers-reduced-motion` is cut globally by the
`*, *::before, *::after` kill-switch block in `app.css`, which flattens every
duration *and every delay* to a single 0.001ms iteration.

The composer is `WorkstreamComposer`, the one a Channel's own feed uses, so
the opening message gets the same `@` list (Rally and the Organization's
members), slash commands and draft handling as every message after it. It is
handed a `ComposerConversation` standing for the Channel about to exist: the
Participants bar's people, the Space's scope, and no run. Mentioning a person
seats them in the Channel: `submit` unions the mentioned people into the
request's `participantIds`, because a name that only reached the text would
arrive with nobody attached to it. In a personal Space the composer first asks
**Add participant?** for anybody outside the bar, as it does in a feed. The
composer clears the draft on submit and restores it if `submit` rejects, so the
too-long refusal and a failed create both throw rather than return.

### What the optimistic surface shows

The opening turn is a `Message` built from what was typed and from the files that
were attached — a create carrying only attachments is one `submit` accepts, and
its turn is a bubble of tiles. It is rendered through the same `MessageBlock` the
work-stream screen uses, with the current user as author so it takes the same
own-turn treatment. The header shows `TitleSkeleton` — the same skeleton the created work stream shows while the naming agent answers, so
the header does not change hands at the swap; it is already waiting for the same
name.

### The Channel is listed before it exists

The sidebar shows the Channel on the keystroke, and the row it shows is the
Channel's own. `submit` mints the id, lists a row under it with
`pending: true` in the Space the request names, and sends
the id as `workstreamId`; the server creates the Channel under it. Every later
answer (the create's, a directory page, a refetch) carries a row with the same
id, which replaces the pending one in place, so there is nothing to match up.

A pending row stays until a server row for its id replaces it, and leaves
otherwise only through `releasePendingWorkstreams`: the create's confirm or
discard, or an authoritative eviction of the id. It is drawn dimmed and inert,
skipped by background sockets and the landing route, and never persisted.

The server claims the id with the create receipt, in one statement, only if no
conversation already has it: the receipt's unique id covers receipt-path
creates and a `NOT EXISTS` on the `workstreams` anchor covers the rest. A taken
id is refused `409 workstream_id_unavailable`. Parents anchored without a
receipt (`bootstrapWorkstreamRuntimeEnvironment`: Spaces, Sidekicks, digests,
Slack tasks) hold the other half: they anchor first, then refuse if a receipt
already names the id, so whichever statement runs first owns it.

### The room snapshot has to describe the run

A work stream's socket sends a `snapshot` on subscribe, and the client replaces
its whole cached detail with it. The snapshot therefore has to carry everything
`GET /workstreams/:id` carries, and it now describes the latest harness run
rather than naming only its id — both read the same columns, in the same order,
and map them through the same `memberSafeHarnessError`.

The order matters as much as the columns. A `scheduled` run is inserted with a
NULL `started_at`, and SQLite sorts NULLs last under `DESC`, so ordering by it
would select an *older* run — and a snapshot does not merge, it replaces, so that
wrong answer would overwrite the right one the client already held. Both queries
order by `created_at`.

### The swap

On success the destination is seeded before `navigate`: a `WorkstreamDetail`
built by `launchedWorkstreamDetail` and one canonical ordered-transcript
snapshot.
The work-stream screen shows its full-screen `Opening work stream…` state
whenever *either* of those two queries is loading, so seeding one is not enough —
both launchers write both, and a work stream that was just created therefore
never shows it. It paints immediately, with the same turn in the same place, at
the same geometry.

The typed create authored its opening turn and seeds it. The work-stream screen
withholds its `Ready to begin` empty state while a run is scheduled or running,
because an admitted run is already work even before its Workflow starts. The
create response names that opening row as `turnId`; the
optimistic snapshot uses exactly that canonical identity, so the socket upsert
replaces it by identity rather than asking timestamps or equal text to prove
that two rows are the same turn.

### What the server makes you wait for

Everything. `POST /workstreams` finishes the participant and attachment checks,
the address reservation, the Space placement below, the authoritative
SubstreamAgent work-stream/opening
turn/run write, the canonical `transcript_turn_upserted` publication, and the
Workflows round trip that starts the run. The placement already applied the
provisional `channels` row, since the Channel's parent and the directory are
both in `WorkspaceDO`, and the create changes the minimal D1 route from
`verified` to `active`, and activates email —
only then does it answer. The one thing off the path is the naming call, which
was already deferred before this module existed.

**The Space placement is one WorkspaceDO call, whatever the number of Spaces**:
`reserveChannelInSpaces`, after the address reservation and before the D1
anchor. In one SQLite transaction it resolves General when the request named no
Space, writes each membership `active`, stages the defaults each Space hands a
new member, reserves the main conversation with its provisional directory row,
and records which Space supplied which reader on the Channel's own authority
(`applySpaceAccessSource` with `commitWithPlan`, called inside the object rather
than over RPC). It answers with the Spaces it read, and the
coordinator derives the opening audience from them with the same
`resolveSpaceWorkstreamStart` the object used for the directory row's scope.

It replaced a staged sequence that was shaped for a Space directory and a
Channel parent in different objects: `ensureGeneral` (when no Space was named),
then per Space `prepareSpaceMembership` and `finalizeSpaceMembership`, then
`reserveChild`, then per Space `applySpaceAccessSource`, then a
`flushProvisionalDirectory` run beside `initialize` (a no-op by then, because
`reserveChild` already applies the provisional row), plus a
`cancelSpaceMembership` per Space on failure. For the common create that names
no Space, that was five sequential calls and one concurrent call into the same
object; it is one.

The one case the call cannot finish alone is an Organization with no General
yet. Making General provisions its own conversation (the D1 reads and object
reservations [`spaces.md`](spaces.md#regional-impact) lists), which is not a
write the object can take in a transaction, so it answers `general_missing`,
the coordinator runs `SpaceService.ensureGeneral`, and asks again. That happens
once per Organization.

What a Space hands *down* is not on the path: the resources and Sidekick
recommendations a Space's defaults give a new member Channel are staged in the
placement's transaction and delivered over `ACTIVITY_QUEUE`.

The explicit drain is not the normal delivery mechanism. Ordinary mutations
use the child and parent SQL outboxes plus alarms. Creation overrides any alarm
backoff because route activation is a publication fence: no reader may observe
an active D1 route before the WorkspaceDO socket can serve that work stream.
Every receiver is idempotent, so retrying after an ambiguous RPC completes the
same drain rather than creating a second row.

That is deliberate, and it is a reversal: deferring the route activation and the
Workflows round trip to `waitUntil` was built, reviewed, and taken back out. The
changelog below records why. The wait is not what the person who pressed enter
experiences — the launch surface above is — so buying it back with a durability
risk was the wrong trade.

### The Space a Channel is born in

Every Channel belongs to at least one Space, and creation is where that becomes
true. `POST /workstreams` carries `spaceIds`, defaulted to empty, and **empty
means General** — `SpaceService.ensureGeneral` makes the Organization's General
Space if this is the first thing that ever needed it.

**A Channel created without a named Space is therefore born Organization-wide**,
whatever scope the caller asked for: General is Organization-wide, its source
unions into the birth audience, and a source only ever widens. That is true of
a connector ingress that resolved a personal scope,
of session import, of `createFromOpportunity`, and of the demo seeder — which
refuses a pack room declared `personal` by name rather than seeding it
Organization-wide ([`demo-workspaces.md`](demo-workspaces.md)). A Channel that
is meant to stay personal has to be born in a personal Space that names it.

The audience the Channel opens with is derived from those Spaces rather than
taken from the request. `resolveSpaceWorkstreamStart` runs the same
`effectiveChannelAudience` algebra the rest of the Space module uses over the
named Spaces plus the caller's own request: if any of them is Organization-wide
the Channel opens `workspace` and the requested participants are kept as
participants; otherwise it opens personal over the union of the Spaces' rosters
and the caller's. A requested participant who is in none of the named Spaces'
rosters is seated directly in the Channel; that descendant access exposes only
the containing Spaces' presentation metadata through associative reach and does
not make them a Space participant. The Spaces' `defaultResourceIds` are unioned with the
caller's origin resources, so a Channel started in a Space begins with what that
Space hands down.

**The memberships, the reservation and the provenance commit together.** The
order between them used to be load-bearing: reserving the main conversation
arms the parent's recovery alarm, which delivers the provisional directory row
itself if it wins the race with the coordinator, so a settlement any later could
publish a Channel that is Organization-wide and in no Space at all. In one
transaction there is no later: the directory row is written in the same commit
as the memberships, so it can only ever appear placed, and a refusal anywhere in
it (a Space the caller cannot reach, an archived Space, a source whose Space
moved) rolls all of it back. Which Space reaches a Channel is recorded before
`initialize`, because that is true of the Channel whether or not anybody ever
opens it.

A Space refusal therefore leaves nothing in WorkspaceDO and nothing in D1 but
the idempotency receipt. It does now follow the address reservation, because
the directory row the same transaction writes carries the address, so a refused
create leaves an unactivated address row keyed to the id the receipt holds; a
retry under the same create key reuses it. A failure *after* the call (the D1
anchor, `initialize`) leaves an active placement and a listed Channel whose
conversation may never open, which is the residue to prefer: nothing is
cancelled, the retry reuses the same id, and the call is idempotent for it (an
active membership keeps its generation and the reservation finds its child
registered). A replayed receipt reconciles through
`reconcileReplayedSpaceMembership`, which uses the staged `addChannel` path
rather than this call because the Channel already exists and its audience has
to be widened through its canonical operations.

Two creation paths do not go through here, and both call
`placeConnectorChannelInGeneral` for the same step. The Slack agent opens a
Channel for a Slack member with no Rally identity and provisions the
conversation itself; it keeps this module's former staged ordering to place it —
`reserveChild` on the parent first, with its directory delivery deferred, then
the conversation, then the placement, then the flush — because the placement
addresses the parent authority, and because a Channel is not listed until it has
a home. The local development seed route restores a captured fixture into
objects it provisions under the ids the fixture chose, and waits for each
Channel to reach the Organization's directory before placing it — a wait that
is acceptable only because that route is development-only. Without the parent
authority that row's arrival announces, a placement is refused
`conversation_parent_missing`. [`spaces.md`](spaces.md) owns both.

The one saving kept is that the participant and attachment checks run
concurrently. Both are no-ops when there is nothing to check, so it costs
nothing in the common case, and the pair is settled rather than raced: a request
that violates both is refused with `invalid_workspace_member` every time rather
than whichever rejection landed first.

## Invariants

- **The composer is one element across the hand-off.** Rendering it from two
  branches would remount it, restarting its internal state and splitting the
  transition into two elements swapping places — which is the thing the animation
  exists to avoid. `carries the same composer across the hand-off` in the screen's
  test asserts node identity for exactly this reason.
- **The launching state states no geometry of its own.** Every launcher-specific
  rule is written under `:not(.is-launching)`. A rule added the other way round —
  styling `.is-launching` directly — will drift from `.workstream-screen` and
  reintroduce a visible jump at the navigation, which no component test can see.
  The header's height is the single exception, because a grid track sized `auto`
  cannot take a number from the screen it becomes: the header names the
  destination's row itself, and the test that holds it there has to read the row
  that *applies* to the destination rather than the one underneath it.
- **Nothing the optimistic turn's position depends on may be eased into place.**
  The surface does not decide when the swap happens — creation can finish in one
  round trip — so a transition the turn's geometry rides is a jump whose size is
  whatever was left of it. Motion is for things the turn does not sit on: the
  dock's participant row, which is below the transcript, and the turn's own 7px
  arrival.
- **`launching` is set in the same commit as the request, and cleared on
  failure.** An optimistic turn stands for a work stream that does not exist; it
  cannot remain on screen next to an error explaining why it never will.
- **The work timer's `startedAt` is frozen at submit** and seeded onto the
  created run, so the timer does not restart at the swap. It is optimistic by the
  create's duration — the run really started a few hundred milliseconds later —
  so the elapsed time can be corrected slightly downward when the canonical run
  arrives. In practice the difference is smaller than the second the label
  rounds to and is not visible; a change that makes creates much slower, or the
  label finer-grained, would make it so.
- **A turn attributed to someone who did not write its words carries the label
  that says so.** The suggested-work brief is stored as the selecting member's
  own turn, and own turns render without a header. `MessageBlock` makes the
  header conditional on `contextLabel` rather than on authorship alone for
  exactly this case; removing that exception leaves a member reading a brief
  under their own name with nothing on screen to account for it.
- **Oversized opening text gets the same actionable refusal for Main and child
  creation.** The length-only guard runs before session processing; accepted
  bodies still pass all authentication, validation and scope checks.
- **The opening turn commits and publishes before the harness launch.** Both
  events land in the same Durable Object log, and a client resyncing from a
  sequence must not see the run start before the canonical turn that triggered
  it. There is no compatibility-message publication beside this path.
- **A run row that says `running` must have a Workflow behind it.** `attempt_id`
  and `lease_expires_at` stay NULL until the Workflow admits the run, and nothing
  reaps that shape: `stop` only records a request a live workflow has to observe,
  `retry` refuses a `running` work stream, and no screen offers either. A start
  that is not awaited can therefore leave a work stream permanently "working".
- **A route is not active until WorkspaceDO can serve it.** New routes begin in
  `verified`; the child and parent outboxes drain, `hasWorkstreamDirectory`
  proves the authoritative row, and only then may D1 advertise `active`.
  Optimistic UI is not a substitute for this fence because another client may
  list the workspace immediately.
- **The pre-flight checks run ahead of the reservation.** A create that is going
  to be refused must not leave an address reserved for a work stream that never
  exists. The one refusal that follows the reservation is a Space's, because the
  placement transaction writes the directory row that carries the address; see
  [The Space a Channel is born in](#the-space-a-channel-is-born-in).
- **A Channel's Organization-side birth is one transaction.** Memberships,
  Space defaults, the parent reservation with its provisional directory row, and
  the Space sources commit in `reserveChannelInSpaces` or not at all; creation
  never stages a `joining` row or an `add` intent.
- **A create that names no audience writes a private work stream.** `POST
  /workstreams` carries no scope — a request on the wire cannot claim one — so
  the creator is seated beside whoever they named, those active participant rows
  are the room's complete reader authority, and the scope reaches the
  object as an argument rather than a hardcoded `'workspace'`. A create path
  added later inherits that: omitting the scope is a decision for private, and
  only a caller that *knows* the audience is wider — an ingress reading a public
  channel — says `workspace`. See
  [`data-model.md`](data-model.md#2026-08-21--a-work-stream-is-born-private).
- **Whether the people named are told is the caller's to say, not the object's.**
  `POST /workstreams` passes `notifyParticipants`, because its
  `participantUserIds` is people somebody picked in "Add people"; each of them
  then gets the activity event and the Slack-or-email notification that being
  added to an existing work stream produces, behind their own directory row, and
  the creator gets neither. A connector ingress passes nothing and stays quiet:
  the same field carries a conversation's resolved roster, and nobody in a Slack
  channel was added by anybody. A create path added later inherits neither
  behaviour — seating somebody and telling them are separate effects, and the
  second one has to be asked for. The notification also does not arrive on the
  awaited drain below: it rides the ordinary outbox and alarm, so it lands after
  the response. See
  [`workstream-durable-object.md`](workstream-durable-object.md#2026-08-25--being-named-at-creation-tells-the-person-when-the-caller-says-to).
- **`ComposerInput` drops a keydown belonging to an IME composition before any
  host sees it.** The guard is the first statement of its `onKeyDown`, so
  mention navigation, popover dismissal, and slash commands are all written as
  though compositions did not exist. A host that adds key handling inherits
  that; a change that moves the guard below `onKeyDown?.(event)` hands every
  host the keys the IME still owns, and each of them would have to learn the
  rule again.
- **Both launchers seed both queries, through `launchedWorkstreamDetail`.** The
  work-stream screen loads on either query being absent, so seeding one of the
  two still lands on the full-screen orb; and two hand-built details would drift
  into one path quietly losing its work timer at the navigation.
- **A scheduled create is never “Ready to begin.”** `scheduled` is the durable
  state between run admission and Workflow start, not an empty work stream. An
  empty or lagging ordered snapshot keeps the routed opening turn as a
  compatibility overlay, and even a suggested-work create with no locally known
  turn withholds the empty invitation until the run settles.
- **Concurrent refusals are reported in a fixed order.** The pre-flight pair is
  settled and rethrown in order, so one bad request always gets the same code.
- **The room snapshot answers exactly what `GET /workstreams/:id` answers.** Same
  columns, same ordering, same error mapping. A snapshot replaces the client's
  whole detail rather than merging into it, so any field the two disagree on is a
  field where the socket overwrites the truth with something else.

## Boundary

This module owns the create path and the screen in front of it: the optimistic
surface, the transition, and which steps of `POST /workstreams` a caller waits
for.

It does not own what happens afterwards. The transcript, the socket, and the
work-stream screen's own loading states belong to that screen. Naming belongs to
[`workstream-naming.md`](workstream-naming.md) — the provisional title and the
`naming` grace this surface renders a skeleton for are its contract, not this
one's. Draft text and attachments belong to
[`composer-drafts.md`](composer-drafts.md); this module clears the draft on
submit and restores it on failure, and changes nothing else about it. Address
allocation and delivery belong to
[`workstream-email-addresses.md`](workstream-email-addresses.md); this module
only decides that activation stays on the create path, ahead of the response.
Run admission, leases,
and scope belong to [`agent-harness.md`](agent-harness.md). A work stream a
connector creates does not come through this screen at all, and its initial scope
and starting participants are decided by the conversation it was summoned from —
see
[`connectors.md`](connectors.md#a-work-streams-audience-is-the-conversation-it-started-in).

## Failure modes and limits

- **The create fails.** `launching` is cleared, the launcher comes back with the
  typed message restored into the composer unless a newer draft has replaced it,
  and the error renders under the composer. No work stream is left on screen.
- **The workflow start fails.** The run is marked `failed`, the work stream's
  `harness_status` is set to `failed`, a `harness_status_changed` event is
  published so anyone already watching is not left on a `running` row, and the
  caller gets a 503. The work stream and its opening message exist either way;
  the client clears its launch surface and restores the composer.
- **The directory handoff fails.** The product row and outbox remain durable,
  but the D1 route remains `verified`, so the work stream is not advertised
  without a WorkspaceDO row. Retrying the same client message resumes the
  idempotent drain and activation.
- **A create is refused.** The participant and attachment checks run ahead of the
  reservation deliberately, so a create that is going to be refused does not leave
  an address reserved for a work stream that never exists. The message-length
  check is the same rule one step earlier: `requireSendableMessageLength` is the
  first middleware on the route, ahead of `zValidator`, because a length is the
  one bound here whose remedy belongs to the person who typed it.
- **The message is too long.** Over `MESSAGE_MAX_CHARACTERS` the create is
  refused with `message_too_long` and `MESSAGE_TOO_LONG_MESSAGE`, and the
  composer refuses it before that without a round trip at all. Nothing is
  truncated on either side: the person is told to shorten it and keeps every
  character while they do.
- **Typing during the launch window.** The composer stays live; anything typed
  lands in the `new-workstream:<workspaceId>` draft and is not carried into the
  created work stream. Attachment tiles and the file input are frozen for the
  window, because the files they stand for are already on their way into a
  message.
- **Limits.** `MESSAGE_MAX_CHARACTERS` is 100,000 — the ceiling on one composed
  message, and the only bound the opening message has. The description derived
  from it is bounded separately and far lower; see
  [`workstream-descriptions.md`](workstream-descriptions.md). `HOME_HAND_OFF_MS` is 190ms and must equal the stylesheet's
  `launch-home-leave` duration. The arrival stagger is 70ms per index with a 60ms
  lead-in. Geometry transitions run at 240ms and the header at 220ms.

## Testing

- `apps/api/test-workers/space-creation.test.ts` —
  `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/space-creation.test.ts`.
  On real workerd: the coordinator makes exactly one WorkspaceDO call once
  General exists; the membership is born `active` with no intent; a refused
  source write rolls back the membership, the parent and the directory row; a
  failure after the commit keeps the placement and a retry under the same key
  finishes on it; a Space's defaults are staged by the placing call.
- `apps/desktop/src/renderer/screens/new-workstream.test.tsx` —
  `pnpm --filter @rally/desktop exec vitest run src/renderer/screens/new-workstream.test.tsx`.
  Covers the surface appearing on the keystroke, composer node identity across
  the hand-off, and the optimistic turn being taken back when the create fails.
  The suite clears the draft cache in `beforeEach` and stubs `ResizeObserver`;
  a test that skips either will see a restored draft from its predecessor.
- The pending row: `lib/workstreams-cache.test.ts` (kept across a replacing
  write, replaced by its server row, confirmed under a different id, evicted, discarded),
  `lib/workstream-state-store.test.ts` (a versioned common half ends it),
  `lib/use-workstreams-query.test.tsx` (the refetch keeps it and then takes the
  fetched row), and `components/sidebar.test.tsx` (drawn dimmed and inert).
  The server half is in `apps/api/test/workstream-scope.test.ts`, on the
  checked-in migrations: a named id is used and replayed, and one held by a
  receipt or by a receipt-less anchor is refused, a receipt reserved without the
  id replays, and bootstrap refuses an id a create has claimed.
- `apps/desktop/src/renderer/screens/workstream-open.test.tsx` and
  `apps/desktop/src/renderer/lib/transcript.test.ts` cover the destination side:
  a scheduled run cannot paint `Ready to begin`, and an unmatched routed opening
  turn remains until the ordered projection supplies its logical replacement.
- `apps/desktop/src/renderer/components/composer-input.test.tsx` —
  `pnpm --filter @rally/desktop exec vitest run src/renderer/components/composer-input.test.tsx`.
  Covers the shared composer's keyboard contract: Enter submits, `shouldSubmitOnEnter`
  can refuse it, and nothing an IME composition owns reaches either this
  composer's submit or the host's own `onKeyDown` — including that the blocked
  keystroke is left uncancelled, so the IME still receives it. `lib/ime.test.ts`
  covers the predicate underneath.
- `apps/api/test/workstream-create-latency.test.ts` —
  `pnpm --filter @rally/api exec vitest run test/workstream-create-latency.test.ts`.
  Covers what the create finishes before it answers: the run started, the route
  active, no address reserved for a create it is about to refuse, and one stable
  code for a request that violates both pre-flight checks. That last one loops
  five creates rather than asserting once — a fixed order that only held by luck
  would pass a single run.
- `apps/api/test/message-length-limit.test.ts` —
  `pnpm --filter @rally/api exec vitest run test/message-length-limit.test.ts`.
  Covers the ceiling from both sides: the guard's exact boundary on both routes,
  the sentence itself, that an unreadable body is left to the validator, and the
  incident this module's changelog records — a description derived from a
  message at the ceiling, parsed through `InitializeWorkstreamObjectInputSchema`,
  which is the schema that refused the create in production.
- `apps/api/test-workers/message-to-output-pipeline.test.ts` — follow-up messages
  use the addressed SubstreamAgent socket on real workerd, remain idempotent
  across hibernation, return correlated failures for malformed commands, and
  reject an oversized message without closing the connection.
  The composer's own length guard on that screen is untested; see
  [`potential-bugs.md`](potential-bugs.md).
- `apps/api/test/substream-agent-snapshot.test.ts` — includes the case that the
  snapshot describes the latest run rather than naming its id. The snapshot
  replaces the client's whole detail, so a field dropped there is invisible until
  something notices a missing timer.
- `apps/api/test-workers/durable-object-runtime.test.ts` — inserts a backed-off
  child directory snapshot, explicitly drains both parent hops, and proves the
  WorkspaceDO row exists while both SQL outboxes are empty. This guards the
  verified-to-active creation fence in the real Workers runtime.
- `apps/desktop/src/renderer/styles/app.css.node.test.ts` — guards what a
  component test cannot see: that the launching state states no geometry of its
  own, and that `.new-workstream-home` reserves its scrollbar gutter so the home
  content does not shift sideways when the suggestions below it grow past a
  viewport. It reads the stylesheet from disk, so it is typed by
  `tsconfig.node.json` and named `.node.test.ts` to keep `node:fs` out of the
  renderer program.
- These are component, stylesheet, and service tests, so none of them sees the
  transition. **A change to the animation or to either state's geometry still has
  to be looked at in a real window** — see [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).

## Changelog

### 2026-09-25 — A Channel is placed and reserved in one WorkspaceDO call

**What changed:** The coordinator's Space placement and parent reservation are
one RPC, `WorkspaceDO.reserveChannelInSpaces`, which commits the memberships
(born `active`), the Space defaults, the parent with its provisional directory
row, and the Space sources in one SQLite transaction. It replaces
`ensureGeneral`, `prepareSpaceMembership` and `finalizeSpaceMembership` per
Space, `reserveChild`, `applySpaceAccessSource` per Space, the concurrent
`flushProvisionalDirectory`, and `cancelSpaceMembership` per Space on failure.
The call now runs after the address reservation, because the directory row it
writes carries the address.

**Why:** Creation is the slowest thing a person waits on, and those calls were
sequential hops into one object: five and one concurrent for the common create
that names no Space, and 3N+1 plus the concurrent one for N named Spaces. They
were shaped as a saga when the Space directory and the Channel's parent were
different objects; both are WorkspaceDO SQLite now, so a transaction gives the
same guarantees the ordering was buying, and more: a Channel can no longer be
listed with a half-written placement at all.

**Considered and rejected:** One RPC that ran the same stages inside the
object, which keeps the `joining` state and its recovery intent for no reader.
Running the call before the address reservation with no address on the
provisional row, which would keep a Space refusal ahead of the reservation but
publish a directory row that changes a moment later; the team may prefer that
trade, and it is a small change to make. Placing a replayed receipt through the
new call: the Channel already exists there, and its audience has to be widened
through its canonical operations, which the birth-mode source recording assumes
already happened.

**Consequences:** A Space refusal now leaves an unactivated address row keyed
to the receipt's id, which a retry reuses. A failure after the call leaves an
active placement and a listed Channel, as a failure after the old settlement
did, and a retry under the same client key converges on it; a client that never
retries leaves that Channel listed with a conversation that never opened.
Adding an existing Channel to a Space is `addSpaceChannel`
([`spaces.md`](spaces.md#membership)); the staged membership RPCs are deleted.

### 2026-09-24 — The caller names the Channel's id, so the sidebar lists it on the keystroke

**What changed:** `POST /workstreams` accepts an optional `workstreamId`.
The launcher mints one, lists a pending row under it in the shared
work-stream list, and sends it; the server creates the Channel under that id or
refuses it with `workstream_id_unavailable` if any conversation already has it.

**Why:** The screen opened the Channel on the keystroke while the sidebar said
"No channels yet" until the list refetched. A row listed early under a local
id has to be matched to the server's id later, and is stranded if the match
never comes. Giving the Channel its id before the request removes the matching:
every later answer is the same row.

**Considered and rejected:** A side store of stand-ins read next to the list,
which served one screen and needed its own reconciliation. A synthetic row
with a local id, swapped for the server's id on the answer, which is the same
two-id problem inside the cache. Letting the receipt's unique index alone guard the id: Channels created without a receipt
(connectors, imports, Sidekick parents) are only in the `workstreams` anchor,
so a caller could have aimed a create at one. A Space or Sidekick id can even
be seen before its anchor exists, when its provisioning is replayed, which is
why bootstrap checks the receipts too.

**Consequences:** Every writer that replaces the list has to keep pending rows,
and only `releasePendingWorkstreams` (confirm, discard, eviction) may drop one;
a new writer that bypasses `setCachedWorkstreams` must call
`keepPendingWorkstreams`. The id is in the receipt's request hash, so a receipt
reserved by a Worker from before the field is also matched against the hash
without it, or a retry across a deploy would read as a conflict. Browser
import runs in another window with its own cache, so it does not list early
yet: that needs a message from the import window to the main one, and the
server field already covers it. The uniqueness check reaches one regional D1,
so an id already used in another region is not refused. A random UUID does
not collide, and a client that forces one affects only its own workspace,
whose objects are named per region.

### 2026-09-24 — Participants are picked in the header, and every launcher has a Space

**What changed:** The Space-less `/workstreams/new` launcher is gone; the path
now redirects to `/`. The Space launcher's header carries the **Participants**
bar that only the Space-less launcher used to show, and the participant chip,
**Add people** button and **Add people** dialog above the composer are deleted.
The fallbacks that used to open the Space-less launcher now go elsewhere: an
empty Organization lands on General's dashboard, a Channel moved out of the last
placement in a Space opens that Space's dashboard, and the `workstreams/new` and
`automations/new` deep links open the app. A deep link that changes organization
parks on an inert `/opening` route instead. The launcher renders
`WorkstreamComposer` (see [`conversation-surfaces.md`](conversation-surfaces.md)).

**Why:** Once the sidebar's creation dialog required a Space (2026-09-20), the
Space-less launcher was reachable only through fallbacks, so the header's
recipient bar people remembered effectively disappeared. The launcher then had
two pickers for one list, in two places, depending on how it was opened.

**Considered and rejected:** Routing the fallbacks to General's launcher. The
deep-link handler has no Space directory to find General in, and a fallback
that opens a composer nobody asked for is the accident the 2026-09-09 entry
removed.

**Consequences:** A new way into the launcher has to name a Space. The
launcher's resting header is 48px, so the header shrinks to the conversation's
44px row at the swap, as the Space-less launcher's always did. A mentioned
person is seated at submit rather than drawn into the Participants bar while
typing; deleting the mention is how to leave them out.

### 2026-09-21 — Direct Channel participants need not join its Spaces

**What changed:** Creation accepts a requested Channel participant who is not on
any containing personal Space roster. Their Channel access grants only
associative ancestor presentation metadata.

**Why:** Space membership and Channel readership are separate permissions. The
old refusal forced broader Space membership merely to make the hierarchy
discoverable.

**Considered and rejected:** Automatically joining the participant to every
Space would grant rosters, defaults and Space writes beyond the requested
Channel access.

**Consequences:** Creation still derives the Channel audience as the union of
its direct request and Space sources. Ancestor visibility does not widen the
Space audience.

### 2026-09-20 — Name and place a Channel before composing it

**What changed:** The unified sidebar plus collects a required Space and Channel
name, then hands both to the existing composer. The eventual `POST /workstreams`
carries that settled title and Space alongside the opening message and chosen
participants; no Channel is created by the setup dialog itself. The picker is
enabled only after Space bootstrap and contains only destinations the person may
write, so it cannot carry a transient or `through_channel` placement into the
composer.

**Why:** Creation controls were scattered across the Spaces heading and every
Space row, while the top-level launcher left placement implicit. A single setup
step makes the two durable identity choices explicit without weakening the
existing rule that pressing Enter on an opening message is the creation boundary.

**Considered and rejected:** Creating the Channel as soon as the setup form is
submitted. That would move the durable boundary ahead of participant selection
and the opening message, leaving abandoned empty Channels when setup is cancelled.

**Consequences:** The selected name and Space remain route state until the
opening message is submitted. Telemetry marks the sidebar entrypoint at that
handoff, and the launching header can show the settled name immediately.

Shipped in #876.

### 2026-09-19 — The launching header is the destination's row, immediately

**What changed:** The launching header's height is 44px, the row
`.grokbot-workstream-header` gives the conversation screen, rather than 55px,
the base row underneath it, and it takes that height on the frame `is-launching`
lands rather than growing into it over 220ms — the transition now rides
`:not(.is-launching)`, so only the collapse back is eased.
`.workstream-launch-screen > .launch-header` also gives back two things it
inherits from the `.workstream-header` class it borrows its dressing from: the
`min-height: 48px` that outranked both stated heights, and the hairline
`border-bottom` the destination does not draw.

**Why:** The endpoint had been the base row since before the newer header
existed, and `min-height` outranked both stated heights anyway — so the header
never collapsed while composing (the launcher reserved a header's worth of empty
pane) and sat at 48px while launching against a destination of 44. Releasing the
`min-height` made the growth real for the first time, and review caught what that
exposed: the surface does not decide when the swap happens. `prepare` returns an
already-prepared receipt without doing any work, so a retry can finish inside
220ms, and a header caught half-grown hands its transcript to a 44px row. A
transition the optimistic turn's position rides is a jump whose size is whatever
was left of it.

**Considered and rejected:** Gating the hand-off on `transitionend` — it makes
navigation wait on motion that a reduced-motion setting removes entirely and an
interrupted transition never finishes. Dropping the shared `.workstream-header`
class, which is also where the header's padding and border come from. And sizing
the launching header from the destination at runtime, a measurement to keep in
sync in place of a number the test already pins.

**Consequences:** `app.css.node.test.ts` asserts the endpoint against
`.workstream-screen:has(> .grokbot-workstream-header)`, and asserts that the
shared rule — the one both states take — declares no transition at all. A screen
that renders a different header, or a header restyled to a different row, fails
there rather than showing up as a step at the swap, which is what the old
assertion, pointed at the base row, allowed for two header generations. The
launcher's header now appears rather than opening; what motion the hand-off has
left is the dock's participant row and the transcript's own arrival. "Dressed
exactly as the screen it is about to become" is true of the border too, which it
had not been: the rule blinked off at the swap, at 55px and at 44px alike.

### 2026-09-19 — A Channel is born in a Space, and settles it before it can be seen

**What changed:** `WorkstreamCreationFields` carries `spaceIds` in place of
`projectId`, and an empty list means General. The audience is derived from the
named Spaces through `resolveSpaceWorkstreamStart` rather than taken from the
request; a requested participant outside every named Space's roster is refused
with `space_audience_incompatible`. The staged memberships now settle **before**
the main conversation is reserved, and the Channel's Space sources are recorded
between the reservation and `initialize`. `initialize` and the directory flush
run beside each other, as they always have.
`apps/api/test-workers/space-creation.test.ts` covers both halves on real
workerd.

**Why:** Every Space invariant is written about every Channel in the
Organization, and a Channel that could be created outside one made all of them
conditional. Deriving the audience is the same requirement from the other side:
a Channel started in an Organization-wide Space is readable by the Organization
the moment it exists, and a creation that opened it personal and let a later
membership widen it would have published a narrower Channel first and disclosed
it second.

The ordering was a bug this change found rather than a design it started with.
The settlement used to run after `initialize` and before the directory flush, on
the reasoning that the flush is what makes a Channel visible. It is not the only
thing that does: reserving the main conversation arms the parent's recovery
alarm, which delivers the deferred provisional directory row itself if it wins
the race. The new workerd case saw exactly that — a failed creation's Channel
listed with `scope: "workspace"` and `spaceIds: []`.

The first attempt at that fix moved the directory flush *behind* `initialize`,
because the flush was publishing the Channel while its placements were still
`joining` — a Channel in no Space, which is a state no surface may render. Then
the settlement moved ahead of `reserveChild`, which is what this entry is
about, and the placements became `active` before either call starts. The
serialization outlived its reason by one commit and cost a round trip on every
creation for nothing, so the two run beside each other again as they did before
this branch: they address different objects, and what the flush reads is the
reservation's own outbox rows at source version one, which `reserveChild` wrote
and `initialize` never touches.

**Considered and rejected:** Placing the Channel with a follow-up call after the
create returns. The PRD requires a named Space to be established with the
Channel or the creation to fail without publishing one, and a second call is
neither. Also rejected: keeping the settlement last and making the recovery
alarm skip a Channel with no placement. That would have made the alarm's
correctness depend on a Space fact it has no reason to know, and left the same
race for anything else that drains a parent outbox.

**Consequences:** A future change must keep the settlement ahead of
`reserveChild`, and that — rather than the order of `initialize` and the flush —
is what keeps a `joining` placement off the directory. Anything that moves the
settlement later has to re-serialize the pair, and should say so here rather
than leave the next reader to rediscover which constraint the serialization was
for. The residue swapped with the order: a failure after the
settlement now leaves an active membership for a Channel whose conversation may
never open, which the retry under the same create key reuses, and which the
cutover's walk skips — it reads what is already placed off the membership row
itself, which is the state a placement produces and cannot disagree with.

### 2026-09-17 — Keep grant handoff off ordinary creation

Ordinary and system-created workstreams retain the existing local participant
writer. Scoped sharing prepares only the addressed authorities when the first
invitation is created. Eager handoff during creation was rejected because it
added D1 and parent/source RPCs before route activation and moved ordinary
message-driven participant additions onto a cross-object path before sharing
was needed. First-share preparation already has durable receipts and recovery;
creation must not duplicate that work. Slack and digest producers continue to
use `provisionWorkstreamObject`; replay keeps their initial roster intact.

### 2026-09-14 — New work streams start with the opening message

**What changed:** Both workspace and project launchers focus the message composer.
The recipient picker starts closed, and the sidebar no longer lists an unsent
draft as “New work stream.” The existing creation controls remain available.

**Why:** The recipient-first focus made immediate typing search people instead
of composing the opening message. The requested starting point is writing the
message, without a placeholder suggesting a work stream already exists.
Keeping the picker initially open and closing it from the composer's focus
handler would make the starting state depend on a second control's mount event;
it now starts closed directly.

**Consequences:** Recipient selection opens when the person reaches the recipient
field. Changing launcher draft identity remounts the composer to restore focus,
while the same draft keeps its composer across the launch hand-off. Future launcher changes must preserve initial composer focus and keep
unsent drafts out of the work-stream list. The earlier recipient-first launcher
and sidebar-label changelog entries describe the behavior before this change.

### 2026-09-10 — Project-owned creation uses the message capsule too

**What changed:** `layout="message-capsule"` is passed unconditionally, so the
project-owned launcher renders the same field as a workspace-level new chat and
as the conversation, rather than the toolbar layout the 2026-09-04 entry below
left it on. Its participant row is untouched. The composer no longer changes
treatment across `.is-launching`, so the transitions that travelled it are gone
and **What moves** above is one item shorter.

**Why:** The same reasoning as that entry, applied to the surface it left out: a
field that is dressed differently from the conversation's makes the launcher look
like a different product, and the field is the one element that survives the
hand-off. [`conversation-surfaces.md`](conversation-surfaces.md) owns the capsule
and carries the full entry.

**Consequences:** The developer-only model override moves from the toolbar pill
into the plus menu beside Attach files, where the capsule has carried it since
the 2026-09-04 entry. The footer hint is not rendered at all — the capsule hides
`.composer-hint` — so neither launcher now states the Enter-to-create keystroke
anywhere; the prop is still passed and one rule stands between it and being
shown.

### 2026-09-10 — The launch geometry and the optimistic turn are shared with substreams

**What changed:** `optimisticOpeningTranscript` moved out of this screen into
`lib/launched-conversation.ts`, unchanged, and `.workstream-launch-screen` gained
`grid-template-columns: minmax(0, 1fr)`. Starting a substream now renders the
same three rows through the same block; [`substream-creation.md`](substream-creation.md)
owns that surface.

**Why:** The substream launcher needed exactly this screen's optimistic turn —
the same revision, coverage and identity, because the same socket upsert
replaces it — and a second copy would have been a second answer to what those
are, with the copy that drifted being the one whose surface flickers at the
swap. The column track is the bug that sharing found: the rows alone left an
implicit `auto` column, which is max-content, so the first unbreakable line
placed in one of them sized all three wider than the pane and hung the dock off
its side. This screen never showed it because nothing in it declares `nowrap`.

**What a future change has to respect:** a rule written under
`.workstream-launch-screen` now dresses two surfaces. Anything true only of the
new-work-stream screen belongs under `.new-chat-screen`, which is what that class
is for.

### 2026-09-09 — The launcher is reached only by an explicit New action

**What changed:** Nothing in this screen. The screens that used to fall back to
`/workstreams/new` when what they showed went away — an archived work stream,
note, or project, a deleted automation, a work stream left or marked unread,
the not-found screen, the end of onboarding — now open the first sidebar work
stream instead. The composer opens for a New action or an empty workspace.

**Why:** The launcher had become the app's default home by accident of being
the safe route to leave for, so archiving the room someone was reading handed
them an empty draft rather than their next conversation. The rule, the
`skipWorkstreamIds` state that keeps the just-archived row from being reopened,
and the one deliberate exception are recorded in
[`workstream-pinning.md`](workstream-pinning.md#leaving-for-the-first-work-stream),
which owns the root route.

**Consequences:** `returnTo` still lets the sidebar's New close back to where it
was opened from; that state is set only by the New links and never by a leaving
screen.

### 2026-09-04 — New chat uses GrokBot's recipient-first launcher without losing create semantics

**What changed:** A workspace-level new chat opens with a `To:` recipient bar,
searchable people results, and the compact message capsule. Typing `@` opens the
inline mention list; attachments and the developer-only model override live in
the capsule action menu. Project-owned creation keeps its project participant
contract and existing toolbar. Both shapes still use the same durable create,
draft, attachment, mention, optimistic transcript, and failure-recovery paths.

**Why:** The old participant modifier and permanent toolbar made the rebased
launcher visibly different from the GrokBot conversation entry point. Removing
the controls outright would have made the visual rewrite a behavioral
regression, especially for model-pinned debugging and attachment-only creates.

**Consequences:** Tests for workspace creation interact with the recipient bar
and action menu; project tests interact with the project participant modifier.
The workspace launcher does not fetch the work-stream directory or suggested
work, so restoring either query would also restore the loading and layout churn
the focused launcher removed.

### 2026-09-02 — Follow-up creation now enters through the owning substream

**What changed:** The work-stream composer sends an idempotent `create_message`
command over the addressed SubstreamAgent socket. The former public message REST
route and WorkspaceDO relay were removed.

**Why:** A follow-up belongs to one child transcript and loop. Keeping admission
on that child's ordered connection gives creation, replay, feed updates, and
correlated failure one authority.

**Consequences:** Opening work-stream creation remains a parent bootstrap route.
Once the child exists, its conversation mutations use its socket.

### 2026-09-01 — The launcher opens on the composer, not a home dashboard

**What changed:** The not-yet-launching state no longer renders Welcome back,
Needs attention, or Suggested work. It opens as an empty composer surface and
keeps the same optimistic create transition after Enter.

**Why:** Work-stream navigation now owns ongoing work, so duplicating attention
and suggestion lists inside New work stream created a second, visually unrelated
home product between the person and the GrokBot-style conversation shell.

**Considered and rejected:** Restyling the dashboard to resemble GrokBot would
keep the redundant navigation model. Redirecting New work stream to an existing
room would remove the explicit create affordance.

**Consequences:** The launcher no longer queries the work-stream directory or
suggested-work endpoints. Its draft, attachments, mentions, and optimistic
creation path are unchanged; the workspace-level participant interaction was
later replaced by the recipient-first launcher recorded above.

### 2026-08-27 — The reduced-motion cut now zeroes delay, not only duration

**What changed:** The global `*, *::before, *::after` rule of the
`@media (prefers-reduced-motion: reduce)` kill switch in `app.css` now sets
`animation-delay: 0.001ms !important;` and
`transition-delay: 0.001ms !important;` alongside the duration zeroing it
already did.

**Why:** `.launch-arrival` — the opening turn and work timer rising into place —
staggers in from `opacity: 0` with `animation-delay: calc(var(--arrival-index,
0) * 70ms + 60ms)` and a `both` fill, so it is the *delay*, not the animation,
that holds each row invisible before it starts. Zeroing only the duration left
the two arrival rows blank for their full 60ms and 130ms holds under reduced
motion — which is exactly the motion "What moves" above already claimed was
cut. The kill switch predates this document and had never been checked against
a delay-based animation.

**Considered and rejected:** A `.launch-arrival`-specific override, since this
stagger was the animation found to be affected. Rejected because the global
block exists precisely so a new staggered or delayed animation added later is
covered automatically; a local override only this class carries would need to be
copied by whatever adds the next one, which is the failure this fix removes
rather than repeats.

**Consequences:** "flattens all of it" in *What moves* is now actually
enforced rather than aspirational. Any future animation that leans on
`animation-delay` or `transition-delay` for sequencing is covered by the same
global rule and does not need its own reduced-motion carve-out — provided the
delay is declared in CSS; motion driven from script (an explicit `behavior`
option, a `setTimeout` hold) is out of the cascade's reach and has to read the
preference itself, per the same-day entry in
[`transcript-scrolling.md`](transcript-scrolling.md). `app.css.node.test.ts`
pins both declarations, and pins that the kill switch owns the only
`!important` delays in the stylesheet, so neither a change to the block nor a
higher-specificity delay can reopen the hole silently.

Shipped in [#376](https://github.com/juno-ai-labs/avalon/pull/376).

### 2026-08-27 — Creation hands off one canonical turn identity

**What changed:** Both creation endpoints return `turnId`, and the launcher
seeds its ordered transcript under that exact identity. The object publishes the
opening `transcript_turn_upserted` as part of the canonical append path; the
separate `message_created` compatibility publication is gone.

**Why:** A create previously exposed the same durable row as a message in its
HTTP response and as a turn in the canonical socket. That forced the renderer to
reconcile two vocabularies and allowed the compatibility frame to race the
ordered turn. Equal text and nearby timestamps cannot establish identity.

**Considered and rejected:** Keeping the old response key for Electron rollout
compatibility. There are no deployed users to protect, and accepting both names
would leave ambiguity at the exact protocol boundary this change closes.

**Consequences:** A newly created turn is optimistic only in availability, not
in identity or order. API and Electron versions must move together; old clients
fail their strict response parser instead of silently composing a second feed.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

### 2026-08-27 — The composer owns IME composition, so no host has to

**What changed:** `ComposerInput` drops any keydown belonging to an in-flight
IME composition as the first statement of its `onKeyDown`, before the host's
handler and before its own Enter. The predicate both it and
`use-mention-navigation.ts` read is `renderer/lib/ime.ts`, which is where the
reasoning now lives; the work-stream composer's own copy of the guard is gone.

**Why:** the guard first landed as a copy in each of three separate keydown
handlers, and in this one it sat *below* `onKeyDown?.(event)` — so a host still
received the Enter and the Tab that commit a composition, and the work-stream
composer's slash-command hijack could still run a command (`/stop` among them)
on a keystroke that was only finishing a Japanese word. Pushing it
into the primitive was chosen over fixing the three copies because every host's
key handling is mention navigation, popover dismissal, and slash commands, and
none of those wants a composing key: there was no host to keep the escape hatch
for. On macOS the IME's candidate window covers those popovers anyway, so a
dismissal the host performed would be a state change nobody could see.

**Consequences:** a host may assume its `onKeyDown` never fires mid-composition,
and the prop says so. Anything that needs those keys — a composer that wants to
watch a composition as it happens — has to take them from the composition events
rather than from `onKeyDown`, or move the guard, which is the invariant above.
A field that is *not* a `ComposerInput` still keeps its own copy: the onboarding
organization-name input and the header's inline rename editor both do.

### 2026-08-26 — The scheduled hand-off cannot regress to “Ready to begin”

**What changed:** The work-stream screen now treats both `scheduled` and
`running` as active creation states when deciding whether the empty invitation
is legal. Its transcript reconciliation also retains a routed message until an
ordered message with the same durable, client, elicitation, suggestion, or tool
identity exists.

**Why:** A newly created work stream first showed its optimistic opening turn and
work timer, then the first authoritative snapshot replaced `running` with the
short-lived `scheduled` state. The empty-state predicate inferred activity only
from the running timer, so that valid intermediate state painted “Ready to
begin” for several seconds. When an ordered transcript snapshot lagged its
message page, the compatibility filter discarded the opening message merely
because it was settled human text, making the false empty state visible.

**Considered and rejected:** Delaying navigation until Workflow admission. The
launcher exists so creation already looks open while durable work completes,
and adding another server wait would trade a truthful intermediate state for a
slower hand-off. Also rejected was trusting the optimistic cache indefinitely;
the ordered transcript still replaces it once the same logical turn arrives.

**Consequences:** No payload that says a run is admitted or executing may invite
the participant to start it again. Compatibility rows are reconciled by stable
identity, not by message type, so rolling deployments and temporarily incomplete
ordered projections do not erase already-visible work.

### 2026-08-25 — Creation is a notifying path, on request

**What changed:** `POST /workstreams` passes `notifyParticipants`, so everybody
picked in "Add people" is told they were added — the invariant above. No other
caller of the creation service passes it.

**Why:** the create path seated people and told nobody, which made "Add people"
the one way of putting somebody in a work stream that reached them through no
channel at all. The flag exists rather than the object deciding for itself
because `participantUserIds` is also where a connector ingress puts a
conversation's resolved roster, and those two lists are not the same event.
[`workstream-durable-object.md`](workstream-durable-object.md#2026-08-25--being-named-at-creation-tells-the-person-when-the-caller-says-to)
owns the reasoning and the effects; this document owns only which caller says yes.

**Consequences:** a new create path is quiet unless it opts in, and opting in
means asserting that its participant list is people somebody chose.

### 2026-08-24 — The launcher's `@` names a person inline instead of opening a dialog

**What changed:** The composer's `@` control on this screen opened the **Add
people** dialog and typing `@` did nothing. It now opens the shared mention
list over the workspace's members — first row selected, arrow keys walking it,
`Enter` taking it, `Escape` dismissing it — and picking someone writes their
name into the opening message *and* adds them to the pending participant list.
Names the list knows are highlighted in the draft the way they are in a work
stream. The dialog is unchanged and still reached from the participant row.

**Why:** The same `@` did three different things across the three composers a
person moves between — a dialog here, an inline list of connections in an
automation, an inline list of people in a work stream — and only two of them
answered the keyboard. The pick has to add the participant because this screen
has nothing to mention someone *into* yet: the create request carries
participant ids and no mention spans, so a name left in the text alone would
reach the server attached to nobody. Adding on pick is the same silent toggle
the dialog performs, and lands in the same avatar row a few pixels above.

**Consequences:** Deleting the name from the draft does not remove the
participant — the row above the composer owns that, as it owns every other way
someone is added here. A future create that carries mention spans should revisit
the add-on-pick, not the list.

### 2026-08-24 — One ceiling on a composed message, and a refusal a person can act on

**What changed:** `MESSAGE_MAX_CHARACTERS` (100,000) is the single bound on the
opening message, on a reply, and on every schema either travels through.
`requireSendableMessageLength` runs ahead of `zValidator` on `POST /workstreams`
and `POST /workstreams/:id/messages` and answers `message_too_long` with
`MESSAGE_TOO_LONG_MESSAGE`; the composer refuses the same message with the same
sentence without sending it. The description the create derives no longer
inherits the message's bound — `provisionalWorkstreamDescription` takes the
opening *line*.

**Why:** The route took 50,000 characters and the object's `objective` took
4,000, and the gap was a working create path for messages nobody sends and a
broken one for the pasted templates people actually open work streams with. A
message in the gap passed the route, reserved an email address, wrote its D1
rows, and then failed `ProductRequestSchema` inside the SubstreamAgent with
`invalid_product_request` — which reached the person as "The work stream could
not be loaded", a sentence about reading a work stream, on a request that was
creating one, naming nothing they could do about it. It happened in production
on 2026-08-24 and left an orphaned `verified` route row and a `reserved` receipt
behind it.

The two bounds disagreed because they were two numbers. They are now one, and it
sits in `@rally/contracts` where the composer reads it too, so the surface that
accepts a message and the object that stores it cannot drift apart again.

**Consequences:** Truncation was considered and rejected: a silently shortened
message is one whose author does not know what Rally read. Raising the
description to match the message was rejected for the reason
[`workstream-descriptions.md`](workstream-descriptions.md#2026-08-24--the-provisional-description-is-the-opening-line)
records — it is a sidebar line and a classifier input backed by a 4,000-character
column CHECK, not a place to put a paste. A create path added later gets the
guard by registering the middleware; a bound added to a composed message
elsewhere is a second number, and this changelog is the argument against it.

### 2026-08-21 — A create that names no audience writes a private work stream

**What changed:** `POST /workstreams` still carries no scope, and the work
stream it produces is now `personal` — the creator plus whoever they named in
`participantUserIds` — instead of `workspace`.
`WorkstreamObjectCreationService` passes the scope explicitly into
`initialize`, which used to hardcode `'workspace'`, and `WorkstreamService.create`
stops losing the scope its connector callers computed.

**Why:** Work started here was published to the whole workspace at the moment
of creation, and closing it again was something the person had to think to do.
The rest of this module is built around a create that answers in one round
trip; the audience it answers with should be the one that costs nothing to
widen and cannot be taken back once wrong. See
[`data-model.md`](data-model.md#2026-08-21--a-work-stream-is-born-private) for
the full reasoning, the paths that still say `workspace`, and what was rejected.

**Consequences:** The screen this module owns is unchanged — the optimistic
surface renders the server's row, so the **Private** badge and the sidebar's
privacy marker simply appear on the work stream the swap lands on. A create
path added later decides its scope deliberately: omitting it is a decision for
private.

### 2026-08-20 — Every awaited step of the create is a named span

**What changed:** `POST /workstreams` opens a `workstream.create` span and hands
it to `WorkstreamObjectCreationService.create`, which opens a child span per
awaited step — the receipt, the email-address reservation, the D1 batch, the
object initialize, both effect flushes, the directory probe, the route
activation, the receipt completion. These are custom spans on Cloudflare's
automatic tracing, so the room's own spans and the D1 and Durable Object calls
the platform instruments nest underneath without anything being propagated by
hand. The flow also emits one `perf_flow` log row carrying the whole breakdown.

**Why:** This document already says that everything the response does not depend
on waits for it anyway, deliberately — which makes the create the longest thing
a person waits on in Rally, and made "it feels slow" unanswerable. The only
measurement was `http_request`'s total duration: eleven awaited round trips
behind one number, so the question of whether the cost is the email reservation,
the Durable Object initialize, or the directory probe could not be asked without
adding a temporary log and deploying it.

**Considered and rejected:** Cutting or deferring work on the create path to
make it faster before knowing which part was slow. The 2026-08-18 entry below is
the last time that trade was made and had to be put back, and this document's
opening already says the deferral experiment was reverted; guessing again
without a measurement would repeat it. Also rejected: timing the create as one
number per stage in the existing `api_operation_outcome` telemetry, which is
bucketed to five ranges by design and cannot locate a step.

**Consequences:** Nothing about what the caller waits for changed — every span
wraps a call that already existed, in the same order. A step added to `create`
should get a span in the same change, or the trace quietly attributes its cost
to whichever span follows it. The service's authority read is named
`workstream.create.authority.read_recheck` because the route has already made
the same read, and the trace is where that duplicated round trip is now visible.
See [`performance-tracing.md`](performance-tracing.md), including its rule
against adding an OpenTelemetry package.

Shipped in #203.

### 2026-08-18 — Route activation waits for the WorkspaceDO directory

**What changed:** A new D1 route now begins `verified`. Creation explicitly
drains the SubstreamAgent outbox to WorkstreamDO, drains the parent directory
outbox to WorkspaceDO, verifies the resulting authoritative directory row, and
only then marks the route `active`.

**Why:** Moving sidebar serving out of D1 removed its projection fallback. An
active route without a WorkspaceDO row would therefore be a real serving gap,
especially for a second client that does not have the creator's optimistic
cache.

**Considered and rejected:** Relying on the normal alarms or the optimistic
renderer entry. Alarms are eventual and can be backed off after an ambiguous
RPC; optimistic state exists on only one client and cannot establish server
authority.

**Consequences:** Creation pays two deterministic cross-object RPC hops before
responding. Retrying is safe because every handoff has an outbox/receipt fence,
and a failed handoff leaves the route non-active rather than exposing partial
state.

### 2026-08-13 — Creation analytics follows the committed server row

**What changed:** The renderer no longer reports a completed creation. The
regional API emits one stable `workstream_created` event after the work-stream
transaction commits, deriving visibility, origin, participants, opening
attachments, and model override from the stored row. Composer correlation keeps
the request operation ID while the work-stream UUID supplies the idempotent event
identity.

**Why:** A renderer response covered only the desktop composer and could
double-count a server outcome. Slack, suggestions, and automation producers know
the durable source and connector provenance the renderer cannot see.

**Considered and rejected:** Keeping the renderer event beside a connector-only
server event. A single work stream would then create one or two events depending
on its entry path, making totals and funnels structurally incorrect.

**Consequences:** Creation telemetry remains off the correctness path and cannot
fail creation. Any new API or ingress that commits a user-visible work stream
must register its closed source with the server telemetry helper; hidden system
work streams remain excluded.

### 2026-08-12 — A started suggestion opens with the member's own turn, not Rally's

**What changed:** `createFromOpportunity` writes its opening message as the
selecting member's turn (`openingAuthor: { type: "human", … }`) instead of the
agent's. The text is unchanged — it is still the server-expanded
`executionPrompt` — and it still carries the `suggested_work_expansion`
structured content whose label reads "Expanded by Rally from suggested work".
`MessageBlock` now renders the identity header for an own turn when that turn has
a context label, showing the label and the time but still not the reader's own
name.

**Why:** Selecting a suggestion *is* the request; the brief is that request
written out. Attributing it to the agent made every one of these work streams
open with Rally instructing itself, and left the transcript with no human turn
in it at all — which is not only a presentational claim. `retry` resolved its
trigger as the latest human message, found none, and started the replay with a
null trigger; the model projection admits the brief *only* as the trigger, so a
retried run replayed against an empty transcript.

Making the brief a human turn fixes that and immediately breaks the guess the
other way: the brief becomes the newest human message *forever*, so retrying a
later trigger-less run — a scheduled wakeup, an activity — would fence
the transcript back at sequence 1 and re-execute the original request with days
of finished work cut out of it. So the guess goes: runs now record
`harness_runs.trigger_message_id` and `retry` inherits the failed run's own
trigger. That reasoning is in [`agent-harness.md`](agent-harness.md), which owns
the run row.

**Considered and rejected:** *Leaving the author as the agent and special-casing
`retry`* to fall back to the opening message — it fixes the retry and leaves the
transcript still reading as Rally talking to itself, and every future consumer
that asks "what did the person ask for" needs the same special case. *Attributing
it to the member and dropping the label* — the words are Rally's, and a long
brief appearing under your own name with nothing to explain it is worse than the
agent attribution it replaces. *Sending the expanded brief to the client so the
launcher could render the turn optimistically* — the payload behind four
suggestions would carry four briefs of up to 20k characters to render one, and
the empty seed is already invisible.

**Consequences:** The model projection keys the brief on its structured content,
ahead of the author dispatch and deliberately independent of it: an ordinary
human turn is replayed as plain instruction, which would strip the caveat
marking the connector evidence quoted inside the brief as evidence rather than
orders. Anything that routes on authorship alone will now treat these briefs as
member-written text — `recentAddressingMessages` and the naming context both do,
which is the intent. Unchanged, and worth knowing: the brief is still admitted to
the model only when it is the run's trigger, so a follow-up message starts a run
that cannot see it.

The brief also moves from the full-width agent column into the human turn's
right-aligned bubble, capped at `min(72%, 620px)`. That was checked in a real
window against a brief with headings, bullet and numbered lists, and multiple
sections rather than reasoned about: headings, spacing, and wrapping all hold at
that width, and code blocks scroll inside themselves rather than widening the
bubble. List markers did not render at the time — reported here as the `tw-fade`
preflight, which was wrong: the `list-style: none` came from Tailwind's own
preflight, pulled in by `@tailwind base`. It applied to every markdown surface,
not only this one, and the repair is recorded in
[`markdown-rendering.md`](markdown-rendering.md), which owns the renderer.

### 2026-08-11 — The create path waits for its own work again; only the launch surface stays

**What changed:** Both deferrals from the entry below are reverted.
`POST /workstreams` again awaits the Cloudflare Workflows round trip that starts
the harness and the email route activation. `launchWorkstreamHarness` no longer
takes a deferral at all, and `offCriticalPath` is gone. What stays is everything
on the client — the launch surface, the composer hand-off, the seeded run — plus
the concurrent pre-flight checks, which are now settled and rethrown in a fixed
order. The optimistic turn also renders for a create carrying only attachments,
which it previously skipped.

**Why:** Three things the first version got wrong, all found in review.

The deferral was passed straight from `this.defer`, and `POST /workstreams/:id/messages`
is built with `requestDeferral` too — so sending a message into an existing work
stream deferred its workflow start as well, despite the comment and this document
both saying create-only. During a Workflows outage that turned a 503 into a 201
with nothing shown, *after* `supersedeActiveRun` had already cancelled the live
run.

Worse, a deferred start that never runs is unrecoverable. The run row says
`running` while `attempt_id` and `lease_expires_at` stay NULL until the Workflow
admits the run, and nothing reaps that shape: `stop` only records a request a
live workflow has to observe, `retry` refuses a `running` work stream, and no
screen offers either. `waitUntil` is best-effort, so the cost of losing one was a
work stream permanently reading "Rally is working", with no way out.

And the activation deferral did not pay. `create.onSuccess` invalidates the
work-stream list immediately, and `list` backfills every route that is not yet
`active` — so the same Global-registry hop was made a moment later by the
refresh, against four extra D1 reads, with two activations of one route able to
overlap and fail each other's reconcile.

**Considered and rejected:** *Keeping the deferral and making the stuck run
recoverable* — a sweep for `running` rows with a NULL `attempt_id` older than
some threshold, or letting `retry` rescue one. Both are real options, but they
add machinery to the harness's lease and fencing protocol to buy back latency
that nobody is now waiting on, and there is no screen that would surface the
stuck state to ask for a retry in the first place. *Scoping the deferral to
`create` alone and keeping it* — that fixes the leak but not the unrecoverable
run.

**Consequences:** The create path is slower than it was for the two-week life of
the entry below, and that is accepted: the launch surface is what the person
experiences, and it does not care how long the response takes. Any future attempt
to move work off this path has to answer two questions first — what recovers the
state if `waitUntil` is dropped, and does the client immediately undo the saving
by refetching. A run row that says `running` must have a Workflow behind it.

Shipped in #98.

### 2026-08-11 — The work stream opens on the keystroke, and the create path stops waiting for what the caller does not need

**What changed:** Pressing enter in the launcher now shows the work stream being
created — the typed turn, a title skeleton, and a running work timer — instead of
leaving the person on the emptied launcher until the response arrives. The
launcher and that surface are one element tree with one composer element, so the
change between them animates. On the server, `POST /workstreams` no longer waits
for the Cloudflare Workflows round trip that starts the harness, nor for the
email route activation; both are deferred to `waitUntil`. The two pre-flight
checks now run together.

**Considered and rejected:** *A client-generated work-stream id*, sent in the
create request so the client could navigate straight to the final URL. It is the
tidiest end state — no swap at all — but it makes the primary key
client-controlled on a route shared with Slack ingress and automations, and the
optimistic surface does not need it. *A separate `/workstreams/pending/:localId`
route.* It would have unmounted the launcher, and with it the mutation, the
attachment draft, and the composer — the mutation would have had to move or be
re-fired from the new route, and the composer would have remounted, which is
precisely the element the transition is built on. Rendering both states from one
component keeps the create, the draft, the attachments, and the failure path
exactly where they already were. *Deferring the canonical turn publication too*:
it shares a Durable Object log with the harness events, and deferring it would
let a run start appear before the turn that triggered it.

**Also fixed here:** the work-stream room's snapshot named the latest harness
run's id but did not describe the run, and a snapshot replaces the client's whole
detail. Any work stream whose socket connected during a run therefore lost its
work timer until the run ended — pre-existing, and unrelated to creation, but it
is what this change's optimistic timer disappeared into a second after the
transition, so it is fixed rather than reported.

**Consequences:** The launching state must never state geometry of its own — it
inherits `.workstream-screen`, and a rule written against `.is-launching`
directly will drift and reintroduce the jump at navigation that this removes, in
a way no component test can catch. The composer must keep being rendered from a
single position in the tree. A workflow start that fails on the create path now
reaches the client as a failed run over the socket rather than as a 503, so
anything that treats a 201 as proof the harness is running is wrong; the run row
says `running` before the workflow exists. A work stream can briefly exist with
its email route still `reserved`, and `list`'s backfill is what closes that. Any
future work added to `create` has to be classified deliberately: inline if the
response carries its result, deferred through `offCriticalPath` if not — and
deferred work must swallow its own failures, because there is no longer a
response for them to fail.

Shipped in #98.

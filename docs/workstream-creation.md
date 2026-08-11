# Starting a work stream

Between pressing enter in the launcher and a work stream existing, Avalon does
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
| `apps/desktop/src/renderer/screens/new-workstream.tsx` | Both states of the screen, the `launching` state that switches between them, the create mutation, and `useHomeHandOff`. |
| `apps/desktop/src/renderer/styles/app.css` | The `.workstream-launch-screen` block at the end of the file: every geometry difference between the two states, and the two keyframes. |
| `apps/desktop/src/renderer/components/composer-input.tsx` | `ComposerInput`, the single composer element the hand-off is built around. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MessageBlock`, which renders the optimistic opening turn exactly as the work-stream screen will render the persisted one. |
| `apps/desktop/src/renderer/components/agent-work-timing.tsx` | `AgentWorkTiming`, the work timer the optimistic surface starts and the created work stream keeps counting from. |
| `apps/api/src/durable-objects/workstream-room.ts` | `loadWorkstreamRoomSnapshot`, which has to describe the latest run because a snapshot replaces the client's whole detail. |
| `apps/api/src/routes/workstreams.ts` | `POST /workstreams`. |
| `apps/api/src/services/workstream-service.ts` | `create`, and `launchWorkstreamHarness` — the run row, the Workflows start, and what happens when it fails. |

## How it works

### The launcher and the work stream are one screen

`NewWorkstreamScreen` holds a `launching: LaunchingWorkstream | null` state. It is
set **in the same commit as the create request**, from what the person typed, and
it is what makes the work stream appear to open on the keystroke rather than on
the response.

The component renders one tree in both states, a three-row grid of header, body,
and composer dock:

- **Not launching** — the header row is collapsed to zero height, the body holds
  the welcome heading, the work streams waiting for input, and suggested work,
  and the dock carries the participant row above the composer.
- **Launching** — the root additionally carries `workstream-screen`, the header
  expands to 55px around a title skeleton, the body holds a transcript, and the
  participant row collapses.

The launching state deliberately declares no geometry of its own. Because its
root carries `workstream-screen`, it inherits that screen's dock padding, column
width, and composer treatment from the same rules the real screen uses. Anything
restyled for the launcher is written under `:not(.is-launching)` instead, so the
moment the class lands the element is already dressed as the screen it is about
to become and the navigation that follows changes only the data.

### What moves

Three things animate, and they are the whole transition:

- **The composer settles.** It is the same DOM element throughout, so its dock
  padding, stack width, background, border, radius, shadow, and text height all
  transition rather than cut. It is the object the eye follows from the middle of
  the launcher down into the dock.
- **The home content hands off.** `useHomeHandOff` keeps it mounted and `inert`
  for `HOME_HAND_OFF_MS` (190ms) while it fades and settles downward over the
  transcript that replaced it — the same contract `RAIL_CROSSFADE_MS` keeps for
  the right sidebar, and the stylesheet animates over the same span.
- **The transcript assembles.** The opening turn and the work timer each rise
  7px into place on a 70ms stagger, so the transcript reads as being built rather
  than revealed.

Nothing here is bespoke motion: `prefers-reduced-motion` is cut globally at the
end of `app.css`, which flattens all of it to a single 0.001ms iteration.

### What the optimistic surface shows

The opening turn is a `Message` built from what was typed and from the files that
were attached — a create carrying only attachments is one `submit` accepts, and
its turn is a bubble of tiles. It is rendered through the same `MessageBlock` the
work-stream screen uses, with the current user as author so it takes the same
own-turn treatment. The header shows `TitleSkeleton` — the same skeleton the created work stream shows while the naming agent answers, so
the header does not change hands at the swap; it is already waiting for the same
name.

Suggested work opens onto the same surface **without** an opening turn: that one
is written by the agent from the expanded prompt, and there is nothing on the
client that could stand in for it without inventing what it says.

### The room snapshot has to describe the run

A work stream's socket sends a `snapshot` on subscribe, and the client replaces
its whole cached detail with it. The snapshot therefore has to carry everything
`GET /workstreams/:id` carries, and it now describes the latest harness run
rather than naming only its id — both read the same columns and map them through
the same `memberSafeHarnessError`.

### The swap

On success the existing seeding runs — the synthesized `WorkstreamDetail`, the
opening message, and a null message cursor are written into the query cache
before `navigate`. The work-stream screen therefore never shows its
`Opening work stream…` state for a stream that was just created: it paints
immediately, with the same turn in the same place, at the same geometry.

### What the server makes you wait for

Everything. `POST /workstreams` finishes the participant and attachment checks,
the address reservation, the work-stream and opening-message write, the route
activation, the `message_created` publish, the harness run row, and the Workflows
round trip that starts the run — and only then answers. The one thing off the
path is the naming call, which was already deferred before this module existed.

That is deliberate, and it is a reversal: deferring the route activation and the
Workflows round trip to `waitUntil` was built, reviewed, and taken back out. The
changelog below records why. The wait is not what the person who pressed enter
experiences — the launch surface above is — so buying it back with a durability
risk was the wrong trade.

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
- **`message_created` is published before the harness launch.** Both land in the
  same Durable Object log, and a client resyncing from a sequence must not see the
  run start before the message that triggered it.
- **A run row that says `running` must have a Workflow behind it.** `attempt_id`
  and `lease_expires_at` stay NULL until the Workflow admits the run, and nothing
  reaps that shape: `stop` only records a request a live workflow has to observe,
  `retry` refuses a `running` work stream, and no screen offers either. A start
  that is not awaited can therefore leave a work stream permanently "working".
- **The pre-flight checks run ahead of the reservation.** A create that is going
  to be refused must not leave an address reserved for a work stream that never
  exists.
- **Concurrent refusals are reported in a fixed order.** The pre-flight pair is
  settled and rethrown in order, so one bad request always gets the same code.

## Boundary

This module owns the create path and the screen in front of it: the optimistic
surface, the transition, and which steps of `POST /workstreams` a caller waits
for.

It does not own what happens afterwards. The transcript, the socket, and the
work-stream screen's own loading states belong to that screen. Naming belongs to
[`workstream-descriptions.md`](workstream-descriptions.md) — the provisional
title and the `naming` grace this surface renders a skeleton for are its
contract, not this one's. Draft text and attachments belong to
[`composer-drafts.md`](composer-drafts.md); this module clears the draft on
submit and restores it on failure, and changes nothing else about it. Address
allocation and delivery belong to
[`WORKSTREAM_EMAIL_ADDRESSES.md`](WORKSTREAM_EMAIL_ADDRESSES.md); this module
only decides that activation happens after the response. Run admission, leases,
and scope belong to [`AGENT_HARNESS.md`](AGENT_HARNESS.md).

## Failure modes and limits

- **The create fails.** `launching` is cleared, the launcher comes back with the
  typed message restored into the composer unless a newer draft has replaced it,
  and the error renders under the composer. No work stream is left on screen.
- **The workflow start fails.** The run is marked `failed`, the work stream's
  `harness_status` is set to `failed`, a `harness_status_changed` event is
  published so anyone already watching is not left on a `running` row, and the
  caller gets a 503. The work stream and its opening message exist either way;
  the client clears its launch surface and restores the composer.
- **A create is refused.** The participant and attachment checks run ahead of the
  reservation deliberately, so a create that is going to be refused does not leave
  an address reserved for a work stream that never exists.
- **Typing during the launch window.** The composer stays live; anything typed
  lands in the `new-workstream:<workspaceId>` draft and is not carried into the
  created work stream. Attachment tiles and the file input are frozen for the
  window, because the files they stand for are already on their way into a
  message.
- **Limits.** `HOME_HAND_OFF_MS` is 190ms and must equal the stylesheet's
  `launch-home-leave` duration. The arrival stagger is 70ms per index with a 60ms
  lead-in. Geometry transitions run at 240ms and the header at 220ms.

## Testing

- `apps/desktop/src/renderer/screens/new-workstream.test.tsx` —
  `pnpm --filter @avalon/desktop exec vitest run src/renderer/screens/new-workstream.test.tsx`.
  Covers the surface appearing on the keystroke, composer node identity across
  the hand-off, and the optimistic turn being taken back when the create fails.
  The suite clears the draft cache in `beforeEach` and stubs `ResizeObserver`;
  a test that skips either will see a restored draft from its predecessor.
- `apps/api/test/workstream-create-latency.test.ts` —
  `pnpm --filter @avalon/api exec vitest run test/workstream-create-latency.test.ts`.
  Covers what the create finishes before it answers: the run started, the route
  active, no address reserved for a create it is about to refuse, and one stable
  code for a request that violates both pre-flight checks. That last one loops
  five creates rather than asserting once — a fixed order that only held by luck
  would pass a single run.
- `apps/api/test/workstream-room-snapshot.test.ts` — includes the case that the
  snapshot describes the latest run rather than naming its id. The snapshot
  replaces the client's whole detail, so a field dropped there is invisible until
  something notices a missing timer.
- These are component and service tests, so neither sees the transition. **A
  change to the animation or to either state's geometry has to be looked at in a
  real window** — see [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).

## Regional impact

The email route reservation crosses to the Global registry from every non-Global
region, and activation crosses a second time, so an EU create pays two hops that
a Global one does not. Both are on the create path. Moving activation off it was
tried and reverted — see the changelog — because the create's own cache
invalidation makes `list` backfill the route immediately, paying the same hop a
moment later against extra reads. Anything that wants that hop back has to deal
with the backfill first. See [`REGIONALIZATION.md`](REGIONALIZATION.md).

## Changelog

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
work stream permanently reading "Avalon is working", with no way out.

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

**Why:** `create` made eight sequential round trips before returning 201, and the
client did not navigate until it did. Nothing on screen changed in that window
except a spinner in the send button the message had already left, so the whole
cost of creating a work stream was paid in front of a screen that looked idle.
The two deferred steps were picked because nothing in the response depends on
them: the harness run row and its id are written before the workflow start, and
the address is settled by the reservation, leaving only its routing status. For
an EU workspace the activation is a second hop to the Global registry, which made
it the largest thing that could leave the path without changing what the caller
gets.

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
exactly where they already were. *Deferring the `message_created` publish too*:
it shares a Durable Object log with the harness events, and deferring it would
let a run start appear before the message that triggered it.

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

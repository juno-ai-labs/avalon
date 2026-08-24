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
| `apps/desktop/src/renderer/screens/new-workstream.tsx` | Both states of the screen, the `launching` state that switches between them, both create mutations, `launchedWorkstreamDetail` — the one place a launched work stream's cached detail is built — and `useHomeHandOff`. |
| `apps/desktop/src/renderer/styles/app.css` | The `.workstream-launch-screen` block at the end of the file: every geometry difference between the two states, and the two keyframes. |
| `apps/desktop/src/renderer/components/composer-input.tsx` | `ComposerInput`, the single composer element the hand-off is built around. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MessageBlock`, which renders the optimistic opening turn exactly as the work-stream screen will render the persisted one. |
| `apps/desktop/src/renderer/components/agent-work-timing.tsx` | `AgentWorkTiming`, the work timer the optimistic surface starts and the created work stream keeps counting from. |
| `apps/api/src/durable-objects/substream-agent.ts` | The authoritative create, opening turn/run, feed snapshot, and synchronous child-effect drain used by the route-activation fence. |
| `apps/api/src/durable-objects/workstream-do.ts`, `workspace-do.ts` | Aggregate the child's metadata, commit the authoritative workspace directory row, and prove it exists before the D1 route becomes active. |
| `apps/api/src/routes/workstreams.ts` | `POST /workstreams`. |
| `apps/api/src/services/workstream-object-creation-service.ts` | Post-cutover creation receipt, identity anchor, verified-to-active route transition, hierarchy drain, and email activation. |
| `apps/api/src/services/workstream-service.ts` | The fenced pre-cutover create path retained until Durable Object authority opens. |
| `apps/api/src/observability/tracing.ts` | The custom spans every step of the create is measured with; the names and the queries are in [`performance-tracing.md`](performance-tracing.md). |

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

The participant picker sends initial focus to its first available member, or to
Done when there are no available members. This keeps keyboard entry on the
dialog's task instead of focusing the header's Close control and opening its
tooltip as a side effect. The native checkboxes remain the interactive controls;
the fixed 16px indicators at the end of each row are only their visual treatment
and mirror the native input's keyboard-visible focus.

### What the optimistic surface shows

The opening turn is a `Message` built from what was typed and from the files that
were attached — a create carrying only attachments is one `submit` accepts, and
its turn is a bubble of tiles. It is rendered through the same `MessageBlock` the
work-stream screen uses, with the current user as author so it takes the same
own-turn treatment. The header shows `TitleSkeleton` — the same skeleton the created work stream shows while the naming agent answers, so
the header does not change hands at the swap; it is already waiting for the same
name.

Suggested work opens onto the same surface **without** an opening turn, and with
an empty composer, and seeds its destination the same way. That work stream's
opening turn belongs to the person who selected the suggestion, but its text is
the expanded brief, which only the server holds — the home screen has never seen
anything but the one-line `displayPrompt`, and standing that line in for the
brief would show a turn that a longer, different one replaces the moment the
refetch lands. Anything sitting in the composer, meanwhile, is a draft for a work
stream nobody has started, so showing it beside one that has just been started
would attach it to the wrong thing. The draft is held back rather than
discarded — `LaunchingWorkstream.origin` is what distinguishes the two
launchers — and it returns the moment the launch ends, either way.

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
built by `launchedWorkstreamDetail`, the transcript, and a null message cursor.
The work-stream screen shows its full-screen `Opening work stream…` state
whenever *either* of those two queries is loading, so seeding one is not enough —
both launchers write both, and a work stream that was just created therefore
never shows it. It paints immediately, with the same turn in the same place, at
the same geometry.

The two launchers differ only in the transcript. A typed create authored its
opening turn and seeds it. Suggested work's turn is the selecting member's too,
but its text was expanded server-side from the prompt, so it seeds an empty
transcript and lets the refetch bring the real turn a moment later — and the
work-stream screen withholds its
`Ready to begin` empty state while a run is active, because inviting someone to
start a work stream an agent is already working on contradicts the timer beside
it.

### What the server makes you wait for

Everything. `POST /workstreams` finishes the participant and attachment checks,
the address reservation, the authoritative SubstreamAgent work-stream/opening
message/run write, the `message_created` publish, and the Workflows round trip
that starts the run. It then synchronously drains the committed directory facts
through WorkstreamDO into WorkspaceDO, verifies the workspace directory row,
changes the minimal D1 route from `verified` to `active`, and activates email —
only then does it answer. The one thing off the path is the naming call, which
was already deferred before this module existed.

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
- **A turn attributed to someone who did not write its words carries the label
  that says so.** The suggested-work brief is stored as the selecting member's
  own turn, and own turns render without a header. `MessageBlock` makes the
  header conditional on `contextLabel` rather than on authorship alone for
  exactly this case; removing that exception leaves a member reading a brief
  under their own name with nothing on screen to account for it.
- **`message_created` is published before the harness launch.** Both land in the
  same Durable Object log, and a client resyncing from a sequence must not see the
  run start before the message that triggered it.
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
  exists.
- **A create that names no audience writes a private work stream.** `POST
  /workstreams` carries no scope — a request on the wire cannot claim one — so
  the creator is seated beside whoever they named, those active participant rows
  are the room's complete reader authority, and the scope reaches the
  object as an argument rather than a hardcoded `'workspace'`. A create path
  added later inherits that: omitting the scope is a decision for private, and
  only a caller that *knows* the audience is wider — an ingress reading a public
  channel — says `workspace`. See
  [`data-model.md`](data-model.md#2026-08-21--a-work-stream-is-born-private).
- **Both launchers seed both queries, through `launchedWorkstreamDetail`.** The
  work-stream screen loads on either query being absent, so seeding one of the
  two still lands on the full-screen orb; and two hand-built details would drift
  into one path quietly losing its work timer at the navigation.
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
[`workstream-descriptions.md`](workstream-descriptions.md) — the provisional
title and the `naming` grace this surface renders a skeleton for are its
contract, not this one's. Draft text and attachments belong to
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
- `apps/api/test/substream-agent-snapshot.test.ts` — includes the case that the
  snapshot describes the latest run rather than naming its id. The snapshot
  replaces the client's whole detail, so a field dropped there is invisible until
  something notices a missing timer.
- `apps/api/test-workers/durable-object-runtime.test.ts` — inserts a backed-off
  child directory snapshot, explicitly drains both parent hops, and proves the
  WorkspaceDO row exists while both SQL outboxes are empty. This guards the
  verified-to-active creation fence in the real Workers runtime.
- `apps/desktop/src/renderer/styles/app.css.node.test.ts` — guards the one thing
  a component test cannot see: that the launching state states no geometry of its
  own. It reads the stylesheet from disk, so it is typed by `tsconfig.node.json`
  and named `.node.test.ts` to keep `node:fs` out of the renderer program.
- These are component, stylesheet, and service tests, so none of them sees the
  transition. **A change to the animation or to either state's geometry still has
  to be looked at in a real window** — see [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).

## Regional impact

The email route reservation crosses to the Global registry from every non-Global
region, and activation crosses a second time, so an EU create pays two hops that
a Global one does not. Both are on the create path. Moving activation off it was
tried and reverted — see the changelog — because the create's own cache
invalidation makes `list` backfill the route immediately, paying the same hop a
moment later against extra reads. Anything that wants that hop back has to deal
with the backfill first. See [`regionalization.md`](regionalization.md).

## Changelog

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
a person waits on in Avalon, and made "it feels slow" unanswerable. The only
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
### 2026-08-12 — The participant picker opens on its first option without stretching its checkboxes

**What changed:** Opening Add people initially focuses the first available
member, falling back to Done for an empty list. Each native checkbox's visual
indicator is fixed at 16px instead of participating in the row's flexible copy
layout, and exposes keyboard-visible focus from the transparent native input.

**Why:** The dialog's first focusable control was its header Close button, whose
focus-accessible tooltip therefore appeared every time the picker opened even
when the pointer was elsewhere. The selector intended to grow the member's name
and email also matched the decorative checkbox span, turning each unchecked
square into a long outlined bar. Because the native control is transparent,
moving focus to it without mirroring `:focus-visible` also left keyboard users
with no visible indication of their position.

**Considered and rejected:** Disabling focus-triggered tooltips would remove
their keyboard-accessible labels from every icon button. Changing the shared
modal's default focus would also override dialogs that deliberately autofocus a
form field, so the picker supplies its own meaningful target instead.

**Consequences:** Picker options remain native checkboxes for interaction and
accessibility; the trailing span must stay decorative, excluded from flexible
copy styling, and reflect the native input's focus state. Dialogs without an
explicit initial-focus target keep Radix's default focus behavior.

Shipped in #138.

### 2026-08-12 — A started suggestion opens with the member's own turn, not Avalon's

**What changed:** `createFromOpportunity` writes its opening message as the
selecting member's turn (`openingAuthor: { type: "human", … }`) instead of the
agent's. The text is unchanged — it is still the server-expanded
`executionPrompt` — and it still carries the `suggested_work_expansion`
structured content whose label reads "Expanded by Avalon from suggested work".
`MessageBlock` now renders the identity header for an own turn when that turn has
a context label, showing the label and the time but still not the reader's own
name.

**Why:** Selecting a suggestion *is* the request; the brief is that request
written out. Attributing it to the agent made every one of these work streams
open with Avalon instructing itself, and left the transcript with no human turn
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
transcript still reading as Avalon talking to itself, and every future consumer
that asks "what did the person ask for" needs the same special case. *Attributing
it to the member and dropping the label* — the words are Avalon's, and a long
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

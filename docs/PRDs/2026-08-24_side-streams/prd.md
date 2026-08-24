# Side streams

> Created 2026-08-24.
>
> A temporary chat beside the work stream you are reading, for the question you
> do not want in its transcript — and the one control that turns that chat into
> a new work stream. Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [`workstream-creation.md`](../../workstream-creation.md),
> [`workstream-origin-attachments.md`](../../workstream-origin-attachments.md),
> [`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md), and
> [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).

## Summary

A person reading a work stream can open a **side stream**: a small chat window
that floats over the work-stream screen, answers questions about the work stream
they are looking at, and is never saved. Nothing they type in it enters the
work stream's transcript, reaches its participants, starts a run, or interrupts
the run already in flight. When the answer turns out to be worth pursuing, one
control — **Keep as work stream** — turns the side conversation into a real work
stream that carries the parent along with it.

What becomes possible: asking Avalon something *about* the work in front of you
without paying for it in the shared record. Today the only way to ask Avalon
anything is the composer that feeds the work stream's own agent, so every
clarifying question becomes a turn in a transcript other people read, and every
tangent either derails the run or waits until it finishes.

## Motivation

A work stream is the durable, multiplayer home for a piece of work, and its
transcript is the record everyone in it reads later. That is the right default,
and it is exactly what makes a certain class of question expensive.

Three things happen today, all of them observable in the product as it stands:

1. **A question to Avalon costs a turn in the shared record.** The work-stream
   composer is the only way to reach the agent. "What was the EU VAT threshold
   again?" and "remind me what this repo's release process is" land in the same
   transcript as the deliverable, attributed to you, in front of every
   participant, permanently. The reasonable response is to not ask — to open a
   browser instead, which is the outcome Avalon exists to prevent.

2. **A question to Avalon costs the run in flight.** Sending into a work stream
   whose harness status is `running` steers the run that is going. A person who
   wants to ask something adjacent has to either interrupt work they are waiting
   on or wait for it to finish. `workstream.tsx` already models steering as a
   deliberate act; there is no non-steering way to talk to Avalon at all.

3. **A tangent has nowhere to go but a new work stream.** Starting one from the
   launcher means leaving the screen, losing the thing you were reading, and
   opening a durable multiplayer object for a thought that may not survive
   contact with its own first answer. The sidebar fills with work streams that
   were questions.

The cost of leaving this alone is not one broken flow; it is that the quiet,
low-stakes half of working with an assistant has no home in Avalon, so it
happens somewhere else. Every question asked in a browser is context Avalon
never sees and a work stream that never starts.

The side stream is the cheap surface for that half: no record, no participants,
no run, no sidebar row — and a single, deliberate step from there into the
durable object when the question turns out to be work.

## Goals

1. A person reading a work stream can ask Avalon a question without anything
   they type reaching that work stream's transcript, participants, or agent.
2. A side stream can be opened, expanded, minimized, and closed from its own
   header, and asking in it never blocks reading or using the work stream
   underneath — including while that work stream's agent is running.
3. A side stream answers with knowledge of the work stream it was opened from:
   the current state of its transcript and the resources attached to it, read
   fresh on every turn rather than frozen when the window opened.
4. A side stream conversation can be turned into a new work stream in one
   action, and that work stream carries both the side conversation and a
   durable, followable reference back to the parent.
5. A side stream leaves nothing behind. Closing it, quitting, or reloading ends
   it, and no server-side row records that it existed.
6. Every one of the above is reachable without leaving the work-stream screen.

## Non-goals

1. **Merging a side stream into its parent work stream.** The mock this PRD was
   written from shows a second hand-off control, *Send into this stream*. It is
   not built. A side stream is defined by what it does not enter; a control that
   pushes it into the transcript is a different feature with its own questions
   about authorship, ordering against a live run, and what participants see.
   **Deferred**, and the hand-off row ships with one button rather than a
   disabled second one.
2. **A side stream that is saved anywhere.** Not in D1, not in a Durable Object,
   not in the on-device draft cache, not in the sidebar, not in export, not in a
   digest. **Rejected outright** for this PRD: "temporary" is the property that
   makes the surface cheap enough to use without thinking, and every persistence
   mechanism that would make it recoverable also makes it findable by someone
   else later. A future PRD may revisit it; this one should not be built as
   though it will.
3. **A side stream that acts.** No writes of any kind — no connector calls, no
   web fetches, no Terminal, no memory or table writes, no elicitation, no
   scheduled wake-ups, no sub-agents. **Deferred**: a surface that can act but
   cannot be read back later is an audit hole, and Avalon's contract is that
   every authorized external write is visible and audited. Acting is what the
   hand-off is for.
4. **Side streams anywhere but on an open work stream.** Not on the home screen,
   not on the new-work-stream launcher, not on a note, not on an automation
   overview. **Rejected for now**: a side stream is defined against a parent, and
   a parentless one is just the launcher with a smaller composer.
5. **Multiplayer side streams.** A side stream has exactly one participant — the
   person who opened it — and is not shareable, addressable, or visible to
   anyone else. **Rejected outright.**
6. **A blank-slate hand-off.** The original request asked for parent context
   when the side conversation is related and a blank slate when it is not. Every
   hand-off inherits the parent instead; see key design decision 1 for why that
   costs nothing. **Rejected**, with the reasoning recorded rather than the
   branch built.
7. **Attachments, dictation, mentions, and a model pill in the side composer.**
   The side composer takes text. **Deferred** — each one is a real feature of
   the main composer and none is needed to answer a question.
8. **A side stream on a work stream you cannot read.** Access to the side stream
   is exactly access to its parent; there is no path that shows you parent
   content you could not already open.

## Product behavior

### Opening one

The work-stream header gains a **Side stream** toggle in
`workstream-header-actions`, sitting with the two controls that already own the
right side of that header — HyperSight and work-stream context — and behaving
like them: `aria-pressed`, an `is-active` treatment while open, and a label that
states what activating it does. The same toggle is bound to a keyboard shortcut
(see open question 4).

Opening one does not change the work stream in any way. It starts no run,
attaches nothing, publishes nothing, and does not make a viewer a participant —
[the contract's rule](../2026-08-05_avalon-implementation-brief/prd.md) that
viewing does not create participation is untouched, because opening a side
stream is a kind of viewing.

There is **one side stream per work stream**, and it belongs to that work
stream's screen. Navigating to another work stream leaves it behind, still
holding its conversation; coming back reopens it exactly as it was, including a
turn that finished while you were gone. It lives until the app is closed or
reloaded, and no longer.

### The window

A floating card anchored to the bottom-right of the work-stream screen, above
the composer dock, at the right rail's width vocabulary (320–380px). It is
**not modal**: the transcript behind it stays readable and scrollable, the main
composer stays focusable and sendable, and the run underneath keeps streaming.
That is the whole promise of the surface, and it is the one thing a review
should check first.

Its header carries, on the left, a clock glyph and the words `TEMPORARY · NOT
SAVED` in the same small-caps treatment the mock shows — the label is the
product's only warning that closing loses the conversation, so it is stated
where the conversation is, not in a tooltip. On the right sit three controls, in
this order:

| Control | Effect |
| --- | --- |
| **Expand** | Widens the card to the transcript column's width, still non-modal, for reading a long answer. Toggles back to **Restore**. |
| **Minimize** | Collapses to a single bar pinned above the composer dock, keeping the conversation and any turn in flight. The bar shows a status dot while a turn runs and an unread dot when one finished while collapsed. |
| **Close** | Ends the side stream and discards it. |

Closing a side stream that holds at least one exchange asks for confirmation
once, because the content is unrecoverable and the control sits next to
Minimize, which is not destructive. Closing an empty one just closes.

### Asking

The composer reads `Ask something temporary…`. Enter sends and Shift+Enter
inserts a newline, matching `ComposerInput`. The answer streams in, revealed
through the same cadence the transcript uses, so a side stream and a work stream
read at the same speed.

Each turn is answered with:

- **The parent work stream's recent transcript**, read at the moment the turn is
  sent rather than when the window opened, so a message that landed while you
  were typing is visible to the answer.
- **The parent work stream's attached resources**, which Avalon may read to
  answer and may not modify.
- **Nothing else.** No connectors, no web, no Terminal, no writes. See
  [Agent behavior](#agent-behavior).

The side stream never sees another work stream, and asking about one it was not
opened from gets an answer that says so.

### States

| State | What the window shows |
| --- | --- |
| **Empty** | The header, the composer, and one line under it: nothing here is saved, and it will not reach this work stream. The hand-off row is present and its control is disabled. |
| **Streaming** | The answer reveals as it arrives. The hand-off control is disabled until the turn settles — a work stream created from half an answer is created from a different conversation than the one on screen. |
| **Populated** | The exchanges, newest last, with the hand-off row live. |
| **Error** | An `InlineError` inside the window with **Try again**, and the message that failed left in the composer rather than discarded. The work stream underneath is unaffected; a failed side-stream turn is not a failed run. |
| **Offline or unreachable** | The same error treatment. A side stream holds no socket of its own, so the work stream's own `SocketStatusIndicator` continues to describe the work stream and says nothing about the side stream. |
| **Parent running** | Unchanged. Every state above is reachable while the work stream's harness status is `running`, and the side stream never steers it. |
| **Limit reached** | When a side stream has taken as many turns as it may hold, the composer is disabled with a line saying so and pointing at **Keep as work stream**. Ships inert; see open question 1. |

A turn already in flight when you navigate away keeps running: the request is
owned by the side-stream store rather than by the screen, so the answer is
waiting when you come back.

### Keeping it as a work stream

The hand-off row carries one control, **Keep as work stream**. Activating it:

1. Creates a work stream through the existing `POST /workstreams` path, with the
   side conversation as its opening message and the person who opened the side
   stream as its only participant. It is therefore a `personal` work stream, and
   the existing scope control widens it afterwards.
2. Attaches the parent work stream to it as a resource with
   `relationship_type = 'parent'`, so the new stream's **Resources** section
   shows where it came from and the agent can find and read it with the
   `workstream_list_resources` tool it already has. This is what makes the new
   work stream *able to reference the parent* rather than merely seeded from it.
3. Closes the side stream and navigates to the new work stream, which opens on
   the same optimistic surface every create uses
   ([`workstream-creation.md`](../../workstream-creation.md)) — the opening turn
   is on screen before the response lands.

The parent is always carried. A side conversation that wandered somewhere
unrelated still gets the reference; it costs one resource row and one line of
context, and the agent simply does not read it. See key design decision 1.

If the create fails, the side stream stays open with its conversation intact and
the failure is shown in it. Nothing is lost by a failed hand-off.

## Impact on the product contract

**One clause moves, by addition.** The brief says *Avalon is inherent in every
work stream*. It has never said Avalon is reachable *only* in a work stream, but
that has been true in practice, and this PRD makes it deliberately untrue: there
is now one more place to talk to Avalon.

The rest of the contract holds, and the reasons are worth stating because this
is the change most likely to be mistaken for a bigger one:

- **This is not a direct message and not a channel.** The brief organizes Avalon
  around work streams *rather than channels, direct messages, search, or a
  global inbox*. What that clause is defending against is a second durable home
  for work that competes with the work stream. A side stream cannot be one: it
  has no persistence, no list, no address, no history, no second participant, and
  no way to produce anything except a work stream. It is a scratch surface whose
  only exit is the contract's own primitive.
- **Viewing still does not create participation.** Opening a side stream on a
  work stream you are viewing does not add you to it.
- **Every automation run still owns exactly one work stream.** Side streams are
  not runs and cannot be scheduled or triggered.
- **The agent still uses typed, authorized tools**, and the side stream's slice
  of them is strictly smaller than a work-stream run's — read-only, and fenced
  to one work stream's resources.
- **Ordinary authorized external writes remain visible and audited**, because a
  side stream performs none.

The contract line that a reviewer should push on is the first one. If the answer
is that Avalon must only ever be reachable inside a durable work stream, this
feature does not exist and the motivation above needs a different solution.

## Decision log

None yet.

## Key design decisions

1. **The hand-off always carries the parent, because the parent arrives as a
   reference rather than a paste.** The original request asked for a
   relatedness judgement — inherit when related, blank slate when not. A
   judgement needs a classifier, a classifier is wrong sometimes, and its
   wrongness is invisible until the new work stream's first turn has already
   been written against the wrong context. The alternative considered was
   asking the person at hand-off, which is never wrong but adds a decision to
   the one action this surface has. Both were rejected once the hand-off shape
   settled: because the parent travels as an attached resource plus one line of
   context, an unrelated new work stream pays a resource row and reads nothing,
   while a related one gets a parent it can actually follow — a reference the
   agent hydrates on demand, not a wall of transcript in its first prompt. The
   cheap answer is therefore also the correct one, and the branch that would
   have needed the judgement does not exist to be wrong.

2. **A side stream is not a work stream, not a substream, and not a Durable
   Object.** [`workstream-durable-object.md`](../../workstream-durable-object.md#when-substreams-are-appropriate)
   sets three conditions for a substream, and a side stream fails the ones that
   matter: it owns no durable ordered message array and its output is not
   aggregated into parent state. Building it as a `SubstreamAgent` would give
   every ephemeral question a SQLite database, an alarm, a socket, and an
   authorization surface — the exact multiplication that section forbids. It is
   served instead by a streaming request whose conversation lives in the
   renderer, the shape the automation compiler already uses at
   `POST /automations/draft/stream`.

3. **Session-lived, in renderer memory, one per parent.** The alternatives were
   the on-device draft cache ([`composer-drafts.md`](../../composer-drafts.md)),
   which survives restarts and would make "not saved" a lie on the device, and a
   hidden server-side personal work stream, which would make it a lie
   everywhere. Renderer memory is the only store whose lifetime matches the
   label on the window. The cost is real and accepted: a reload loses the
   conversation, and the label is what warns you.

4. **The window is non-modal and the work stream underneath stays fully live.**
   A modal would be far easier to build and would defeat the feature: the
   request was explicitly to *not disturb my ongoing one*. This is the invariant
   most likely to be broken by a later change and is called out in
   [Acceptance](#acceptance) for that reason.

5. **The side stream reads the parent fresh on every turn.** A snapshot taken
   when the window opened is cheaper and goes stale in exactly the situation the
   feature is for — a run streaming into the parent while you ask about it.

6. **The hand-off creates a `personal` work stream.** A side stream is private
   to one person, and promoting a private conversation straight into a workspace
   work stream publishes it in one click. Inheriting the parent's scope was
   rejected for that reason. Widening afterwards is an existing control and an
   explicit act.

7. **The parent reference is a new `parent` relationship, not `origin`.**
   `origin` has a stated promise —
   [the connector place a work stream started from, recorded by the connector
   that knows what the place is](../../workstream-origin-attachments.md) — and a
   work stream is not a connector place. Reusing the label would make that
   document false for a class of rows it does not describe.

## Data model

No migration is needed for the side stream itself: it has no rows.

The hand-off writes what a create already writes, plus one attachment:

- A `resources` row for the parent work stream, with `provider =
  'avalon_workstream'`, `resource_type = 'workstream'`, `provider_resource_id`
  the parent's id, `title` the parent's title at hand-off, `canonical_url` the
  parent's `workstreamCanonicalUrl`, and no `connection_id`. Non-connector
  resources are established — `avalon_upload`, `avalon_note`, and
  `avalon_generated` all exist — so this adds a provider, not a shape.
- A `workstream_resources` row linking it to the new work stream with
  `relationship_type = 'parent'` and watching off.

The resource row is reused when one already exists for that parent, keyed the
way every other resource is, so N side streams handed off from one work stream
produce one row and N links.

`workstream-resource-visibility.ts` gains a rule for `avalon_workstream`
alongside the ones it already carries for `resend`, `avalon_upload`, and
`avalon_note`. See [Security and trust model](#security-and-trust-model) — this
is the part of the change with a real way to be wrong.

## Regional impact

None beyond the ordinary. A side stream is served by the regional Worker that
already serves the parent work stream, its conversation never leaves the
renderer and that Worker, and nothing about it reaches the Global control plane.
The route and the model role are provisioned in both regions like every other.

## Security and trust model

- **Authorization is the parent's, exactly.** Opening a side stream, sending a
  turn in it, and handing it off are each authorized against read access to the
  parent work stream, rechecked per request. A personal work stream is readable
  only by its participants, so only they can open a side stream on it.
- **The parent reference inherits the parent's readability.** This is the one
  new way to leak. A `parent` link is a pointer to a work stream, and the
  resource-visibility layer must resolve the reader's access to *that work
  stream* — not merely the presence of the link row — before showing its title
  or letting the agent read through it. A new work stream widened to workspace
  scope must not become a window onto a personal parent. The test that proves
  this is named in [Acceptance](#acceptance).
- **Side-stream text is inference input, and nothing else.** It is never written
  to D1, a Durable Object, `activity_events`, a digest, the message export card,
  or the on-device draft cache. It does reach OpenRouter, like every other turn
  in Avalon, and it is subject to the workspace's `logAgentInference` setting on
  the same terms — a workspace that has turned inference logging off does not
  get side-stream turns logged.
- **The parent's transcript reaches the model under the reader's own access.**
  The side stream is given what its opener may already read, and nothing is
  widened to make the surface convenient.
- **No new IPC and no renderer privilege change.** The window is renderer-side
  React over the existing authenticated `AvalonApi`;
  [`security.md`](../../security.md)'s isolation model is untouched.
- **The parent's agent is never told a side stream happened.** No event, no
  transcript row, no signal in the run's context.

## Agent behavior

**No new tool and no new plugin.** A side-stream turn runs against a strictly
read-only slice of what a work-stream run already gets.

| Available | Mode | Fenced to |
| --- | --- | --- |
| The parent's recent transcript | read | the parent work stream |
| `workstream_list_resources` | read | the parent's attached resources |
| The resource read/view/search/summarize tools already grouped under `workstream.resources.` | read | the same set |

Everything else is denied for the side-stream caller: every `write` mode tool,
every connector plugin, `avalon:web`, the Terminal plugin, elicitation,
`workstream_schedule_wakeup` and the rest of `workstream.wakeup.`, sub-agents,
memory writes, and table writes. The denial is enforced at the caller's plugin
selection rather than by prompt, so a model that asks for one is refused rather
than persuaded.

The side stream's standing guidance says what it is, in the terms
[`writing-prompts.md`](../../writing-prompts.md) asks for: this conversation is
temporary and is not part of the work stream; answer about the work stream in
front of the person; you cannot act, and when acting is what is needed, say that
keeping this as a work stream is how it gets done.

What the person sees while it works: streamed text, and nothing else. A side
stream shows no tool-activity rows, no work timer, and no thinking indicator
beyond the stream itself — it is a chat window, not a run surface. A resource
read that takes a moment reads as an answer that started a moment later.

## Rollout

- **Client flag `side-streams`**, served through `GET /feature-flags` and
  resolved by `client-feature-flags.ts`, which fails closed. Off means the
  header toggle and its shortcut do not exist. This is the off switch, and it is
  a flag flip rather than a deploy.
- **Model role `side_stream`**, added to `AGENT_MODEL_ROLES` with flag key
  `agent-model-side-stream`, defaulting to `OPENROUTER_PRIMARY_MODEL` and the
  standard fallbacks — the same plan the `workstream` role gets, because a side
  stream answers real questions and a cheaper classifier model would be felt
  immediately. Registering the role is what makes the choice retargetable
  without a deploy, per [`feature-flags.md`](../../feature-flags.md).
- No migration ordering to respect: the `parent` relationship and the
  `avalon_workstream` provider are written only by a path that ships behind the
  client flag.

## Acceptance

1. **It does not disturb the parent.** With the parent's harness status
   `running`, open a side stream, send a turn, and watch the parent's transcript
   keep streaming, its composer stay focusable and sendable, and its run
   complete unchanged. Then confirm the parent's transcript contains no trace of
   the side stream, before or after.
2. **It sees the parent live.** Ask about something that arrived in the parent's
   transcript *after* the side stream was opened, and get an answer that
   accounts for it.
3. **Three controls behave.** Expand, minimize with a turn in flight and watch
   it finish in the collapsed bar, restore, and close — and confirm the
   confirmation appears only when there is something to lose.
4. **It survives navigation and not a reload.** Leave the work stream mid-turn,
   come back to the finished answer; reload and find the side stream gone.
5. **The hand-off carries the parent.** Keep a side stream as a work stream,
   land on the new work stream with the side conversation as its opening turn,
   find the parent in its **Resources** section, and ask the new stream's agent
   something that requires reading the parent.
6. **The parent reference cannot leak.** A hand-off from a `personal` parent,
   widened to `workspace` scope, must not expose the parent's title or content
   to a workspace member who is not one of the parent's participants. This is
   the security test, and it belongs in the suite that runs the checked-in
   migrations rather than a stubbed one, per
   [`testing.md`](../../testing.md).
7. **Nothing is written.** Attempt, through the side stream, something that
   would require a write — sending a Slack message, editing a resource — and get
   a refusal that points at the hand-off. Confirm no receipt, no activity event,
   and no audit row exists for the attempt.
8. **Visible-change verification.** Every state in
   [Product behavior](#product-behavior) is looked at in a real window under
   Xvfb per [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it),
   not asserted only in a component test.
9. **The subsystem gets its document.** Side streams have no owner in
   [the documentation index](../../README.md); shipping this adds
   `docs/side-streams.md` to the shape in
   [`module-documents.md`](../../module-documents.md), registers it in that
   index, and updates
   [`workstream-origin-attachments.md`](../../workstream-origin-attachments.md)
   with the `parent` relationship it does not currently describe.

## Open questions

1. **The defensive numbers, all of them open.** Per
   [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md),
   this PRD defines these bounds and picks none of them. Each ships at its open
   value, marked `LIMIT UNSET`, and each needs a real number from the team
   before it does anything:

   | Limit | What it bounds | The arithmetic to set it |
   | --- | --- | --- |
   | `SIDE_STREAM_PARENT_TRANSCRIPT_MESSAGES` | Parent messages given to one turn | Context window against the parent's typical transcript size; the compaction trigger in [`context-compaction.md`](../../context-compaction.md) is the comparable number. |
   | `SIDE_STREAM_MAX_TURNS` | Exchanges one side stream may hold | Per-turn cost times turns, against the point where the conversation should have become a work stream anyway. |
   | `SIDE_STREAM_MESSAGE_CHARACTERS` | One typed side-stream message | `CreateMessageRequestSchema.text` caps a work-stream message at 50,000 characters; a side stream has no reason to be more generous. |
   | `SIDE_STREAM_CONCURRENT_RUNS` | Side-stream turns in flight per person | A person can hold one window per work stream and could open many; this is the only bound between that and a fan-out of inference calls. |
   | `SIDE_STREAM_TURN_TIMEOUT_MS` | How long one turn may stream | Provider timeouts, and how long a person will sit in front of a small window. |

   Answering question 1 is not a blocker for building the mechanisms; it is a
   blocker for calling the feature done.

2. **Does the side composer take attachments?** Non-goal 7 says no for this
   PRD. If dropping a file into the side stream is part of what makes it useful
   — "what does this PDF say about the thing we're doing here" — that changes
   the composer, adds the upload path, and adds a question about what happens to
   the uploaded resource when the unsaved conversation ends. Worth settling
   before the composer is written rather than after.

3. **Is the window per-work-stream, or does it follow you?** This PRD says the
   side stream belongs to the work stream it was opened from and is left behind
   on navigation. The other reading of "chat on the side" is one window that
   follows you across the app and keeps its conversation as you move. That
   version needs an answer for what "context of the parent" means once you have
   navigated away from the parent, which is why it is not the proposal — but it
   is a legitimate product choice and the two are hard to swap later.

4. **What is the shortcut?** The mock shows a chord in the hand-off row's
   trailing corner. The renderer currently binds almost nothing, so the space is
   open; `⌥⌘N` reads as "new, but to the side" and does not collide with
   anything in `application-menu.ts`. Confirm, or name another.

5. **Is "side stream" the user-facing word?** It is the word in this document and
   the proposed button label. The mock's own chip says only `TEMPORARY · NOT
   SAVED`, which suggests the window may not need to name itself at all. The
   sidebar has no row for it and the transcript never mentions it, so the toggle's
   label is the only place the noun appears — and a noun that appears once is
   cheap to change now and expensive after people learn it.

6. **Should the hand-off inherit the parent's scope after all?** Key design
   decision 6 makes every handed-off work stream `personal`. The case against:
   a side stream opened on a workspace work stream, about that work stream's
   work, probably wants to be workspace work too, and making it private by
   default puts an extra step between the question and the team seeing the
   answer. The case for is one click that publishes a private conversation. This
   PRD takes the safe side; it is the kind of default worth disagreeing with
   early.

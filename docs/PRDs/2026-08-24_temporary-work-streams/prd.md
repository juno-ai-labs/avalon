# Temporary work streams

> Created 2026-08-24.
>
> A work stream that is discarded when its author leaves it, armed from the Home
> composer and convertible into an ordinary one from the work-stream header.
> Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Conventions for this folder: [`../../prds.md`](../../prds.md).

## Summary

A circular toggle sits at the right edge of the Home composer, at the bookend the
sketch mirrors its search control against. Armed, the composer takes a dashed
ring, and the work
stream started from it is **temporary**: it never enters the sidebar, it is
readable by nobody but its author, it reserves no email address, it writes no
durable memory, and it is deleted the moment its author leaves the screen it is
on. Its header carries a **Temporary** pill in place of the **Private** badge.
Hovering that pill turns it into **Keep this work stream**; clicking it converts
the work stream into an ordinary one, in place, without losing the transcript.

What becomes possible is a question you can ask Avalon without deciding first
whether it deserves a permanent home. Today every sentence typed into the Home
composer creates a durable, addressable, sidebar-listed row that somebody has to
look at again — so a throwaway question costs a small act of housekeeping, and
people either pay it or do not ask. This is the same trade Claude and ChatGPT
resolved with temporary chats, applied to a product whose unit of work is heavier
than a chat and whose agent can act on the world.

That last difference is the whole design problem, and it is settled explicitly
below: **temporary bounds Avalon's own record of the work, not the work's effect
on the world, and not the audit trail of what was done.** A temporary work stream
that sends an email has sent an email. See non-goals 1 and 2.

## Motivation

Avalon has exactly one way to ask it something, and it is expensive. `POST
/workstreams` reserves an email address in the Global registry — a cross-region
hop from every non-Global region, and a second one to activate it — writes the
authoritative object, admits a run, drains the directory facts through
`WorkstreamDO` into `WorkspaceDO`, and flips a D1 route from `verified` to
`active` before it answers
([`workstream-creation.md`](../../workstream-creation.md#what-the-server-makes-you-wait-for)).
The result is a durable row in the sidebar's **Recent** list, an inbound address
that will accept mail for as long as the workspace exists, and a title the naming
agent is dispatched to choose.

That is the correct amount of machinery for a client engagement. It is the wrong
amount for "what is the difference between these two Cloudflare bindings", and
the mismatch has three costs we can name without a metrics stack:

1. **The sidebar accumulates rows nobody meant to keep.** **Recent** is
   recency-sorted, so ten throwaway questions in a morning sit on top of a week of
   real work and push it down a 250-row page. There is no delete: `workstreams.ts`
   exposes no `DELETE /workstreams/:id`, and `archived` is the only retirement path
   there has ever been. Every question asked is permanent, by construction.
2. **People stop asking.** The observable version of this cost is that a product
   whose composer says "Describe a task or ask a question…" is used for tasks and
   not for questions. A question that costs a permanent artifact is a question
   people take somewhere else — which today means a different vendor's chat
   window, with none of this workspace's connectors, memory, or context.
3. **Some questions should not be kept at all.** A salary band, a candidate's
   name, a paragraph pasted out of a contract to check a clause. Today the only
   controls are `scope: 'personal'` — which narrows the room but keeps the row
   forever — and, once meeting notes or a connector has seeded it, nothing.
   "Private" and "not retained" are different promises, and Avalon can only make
   the first one.

The evidence for the direction is that both of the products Avalon is measured
against shipped this feature and shipped it in the composer rather than in
settings, which is where a per-message decision has to live. The evidence for
building it *now* is cost 1: **Recent** degrades monotonically, there is no delete
to relieve it, and every week of use makes the eventual cleanup story larger.

## Goals

1. A person can arm **Temporary** in the Home composer before typing, and the
   work stream started from that composer leaves no durable record in Avalon once
   they leave it.
2. Leaving is unambiguous and never a surprise: the first attempt to navigate away
   from a temporary work stream that has content asks first, and offers keeping it
   as the alternative to discarding it.
3. A temporary work stream can be converted into an ordinary one at any point
   before it is discarded, from a control in its own header, without losing the
   transcript, the resources, or the run in flight.
4. A temporary work stream is invisible to every surface that aggregates work:
   the sidebar, `GET /workstreams`, pins, digests, the activity log, suggested
   work, and contextual routing. Nobody but its author can read it, and it cannot
   be shared with anyone.
5. The agent behaves correctly inside one: it does not write durable memory or
   tables, and it does not tell the person it will remember something it cannot.
6. A discarded work stream leaves no orphan: no email route, no draft resource,
   no directory row, no Terminal sandbox, no pending alarm.
7. Losing a connection is not leaving. A dropped socket, a sleeping machine, or a
   renderer reload returns to the same work stream rather than destroying it.

## Non-goals

1. **Making external writes temporary.** Rejected outright, permanently. If the
   agent sends mail, files a Linear issue, or pushes a commit from a temporary
   work stream, that happened and Avalon will not pretend otherwise. The feature
   discards Avalon's record of a conversation; it has no authority over anybody
   else's systems, and a control implying it did would be a lie with real
   consequences.
2. **Making the audit trail temporary.** Rejected outright, permanently. Every
   authorized external write stays "idempotent, visible, and audited" per the
   product contract, and the receipts of a discarded work stream's writes survive
   it. A retention control that erased the record of what an agent did on
   somebody's behalf is an insider-threat tool, not a privacy feature. **Temporary
   is not untraceable**, and the interface says so where the promise is made.
3. **Converting a permanent work stream into a temporary one.** Deferred, and
   probably forever. Avalon has no delete path; adding one whose entry point is
   labelled "temporary" hides a destructive operation behind a word that does not
   suggest one. If deleting a work stream is wanted, it is its own PRD with its
   own confirmation, authority, and audit story.
4. **Multiplayer temporary work streams.** Deferred. A temporary work stream is
   single-participant: it cannot be made `workspace`-scoped and no participant can
   be added. Two people in a room whose contents vanish when *one* of them
   navigates away is a worse experience than either of the alternatives, and
   deciding whose presence holds it open is a design problem this feature does not
   need to solve to be useful. Converting it first is the supported path.
5. **Temporary automations, temporary automation runs, and temporary Slack or
   email ingress.** Rejected for this change. Every automation run owns exactly
   one work stream and that work stream is its record; an ingress has no composer
   to arm and no author sitting on a view. Retention is a decision made by a
   person at a keyboard, and the only surface where that is true is the Home
   composer.
6. **A history of past temporary work streams.** Rejected — it is the feature
   inverted. There is no "recently discarded" list, no recovery from the trash,
   and no server-side record that a specific temporary work stream ever existed
   beyond the audit rows non-goal 2 keeps and the counted telemetry below.
7. **Exporting a temporary transcript on the way out.** Deferred. The existing
   per-message **Image** and **PDF** actions
   ([`message-export.md`](../../message-export.md)) already work inside a temporary
   work stream and are the escape hatch for one answer worth keeping; converting
   is the escape hatch for the whole thing. A third path that writes a file at
   discard time is more surface than either problem needs.
8. **A retention default, a per-workspace policy, or an admin control.**
   Deferred. Temporary is opt-in per work stream, off unless armed. A workspace
   that wants everything temporary, or nothing, is asking for a policy engine, and
   nobody has asked for one.

## Product behavior

### Arming it

The Home composer (`NewWorkstreamScreen`, `/workstreams/new`) gains one control:
a circular icon button immediately outside the composer's right edge, in the
`composer-dock`, at the bookend the sketch mirrors its search control against.
It is a peer of the composer, not one of the tools inside its toolbar — the
toolbar's controls (`@`, attach, dictate) act on the *message*, and this one
decides what the *work stream* will be.

At rest it is a quiet ghost button carrying a dashed ring. Hover or focus opens
the tooltip from the mock, in Avalon's own vocabulary:

> **Temporary work stream**
> Nothing is kept

Clicking arms it. Armed, the button fills and the composer shell itself takes the
same dashed outline. The dashed ring is deliberately on the composer and not only
on the button: the state has to be legible to somebody who has finished hovering
and is now typing, and a small filled circle at the edge of the eye is not enough
to carry "this will not be saved" through three sentences of typing.

The armed state is **per composition, not a preference**. It resets to off when a
work stream is created, when the screen unmounts, and when the session's draft
scope changes. It is deliberately *not* written to the draft cache
([`composer-drafts.md`](../../composer-drafts.md)) alongside the text: a sentence
restored twelve hours later should not silently carry a retention decision made
yesterday, for the same reason that cache already refuses to restore the model
pinned beside it.

Only the Home composer offers it. The work-stream composer
(`WorkstreamComposer`) does not, because retention is a property of a work stream
and that composer is inside one already; the **New automation** composer does not,
per non-goal 5.

### Starting one

Enter creates the work stream through the existing path with three differences,
and the launch surface is otherwise identical — the same optimistic turn, the same
work timer, the same composer carried across the hand-off:

- **No email address is reserved.** `emailAddress` is null, and the two Global
  registry hops the create pays are not paid. A temporary work stream therefore
  creates *faster* than a permanent one, most visibly in the EU.
- **No naming call is dispatched.** `titleStatus` stays `settled` on the first
  line of the request. Choosing a name is work done so a row can be found again in
  a list this row will never appear in.
- **No listing.** The work stream is absent from `GET /workstreams` and from every
  `WorkspaceDO` list, so it never reaches the sidebar. Its directory row is still
  written — that row is what `WorkspaceDO` applies for socket admission and viewer
  projection, so suppressing it would break the room rather than hide it. It
  carries `retention` and every listing predicate excludes it, which is the same
  shape `system_kind` already uses for a digest occurrence.

The transcript, the composer, the right rail, HyperSight, the Terminal, and every
plugin behave exactly as they do in an ordinary work stream. **Temporary is a
retention decision, not a reduced product.** The one visible difference inside the
screen is the header.

### The header

Where an ordinary private work stream shows the **Private** badge, a temporary one
shows a **Temporary** pill in the same position on the title line. It replaces the
badge rather than joining it: a temporary work stream is readable by one person by
construction, so both would say the same thing twice and the pill says the stronger
of the two.

The pill is a real button, and it is the conversion control:

| State | Reads | Does |
| --- | --- | --- |
| Rest | **Temporary**, dashed ring | Denotes. Nothing. |
| Hover / focus | **Keep this work stream** | Tooltip: *Stops it being discarded. It joins your sidebar and gets an email address.* |
| Click | — | Converts, in place. |
| Converting | **Keeping…** | Disabled. |
| Converted | pill is replaced by the ordinary **Private** badge | A one-line inline confirmation in the subtitle: *Kept. This work stream now behaves like any other.* |

Naming the hover state for the destination rather than the current state is this
repository's own convention for a toggle — the sidebar's **Pin** / **Unpin** and
**Make private** / **Make public to workspace** items are named the same way. The
rest state is the exception on purpose: this pill has a second job the sidebar's
items do not have, which is to *say what the work stream is* to somebody who never
hovers it.

Conversion is one click with no confirmation dialog. It is the safe direction: it
creates something rather than destroying it, the hover state has already said
exactly what it does, and the alternative — a modal between a person and keeping
their work — puts the friction on the wrong side.

There is no control anywhere that turns a permanent work stream temporary
(non-goal 3).

### Leaving it

**Leaving is the destructive act, so leaving is the thing that asks.**

The first time the person navigates away from a temporary work stream that has at
least one turn in it, a modal intercepts:

> **Discard this work stream?**
> It is temporary, so leaving deletes the conversation and everything Avalon
> recorded in it. Anything the agent already sent or changed outside Avalon stays
> done.
>
> [Keep this work stream] [Discard and leave] [Cancel]

**Keep this work stream** is the primary action and converts, then completes the
navigation. **Discard and leave** deletes and completes it. **Cancel** stays. The
second sentence is not padding: it is where non-goals 1 and 2 are told to the
person, at the moment the promise is being made, rather than in a settings screen
nobody reads.

The dialog appears **once per work stream**, not once per navigation. Somebody who
has chosen **Discard and leave** and then come back has understood the deal; asking
again on every exit is what trains people to click through dialogs. An empty
temporary work stream — armed, opened, nothing typed — never asks at all.

Every route change is a leave: the sidebar, Home, a note, settings, a deep link, a
menu-bar item. Quitting Avalon is a leave and is not intercepted, because a quit
that a dialog can cancel is not a quit.

### Being discarded

Deletion is the server's, not the client's. A renderer that is killed, loses its
network, or is force-quit cannot delete anything, and a promise kept only by a
cooperative client is not kept.

- **A deliberate leave discards immediately.** The client issues the discard, the
  work stream and everything object-local to it are deleted, and its pending alarm
  is cancelled.
- **Anything else starts a recovery window.** When the last viewing socket
  detaches without a discard — a dropped connection, a sleeping machine, a renderer
  reload, a crash, a quit — the work stream is marked for deletion **five minutes**
  out. Reattaching inside that window cancels it and the work stream is exactly as
  it was.

The window is a **recovery** window, not a retention window. It exists for one
reason: a lost socket is indistinguishable from a lid closing, and the socket's own
reconnect ceiling is 30 seconds (`socketReconnectDelay`), so a window shorter than
a single reconnect cycle would destroy work streams over ordinary Wi-Fi. Five
minutes clears that cycle by an order of magnitude, survives a sleep and a reload,
and is short enough that "nothing is kept" stays true in any sense a person would
mean it. It is a product limit and this PRD sets it, per
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).

Note what the window does *not* cover, in both directions. Avalon does not restore
its route on relaunch, so quitting and reopening lands on Home and the work stream
expires unreached — the correct outcome, and why the quit path is not intercepted.
And **presence is measured by the socket**, so a person sitting in front of an open
temporary work stream through a network outage longer than five minutes loses it
anyway. That is a real cost and it is accepted knowingly: the only thing that could
distinguish them from a crashed renderer is the renderer's own word, which is
exactly what a promise like this one cannot rest on. They are told when the socket
comes back, rather than finding out by typing into a work stream that is gone.

A run in flight is stopped before deletion, by the same path `POST
/workstreams/:id/stop` uses. A Terminal sandbox is torn down with it.

There is no cap on how long a temporary work stream may live while somebody is
looking at it. It is bounded by a person sitting in front of it, which is a
tighter bound than any number we could justify, and
[`AGENTS.md`](../../../AGENTS.md#where-we-are) is explicit that a limit nobody can
state the cost of omitting should not be added.

### Every state

| State | What the screen shows |
| --- | --- |
| Armed, nothing typed | Dashed composer, filled toggle. No work stream exists. |
| Launching | The ordinary launch surface. The header skeleton is absent — there is no name coming. |
| Live, empty | The ordinary **Ready to begin** empty state, plus the **Temporary** pill. |
| Live, populated | Ordinary transcript. Pill in the header. No sidebar row anywhere. |
| Agent running | Ordinary streaming and work timer. Leaving still asks; discarding stops the run. |
| Converting | Pill disabled, reading **Keeping…**. The transcript is untouched. |
| Converted | **Private** badge, a sidebar row appears, an email address arrives on the next detail read. |
| Conversion failed | The pill returns to **Keep this work stream** with an inline error under the title. Still temporary, still discardable, nothing lost. |
| Offline, briefly | The composer reports the socket state exactly as it does now. The recovery window is running, invisibly; reconnecting inside it is a no-op the person never sees. |
| Offline past the window | On reconnect the work stream is gone. The screen replaces itself with the discarded state rather than leaving a live-looking transcript that can no longer be sent to. |
| Reattached after expiry | `GET /workstreams/:id` answers 404 and the screen shows the ordinary not-found state, worded for this case: *This work stream was temporary and has been discarded.* |

## Impact on the product contract

**This changes the contract, in one clause.** The brief opens:

> A work stream is the durable, multiplayer home for a task, investigation,
> deliverable, client engagement, or automation run.

A temporary work stream is neither durable nor multiplayer. The proposed
amendment, which this PRD asks for explicitly rather than assuming:

> A work stream is the durable, multiplayer home for a task, investigation,
> deliverable, client engagement, or automation run. A work stream started as
> **temporary** is the one exception: it has a single participant, it is
> discarded when its author leaves it, and nothing else in Avalon may create one.

Three consequences worth naming at the top of that conversation:

1. **"Durable" is doing real work in that sentence, and this narrows it.** Every
   subsystem downstream — the directory, digests, activity, suggested work,
   routing, memory — was written against a world where a work stream that exists
   now exists later. This adds a kind that does not, and goal 4 is the list of
   places that have to learn it.
2. **Viewing now decides existence, though it still does not create
   participation.** The contract's second clause ("Viewing does not create
   participation") is unchanged and remains true. But viewing has only ever been a
   *displayed* fact — `workspace_workstream_viewers` records who is attached so the
   room can show them — and it has never decided any state. Now it holds a work
   stream open. That is a new relationship between presence and existence, and it is
   the part of this design most likely to surprise whoever touches the socket layer
   next.
3. **The remaining clauses hold unchanged**, and one of them load-bears: "Ordinary
   authorized external writes execute without a global approval gate, but every
   attempt is idempotent, visible, and audited." Non-goal 2 is that clause,
   defended. Retention may not reach it.

## Decision log

None yet.

## Key design decisions

1. **It is a real work stream with a retention property, not a second
   non-persisted path.** Rejected: keeping a temporary conversation entirely in the
   renderer and never telling the server. It cannot work — the harness admits a run
   through durable SQL before the child acknowledges the launch
   ([`agent-harness.md`](../../agent-harness.md)), so an agent turn without a
   `SubstreamAgent` is not a feature we can build without rearchitecting the loop.
   It is also the wrong shape: everything a temporary work stream needs (the
   transcript, resources, plugins, Terminal, HyperSight) already exists on the real
   one, and a parallel path would reimplement all of it and drift. One column and
   an alarm is the version that is cheapest to reverse.

2. **`retention` is a third orthogonal question, not an extension of `scope` or
   `system_kind`.** The schema already separates *who may read it* (`scope`) from
   *whether it is listed* (`system_kind`), and the contract comment on `systemKind`
   says so outright. **Whether it is kept** is a third question, and overloading
   either existing column would fuse two answers that move independently — a
   converted work stream changes its retention and nothing else. Rejected:
   `system_kind = 'temporary'`, which would have inherited the digest row's
   semantics and made "hidden from lists" and "deleted on exit" the same bit.

3. **The default is `permanent`, and that is the opposite reasoning from
   `scope`'s default — deliberately.** A work stream is born `personal` because the
   dangerous failure is publishing something nobody meant to publish
   ([`data-model.md`](../../data-model.md#2026-08-21--a-work-stream-is-born-private)).
   A work stream is born `permanent` because here the dangerous failure is the
   reverse: destroying something somebody meant to keep. The safe omission points a
   different way for each column, which is exactly why they must not be one column.
   A caller that names no retention has decided to keep.

4. **Deletion is server-owned and viewer-driven, reusing two things that already
   exist.** `workspace_workstream_viewers` already records who is attached to a work
   stream, and `ScheduledDurableObject` already gives an object a list of scheduled
   alarms with one slot ([`durable-object-alarms.md`](../../durable-object-alarms.md)).
   Detach arms an entry, attach cancels it, the alarm deletes. Rejected: a
   `beforeunload` handler in the renderer, which is unreliable on a crash, absent on
   a kill, and would have made the promise depend on the one process that cannot be
   trusted to keep it. Also rejected: a workspace-wide sweep, which is a second
   mechanism for something the object can decide locally.

5. **The intercept is on leaving, not on arming.** Rejected: a confirmation when
   the toggle is armed. Arming is reversible and costs nothing; leaving is the
   irreversible act, and it is also the moment the person has something to lose and
   can weigh it. A dialog at arming time trains people to dismiss the dialog that
   matters.

6. **Conversion is one-way and one-click.** Both halves follow from Avalon having
   no delete: there is nothing to convert *back* to (non-goal 3), and the direction
   that exists only ever creates. The alternative considered was a confirmation on
   conversion, rejected because the hover state already states the outcome and the
   action is not destructive.

7. **The copy says "work stream", not "chat".** The mock says *Temporary chat*.
   Avalon has no chats, and [`prds.md`](../../prds.md) requires the product and its
   documents to share one vocabulary. Rejected: adopting "chat" for this surface on
   the grounds that it is what the competitors call it — a second word for the
   product's only noun is a cost paid on every screen thereafter.

8. **The entry point does not depend on the search control.** The mock positions
   the toggle as a mirror of a circular search button on the composer's left. That
   button is in the sketch and not in the product — the Home composer today has no
   control on either side. This ships on the right regardless; if search lands
   later, the pair is symmetric, and if it never does, the toggle is still where an
   ad-hoc thought is typed. Noted because a reader comparing the mock to the built
   screen will otherwise think something was dropped.

## Data model

One column on the work-stream product root and one on the directory projection.

| Column | Where | Meaning |
| --- | --- | --- |
| `retention` | `SubstreamAgent`'s object-local `workstream` row; `WorkstreamDO.workstream_metadata`; `WorkspaceDO.workspace_workstream_directory` | `'permanent'` (default) or `'temporary'`. |
| `discard_after` | The same rows | The instant the recovery window expires, or null while somebody is attached. |

`retention` is `NOT NULL DEFAULT 'permanent'` with a `CHECK` constraint, on the
bootstrap row as well as the authoritative one — the runtime compatibility insert
writes `COALESCE(NEW.scope, scope)` for `scope`, and the same pattern applies here,
so the bootstrap default has to be the safe one for an omission to be safe (key
design decision 3).

On the wire, `WorkstreamSchema` gains `retention`, defaulting to `'permanent'` on
read for the same fail-safe reason. `UpdateWorkstreamRequestSchema` gains
`retention`, accepting `'permanent'` only; `'temporary'` on an existing work stream
is refused with `workstream_retention_not_reversible`.

Listing paths exclude `retention = 'temporary'` in the same predicate that already
excludes `system_kind IS NOT NULL`: the directory page reads, the pin reads, the
sidebar batch, suggested work's candidate scan, and the activity/digest projections.

Deletion removes the `SubstreamAgent`'s object-local rows, the `WorkstreamDO`
metadata, the `WorkspaceDO` directory row and its viewer children (already
`ON DELETE CASCADE`), any draft resources the composer uploaded, any Terminal
sandbox, and — on the client — the device's cached draft for that work stream. It
does **not** remove connector delivery receipts, external write audit rows, or
telemetry (non-goal 2). Those rows keep the `workstream_id` they were
written with; the id resolves to nothing, and that is the record being correct
rather than a dangling reference.

Nothing is backfilled. Every existing row reads `permanent`.

A new socket event `workstream_retention_changed` mirrors
`workstream_scope_changed`, so an open room learns about a conversion the same way
it learns about a scope change.

## Regional impact

A temporary work stream reserves no email route, so it pays neither of the two
Global registry hops the create path pays from a non-Global region. It is therefore
the first create in Avalon that is *cheaper* than the ordinary one, and the saving
is largest exactly where the ordinary create is slowest. Conversion pays the
reservation hop at the moment it converts, on a path where a person has already
accepted that they are creating something durable.

Deletion is object-local plus a directory removal inside the same region. Nothing
about a temporary work stream crosses a regional boundary, which is a stronger
residency story than the permanent case rather than a weaker one. See
[`regionalization.md`](../../regionalization.md).

## Security and trust model

- **Readable by exactly one person, enforced on the row.** A temporary work stream
  is `personal` with its creator as the only participant, and `PATCH` refuses to
  move it to `workspace` while it is temporary. `addParticipant` refuses it. This
  is enforced in `WorkstreamDO`'s authoritative scope rule, not in the client.
- **The known `personal` read gap applies here too, and matters more.**
  [`data-model.md`](../../data-model.md#work-streams) records that the single-row
  read admits `created_by_user_id` while `canRead` tests participation alone. For a
  temporary work stream the creator *is* the only participant, so the two rules
  agree and the gap is unreachable — but it must not be widened by this change, and
  a temporary work stream must never be created with a creator who is not seated.
- **Temporary is not untraceable, and the interface says so.** The leave dialog
  states it in the second sentence. Audit receipts, connector delivery records, and
  the workspace's own record of what an agent did survive the work stream by
  design. Anyone reasoning about this feature as a way to do unlogged work should
  find that answered in the first place they look.
- **The device's draft cache is discarded with it, and that is not automatic.**
  A composer caches its unsent text and staged files under `workstream:<id>` in the
  renderer's IndexedDB for twelve hours
  ([`composer-drafts.md`](../../composer-drafts.md)). Left alone, a half-typed
  sentence in a temporary work stream would outlive the work stream itself on the
  one device the person is looking at — the promise broken in the most visible
  place available. Discarding must release that draft key and its attachment rows,
  and this is a requirement of the feature rather than a cleanup detail.
- **Discarding is still not sanitizing.** Deletion removes Avalon's rows. It does
  not overwrite storage and it does not reach a provider's copy of anything the
  agent sent. The promise is "Avalon does not keep this", which is precisely the
  promise the copy makes.
- [`security.md`](../../security.md) owns the boundaries this sits inside; nothing
  here moves one.

## Agent behavior

**No tool's wire shape, name, description, or schema changes.** What changes is
which tools are *registered* for a run whose work stream is temporary, and one
conditional section in the system prompt. The catalog in
[`agent-tools.md`](../../agent-tools.md) is unaffected.

### What a temporary run may load

| Plugin | Permanent run | Temporary run |
| --- | --- | --- |
| `avalon_memory` | `search`, `add`, `update`, `invalidate` | `search` only |
| `avalon_tables` | full | reads only |
| `avalon_core`, `avalon_workstream`, `avalon_web`, `avalon_discovery`, Terminal, connectors | unchanged | unchanged |

Reads stay because recall is what makes the answer good and reading leaks nothing.
Writes go because a durable memory or table row outlives the work stream that
wrote it — which is the one thing the feature promises will not happen. A temporary
work stream that quietly seeded workspace memory would be the exact leak the
control exists to prevent, and it would be invisible to the person who armed it.

The harness already registers only the applicable bundles per run
([`agent-harness.md`](../../agent-harness.md)), so an unregistered tool is not
advertised and cannot be called. There is no new failure code and no new error
sentence: the model is never in a position to attempt the write.

### What a temporary run is told

The absent tools are not enough on their own. The standing prompt carries
`- Treat recalled memory as fallible context. Search before writing, update or
invalidate instead of duplicating, choose the narrowest durable scope…`, whose
write clause has no referent on a temporary run. `packages/agent-harness/src/prompts/workstream.ts`
already records, in its own comment on `deliveryPolicy`, why that is worth fixing
rather than tolerating: *"a rule whose subject is absent is one a model has to
resolve before it can ignore it."*

So `renderWorkstreamSystemPrompt` gains a conditional section, appended the way
`deliveryPolicy` and `authorityPolicy` already are, and the standing memory
bullet's write clause becomes conditional on the same input:

```
# Temporary work stream
- This work stream is discarded when the person viewing it leaves. Avalon keeps no
  record of this conversation afterwards.
- You cannot write durable memory or tables here. Never say you will remember
  something, note it, or use it next time — none of that survives this
  conversation. Answer now instead.
- Anything you send or change outside Avalon is not temporary and is not undone.
  Do not describe an external write as temporary, private, or reversible because
  this work stream is.
```

The third bullet is the one that earns its place. Without it the model has been
told the conversation is disposable and will reasonably extend that to the work —
"I'll send a quick draft, it's just a temporary chat" — and a model that
mischaracterises an outbound send is worse than one that never mentions retention
at all.

`retention` also joins the frozen task-context JSON, so the fact is available to a
skill or plugin that needs it without a second prompt section.

Per [`writing-prompts.md`](../../writing-prompts.md) this section must hold on the
configured medium fallback model, not only the strongest one: the acceptance below
requires an evaluation that a temporary run does not promise to remember and does
not describe an external write as reversible.

## Rollout

Behind the client feature flag `temporary-workstreams`, resolved through
`client-feature-flags.ts` and therefore **failing closed** — an unbound binding, an
unreachable Flagship, or a mistyped value all mean the toggle is absent and every
create is permanent, which is the pre-change behavior exactly.

The flag gates the composer control only. The server accepts and honours
`retention` regardless, so a work stream created while the flag was on is still
discarded correctly if the flag is turned off underneath it — the alternative
would strand a temporary work stream as a permanent one nobody asked for.

No migration and no backfill: the column defaults, and every existing row means
what it already meant.

Turning it off is turning the flag off. Work streams already created stay
temporary and expire normally.

Telemetry: `workstream_created` gains a `retention` property; a
`workstream_retention_changed` event records a conversion; a
`workstream_discarded` event records an expiry and whether it came from a
deliberate leave or a recovery-window timeout. All three carry ids and enums under
the existing `product` classification and **no title and no message text** — the
question these answer is whether the feature is used and whether people convert,
which needs counts and not content. See
[`adding-new-instrumented-event.md`](../../adding-new-instrumented-event.md).

## Acceptance

Walk these in a real window, per [`AGENTS.md`](../../../AGENTS.md):

1. Arm the toggle on Home. The composer takes the dashed ring; the tooltip reads
   **Temporary work stream / Nothing is kept**.
2. Send a message. The work stream opens with a **Temporary** pill and no
   **Private** badge. **Recent** in the sidebar gains no row. `GET /workstreams`
   does not return it. Its detail carries a null `emailAddress`.
3. Ask the agent to remember something. It declines to promise it and answers
   instead. `memory_add` is absent from the run's registry.
4. Click the sidebar. The dialog appears. **Cancel** — nothing is lost. Leave
   again and choose **Discard and leave**: the work stream is gone, and returning
   to its URL shows the discarded not-found state.
5. Start another. Hover the pill — it reads **Keep this work stream**. Click it.
   The pill becomes **Private**, a sidebar row appears, and the transcript is
   unchanged. Navigating away now asks nothing.
6. Start a third, pull the network, wait past the socket's reconnect ceiling,
   restore it. The work stream is intact and its pending deletion is cancelled.
7. Start a fourth, quit Avalon, reopen it after six minutes. The work stream is
   gone and no directory row, email route, or alarm remains.
8. Turn the flag off. The toggle is absent and Home behaves exactly as it does
   today.
9. On the configured medium fallback model, not only the strongest one: a
   temporary run asked to remember something answers instead of promising, and a
   temporary run asked to send mail does not describe the send as temporary,
   private, or reversible. Per [`writing-prompts.md`](../../writing-prompts.md),
   a frontier model getting this right is not evidence.

Whichever of these become durable checks land per [`e2e.md`](../../e2e.md).

## Open questions

- **Does a temporary work stream appear in the menu bar's **Recent** five while it
  is open?** It inherits the listing exclusion, so it will not — and that is
  probably right, since the menu bar exists to get back to work from outside the
  app and a temporary work stream cannot be got back to. But nobody has looked at
  it deliberately. Blocks nothing; the answer today is "no" by inheritance rather
  than by decision.
- **Should the leave dialog be suppressible?** A power user asking twenty throwaway
  questions an hour meets it twenty times. Once-per-work-stream is the compromise
  this PRD proposes; a "don't ask again" checkbox trades the safety of goal 2 for
  it. Deferred until somebody has actually used the feature for a week.
- **Does conversion re-dispatch the naming agent?** A converted work stream is
  titled by the first line of its opening message, which is the placeholder the
  naming agent exists to replace, and it now lives in a list where a name matters.
  Dispatching at conversion is the obvious answer and costs a call on a path that is
  already doing a round trip. It does not block the build.

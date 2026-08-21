# Work-stream groups

> Created 2026-08-21.
>
> A workspace-wide, named, icon-marked set of work streams that everyone in the
> workspace sees, carries a list of resources every work stream in it is given,
> and is called either a *group* or a *project* according to one workspace
> setting. Standing contract: [the Avalon implementation
> brief](../2026-08-05_avalon-implementation-brief/prd.md). Governing documents
> for the surfaces this touches:
> [`../../workstream-pinning.md`](../../workstream-pinning.md),
> [`../../workstream-durable-object.md`](../../workstream-durable-object.md),
> [`../../workstream-origin-attachments.md`](../../workstream-origin-attachments.md),
> [`../../theming.md`](../../theming.md), and
> [`../../choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md).

## Summary

A **group** is a named, shared collection of work streams that belongs to the
workspace. Anybody in the workspace can create one from a plus button on the new
**Groups** section of the sidebar, which sits below **Pinned** and above the
time-sorted list. Creating one asks for three things — a name, an icon from a
set of twenty, and one of ten colours to draw that icon in — and nothing else.
Work streams go into a group by right-clicking a row and using the **Add to
group** submenu, or by dragging the row onto the group. A group is a collapsible
list of the work streams in it; an empty one says *Add a work stream to Blogs*.

Membership is additive, not a move. A work stream in a group stays in its
recency bucket and stays in **Pinned** if it is pinned, and every row it appears
on carries a small circular marker — the group's icon in the group's colour —
between the status dot and the title. Clicking that marker expands the group and
scrolls it into view rather than opening the work stream. Clicking the group row
itself opens a small home page for the group: its name in the header, and one
**Work streams** section listing what is in it, in the shape the new-work-stream
screen already uses for **Waiting for input**.

A group also carries **default resources**. A resource added to a group's
defaults is attached to every work stream already in that group and to every work
stream added afterwards, live — a work stream open on a screen shows it arrive
without a refetch. Removing a default from the group is not a retraction: the
work streams that already have it keep it, and only later ones stop getting it.

Finally, Settings → Workspace gains **Group terminology**, a two-option dropdown —
**Group** or **Project** — that changes the word everywhere in the interface. The
codebase says *group* everywhere regardless; the setting is a rendering decision
and nothing else.

## Motivation

The sidebar has exactly two organizing ideas today, and neither of them is
shared. Work streams are grouped by recency — *Today*, *Yesterday*, *Last week* —
which is a fact about when something last moved, not about what it is for. Above
that sits **Pinned**, and [`workstream-pinning.md`](../../workstream-pinning.md)
is explicit that a pin is "one person's opinion about a shared row": it tells
nobody else anything and appears on nobody else's screen. So there is no way for
two people in a workspace to agree that eleven work streams are the same piece of
work, and no way for a third person to discover that agreement.

That gap is load-bearing here rather than cosmetic, because Avalon has
deliberately given itself no way around it. The [implementation
brief](../2026-08-05_avalon-implementation-brief/prd.md) organizes the product
"around concrete work streams rather than channels, direct messages, search, or
a global inbox". With no search and no inbox, the sidebar *is* the index, and
the sidebar's index is time. A client engagement that has been quiet for two
weeks is reachable only by scrolling past everything that has happened since,
and the person who knows it exists is the only person who can find it.

The second cost is setup, repeated by hand. Attaching a resource to a work stream
is one call per work stream — `POST /workstreams/:id/resources`, driven from the
inspector rail one row at a time. A team working through a project against the
same Notion spec, the same Linear project, and the same GitHub repository
re-attaches those three things to every new work stream about it, and every work
stream where somebody forgot is a work stream where the agent starts without the
context the rest of them had. `workstream_list_resources` is how the agent finds
out what it may read; a resource nobody remembered to attach is a resource that
does not exist as far as the run is concerned.

**Where this came from.** The proposal is a direct product request — groups (or
projects) as a sidebar section, created from a plus button, with an icon, a
colour, drag-to-add, a per-row marker, a small home page, default resources that
propagate, and a workspace setting choosing the word. That request is the
evidence that this is wanted now; the rest of this section is the case that the
product has a matching gap. Recording it here rather than implying a support
thread nobody can find: no incident, no ticket queue, and no measurement stands
behind this document, and a reader deciding whether to build it should weigh it
on that basis.

**We cannot put numbers on either cost.** There is no usage telemetry that counts
scroll depth in the sidebar or resource re-attachment, and per [the rule
sheet](../../../AGENTS.md#where-we-are) that is a constraint on how this decision
gets made, not a reason to defer it: the argument above is structural and reads
off the code and the contract rather than off a measurement nobody here can
produce. What the design does about it is choose the cheap, reversible version —
a sidebar section, a membership table, and a fan-out — over the expensive one,
and leave everything that would need evidence to justify in
[the appendix](#appendix--future-improvements).

## Goals

1. Anybody in a workspace can create a named group with an icon and a colour, and
   everybody in that workspace sees it in the same place in their sidebar.
2. A work stream is put into a group, and taken out again, from the sidebar —
   both by right-clicking the row and by dragging it — without leaving the
   sidebar and without opening the work stream.
3. A work stream that is in one or more groups says so on every row it appears
   on, and one click from that marker gets to the group in the sidebar.
4. Group membership costs a work stream nothing: it stays where it already was,
   in its recency bucket and in **Pinned**, and can be in several groups at once.
5. A group has a home page that answers "what is in this?" — its name and the
   work streams it holds, each of which opens.
6. A resource added to a group's default resources is attached to every work
   stream in that group, including ones added to the group later, without anybody
   attaching it by hand, and a work stream open on screen shows it arrive.
7. Removing a default resource from a group never removes it from a work stream
   that already has it.
8. A workspace chooses whether the interface says *group* or *project*, and that
   choice changes every user-visible occurrence of the word at once.
9. The codebase says `group` — table, column, contract, route, component, and
   test — whatever the interface is rendering.

## Non-goals

1. **Private groups.** Every group is workspace-scoped and readable by every
   member. The `scope` column exists and is written `'workspace'`, and no route
   changes it. Deferred, not rejected — see [the appendix](#1-private-groups).
2. **Participant mutation.** A group records its creator as its one participant
   and offers no way to add or remove another. Nothing today reads that set;
   it grants no access, because access is already "everyone in the workspace".
   Deferred — see [the appendix](#2-group-participants-that-mean-something).
3. **Nested groups.** A group holds work streams, never other groups. Rejected
   for now: nesting doubles the sidebar's tree logic and the marker's meaning to
   buy an arrangement no one has asked for.
4. **Groups as a place to post.** A group has no transcript, no composer, no
   participants who receive anything, no unread state, and no agent run of its
   own. This is the line that keeps a group from being a channel, and it is not
   deferred — it is [what the contract forbids](#impact-on-the-product-contract).
5. **A group's own agent context or memory.** Default resources are the only
   thing a group pushes into a work stream. A group does not carry standing
   instructions, a skill, a model pin, or a compaction checkpoint. Deferred —
   see [the appendix](#4-standing-group-instructions).
6. **Automations scoped to a group.** An automation's subscription scope stays
   `You` or `Workspace`. Deferred.
7. **Removing a default resource from work streams that already have it.**
   Explicitly rejected, per goal 7: a work stream's resource list is the record
   of what that work stream was actually run against, and retroactively editing
   it makes past runs unreadable.
8. **Reordering the group list by hand.** Groups sort by name. Deferred — see
   [the appendix](#3-a-hand-arranged-group-list).
9. **Reconciling a work stream that missed a fan-out.** The fan-out retries and
   then dead-letters; there is no sweep that repairs a work stream the queue gave
   up on. Deferred — see [the appendix](#5-a-fan-out-reconciliation-pass).
10. **User-defined terminology.** The terminology setting is a two-value enum.
    A workspace cannot type its own word, and most likely never will be able to:
    a free-text label has to be pluralized, case-folded, and translated at every
    call site, and none of that is worth a third option nobody has asked for.
11. **Groups in the macOS menu bar or the ⌘1–9 shortcut run.** Both surfaces stay
    exactly as [`menu-bar.md`](../../menu-bar.md) and
    [`workstream-pinning.md`](../../workstream-pinning.md) describe them.
12. **A mutation audit log.** Who renamed a group, who removed a work stream from
    one, and who deleted one are not recorded. Attachment provenance is kept;
    mutation history is not. Deferred — see
    [the appendix](#8-a-mutation-audit-log).
13. **A cap on how many work streams a group holds.** The group's list pages
    instead. Rejected on the precedent in
    [`workstream-pinning.md`](../../workstream-pinning.md), where a pin cap was
    shipped, narrowed to a visibility-filtered count, and then removed outright
    because neither form worked.

## Product behavior

### The Groups section

The sidebar gains one section, between **Pinned** and the recency-grouped work
streams. Its heading reads **Groups** (or **Projects**), and to the right of the
heading sits a small plus `IconButton` labelled *New group*.

**The heading and its plus button always render, even with no groups.** That is a
deliberate departure from the neighbouring rule: **Pinned** hides itself when
nothing is pinned, on the grounds that an empty heading is "a standing invitation
to a feature the reader has not used". The difference is that pinning has another
entry point — the right-click menu on any row — and creating the first group does
not. Hiding the section would hide the only affordance that makes one. With no
groups the section is the heading and the button and nothing else; there is no
empty-state line under it.

Each group renders as a disclosure:

- A **group row**: the group's icon drawn in the group's colour, the group's
  name, and a chevron. Clicking the name navigates to the group's home page.
  Clicking the chevron — its own button, with its own accessible name —
  expands or collapses the list. The two are separate targets so that the row can
  do the obvious thing (open the group) without the collapse becoming
  unreachable.
- **The work streams in it**, rendered with the same row component the rest of
  the sidebar uses, ordered by last activity, newest first — and **paged the same
  way the main list is**, following `nextCursor` as the scroll approaches the
  bottom. A group is not capped: pinning tried a cap twice and removed it
  (`docs/workstream-pinning.md`, 2026-08-11 — "the cap could not be made to work
  in either of its two possible forms"), and a group is more likely to be large
  than a pin list, not less. Paging rather than capping is also what keeps
  `GET /groups/:id` and the fan-out honest at the top end; see [group
  size](#how-large-a-group-gets).
- **When empty**, one light italic line: *Add a work stream to Blogs* — the
  group's own name, so the instruction names the thing it is about.

**Archived work streams are not in a group's list.** A work stream leaves the
sidebar by `archived_at`, not by deletion, and every existing read filters on it —
`visibleWorkstreamIds`, the list query, and the pinned rows all do. A group
filters the same way, so archiving removes a row from its group exactly as it
removes it from *Yesterday*, and the header's count on the group's home page
counts only what that viewer can actually see. The membership row is left alone:
un-archiving puts the work stream back in its groups with nothing to redo. This is
the failure pinning already had and fixed — a pinned row that renders nothing and
offers no menu is a slot that cannot be freed — and a group inherits the answer
rather than rediscovering it.

Collapse state is per person and per device, kept beside the sidebar width in
`ui-store` and `localStorage`, not on the server. It is a viewport preference
like a pane width, and the repository already keeps those on the device.

Groups sort by name, case-insensitively ascending. Names are unique within a
workspace, case-insensitively, so the marker on a row is never ambiguous about
which *Blogs* it means; creating or renaming to a name already taken fails with
that reason.

While the first page of workspace state is loading, the section shows the same
skeleton the **Automations** section shows. Offline, it renders the last cached
groups; every mutation below fails with an inline error and nothing is applied.

> **Implementation hazard.** `sidebar.tsx` already calls the recency buckets
> `groups` — `groups.map((group) => …)`, `group.label`, `groupActivityItems` in
> `lib/format`. Those are date buckets and have nothing to do with this feature.
> Rename them (`recencyBuckets`) in the same change, or the file acquires two
> unrelated meanings for its most common identifier.

### Creating a group

The plus button opens a modal with exactly three controls:

1. **Name.** Required, 1–60 characters, trimmed. **Create** stays disabled until
   it is non-empty.
2. **Icon.** A grid of twenty, chosen to be diverse enough that a workspace of a
   dozen groups can give each one a distinguishable mark: rocket, target, flask,
   book, briefcase, code, compass, feather, flag, folder, globe, hammer, heart,
   layers, lightbulb, megaphone, palette, puzzle, sparkles, users.
3. **Colour.** A row of ten swatches, which shade the icon's foreground. The
   colours are palette entries, not free-form values — see key design
   decision 3.

The modal opens with an icon and a colour already selected, rotating through the
set by how many groups the workspace has, so somebody who types a name and
presses **Create** still gets a mark that is not identical to their last group.

On success the modal closes and the group appears in the section, expanded and
empty. On failure the modal stays open with everything the person typed still in
it, and an `InlineError` says why.

The same modal, reached from the group row's right-click menu or the home page's
overflow menu, edits an existing group's name, icon, and colour. **Delete
group** sits in those same menus behind a confirmation that says what deleting
does *not* do: it removes the group, and it removes nothing else — not a work
stream, not a resource, not an attachment a work stream already has.

### Putting a work stream in a group

**From the right-click menu.** Every work-stream row's context menu gains an
**Add to group** submenu — the sidebar's first Radix `ContextMenu.Sub` — listing
every group in the workspace as a checkbox item showing whether this work stream
is already in it. Selecting one toggles membership, so the submenu is how a work
stream is both added and removed. Below the list, a separator and **New group…**
opens the create modal, and creating from there adds this work stream to the new
group. When the workspace has no groups yet, there is no submenu: a single **Add
to group…** item opens the modal directly, because an empty submenu is a dead end.

A row rendered *inside* a group section also gets a direct **Remove from Blogs**
item, naming that group, so the common case is one click rather than a submenu.

**By dragging.** A work-stream row can be dragged onto a group row or into an
expanded group's list, and releasing adds it. This reuses the drag the **Pinned**
section already has: the payload on `dataTransfer` is already the work-stream id
as `text/plain`, and the group targets accept the same payload, so a row dragged
out of **Pinned** and released on a group is added to the group and *stays
pinned*. A collapsed group expands when a drag hovers over it for a moment, so
that a release lands somewhere visible. Dropping a work stream into a group it is
already in does nothing. `dragend` is read the same way **Pinned** reads it — a
`dropEffect` of `none` is Escape, or a release nothing accepted, and changes
nothing.

Adding and removing apply optimistically to the cached list and revert with an
error if the request fails; the drag is what the reader is looking at, and a
round trip before the row moves reads as the drop not working.

Membership is many-to-many and additive:

- A work stream can be in several groups at once.
- Being in a group does **not** remove it from its recency bucket, and does not
  affect its pin. The same row can legitimately be on screen three times — under
  **Pinned**, under a group, and under *Yesterday*.
- Group membership says nothing about who may read the work stream. A personal
  work stream in a group is still visible only to the people it was already
  visible to; other members see the group without that row in it.

### The group marker on a row

On a work-stream row rendered outside a group section, between the status dot and
the title, one small circular marker per group the work stream is in: the group's
icon, in the group's colour, inside a circle. Markers follow the group order; at
most three render and any beyond that collapse into a `+N` counter whose tooltip
names the rest. Inside a group section, the row shows markers only for its *other*
groups — repeating the group you are already looking at is noise.

Clicking a marker does not open the work stream. It expands the group if it is
collapsed, scrolls the group's heading into view, and moves focus there. It uses
the reveal machinery pinning already has and inherits its behaviour: the scroll
is `block: 'nearest'` so a group already on screen is not moved, it is `smooth`
unless the reader has asked for reduced motion, and the intent expires after
`REVEAL_DEADLINE_MS` rather than sitting armed against a later socket update.

**The markers sit beside the `NavLink`, not inside it.** An interactive button
nested in an anchor is invalid, and the obvious shortcut does not work:
`stopPropagation()` does not set `defaultPrevented` and does not cancel the
ancestor anchor's navigation, so a marker written that way would follow the link
to the work stream instead of revealing the group — the row's own handler
(`sidebar.tsx:470-472`) only checks `defaultPrevented`. The markers are therefore
siblings of the link inside the row wrapper, laid out into the gap between the
status dot and the title, and each one calls `preventDefault()` as well.

Each marker's accessible name is *In group Blogs. Show it in the sidebar.* and it
is reachable by keyboard, because it is the only route from a row to its group.

### The group home page

Clicking a group row opens `/groups/:id`.

- **Header.** The group's icon in its colour, and its name, in the same header
  geometry the new-work-stream screen uses. An overflow menu carries **Rename**,
  **Change icon and colour**, and **Delete group**.
- **Work streams.** One section, headed **Work streams**, listing the group's
  work streams in the treatment **Waiting for input** already uses on the
  new-work-stream home, ordered by last activity, newest first. A row opens that
  work stream. Empty, it shows the same italic line the sidebar does.
- **Default resources.** A second section, below, listing the group's defaults.
  **Add resource** opens the resource picker the inspector rail already uses.
  Each row has a remove control.

A member sees the work streams in the group *they can read*, which is what the
sidebar already shows them; the count in the header is the same filtered count,
not a total that hints at rows they cannot see.

Loading shows skeletons in both sections. A group that has been deleted in
another window resolves to the not-found screen.

### Default resources

Adding a resource to a group's defaults does two things: it records the resource
on the group, and it attaches that resource to **every work stream currently in
the group**. From then on, every work stream added to the group is given the
group's whole default set at the moment it joins.

The rules, stated in full because most of them are about what does *not* happen:

- The attachment carries `relationship_type = 'group_default'`, alongside the
  existing `attachment`, `origin`, `generated`, `inbound_email`,
  `suggested_activity`, and `message_attachment`. The column carries no `CHECK`
  constraint, so adding a value needs no migration — which is also why the list
  is worth reading off the code rather than trusting this one to stay complete.
- Attachment is idempotent per (work stream, resource). A resource a work stream
  already has keeps the relationship type *and the attribution* it already had.
- **Neither existing attachment path can be used to do this**, so the build adds
  one. `attachResource` has the right conflict semantics
  (`ON CONFLICT(resource_id) DO NOTHING`) and publishes `resource_attached`, but
  it opens with `this.authorize(auth)` and a queue consumer has no
  `AuthContext`. The userless path, `attachRuntimeResource`, is not equivalent in
  either respect: its clause is `ON CONFLICT(resource_id) DO UPDATE SET …
  relationship_type = excluded.relationship_type`, which would rewrite an
  existing `origin` or `attachment` link as `group_default`, and it returns
  `void` without a `publishLocalProductEvent`, so an open work stream would never
  see the resource arrive. Using it as-is would break the "keeps the relationship
  type it already had" rule above *and* acceptance criterion 7.

**The operation the build adds.** One internal, userless RPC — call it
`attachGroupDefaultResource` — is the only thing that writes a group default, and
**both** the queue fan-out and the synchronous join-a-group path go through it,
so the two cannot drift. Its contract:

1. Verify the work stream's identity against the workspace, the way
   `attachRuntimeResource` already does with `parent_workspace_key`.
2. Insert the link with `ON CONFLICT(resource_id) DO NOTHING`, carrying the
   `attached_by_user_id` the caller supplies.
3. Advance `resource_inventory_revision` **only when a row was actually
   inserted** — an existing link is not a change, and revving it invalidates
   every cached invocation in that work stream for nothing.
4. On conflict, change nothing: not the relationship type, not the attribution,
   not `updated_at`.
5. Publish `resource_attached` **only for a newly inserted link**, so a
   redelivered queue message is silent rather than announcing an arrival twice.

Steps 2–5 are what make the operation safe to retry, which matters because the
queue delivers at least once.

**The drain tolerates a group that is gone.** Because removing a default — or
deleting the group entirely — deliberately does not cancel an attach already in
flight, the alarm and the consumer must both treat a missing group, a missing
default row, or an archived target work stream as an ordinary outcome: complete
the attach if the work stream is still there, drop the intent if it is not, and
in neither case throw. An outbox row that raises on a vanished parent would wedge
the drain for every other group in the workspace behind it.
- **Removing a default from the group detaches it from nothing.** Later work
  streams stop being given it; every work stream that has it keeps it. The
  confirmation says so in those words.
- **Removing a work stream from a group detaches nothing**, for the same reason.
- **Deleting a group detaches nothing.**
- Only a resource that is visible workspace-wide can be a group default — see
  [the security section](#security-and-trust-model).
- A group holds at most 20 default resources; a workspace holds at most 200
  groups.

### How large a group gets

**Group membership is deliberately unbounded**, which makes its size the number
three other things have to survive.

- **The sidebar** pages a group's rows and follows `nextCursor`, exactly as the
  main list does. An expanded group of 800 renders a page, not 800 rows.
- **`GET /groups/:id`** pages its **Work streams** section the same way.
- **The fan-out** is one message per member, so adding a default to a group of N
  enqueues N. That is the number [key design decision
  4](#key-design-decisions) rests on, and it is why the outbox is drained in
  bounded batches on the alarm rather than enqueued in one burst inside the
  request: the queue absorbs 5,000 messages a second and 25 GB of backlog, and
  the object hands it work at its own pace. A large group makes the fan-out take
  longer; it does not make it fail.

A cap was considered and rejected on the precedent that already exists: pinning
shipped `MAX_PINNED_WORKSTREAMS`, moved it onto a visibility-filtered count, and
then removed it outright, because a cap counted against stored rows is wrong
whenever the run has a hole and a cap counted against visible rows can be wedged
shut by rows nobody can free. A group, being shared, would hit both faster.

**Live.** A newly inserted link publishes `resource_attached` on that work
stream's socket — the same event the existing attach path emits from
`substream-agent.ts` — so a work stream open on somebody's screen shows the
resource arrive without refetching. Changes to the
group itself — created, renamed, restyled, deleted, membership, defaults —
publish a new `groups` topic on the workspace socket, so every window's sidebar
converges without polling.

**When the fan-out is slow or fails.** The fan-out is asynchronous, so a group
with many work streams finishes attaching over seconds rather than instantly; the
group's own list updates immediately, and each work stream lights up as its
attach lands. A work stream whose attach fails is retried by the queue and, if it
keeps failing, ends in the dead-letter queue. **There is nothing in this change
that repairs it afterwards** — a non-empty dead-letter queue is the signal, per
[the rule sheet](../../../AGENTS.md#where-we-are), and non-goal 9 says why a
reconciliation sweep is not in scope yet.

### Group terminology

Settings → Workspace → **Workspace preferences** gains one row, beside **Default
timezone** and **Log agent inference**: a `DropdownSelect` labelled **Group
terminology**, with the sub-copy *What would you like to call your groups?* and
two options, **Group** and **Project**. It is workspace-wide and admin-gated,
exactly like the two rows above it, and it rides on the existing `PATCH
/workspace` and the `workspace_profile` sync topic, so the other windows follow.

Choosing **Project** re-renders every surface at once: the sidebar heading
becomes **Projects**, the plus button becomes *New project*, the context-menu item
becomes **Add to project**, the modal becomes **New project**, the removal item
becomes **Remove from Blogs** (unchanged — it names the group), the marker's
accessible name becomes *In project Blogs…*, and the settings row itself becomes
**Project terminology / What would you like to call your projects?**. The setting
label follows the same rule as everything else deliberately; see key design
decision 5.

The group's own *name* is never touched by this. Only the common noun moves.

## Impact on the product contract

**One clause needs checking, and it holds.** The [implementation
brief](../2026-08-05_avalon-implementation-brief/prd.md) opens by saying Avalon is
"organized around concrete work streams rather than channels, direct messages,
search, or a global inbox". A grouping construct in the sidebar is close enough to
a channel that the burden is on this PRD to say why it is not one.

A channel is a place messages go. A group is not:

- It holds no messages, has no transcript, and has no composer. Non-goal 4.
- Nobody is subscribed to it, so nothing is delivered because of it, and it has
  no unread state of its own.
- No agent run belongs to it. Avalon is not a participant in a group, because a
  group has no conversation to be a participant in.
- It creates nothing. A work stream is still created from the composer or an
  automation; a group can only contain one that already exists.
- It grants nothing. Membership does not change who may read a work stream, and
  a group's own readability is "everyone in the workspace", which is what
  workspace scope already means.

What a group *is*, in contract terms, is a second index over the same work
streams — the first being recency and the second being a name a team agreed on.
The clause forbids somewhere else to put the work; this puts a label on the work
where it already is.

Two other clauses are worth naming as unmoved. "Viewing does not create
participation" is untouched: opening a group's home page and reading the list of
work streams in it is viewing, and creates no participation in any of them.
"Every automation run owns exactly one work stream" is untouched: an automation's
work stream can be put in a group like any other, and the group owns nothing.

The one place the contract genuinely gains a sentence is the resource path — a
resource can now be attached to a work stream by a rule about a group rather than
by a person or a connector. That is an addition to how attachment happens, not to
what an attachment means: the resulting row is the same row, the agent reads it
through the same `workstream_list_resources`, and the audit still names the
person who added it to the group.

## Decision log

None yet.

## Key design decisions

1. **A group is authoritative in WorkspaceDO, alongside pins, rather than in
   D1.** WorkspaceDO already owns the authoritative work-stream directory and the
   authoritative per-person `workspace_workstream_pins`, and it already publishes
   the socket the sidebar converges on. Groups are the same shape of state — a
   workspace-scoped opinion about which rows go where — and putting them in the
   same object means membership and the directory rows it references are read in
   one query and written in one transaction, with a foreign key that cascades if a
   directory row is ever removed. That cascade is insurance, not a live path:
   nothing deletes from `workspace_workstream_directory` today — a work stream
   goes quiet by `archived_at` — so the FK matches what
   `workspace_workstream_pins` and its siblings already declare rather than
   describing something that fires. *Rejected:* a D1 table in the regional control
   plane. It would put group membership and the directory it annotates in two
   authorities that converge asynchronously, which is exactly the split
   [`0079_workstream_do_authority_cutover.sql`](../../../packages/db/migrations/0079_workstream_do_authority_cutover.sql)
   spent a cutover removing. **This change adds no D1 migration.**

2. **Membership is additive, and the marker is what makes that legible.** The
   alternative — a grouped work stream leaves the recency list, the way a pinned
   one does — was rejected. Pinning can take a row out of the recency list
   because a pin is one person's and a pinned row is a row that person is
   actively watching; a group is everyone's, and a group that quietly emptied
   *Today* for every member of the workspace would make the sidebar's primary
   index depend on somebody else's filing. Keeping the row where it was costs one
   marker per group and buys a sidebar whose recency list still means what it
   says.

3. **Colour is an index into a themed palette, not a value.**
   `GroupColor` is an integer 1–10 resolving to `sys.color.group.1`–`.10`, one
   set of values per theme, exactly as `sys.color.person.1`–`.6` already works
   for per-participant accents. *Rejected:* storing a hex value the picker
   produces. [`theming.md`](../../theming.md) requires that every colour is
   written down once, in a theme file, and that "every theme restates every token
   whose value is a colour" — a hex chosen against the dark surface would be a
   colour the theme system has never seen, illegible the moment somebody switches
   to Air, and unfixable without rewriting stored data. The same reasoning makes
   the icon a stable key (`"rocket"`) mapped to a component in the renderer
   rather than a stored `lucide-react` export name: an upstream rename must not
   invalidate a stored row.

4. **The fan-out is a Queue; joining a group is RPC.** The two directions of the
   same operation get different mechanisms, and
   [`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md) is what decides
   it. *One resource into many work streams* is a fan-out onto N separate
   single-threaded Durable Objects where nothing reads the result: the default
   applies, and the queue's retries and dead-letter queue are the only monitoring
   this change needs. *One work stream into one group, taking its K default
   resources* is bounded, is one object, and has somebody waiting on it who needs
   read-your-writes to render the row — that is on the must-use-RPC list.
   *Rejected:* draining the fan-out with direct RPC from WorkspaceDO's alarm. It
   rebuilds retry inside the caller, which the document explicitly forbids, and
   it makes one person's edit to a group wait behind the slowest work stream in
   it.

5. **The terminology setting renames itself too.** With **Project** chosen, the
   settings row reads *Project terminology*. This departs from the literal
   wording the feature was requested in, and it is deliberate: the invariant
   worth having is *no user-visible string says "group" or "project" outside the
   terminology helper*, because that one is testable and stays true, whereas
   "…except in Settings" is an exception somebody re-adds by accident within a
   month. The row reads correctly either way.

6. **Names are unique per workspace, case-insensitively.** The marker on a row is
   an icon, sometimes only a tooltip's worth of text, and two groups called
   *Blogs* make it ambiguous at exactly the moment it is doing its job.
   *Rejected:* allowing duplicates and disambiguating in the tooltip.

7. **Rename, restyle, and delete are in scope**, though the feature was requested
   as create-only. A group's name and mark are the whole of its identity and are
   chosen in a modal in about four seconds; without an edit path a typo is
   permanent and the only fix is a second group, which splits the work streams.
   Delete is bounded by design — it detaches nothing and deletes no work stream —
   so the destructive case is a confirmation dialog, not a subsystem.

## Data model

Groups themselves are WorkspaceDO-local SQL, added by a WorkspaceDO migration.
**One D1 migration is needed, and it is not for groups** — see [the terminology
column](#the-one-d1-migration) below. Sketch level; the migrations are
authoritative, and [`data-model.md`](../../data-model.md) is updated in the same
change as the code.

```sql
CREATE TABLE workspace_groups (
  group_id           TEXT PRIMARY KEY,
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  icon               TEXT NOT NULL CHECK (length(icon) BETWEEN 1 AND 40),
  color              INTEGER NOT NULL CHECK (color BETWEEN 1 AND 10),
  scope              TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  created_by_user_id TEXT NOT NULL,
  created_at         INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at         INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;
-- Scoped now, not later. Private groups (appendix 1) need a per-owner rule —
-- two people each having a private "Blogs" is not a constraint anybody would
-- choose — so a workspace-wide unique name would have to be dropped and rebuilt.
-- Carrying the predicate from the start is what makes the unused `scope` column
-- actually buy what the paragraph below claims it buys.
CREATE UNIQUE INDEX workspace_groups_name_idx
  ON workspace_groups(name COLLATE NOCASE) WHERE scope = 'workspace';

CREATE TABLE workspace_group_members (
  group_id         TEXT NOT NULL REFERENCES workspace_groups(group_id) ON DELETE CASCADE,
  workstream_id    TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
  added_by_user_id TEXT NOT NULL,
  added_at         INTEGER NOT NULL CHECK (added_at >= 0),
  PRIMARY KEY (group_id, workstream_id)
) STRICT;
-- The sidebar's marker read: every group one work stream is in.
CREATE INDEX workspace_group_members_workstream_idx
  ON workspace_group_members(workstream_id, group_id);

CREATE TABLE workspace_group_participants (
  group_id TEXT NOT NULL REFERENCES workspace_groups(group_id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  added_at INTEGER NOT NULL CHECK (added_at >= 0),
  PRIMARY KEY (group_id, user_id)
) STRICT;

CREATE TABLE workspace_group_default_resources (
  group_id         TEXT NOT NULL REFERENCES workspace_groups(group_id) ON DELETE CASCADE,
  resource_id      TEXT NOT NULL,
  added_by_user_id TEXT NOT NULL,
  added_at         INTEGER NOT NULL CHECK (added_at >= 0),
  PRIMARY KEY (group_id, resource_id)
) STRICT;

-- Transactional outbox for the fan-out, drained onto the regional queue by the
-- object's alarm. Same shape as the regional-effect outbox the work-stream
-- objects already use, and for the same reason: `queue.send()` does not
-- participate in the local transaction, so the intent has to be committed with
-- the row that caused it. Deliberately self-contained — every field the attach
-- needs is on the row, so draining it joins to nothing.
CREATE TABLE workspace_group_resource_fanout (
  group_id            TEXT NOT NULL,
  resource_id         TEXT NOT NULL,
  workstream_id       TEXT NOT NULL,
  -- Copied in, not joined to. The group or the default may be deleted between
  -- this commit and the alarm that drains it, and a deleted row cannot name the
  -- person whose action caused the attachment.
  attached_by_user_id TEXT NOT NULL,
  enqueued_at         INTEGER NOT NULL CHECK (enqueued_at >= 0),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (group_id, resource_id, workstream_id)
) STRICT;
```

**`NOCASE` folds ASCII only.** *Café* and *CAFÉ* are therefore two different
groups under a rule [key design decision 6](#key-design-decisions) states without
qualification. That is accepted rather than solved — a normalized Unicode
case-folded key is a stored column and a fold to keep current with, for a
collision between two names that differ only in the case of an accented letter —
but it is written down here, because the decision is argued from the marker being
unambiguous and this is the case where it is not. The list read sorts with the
same `COLLATE NOCASE`, so ordering and uniqueness agree about names differing
only in case; a read that sorted binary while the index folded would disagree
with itself.

`scope` is written `'workspace'` by every path and read by none, per non-goal 1.
It is present rather than deferred because adding a column later means a
migration *and* a read path that has to tolerate its absence, whereas an unused
constrained column costs nothing and makes private groups an API change. It is
the cheaper thing to reverse either way.

`workspace_group_resource_fanout` rows are written in the same transaction as the
`workspace_group_default_resources` row that caused them, carry
`attached_by_user_id` forward into the queue payload, and are deleted only once
the attach is acknowledged. Nothing in the drain path reads the defaults table:
by design, removing a default does not cancel an attach already in flight, so the
row it came from may be gone by the time the message is handled.

`workspace_group_participants` is seeded with the creator and is otherwise inert,
per non-goal 2. Nothing reads it to make an authorization decision, and the code
must not start: "everyone in the workspace" is the whole of a group's
readability today, and a check that consults an inert table is a check that
silently becomes wrong when the table stops being inert.

Contracts (`packages/contracts/src/index.ts`):

| Addition | Shape |
| --- | --- |
| `GroupIconSchema` | `z.enum` of the twenty stable icon keys. |
| `GroupColorSchema` | `z.number().int().min(1).max(10)`. |
| `GroupTerminologySchema` | `z.enum(["group", "project"])`. |
| `GroupSchema` | `id`, `name`, `icon`, `color`, `scope`, `workstreamCount`, `createdByUserId`, `createdAt`, `updatedAt`. |
| `WorkstreamSchema.groupIds` | `z.array(IdSchema)` — the marker's source, carried on directory rows the way `pinPosition` already is. |
| `CreateGroupRequestSchema`, `UpdateGroupRequestSchema` | Name, icon, colour; update requires at least one field, like `UpdateWorkspaceRequestSchema`. |
| `WorkspaceSchema.groupTerminology`, `UpdateWorkspaceRequestSchema.groupTerminology` | Defaults to `"group"`. |
| `WORKSPACE_SYNC_TOPICS` | Gains `"groups"`, invalidating `['groups']` and the work-stream directory key. |

A `GroupId` brand is added per [`branded-ids.md`](../../branded-ids.md), and flows
from the route parameter through the service to the object without a cast.

### The one D1 migration

`groupTerminology` is a workspace preference sitting in the same settings card as
**Default timezone** and **Log agent inference**, and those are D1 columns on the
`workspaces` row: `WorkspaceService.getWorkspace` selects
`w.timezone, w.log_agent_inference` and `updateWorkspace` writes exactly those two
behind `COALESCE`. There is no path by which a WorkspaceDO-local table makes a
field of the D1-backed workspace profile durable, so putting the setting on
`PATCH /workspace` — which is where it belongs — requires one migration:

```sql
-- packages/db/migrations/NNNN_workspace_group_terminology.sql
ALTER TABLE workspaces
  ADD COLUMN group_terminology TEXT NOT NULL DEFAULT 'group'
  CHECK (group_terminology IN ('group', 'project'));
```

One nullable-free column with a default, applied identically in both regions, and
the select, map, and update paths in `workspace-service.ts` extended alongside it.
The alternative — a WorkspaceDO-owned terminology API — was rejected: it would put
one row of a settings card on a different authority from the two above it, for a
value read on every render of the sidebar.

Routes (`apps/api/src/routes/groups.ts`, new):

```
GET    /groups                                   list, with per-viewer counts
POST   /groups                                   create
GET    /groups/:id                               the home page's group, members, defaults
PATCH  /groups/:id                               name, icon, colour
DELETE /groups/:id                               delete the group and nothing else
PUT    /groups/:id/workstreams/:workstreamId     add — returns the work stream's groupIds
DELETE /groups/:id/workstreams/:workstreamId     remove
POST   /groups/:id/resources                     add a default, and fan it out
DELETE /groups/:id/resources/:resourceId         remove a default, detaching nothing
```

Every one of them is gated on the caller being a member of the workspace, and the
two work-stream routes additionally on the caller being able to read that work
stream's directory row — the same readability check `pin` already makes.

## Regional impact

A group is workspace content and never leaves its workspace's region. The tables
live in that workspace's WorkspaceDO, the resources they reference are already
regional, and no group data crosses the Global/EU boundary or reaches the Global
registry. Identity, membership, and region resolution are untouched.

The one regional artefact is the fan-out queue, which is **split per region**,
like `ACTIVITY_QUEUE` and for the same reason: its payload names a workspace's
work streams and resources, and it must be consumed by that region's own Worker.
Each region gets its producer binding, its consumer, and its dead-letter queue,
registered in both `wrangler.global.jsonc` and `wrangler.eu.jsonc`, and in
[`runbook.md`](../../runbook.md).

## Security and trust model

**Only a resource that is already visible to the whole workspace can be a group
default, and the check happens when it is added.** The fan-out runs later, from a
queue consumer, with no user behind it, so it cannot make that judgement — and it
must never be handed a resource whose readability depends on who is asking. What
makes this load-bearing rather than defensive is stated in
`apps/api/src/lib/activity-visibility.ts`: a resource row "is listed to every
member of the work stream it hangs off and is broadcast over `resource_attached`
— `WORKSTREAM_RESOURCES_SQL` applies no connection-scope filter". Attaching is
therefore disclosure to everyone in that work stream, and to its agent.

**Connector scope is not the whole of resource visibility, so the gate cannot be
modelled on the check `attachResource` already makes.** That check is
`connection_scope === 'personal' && owner_user_id !== auth.userId`, which speaks
only for connector-backed rows. Two resource classes have a null
`connection_id` and get their readability from somewhere else entirely:

- **Notes.** A note is a `resources` row with a `notes` row pointing at it, and
  `notes.scope` — `'personal' | 'workspace'`, defaulting to `'personal'` — is
  what decides who may read it. `attachResource` selects `note.scope AS
  note_scope` in its lookup query and then **never reads it**; the identifier
  appears exactly once in `workstream-object-product.ts`. So the existing check
  does not reject a personal note today, and a group-default gate copied from it
  would admit one and fan it out to every work stream in the group.
- **Inbound email.** `resend-inbound-email-service.ts` creates an `email`/`resend`
  resource with a null connection and attaches it with
  `relationship_type = 'inbound_email'`. Its visibility *is* the attachment — the
  work stream it landed in — so there is nothing about the row itself that makes
  it workspace-readable.

`POST /groups/:id/resources` therefore gates on one named predicate,
`resourceIsWorkspaceDefaultEligible`, which is **default-deny** and is the single
implementation used both by the picker (to decide what it may offer) and by the
route (to decide what it accepts):

| Resource class | Admitted when |
| --- | --- |
| Connector-backed (`connection_id` non-null) | The connection's scope is `workspace`. |
| Note (`notes.resource_id` matches) | `notes.scope = 'workspace'` and the note is not archived. |
| Inbound email (`provider = 'resend'`, `resource_type = 'email'`) | Never — its visibility derives from an existing attachment. |
| Upload (`connection_id IS NULL`, no note row) | Admitted. It has no scope of its own because it never had an owner other than the workspace — it was uploaded into it. |
| Anything else | Never. A resource class the predicate has not been taught is refused until somebody decides what it means. |

Default-deny is the point: a new resource class added later is refused rather
than silently inheriting group-wide disclosure, and the refusal is the thing that
prompts the decision. Note that "workspace-scoped" is shorthand throughout this
document and **not a column** — `resources` has no `scope` — which is exactly why
the predicate has to enumerate classes rather than read a field. The predicate is
new code, not a reuse of the existing check, and the tests it needs are named in
acceptance criterion 9.

**Scope is mutable, and the gate is not the last word.** A note admitted as a
group default can be changed from `workspace` to `personal` afterwards. The
product already treats that transition as significant: `0045_notes.sql` carries an
outbox and a trigger for it, drained by `note-privacy-notification-service.ts`.
Left alone, an add-time-only gate would keep fanning that note out to every work
stream that joins the group later, with no user behind the attach — the precise
situation the gate exists to prevent. So:

- **The predicate re-runs at fan-out time**, in the consumer, against current
  state. It reads scope from stored columns, needs no `AuthContext` to do it, and
  a resource that has stopped qualifying is dropped rather than attached.
- **A note going private drops itself from every group's defaults**, written by
  the same note-privacy drain that already notices the transition. The group's
  **Default resources** list stops showing it, so the change is visible where it
  was made rather than silent.
- **Nothing already attached is retracted.** That follows non-goal 7 and is the
  same answer the product gives today: the note-privacy path notifies, it does not
  claw back. What changes is only what happens next.

Add-time and fan-out-time both, therefore — the door check is for the person, so
they get an immediate refusal with a reason; the fan-out check is for correctness,
because time passes between the two.

**Group membership grants nothing.** It does not make a work stream readable to
somebody who could not read it, and it does not make a group's contents visible
beyond what each viewer could already see. A member's view of a group is filtered
by the same directory readability the sidebar already applies; a personal work
stream in a shared group appears to its own viewers and to nobody else, and the
count in the header is filtered too, so it does not leak the existence of rows.

**Adding a work stream to a group is a decision about that work stream.** The
group's defaults are attached to it, which means workspace-scoped resources
appear in it and become visible to the agent through
`workstream_list_resources`. For a personal work stream, only its own viewers
can see the row to add it, so this is its owner's own action. It is still worth
stating plainly: putting a work stream in a group is how content gets pushed into
it.

**Deletion is bounded, and attachment provenance survives it — but there is no
mutation history.** Deleting a group deletes group rows only. What is retained is
*attachment provenance*: `created_by_user_id` on the group and
`added_by_user_id` on a membership or default row, so a resource that arrived in
a work stream by a group rule still names the person whose action caused it.

What is **not** retained is a record of the mutations themselves. A rename or a
restyle overwrites without recording who did it, and removing a member, removing a
default, or deleting a group destroys the only row carrying that actor. So "who
renamed this group" and "who took that work stream out" are questions this design
cannot answer, deliberately: an append-only audit table is a subsystem, nobody has
asked for one, and inventing one here would be building for a requirement that
does not exist yet. It is named in [the appendix](#8-a-mutation-audit-log) so the
gap is a decision rather than an oversight. Do not read `added_by_user_id` as an
audit log; it is provenance for the row it sits on and disappears with it.

That distinction is why the fan-out outbox carries
`attached_by_user_id` of its own rather than joining back to
`workspace_group_default_resources`: the group, or just that default, may be
deleted after the transaction commits and before the alarm drains, and a join to
a row that no longer exists cannot name anybody.

## Agent behavior

**No new tool, no new plugin, and no change to the harness.** The only thing the
agent sees differently is that a work stream's resource inventory may contain
resources it did not watch anybody attach, carrying
`relationship_type = 'group_default'` where it would otherwise read `attachment`
or `origin`. `workstream_list_resources` lists them like any other resource, and
the hydration, bounds, and authorization rules in
[`agent-attachments.md`](../../agent-attachments.md) are unchanged.

Two consequences follow and should be expected rather than discovered. A group's
defaults count against the resource inventory the compaction appendix
enumerates, so a group with twenty defaults makes every work stream in it carry
twenty entries. And a resource attached mid-run advances the work stream's
`resource_inventory_revision`, invalidating cached invocations exactly as a
hand-attached resource does today — the fan-out is not a special case there and
must not become one.

## Rollout

**No feature flag.** The change is inert until somebody makes a group: with none,
the sidebar gains a heading and a plus button, the context menu gains one item,
and Settings gains a row whose default value — `group` — is the word every
surface already says. Nothing about an existing work stream, resource, or run
changes. Flagship's flags are model-routing decisions per
[`feature-flags.md`](../../feature-flags.md), and adding the product's first
UI flag to gate an additive section costs more than removing the section would.

**Two orderings matter.** The D1 column lands before the Worker that selects it:
`NNNN_workspace_group_terminology.sql` adds `group_terminology NOT NULL DEFAULT
'group'`, so an older Worker ignores a column it does not name and a newer one
reads a value every row already has. There is no backfill and no window in which
the setting is absent.

The second is the queue: Wrangler binds a producer to a queue
but does not create it, so the regional queues exist before the Worker that
produces to them is deployed. `scripts/check-cloudflare-queues.mjs` is the
preflight that proves it — the new queues are declared in both Wrangler files and
the check runs before any deployment, per [`runbook.md`](../../runbook.md).

Reversal is deleting the section and the routes; the WorkspaceDO tables can be
left in place, holding rows nothing reads.

## Acceptance

Walked in a real Electron window under Xvfb, with screenshots read, per [the rule
sheet](../../../AGENTS.md#verifying-visible-changes) — a passing component test
does not establish that any of this is visible or legible.

1. The **Groups** heading and its plus button render in an empty workspace,
   between **Pinned** and the recency list, with no rows and no empty-state line
   beneath.
2. Creating a group with each of the twenty icons and each of the ten colours
   produces a legible mark in every theme, light and dark. A duplicate name is
   refused with that reason, and the modal keeps what was typed.
3. A work stream added by right-click appears in the group **and** stays in its
   recency bucket, and stays in **Pinned** if it was pinned. A row in three
   groups shows three markers; a row in five shows three and `+2`.
4. Dragging a row from *Yesterday* onto a collapsed group expands it after a
   dwell and drops into it. Escape mid-drag changes nothing. A drag released
   outside any target changes nothing.
5. Clicking a marker on a row scrolls to its group and expands it if collapsed,
   without navigating to the work stream, and works from the keyboard. A marker
   for a group already on screen does not move the viewport.
6. An empty group reads *Add a work stream to Blogs*; the group's home page shows
   its name, its work streams in last-activity order, and opens one on click.
7. Adding a default resource to a group of several work streams attaches it to
   all of them; one of them, open in a second window, shows it arrive without a
   refetch. A work stream added afterwards receives the whole default set.
8. Removing a default resource from the group removes it from the group and from
   no work stream. Removing a work stream from the group, and deleting the group,
   likewise detach nothing.
9. `resourceIsWorkspaceDefaultEligible` is proved default-deny, with one case per
   row of its table plus the ones that motivated it: a **personal note owned by
   the caller** is refused (the case the existing connector check misses), a
   workspace-scoped note is admitted, another member's personal connector
   resource is refused, a workspace connector resource is admitted, an inbound
   `resend`/`email` resource is refused, and a resource of an unrecognized class
   is refused. The picker offers exactly what the route accepts — one test drives
   both against the same fixtures, so they cannot diverge.
10. `attachGroupDefaultResource` is proved on real workerd against a work stream
    that already holds the resource: the relationship type and
    `attached_by_user_id` are unchanged, `resource_inventory_revision` does not
    move, and no `resource_attached` is published. Against one that does not, all
    three happen exactly once — and a redelivered message produces no second
    event. Both the queue fan-out and the synchronous join path are shown to call
    it, with a live socket asserting the event.
11. A default added and then deleted — group and all — before the alarm drains
    still attaches, and the resulting link names the original actor. This is the
    case that a join back to `workspace_group_default_resources` cannot serve.
12. Switching **Group terminology** to **Project** changes the sidebar heading,
    the plus button, the context-menu item, the modal, the marker's accessible
    name, the group home page, and the settings row itself, with no reload. The
    setting survives a reload, proving the D1 column is written and read back.
13. The terminology invariant is enforced by a rule a test can apply
    mechanically: **no string in a JSX text position, `aria-label`, `title`, or
    `placeholder` matches `/\b(group|project)s?\b/i` outside the terminology
    helper.** A bare grep is not the check — the renderer legitimately contains
    `role="group"`, Radix's `*.Group` parts, and the recency identifiers this PRD
    asks be renamed — and a check that needs an allowlist to stay quiet proves
    nothing.
14. Archiving a work stream removes it from its groups' lists and from the group
    home page's count, exactly as it removes it from *Yesterday*; un-archiving
    puts it back with its membership intact. An expanded group of more work
    streams than one page pages them.
15. Membership and defaults survive a WorkspaceDO restart.
16. A fan-out whose target work stream is unreachable retries and lands in the
    dead-letter queue; the group keeps the default, and nothing else in the
    workspace is affected. A fan-out whose group, default row, or target work
    stream has vanished or been archived in the meantime drops the intent without
    throwing, and the drain keeps going for every other group in the workspace.
17. A note admitted as a group default and then made private stops being fanned
    out: it leaves the group's default list, later joiners do not receive it, and
    work streams that already hold it keep it. The fan-out-time re-check refuses
    it even if the list write is lost.
18. `pnpm lint` (zero warnings), `pnpm typecheck`, `pnpm test`,
    `pnpm test:scripts`, both Wrangler dry-run builds, and
    `pnpm --filter @avalon/api test:workers` are green. Anything that depends on
    Durable Object storage, alarms, or the socket is a `test-workers/` test on
    real workerd, per [`testing.md`](../../testing.md).

## Open questions

- **Should a group be reachable from ⌘1–9?** The shortcut run today is pinned
  work streams then recent ones. Groups are destinations now, and leaving them
  out means the fastest route to a group is a mouse. Including them changes the
  meaning of a number somebody has learned, which
  [`workstream-pinning.md`](../../workstream-pinning.md) treats as a cost worth
  avoiding. Not blocking; non-goal 11 holds until this is answered.
- **Does the group home page belong in the sidebar's active-row state?** When
  `/groups/:id` is open, no work-stream row is active and the group row is. That
  is straightforward, but the same is not obviously true of the header's
  breadcrumb when a work stream is opened *from* a group page. Not blocking.

## Appendix — future improvements

Everything here is deferred, not designed. It exists so a later reader knows
which omissions were deliberate; the numbered non-goals above are the binding
statement of scope, and this section only says what picking one back up would
involve.

### 1. Private groups

`workspace_groups.scope` already carries `'personal'` as a legal value and no
route writes it. Turning it on is a create-time choice, a read filter on the list
and on membership, and a decision about what a private group's marker looks like
on a row somebody else can see — most likely nothing at all, which means the
marker's "at most three" rule becomes per viewer.

### 2. Group participants that mean something

`workspace_group_participants` holds the creator and grants nothing. It becomes
real when private groups do: a private group's readability would be its
participant set, which needs add/remove routes, a picker, and a rule for what
happens to a private group whose last participant leaves the workspace.

### 3. A hand-arranged group list

Groups sort by name. A manual order is the pinned-list problem again — a dense
`position` run, a whole-list `PUT`, and a local order that wins during a drag —
and [`workstream-pinning.md`](../../workstream-pinning.md) already contains the
answer to every part of it. The open question is whether the order is per person
or shared, and unlike a pin, a group is shared, so a shared order means two
people can fight over it.

### 4. Standing group instructions

The most-asked-for version of "a group carries context" is not a resource list
but a sentence: *every work stream in this group is about the Acme migration, and
should assume X*. That is a prompt-authority question, not a filing question, and
[`writing-prompts.md`](../../writing-prompts.md) owns where such a thing may sit
relative to standing policy. It should not be added by analogy to default
resources.

### 5. A fan-out reconciliation pass

A work stream whose attach exhausted its retries stays without the resource, and
nothing notices except the dead-letter queue. The repair is a sweep that
recomputes each group's expected attachments against actual ones, which is cheap
to write and easy to get wrong in the direction of re-attaching something a
person deliberately detached — so it needs the "detach is remembered" idea below
first.

### 6. Detaching a group default from work streams that already have it

Non-goal 7 rejects this as specified, and the rejection is about the current
shape rather than the goal: a work stream's resource list is the record of what
its runs were given. A version that works would distinguish *this resource is no
longer a group default* from *this resource was removed from this work stream*,
and would need a tombstone so a later fan-out does not put it back.

### 7. Multi-group markers beyond three, and a group filter

Three markers and a `+N` is a guess at how many groups a work stream is
realistically in. If workspaces routinely exceed it, the answer is probably not a
fourth marker but a way to filter the sidebar to one group — which is a different
feature, and closer to search than anything Avalon has today.

### 8. A mutation audit log

Non-goal 12. Today a rename overwrites and a removal destroys the row carrying
its actor, so group mutations leave no history. The version that works is an
append-only WorkspaceDO table — actor, target, action, timestamp — written in the
same transaction as each mutation, and a retention answer to go with it. It is a
subsystem, and it should be built when somebody actually needs to ask one of
these questions rather than pre-emptively; `added_by_user_id` must not be quietly
pressed into the role in the meantime, because it disappears with its row.

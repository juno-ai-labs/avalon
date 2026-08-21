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
  the sidebar uses, ordered by last activity, newest first.
- **When empty**, one light italic line: *Add a work stream to Blogs* — the
  group's own name, so the instruction names the thing it is about.

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

The marker is a `button` inside the row's `NavLink`, so its handler stops the
event; the row's own click handler already bails on `event.defaultPrevented`. Its
accessible name is *In group Blogs. Show it in the sidebar.* and it is reachable
by keyboard, because it is the only route from a row to its group.

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
  existing `attachment`, `origin`, and `generated`.
- Attachment is idempotent per (work stream, resource). A resource a work stream
  already has keeps the relationship type it already had — `attachResource`'s
  insert is already `ON CONFLICT(resource_id) DO NOTHING`, and this relies on
  that rather than changing it.
- **Removing a default from the group detaches it from nothing.** Later work
  streams stop being given it; every work stream that has it keeps it. The
  confirmation says so in those words.
- **Removing a work stream from a group detaches nothing**, for the same reason.
- **Deleting a group detaches nothing.**
- Only **workspace-scoped** resources can be a group default — see [the security
  section](#security-and-trust-model).
- A group holds at most 20 default resources; a workspace holds at most 200
  groups.

**Live.** The attach publishes `resource_attached` on each affected work stream's
socket, which is what `attachResource` already does, so a work stream open on
somebody's screen shows the resource arrive without refetching. Changes to the
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
   one query and written in one transaction, with a foreign key that cascades
   when a work stream is deleted. *Rejected:* a D1 table in the regional control
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

All of it is WorkspaceDO-local SQL, added by a WorkspaceDO migration. **No D1
migration.** Sketch level; the migration is authoritative, and
[`data-model.md`](../../data-model.md) is updated in the same change as the code.

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
CREATE UNIQUE INDEX workspace_groups_name_idx ON workspace_groups(name COLLATE NOCASE);

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
-- the row that caused it.
CREATE TABLE workspace_group_resource_fanout (
  group_id      TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  enqueued_at   INTEGER NOT NULL CHECK (enqueued_at >= 0),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (group_id, resource_id, workstream_id)
) STRICT;
```

`scope` is written `'workspace'` by every path and read by none, per non-goal 1.
It is present rather than deferred because adding a column later means a
migration *and* a read path that has to tolerate its absence, whereas an unused
constrained column costs nothing and makes private groups an API change. It is
the cheaper thing to reverse either way.

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

**Only a workspace-scoped resource can be a group default, and the check happens
when it is added.** `attachResource` today refuses a resource whose connector
connection is personal and owned by somebody other than the caller. The fan-out
runs later, from a queue consumer, with no user behind it — so it cannot make
that judgement, and it must never be given a resource whose readability depends
on who is asking. `POST /groups/:id/resources` therefore rejects a
personal-scoped resource outright, with a message saying so, and the fan-out
attaches only what that gate admitted.

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

**Deletion is bounded and audited.** Deleting a group deletes group rows only.
Every mutation records the acting user (`created_by_user_id`, `added_by_user_id`),
so a resource that arrived in a work stream by a group rule still names the
person whose action caused it.

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

The order that does matter is the queue: Wrangler binds a producer to a queue
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
9. A personal-scoped resource is refused as a group default, with a message that
   says why.
10. Switching **Group terminology** to **Project** changes the sidebar heading,
    the plus button, the context-menu item, the modal, the marker's accessible
    name, the group home page, and the settings row itself, with no reload. A
    grep of the renderer finds no user-visible `"Group"` or `"Project"` literal
    outside the terminology helper, and a test asserts it.
11. Membership and defaults survive a WorkspaceDO restart, and a deleted work
    stream leaves no orphaned membership row.
12. A fan-out whose target work stream is unreachable retries and lands in the
    dead-letter queue; the group keeps the default, and nothing else in the
    workspace is affected.
13. `pnpm lint` (zero warnings), `pnpm typecheck`, `pnpm test`,
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

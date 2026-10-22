# Work-stream appearance

A Channel or Breakout has one icon and color shared by everyone who can read it. Clicking
its header icon opens a compact palette: fixed colors above a scrolling icon grid.
Each choice saves immediately and keeps the palette open. A conversation nobody
has chosen for usually gets its icon from the naming pass, out of this same
catalog; where that pass produced none it keeps the deterministic icon derived
from its id, which is also what every work stream created before this existed
still shows.

**For now a thread's and a Breakout's colour is its Channel's, and the server
writes it.** Since the navigation redesign a thread (stored as a work stream)
sits in one or more Channels (stored as Spaces). Each thread and every Breakout
under it stores the colour of the thread's canonical Channel
(`canonicalChannelSpaceId`: Organization-wide before private, then by id) in
its own `appearance_json`, like any other appearance, so every surface and
every server-built mark reads it without knowing the rule. The client's
appearance command drops `color` for a thread or a Breakout, and their pickers
offer icons only (`colors={false}`); the icon stays the conversation's own. A
Space's own appearance is unchanged.

The writes are WorkspaceDO's, through `channel-color-sync.ts`. SQLite triggers
mark a thread in `channel_color_sync` whenever its colour can move: one of its
placements is made, ended or archived; a Channel it sits in changes colour, is
archived or restored, or changes scope; the thread or a Breakout under it is
first projected or restored from the archive. Migration 99 marks every thread
that existed when it shipped. The alarm lane `channel_color_sync` sends due
threads to the activity Queue; the consumer asks `channelColorWork` for the
colour and the conversations (Main and each open Breakout), writes each one
with the identity operation `recolor`, and settles the row with
`completeChannelColorSync` only if nothing marked the thread again meanwhile.
The projection each `recolor` commits carries the colour to every client.

**A new thread is born in its colour.** The lane takes seconds (an alarm, a
Queue hop and a write per conversation), and until it ran a new thread was
drawn in its id-derived colour and then switched. So `reserveChannelInSpaces`
reads `channelColor` in the transaction that places the thread, writes it onto
the provisional directory row, and returns it; the creation service passes it
to Main's `initialize` (the Slack path to `provision`), which stores
`{ icon: null, color }`. The client lists the pending row in the colour of the
Channel it was started in. The lane still marks the thread and runs, and
writes nothing when the colour matches, so a Channel recoloured during the
create still converges.

Every mark takes the next value of one counter (`channel_color_sync_state`),
so a thread's `revision` never repeats, even after its row is settled and
deleted, and a late completion cannot take a newer mark. Each conversation
keeps the newest revision it applied (`channel_color_revision`, conversation
migration 74), and `recolor` refuses one at or below it. Two jobs for the same
thread can overlap (a newer mark is sent while an older job is still writing),
and without that fence the older job could put the old colour back on the
Breakouts it had not reached yet, with nothing left to correct it.

One batch (up to 100 threads, the Queue's `sendBatch` maximum) is in flight per
Organization at a time. A claimed row is `in_flight`; the lane sends nothing
while any in-flight row's retry gate is still ahead, and the alarm waits for
that gate rather than for the pending rows. Settling or releasing a thread
(`releaseChannelColorSync`, which the consumer calls on a failure) re-arms
the alarm, so the next batch follows the last one's completion. The
backfill is paced by how fast the object answers, not by a chosen interval:
sent back to back it would have repeated the resource-search backfill's
overload (`docs/text-search.md`, 2026-09-26).

**A Sidekick has one too, and it is the same palette.** Clicking the hexagon on
its profile opens the picker this document owns, over the same catalog and the
same colour ring. What differs is only where the value is stored and how it is
sent, which is the Sidekick's own business and lives in
[`automation-lifecycle.md`](automation-lifecycle.md#choosing-what-a-sidekick-looks-like);
this document owns the catalog, the descriptions, the colours, the picker's
behaviour and the deterministic default, for every surface that has an
appearance. The deterministic default lives in contracts as
`generatedWorkstreamAppearance`. Anything else that grows an appearance comes
here for those defaults, and brings its own storage and glyph treatment.

**So does a Space.** The icon tile on its dashboard is this picker's trigger,
drawn with `SpaceIcon`. A Space's route replaces the name, icon and colour
together rather than merging a patch, so the dashboard sends one choice at a
time and builds each request from the last choice rather than from the Space as
rendered; otherwise a colour clicked before the icon's answer arrived would send
the old icon back. The route itself is [`spaces.md`](spaces.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/appearance-icons.ts` | The one icon catalog for a Channel, a Breakout, a Space and a Sidekick: its eight sections, the pickable keys, the retired keys that stay storable, the id-derived default marks, and one short model-visible description per pickable key. |
| `packages/contracts/src/workstream-appearance.ts` | The catalog under the names callers import (`WORKSTREAM_ICON_KEYS` for the menu, `WORKSTREAM_ICON_KEYS_STORABLE` for the schema), the default key, color keys, and partial updates. |
| `apps/api/src/durable-objects/channel-color-sync.ts` | A thread's and its Breakouts' Channel colour: migration 99's table, triggers and backfill, the alarm lane's publish, and the two reads the Queue consumer settles through. `recolor` in `workstream-identity-storage.ts` is the write. |
| `packages/ui/src/components/appearance-icons.ts` | `APPEARANCE_ICON_COMPONENTS`, the Lucide glyph for every storable key. |
| `packages/ui/src/components/icon-catalog.tsx` | `IconCatalog`: section tabs over one scrolling grid with a heading per section. Both pickers render their cells through it. |
| `packages/ui/src/components/appearance-picker.tsx` | `AppearancePicker`: palette, optimistic preview, ordered clicks, and failures, for every surface that has an appearance. The caller supplies the trigger's mark through `renderGlyph` and its accessible name through `label`; nothing else about it differs between a work stream and a Sidekick. |
| `packages/ui/src/components/workstream-glyph.tsx` | `resolveWorkstreamAppearance`, the one resolver from a stored appearance to an icon component and a colour, and the three treatments over it: the filled `WorkstreamGlyph` for navigation, `WorkstreamMark` — the bare tinted symbol — for a surface already inside the work stream, such as the Breakout menu's Channel header, and `AutomationGlyph`, the rounded hexagon a Sidekick wears. |
| `apps/desktop/src/renderer/lib/workstreams-cache.ts` | `patchCachedWorkstreamAppearance`, the receipt-time write that puts a committed choice on the sidebar row ahead of the directory projection, and `patchCachedGeneratedIcon`, the naming pass's, which additionally declines a row that already has an icon. Neither touches the cached detail. Built on `patchCachedWorkstream`, the write for any unversioned fact both caches must agree on. |
| `apps/desktop/src/renderer/lib/use-workstreams-query.ts` | `useCachedWorkstreamAppearance`, the read side: one work stream's appearance off the sidebar row, for a surface that must move with that row rather than with the detail. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Orders the picker's choices on the addressed conversation socket and applies each one to the relevant Channel or Breakout cache row when its receipt arrives. |
| `apps/desktop/src/renderer/lib/channel-viewer-state.ts` | Reconciles a receipt-backed Breakout row with parent directory snapshots: a pre-command snapshot cannot undo the commit, while a genuinely different authoritative appearance wins. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Authoritative Channel-or-Breakout write, command receipt, and common-state publication. |
| `apps/api/src/durable-objects/hosted-parent.ts` | Projects each Breakout's stored appearance into the parent-owned Breakout directory. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Every conversation object's nullable `workstream.appearance_json`. |
| `apps/api/src/durable-objects/workspace-do.ts` | Directory projection for all workspace surfaces. |
| `apps/api/src/durable-objects/workstream-identity-storage.ts` | `rename`, the second writer: it offers the naming pass's icon and refuses it where one is stored. See [`workstream-naming.md`](workstream-naming.md). |
| `apps/api/src/durable-objects/sidekick-do.ts` | `setAppearance` and `automation.appearance_json` — the Sidekick's copy of this, owned by [`automation-lifecycle.md`](automation-lifecycle.md#choosing-what-a-sidekick-looks-like). |

## How it works

The header uses the retained Main conversation socket even when a private child
is selected. `set_workstream_appearance` carries a partial appearance and a unique
operation ID. Main commits the merged value, idempotency receipt, and common
outbox effect together. The Channel's parent in `WorkspaceDO` applies that
common state to the directory and publishes it to its control sockets. Existing versioned state handling
updates the header, sidebar, and cached detail. Reconnection obtains the same
appearance in the canonical snapshot.

That projection is the durable path, not the fast one. From the commit it
crosses Main's outbox alarm and a Queue hop to `WorkspaceDO`, which applies the
parent step and the directory step back to back, and only then a state push.
That is still slower than the receipt, which comes back in one socket round
trip. The picker previews its
own trigger locally, so the header moved at once and the sidebar row did not. The
client now closes that gap on the receipt: when Main acknowledges a choice, the
socket hook merges the patch over the current appearance on the sidebar row, the
way Main merges it over its own row. The write is unversioned and the versioned
receiver replaces `appearance` whole on the next newer common waterline, so the
authoritative push always wins; a delayed older push can at worst flicker the
row back until the one carrying the choice lands. The cached detail is not
written: the header renders it under the picker's own preview, which the picker
retires only once the detail carries the choice, so writing the detail on the
receipt would retire that preview early and expose the header to the same
flicker. Nothing is written on send: the row shows a committed value or the
previous one, never a choice the room may still refuse. Nor is anything written
for a receipt that
crossed a reconnect. The feed resends an unanswered command on the next
connection and Main answers an already committed operation from its receipt,
publishing nothing, so that receipt may describe a choice another client has
since replaced and whose newer state this client already holds; the reconnect's
snapshot carries the current value, so the patch is skipped rather than risked.


Control snapshots and broadcasts always include appearance. There is no query
capability or per-socket configuration. The common receive boundary ignores new
fields and unknown event types so protocol additions cannot hide child discovery.

The socket connection queues rapid clicks in order, retaining their original
work-stream address even if the picker unmounts. A click changes only its own field, so
a color change does not overwrite another user's icon.

The icon catalog is 253 Lucide icons in eight sections — Planning, Docs &
writing, Learning, Data & money and Build & tech at 23 each, and People & talk,
Places & nature and Life & fun at 46 — and a Space picks from the same one. The
picker shows a tab per section along its top, as Slack's emoji picker does; a
tab scrolls the grid to its section and the tab follows the scroll back. Icons
work like colours: the picker offers `WORKSTREAM_ICON_KEYS`, while the schema
parses `WORKSTREAM_ICON_KEYS_STORABLE`, which adds every key an earlier catalog
offered (`RETIRED_APPEARANCE_ICON_KEYS`), so a retired icon keeps parsing and
drawing and simply shows nothing selected in the picker. A model's answer is
held to the pickable list. The id-derived default still indexes the original
twelve marks, in their original order, through `GENERATED_APPEARANCE_ICON_KEYS`.

Each pickable key carries a short description of its drawing: the naming pass
chooses an icon from this catalog and needs to know what each key draws. They are model-visible strings, so keep them in plain words — no icon
library names — and add one with every key added, which the exhaustive `Record`
enforces at compile time. **Describe the drawing only.** Name what the icon
depicts and then how it is drawn — "two coins, one face on and one behind it at
an angle" — and stop. A description must not say what an icon is *for*: matching
a mark to a work stream belongs to the naming pass's model, which has the
request, and a test fails a description that carries usage language. See
[`workstream-naming.md`](workstream-naming.md). The Sidekick setup chat reads the
same lines, rendered once by `WORKSTREAM_ICON_CATALOG` in
`packages/agent-harness/src/prompts/icon-catalog.ts` under the same section
headings the picker shows, so a Channel, a Breakout and a Sidekick all choose
from one list with one set of descriptions.
Colors store semantic keys such as `blue` and `purple`, never hex or RGB values.
A glyph and its swatch resolve the key to its pastel pair, `project-tint` under
`project-ink`, through the current appearance (`markColors()`;
[`theming.md`](theming.md) owns the pair), and a bare mark is drawn in the ink.
`sys.color.project.<key>` is the hue itself, which people's colours and the
keys without a pair still use. The keys that resolve to the same colour in both appearances live
in `config/design-tokens/base.json`; a key that has to differ is set in both
`themes/light.json` and `dark.json`, never one. Run `pnpm tokens:build` after
either. The shared palette also affects projects and personal accents.

The picker offers `PROJECT_COLOR_KEYS` — the fourteen-hue ring — while the
schema parses `PROJECT_COLOR_KEYS_STORABLE`, which is every colour the palette
defines: the ring, the four retired keys, and `black`.

The two lists are deliberately different sizes, and the wider one is what
validates. `WorkstreamAppearanceSchema.parse` runs on every work-stream read, so
narrowing the stored vocabulary to match the menu is not a product change but a
read-path outage for whoever holds the colour being removed. Taking a colour off
the menu is a one-line edit; taking it out of the vocabulary needs a migration
and is almost never what is wanted.

`black` is the worked example. It is reserved for account accents and never
offered here, because an absence of colour is the wrong signal for an object
that sits in a list beside thirteen others it must be told apart from. A work
stream that already holds it keeps rendering and simply shows nothing selected
until someone picks a hue.

## Invariants

- Each conversation owns one authoritative appearance. Main's is the Channel
  identity; a private child's is its Breakout identity and never overwrites Main.
- **A person's choice outranks a generated one, and the rule is a condition on
  the write.** The picker's command writes unconditionally; the naming pass's
  write is refused wherever an icon is already stored. Neither writer can tell a
  generated icon from a chosen one after the fact, so the ordering has to be
  decided at the moment of writing.
- Command receipts are committed with the write. Replaying an older operation
  cannot overwrite a later choice.
- Omitted fields mean unchanged; null fields use the deterministic ID-based
  default. Older work streams retain their original appearance until edited.
- A colour job carries its mark's revision to every conversation it writes,
  and a conversation never applies a revision at or below the one it holds.
- After birth, a thread's or a Breakout's colour has one writer, `recolor`.
  The birth write is `channelColor`, the same read the lane makes, and never
  overwrites a stored appearance. A new path that sets one some other way is
  overwritten the next time the thread is marked;
  a new table whose change can move a thread's colour needs its own trigger in
  `channel-color-sync.ts`.
- Every common projection carries the appearance. Dropping it makes identity
  differ between the header, sidebar, and reopening a work stream.

## Boundary

This controls chosen identity — a work stream's, and a Sidekick's. Project
appearance keeps its existing behavior. The account's personal accent and device light/dark
preference remain owned by [desktop appearance](theming.md). This document owns
the catalog, the descriptions, the picker, the colour, the deterministic default
and the projection; *which* icon Rally picks for an unnamed work stream, and when
that pick may be written, belongs to
[`workstream-naming.md`](workstream-naming.md).

## Failure modes and limits

The existing socket transport queues commands while reconnecting and resends
with their operation IDs. A failed command restores server state and leaves an
inline error in the open picker. Invalid keys are rejected by the wire schema.
The scroll viewport is a layout choice, not a cap on the catalog or server data.

## Testing

The picker component suite covers the section tabs, a choice from a later
section, a retired stored icon that draws but is not offered, immediate selection, ordered rapid clicks,
staying open, Escape focus restoration, and failed saves — through the work
stream's own arrangement of it, because the behaviour is the picker's and the
work stream is one real caller rather than a component built for the test. The socket hook suite
proves the caches hold the old appearance until the receipt and the merged value
after it, and that a naming pass's icon reaches the row and not the detail;
the cache suite covers the merge over a stored and a generated appearance. The
refusal that protects a person's choice from a naming pass is proved in
`apps/api/test/workstream-naming.test.ts`. The real-workerd
`message-to-output-pipeline.test.ts` appearance case covers partial updates,
idempotent replay, and persistence across object eviction. Its dropped-write
mutation must fail the reopened snapshot assertion. Client control/state tests
cover the common cache path. The Sidekick's half is proved in the real-workerd
`automation-directory.test.ts`, which drives `setAppearance` and the effect
legs and asserts the merge, the refusal, and the value on both directory
listings. The Channel colour is proved on real workerd in
`channel-color-sync.test.ts` (which writes mark a thread and which do not, the
revision fence, the rows settled with nothing to write, and the Queue consumer
recolouring a real Main, and a later batch held until the one in flight
settles or is released, and a Channel recolour reaching Main and a Breakout
through the consumer, each keeping its icon) and `identity-authority.test.ts` (`recolor` keeps the
icon, commits the projection, writes nothing on a repeat, and refuses an older
revision); the
`message-to-output-pipeline.test.ts` appearance case proves a client's colour
is dropped. `workspace-channel-color-migration.test.ts` proves the backfill.
`space-creation.test.ts` proves a thread is born in its Channel's colour on
Main and on its directory row before the lane runs; `identity-authority.test.ts`
proves `provision` stores it and keeps an appearance already stored; and the
cache suite proves the pending row carries it through the naming pass's icon.
Inspect the actual Electron popup in light and dark,
including scrolling, and check another connected window and reopening.

### 2026-10-13 — A new thread is born in its Channel's colour

**What changed:** Creation writes the thread's Channel colour at birth: on
the provisional directory row, on Main through `initialize` (or `provision`
for Slack), and on the client's pending row. The sync lane is unchanged.

**Why:** A new thread showed its id-derived colour for the seconds the lane
took, then switched, and its glyph changed colour under the reader.

**Considered and rejected:** Only drawing a thread with no stored colour in
the Channel's colour on the client. It needs the Channel at every surface
that draws a thread, and leaves server-built marks wrong. A Breakout is not
born in its colour here; it still waits on the lane, and was left out of
this change's scope.

**Consequences:** `recolor` is no longer the only writer of a colour, only
the only one after birth. The birth write must stay the `channelColor` read,
or a thread is born in a colour the lane then changes.

Shipped in [#1233](https://github.com/juno-ai-labs/avalon/pull/1233).

### 2026-10-13 — A breakout row in the Threads list follows its thread's live colour

**What changed:** In the Threads list, a breakout row's own tile takes its
colour from its thread's live row, keeping its own icon
(`withLiveThread` in `navigation-sidebar.tsx`).

**Why:** Checking a Channel recolour end to end showed every stored colour
right, and every thread row updated live, but a breakout row kept the old
colour until the list was read again. That list is one fetch, and the socket
carries thread rows only, so nothing live held the breakout's colour. The
server writes a breakout's colour and its thread's from the same Channel in
one job, so the live thread row already has the right answer.

**Considered and rejected:** Re-reading the list when a thread's colour
moves. The consumer recolours Main and then each Breakout, and each reaches
the directory through its own Queue hop, so a re-read can land between them
and keep the old colour.

**Consequences:** This leans on a breakout's colour equalling its thread's. If
conversations choose their own colours again (see the entry below), drop it.

Shipped in [#1202](https://github.com/juno-ai-labs/avalon/pull/1202).

### 2026-10-12 — Threads and Breakouts store their Channel's colour

**What changed:** A thread and its Breakouts carry their Channel's colour in
their own stored appearance, written by the server (`channel-color-sync.ts`,
WorkspaceDO migration 99, conversation migration 74, identity operation
`recolor`). Migration 99 backfills
every existing thread, overwriting the colours people had chosen. The client's
colour patch is dropped for a thread or a Breakout and their pickers offer
icons only.

**Why:** Product call, stated as "for now": after Spaces became Channels and
Channels became threads, a thread's own colour said nothing about where it
lived. The colour is stored rather than swapped at read time so that every
reader (the sidebar, search, the access-request marks the server builds, a
future email) gets it from the one appearance it already reads.

**Rejected:** A first cut swapped the colour on the client at draw time. It
left server-built marks wrong and put the rule in every surface that draws a
thread. A read-time swap on the server was also weighed: it keeps the stored
colours, but every projection point would need to know the rule, and a
Channel recolour would have to republish each row. Hooking each placement
path in code was rejected for triggers: the placement writes are many
(birth, add, remove, move, archive into General, restore, the cutover) and a
missed one is a thread silently left in the wrong colour. Sending due rows
back to back was rejected for one batch in flight: the backfill marks every
thread at once, and each message calls WorkspaceDO and then sends a child
effect back to it, the shape that overloaded the object in the resource-search
backfill. Completion gating needs no interval anyone would have to pick.

**Respect:** Undoing this is not a deletion: the original colours are gone.
Letting conversations choose again means removing the colour drop in
`applyAppearance` and the triggers, after which a thread keeps its Channel's
colour until someone picks another. When a thread sits in several Channels its
colour follows `canonicalChannelSpaceId`, not the Channel it is being read in.

### 2026-10-01 — One 253-icon catalog in sections, for every surface with an appearance

**What changed:** One catalog in `appearance-icons.ts` replaced the 37
work-stream keys and the Space's own 25, and a Space now opens the same picker
as a Channel. Icons split pickable from storable the way colours do, and each
description became a short phrase.

**Why:** The old lists left most work with no fitting mark. Every description
ships in every naming prompt, so sentence-length lines across 253 icons would
have made each naming call several thousand tokens heavier. Retiring a key from
the menu rather than the vocabulary follows the colour entry below: the schema
parses on every read.

**What a future change has to respect:** keep `GENERATED_APPEARANCE_ICON_KEYS`
in its order, add a description with every key, and move a key to
`RETIRED_APPEARANCE_ICON_KEYS` rather than deleting it. New keys are new wire
values: a desktop build that predates them parses appearances against its own
enum and rejects the whole payload, and raising `MINIMUM_SERVED_CLIENT_CONTRACT`
in the same deploy would turn away every shipped build instead. This change
accepted that breakage and relies on auto-update to move people to a build that
knows the new keys. Shipping a reader that tolerates unknown keys first was
considered and not taken; it is the way to make a later catalog change free.

### 2026-09-21 — Breakouts own persisted appearances

**What changed:** A Breakout now uses the same persisted icon-and-colour shape
and picker as a Channel. Its own conversation object commits the choice and
publishes it in the existing common projection; the parent includes that value
in each authorized Breakout row, while the client patches only that row when
the command receipt returns. That receipt patch is bound to the exact row the
choice started from and remains overlaid only while parent snapshots still carry
that baseline; a different authoritative value wins. Older Breakouts with no
stored choice continue to derive a stable mark from their ID.

**Why:** Generated marks made Breakouts distinct but not personalizable, while
copying the Channel appearance made a Breakout look like another view of Main.
The child already had the same appearance column and command machinery, so a
second table or Breakout-specific palette would have duplicated authority and
interaction logic. The parent remains the authority for who can discover the
row; the child remains the authority for what its own conversation looks like.

**What a future change has to respect:** a Breakout appearance is not Channel
appearance and is not parent-authored metadata. Commit it in the addressed
child, project it through `substream_directory`, and expose it only inside the
same roster-filtered child row that already carries the title. Receipt-time
cache movement must preserve omitted fields from the child's effective
appearance and must not regress a newer parent projection.

### 2026-09-10 — A Sidekick picks from the same palette, and the picker stopped belonging to work streams

**What changed:** The Sidekick profile's hexagon became the trigger for this
picker. `WorkstreamAppearancePicker` is now `AppearancePicker` in
`appearance-picker.tsx`, taking the trigger's mark as `renderGlyph` and its
accessible name as `label`; its CSS moved from `.workstream-appearance-*` to
`.appearance-picker-*`. `AutomationGlyph` gained an `appearance` prop and now
resolves through `resolveWorkstreamAppearance` like the other two treatments.
Where a Sidekick's value is stored and how it reaches other people is
[`automation-lifecycle.md`](automation-lifecycle.md#choosing-what-a-sidekick-looks-like).

**Why:** A Sidekick had a hexagon nobody could change, in the identity colours
this catalog already defines, and the ask was for the *same* picker rather than
one that looks like it. The hard part of this component is not the grid: it is
several unsaved clicks in flight at once, each retiring only when its own field
moves authoritatively, an error that belongs to the newest choice, and a preview
that survives an unrelated broadcast. Copying that for the second caller would
have meant two of them, and the second copy would have been the one that
drifted. The only thing that genuinely differs is the mark the trigger draws, so
that is the prop and everything else stayed put.

Renaming it was part of the change rather than tidying after it. A component
called `WorkstreamAppearancePicker` mounted on a Sidekick is a name that
actively misleads whoever reads it next, and this repository has a document
about exactly that kind of stale name. The CSS moved for the same reason and no
other; the rules themselves are untouched.

**Three names deliberately did not move, and the reasoning is the same argument
reaching its limit.** `WorkstreamAppearance` and `WorkstreamAppearancePatch` are
now the stored shape and the request body of `POST /sidekicks/:id/appearance`,
and this document's own filename still says work stream while its contents cover
chosen identity generally. All three are misleading in exactly the way the
component's name was. They stayed because the blast radius is different in kind:
the two contract types are exported across every package and named in schemas a
Durable Object parses on each read, and a document's filename is linked from the
index and from a dozen other documents. Neither is hard, both are wide, and
neither belongs in a change about Sidekick icons. Recorded here so the third
caller does not have to work out whether it was considered.

**One click is one directory effect, one `registration_generation` bump and one
re-push of the workspace's `automations` list to every subscribed socket.**
Clicking across the ring is that many. It is fine at present scale and gets no
guard now, per
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md),
but it is the first place to look if that sidebar push ever feels chatty.

`AutomationGlyph` reading the palette itself was the older half of the same
problem, and the entry below already predicted it — "a future surface wanting a
third treatment should add it here rather than reading `workstreamAppearance`
and picking colours itself". It was already the third treatment; it simply
predated the resolver. Going through `resolveWorkstreamAppearance` is what lets
it render a *stored* key at all, and it inherits the unknown-key fallback that
entry describes, which matters more here than for the other two: a Sidekick's
key can now arrive from a client shipped after the one drawing it.

**The trigger's hover fill moved with it**, from
`--av-sys-color-surface-raised-hover` to `--av-cmp-row-background-hover`, for
both callers. The hexagon is a sidebar tile in the other rail and hovers there
on the row token, so filling differently depending on where you found it read
as two controls; and the old token was the wrong weight anyway — opaque in
dark, and in light the same value `cmp.row.background-selected` holds, so the
trigger announced a selected row on something nothing had selected.

**What a future change has to respect:** the picker is the primitive and the
glyph is the caller's. A third surface adds a treatment beside
`WorkstreamGlyph`, `WorkstreamMark` and `AutomationGlyph`, and passes it to this
same picker; it does not fork either one.

### 2026-09-09 — A bare tinted mark beside the filled glyph, read off the row

The work-stream sidebar's main conversation row asked for this identity, and the
filled glyph was the wrong weight for it: a rail that only ever shows one work
stream does not need the badge that tells one stream from another in a list of
them. `WorkstreamMark` renders the same chosen icon in the same chosen colour
without the gradient shape, so both components resolve one appearance and only
the treatment differs. A future surface wanting a third treatment should add it
here rather than reading `workstreamAppearance` and picking colours itself.

Which cache it reads was the harder half. The rail first read the parent's
cached detail, the way the header does, and review pointed out what the two
receipt-time entries below had already decided: every unversioned write lands on the row and
none of them touches the detail, so a person's own icon change moved the
navigation sidebar on the receipt and left this rail on the old mark until the
projection — the two rails disagreeing about one work stream, which is the
opposite of what putting the mark there was for. `useCachedWorkstreamAppearance`
reads the row instead. That is sound in one direction only, and the direction is
the point: the row takes the projection **and** the unversioned writes, so it is
never behind the detail. Writing the detail to close the gap is what those entries
reject, and reading the row is the other half of that rule finally being
used — a surface that needs the fast value reads where the fast value is written.
The header is deliberately left on the detail: that entry is what retires the
picker's preview, and moving the header onto the row would reintroduce the
flicker.

A second treatment also made the resolution worth naming. Both components read
the same map and the same seed, but by two copies of one expression kept in step
by hand, and a third treatment would have been a third copy.
`resolveWorkstreamAppearance` is that expression once. Extracting it fixed a
defect the duplication had hidden in both: the icon fallback was written
`saved?.icon ? MAP[saved.icon] : ICONS[i] ?? Sparkles`, where the ternary binds
first, so the fallback only ever guarded the *generated* branch. A stored key
the map lacks — a client shipped before a key was added, meeting a work stream
that already carries it — resolved to `undefined`, and React renders an
undefined component by throwing, blanking the window rather than dropping one
glyph. Anything added to the icon catalog now has one place to be resolved and
one fallback, and the catalog is a thing a model chooses from, so keys will keep
arriving.

### 2026-09-09 — The picker offers the ring; the schema accepts more than the picker offers

**What changed:** The twelve-key palette became a fourteen-hue ring in wheel
order. `gray`, `brown`, `yellow` and `teal` left the picker, and `black` — added
to the palette in the same change — is never offered here at all, being reserved
for account accents. `PROJECT_COLOR_KEYS` is the pickable list;
`WorkstreamAppearanceSchema` validates against `PROJECT_COLOR_KEYS_STORABLE`,
which is every colour the palette defines.

**Why:** The schema had been pointed at the pickable list, which made retiring a
colour a read-path outage rather than a product change — `parse` throws, and it
runs on every work-stream read, so a stored `gray` would have taken the work
stream down for its owner alone. Splitting pickable from storable is what makes
the palette editable at all. Remapping the four retired keys onto near
neighbours was the alternative; it was rejected because it recolours projects
under their owners to save a list nobody sees, and it is not reversible once the
old value is overwritten. The same reasoning is why `black` is withheld from the
menu rather than from the vocabulary: hiding a colour costs a line, forbidding
one costs a migration and breaks whoever holds it.

**Consequences:** A retired key keeps its design token and keeps rendering.

Every work stream that never had a colour chosen for it changes appearance once.
`workstreamAppearance` seeds from the id and indexes the palette, so both the
length and the order moved; `conversation-surfaces.md` already names this as a
visible migration rather than a repaint, and it is the accepted cost of
reordering. The derivation now runs over `PROJECT_COLOR_RING` — the ring without
`black` — so a derived glyph is always a hue: the neutral is something a person
picks, and handing it out by hash would leave roughly one work stream in fifteen
looking deliberately unaccented when nobody had chosen anything.

Adding or retiring a colour is a contracts edit plus a WorkspaceDO migration —
the `icon_color_key` CHECK vocabulary is baked into shipped SQL — and
`test/workspace-project-palette.test.ts` fails the build if the contract moves
without one.

### 2026-09-08 — Remove appearance negotiation

The URL capability broke the control connection in installed desktop builds.
Appearance now travels unconditionally and receivers tolerate additive protocol
changes. This supersedes the same-day capability negotiation, in which
appearance frames were sent only to a client that had declared a socket
capability, so that older strict readers kept receiving control updates.

### 2026-09-09 — Rally chooses the icon a work stream starts with, and every unversioned appearance write is row-only

**What changed:** Every icon key now carries a description of the mark it draws
in `workstream-appearance.ts` — the drawing only, never what the icon is for, so
matching stays with the model that has the request — and the work-stream naming
pass renders that catalog into its prompt and chooses an icon alongside the
name, so a sidebar shows marks that mean something instead of a column of
id-derived glyphs. The write is in `rename`, in the same transaction as the
title, and refuses any work stream that already has a stored icon: the picker's
command is unconditional and a person choosing an icon settles no title, so the
"already stored" condition is the only thing standing between a naming pass and
someone's choice. Nothing about the picker, the colour, the projection, or the
deterministic default changed.

On the client, `patchCachedGeneratedAppearance` is gone;
`patchCachedGeneratedIcon` replaces it, row-only like the receipt-time write,
and it declines a row that already has an icon. The rule is now stated as a
property of the writer rather than of the caller: **the cached detail is the
picker's own signal, and only the versioned projection may move it.**

**Why:** Review on #619 caught the naming pass's generated icon being written to
the cached detail as well as the sidebar row, on the reasoning that a generated
icon has no optimistic preview to retire. That reasoning was wrong in one
direction it did not consider: the icon has no preview of *its own*, but the
detail is where `settled()` looks to retire **somebody else's**, and its
`changed` arm fires when the detail's icon moves off the baseline to *any*
value — deliberately, because another person changing the icon has to retire a
pending choice too. So a generated icon landing between a person's receipt and
their projection retired their in-flight choice to the generated glyph and held
the header there for the seconds the projection takes. That is the same defect
as the 2026-09-09 entry below ("The receipt writes the row, not the detail"),
reached through a different writer.

The same review raised the row half, and that one earned a condition rather
than an argument: an event carries an icon only when the object had none when
it renamed, so a row that has one holds something newer, and the event can
arrive after that receipt because the two travel different paths. Declining a
row that already has an icon is an ordering rule for a write whose value is
known-stale the moment anything else is present, not a second copy of the
object's own "only where none is stored" — which stays authoritative.

**Considered and rejected:** Patching `settled()` instead: distinguishing
"moved to my value" from "moved to someone else's" would break the case that
arm exists for. If the header ever needs a generated icon immediately, the fix
is the one the entry below already names — a receipt or event carrying the
committed appearance and a version, so the write is authoritative rather than
optimistic — not a second unversioned writer with its own exception.

**Consequences:** The cost is the one the entry below already accepted — the
header glyph waits for the projection — and it is smaller here, because until
it lands the header shows the id-derived default rather than a wrong stored
value. The catalog gaining a second audience is the thing to respect: an icon
added here is now also an icon a model may choose, and it needs a description
of its shape in the same edit. Why the second naming pass may not revisit the
first one's icon, and what provenance on the appearance would buy, is in
[`workstream-naming.md`](workstream-naming.md).

Shipped in #619.

### 2026-09-09 — The receipt writes the row, not the detail

Review traced a header flicker the receipt-time write had introduced: writing
the cached detail retired the picker's preview at once, and an unrelated common
projection already in flight at a newer waterline could then paint the pre-choice
value over the header until the appearance projection landed. Before the write
the preview covered that window. The receipt now patches the sidebar row only,
which has no preview of its own, and the header stays on the picker's preview
until the versioned detail carries the choice. The same review noted that the
client merges the patch over its own cached base while Main merges over its row,
so an icon-only choice can briefly pair with a color another client just
changed; that is inherent to a receipt with no payload and is recorded on the
helper. Returning the committed appearance in the receipt would give the client
the authoritative value and a single merge rule, and is the change to make if
either transient ever matters.

### 2026-09-09 — A replayed receipt does not touch the caches

Review found an ordering the receipt-time patch got wrong: a choice commits,
its receipt is lost with the connection, another client's newer appearance
arrives through versioned state, then the reconnect resends the command and
the idempotent replay receipt wrote the older choice over the newer cached one.
Main publishes nothing for a replay, so nothing would have corrected it. The
socket hook now applies the patch only when the receipt arrives on the
connection that sent the command; a receipt after a reconnect is left to the
snapshot that reconnect already delivered. Carrying the committed value and a
version in the receipt was the alternative, and remains the right shape if the
receipt ever needs to be authoritative on its own; it was not taken here because
it changes the socket contract for a case the existing snapshot already covers.

### 2026-09-08 — Sidebar row follows the receipt, not the projection

Choosing a color or icon updated the header at once and the sidebar rail seconds
later, because the rail reads the work-stream list and nothing wrote to it before
the directory projection arrived through two Durable Object alarms and two Queue
hops. The socket hook now patches the list row and the cached detail when Main's
receipt arrives, through one shared cache primitive that writes both places a
work stream is read from. Writing on send was rejected: a refused command would
then need a revert path and could show a value the room never held. Publishing
the appearance directly from Main's feed socket was rejected for now as a server
change that would still leave other clients on the full path; the client patch is
the cheaper, reversible fix, and it stays correct because the versioned receiver
replaces the field whole on the next newer waterline. A future change must keep
that: an unversioned write here is only safe while a later authoritative push can
overwrite it.

### 2026-09-08 — Reconcile individual optimistic choices

Review found that unrelated metadata broadcasts rebuild the appearance object,
which prematurely retired a saved preview by reference equality. Each choice now
tracks its own field values and receipt; only an authoritative value change settles
it. Failed earlier choices are removed independently and cannot leave a stale error
on a later success. Closing the popup clears its transient error. The compact
header keeps the picker outside the heading so its accessible name remains the title.

Stored keys remain server-validated on every write and projection. A newer desktop
cannot write an unknown key through an older server. Catalog expansion or rollback
must preserve the accepted stored keys; malformed durable state deliberately fails
visibly rather than silently replacing shared identity. This change does not add a
second, permissive interpretation of the server's validated appearance contract.

### 2026-09-08 — Shared editable identity

Work-stream icons were deterministic decorations with no stored preference.
The header now exposes immediate color and icon selection. Main's existing
command receipts and common-effect pipeline keep the change durable and shared;
a device preference or separate REST writer would introduce another authority.
Future catalogs must preserve the original deterministic symbol ordering and
stable stored keys.

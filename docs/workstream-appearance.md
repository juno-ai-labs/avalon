# Work-stream appearance

A work stream has one icon and color shared by everyone who can read it. Clicking
its header icon opens a compact palette: fixed colors above a scrolling icon grid.
Each choice saves immediately and keeps the palette open. A work stream nobody
has chosen for usually gets its icon from the naming pass, out of this same
catalog; where that pass produced none it keeps the deterministic icon derived
from its id, which is also what every work stream created before this existed
still shows.

**A Sidekick has one too, and it is the same palette.** Clicking the hexagon on
its profile opens the picker this document owns, over the same catalog and the
same colour ring. What differs is only where the value is stored and how it is
sent, which is the Sidekick's own business and lives in
[`automation-lifecycle.md`](automation-lifecycle.md#choosing-what-a-sidekick-looks-like);
this document owns the catalog, the descriptions, the colours, the picker's
behaviour and the deterministic default, for every surface that has an
appearance. Anything else that grows one comes here for those, and brings its
own storage and its own glyph treatment.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/workstream-appearance.ts` | Stable icon keys, one model-visible description per key, the default key, color keys, and partial updates. |
| `apps/desktop/src/renderer/components/appearance-picker.tsx` | `AppearancePicker`: palette, optimistic preview, ordered clicks, and failures, for every surface that has an appearance. The caller supplies the trigger's mark through `renderGlyph` and its accessible name through `label`; nothing else about it differs between a work stream and a Sidekick. |
| `apps/desktop/src/renderer/components/workstream-glyph.tsx` | `resolveWorkstreamAppearance`, the one resolver from a stored appearance to an icon component and a colour, and the three treatments over it: the filled `WorkstreamGlyph` for navigation, `WorkstreamMark` — the bare tinted symbol — for a surface already inside the work stream, such as the center rail's main conversation row, and `AutomationGlyph`, the rounded hexagon a Sidekick wears. |
| `apps/desktop/src/renderer/lib/workstreams-cache.ts` | `patchCachedWorkstreamAppearance`, the receipt-time write that puts a committed choice on the sidebar row ahead of the directory projection, and `patchCachedGeneratedIcon`, the naming pass's, which additionally declines a row that already has an icon. Neither touches the cached detail. Built on `patchCachedWorkstream`, the write for any unversioned fact both caches must agree on. |
| `apps/desktop/src/renderer/lib/use-workstreams-query.ts` | `useCachedWorkstreamAppearance`, the read side: one work stream's appearance off the sidebar row, for a surface that must move with that row rather than with the detail. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Orders the picker's choices on the retained Main socket and applies each one to the caches when its receipt arrives. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Authoritative write, command receipt, and common-state publication. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Main conversation's nullable `workstream.appearance_json`. |
| `apps/api/src/durable-objects/workspace-do.ts` | Directory projection for all workspace surfaces. |
| `apps/api/src/durable-objects/workstream-identity-storage.ts` | `rename`, the second writer: it offers the naming pass's icon and refuses it where one is stored. See [`workstream-naming.md`](workstream-naming.md). |
| `apps/api/src/durable-objects/sidekick-do.ts` | `setAppearance` and `automation.appearance_json` — the Sidekick's copy of this, owned by [`automation-lifecycle.md`](automation-lifecycle.md#choosing-what-a-sidekick-looks-like). |

## How it works

The header uses the retained Main conversation socket even when a private child
is selected. `set_workstream_appearance` carries a partial appearance and a unique
operation ID. Main commits the merged value, idempotency receipt, and common
outbox effect together. WorkstreamDO forwards that common state to WorkspaceDO
and publishes it to its control sockets. Existing versioned state handling
updates the header, sidebar, and cached detail. Reconnection obtains the same
appearance in the canonical snapshot.

That projection is the durable path, not the fast one. From the commit it
crosses Main's outbox alarm, a Queue hop to WorkstreamDO, WorkstreamDO's outbox
alarm, a second Queue hop to WorkspaceDO, and only then a state push: seconds,
while the receipt comes back in one socket round trip. The picker previews its
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
a color change does not overwrite another user's icon. The icon registry extends
the original twelve deterministic symbols with the existing project icons. Each
key also carries one or two sentences describing the icon, in the same file: the
naming pass chooses an icon from this catalog and needs to know what each key
draws. They are model-visible strings, so keep them in plain words — no icon
library names — and add one with every key added, which the exhaustive `Record`
enforces at compile time. **Describe the drawing only.** Name what the icon
depicts and then how it is drawn — "two coins, one face on and one behind it at
an angle" — and stop. A description must not say what an icon is *for*: matching
a mark to a work stream belongs to the naming pass's model, which has the
request, and a test fails a description that carries usage language. See
[`workstream-naming.md`](workstream-naming.md).
Colors store semantic keys such as `blue` and `purple`, never hex or RGB values.
Both the swatch and glyph resolve `sys.color.project.<key>` through the current
appearance. The keys that resolve to the same colour in both appearances live
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

- One authoritative appearance belongs to Main; a private child must not create
  an alternative identity for the parent.
- **A person's choice outranks a generated one, and the rule is a condition on
  the write.** The picker's command writes unconditionally; the naming pass's
  write is refused wherever an icon is already stored. Neither writer can tell a
  generated icon from a chosen one after the fact, so the ordering has to be
  decided at the moment of writing.
- Command receipts are committed with the write. Replaying an older operation
  cannot overwrite a later choice.
- Omitted fields mean unchanged; null fields use the deterministic ID-based
  default. Older work streams retain their original appearance until edited.
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

The picker component suite covers immediate selection, ordered rapid clicks,
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
listings. Inspect the actual Electron popup in light and dark,
including scrolling, and check another connected window and reopening.

## Changelog

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

`AutomationGlyph` reading the palette itself was the older half of the same
problem, and the entry below already predicted it — "a future surface wanting a
third treatment should add it here rather than reading `workstreamAppearance`
and picking colours itself". It was already the third treatment; it simply
predated the resolver. Going through `resolveWorkstreamAppearance` is what lets
it render a *stored* key at all, and it inherits the unknown-key fallback that
entry describes, which matters more here than for the other two: a Sidekick's
key can now arrive from a client shipped after the one drawing it.

**What a future change has to respect:** the picker is the primitive and the
glyph is the caller's. A third surface adds a treatment beside
`WorkstreamGlyph`, `WorkstreamMark` and `AutomationGlyph`, and passes it to this
same picker; it does not fork either one.

### 2026-09-10 — Project colours live in the base token file

**What changed:** The `sys.color.project.*` keys both appearances set to the
same value moved from `light.json` and `dark.json` to
`config/design-tokens/base.json`, with every other token the two files agreed
on ([`theming.md`](theming.md)). The section above told a reader to tune the
keys per appearance; it now says where each key lives.

**Why:** Two files carrying identical keys can only ever differ by mistake, and
the token build now fails an appearance file that sets a token both
appearances agree on. Following the old instruction would trip that test
rather than change a colour. A key that has to differ by appearance moves into
both appearance files in the same edit, which the same test also holds.

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
changes. This supersedes the capability-based compatibility approach below.

### 2026-09-09 — Every unversioned appearance write is row-only, generated icons included (#619)

Review on #619 caught the naming pass's generated icon being written to the
cached detail as well as the sidebar row, on the reasoning that a generated icon
has no optimistic preview to retire. That reasoning was wrong in one direction it
did not consider: the icon has no preview of *its own*, but the detail is where
`settled()` looks to retire **somebody else's**, and its `changed` arm fires when
the detail's icon moves off the baseline to *any* value — deliberately, because
another person changing the icon has to retire a pending choice too. So a
generated icon landing between a person's receipt and their projection retired
their in-flight choice to the generated glyph and held the header there for the
seconds the projection takes. That is the same defect as the 2026-09-09 entry
below, reached through a different writer.

The rule is now stated as a property of the writer rather than of the caller:
**the cached detail is the picker's own signal, and only the versioned
projection may move it.** `patchCachedGeneratedAppearance` is gone;
`patchCachedGeneratedIcon` replaces it, row-only like the receipt-time write.
The cost is the one the entry below already accepted — the header glyph waits
for the projection — and it is smaller here, because until it lands the header
shows the id-derived default rather than a wrong stored value.

The same review raised the row half, and that one earned a condition rather than
an argument: an event carries an icon only when the object had none when it
renamed, so a row that has one holds something newer, and the event can arrive
after that receipt because the two travel different paths. `patchCachedGeneratedIcon`
declines a row that already has an icon. That is an ordering rule for a write
whose value is known-stale the moment anything else is present, not a second
copy of the object's own "only where none is stored" — which stays
authoritative.

Patching `settled()` instead was rejected: distinguishing "moved to my value"
from "moved to someone else's" would break the case that arm exists for. If the
header ever needs a generated icon immediately, the fix is the one the entry
below already names — a receipt or event carrying the committed appearance and a
version, so the write is authoritative rather than optimistic — not a second
unversioned writer with its own exception.

### 2026-09-09 — Rally chooses the icon a work stream starts with (#619)

Every icon key now carries a description of the mark it draws in
`workstream-appearance.ts` — the drawing only, never what the icon is for, so
matching stays with the model that has the request — and the work-stream naming
pass renders that catalog into its prompt and chooses an icon alongside the name — so a sidebar shows marks that mean something instead of a
column of id-derived glyphs. The write is in `rename`, in the same transaction as
the title, and refuses any work stream that already has a stored icon: the
picker's command is unconditional and a person choosing an icon settles no title,
so the "already stored" condition is the only thing standing between a naming
pass and someone's choice. Nothing about the picker, the colour, the projection,
or the deterministic default changed. The catalog gaining a second audience is
the thing to respect: an icon added here is now also an icon a model may choose,
and it needs a description of its shape in the same edit. Why the second naming pass may not
revisit the first one's icon, and what provenance on the appearance would buy, is
in [`workstream-naming.md`](workstream-naming.md).

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

### 2026-09-08 — Preserve installed-client control updates

Review caught that an optional field remains incompatible with an older strict
reader. Appearance now requires an explicit socket capability, preserved through
hibernation, so deploying the server cannot stop older clients receiving title,
viewer, or private-child changes. A URL capability also leaves older servers able
to accept newer clients without changing their strict subscribe command. Runtime
tests cover both frame shapes and the actual workspace directory projection.

### 2026-09-08 — Shared editable identity

Work-stream icons were deterministic decorations with no stored preference.
The header now exposes immediate color and icon selection. Main's existing
command receipts and common-effect pipeline keep the change durable and shared;
a device preference or separate REST writer would introduce another authority.
Future catalogs must preserve the original deterministic symbol ordering and
stable stored keys.

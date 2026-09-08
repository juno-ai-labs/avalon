# Work-stream appearance

A work stream has one icon and color shared by everyone who can read it. Clicking
its header icon opens a compact palette: fixed colors above a scrolling icon grid.
Each choice saves immediately and keeps the palette open.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/workstream-appearance.ts` | Stable icon keys, color keys, and partial updates. |
| `packages/contracts/src/projects.ts` | Shared color registry, picker choices, and `paintProjectColor`. |
| `apps/desktop/src/renderer/components/workstream-appearance-picker.tsx` | Palette, optimistic preview, ordered clicks, and failures. |
| `apps/desktop/src/renderer/components/workstream-glyph.tsx` | Shared rendering and deterministic defaults. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Authoritative write, command receipt, and common-state publication. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Main conversation's nullable `workstream.appearance_json`. |
| `apps/api/src/durable-objects/workspace-do.ts` | Directory projection for all workspace surfaces. |

## How it works

The header uses the retained Main conversation socket even when a private child
is selected. `set_workstream_appearance` carries a partial appearance and a unique
operation ID. Main commits the merged value, idempotency receipt, and common
outbox effect together. WorkstreamDO forwards that common state to WorkspaceDO
and publishes it to its control sockets. Existing versioned state handling
updates the header, sidebar, and cached detail. Reconnection obtains the same
appearance in the canonical snapshot.

New control clients request `workstreamAppearance=1` when issuing a socket ticket.
The server includes it in the socket URL. The Worker forwards that capability, and WorkstreamDO stores it in the hibernating
socket attachment. Subscribe snapshots and later broadcasts omit `appearance`
for older clients, whose strict metadata schema would reject the whole frame.
Missing capabilities on pre-deploy attachments also retain the original shape.

The socket connection queues rapid clicks in order, retaining their original
work-stream address even if the picker unmounts. A click changes only its own field, so
a color change does not overwrite another user's icon. The icon registry extends
the original twelve deterministic symbols with the existing project icons.
Colors store semantic keys such as `blue` and `purple`, never hex or RGB values.
Both the swatch and glyph resolve `sys.color.project.<key>` through the current
appearance, after `paintProjectColor` remaps the retired `orange` key to gold
`yellow`. Tune the remaining keys independently in
`config/design-tokens/themes/light.json` and `dark.json`, then run
`pnpm tokens:build`. The shared palette also affects projects and personal accents.
Pickers offer `PROJECT_COLOR_CHOICES`, which omits `orange`. The stored key stays
valid so existing appearances do not fail the wire schema.

## Invariants

- One authoritative appearance belongs to Main; a private child must not create
  an alternative identity for the parent.
- Command receipts are committed with the write. Replaying an older operation
  cannot overwrite a later choice.
- Omitted fields mean unchanged; null fields use the deterministic ID-based
  default. Older work streams retain their original appearance until edited.
- Every common projection carries the appearance. Dropping it makes identity
  differ between the header, sidebar, and reopening a work stream.

## Boundary

This controls work-stream identity only. Project appearance and automation glyphs
keep their existing behavior. The account's personal accent and device light/dark
preference remain owned by [desktop appearance](theming.md).

## Failure modes and limits

The existing socket transport queues commands while reconnecting and resends
with their operation IDs. A failed command restores server state and leaves an
inline error in the open picker. Invalid keys are rejected by the wire schema.
The scroll viewport is a layout choice, not a cap on the catalog or server data.

## Testing

The picker component suite covers immediate selection, ordered rapid clicks,
staying open, Escape focus restoration, and failed saves. The real-workerd
`message-to-output-pipeline.test.ts` appearance case covers partial updates,
idempotent replay, and persistence across object eviction. Its dropped-write
mutation must fail the reopened snapshot assertion. Client control/state tests
cover the common cache path. Inspect the actual Electron popup in light and dark,
including scrolling, and check another connected window and reopening.

## Changelog

### 2026-09-08 — Retire neon yellow from pickers

Neon yellow (`orange`) failed contrast on sidebar chips even after retuning the
token off brand lime. Removing it from pickers and from new deterministic
defaults is cheaper than hunting a readable neon. The stored key stays in
`PROJECT_COLOR_KEYS` so existing appearances and the WorkspaceDO check still
validate; `paintProjectColor` maps leftover `orange` to gold `yellow`. Personal
`orange` follows the same split via `PERSONAL_COLOR_CHOICES` and
`paintPersonalColor` onto `amber`. Reintroducing a neon swatch needs a color
that holds against white icons, not a restoration of this key's former paint.

### 2026-09-08 — Soften the neon-yellow chip

The shared `orange` identity token was the same lime as brand fills (`#ccff00`),
which made sidebar chips too bright and green. Both appearances now resolve it
to `#ffff3c` so the glyph is yellow. Brand fills are left on `#ccff00`; the
stored key stays `orange` and the picker still labels it Neon yellow. Changing
only this token also shifts project and personal-accent swatches that share the
palette, which is the coupling the picker already documents.

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

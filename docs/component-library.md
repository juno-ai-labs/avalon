# Component library

`apps/desktop/src/renderer/components/ui/` is the desktop renderer's component
library: a set of primitives with a variant API, styled entirely out of the
design tokens, imported through one barrel, and shown side by side on a screen
in the running application. It exists so that a control's appearance is decided
once, in a file whose name says what the control is, rather than a hundred and
twelfth time in a stylesheet rule named after the screen that needed it.

Read this before adding a component, before writing a `className` in the
renderer, and before adding an icon. [`theming.md`](theming.md) owns the tokens
themselves and is the prerequisite: this document is about what consumes them.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `components/ui/index.ts` | **The barrel.** The only module app code may import from. Adding a component means adding a line here. |
| `components/ui/<name>.tsx` | One primitive each. Owns its own styling; names tokens, never colours. |
| `components/ui/cn.ts` | `cn()` — `clsx` plus a `tailwind-merge` taught about the token scales. Every primitive ends with `cn(variants(), className)`. |
| `components/ui/icon.tsx` | The icon registry: a name per *role*, over Lucide, at four sizes. |
| `components/ui/connector-icon.tsx` | Provider brand marks, over Tabler, on the `cmp.connector.*` faces. |
| `components/ui/surfaces.ts` | The one treatment shared by everything that floats — menus, selects, popovers. |
| `screens/component-explorer.tsx` | The explorer at `#/explorer`, and `explorerSections`, which a test holds to the barrel. |
| `styles/tailwind-theme.ts` | **Generated.** The palette and scales, derived from the token registry. |
| `scripts/build-theme-assets.mjs` | Writes that file. `pnpm tokens:build`; `pnpm tokens:check` fails on drift. |
| `apps/desktop/tailwind.config.ts` | Assigns the generated palette to `theme.colors`, extends the rest. |
| `scripts/eslint-rules/component-library-boundaries.mjs` | The barrel rule and the icon-registry rule. |
| `components/primitives.tsx` | Rally's *own* components — work-stream marker, socket indicator, avatar, naming skeleton — plus historical re-exports of `Badge` and `Modal`. |

## How it works

### A component is tokens, a variant table, and `cn`

A primitive is a `cva` variant table over Tailwind utilities, and every utility
resolves to a design token. `Button` is the shape of all of them:

```tsx
const buttonVariants = cva(
  cn('inline-flex … rounded border border-line bg-surface-raised text-ink-subtle',
     'enabled:hover:border-line-hover enabled:hover:bg-surface-raised-hover'),
  { variants: { variant: { primary: 'border-brand-base bg-brand-base …', … } } },
);
```

`bg-surface-raised` is `var(--av-sys-color-surface-raised)`. There is no second
palette and no place to write a hex.

### The palette is generated from the registry

`config/design-tokens/registry.json` is the vocabulary. `pnpm tokens:build`
writes `styles/tailwind-theme.ts` from it alongside `themes.css`, and
`tailwind.config.ts` imports that module. Adding a token makes a utility appear;
nothing has to be copied.

Two rules decide what is published:

- **`ref.*` is never exposed.** The neutral and line ramps are how a theme
  *builds* its semantic tokens. A component naming `ref.color.neutral.4` asserts
  a contrast step rather than a meaning, and any theme that reorders its ramp
  breaks it silently.
- **`sys.*` defines the scales; `sys.*` and `cmp.*` colours define the palette.**
  Component *measurements* (`cmp.markdown.heading-1` and the rest) stay with
  `app.css`, which owns the rules that use them.

`colors` is assigned to `theme.colors` rather than merged into
`theme.extend.colors`. That is the enforcement: Tailwind's own `zinc-500` and
`red-600` are removed from the class vocabulary, so `bg-zinc-800` fails the
build instead of rendering correctly under one theme and wrongly under the other
three.

### `cn` has to be told about our scales

`tailwind-merge` classifies an unknown `text-*` by shape, and every one of our
names has the shape of a colour. `text-hint` is a font size and `text-ink-muted`
is a colour; to the stock configuration both are `text-color`, so
`cn('text-hint', 'text-ink-muted')` silently drops the size. `cn.ts` extends the
class groups from the generated module's own keys, so a new token is classified
correctly without anyone remembering the file exists.

### Icons are named for what they mean

`Icon` takes a `name` from a registry — `dashboard`, `private`, `more` — and a
`size` from a closed scale of four. The glyph is an implementation detail of the
registry row.

Brand marks are the one thing Lucide does not carry (it removed them in 2023
over trademark exposure), which is the sole reason Tabler is still a dependency.
`ConnectorIcon` is that boundary, and it is also where the `cmp.connector.*`
faces are applied, because a mark and the tile behind it have to be chosen
together or the mark disappears into it.

### The explorer keeps the set visible

`#/explorer` renders every barrel export in every variant, with a control that
stamps `data-theme` so a component can be checked against all four themes
without changing the application's own. It is not linked from the interface: a
route nobody navigates to costs nothing, while a navigation entry would have to
answer who is allowed to see it.

## Invariants

- **App code imports the barrel and nothing else inside `ui/`.** The barrel is
  what makes a backing swappable — replace one file and every call site gets the
  change. A deep import revokes that for the caller. `rally/component-library-barrel`
  fails the build; library files import their siblings freely, which is what a
  library's internals are.
- **No component names a colour.** Not a hex, not `rgb()`, not `zinc-500`. Three
  things enforce it from different directions: the palette assignment removes
  Tailwind's colours from the vocabulary, `themes.css.node.test.ts` rejects a hex
  or `rgba(` anywhere in the renderer's TypeScript, and the same test rejects one
  in `app.css`. Breaking any one of them pins a component to whichever theme its
  author was looking at.
- **Icons come from the registry.** `rally/icon-registry` fails a `lucide-react`
  import outside `icon.tsx` and a `@tabler/icons-react` import outside
  `connector-icon.tsx`. The Lucide rule carries a legacy list of seventeen files
  that have not been converted; **that list only shrinks.** A new entry is not a
  small exception, it is the rule being switched off for a file.
- **Every barrel export appears in the explorer.** `component-explorer.test.tsx`
  compares `explorerSections` against the barrel's runtime exports and fails on
  either a missing entry or a stale one. An export with genuinely nothing to
  render goes in `explorerExempt` with a reason.
- **One concept, one component.** If the barrel exports `Select`, the second
  select is not added beside it — the first one grows a variant, or the second
  replaces it in the same change.
- **A styling hook outside the library is a `data-slot`, not a class name.**
  `app.css` finds a badge through `[data-slot="badge"]`. A marker survives a
  rename and cannot be confused with the thing that does the styling.

## Boundary

The library owns generic primitives: controls, form parts, overlays, typography,
icons. It owns their appearance completely — a caller passing `className`
overrides, it does not complete them.

It does not own:

- **Tokens.** [`theming.md`](theming.md) does. A component that needs a value the
  registry has no name for adds the token there first, in the same change.
- **Rally's own components.** A work-stream status dot, a member avatar, the
  naming skeleton, the thinking orb — these encode product meaning and live in
  `components/primitives.tsx`.
- **Layout.** Screens compose; primitives do not position themselves. Margin
  belongs to the parent, which is why `ConnectorIcon` takes its `mr-[3px]` from
  the call site in `workstream-blocks.tsx` rather than carrying one.
- **Markdown.** [`markdown-rendering.md`](markdown-rendering.md) owns
  `MarkdownBody` and the `.markdown-body` styling, which is a document surface
  rather than chrome.

## Failure modes and limits

- **A utility naming a token the registry does not declare silently produces
  nothing.** Tailwind emits no rule for an unknown class, so the element renders
  unstyled rather than failing. `pnpm tokens:check` catches a stale generated
  file; a typo in a class name is caught by looking at the explorer, which is
  most of why it exists.
- **Opacity modifiers do not work on token colours.** `bg-surface/50` needs the
  palette to be channel triplets, and these are whole `var()` references. Use
  `color-mix()` in an arbitrary value, or a token.
- **`tailwind-merge` only resolves conflicts it can classify.** An arbitrary
  utility like `p-[10px]` against `p-pane` is left alone: both survive and the
  cascade decides. Prefer the scale.
- **The four icon sizes are 12, 14, 16 and 20 pixels.** They were chosen to cover
  the twelve sizes in use with the fewest steps that stay distinguishable. A
  fifth is a decision, not a detail — bring it to the team rather than adding it
  in passing.
- **`.button` and `.icon-button` are still stylesheet classes.** Twenty-five
  rules in `app.css` use them as hooks for per-context overrides
  (`.invite-form .button { height: 34px; }` and so on), so moving `Button`'s
  base styling into the component means converting those in the same change.
  That is the top of the migration backlog below, not an oversight.

## Migration

The library replaces `app.css` a family at a time. What has moved, and what
has not:

| Moved | Replaced |
| --- | --- |
| `Dialog` | `.dialog-overlay`, `-content`, `-header`, `-title`, `-description`, `-body`, `-footer`, and the narrow-window media query. `Modal` is a re-export, so all 21 call sites were unchanged. |
| `Select` | The whole `.dropdown-select-*` family (15 rules). Its two call sites name `Select` directly; `DropdownSelect` is gone. |
| `Switch` | The `.settings-toggle` family (8 rules) and the eight hand-written `<span><input/><span/></span>` triples. |
| `Badge` | `.badge`. The one external hook became `[data-slot="badge"]`. |
| `ConnectorIcon` | `.plugin-face*` (10 rules) and two identical copies of the connector icon map. |

| Not yet moved | Why |
| --- | --- |
| `Button`, `IconButton` | 25 `app.css` rules use `.button`/`.icon-button` as context hooks. See **Failure modes and limits**. |
| The Lucide legacy list | Seventeen files, roughly 250 call sites, at sizes the four-step scale does not offer. Converting them is a visual change across every screen and belongs in its own reviewable diff. |
| `.settings-preference-row`, `.settings-list-card`, `.form-field` | The settings layout. A `Field`/`Fieldset` cutover of the settings surface is the natural next slice. |

## Testing

`pnpm --filter @rally/desktop test`. The suites that hold the library up:

- `components/ui/cn.test.ts` — that the scale classifications survive. Break the
  `extend` in `cn.ts` and `text-hint` is dropped as if it were a colour.
- `components/ui/select.test.tsx` — behaviour, not classes. It replaced a test
  that asserted `dropdown-select-trigger-secondary`, which named the stylesheet
  and so passed for the wrong reason.
- `screens/component-explorer.test.tsx` — the barrel-to-explorer coverage check,
  in both directions.
- `styles/themes.css.node.test.ts` — the no-colour rule, over `app.css` *and*
  every renderer `.ts`/`.tsx`.
- `scripts/build-theme-assets.test.mjs` (via `pnpm test:scripts`, which CI runs)
  — that `tailwind-theme.ts` is what the token JSON produces.

A component test asserts what a user can reach: a role, a name, a state. It does
not assert a class name — a test that breaks when the backing changes but the
output does not is testing the backing, which is the one thing the barrel exists
to let us change.

**A component test is not enough on its own.** Per
[`AGENTS.md`](../AGENTS.md#verifying-visible-changes), look at the explorer in a
real window before calling a component done; the DOM says nothing about whether
something is visible, legible, or covered.

## Open questions

- **The control scale.** `Button` carries `.button`'s measurements verbatim —
  7px gap, 11px horizontal padding, 5px vertical — because rounding them inside
  a change whose claim is that nothing moved would have moved every button in
  the product. They are not on any scale. Normalising them is a decision for the
  team, and it wants a screenshot pass rather than an argument.
- **Whether Catalyst becomes the backing later.** Rejected for now; the reasoning
  is in the changelog entry below. If Rally moves to Tailwind v4, the palette
  remap that makes Catalyst themeable becomes available and the question is worth
  reopening.

## Changelog

### 2026-08-27 — A component library, built on Rally's tokens rather than on Catalyst

**What changed:** `components/ui/` now holds the renderer's primitives —
`Button`, `IconButton`, `Input`, `Textarea`, the `Field` family, `Switch`,
`Select`, `Dialog`, `Badge`, `Divider`, the typography set, `Icon` and
`ConnectorIcon` — behind one barrel, styled from the design tokens through a
Tailwind palette generated from the token registry. Two ESLint rules hold the
barrel and the icon registry. An explorer at `#/explorer` shows every export,
and a test fails when one is missing from it. Five `app.css` families (about 45
rules) were deleted as their components landed.

**Why:** the renderer had no component layer at all. Styling lived in a
4,241-line stylesheet holding 608 class names, **440 of them used exactly once**
— a class per element per screen, which is not a design system but a naming
convention for `style` attributes. The consequences were visible in the product:
two popover surfaces with different edges and different highlight fills, opened
from the same toolbar; four text inputs with four paddings and four focus
treatments; the connector icon map written out twice in two files; icons drawn
at **twelve different sizes and five stroke widths across two packages**, with
the sidebar taking its lock and overflow marks from Tabler while five other
files took the same two marks from Lucide. None of that was anybody's mistake.
Each one was written by someone who could not see the others, because nothing in
the repository showed them together. Tailwind was already installed and already
pointed at the tokens, and had **three utility classes in the entire renderer**:
the wiring was there and nothing had been built on it.

**Considered and rejected:** vendoring **Catalyst** — the Tailwind Plus kit —
the way Monad does, which is what AVA-14 proposed. Juno holds the licence and
Monad has 29 vendored Catalyst files behind its own wrappers, so the path is
proven inside the company. It does not carry across. Catalyst hardcodes `zinc`
for neutrals and `blue` for focus, and Monad's escape hatch for that (documented
in its `docs/catalyst.md` §5) is remapping palette steps in Tailwind v4's
`@theme` — Rally is on Tailwind **v3**, where that does not exist. Monad also
has two appearances where Rally has four, with translucent sidebars, painted
backdrops and per-component `cmp.*` tokens that Catalyst's flat `zinc` cannot
express. And Catalyst is Headless UI, which would run alongside the Radix
already here. The cost is a Tailwind major upgrade plus two headless libraries
plus a palette reconciliation, and it is expensive to reverse. What did carry
across is the part that matters — Monad's *contract*: a barrel as the only
import surface, thin wrappers so a backing stays swappable, a live explorer, and
a document stating the rules. That is what this change adopts.

Also rejected: putting the library in `packages/ui` for the desktop client and
the Ace admin Worker to share. Ace has not asked for it, and a shared package
whose second consumer is hypothetical is an abstraction for a second
implementation nobody has requested.

**Consequences:** the palette is *assigned* to `theme.colors`, so Tailwind's own
colour classes no longer resolve — `bg-zinc-800` is now a build error, which is
deliberate and will surprise anyone reaching for it. Three tokens were added:
`sys.color.border.hover` and `sys.color.border.focus`, which name the two ramp
steps the stylesheet had been reaching past the semantic layer for, and both
resolve per theme through Terra's aliases. Two visual changes were accepted
rather than preserved: the select's popover now wears the menu's surface
treatment instead of its own heavier one, and the connector tile's border is
named `border-line-subtle` instead of `ref.color.line.1` — the same pixels
either way. `Button` and `IconButton` deliberately did **not** move; 25 `app.css`
rules use those classes as context hooks, and converting them belongs in a diff
where that is the whole change. The Lucide legacy list in the ESLint rule is a
ratchet: it makes the invariant real for new code, and it must only ever get
shorter.

Design: `docs/PRDs/` — none; this landed from AVA-14 directly.

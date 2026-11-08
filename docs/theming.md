# Desktop appearance

Rally has one visual language with two appearances: light and dark. People can
follow the Mac setting or pin either appearance. There are no named theme
families, user-selectable designs, animated theme documents, or theme-specific
component branches.

The design-token JSON is the source of truth. Generated CSS exposes semantic
custom properties to the renderer, and application rules consume those
properties without knowing which appearance is active.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `config/design-tokens/registry.json` | Declares every supported token path, type, and meaning. |
| `config/design-tokens/base.json` | Every token that does not change with the appearance: geometry, type, spacing, and the absolute colours. |
| `config/design-tokens/base.schema.json` | Validates the base file. |
| `config/design-tokens/themes/light.json` | What the light appearance sets: the tokens that differ from dark, and its font declarations. |
| `config/design-tokens/themes/dark.json` | The same for dark. |
| `config/design-tokens/theme.schema.json` | Validates an appearance file. |
| `scripts/build-theme-assets.mjs` | Generates the renderer stylesheet and remote-font manifest. |
| `packages/ui/src/styles/themes.css` | Generated light and dark custom-property blocks. |
| `packages/ui/src/styles/app.css` | Component and layout rules expressed through semantic tokens. |
| `packages/ui/src/themes.ts` | The shared appearance preference, resolver, and initial window backgrounds; desktop common imports re-export it. |
| `packages/ui/src/lib/theme.ts` | Shared appearance, device preference, system appearance watcher, and the `theme-color` meta an iOS Home Screen app paints its status bar from. |
| `apps/desktop/src/renderer/lib/theme.ts` | Desktop native reporting and window synchronization adapter. |
| `apps/desktop/src/renderer/components/theme-picker.tsx` | The Appearance setting, drawn with the shared `SegmentedControl` from `components/primitives.tsx`. |
| `apps/desktop/src/main/theme-assets.ts` | The private cache for a remote font declared by an appearance. |
| `packages/contracts/src/palette.ts` | The palette keys and `PALETTE_INK` — which of the two absolute inks each fill carries, and the reasoning behind the rule that picks it. Which keys an appearance or a person may hold is in `spaces.ts` and `projects.ts` (storage names kept from before the Canvases pivot), which draw from it. |
| `packages/ui/src/lib/project-palette.ts` | `markColors()`, the pastel `project-tint`/`project-ink` pair a mark of a hue is painted in, and `glyphInk()`, resolving `PALETTE_INK` to the `palette-ink` token for the fills that have no pair. `apps/desktop/src/renderer/lib/project-palette.ts` only re-exports it. |
| `apps/desktop/src/renderer/styles/palette.css.node.test.ts` | Recomputes the table from the tokens, and pins the WCAG 2 shortfall and the APCA ties. |

## How it works

`ThemeChoice` is the scalar device preference `system`, `light`, or `dark`.
`system` resolves through `prefers-color-scheme`; the other two values resolve
to themselves. The renderer writes the result to `data-theme` on `<html>` and
the original preference to `data-theme-mode`. The generated stylesheet has one
block for `[data-theme='light']` and one for `[data-theme='dark']`; light is also
emitted on `:root` to make the first frame deterministic.

The preference is device-local. `theme.ts` writes it beside the other device
preferences and reports it to the main process. Main stores the scalar in
`application-settings.json`, uses its resolved value for a new BrowserWindow's
initial `backgroundColor`, and broadcasts changes so every open window repaints.
Every apply also writes that value into each `theme-color` meta the document
carries, which is what iOS 15 to 18 paint a Home Screen app's status bar from
and Chromium an installed app's title bar; `apps/browser/index.html` holds a
media-qualified light and dark pair so the paint before the script runs is
right for the `system` choice. The same document paints the canvas dark under
`prefers-color-scheme: dark` until `data-theme` is stamped, because the
stylesheet's unstamped root is light and the stamp waits on the module bundle.
iOS 26 reads the page instead of the meta: the
root element's own background, or a fixed container at the top edge. So `html`
paints `sys.backdrop.color` as `body` does; a root with no background of its
own is reported to read as transparent there, and the bar falls back to white.
A previous object-shaped preference is accepted only as a migration input: its
`mode` becomes the scalar preference and its former family value is ignored.

Every visual value originates in the token registry and either `base.json`,
which holds what does not change with the appearance, or one of the two
appearance JSON files, which hold only what differs between light and dark. The
build merges base under each appearance, so the generated stylesheet keeps one
shape: every block declares every token. `pnpm tokens:build` regenerates `themes.css` and
`common/theme-assets.ts`; `pnpm tokens:check` rejects drift. Bundled fonts are
addressed directly. If an appearance declares a remote WOFF2 URL, main fetches
it once, optionally verifies its integrity, stores it under `userData`, and
serves it through `rally-font://`.

## Invariants

- **There is one design and exactly two resolved appearances.** Adding a named
  theme family would restore UI and state the product no longer supports.
  Account-owned accent color is independent of this light/dark preference.
- **The account accent is seven tokens, and they are the only ones.**
  `html[data-personal-color]` rewrites the whole `sys.color.accent.*` group —
  `base`, `strong`, `soft`, `wash`, `edge`, `tint` and `on` — so a rule naming
  one of them paints in the member's own colour, not in chrome. The neutral
  value they hold is the unconfigured case, not the design, so check a
  screenshot against an account that has a personal colour set before believing
  one that does not. `cmp.row.background-selected` was an eighth until the entry
  below removed the re-point; a future accent that wants a row back gives that
  row a token of its own rather than re-pointing the one everything shares.
- **`system` is a preference, not a palette.** It must always resolve to light
  or dark before it reaches `data-theme`; otherwise the generated selectors do
  not provide a complete token set.
- **Renderer rules use semantic tokens.** A literal colour in `app.css` works in
  one appearance and bypasses the contrast decisions in the token files. A
  `mask-image` is the one place a literal colour is fine, and it is
  not really an exception: a mask is sampled for its alpha channel and never painted, so
  nothing in it can render wrong under the other appearance. Writing `#000`
  there means "fully opaque", and it is the honest spelling — `currentColor`
  would work while tying the mask's strength to whatever alpha the
  element's text token happens to carry.
- **An appearance file holds only what differs between light and dark.**
  Everything else is `base.json`, and `scripts/build-theme-assets.test.mjs`
  holds the line from both sides: the files partition the registry, both
  appearances set the same tokens, and a token both appearances set to the same
  value fails as a base token that drifted. Inheritance between appearances
  would otherwise make a missing dark value silently render with the light one.
- **Every token has a reader.** `themes.css.node.test.ts` fails a declared token
  that no source file names, no token file aliases, and no prefix reader covers.
- **A scrim that shows the backdrop takes its chrome's contrast with it.**
  `sys.color.scrim.veil` is `scrim.solid`'s colour at half strength and the two
  move together; re-fitting one without the other stops them reading as one
  material. The consequence is the part that gets missed: anything drawn on a
  half-strength wash — the lightbox's media controls, its gallery arrows and
  caption — can no longer take its contrast from the wash, so each carries its
  own opaque chip. A control added to that surface later needs one too.
- **Spacing is one number.** Every feed spacing token is a multiple of
  `ref.space.unit`, and `app.css` derives its `--space-N` steps from the same
  unit. The sidebar's `sys.space.group.gap` is the one spacing token off it,
  at the 14px its own entry argued for. The steps are declared on `:root`,
  which is safe only while the unit is a base token: an alias on `:root`
  resolves against the default appearance, so a unit set per appearance would
  leave a nested `data-theme` on the default's steps. The partition test is
  what keeps the unit in `base.json`.
- **The shell owns the canvas background.** Repainting the same image or
  gradient on nested panes creates seams when the sidebar and feed differ in
  size.
- **The main-process window background matches the canvas token.** A mismatch
  flashes the wrong colour before the renderer's first frame. It is set when a
  window is built and again on every change of appearance, a choice made in
  `theme:set-window` or the Mac's own under System (`repaintWindowBackgrounds`
  in `apps/desktop/src/main/window-background.ts`).
- **So do the root's own background and the `theme-color` meta.** iOS 26
  paints a Home Screen app's status bar from the page, the root's background
  or a fixed container at its top edge, and iOS 15 to 18 from the meta. A root
  with no background of its own, or a document without the tag or with a stale
  one, shows a white bar over a dark canvas. `html` paints `sys.backdrop.color`,
  `applyTheme` writes `themeWindowBackground` into every tag on every apply and
  adds none, and the browser entry's pre-script pair holds the same two values,
  as does its pre-script dark canvas rule.
- **A palette fill's ink is decided by APCA, not by the WCAG 2 ratio, and it is
  checked in.** `PALETTE_INK` is the table; sixteen of the nineteen fills take
  the near-white ink and `amber`, `lime` and `green` take the near-black one.
  The rule is deliberately not WCAG 2's, whose luminance curve misjudges
  saturated mid-tones, and the resulting shortfall against that standard is
  recorded rather than fixed — see the 2026-09-10 changelog entry for what is
  accepted and why.
- **A mark is painted in its hue's pastel pair, a person in the hue itself.**
  Conversation glyphs (`WorkstreamGlyph`), Sidekick hexagons and picker
  swatches take `project-tint` under `project-ink` (`markColors()`), themed per
  appearance, every ink at least 5.3:1 on its tint in light and 7.25:1 in dark,
  and each family at one OKLab lightness so no hue stands out.
  `palette.css.node.test.ts` holds both. A person's colour — avatar, presence,
  bubble, accent — keeps `project` at full saturation. `black` and the retired
  keys have no pair and keep their fill under `PALETTE_INK`.
- **Both palette inks are absolute.** A fill does not change with the
  appearance, so the ink over it must not either. `palette-ink-light`,
  `palette-ink-dark` and the fills themselves live in `base.json`, where an
  appearance cannot move them, and the `--personal-ink-*` pair swaps which
  neutral it points at precisely so that it does not invert.
- **A spacing token is re-fitted, never escaped per consumer.** When a shared
  value is wrong for one rule, the fix is the token or a decision written down
  beside the rule — not a literal on that one selector. Overriding each
  consumer in turn is what let `sys.space.group.gap` keep a retired theme's
  60px in the one place nobody had overridden; the value that survives that
  process is the one nobody argued for.
- **A rule that names a token is not proof the token reaches it.** Check for a
  shorthand later in `app.css` that shadows the longhand on the same element —
  `.sidebar-primary-actions` (`app.css:703`) names `sys.space.group.gap` and has
  never used it, because `.sidebar-secondary-actions` sets a `margin` shorthand
  at equal specificity further down the file.
- **The hover wash is layered over a control, never substituted for what it
  paints.** `app.css` spells it `--hover-layer`, a `background-image` derived
  from the token, and a hover rule sets that rather than `background`. A
  control with no surface of its own could take the wash as a
  `background-color` and composite correctly against its ancestor; one that
  paints its own surface cannot, because `background-color` replaces that
  surface. `.button` on `surface.raised` lost it and composited against the
  canvas, turning `#2f2f2f` into roughly `#1a1a1a` — the control went *darker*
  under the pointer. Layering makes the hover delta identical for every
  control, which is what one wash is for. It costs the fill's fade:
  `background-image` is discrete, so only border and text colour still
  transition.
- **There is one hover wash, and it is `sys.color.state.hover`.** Every neutral
  control a pointer can cross — a navigation row, a menu item, a header icon, a
  chip, a settings button — paints hover from that one token. Two kinds of rule are exempt and
  say so: a hover carrying a semantic hue, where the hue is the point, and a
  rule shared with a selected or pressed state, which is not a hover. The wash
  is translucent in **both** appearances on purpose — an opaque fill has to know
  what is behind it, which is how `sys.color.surface.raised` came to be a hover
  on the light canvas that *was* the canvas.
- **Elicitation hover uses the reader's accent.** The scoped row clears the
  generic brand background beneath its accent tint; its thin row divider stays
  visible on hover and selection.
- **A control's resting chip fill is `cmp.control.background-quiet`, not the
  hover wash.** They carry the same weight today and are still two tokens: the
  composer's round tools rest on the quiet fill and hover a step above it, so a
  single token would have collapsed their only feedback the moment either value
  moved.
- **Appearance files are data.** They cannot carry HTML or JavaScript, and the
  desktop registers no appearance-document protocol or iframe.

## Boundary

This module owns appearance preference, token definitions, token generation,
the renderer's CSS contract, and initial window colouring. Individual
components own their structure and choose semantic component tokens; they do
not own palettes. Application icons, member and connector brand colours, rich
attachment content, and exported message documents have their own presentation
contracts and do not become selectable Rally themes.

The private font scheme is an asset cache, not a theme execution surface. It
serves only generated, hash-addressed WOFF2 entries. The renderer cannot supply
an arbitrary URL to it.

## Failure modes and limits

- A missing or malformed preference falls back to `system`.
- A stored preference from the former object shape retains only its valid
  `mode`; an invalid mode falls back to `system`.
- A remote font response that is empty, exceeds 8 MiB, fails a declared SHA-256
  integrity check, or is not in the generated manifest returns 404 and leaves
  the UI on its fallback font.
- A token file that names an undeclared token, leaves a registry token unset
  between base and the appearances, restates a base token in an appearance,
  or sets a token to the same value in every appearance fails the token build
  or its tests.

## Testing

- `pnpm tokens:check` proves the committed generated files match the two JSON
  sources.
- `pnpm test:scripts` exercises the generator, schema, token completeness,
  aliases, font declarations, and structural token rules.
- `pnpm --filter @rally/desktop exec vitest run src/common/themes.test.ts src/main/theme-assets.test.ts src/renderer/lib/theme.test.ts src/renderer/components/theme-picker.test.tsx src/renderer/styles/themes.css.node.test.ts`
  covers preference migration, resolution, cross-window behavior, the picker,
  the font cache, and CSS invariants.
- `pnpm lint`, `pnpm typecheck`, and the proportional desktop suite remain the
  repository gates. A visible change must also be inspected in a real Electron
  window in both appearances.

## Security and trust model

Appearance JSON is build-time input and produces CSS plus a fixed font
manifest. It cannot execute code. The retired animated appearance-document
scheme and iframe are absent from the renderer CSP and Electron protocol
registration. Remote font URLs are not exposed directly to the renderer; main
serves only generated IDs and enforces the cache's size and integrity checks.

## Changelog

### 2026-11-08 — Every window's native background follows a change of appearance

**What changed:** Switching appearance, or the Mac switching it under System,
repaints every Rally window's native background, not only the next one built.

**Why:** The background was applied only in the constructors, so after Light
to Dark the area a live resize exposes stayed `#fcfcfc` beside a `#070707`
document (v3-G1); docs/e2e.md step 7 promises no flash of the other mode.

### 2026-10-18 — A dark phone no longer opens the Home Screen app on white

**What changed:** `apps/browser/index.html` carries an inline rule that paints
`html` and `body` `#070707` under `prefers-color-scheme: dark` while `html` has
no `data-theme`, with the light canvas colour as its ink.

**Why:** The stylesheet emits the light block on `:root` so the first frame is
deterministic, and `installTheme` stamps `data-theme` only once the module
bundle has downloaded and run. The stylesheet is in the head and arrives first,
so a dark phone painted the light canvas for as long as the bundle took. An iOS
Home Screen app reloads whenever iOS has evicted it, and the service worker
caches nothing, so on a phone network that showed as a white flash on most
returns to the app.

**Considered and rejected:** A blocking classic script in the head that reads
the stored choice and stamps `data-theme` early. The CSP allows no inline
script, so it would be one more request before first paint and a second parser
of the device preferences. Emitting the dark block under a media query for the
unstamped root from `build-theme-assets.mjs` would theme everything, not just
the canvas, but nothing else is on screen before the bundle runs, and it would
double the dark block.

**Consequences:** A choice pinned against the phone (Dark on a light phone, or
the reverse) still shows the phone's canvas until the bundle runs, as the
`theme-color` pair already does. `#070707` is a fourth copy of the dark canvas
and moves with `themeWindowBackground`. The ink is there because with
JavaScript off the stamp never comes, and the `<noscript>` notice would
otherwise be the light theme's dark text on the dark canvas.

### 2026-10-17 — The status bar follows the canvas in an iOS Home Screen app

**What changed:** `html` paints `sys.backdrop.color`, the colour `body`
already painted. `applyTheme` writes the resolved appearance's canvas colour,
`themeWindowBackground`, into every `theme-color` meta in the document, and
`apps/browser/index.html` carries a media-qualified light and dark pair so the
paint before the script runs is right for the `system` choice.

**Why:** On an iPhone in dark mode the Home Screen app showed a white status
bar over the dark canvas. iOS paints that strip itself. Through iOS 18 it took
the `theme-color` meta, and the browser entry had none. iOS 26 no longer reads
the meta at all: it takes the page's own colour, the root element's background
or a fixed container at the top edge (WebKit bug 305546, and the field reports
the bug's reporter and Apple's developer forum give). `body` painted the
canvas, which reaches the viewport by propagation, but `html` had no
background of its own, and a transparent root is reported to fall back to
white there. Both are set now, one per generation of iOS. A `media`-qualified
meta pair alone would follow the phone rather than the choice: the appearance
is pinned per device, so a person on Dark with a light phone would still get
the wrong bar. The apply step already tells the Mac main process what to paint
beside the page, and the meta is the same report to a different host.

**Considered and rejected:** `apple-mobile-web-app-status-bar-style:
black-translucent` with `viewport-fit=cover`, so the page draws under the bar.
Nothing in the client handles safe areas yet, the bar's text turns white in
both appearances unless the bar's colour is set anyway, and the home indicator
would need the same work. A 6 px fixed strip at the top edge in the canvas
colour, the workaround a Safari 26 note proposes for browser tabs, was
rejected as a hack that depends on scroll-driven animation and is untested on
iOS. Reading the canvas back through `getComputedStyle` at apply time was
rejected too: `themeWindowBackground` already duplicates the token and is
checked against the stylesheet, and a style read costs a recalc for nothing.

**Consequences:** On iOS 26 the bar shows whatever is fixed at the top edge,
so a fixed container there paints the canvas or nothing. At phone width the
navigation sheet is fixed at the top and paints `cmp.sidebar.background-solid`,
a step off the canvas, while it is open. An entry document that wants its host
told carries its own `theme-color` tag; `applyTheme` writes every tag it finds
and adds none. The pair in `index.html` is a third copy of the two canvas
values, beside `themes.ts` and the generated stylesheet, and moves with them.
None of this was verified on a device; the pull request records what was.

Shipped in #1277.

### 2026-10-13 — `sys.color.glass.shine` lights a glass shape

**What changed:** A new themed token, `sys.color.glass.shine`: white at 75% in
light and 16% in dark. `MarkBridge` paints its sheen and the rim along its top
edge in it ([`shared-ui.md`](shared-ui.md)).

**Why:** The highlight has to differ by appearance (full-strength white on a
dark surface reads as glare), and a value that differs by appearance is a
theme's to set, not a rule-local property in `app.css` overridden under
`[data-theme='dark']`. The first version did that, and the token-reference
test rejected it.

**Considered and rejected:** Reusing `sys.color.shimmer.default`. Its job is
a loading sweep, and in light it is near-black at 5%, not a highlight.

**Consequences:** A theme that wants flat glass sets this to `transparent`.

Shipped in #1203.

### 2026-10-02 — Marks take a pastel pair; people keep the hue

**What changed:** Two themed token families, `sys.color.project-tint.<key>` and
`sys.color.project-ink.<key>`, give each of the fourteen ring hues a pastel
background and the icon on it, in light and dark. `markColors()` resolves a key
to that pair, and every mark draws from it: Channel and Breakout glyphs and
bare marks, Sidekick hexagons, Space icons, and the appearance picker's swatches
(the tint with an ink dot) and icon strokes. People's colours are unchanged.

**Why:** The full hues as solid fills were loud in a sidebar of forty rows, and
asked for a calmer set. The pairs were chosen as a set: one lightness and
chroma per appearance, so no hue stands out, and every ink clears body-text
contrast on its tint (5.3–5.9:1 light, about 7.3–7.4:1 dark), which the APCA
table for the full fills could not promise. People were left saturated on
purpose: a person's colour is how they are told apart at a glance, and it is
their own choice.

**Considered and rejected:** Retuning `sys.color.project` itself. That token is
also every person's colour, so it would have muted people along with marks.

**Consequences:** Stored keys are unchanged; only drawing changed. `black` and
the retired keys have no pair, so a mark that still stores one keeps its old
fill under `PALETTE_INK`, which therefore still governs those and every person.
A new ring hue needs both pairs in both appearances, and the palette test will
fail until it has them.

### 2026-09-25 — `cmp.row.hint-gap` is retired

**What changed:** the token is gone from the registry and the base theme. Its
last reader was the sidebar's placeholder row, which now centres its title and
activity bars in the real row's 20px and 16px line boxes rather than spacing
them with a gap.

**Why:** the real two-line rows do not read it; they lay out their lines by
line-height alone. When they stopped was not recorded. The token only kept the
placeholder a different shape from the row that replaces it. A token with no
reader is a theme knob that moves nothing, and `themes.css.node.test.ts`
refuses one. A theme that needs that spacing back should add it to the real
row first, and give the placeholder the same reader.

### 2026-09-21 — Elicitation hover belongs to the reader

**What changed:** the hover over an elicitation option now layers a half-strength
`sys.color.accent.tint` over its existing surface. The tint resolves from the
signed-in reader's chosen profile colour; halving its 20% alpha gives the hover
a 10% personal-colour wash without replacing the option's own fill. Its resting
surface, selected fill, keycap, checkbox and focus outline are unchanged.

**Why:** elicitation is the point where Rally is explicitly asking this reader
to act. The product-wide neutral hover wash made that choice row read like
ordinary chrome and ignored the colour the reader chose for their controls.
This is a deliberate semantic exception to
the shared neutral hover: the personal wash appears only under the pointer and
does not re-point `cmp.row.background-selected`, so persistent selection and
unrelated rows remain neutral.

**Considered and rejected:** restoring the old account-level rewrite of
`cmp.row.background-selected`. That token still serves selections, chips,
controls and other borrowers that have no claim to personal identity. Also
rejected: filling the row with `sys.color.accent.wash`. That token is opaque and
mixed against the canvas, so in dark appearance it discards the option list's
lighter surface and makes hover look recessed. Layering the transparent accent
tint keeps the exception local and preserves the existing option surface in
both appearances.

### 2026-09-19 — The lightbox stops hiding the window it covers

**What changed:** `sys.color.scrim.veil` is new — `scrim.solid`'s colour at half
opacity — and `.attachment-lightbox-overlay` takes it, with its blur raised from
1px to 6px. Both lightboxes read that rule: the attachment preview and the
inspector's resource lightbox. Everything the media viewer draws on that overlay
— the close, download, details and expand controls, the gallery arrows and the
caption — now carries an opaque chip, a preview image gets the surface colour
under it, and `prefers-reduced-transparency` restores the old opaque wash.

**Why:** asked for. The overlay took `scrim.solid`, which is `0.98` in both
appearances and opaque in practice, so opening a preview replaced the window
rather than covering it — a person lost where they were, and nothing behind the
dialog said what it belonged to. The 1px blur beside it had never drawn
anything, because there was nothing visible left to blur; raising the radius
without thinning the wash would have been the same no-op.

**What thinning the wash cost, and what it taught:** a wash that is opaque in
practice is load-bearing for everything drawn on it, and none of those rules say
so. The media viewer paints no surface of its own: its controls were
`background: transparent` with muted ink, legible only because the wash behind
them was effectively `surface.default`. At half strength their contrast follows
whatever the window shows — review measured 4.84:1 to 1.48:1 in light, 7.84:1 to
1.55:1 in dark, worst case, with the close button, the only way out of a
full-window viewer, the most exposed. A blur does not save them: it
redistributes detail and preserves local mean luminance. The same held for an
image with an alpha channel, which had been compositing against that wash and
would otherwise have shown the live window through its transparent parts. The
rule to carry forward is in **Invariants**: a control added to this surface
brings its own chip.

**Considered and rejected:** `color-mix()` on `scrim.solid` in the rule. It reads
the same on screen and puts a number that decides an appearance back into
`app.css`, where a theme cannot reach it — the thing the registry exists to
prevent. Also rejected: reusing `scrim.default`, which is a *darkening* scrim in
both appearances (`0.34`/`0.72`) and would tint the light appearance grey rather
than wash it with the surface colour. For the chrome, rejected: the translucent
`scrim.default` chip the gallery arrows already had. Review offered it as the
existing pattern, and it is the wrong one — it is translucent too, so its
composite tracks the backdrop just as the bare control did, which is why the
arrows are in the list being fixed rather than the example being followed.

**The two preferences are not interchangeable.** The blur was cancelled under
`prefers-reduced-motion`, which never made sense — a static blur does not
move — and never mattered either, because cancelling a blur behind an opaque
wash changes nothing. Against this wash it would have mattered in the worst
direction: the reader who asked for calm would have been the only one looking at
a sharp, legible window through a half-transparent veil, with unbacked chrome
floating over sharp content rather than smeared content. That block is gone.
`prefers-reduced-transparency` is the preference that describes this surface,
and it now restores the full-strength wash and drops the blur together — the
pair is the invariant, since sharp *and* see-through is the one state neither
preference asks for. Rejected: pairing the old reduced-motion block with
`scrim.solid` instead, which would have left reduced motion as a second design
of this surface rather than the same one.

**Consequences:** `veil` and `solid` are the same colour at two strengths and
have to move together. The media chrome hovers on the product's one hover wash
layered over its chip; the gallery arrow used to hover to `scrim.solid`, which
was the overlay's own colour, so hovering dissolved the chip into the backdrop —
that pairing broke the moment the two tokens diverged and is now gone.
`app.css.node.test.ts` fails on a rule that cancels the blur without also
restoring the wash, on a media control that gives up its chip, and on an image
that loses its surface.

### 2026-09-19 — One hover wash for the whole product

**What changed:** `sys.color.state.hover` is new and is now the only fill a
neutral hover may take; 46 rules moved onto it. `cmp.row.background-hover` is
retired into it, and `cmp.control.background-quiet` is new for the five places
that used that value as a control's *resting* chip fill rather than as a hover.
`app.css.node.test.ts` gained a sweep that fails any future `:hover` or
`[data-highlighted]` rule painting a neutral surface fill.

**Why:** hover was spelled seven ways — `surface.raised`, `surface.raised-hover`,
`surface.elevated-hover`, `surface.subtle`, three steps of the neutral ramp, and
the sidebar's own row token — and which one a control got was an accident of
when it was written. `surface.raised` was the worst: it is a step above the
canvas only in dark, and light sets it to the canvas's own `#fcfcfc`, so the
work-stream header's icons had no visible hover at all while the title button
beside them lit up. Fixing only those three would have left the same trap set
for the next control, and left one bar hovering at four different weights.

**Considered and rejected:** darkening light's `surface.raised`, which is also
the fill of menus, dialogs, cards and the segmented control's chosen pill — all
meant to be white against a white canvas and separated by their border. Also
rejected: pointing everything at `cmp.row.background-hover`, which has the right
value but names a row, so an icon button reading it is the component tier
leaking into the system tier.

**Consequences:** the wash is applied as a layer (`--hover-layer`), not as a
fill, so a control keeps whatever surface it already paints and the hover delta
is the same everywhere. The first revision of this change substituted it, which
made every control with its own opaque surface go darker under the pointer in
dark; Codex caught it on review. The cost of the layer is that
`background-image` is discrete, so the fill no longer fades over the 120-140ms
the transitions declare — border and text colour still do, and a hover that
lands instantly was judged better than one that lands on the wrong colour. The
wash is translucent in both appearances, so one value works on the canvas, in a
menu and inside a dialog; an opaque fill cannot, and
that is the property to preserve if either number is re-fitted. Light hovers at
`0.09` and dark at `0.17` — the sidebar's existing weights, unchanged, so the
sidebar is the reference anything else should be compared against. Controls that
used to hover heavier than that are now lighter: the work-stream title button
and `.icon-button` both dropped from `0.17`, which is deliberate and is what
makes the top bar read as one family. Two dark restatements that existed only
because light and dark disagreed about hover — the account menu's highlighted
row and the composer capsule's tool buttons — became no-ops and were deleted.
`.grokbot-computer-button` had folded hover and `aria-pressed` into one
declaration; pressed keeps the heavier `surface.elevated-hover`, because it has
to hold once the pointer leaves and the wash is deliberately too light for that.

**What it does not fix:** the mention popover and the new-chat recipient list
still draw hover from `cmp.row.background-selected`, so a hover in either still
carries a selection's weight. The 2026-09-11 entry below raised this and pointed
them at `cmp.row.background-hover`, which this change retires; the fill they
want now is `sys.color.state.hover`. 
`cmp.control.background-quiet` and `sys.color.state.hover` hold the same value
today, so a control that rests on the first and hovers on the second gets its
step from the wash being *layered* over the resting fill, not from the two
numbers differing. That is worth knowing before either is re-fitted: review of
this change twice read the shared value as meaning those controls have no hover
feedback at all, which was true only of the revision that substituted the wash
instead of layering it. The agent question's Skip button is the case to check —
it rests on the quiet fill and takes `.button`'s hover. The collapsed sidebar's
search pill is not, despite looking like it: `app.css` resets it to
`transparent` in the compact rail, so it never rested on the quiet fill there.

### 2026-09-18 — Share theme presentation between desktop and browser

**What changed:** The shared UI package owns generated/component styles, bundled
fonts, the Rally mark, and theme definitions. The generator and desktop use those
files, and the desktop main bundle includes the shared theme definitions.

**Why:** Adding browser collaboration would otherwise copy desktop styles and
assets into a second independently maintained tree. One package keeps appearance
changes together; host-specific preference storage and native reporting stay in
the desktop runtime. Asset URLs must resolve inside the shared package, and
shared package changes must trigger desktop release planning.

**Considered and rejected:** A separate browser stylesheet would drift; a shared
runtime that calls Electron would break browser startup.

**Consequences:** New tokens and appearance changes update the shared source,
not the desktop import wrappers. Native window synchronization remains desktop-only.

### 2026-09-16 — One saturated success step for the status dot

**What changed:** `sys.color.success.vivid` is a new token, the one saturated
step in the success role: `#1fa85c` in light, `#34d276` in dark. The healthy
dot beside a connection in Settings draws it, with a two-pixel halo at 28% of
the same colour. Nothing else moved off `success-base`.

**Why:** `success-base` is a sage tuned for text and fills — `#7fae97` in dark
— and at seven pixels on the dark surface it read as grey. An administrator
looking at the connections table could not tell a healthy connection from a
disabled one without reading the badge, which is the one job the dot has.

**Considered and rejected:** Brightening `success-base` itself, which would
have shifted every success text and fill in the product for the sake of one
dot. Making the dot larger, which changes the row's rhythm and the alignment
of every table that uses it. A hard-coded hex in the stylesheet, which a theme
could not override and `tokens:check` could not see.

**Consequences:** A theme that wants a quieter table sets `vivid` closer to
`base`; the dot still reads because the halo carries the same colour. The
automation status dot and the presence dot still draw `success-base`, and this
token is where they go if the same complaint reaches them.

### 2026-09-11 — A mask is not a colour

**What changed:** `themes.css.node.test.ts` reads the property name alongside
the value and skips exactly `mask`, `mask-image` and their `-webkit-` spellings
when it looks for literal colours in `app.css`. The `Invariants` bullet above
records the exemption. The guard's own self-check gained cases for a mask that
is let through, the same gradient on `background-image` that is not, a
`-mask`-suffixed custom property that is *not* exempt, `mask-composite` which is
not a mask image, and three custom-property spellings that stay in scope.

Both halves of the pattern were corrected after review. The exemption is
anchored at both ends: an unanchored `-mask` suffix also exempted
`--overlay-mask` and anything else named that way, and a custom property is
painted wherever it is substituted, so that spelling would have handed a literal
colour a way *out* of the guard rather than describing a mask. And the property
capture is `[\w-]+` rather than a lowercase class: keying on the colon alone had
seen every declaration, and the narrower class silently dropped `--BRAND` and
`--Brand_Color` out of the scan entirely.

**Why:** The navigation and work-stream rails now fade a line they cannot fit
rather than ellipsizing it, and the mask that does it needs one fully opaque
stop. A mask is never painted; the compositor takes its alpha and discards the
rest, so a colour written into one cannot look right in one appearance and wrong
in the other — which is the entire failure this guard exists to catch. Leaving
the guard as it was would have forced `currentColor` into the gradient instead,
which passes a blind check but makes how much of the line survives the mask
depend on the alpha of whichever text token the line inherits: a real defect
traded for a clean test. See
[`conversation-surfaces.md`](conversation-surfaces.md) for the fade itself.

### 2026-09-11 — The tooltip rejoins the neutral ramp and stops reading warm

**What changed:** Four values in the two appearance files.
`cmp.tooltip.background` and `cmp.tooltip.foreground` were literals —
`#efe8dc`/`#17130d` in dark and `#2a241d`/`#f7f3ec` in light — and are now
`{ref.color.neutral.13}` and `{sys.color.text.on-inverse}` in both. They resolve
to `#eeeeee` on `#141414` in dark and `#2f2f2f` under `#fcfcfc` in light, so the
lightness barely moves and only the hue goes. `.tooltip-arrow` already filled
from the background token and follows for free. The registry's `cmp.tooltip`
note, which asserted the surface "cannot be a ramp step in either", is rewritten
because that premise was wrong and was the reason the literals were there.

The ink is the system's, not a ramp step, because `sys.color.text.on-inverse`
already exists for exactly this job and every other inverted surface reads it —
`.meeting-start-button`, `.rally-mention-icon`, the pressed sidekick filters, the
automation check. A ramp step there would have duplicated it and, in dark, sat
one step off it, which is this same entry's bug moved up a layer.

**Why:** `#efe8dc` is a warm beige — hue about 38°, saturation about 37% — and
the entire reference ramp it sits against is hueless, `R === G === B` at every
one of its fourteen steps. The chrome around it is hueless too: pane, sidebar,
bubble and composer are greys that land on ramp steps, and the keycap is a grey
`rgba()`. (They are literals that coincide with the ramp rather than aliases of
it, which is its own untidiness and not this entry's.) So the tooltip was the
one surface in the chrome carrying a colour cast, which is what made it read as
wrong rather than merely light. The opposing-surface intent behind the literals
was right and is kept; the reasoning that it forced a literal was not. The ramp
inverts with the appearance, so a single alias in both files is already
light-on-dark and dark-on-light, and the opposition now comes from the palette
rather than from two hand-picked colours that nothing keeps in step with it.

**Consequences:** the huelessness is now checked, by
`a surface held to the neutral ramp carries no hue in any appearance` in
`scripts/build-theme-assets.test.mjs`. It resolves each path in
`HUELESS_SURFACES` through its aliases and fails on any cast, in either
appearance. That test exists because the obvious candidate does not do this job:
the partition guard beside it — `a token every appearance agrees on is a base
token` — compares the appearance files' raw JSON *text* and only calls a value
agreed when every alias in it resolves in `base.json`. A per-appearance colour
is two different literals, so it slips past on the text alone; run against the
original `#efe8dc`/`#2a241d` that guard stays silent, which is how this survived
as long as it did. Anything that stops being warm should join `HUELESS_SURFACES`
in the same change, or the sweep that neutralised it can quietly come undone.

**Considered and rejected:** Picking a fresh neutral literal at the same
lightness. It renders identically today and puts the value back somewhere
nothing connects to the ramp, so the next palette move walks away from it again
— the check above would now catch the hue, but not a neutral literal that later
drifts. Also rejected: sweeping the other warm groups in the same change.
`cmp.toggle.*` (two values), `sys.color.syntax.*` (ten per appearance) and
`sys.color.scrim.*` all carry a cast from the same earlier palette, and the
scrim is the one that matters most on screen — `scrim.solid` is a warm off-white
in light, painting the full-window `.attachment-lightbox-overlay` against a
hueless canvas, where a cast reads more strongly than it does on a tooltip. Each
is its own contrast decision rather than a rename, and none was what this change
set out to fix. **Do not read that list as complete**: it is what a scan of the
appearance files turned up, and the first version of this entry claimed
`cmp.toggle.*` and `sys.color.syntax.*` were the only survivors, which was wrong
twice over — the scan matched `#rrggbb` only, so every `rgba()` token, the scrim
included, was invisible to it. A sweep should re-derive the list over both
notations rather than trust this sentence.

Also rejected, for the fill: `sys.color.surface.inverse-hover`, which holds
`#eeeeee`/`#2f2f2f` — the same two values this now resolves to. Pointing at it
would read as the system token for an inverted surface and would not be one. It
is a *hover* state, and a tooltip has no rest to hover from, so the tooltip would
inherit any future change made to how an inverted control responds to a pointer
— a coupling as arbitrary as the literal, and harder to see. The token that
should exist is a resting `sys.color.surface.inverse`; the system has none, which
is also why the inverted controls in `app.css` take their resting fill from
`sys.color.text.default`, a text token used as a background. Adding that sibling
— `inverse` at `{ref.color.neutral.14}`, `inverse-hover` re-pointed to
`{ref.color.neutral.13}`, which it already equals — would give the tooltip and
those four rules one pair to share, and is the change this entry would rather
have made. It is left undone because it moves the tooltip's own lightness and
re-points controls this change had no reason to touch, which makes it a design
decision rather than a rename.

### 2026-09-10 — The feed's byline is one size and two weights

**What changed:** `cmp.feed.author.font-size` and `cmp.feed.author.font-weight`
become `cmp.feed.byline.font-size` and `cmp.feed.byline.author-weight`, the
author weight moves from 470 to 500, a third token `cmp.feed.byline.time-weight`
joins them at 420, and `sys.font.size.author` leaves the registry with the one
rule that read it. The feed's name and time now take one size and one pair of
greys for every speaker, and the context label between them takes that size
too.

**Why:** the token names described who was speaking rather than what was being
drawn, and that framing is what licensed a second pair of rules under
`.agent-message` — the small capitals and 0.7 opacity from
[the 2026-08-19 type-scale entry](#2026-08-19--the-type-scale-became-themeable-and-airy-went-larger-and-lighter),
which reused the navigation's label properties on Rally's name. That reuse was
right while the author label was the only thing in the line; it stopped being
right once the line also had to carry a timestamp, because the two then read as
different kinds of object stapled together. `sys.font.size.author` was left with
no reader at all, which the token-completeness test would have failed.

**Consequences:** a theme that wants the byline to read differently changes the
three `cmp.feed.byline.*` values, and gets both speakers. One size and two
weights is the whole vocabulary, because the line is one object and what
separates who from when inside it is weight rather than size. No theme can now
make Rally's name letterspaced capitals and a person's not, which was possible
before and was never a distinction anybody asked for.

**This supersedes one clause of [the account-accent entry
below](#2026-09-10--the-account-accent-colours-marks-and-controls-and-fills-no-row),
which stands as written otherwise.** That entry lists "the author name" among
the things taking a palette fill directly, and it did. It no longer does:
`--person-accent` reaches no text at all now, painting the message dot alone,
while the name takes `sys.color.text.subtle` against the time's
`sys.color.text.muted`. The reasoning is that entry's own, applied one step
further — a name is not a fill either, and colouring it by identity is what made
the two speakers' bylines diverge. The avatar and the person's own bubble are
unaffected and still take the fill.

### 2026-09-11 — Tooltips clear every lightbox, and a pressed icon opts in

**What changed:** Tooltips take `z-index: 1005` under
`body:has(.attachment-lightbox)`, the class the media, document and artifact
viewers all carry. An icon button marked `.icon-button-toggle` and
`aria-pressed="true"` takes the row-selection wash. The media viewer's own
controls reach for `Tip` directly rather than becoming `IconButton`s.

**Why:** A lightbox sits at `z-index: 1001` and `.tooltip` at 1000, so every
tooltip inside one opened underneath it: present in the DOM, findable by a test,
and invisible to anyone hovering. That went unnoticed until these surfaces
became icon-only chrome, where the tooltip is the control's only name. The
pressed state is a second gap of the same kind: `.icon-button` had never been a
toggle, so a toggled one looked exactly like an untoggled one, and the raised
fill hover uses is the same colour as the surfaces some of these headers sit on.

**Considered and rejected:** Raising `.tooltip` globally. The stacking above it
is a set of deliberate pairings, and a global bump moves tooltips over surfaces
nobody has looked at them against. Also rejected: keying the pressed wash on
`aria-pressed` alone, which was the first shape of this and reached buttons that
carry the attribute without being visual toggles — the composer's dictation
button wears it through `transcribing` and `finalizing` while painting itself
from `.microphone-control.is-listening`, and picked up the wash in the states
that class does not cover. The opt-in class keeps the paint where it was meant
and `app.css.node.test.ts` now refuses any rule that claims every pressed icon
button.

**Consequences:** A new surface layered above 1001 needs its own tooltip rule
until someone builds a real stacking scale; the rules under that `:has()` are
the list to add to. A toggle asks for its paint by class, so `aria-pressed` on
its own stays a semantic, not a visual, decision.

### 2026-09-10 — The grouped list is an unscoped primitive

**What changed:** The inset hairline grouping the shell draws around a set of
rows is now `InsetSurface` in `primitives.tsx`, backed by an `.inset-surface`
rule that carries no `.app-shell` ancestor.

**Why:** Every rule the GrokBot rewrite added hangs off `.app-shell`, and a
Radix portal mounts on `document.body`, outside it. That is invisible until a
surface renders through one: the live-artifact detail moved into the resource
lightbox on 2026-09-04 and silently reverted to the pre-rewrite look, drawing
outlined buttons as a tab strip and a bordered card per error, because none of
the shell's rules could reach it. Scoping to the shell was never a decision
about which surfaces get the design; it was a way of keeping the rewrite off the
old surfaces while it landed, and a portal is not an old surface.

**Considered and rejected:** Adding `.app-shell` to the lightbox, which would
pull all eighty scoped rules into every dialog that portals, most of which have
never been looked at in that context. Also rejected: giving the artifact detail
its own bordered-card rules, which is how a second visual vocabulary starts.

**Consequences:** A new portal surface can reach for this rather than inventing
a bordered box. It must stay unscoped, which `app.css.node.test.ts` now asserts,
because scoping it silently returns every portal to the old look with nothing
failing. The rules the shell still
scopes (`.elicitation-options` among them) are unchanged: they are the same
treatment with component-specific values, and generalising them was not worth
re-QAing a surface this change had no other reason to touch.

### 2026-09-10 — Recording fills with danger; the microphone stops wearing the account accent

**What changed:** Two rules in `app.css`, no token movement. The composer's
dictation button while `is-listening` is now a filled danger control —
`sys.color.danger.base` under the glyph, `sys.color.danger.on` over it, the
same pairing `.button-danger` uses — replacing a red glyph plus a 4px pulsing
`::after` dot. At rest in the message capsule it takes
`cmp.row.background-hover`, the fill its sibling icon buttons already take,
where it used to take `cmp.row.background-selected`. The capsule's two resting
paint rules gained `:not(.is-listening)`, and their geometry (radius, 28px box)
split into a rule that stays unconditional. Send and the microphone no longer
share a paint rule: Send keeps `cmp.composer-send.*` and the microphone is
neutral at rest in both appearances, so the `[data-theme='dark']` rule that
restated the microphone's fill is gone rather than duplicating tokens that
already resolve per appearance.

**Why:** Two separate faults, one of them only visible to an account with a
personal colour. `cmp.row.background-selected` is one of the seven tokens
`html[data-personal-color]` rewrites, so the microphone was the single control
in the composer painted in the member's own accent — reading as *selected* when
nothing had selected it, and as personal when it is chrome. Nothing about a
microphone is a member identity; the sibling attach and mention buttons were
already on the neutral hover fill and are what it should have matched from the
start. The recording signal was the second fault: the capsule's fills out-specify
the state rule by two classes, so `is-listening` lost its red glyph there and a
recording button was an idle button wearing a dot. Filling is the stronger
signal at 27–28px anyway, and the dot could not survive the fill — drawn in the
same danger red on top of it, it is invisible — so it goes rather than being
recoloured into a white speck.

**Considered and rejected:** Out-specifying the capsule from the state rule, by
naming the capsule's own classes inside it. That puts shape knowledge in
a state rule and grows every time a third composer shape appears; scoping the
shape rules to `:not(.is-listening)` instead leaves exactly one rule painting a
recording button, and the shapes describe rest only. Also rejected: a near-white
ink over the fill in both appearances. `danger.on` is dark in the dark
appearance because `danger.base` is a light salmon there, and picking the ink by
hand would be the palette's absolute-ink rule applied to a semantic fill, which
is not what that rule is for. The consequence a future change has to accept is
that recording is unmistakably red only in light; dark gets the app's dark-mode
red, which is the same red every other danger surface uses.

**What a future change has to respect:** a control that is not selected does not
read `cmp.row.background-selected`, whatever it looks like in a screenshot taken
by an account with no personal colour set. When this was written that token was
also re-pointed to the account accent, which is how a microphone ended up
wearing a member's colour; the entry below has since removed the re-point, so
the fill is neutral for everyone and the remaining reason stands on its own —
the button is chrome, not a selection.

### 2026-09-10 — The account accent colours marks and controls, and fills no row

**What changed:** `onboarding.css` no longer re-points
`cmp.row.background-selected` under `html[data-personal-color]`, in either
appearance. Row fills are neutral for everyone: the selected sidebar row, the
current substream, the selected option, the automation tile, both hover states
and the composer's mention chip and dictation button. The accent keeps the
`sys.color.accent.*` group, so links, marks, checkboxes and the controls that
resolve through it are unchanged, as are the avatar, the person's own bubble and
the author name, which take a palette fill directly and never went through this
token. The keycap split from the entry above stays.

**Why:** The re-point was written for selection, and for selection it reads
well — the row this reader picked, in this reader's colour. But
`cmp.row.background-selected` is a *fill*, and only about half of what reads it
is a selection: an inline mention chip in the composer, the dictation button's
resting state, two hover rules, and the letter beside an option all took the
accent because they wanted that value, not because anyone decided they should
carry somebody's identity. The keycap was split off first; splitting the other
four the same way would have meant four more names to keep the accent on the
half that had a claim to it, and that is more vocabulary than the effect was
worth. Removing the re-point is one deletion and leaves no borrower behind.
A future accent that wants a row back should give that row a token of its own
rather than re-point the one everything shares, and `palette.css.node.test.ts`
now fails if this one comes back.

**What it does not fix:** the two hover rules still draw from
`cmp.row.background-selected` rather than `cmp.row.background-hover`, so a hover
in the mention popover and the new-chat recipient list still carries a
selection's weight. That is a separate reading of the same rules and was left
alone here.

### 2026-09-10 — A keycap takes its own fill, not the selected row's

**What changed:** `cmp.keycap.background` is a new token — the neutral fill a
keyboard-shortcut chip is printed on, at the value the selected row already
resolves to in each appearance (`rgba(119, 119, 119, 0.17)` light,
`rgba(119, 119, 119, 0.32)` dark). The letter chips in an agent question's
option list (`.app-shell .elicitation-option > kbd`) draw from it instead of
from `cmp.row.background-selected`. Nothing moves for a reader with no account
accent: the two tokens hold the same value, and the chip renders exactly as it
did.

**Why:** `onboarding.css` re-points `cmp.row.background-selected` at the
signed-in person's accent under `html[data-personal-color]`, which is the right
answer for a *selection* — a row this reader picked, drawn in this reader's
colour. A keycap is not a selection. It is a static label saying which key
answers this option, and it borrowed the selection fill only because the value
was the one wanted. So an account accent of `blue` printed A, B, C, D on pale
blue chips, and every other accent printed its own; the letters read as
somebody's colour rather than as keys. Splitting the token is what makes that
structural: the accent can keep re-pointing selection wherever selection is
drawn, and a keycap is no longer collateral. The value is duplicated rather than
aliased on purpose — an alias resolves to `var(--av-cmp-row-background-selected)`
in the generated stylesheet, which is the tint again. Two other keycaps
(`.new-chat-recipient-shortcut kbd`, `.rally-search-result kbd`) still name
their own fills and were left as they are; this token is where they should land
when either is next touched.

### 2026-09-10 — The turn gap closes onto the hover row

**What changed:** `sys.space.stack.gap` is `{ref.space.unit}` (4px, was
`calc({ref.space.unit} * 8)`), written the way `sys.space.row.gap` is. The
registry gains `sys.space.seam.gap` (`* 8`, 32px) for the row after a stretch
of transcript this client has not loaded, which had been taking the turn gap
as its default. The `sys.space.stack` description says only what the token
sits between, the way its siblings do, rather than carrying the value and its
rationale.

**Why:** The rhythm entry of the same date in `conversation-surfaces.md` has
the measurements and the steps the tuning took. The token side is three
things. The turn gap stays on the unit rather than becoming a measurement of
the hover row, which is not a token. It now sits under `sys.space.event.gap`
and `sys.space.block.gap` by tuning rather than by relation: the three sit
between different things and were tuned separately, and the next tuning of
any of them should not move the others. And the seam is its own token rather
than a reuse of the block gap, because it sits between two rows that are not
adjacent, which is not what any other gap means; it keeps the value the turn
gap had so that a seam reads as it did before this change. The stack
description was trimmed on review: a group description that states the
current value goes stale the first time the number moves, and the changelogs
already hold the rationale.

### 2026-09-10 — The appearance picker gives up its private strip

**What changed:** `ThemePicker` renders `SegmentedControl` instead of its own
`.settings-theme-modes` markup and CSS. The shared strip is a pill track with a
flat raised fill on the chosen segment, no borders, and a roving tab stop.

**Why:** Appearance and the connections filter were the same control drawn
twice, and had drifted into different corner radii, different track fills and
different ARIA. The selected segment also carried a border inside its own
padding, which is why it needed a second padding rule to stop the strip from
shifting when the choice moved; a fill-only selection has nothing to give back.

**Considered and rejected:** A shadow under the chosen segment, which is what a
raised pill usually gets. `sys.elevation.shadow.sm` is `none` in both
appearances — this design separates a raised surface from the one behind it by
fill — so a shadow here would have been the first literal of its kind in the
stylesheet.

**Consequences:** The appearance strip has no styles of its own. A change to how
an exclusive choice looks is a change to `.segmented`, and it lands on every
strip at once.

### 2026-09-10 — Base tokens leave the appearance files, dead tokens leave the registry

**What changed:** Three things to the token set and one to the stylesheet's
class vocabulary. `config/design-tokens/base.json` now holds every token whose
value does not change with the appearance (sizes, radii, spacing, type, the
markdown scale, and the absolute colours: the palette fills, the two inks over
them, the brand ramp, `text.on-media`, the bubble's foreground and edge);
`light.json` and `dark.json` hold only what differs, and set the same keys. The
build merges base under each appearance, so `themes.css` keeps its shape, and
nothing falls through from the default appearance any more: a key one file
sets and the other does not is a failure, not light's value. `base.schema.json`
takes the token grammar from `theme.schema.json` by `$ref` rather than
restating it.
Twenty-four tokens nothing read are gone: `cmp.turn.align/margin/width`, the
sixteen `cmp.connector.*` fills, `sys.color.success.on`, `warning.strong`,
`warning.on`, `sys.space.pane.padding` and `sys.font.family.display`, with their
three empty groups. Eight single-read spacing aliases are gone too, replaced in
`app.css` by the `--space-N` step they restated: `cmp.bubble.padding`,
`cmp.feed.padding-x` and `-y`, and the five `cmp.markdown.*-margin` and
`cell-padding` tokens; `sys.space.row.gap` and
`cmp.markdown.list-indent` are now unit multiples (4 and 24); `sys.space.group.gap`
keeps the 14px the sidebar entry of the same date argued for, the one spacing
token off the unit, and lives in `base.json` like the rest.
`.grokbot-shell`, the class the shell's rules hang off, is `.app-shell`.
Three tests were added: the base/appearance partition guards in
`build-theme-assets.test.mjs`, and "every token has a reader" in
`themes.css.node.test.ts`.

**Why:** A count after the spacing change found 114 tokens identical in both
appearances, 65 tokens `app.css` never reads (24 with no reader anywhere), and
67 read exactly once. Identical values in two files can only ever differ by
mistake; `base.json` makes "this does not vary by appearance" structural, which
is what this document had been stating in prose for the palette inks. The merge
happens in the build rather than by emitting base on `:root` because an alias
declared on `:root` is substituted there: a base token pointing at an appearance
token would carry the default appearance's value under a nested `data-theme`,
the Settings miniatures being exactly that element; the build script's comment
on whole blocks already records the hazard. The dead connector fills were left
behind when connector marks moved to masks painted in `currentColor`; the
turn-alignment trio and `sys.font.family.display` were read by themes that no
longer exist. The spacing aliases were kept in the previous change on the
reasoning that a theme might move markdown margins independently of prose; that
reasoning was Air's, and Air is gone, so a token read once that restates a step
of the scale is a name with no second reader. `.grokbot-shell` named a theme in
a product that has one design; the rename says what the class is rather than
where its numbers came from, and the changelog entries that describe the GrokBot
reference keep their history.

### 2026-09-10 — Spacing tokens derive from one unit

**What changed:** The registry gains `ref.space.unit` (4px in both appearances)
and `sys.space.event.gap`, and the feed's spacing tokens are now expressed as
multiples of the unit rather than as their own numbers: `sys.space.stack.gap`
is `calc({ref.space.unit} * 8)` (32px, was 58), `sys.space.block.gap` and
`sys.space.prose.gap` are `* 4` (16, were 28 and 22), `sys.space.event.gap` is
`* 2`, `cmp.feed.padding-y` and `-x` are `* 8` (32, were 64 and 46), and the
markdown margins, the table cell padding and `cmp.bubble.padding` (which was 0
while the work-stream rule wrote `8px 12px` over it) are written the same way.
`app.css` derives `--space-1` to `--space-8` from the unit as rule-local
properties, listed in `themes.css.node.test.ts` as such. The group descriptions
for `sys.space.stack` and `sys.space.block` now say what they sit between.

**Why:** The feed's rhythm was rebuilt on a 4px scale (the entry of the same
date in `conversation-surfaces.md` has the measurements). The first cut added
eight `ref.space.N` tokens, one per step; that was cut back to one unit on the
observation that a theme cannot have an opinion about step five that is not an
opinion about the unit, and eight tokens would only let the two appearance files
disagree about arithmetic. The build resolves `{ref.space.unit}` inside a
`calc()` the same way it resolves any other alias, so nothing in the generator
changed. The steps live in `app.css` rather than the registry for the same
reason: they are the stylesheet's multiples of the theme's number, not eight
more numbers a theme sets.

### 2026-09-10 — The group gap stopped being Airy's number

**What changed:** `sys.space.group.gap` goes from 60px to 14px in both themes,
and the four rules that existed only to escape it are gone —
`.workstreams-section` (22px), `.projects-section` (12px),
`.grokbot-shell .workstreams-section` (10px), and
`.grokbot-shell .sidebar-group` (14px). One selector went with them:
`.grokbot-shell .sidebar.is-compact .workstreams-section`, which had been
carrying enough specificity to beat the first two and is now covered by the
`.sidebar-section` beside it.

**Why:** 60px was Airy's, set by the 2026-08-19 entry "The navigation's own
vertical rhythm became themeable" when Airy's whole premise was that negative
space does the work of borders. Airy is gone — the 2026-09-04 entry "Rally has
one design with light and dark appearances" retired the named families — but
its number stayed on as the single value every theme inherits, which is a
different claim than the one that was argued for. What followed is the part
worth recording: rather than the token being re-fitted, each consumer somebody
actually looked at was overridden back down to the low teens, one rule at a
time. That left the token deciding nothing anywhere except one place nobody had
looked — above **Pinned** — so the number that survived was the one no argument
was ever made for. Measured in the running client, the gap from the search field
to the **Pinned** label was 70px; it is now 24px.

**Where 14px comes from.** Not a fresh guess. It is what
`.grokbot-shell .sidebar-group` already used, and a sidebar group is exactly
what `registry.json` says this token's group is for: `sys.space.group` is
"Between one group of rows and the next." The overrides were the team's revealed
answer to what this break should
measure; the change adopts the one attached to the token's own definition
instead of inventing a fifth number.

**Considered and rejected:** a `.grokbot-shell .pinned-section` override, which
was cheaper to reverse and would have fixed the reported symptom on its own. It
was rejected because it is the same move that produced the bug: a fifth escape
would have left the token meaning nothing, and the next section added to the
sidebar would have inherited 60px and needed a sixth.

**One rule still reads as a token consumer and is not** — review caught this,
and it is why the paragraph above says one place rather than two.
`.sidebar-primary-actions` (`app.css:703`) declares
`margin-bottom: var(--av-sys-space-group-gap)`, but its only render site
(`sidebar.tsx`) puts `sidebar-secondary-actions` on the same element, and
`.sidebar-secondary-actions` (`app.css:5330`) sets `margin: 0 1px 14px` at equal
specificity some 4,600 lines later. Source order decides it, so that shorthand
shadows the longhand — along with the `display` and `gap` beside it, which the
same rule also replaces. All three declarations at `app.css:703` are dead as
written, and were carrying 14px long before this change. They are left in place
rather than swept with the others: deleting them is a no-op only for as long as
both classes stay on that element, the block does not render, and a change that
cannot be looked at in a window is not one to make on cascade reasoning alone.
Whoever removes `conversationOnly` should fix that rule before trusting it.

**Consequences:** `.workstreams-section`'s margin moves from 10px to 14px — the
one visible change beyond **Pinned**, accepted so the breaks in that rail are one
value rather than three. What a reader actually sees depends on what precedes it:
under a pinned section the gap moves 10px to 14px, but with nothing pinned it
follows `.sidebar-commandbar` and collapses against that rule's 12px, so the
visible move is 12px to 14px. Both are the same declaration. `.sidebar-section`
and `.sidebar-group` now resolve to the same 14px, which is deliberate — the
sidebar states its hierarchy through its headings rather than through two
different break sizes, and the two values it had before (10px against 14px) were
not carrying that distinction on purpose either. `.projects-section` now follows
the token too, but
`app-shell.tsx` passes `conversationOnly` unconditionally, so it does not render
in the shipping client and could not be looked at; if that flag ever comes off,
it and the shadowed rule above are what to check first. The
compact rail keeps its explicit `margin-top: 0` because it hides the headings
these gaps are spacing, which is a different reason than escaping the token. A
`.sidebar-section` that wants a different break should now say why in a comment
rather than write a sixth number. Margins here collapse: `.sidebar-commandbar`
has a 12px bottom margin and the section a 14px top, so the token alone decides
that gap — raising the commandbar's number would not show until it passed the
token's.

### 2026-09-10 — The ink table follows APCA, not the WCAG 2 ratio

**What changed:** `PALETTE_INK` flips thirteen of nineteen fills from black ink
to white. Only `amber`, `lime` and `green` still take black; every other fill,
the ring's `cyan` through `indigo` included, now carries the near-white ink. The
table's deciding rule changed with it, from WCAG 2's relative-luminance ratio to
APCA, the perceptual model the WCAG 3 drafts are built on.

**Why:** A spot-check sheet rendering every fill twice — once with each ink, at
the 16px and 36px the sidebar actually uses — showed the old table picking the
worse ink on most of the ring. WCAG 2 scores black the winner on `blue` (5.71
against white's 3.68), `red`, `rose` and `violet`, where white plainly reads
better and where every other design system ships white. Its luminance curve is
known to misjudge saturated mid-tones, and this palette is nothing but saturated
mid-tones. APCA scores the same fills the way the eye reads them: white on `blue`
is Lc 69 against black's Lc 40. The 2026-09-09 entry below, which recorded that
"black wins on every fill but the three darkest", is superseded — that was a true
statement about WCAG 2, and WCAG 2 is what turned out to be wrong here.

The boundary sits between `green` and `cyan` by review rather than by arithmetic.
APCA's own crossover is one step further along, between `emerald` and `orange`,
but the fills either side are ties in its terms (`cyan` Lc 52 white against 57
black, `emerald` 54 against 55), and a ring reads better with one ink running
through it than with two exceptions stranded mid-ramp. The two departures are
named in `palette.css.node.test.ts` so a third cannot appear quietly.

Two alternatives were rejected. Splitting the table in two — one ink for glyphs
at the graphical-object bar, another for text at the higher one — was built far
enough to see it buy nothing: the same fills won either way, and a second table
would have let the two drift with nothing tying them together. Darkening
`emerald` and `orange` so every accent clears APCA's Lc 60 for body text was left
for a separate change, because it moves the palette itself rather than the ink
over it.

**The glyph lost its gradient in the same change.** `WorkstreamGlyph` painted
its symbol over `linear-gradient(145deg, color-mix(in srgb, <fill> 78%,
surface-default), <fill>)`, so the colour behind the symbol was never the one the
ink table had been computed from. Review caught it. Because the mix target
follows the appearance while a fill and its ink deliberately do not, the sheen
always moved contrast the *losing* way for whichever ink that fill carried —
lightening under white ink in light, darkening under black ink in dark — costing
up to 19 Lc and dropping `cyan` and `emerald` (light) and `amber`, `lime` and
`green` (dark) under the floor at that stop. The shape now paints the raw token,
as `AutomationGlyph` always did. Shading away from each fill's own ink instead
was measured and also cleared the floor at Lc 50.1, but the flat fill won: a
contrast guarantee that needs no second surface to reason about is worth more
than the depth, and it is what makes the floor provable rather than approximate.

**Consequences:** This is accepted WCAG 2 debt, and it is written down rather
than discovered. On the fills from `cyan` to `indigo` the white ink does not meet
that standard's ratios — white on `cyan` is 2.43:1, under both its 3:1 for a
graphical object and its 4.5:1 for text — so an audit run against WCAG 2 will
flag them. `palette.css.node.test.ts` pins the four fills that fall under 3:1 by
name, so the debt cannot grow by accident, and holds an APCA floor of Lc 45 on
whichever ink each fill takes. `emerald` and `orange` remain the weakest entries
whichever ink they carry: neither reaches Lc 60 for body text, which is a
property of those two fills and not of this table. Anything painting on a palette
fill still reads `PALETTE_INK` and the two absolute ink tokens, never
`text-on-inverse`.

### 2026-09-09 — Media overlay ink stays light

Media caption overlays use `sys.color.text.on-media`, white in both appearances.
Gallery arrows and placeholders instead follow ordinary surface text because
their background changes with the theme. This avoids white-on-white controls in
light mode while keeping labels over visual media legible.

### 2026-09-09 — A fill's ink is absolute, and the glyph follows it

**What changed:** `sys.color.palette-ink.light` and `sys.color.palette-ink.dark`
join the token set, identical in both appearances. `WorkstreamGlyph` and
`AutomationGlyph` set `--glyph-ink` per glyph from `PALETTE_INK` instead of
painting every symbol in the one `text-on-inverse` near-white.

**Why:** Review caught the symbol going illegible on the brighter half of the new
ring — white on `lime` is 1.98:1 and on `emerald` 2.47:1, under the 3:1 WCAG asks
of a meaningful graphical object. One fixed light foreground worked only because
the previous ramp was uniformly dark, so this is a regression the palette change
introduced rather than a pre-existing gap.

The inks had to be new tokens rather than the neutral ramp. `ref.color.neutral.*`
inverts between appearances, which is right for text on a themed surface and
wrong here: a palette fill is the same colour in both themes, so its ink must be
too. The first attempt reached for `neutral.14` and produced white-on-orange in
dark mode, which `palette.css.node.test.ts` caught.

**Consequences:** Anything drawing on a palette fill takes its ink from
`PALETTE_INK` and these two tokens, never from `text-on-inverse`. The test walks
every fill in both appearances and holds the 3:1 floor, so a future palette value
that would go unreadable fails the build.

### 2026-09-09 — The identity palette becomes a hue ring, and accents step it in twos

**What changed:** `sys.color.project.*` moved to fourteen hues in wheel order —
`rose` through `pink`, on a lighter ramp — plus `black`, a near-black that each
appearance tunes separately (`#17171a` light, `#45454d` dark) so it stays legible
as a glyph stroke rather than vanishing into a dark sidebar. `gray`, `brown`,
`yellow` and `teal` keep their tokens but left the picker. `#ccff00` is no longer
a palette entry: it stays `sys.color.brand.base` and nothing else. A new
`sys.color.project.edge` gives every swatch a hairline, and the
`cmp.member-message.*` tokens are gone, message bubbles reading the palette
directly.

**Why:** The previous palette carried the brand lime in a slot named `orange`,
so the one colour that must stay reserved for the brand was also a colour any
person could paint a project. Separating them is the point of the change; the
ring ordering is what lets the picker close into an oval rather than reading as
two unrelated rows. The `cmp.member-message.*` hexes were duplicating palette
values by hand and had already drifted, which is why they were removed rather
than repointed.

The palette is now a vocabulary rather than a menu. `PALETTE_KEYS` is every
colour with a token; `PROJECT_COLOR_KEYS` is the ring, which is what projects and
work streams offer; `PERSONAL_COLOR_KEYS` is every *other* colour around the ring
plus `black`, which is what an account offers. Stepping the ring in twos is what
makes eight accents distinguishable — adjacent hues are neighbours by
construction, so a contiguous eight would collect the least separable colours.
`black` is offered only to accounts: a person appears once on a screen, where an
absence of colour reads as a choice, while a work stream sits in a list where it
reads as one that failed to get a colour. It stays storable everywhere regardless
— narrowing what can be stored is how a held colour becomes a failed read.

The `cmp.member-message.*` tokens are gone entirely, twenty-four of them. They
restated palette fills and inks by hand for each accent name, had already drifted
from the palette, and could not survive the accent set changing; the accent is a
palette colour now, so message bubbles read the palette directly.

**Consequences:** The label "Neon yellow" is gone — the 2026-09-07 entry below is
superseded on that point, and `orange` is an actual orange now. Ink is no longer
guessed from a list of four dark fills: `PALETTE_INK` in `@rally/contracts`
is the table, black wins on every fill but the three darkest — `black`, and the
retained `gray` and `brown` — and
`palette.css.node.test.ts` recomputes it from the token values in both
appearances. A fill whose contrast flips must move the table in the same change
or that test fails.

### 2026-09-07 — Rally neon yellow replaces the stale orange palette, and an account owns a personal accent

**What changed:** Rally uses #ccff00, matching the public site's primary brand
color. Both desktop appearances now use that yellow for brand fills and the
legacy orange swatch. The stored swatch identifier remains compatible with
existing user selections; its onboarding label is Neon yellow. Export accents
also use the yellow. Brand marks and text stay black in light mode and white in
dark mode for legibility, replacing the temporary onboarding-only override.
Brand fills use dark foregrounds.

Onboarding and Settings share a server-owned avatar/color editor. The selected
color derives sidebar and highlight accents from the existing project palette;
light/dark appearance remains device-owned. Bright colors use dark action text
for contrast. The [new-user onboarding module](new-user-onboarding.md) owns
persistence and sync.

**Why:** The orange palette was stale against the public site, whose primary
brand color is the neon yellow. A personal accent derived from the project
palette gives each account its own colour without the theme engine having to
know about it.

**Considered and rejected:** Introducing another named theme for each personal
color; deriving the accent from the existing project palette avoids that.

**Consequences:** Do not reintroduce the prior orange palette. The accent is
account-owned while the light/dark appearance stays device-owned, and the
onboarding module, not this one, persists and syncs the choice.

### 2026-09-05 — Review fixes preserve scaling and keyboard visibility

The base leading is a unitless 20/14 ratio, not an inherited 20px height: larger
wrapped headings must scale their line boxes. Dark focus uses a lighter blue
(`#3d91ef`) because the light reference blue disappears on raised dark controls.
Both appearances use opaque focus rings; quiet rings are thinner, not less
contrasting. Terminal selection uses the neutral text tone and its domain editor
retains a visible focus ring and readable 13px monospace type.

Control and surface corner roles now own 8px and 12px respectively; secondary
control typography owns its 13px size through the same registry. Changing the
global radius scale was rejected because it would also move feed/sidebar geometry.
Unused Geist sans declarations and its binary are removed; Geist Mono remains.
This deliberately supersedes the **2026-08-20 — A theme may bring fonts and a
document that moves** decision below: the application now follows the native
system UI family to match the reference, rather than bundling a sans replacement.
Token tests cover scaling, focus contrast and the narrow platform-font exception.
The UI stack retains `system-ui` as a Linux fallback after the platform-specific
families, and the account menu consumes that same token. Unused template
subscription/list styles are removed after confirming there are no consumers.
Dialog descriptions no longer reserve a second close-button gutter inside the
header's already separate text column.

### 2026-09-05 — Shared secondary surfaces use the application visual language

**What changed:** System sans-serif and 14px/20px UI type now apply at the
document root, including settings windows and portalled dialogs. Shared primary
actions have dedicated neutral appearance tokens instead of borrowing the brand
color. Dialogs use 12px corners, a 480px preferred width, and a shrinking scroll
body rather than an overflowing minimum width. Advanced connection and terminal
settings use readable secondary labels and neutral selection treatments. Menus,
member pickers, resource inspectors, project forms, onboarding/recovery, and
note/meeting controls use the same role-specific treatment. Narrow GitHub/MCP
preference rows stack instead of squeezing descriptions beside their selects.
Keyboard focus uses the reference's blue `#0c64c1`, independently of brand color.
Unused automation-builder, template-browser and automation-plugin-defaults rules
were removed after checking for renderer consumers.

Conditional-state QA also gave one-time webhook secrets their own padded layout,
separated telemetry metadata and empty states, and spaced the connected MCP tools
heading. Description-only dialogs retain a gap before their actions, even without
a body. Sign-in and invitation errors no longer inherit muted help-text styling.
Project icon/color choices use the same 8px control corners.

**Why:** The shell-only typography override left secondary surfaces in the old
design. Brand orange on ordinary actions and success green on unconfigured
terminal settings gave those surfaces inconsistent visual and semantic meaning.
Rare states exposed gaps hidden by the ordinary settings rows: a generic list-card
class provided no internal secret/empty-state padding, and description-only
dialogs had relied on the absent body to separate their footer.

**Considered and rejected:** Replacing every accent or radius token would also
change existing message bubbles, sidebar geometry, provider identity, and real
warning states. Those remain owned by their components. Code retains its
monospace family and documents retain their separate reading scale.

**Consequences:** New portals inherit UI typography without requiring a shell
ancestor. Primary actions must use the button tokens, not brand or status tokens.
The recovered Grok Bot 0.39 button rules specify 8px corners, 6px vertical and
10px horizontal padding; its light primary fill/hover/text are
`#070707`/`#2f2f2f`/`#fcfcfc`. The dark primary inversion is an adaptation to
Rally's dark surfaces, not a claim of recovered dark runtime values. Shared
dialogs use the reference's 12px large-surface radius. Existing feed, sidebar,
lightbox layout and reduced-motion behavior remain independently owned.

### 2026-09-05 — Settings adopts the reference's quieter grouped layout

**What changed:** The settings navigation uses the 198px rail, 13px regular labels and rounded
selection from Grok Bot 0.39's packaged settings surface. Preference groups use
12px corners, compact rows and inset hairline dividers instead of boxed icons.
Switches use the appearance's monochrome foreground, scoped to settings so other
surfaces are unaffected. Digest selection and time controls also use neutral
tokens rather than the former orange brand and green success states; selecting
a schedule is not a success notification. Rally keeps its native settings window, searchable
navigation and all existing settings behavior: the reference informs presentation,
not which product capabilities or security controls are available.

**Why:** Settings still used the old card and accent treatment after the main
feed adopted the reference design.

**Considered and rejected:** Global token changes would alter unrelated surfaces;
the reference-specific dimensions remain scoped to settings.

**Consequences:** [Settings search](settings-search.md) owns discovery and reveal;
this document owns appearance. Search must not change the control's behavior.
PR: #557.

### 2026-09-04 — Rally has one design with light and dark appearances

**What changed:** The former named palettes, family axis, design swatches,
animated backdrop document, iframe, custom protocol, schema field, generated
module, tests, and supporting CSS were removed. The stored preference is now a
scalar `system | light | dark`; previous object-shaped values migrate by keeping
only their valid appearance mode.

**Why:** The GrokBot rewrite established a single product look. Leaving the old
theme engine behind kept dead visual states, executable decoration, and a
second picker axis available to drift back into the application even though no
current product surface used them.

**Considered and rejected:** Hiding the named-theme controls while preserving
their runtime and token files. That would reduce the Settings UI but retain the
same protocol, generated assets, branches, tests, and maintenance burden.

**Consequences:** Future visual work changes both Rally appearance files rather
than adding a theme. The only compatibility code is the narrow stored-setting
migration, and no appearance can bring executable markup.

The entries below record the retired engine's history, not supported current
features. They remain here so future changes can recover the original reasons.

### 2026-09-02 — Terra's work-stream composer closes its frame and matches the launch composer

**What changed:** the two Terra themes set `cmp.composer.border-color` to
`ref.color.line.3` rather than `line.4`, and `cmp.composer.rule-color` /
`rule-color-focus` to `line.3` / `line.5` rather than `transparent`. Air and Air
Dark are untouched: their composer stays the rule the tokens exist to express.

**Why:** two composers ask for the same thing in the same product and did not
look alike. The new-work-stream screen's `.launch-composer` writes its own card
— `line.3`, `radius.xl`, `shadow.md` — while the work stream's composer draws
from `cmp.composer.*`, which named a darker line; side by side the second read
as the heavier control, and it is the one a person types into all day. Worse,
the stylesheet draws the composer's top edge from `rule-color` in *both* shapes,
so Terra's `transparent` left the card open along the top: three sides and a
colour change where the fourth belonged. Matching the launch composer fixes both
at once, because that screen already showed what the card is supposed to be.

**Considered and rejected:** pointing `.launch-composer` at `cmp.composer.*` so
one definition serves both. It is the better factoring on paper and the wrong
change here — under Air the launch screen would stop being a card and become a
rule, which is a product decision about a screen nobody asked about, made as a
side effect of a colour fix. Also rejected: dropping the focus darkening
entirely and holding `line.3` through focus, so the two matched in every state.
The launch composer holds `line.3` through focus only because its own selector
outranks
`.workstream-composer:focus-within`; the work stream's composer is the
long-lived field, and taking its one focus signal away to match an accident is
not symmetry worth having.

**What it also fixed, which was not the goal:** the launch hand-off.
`new-workstream.tsx` puts `workstream-screen is-launching` on the root while a
work stream is being created, so mid-transition the composer stops matching
`.workstream-launch-screen:not(.is-launching) .launch-composer` and falls to the
tokenised rule — with `transition: border-color 240ms` still running on it. The
frame therefore animated `line.3` → `line.4` *and faded its top edge away* on
the way across, then the destination screen painted the same. Both endpoints are
now `line.3`, so the lid no longer opens during the hand-off. The
`work-stream launch surface geometry` suite exists to protect that transition
and had no way to see this: it reasons about geometry, and this was colour.

**What a future change has to respect:** a card theme states `rule-color` as its
own border colour. Leaving it `transparent` does not turn the rule off — it
erases the top of the card.

### 2026-09-02 — The thinking orb follows the appearance instead of pinning dark

**What changed:** every `ThinkingOrb` — the work-timing row, the compaction
indicator, and `LoadingState`'s opening orb — takes its `theme` from
`useAppearance()`, a new hook over `useTheme()` built on `appearanceOf()` in
`common/themes.ts`, which answers which half of its family a resolved
appearance is. The prop was the literal `"dark"` at all three call sites.

**Why:** the library is monochrome and inverts its ink from that prop alone —
light dots for a dark ground, dark dots for a light one. Pinned to `dark`, the
orb drew near-white dots on Terra Light's white canvas, so the "working for 21s"
row read as a label with a smudge beside it. Nothing caught it: the orb is a
canvas, so the stylesheet's literal-colour and token guards cannot see inside
it, and the component tests assert on props rather than pixels.

**Considered and rejected:** the library's own `theme="auto"`, which is what a
reader will reach for first. It resolves an ancestor `data-theme` of exactly
`dark` or `light` and otherwise falls back to `prefers-color-scheme` — ours
carries an appearance name like `terra-light`, so every window would take the
fallback and a person who pinned Light against a dark Mac would keep the pale
ink this change exists to remove. Stamping a second `dark`/`light` class on
`<html>` would make `auto` work and was rejected for the same reason: the
document carries one theme signal, and a second one drifts.

**Also in this change:** `useTheme()` now snapshots the *document* — the three
attributes `applyTheme` stamps — and re-reads it once inside its subscribing
effect, rather than initializing from the device store. The store is not what is
on screen during the window `watchThemeBroadcast` deliberately opens: it applies
an IPC payload without waiting for the `localStorage` write behind it, so a
surface that mounted in that gap read the previous choice and had already missed
the announcement that would have corrected it. Every reader was exposed to it —
Mermaid, the backdrop, the picker — but the orb is where it becomes permanent
and visible, an inverted canvas until something else applies a theme.

**What a future change has to respect:** a component still may not name a
colour. `useAppearance()` returns a lighting, not a value, and exists for
surfaces that paint outside CSS; anything that can name a token names one. And
the document remains the one record of what is being drawn: do not add a second
copy of the applied state beside it, which is the shape this fix started as and
which drifts the moment anything sets one without the other.

### 2026-09-02 — The identity line stopped being a theme's open question

**What changed:** `MessageBlock` renders the author dot, name, and time over
every human turn, the signed-in reader's own included. The
[2026-08-19 entry below](#2026-08-19--where-a-persons-own-turn-sits-is-a-themes-decision)
left that suppression in place and named the follow-up it implied — a
`You · <time>` line for a theme that left-aligns and drops the bubble, "a
component change gated on a fourth token". That component change has now
happened, and **without** a fourth token: the line renders in every theme
rather than in the ones whose geometry needs it. That earlier entry stands as
written, as a dated record of the reasoning at the time; this one supersedes its
"one to watch".

**Why:** the question turned out not to be a theme's. Suppression was argued
from geometry — a right-aligned bubble is its own attribution — but the thing it
withheld is a *timestamp*, which no geometry supplies. Under Terra, where the
bubble does attribute the turn, the reader's own messages were still the only
rows in the feed carrying no time. Making that conditional on the theme would
have given the two designs different information, not just different shapes,
and a token whose real job is "does this theme tell you when you said it" is not
a theming decision.

**Consequences:** a theme no longer has to reason about whether the reader can
identify their own turn; it can assume the line is there. The header's trailing
inset is stated as `padding-inline-end` from the human bubble's own corner
radius (`--turn-bubble-radius` in `app.css`), so a theme that aligns turns to
the leading edge — Air — leaves the header flush there and the inset inert,
without stating anything of its own. A theme that wants the line to read
differently should change how it is *painted*: `--av-sys-color-person-1`
through `-6` are the accent it and the dot resolve through.
[`conversation-surfaces.md`](conversation-surfaces.md) owns the row itself and
carries the full entry.

### 2026-09-01 — Rally has one GrokBot palette with light and dark appearances

**What changed:** The Settings surface no longer offers visual families. It
offers only System, Light, and Dark, all resolving to the same Rally design.
The main window no longer mounts the Air backdrop. Its light palette now uses
the reference's `#fcfcfc` canvas, `#f7f7f7` sidebar, and neutral fills; dark uses
the measured `#070707` canvas, `#111111` sidebar, `#2f2f2f` raised controls, and
`#313131` selected work-stream row.

**Why:** The GrokBot rewrite is the application, not a selectable skin. Keeping
Terra and Air as visible alternatives made every screenshot and component state
depend on a product choice that no longer exists.

**Considered and rejected:** Deleting the token generator with the picker. The
generator is still the enforcement boundary that keeps literal colors out of
component CSS and gives light and dark exact, independently measured values.

**Consequences:** Older stored family choices keep only their mode when read by
the renderer. The legacy appearance files remain build inputs until the desktop
window-prepaint and asset plumbing can be collapsed without mixing that cleanup
into this frontend rewrite.

### 2026-08-30 — Mermaid resolves the active design tokens

**What changed:** Mermaid's base theme now receives concrete values resolved
from Rally's active design tokens for surfaces, text, borders, state washes,
chart series, typography, radius, and stroke width. The new
`cmp.markdown.diagram-line` token gives relationship lines the strongest
line-ramp value while leaving container borders quiet. A theme change
re-renders the SVG from the new token values.

**Why:** Selecting Mermaid's generic `neutral` or `dark` theme followed the
window's brightness but not Rally's design system. Actor cards, notes, lines,
and sequence numbers therefore looked like an embedded document instead of the
code-block surface around them.

**Considered and rejected:** CSS overrides over Mermaid's generated stylesheet
cover only diagram kinds and selectors known today. Passing unresolved `var()`
strings was also rejected because Mermaid performs colour calculations before
the browser can resolve them. Reading the computed tokens at the generator
boundary keeps every value owned by the theme and works for Mermaid's shared
theme-variable vocabulary.

**What a future change has to respect:** the adapter may map Mermaid roles to
Rally roles, but it must not add literal colours or branch on a theme id. New
diagram-specific fields should resolve design tokens, and every appearance must
be checked in a real window because token provenance alone does not prove
contrast. The visible relationship line and the quieter boundary line are
different roles; do not collapse them back onto the generic border token.

### 2026-08-30 — Automation rows use the same hover pill as work streams

**What changed:** Sidebar automation rows now wear `.automation-row` and
`--row-height-dense`, the same floor as work-stream, note, and project rows.
The scope badge drops its chip fill while the row is hovered, focused, or
current so it cannot punch the selected-row colour through the shared pill.

**Why:** Project rows had been brought onto `.sidebar-row` so hover fill,
radius, and padding matched a work stream. Automations already used that
class, but they still sat on `--row-height` (3px taller in Terra Light) and
kept a `neutral-4` chip on the trailing badge — the same token as the
selected fill. Hovering one therefore read as a taller, two-tone pill rather
than the same navigation row.

**Considered and rejected:** Hiding the You / Workspace badge until hover, the
way a project's plus appears. Scope is something you scan the list for, not an
action that only matters on the row you are pointing at. Ghosting the chip on
the hovered and current states keeps the information and the uniform fill.

**What a future change has to respect:** a new sidebar row kind should pick
`--row-height-dense` when it lives in the same list as work streams, and must
not give itself a private hover colour. Trailing chrome that paints a fill
must drop that fill on `.sidebar-row:hover` and `.is-active` or it will
compete with the row.

### 2026-08-30 — Terra Light's row hover sits on raised-hover, not subtle

**What changed:** Terra Light now sets `cmp.row.background-hover` to
`sys.color.surface.raised-hover` instead of inheriting the default theme's
alias to `surface.subtle`. The command-shortcut scrim reads the same hover and
selected tokens as the row fill.

**Why:** Subtle in Terra Light (`#faf9f6`) is *lighter* than the solid sidebar
(`#f7f6f2`), so a hovered or current row painted as a near-white wash. The
project accordion had already been using raised-hover (`#eae8e1`) for the
same job, which is the direction a hover fill has to go on a light ground.

**Considered and rejected:** Darkening `surface.subtle` itself. That token is
the quiet fill behind many other surfaces; changing it to repair navigation
rows would have moved those too. Pairing the row hover with raised-hover
matches the popover-row pairing from 2026-08-26 and leaves subtle alone.

**What a future change has to respect:** a light theme's row hover must be
darker than the sidebar it sits on, not lighter. Selected stays
`ref.color.neutral.4`, which is a step darker than that hover.

### 2026-08-27 — Projects add a closed semantic color palette

**What changed:** Added twelve `--av-sys-color-project-*` tokens used by the
shared project icon registry and picker.

**Why:** Projects persist named hues rather than hex values so every theme can
render the same choice with suitable contrast.

**Considered and rejected:** Arbitrary colors and component-local hex values;
both bypass theme control and can produce unreadable icons.

**Consequences:** Every new theme must define or deliberately inherit all twelve
project hues, and project components must address them by registry key.

Design: `docs/PRDs/2026-08-26_projects/prd.md`.

### 2026-08-26 — Raised popovers use the raised hover state

**What changed:** Ordinary highlighted dropdown and command rows now paint with
`sys.color.surface.raised-hover`; danger rows keep their dedicated danger tint.

**Why:** Both the dropdown and command popovers are
`sys.color.surface.raised`, but their rows used
`sys.color.surface.elevated-hover`. Terra Light deliberately gives
`surface.elevated-hover` the same value as `surface.raised`, so ordinary rows
showed no visible hover or keyboard-highlight state while danger rows still did.

**Considered and rejected:** changing Terra Light's elevated-hover value. That
would alter every genuinely elevated control to repair popovers whose base
surface was raised. Pairing each row state with its panel's own surface role
fixes the semantic mismatch in every theme instead.

**What a future change has to respect:** items inside a raised panel take
raised-hover for their hover and highlight states; items inside an elevated
panel take elevated-hover. The stylesheet test holds the dropdown and command
popover pairs together and also protects the danger override.

Shipped in TBD.

### 2026-08-24 — Work-stream markers get a token group of their own

**What changed:** `sys.color.stopped.base` is gone, and the six colours the
sidebar's dot drew from — three of which it borrowed from `accent`, `warning`,
`danger` and the neutral ramp — are replaced by `sys.color.workstream`, one
token per state the marker can show: `running`, `needs-input`, `completed`,
`failed`, `stopped`, `unread`, `mentioned`, `unseen`.

**Why:** the marker grew from five states to eight, and the borrowed palette
could not seat them. `running` and unread both resolved to `accent`, so the two
were the same colour on the same list; `needs-input` and a warning banner shared
`warning`, which meant a marker could not be retinted without moving an unrelated
surface. A group whose members are the states of one control is also the only
shape in which "these eight must remain distinguishable from each other" is a
checkable claim rather than a note in a review.

**Considered and rejected:** giving each theme its own hue per state, as the
borrowed tokens did — Terra's accent is a cyan and Air's a muted blue, so
`running` would have been a different colour in each. The states are read as a
legend across the whole product, so the group carries one hue per state with a
per-appearance shade: darker on the light themes, lifted on the dark ones,
`completed` aliased to each theme's `ref.color.neutral.9` because a neutral has
to sit in its own ramp.

**What a future change has to respect:** a ninth state means a token here in all
four themes and a rule in `app.css`, and the two are checked by different tests —
the registry coverage test fails on a token missing from a theme, and the
stylesheet test fails on a `var()` that is not declared. Neither catches a state
that has both and is indistinguishable from its neighbour, which is what the
group's description is for. `sys.color.stopped.base` was removed rather than
aliased: its only consumer moved, and a token nothing names is a colour the next
person has to check before they can change it.

Shipped in TBD.

### 2026-08-21 — Secondary windows keep a flat ground, on purpose

**What changed:** nothing in how it renders. A comment at the mount site, an
invariant, and `theme-backdrop.node.test.ts`, which asserts that `AppShell` is
the only surface mounting `ThemeBackdrop`.

**Why:** review pointed out that the standalone Settings and meeting windows
never mount it, so on Air — where the document *is* the entire backdrop, since
every theme sets `sys.backdrop.image` to `none` — the main window animates and
the Settings window beside it is flat. That was true by omission: those surfaces
return before `AppShell` is reached and nobody had decided anything about it.

**The decision:** they stay flat. Both are dense forms and a moving field behind
one costs more legibility than it buys. The alternative — mounting it and making
`.settings-window` translucent so the light runs beneath — was considered and
rejected on those grounds, not on effort.

**Why a test for a thing that does nothing:** the stylesheet's painted-once
guard looks for a *second* surface painting a backdrop, so it can only catch a
duplicate. A surface that gains or loses the frame is invisible to it, which is
how this went unnoticed in the first place. The new test names the mounting
surfaces, so changing the set means changing the decision in the same diff.

**What a future change has to respect:** "one preference, one appearance
everywhere" is knowingly relaxed here, and only here. If a third window is
added, decide which side of this line it is on before shipping it.

### 2026-08-21 — A following window applies the message, not the store

**What changed:** `watchThemeBroadcast` applies the `ThemeChoice` the
`theme:changed` payload carries, falling back to the store only for a payload it
cannot read.

**Why:** re-reading the store was chosen so that a window following `system`
re-resolves against its own Mac. That reasoning was right and the payload now
satisfies it anyway — it carries both axes, so applying it re-resolves locally
just the same. What re-reading also did was reach `localStorage` from a *second
renderer process*, and a write in the window that made the choice is not ordered
against an IPC round trip through main. Lose that race and the receiving window
applies the old choice and reports it; main sees a difference and broadcasts
again. The comment claiming "relaying only on a change is what stops this
echoing" holds only while every window reads the same value — a stale reader
turns the guard into an oscillator.

**Raised as plausible rather than reproduced,** and left that way: the race is
between a storage write and an IPC hop, and rigging it in a test would prove the
rig rather than the code. What the test does pin is the behaviour that makes the
race harmless — a window with a deliberately stale store still draws what the
message said, and reports that back, so main's comparison matches and stops.

**What a future change has to respect:** `localStorage` is shared between
Rally's windows but not synchronously coherent across them. Anything that has
to agree *now* across windows travels in the message; the store is for what has
to survive a relaunch.

### 2026-08-21 — Highlighted code survives being exported

**What changed:** the generator emits `exportSyntaxPalette` into
`common/theme-assets.ts`, and `message-export.ts` declares it on the export
document's `:root`.

**Why:** tokenising the `prism-react-renderer` theme replaced ten literal hexes
with `var(--av-sys-color-syntax-*)`. In the renderer those resolve against the
cascade, which is what the invariant said and it was right. But `MarkdownBody`'s
markup does not stay in the renderer — the exporter serializes it into a
standalone document that loads no stylesheet of ours. There every reference was
invalid at computed-value time, so `color` fell back to the inherited
`#24251c` on a `#1b1c18` code block: about 1.05:1, and silent. A saved PNG or PDF
of any message containing code shipped with the code invisible.

**Why generated rather than a constant in the exporter:** the values are already
in the theme JSON, and a hand-copied second set is the thing the whole generator
exists to prevent. `exportSyntaxPalette` resolves the default theme's syntax
tokens — aliases followed, since a document that declares none of the ramp cannot
resolve one — and a test asserts the exported document declares every entry.

**Why the default theme's values and not the active one:** the card is
deliberately unthemed. A saved file should look the same whoever saved it, and
its code block is a fixed dark panel, so the palette has to be the one built for
that panel. A second test checks every entry clears 3:1 against it, which is the
property that actually matters and the one that failed.

**What a future change has to respect:** "no component reads a colour" holds
only while the markup stays inside the application. Anything that serializes
rendered markup out of the renderer — an export, an email body, a clipboard
flavour — has to carry the tokens it names, or resolve them before it leaves.

**Found in review, not by tests.** The invariant list reasoned that an inline
`var()` always resolves against the cascade, which is true everywhere except the
one place this markup is re-hosted, and no test covered that place.

### 2026-08-21 — The main process carries the choice, not the appearance

**What changed:** `theme:set-window` now sends a `ThemeChoice`, the settings
file stores `themeChoice` instead of `windowTheme`, and `windowBackgroundColor`
resolves it against `nativeTheme.shouldUseDarkColors` each time a window is
built. `sameThemeChoice` is the relay's new comparison.

**Why:** storing what a choice resolved *to* threw away the axis that produced
it, and two independent defects fell out of that.

- A Mac that changed appearance while Rally was closed opened the next launch's
  first window in the old colour, because `system` had been flattened to
  whichever appearance was in force when it was last written. That is exactly
  the flash the stored value exists to prevent. A fresh profile had the same
  problem from the other end: its fallback was dark Terra, so a light Mac
  flashed dark.
- The relay deduplicated on the resolved appearance, so moving from `system` to
  a pinned Dark under an already-dark Mac looked like no change at all. No
  `theme:changed` was emitted, and every other window kept `data-theme-mode`
  set to `system` — invisible in that moment, and wrong the next time the Mac
  changed.

**The rejected alternative:** keeping the resolved value and adding a separate
"preference changed" ping. That is two sources of truth for one preference, and
the launch case still needs the choice, so the ping would have been a second
mechanism papering over the same missing information.

**What a future change has to respect:** an appearance is a projection of a
choice through a moment in time, and the projection is lossy in both directions
— it cannot be reversed, and it cannot answer whether the choice changed.
Anything that persists, compares, or transmits a theme across a boundary wants
the choice. `ResolvedTheme` is for painting only.

**Found by review, not by tests.** Both defects were flagged on the pull request
by automated reviewers, and neither was caught by the suite: nothing asserted
what main does with a *pair* of choices, and nothing exercised a relaunch.
`common/themes.test.ts` now pins the composition main performs.

### 2026-08-20 — Rendered markdown takes its scale from the theme

**What changed:** `cmp.markdown.*` — heading sizes, leading and margin, `strong`
weight, list rhythm, blockquote and rule margins, table leading and cell
padding, plus a second `article-*` scale for the note detail. Terra keeps every
value it already had; Air takes a scale that sits above its prose.

**Why:** `.markdown-body` scaled with `sys.font.size.prose` and the headings
inside it did not. Air raised prose to 16.5px, so its `h2` rendered at 16px and
its `h3` at 14.5px — headings *smaller* than the paragraphs beneath them. The
same fixed rhythm meant Air's doubled vertical spacing stopped at the edge of
any markdown block.

**The guard that was missing.** The engine had one invariant about literals and
it was about colour, so a type scale walked straight past it. There is now a
second: no bare `px` font-size, weight or line-height inside a `.markdown-body`
rule. Writing it found two more offenders immediately — the note detail's own
`22px`/`17px` headings, which in Air would have put its `h2` *below* the shared
`h3` and inverted the hierarchy rather than merely flattening it.

**One assertion is deliberately `>=`.** A heading level that matches the prose
and is carried by weight alone is a legitimate decision, and Terra's `h4` is
exactly that. A level below the prose is not; that is a caption.

Terra and Terra Light were measured before and after across every heading,
margin, weight and padding, and are unchanged in all of them.

### 2026-08-20 — Choosing a theme repaints every window, not just the one you chose it in

**What changed:** the main process relays a theme change to every other open
window, and each re-reads the stored choice and re-applies it.

**Why:** Settings can open as a window of its own. Each window is a separate
renderer with its own document, and `applyTheme` stamps `data-theme` on the
document it is called in — so choosing Air in the Settings window repainted the
Settings window and left the work stream behind it on Terra. The stored
preference was already correct and shared; what was missing was any reason for
the other windows to look at it again.

**Why the payload is ignored.** The relay carries the appearance now in force,
and a listener deliberately does not stamp it: it re-reads the store. The store
holds both axes, so a window that is following `system` re-resolves against its
own `matchMedia` and keeps following, where stamping the appearance would
silently pin it.

**Why relaying only on a change matters.** Every window that follows re-applies
and reports back over the same channel. That report matches the appearance main
already holds, so it stops there rather than fanning out again — the guard that
was already in the handler for a different reason is what keeps this from
echoing between windows.

Verified with two real windows: Terra in both, Air chosen in Settings, both at
`air-dark` a moment later.

### 2026-08-20 — The System swatch shows both halves, and the preview shows who speaks where

**What changed:** three things in the Settings preview, and one name.

*The System swatch is split.* Under a pinned mode a family has one appearance to
show; under `system` it has two, and which one you get depends on the Mac.
Picking one to display would be quietly wrong for half the day, so the swatch
draws both, divided by a line 30° off vertical through the centre.

**Why a mask and not a clip path.** A gradient angle in `deg` is a true angle
whatever the box's aspect ratio is; a `polygon()`'s percentages are only 30° at
one particular size, and the swatch is 92×58. `linear-gradient(120deg, …)` puts
the edge 30° off vertical because a gradient runs perpendicular to its own
bands — the edge angle is the direction minus a right angle. Both halves draw
the same miniature, so the content lines up across the seam and it reads as one
picture lit two ways rather than two half-pictures.

*The miniature shows which side each actor speaks from.* It reads
`--av-cmp-turn-align`, the same token the feed uses, so the preview cannot say
left while the feed says right: Terra puts a person's own turn on the right in a
bubble, Air runs it left as plain text. The leading mark uses the real
`--av-cmp-marker-*` tokens too, and at swatch scale the same two values still
produce the two shapes — `calc(50% - 3px)` a centred dot, a flat inset a line.

**One trap worth keeping.** The turn's line rendered at 0×0 for a while: the
other two lines are flex items and so are blockified, but this one sits inside
the bubble and was still an inline span, where `height` and `width` do nothing.

*The original design is named Terra*, not Neu — a name it held for one commit. A
stored choice naming the old family is migrated rather than dropped, the same way
a flat pre-axes choice is.

### 2026-08-20 — A theme choice has two axes, and the appearances are named

**What changed:** the picker was one flat list — System, Light, Dark, Airy, Airy
Dark. It is now two: a lighting row (System / Light / Dark) above a row of
designs (Neu / Air). A choice is `{ family, mode }`, and `familyAppearances`
combines them into one of four appearances. The appearances were renamed to
match what they are: `light`/`dark` became `neu-light`/`neu`, and `airy`/
`airy-dark` became `air`/`air-dark`.

**Why the flat list was wrong.** `system` was a peer of the designs, which made
it mean two things at once — follow the Mac, *and* use Rally's original
palette. Someone on Air had no way to say "this design, but follow the room";
picking System took the design away. Separating the axes says both things
independently, and it is the shape that keeps working when a third family
arrives: a flat list would have grown to seven entries, six of them pairs.

**The family never follows the Mac.** Only the lighting does. That is the
invariant the split exists to protect, and it has a test: a person on Air with
the system mode crosses between `air` and `air-dark` at sunset and is never
handed Neu.

**Two smaller things fell out of it.** The generator used to know the default
theme by name — `dark` — in four places, and the rename broke all four. A theme
now declares `"default": true` in its own file and the generator reads it, so a
future rename costs nothing. And a stored preference in the old flat shape is
migrated on read rather than dropped: `airy` still means Air, which is the
difference between a rename and a reset.

**Consequences:** `data-theme-choice` on the document is gone, replaced by
`data-theme-family` and `data-theme-mode`. Anything that wants to know whether
`dark` is deliberate or a resolved `system` reads the mode.

### 2026-08-20 — Airy became two themes, and the light one multiplies

**What changed:** the theme formerly called `airy` is now `airy-dark`, and
`airy` is its light counterpart — warm paper, the same structure, the same four
blooms. Its sidebar edge also changed: it had been an opaque brown line *darker*
than the ground it sat on, where the reference draws a faint warm hairline over
the backdrop.

**Why they are one theme and not two.** A test now asserts that every non-colour
token is identical between them. That is the claim being made: same spacing,
same type scale, same marker, same composer — one design at two brightnesses. If
a future change needs them to differ structurally, that is a signal they have
become separate themes and should be named as such, not a signal to delete the
test.

**Why the light field multiplies.** Ported additively first, and it was wrong in
a way worth recording: on a near-white ground an additive bloom only lightens
what is already light, so each orb read as a blown-out patch instead of colour.
`mix-blend-mode: multiply` darkens toward the pigment, the way ink does on
paper. That is also why the light alphas are roughly double the dark ones — they
are doing the opposite operation — and a future change must not "fix" the
asymmetry by matching them.

**How the light palette was built.** Not by hand: colour-typed tokens were taken
from the existing `light` theme, everything else from `airy-dark`, then the
reference's own values laid over the top. One thing that approach got wrong and
had to be corrected by looking at it — Airy sets several colours to
`transparent` outright (the message bubble, its border, the small shadow), and
those are decisions about the theme's *shape*, not its palette. Taking the light
theme's values there gave the light variant a bubble Airy does not have. Where
Airy removes something, both variants remove it.

**Consequences:** a stored preference of `airy` now selects the light variant.
Nothing is deployed, so nobody is switched from under themselves; if that changes
before release, the rename needs a migration rather than a note.

### 2026-08-20 — The navigation marks selection with a line, and the composer is a rule

**What changed:** two component shapes became a theme's decision.

*The row mark.* `cmp.marker.*` describes the mark at a row's leading edge, and
`cmp.row.background-selected` describes the fill behind a selected row. Airy sets
the fill to `transparent` and the mark to a 2px line; dark and light keep a dot
and a fill. Nothing else moved.

**Why one element rather than two.** The design shows a line where the
application had a status dot, and the obvious reading — delete the dot, add a
selection bar — loses information: the dot says which stream needs an answer and
which is running, and selection is already carried by the title's weight. So the
mark stayed one element with its *shape* themed and its *colour* left as state.
That is also why there is no `cmp.marker.color`: adding one would let a theme
quietly turn a status indicator into decoration.

**Why an inset and not a height.** A height token describes a dot and cannot
describe a line that runs the row, so it would have needed a second rule for the
case it could not express. Stretching between `inset-block` and the row covers
both: a centred dot is `calc(50% - 3px)`. Two traps found on the way, both worth
knowing: an absolutely positioned mark with a definite `height` silently ignores
its bottom inset, and the mark is two elements deep in the row, so the slot in
between needs `align-self: stretch` or the mark has nothing to stretch against.

*The composer.* One set of tokens builds a card or a rule. `rule-color-focus`
is not symmetry for its own sake — once the border is gone, the rule turning warm
is the only feedback left that the field is live, so flattening the frame forces
a theme to say what focus looks like.

**Not done:** Airy's own turns are still left-aligned. The reference right-aligns
them, and `cmp.turn.align` would carry it in one value, but left-alignment was
asked for explicitly and a mockup is weaker evidence than that. Worth confirming
before it changes. The reference's composer also labels its send control `SEND`
in letterspaced caps rather than drawing an arrow; that is markup, not a value,
and no token was invented to fake it.

### 2026-08-20 — A theme may bring fonts and a document that moves

**What changed:** three things a theme could not previously carry.

*Fonts are an asset, not a name.* A theme file has a `fonts` array; `bundled`
names a file that ships in the application, `url` names one the main process
fetches once and keeps under `userData`. Geist and Geist Mono are bundled and
every theme uses them. `Inter` had been named since the engine was written and
never shipped, so weight resolved against whatever the platform substituted —
which is why the type scale had two usable weights and the earlier changelog
entry recorded that weight could only be verified as computed values. It can be
looked at now.

*A backdrop may be a document.* `sys.backdrop.*` describes a floor, and Airy's
design is a field of light that orbits — no `background-image` orbits. The
alternative was a declarative motion vocabulary, which would have covered this
one case and none of the next; a theme brings HTML instead, and the generator
turns it into a page.

*What makes that safe is three mechanisms, not one.* Its own scheme so it never
holds the application's origin; `default-src 'none'` with no `connect-src` so it
cannot report that it ran; and `sandbox="allow-scripts"` without
`allow-same-origin` so its script sits in an opaque origin with no parent, no
storage, and no bridge. Verified in a running window rather than reasoned about:
`parent.location` throws, `fetch` throws, `localStorage` throws, and nothing
Rally-shaped is on `window`. A future change must not relax any one of the
three on the grounds that the other two hold — they cover different things.

The window's own policy now *skips* a backdrop response instead of attaching
alongside it, exactly as it already did for the message exporter, and for a
sharper reason: that policy ends in `frame-ancestors 'none'`, so attaching it
means the backdrop never renders at all.

**Two things went wrong on the way, and both are worth keeping.** The first cut
made the document transparent and let the shell's backdrop show through; a frame
on another origin gets Chromium's default *white* canvas, so the whole
application composited against white. The document paints the theme's floor
itself now, which is also the more honest description — a theme that brings a
document owns the whole backdrop. The second: `vw` looked right for bloom radii
until the Settings miniature sampled a window-sized field through a 92px
keyhole. Percentages of the positioning area work in both.

**Not done:** no shipped theme uses a remote font. The capability is tested
against a stubbed fetch rather than a live host, because a shipped theme that
fetched a font would put a first-run flash and a first-run request into every
install to demonstrate a feature nobody had asked for yet.

### 2026-08-20 — A theme is a JSON file, tokens are named by tier, and the window has one backdrop a theme can draw

**What changed:** `config/design-tokens/` is now the source of truth: a
`registry.json` declaring every token with its type and its prose, and one file
per theme supplying values. `scripts/build-theme-css.mjs` generates
`themes.css`; `pnpm tokens:check` runs in CI and fails on drift. Every token was
renamed to a three-tier dot-separated taxonomy (`ref` / `sys` / `cmp`) written
to custom properties under an `--av-` namespace — 189 tokens and about 1,300
references. Not one rendered value changed in the rename.

`sys.color.surface.wash` is gone. In its place is `sys.backdrop.*`, seven tokens
that are the CSS `background-*` longhands under their own names, painted on
`.workspace-shell` and nowhere else, with `cmp.pane.background` as the fill the
content pane draws over it. A test now names the only elements allowed to paint
the backdrop image. The work stream's composer dock lost its gradient in the
same change. The generator also began writing *every* token into *every*
theme's block instead of letting a theme fall through to `:root`.

**Why:** Asked for, and the flat CSS names had reached the point where they were
guesses. `--line` and `--line-3` were a semantic alias and a ramp step with
nothing in the name to say which; `--label-size` was typography while
`--label-height` was a layout band; `--brand-ink` and `--orange` were the same
colour under two names, as were `--gold` and `--yellow`. A tier prefix answers
"what kind of decision is this" before the reader has to know the system, which
is the property every reference cited converges on.

The wash was painted twice — once by the shell, once by the main pane — because
the pane was opaque and would otherwise have hidden the theme's light.
`background-attachment: fixed` was supposed to keep the two copies in register,
and does, but only while both elements are viewport-sized; the pane is not, and
Airy's glow stopped at the navigation's edge and started again beside it. The
fix is not a better way to synchronise two copies: it is one copy, with the
pane's fill made themeable so Airy can set it to `transparent` and let the
backdrop through. The composer dock's gradient went because the dock lays the
composer out as a grid row rather than floating it over the transcript, so the
gradient hid nothing and had only ever been invisible because it ended on the
pane's own colour. Under a transparent pane it became an opaque rectangle
cutting the backdrop off.

The backdrop token names are deliberately not new. Sizing, centring, tiling and
zoom all have answers that a decade of use has sanded smooth, and a theme that
wants `background-size: cover` should write exactly that rather than a synonym
invented here. What the theme file adds is the one step it cannot write by
hand: `image` accepts `{"svg": "…"}` for artwork drawn in the theme,
`{"url": "https://…"}` for one fetched over the network, `{"gradient": "…"}`,
and an array of those for a layer stack. Inline SVG is percent-encoded into a
data URI; it is rejected without the SVG namespace, and rejected if it aliases a
token, because a data URI is its own document and cannot read a custom property
— encoding the braces and moving on would have drawn the artwork in its
fallback colour under every theme.

Filling every theme's block out is what makes a nested `data-theme` work.
Inheritance worked while `data-theme` sat on the document, because
`[data-theme='light']` and `:root` match the same element and the more specific
block wins. It does not work for a nested element with a `data-theme` of its
own: an alias is substituted where it is declared, so
`--av-cmp-pane-background: var(--av-sys-color-surface-default)` on `:root`
resolves to the *dark* surface and inherits down regardless of the ramp
redeclared beneath it. The Settings miniature is that element, and the Light
swatch previewed a dark surface the moment the pane fill became an alias.

**Considered and rejected:**

- *Loading the JSON at runtime, so a person could drop in a theme file the way
  they can in VS Code.* Tempting, and the format now allows it, but the theme is
  applied before the first React render specifically so a launch shows no flash
  of the default; fetching and parsing JSON first would reintroduce exactly that.
  Generating at build time proves the format carries a whole theme without
  paying for it at startup, and leaves the runtime path open.
- *Keeping the hand-written CSS as the source and emitting JSON from it.* The
  wrong way round: the JSON would be a derived artefact nobody edits, which is
  how it goes stale, and the comments explaining each token would still have
  nowhere to live but the CSS.
- *Nesting the JSON by tier.* Flat dotted keys are what VS Code uses and they
  diff cleanly; a nested tree makes a one-token change a multi-line hunk and
  makes two themes hard to compare side by side.
- *A better way to keep two copies of the backdrop in register.* Two copies is
  the defect; one copy over a themeable pane fill removes it rather than
  synchronising it.

**Consequences:** Adding a theme is a JSON file plus an entry in `themeChoices`.
A number that decides an appearance belongs in that JSON, not in a rule.
`registry.json` is where a token's reasoning lives, and the generator writes it
into the stylesheet, so the prose survives in the place a reader meets it.
Renaming a token means renaming it in the registry, in every theme, and in
`app.css` together — the reference guard fails on a half-done rename, which is
the point.

Filling the blocks out costs a few kilobytes and makes `data-theme` mean the
same thing anywhere in the tree; a future change must not "optimise" the
repetition back out.

Two dead references surfaced during the rename and were fixed: `var(--mono)`
and `var(--muted-strong)`, both referenced but never defined since 1.100.0, so
two values had been rendering in the interface font instead of monospace and one
control had been taking whatever colour it inherited. Nothing would have caught
either before the guard existed.

Not done: the docks that genuinely float over a scrolling transcript still fade
to `sys.color.surface.default`. That is correct for a scrim — it has to hide what
passes under it — but in Airy it means the backdrop's light stops behind them.
Giving those a scrim that shows the backdrop needs a mask, and a mask over the
dock would take the composer inside it with it; it was not worth the complexity
for the small amount of glow involved.

Shipped in #TBD.

### 2026-08-19 — The type scale became themeable, and Airy went larger and lighter

**What changed:** The sizes the interface sets are tokens rather than numbers in
rules — prose, navigation row and hint, primary action, timestamp, author label,
and screen title — along with three weights beside the existing
`--weight-strong`. Airy runs prose at 16.5px against 14px and pulls every weight
back: headings to 480, emphasis to 500, `--weight-strong` from 500 to 450. Its
author label also picks up `--label-transform` and `--label-tracking`, so
"Rally" over a turn renders as letterspaced capitals the way a group label in
the navigation does.

**Why:** Asked for, and the reference carries its hierarchy with size and
letterspacing rather than with boldness — which the theme could not express while
the sizes were literals. Reusing the `--label-*` properties on the feed's author
was the part worth finding: it is the same kind of object as a navigation group
label, so a theme that asks for small capitals gets them in both places without
saying so twice.

**Considered and rejected:** Giving the work-stream feed its own author size and
weight tokens *in addition* to the base ones. The feed already overrode the base
rule with literals, and four tokens for one label is more vocabulary than the
distinction earns; two (`--text-feed-author`, `--weight-feed-author`) keep the
feed's deliberately smaller label without duplicating the whole family.

**Consequences, and a limit on how this was checked:** The renderer names `Inter`
but does not bundle it, so weight resolves against whatever the platform
substitutes. On macOS that is SF Pro, which is variable and honours 450 and 480
distinctly. In the Linux sandbox the substitute has two weights — everything at
or below 500 renders identically and 560 upward renders bold — so **the weights
here were verified as computed values, not as rendered glyphs**, and the sizes
are the only half a screenshot from CI or a sandbox can confirm. Anyone retuning
them should look on a Mac. Bundling the named family would remove the caveat and
is the obvious next step if type keeps moving.

Shipped in #TBD.

### 2026-08-19 — The navigation's own vertical rhythm became themeable

**What changed:** Six more measurements inside the navigation are tokens: a
row's padding (`--row-pad`), the leading of its two lines (`--row-leading`), the
gap between a row's title and its hint (`--row-hint-gap`), the floor under the
denser rows that carry both (`--row-height-dense`), and the band a group's label
sits in with the gap beneath it (`--label-height`, `--label-gap`). Airy's
`--group-gap` went to 60px and its `--label-gap` to 22px. A work-stream row in
Airy is now 61px against 37px, and the break between groups 60px against 28px.

**Why:** Airy's sidebar was still tight where it mattered most, and the reason
was a rule rather than a value. `.workstream-row` and `.note-row` set
`min-height: 30px` outright, which overrode `--row-height` on exactly the rows
that carry two lines — the ones with the most to gain from breathing. The
result was upside down: a two-line work-stream row rendered *shorter* (37px)
than a single-line automation row (46px), and no theme could reach it.

**Considered and rejected:** Raising `--row-height` alone. It has no effect on
those rows, because the `min-height` override replaced it; the number would have
moved and the sidebar would not.

**Consequences:** `--row-height` is the floor for a single-line row and
`--row-height-dense` for a row whose height comes from its content; a new row
kind should say which of the two it is rather than writing a third number. The
values here were fitted against the reference by proportion — the action pitch,
the two-line row pitch, the label-to-row gap and the group break, measured from
the running app rather than eyeballed — so a later change to the row's font
sizes will pull them out of true and they should be re-measured, not nudged.

Shipped in #TBD.

### 2026-08-19 — Where a person's own turn sits is a theme's decision

**What changed:** Three tokens — `--turn-align`, `--turn-margin`, and
`--turn-width` — decide whether your own messages hug the far edge of the feed
or sit in the same left-aligned column as the agent's. Airy takes the second:
every turn starts at the same left edge and runs the full column width.

**Why:** Asked for. The three move together because a turn that is left-aligned
but still capped at 72% reads as text that wraps early for no reason — the cap
only makes sense as the counterpart of hugging the opposite edge.

**Consequences, and one to watch:** `WorkstreamMessage` deliberately renders no
identity line above your own turn — "you know who you are" — and that held
because the right-aligned bubble was itself the attribution. Under a theme that
left-aligns and removes the bubble, nothing distinguishes your turn from
Rally's except that Rally's carries an author line and yours does not. The
alternation and the agent's label still make it inferable, and changing what the
interface *says* was out of scope for a change about where things sit, so the
suppression was left alone. A theme in this shape probably wants a `You · <time>`
line; that is a component change gated on a fourth token, not a restyle, and it
should be decided rather than inferred.

Shipped in #TBD.

### 2026-08-19 — Vertical rhythm became a theme's decision, and Airy took it

**What changed:** Five measurements that were fixed in the stylesheet are now
tokens — `--row-gap`, `--group-gap`, `--block-gap`, `--prose-gap`, and
`--leading-prose` — covering the gap between rows, between groups of rows,
between events in the feed, between paragraphs, and the leading of prose. Airy
roughly doubles all five and raises its leading to 1.85. Three more tokens carry
the fill behind a person's turn (`--bubble-fill`, `--bubble-edge`,
`--bubble-pad`); Airy sets all three to nothing, so a person's message sits on
the page as right-aligned text rather than in a bubble.

**Why:** Airy could change how much air the interface had *horizontally* — it
already owned the pane padding, the column width, and the row height — but
everything that spaces content *downward* was written into `app.css` as a
number. A theme whose entire premise is that negative space does the work of
borders could not act on the axis that matters most for reading. The bubble was
the same problem in a different place: the fill was `--raised-hover`, so a theme
could restyle it but never remove it.

**Considered and rejected:** Deriving the gaps from `--leading-base`, so a
theme would set one number and everything downstream would scale. The ratios are
not constant — a list wants tight rows and generous group breaks, and prose
wants the reverse — so a single multiplier produces a layout that is wrong in
two places for every one it gets right.

**Consequences:** A number that decides vertical spacing belongs in `themes.css`
now, not in a rule. `--bubble-pad` exists because padding without a fill is dead
space that holds the text off the edge it should sit against — a theme removing
the bubble must remove the padding with it, and the two are separate tokens
because a theme could plausibly want one without the other. Both `--prose-gap`
and `--leading-prose` reach the human turn as well as the agent's, the former
directly and the latter through a `calc()` that keeps the turn slightly tighter
than surrounding prose.

Shipped in #TBD.

### 2026-08-19 — The navigation is translucent, and does not float

**What changed:** Reverses [the floating navigation](#2026-08-19--the-navigation-floats-over-the-background)
above. The sidebar is flush to the window edge again, with a single divider at
its trailing edge, and `--sidebar-inset`, `--sidebar-radius`, `--sidebar-shadow`
and the derived `--sidebar-slot` are gone. In its place `--sidebar` is a
translucent tint rather than an opaque colour, so the background — and the light
a theme casts across it — reads through the navigation. `.workspace-shell` keeps
painting `--canvas` rather than `--surface`, because that is now what shows
through.

**Why:** The first answer solved the wrong problem. "Float over the background"
was read as *become a panel that hovers above it*, and what was meant was *let
the background show through*. Insetting the panel made the ground visible around
it; making it translucent makes the ground visible **behind** it, which is the
effect the reference has: one continuous lit surface, with the navigation
reading as a slightly warmer layer over it rather than as a separate object.

**Considered and rejected:** Keeping the inset and adding translucency on top.
Both at once reads as two competing ideas — a panel that hovers *and* dissolves —
and the gutter breaks the continuity that translucency exists to create.

**Consequences:** Anything drawn on the sidebar must not paint `--sidebar` again;
the account row now paints `transparent`, because a second application of the
tint over a surface already carrying it is visibly darker. Two tokens exist for
the states translucency cannot serve: `--sidebar-solid` for the narrow-width
drawer, which sits over the content and would otherwise show the work stream
through the navigation, and `--sidebar-edge` for the divider, which is the one
border Airy keeps after flattening the rest. `--canvas-wash` is painted with
`background-attachment: fixed` wherever it appears, so the shell's copy and the
main pane's stay in register; a per-element gradient put the same glow at two
different places and showed a seam down the sidebar's edge.

Shipped in #TBD.

### 2026-08-19 — The navigation floats over the background

**What changed:** The sidebar is inset from the window on three sides, rounded,
and shadowed, with `--canvas` showing in the gutter around it — the same
treatment the right rail already had. Three tokens carry it
(`--sidebar-inset`, `--sidebar-radius`, `--sidebar-shadow`) and one derived
token, `--sidebar-slot`, carries the room it occupies. `.workspace-shell` paints
`--canvas` rather than `--surface`, so the gutter shows the background and, in
Airy, the wash.

**Why:** Asked for directly, and the app already had the idiom: `.rail-surface`
floats at 8px with a radius and a shadow, so the navigation being welded to the
window edge made the two panels read as different kinds of object. The gutter
also gives Airy's corner light somewhere to land on the left of the window,
which it previously had only on the right.

**Considered and rejected:** Doing it for Airy alone with a
`[data-theme='airy']` rule in `app.css`. That is the third time this shape has
come up and the answer has not changed: once the stylesheet branches on the
theme, every later change costs one edit per theme. Expressing it as an inset
token means a theme that wants the panel flush sets `--sidebar-inset: 0` and
gets exactly the old layout back.

**Consequences:** `--sidebar-width` is now only the panel's own width, and
anything beside the navigation must measure `--sidebar-slot` — a rule that used
the width would overlap the panel by twice the inset. `--sidebar-slot` lives on
`.workspace-shell` because the resize handle writes `--sidebar-width` there
inline; moving it to `:root` would freeze the layout at the default width, and
nothing would look wrong until someone dragged the handle. The inset is bounded
near 12px by the macOS traffic lights, which a Linux sandbox cannot show.

Shipped in #TBD.

### 2026-08-19 — Borders moved onto a ramp of their own

**What changed:** Every border and outline in `app.css` — 114 declarations —
draws from a new six-step `--line-*` ramp instead of from `--n-*`. Airy's line
values sit within a few units of the surface they are drawn on, so its cards,
composer, sidebar edge, and message bubbles read as blocks of tone rather than
as boxes. Its `--n-1` came down with them, because the composer's fill was the
other half of what made it a box. `--n-4` upward is untouched.

**Why:** Airy is meant to draw with negative space, and it could not. A border
and a faint fill sit at the same contrast level, so on a single ramp they shared
a step — `--n-4` was the default border *and* the selected sidebar row, the
inline-code background, and every list hover. Flattening the border flattened the
selection, and the alternative, leaving the border visible, is the thing the
theme exists not to do. The conflation was invisible while only the dark theme
shipped, because there both roles want the same value.

**Considered and rejected:**

- *Compressing the low end of `--n-*` for Airy alone.* This is the one-line
  version and it is what exposed the problem: the selected work stream in the
  sidebar disappeared. The ramp cannot be compressed at a step that two roles
  share.
- *Theme-specific rules — `[data-theme='airy'] .card { border: 0 }`.* It would
  have worked and it ends the engine. Once `app.css` branches on the theme, every
  later change has to be made once per theme, which is the cost the token layer
  was built to avoid.
- *Setting Airy's borders to `transparent`.* Cheaper, but it removes the
  one-pixel edge that still separates a control from what is behind it at the
  extremes, and it leaves nothing for a focus state to shift *from*.

**Consequences:** A border may no longer name `--n-*`, and a test enforces it.
The dark theme is byte-identical at five of the nine steps that moved; the other
four shift 2–5 units of luminance across 23 of the 114 declarations, which is
below the threshold of visibility and was accepted rather than adding three more
steps to keep the mapping exact. `--line-6` is reserved for focus borders and is
the step Airy deliberately does not flatten. A theme that wants flat, borderless
chrome now changes six values; one that wants heavy chrome changes the same six.

Shipped in #TBD.

### 2026-08-18 — Colour became a theme's decision instead of the stylesheet's

**What changed:** `app.css` no longer contains a colour. Its 532 hardcoded hex
values and 44 `rgba()` literals were replaced by about ninety semantic tokens
declared in a new `themes.css`, once per theme, selected by `data-theme` on the
document. Three themes ship — the existing dark one, unchanged in value; a light
one; and Airy — with a `system` choice that follows the Mac, a picker in
Settings, and a device-local preference. The main process mirrors the resolved
theme so a window is constructed on the right canvas.

**Why:** Rally had one appearance and no way to add a second. The colours were
not merely hardcoded but *duplicated*: 268 distinct values, most of them within a
few units of luminance of a neighbour, so the same border was written eleven
different ways and no two surfaces that should have matched reliably did. That
made a second theme impossible in the ordinary sense — not hard, but unbounded,
because there was no list of what a theme would have to answer. Collapsing the
268 onto a fourteen-step ramp and five accent families is what turned "add a
light mode" into a finite job, and the collapse itself removed drift that had
been invisible while there was only one theme to see it in.

**Considered and rejected:**

- *Deriving each theme's ramp from two anchors with `color-mix()`.* It would
  have made a theme about a dozen declarations instead of ninety, and Chromium
  136 supports it. It was rejected because a light theme's ramp is not the dark
  one's inverse: light interfaces compress the faint end — white to `#f4f2ed` to
  `#ebe9e2` are almost nothing — and stretch the text end, and an interpolation
  that produces a good dark ramp produces a washed-out light one. Deriving them
  would have bought brevity in the file at the cost of the themes being right.
- *A single lightness ramp, with surfaces as positions on it.* This is the
  obvious shape and it does not survive contact with a light theme, where a
  raised control is greyer than the page while a raised control on a dark theme
  is lighter than it. Naming the nine surfaces outright and reserving the ramp
  for things that really are monotonic is what lets one rule serve both.
- *Storing the choice on the account.* An appearance belongs to the screen. The
  device record already existed for the region and the microphone.
- *Leaving the main process on a fixed `#111210`.* Every window has
  `show: false` until `ready-to-show`, so the flash is brief — but it is a flash
  of black on a light theme every time a window is resized, and the fix is one
  field and one channel.

**Consequences:** A colour written into `app.css` now fails a test rather than
shipping. A new theme is a block in `themes.css` and an entry in
`themeChoices`; it must restate every colour token, because the dark block is
also `:root` and an omission is silent. Anything that has to hand a colour to
JavaScript passes a `var()` string rather than a value — that is how the syntax
palette and the participant accents work, and it is the pattern to copy. The
exported message card and the application icon stay outside this and are named
above so the next person does not have to work out whether their omission was
deliberate. The window background is duplicated in `common/themes.ts` and a test
holds the two copies together; if a third consumer ever needs a token value
outside the stylesheet, extend that file rather than adding a second copy
somewhere else.

Shipped in #TBD.

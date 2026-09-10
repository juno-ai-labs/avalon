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
| `config/design-tokens/themes/light.json` | Rally's light token values and font declarations. |
| `config/design-tokens/themes/dark.json` | Rally's dark token values and font declarations. |
| `config/design-tokens/theme.schema.json` | Validates an appearance file. |
| `scripts/build-theme-assets.mjs` | Generates the renderer stylesheet and remote-font manifest. |
| `apps/desktop/src/renderer/styles/themes.css` | Generated light and dark custom-property blocks. |
| `apps/desktop/src/renderer/styles/app.css` | Component and layout rules expressed through semantic tokens. |
| `apps/desktop/src/common/themes.ts` | The shared `system | light | dark` preference and resolver. |
| `apps/desktop/src/renderer/lib/theme.ts` | Applies the resolved appearance, persists the preference, follows macOS, and synchronizes windows. |
| `apps/desktop/src/renderer/components/theme-picker.tsx` | The Appearance setting. |
| `apps/desktop/src/main/theme-assets.ts` | The private cache for a remote font declared by an appearance. |
| `packages/contracts/src/projects.ts` | `PALETTE_INK` — which of the two absolute inks each palette fill carries, and the reasoning behind the rule that picks it. |
| `apps/desktop/src/renderer/lib/project-palette.ts` | `glyphInk()`, resolving that table to the `palette-ink` token a glyph paints its symbol in. |
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
A previous object-shaped preference is accepted only as a migration input: its
`mode` becomes the scalar preference and its former family value is ignored.

Every visual value originates in the token registry and one of the two
appearance JSON files. `pnpm tokens:build` regenerates `themes.css` and
`common/theme-assets.ts`; `pnpm tokens:check` rejects drift. Bundled fonts are
addressed directly. If an appearance declares a remote WOFF2 URL, main fetches
it once, optionally verifies its integrity, stores it under `userData`, and
serves it through `rally-font://`.

## Invariants

- **There is one design and exactly two resolved appearances.** Adding a named
  theme family would restore UI and state the product no longer supports.
  Account-owned accent color is independent of this light/dark preference.
- **`system` is a preference, not a palette.** It must always resolve to light
  or dark before it reaches `data-theme`; otherwise the generated selectors do
  not provide a complete token set.
- **Renderer rules use semantic tokens.** A literal colour in `app.css` works in
  one appearance and bypasses the contrast decisions in the token files.
- **Both appearance files declare the full registry.** Inheritance between
  appearances makes a missing dark value silently render with the light value.
- **The shell owns the canvas background.** Repainting the same image or
  gradient on nested panes creates seams when the sidebar and feed differ in
  size.
- **The main-process window background matches the canvas token.** A mismatch
  flashes the wrong colour before the renderer's first frame.
- **A palette fill's ink is decided by APCA, not by the WCAG 2 ratio, and it is
  checked in.** `PALETTE_INK` is the table; sixteen of the nineteen fills take
  the near-white ink and `amber`, `lime` and `green` take the near-black one.
  The rule is deliberately not WCAG 2's, whose luminance curve misjudges
  saturated mid-tones, and the resulting shortfall against that standard is
  recorded rather than fixed — see the 2026-09-10 changelog entry for what is
  accepted and why.
- **Both palette inks are absolute.** A fill does not change with the
  appearance, so the ink over it must not either. `palette-ink-light` and
  `palette-ink-dark` hold the same values in both appearance files, and the
  `--personal-ink-*` pair swaps which neutral it points at precisely so that it
  does not invert.
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
- An appearance JSON file that omits a required token, names an undeclared
  token, uses an invalid value type, or duplicates the default fails the token
  build or its tests.

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

### 2026-09-10 — The group gap stopped being Airy's number

**What changed:** `sys.space.group.gap` goes from 60px to 14px in both themes,
and the four rules that existed only to escape it are gone —
`.workstreams-section` (22px), `.projects-section` (12px),
`.grokbot-shell .workstreams-section` (10px), and
`.grokbot-shell .sidebar-group` (14px). One selector went with them:
`.grokbot-shell .sidebar.is-compact .workstreams-section`, which had been
carrying enough specificity to beat the first two and is now covered by the
`.sidebar-section` beside it.

**Why:** 60px was Airy's, set by the 2026-08-19 entry below when Airy's whole
premise was that negative space does the work of borders. Airy is gone — the
2026-08-20 entry collapsed the family into one design at two brightnesses — but
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
what `registry.json` says this token is for: "Between one group of rows and the
next." The overrides were the team's revealed answer to what this break should
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

**Consequences:** `.workstreams-section` moves from 10px to 14px — the one
visible change beyond **Pinned**, accepted so the breaks in that rail are one
value rather than three. `.projects-section` now follows the token too, but
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

### 2026-09-08 — Give member messages independent appearance roles

Human message colors use `cmp.member-message.<profile-color>.background`,
`foreground`, and `dot`. Both appearance files declare all eight profiles.
These roles preserve the current colors while allowing light and dark tuning
without changing avatar or project colors. Components select a profile role;
they do not decide text contrast from a hard-coded list of hues.


### 2026-09-08 — Identity palette keys are stable; shades are appearance-specific

Projects and work streams store semantic color keys and resolve the shared
`sys.color.project.*` tokens. Each appearance may tune its values independently
for contrast. The registry no longer describes those shades as fixed across
appearances: stable identity means preserving the saved key, not identical RGB
values in light and dark. Existing palette values are unchanged.

### 2026-09-07 — Replace the stale orange palette with Rally neon yellow

Rally uses #ccff00, matching the public site's primary brand color. Both desktop
appearances now use that yellow for brand fills and the legacy orange swatch.
The stored swatch identifier remains compatible with existing user selections;
its onboarding label is Neon yellow. Export accents also use the yellow.
Brand marks and text stay black in light mode and white in dark mode for
legibility, replacing the temporary onboarding-only override. Brand fills use
dark foregrounds. Do not reintroduce the prior orange palette.


### 2026-09-05 — Add account-owned personal accents

Onboarding and Settings share a server-owned avatar/color editor. The selected
color derives sidebar and highlight accents from the existing project palette;
light/dark appearance remains device-owned. Bright colors use dark action text
for contrast. This avoids introducing another named theme for each color. The
[new-user onboarding module](new-user-onboarding.md) owns persistence and sync.

### 2026-09-05 — Align fatal and run recovery states with the theme

Fatal recovery shares the connection screen's rounded raised card and pill
action. Failed and stopped run notices use compact rounded surfaces, quieter
icon tiles and wrapping actions below the message so long diagnostics do not
compete with buttons for width. Semantic danger colors and all recovery behavior
remain unchanged; these scoped rules do not restyle unrelated alerts.

### 2026-09-05 — Bring connection recovery into the current visual language

The regional service error card now uses soft rounded grouped surfaces, quieter
icon treatment, compact typography and pill actions in both appearances. Styling
is scoped to recovery screens so onboarding does not inherit the change.
The endpoint, development guidance and recovery actions remain intact;
the screen scrolls in short windows and actions wrap at narrow widths.

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

### 2026-08-21 — The documents catch up with the two-axis picker

**What changed:** `docs/e2e.md`'s appearance acceptance step, the worked theme
file here, the `data-theme` example, and a new "Deliberately unfinished" list.

**Why:** the axes were split several commits before the documents were, and the
stale text was not merely out of date — it was actively wrong in ways that cost
someone time.

- The acceptance step asked a tester to choose Airy and confirm it *stopped*
  following the Mac. That is the exact bug the split exists to prevent, so
  following the step would have reported a working app as broken.
- The worked example carried `"id": "airy-dark"` against a file on disk named
  `air-dark`. Copying it produces a theme that fails the registry check.
- The `data-theme` example showed a `data-theme-choice` attribute that no longer
  exists; `applyTheme` sets `data-theme-family` and `data-theme-mode`. The
  paragraph's reasoning was still right, which is what made it hard to notice —
  it described the attribute that superseded it.

The changelog's own references to `airy` are left alone. They are correct as
history, and so is the one in the migration section, which is about reading a
preference an older build wrote.

**Why the unfinished list exists:** three reference-design items are knowingly
not done. They were stated in the pull request, which nobody reading this file in
a year can reach. A decision that is only in a review thread is a decision that
will be rediscovered as a bug.

**What a future change has to respect:** an acceptance step is executable
documentation — someone will follow it literally against a build they did not
write. Stale prose elsewhere misleads; stale prose there manufactures a defect
report.

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

### 2026-08-21 — A rebase can demote a heading, and nothing noticed

**What changed:** the eight changelog headings a rebase had truncated are
restored, and `scripts/check-document-headings.mjs` fails the build on the shape
they left behind.

**Why:** rebasing this branch onto a `main` 124 commits ahead ate `### 2026-0`
off the front of eight headings — seven here and one in `docs/security.md` that
was not even this branch's entry. The result is still valid Markdown, so nothing
failed: the line stays in the file, keeps its text, and merely stops being a
heading. It leaves the outline, and the entry it titled is swallowed into the
one above it. `docs/module-documents.md` makes the changelog the one section a
module document may not lose, so it earns a gate.

**Why the check is shaped the way it is:** it looks for the residue — a
date-like fragment followed by an em dash on a line that is not a heading —
rather than trying to validate headings in general. A general rule argues with
every document that has a reason to be unusual; this one only fires on damage
that has actually occurred. Fenced code is skipped, so a document explaining
this failure can show it.

**What a future change has to respect:** a merge conflict in prose does not
announce itself the way one in code does. There is no parser to reject it and no
test that reads for sense. When a rebase touches documents, diff the headings.

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

### 2026-08-21 — A stopped run gets its own hue

**What changed:** `sys.color.stopped.base`, and the two `main` features that
needed it — `.status-stopped .status-dot` and the `.run-stopped-notice` block —
now read from the theme rather than from literals.

**Why:** these arrived on `main` while this branch was open, written against the
stylesheet's old vocabulary (`--muted`, `--surface-2`, `--line`, `--ink`). The
rebase replayed the tokenisation over them, which left the notice pointing at
five variables that no longer exist and dropped the status dot entirely. The
`var()`-is-declared invariant caught the first; nothing could catch the second,
because a rule that is gone asserts nothing — it was found by diffing the
rebased tree against `main`.

**Why a new token rather than an existing one.** A stopped run is not a failure
and not a warning: someone halted it on purpose and nothing went wrong. Reusing
`danger` or `warning` would say otherwise in every theme, and the neutral ramp
has no warm step — `#a78668` is a dimmed ember with no equivalent anywhere in
the existing scales. The light appearances take it down to `#8a6a4d` so it holds
against a near-white ground; Air Dark lifts it to `#ab8a6d`.

**What a future change has to respect:** a feature that lands on `main` while a
theming branch is open will be written in whatever vocabulary `main` has. The
rebase will not flag it. Diff the rebased tree against `main` for the files both
sides touched, rather than trusting a clean replay.

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

### 2026-08-20 — Airy is lit by two circles, not two corners

**What changed:** `sys.backdrop.image` in Airy is two overlapping amber discs
sitting in the field — one at 67%/28%, one lower and left of centre at 52%/84% —
instead of the two corner washes it had.

**Why:** the corner washes were a guess at the reference, and the reference has
circles: discs with a discernible edge, placed in the canvas, overlapping, with
the corners of the window left near-black. Reading them as corner lights put the
brightness where the design had none and left the middle flat.

**Their radii are percentages, not `vw`.** `vw` was the first cut and it is
wrong: a percentage radius is relative to the *background positioning area*, and
the Settings miniature is a 92×58 swatch with its own. Sized in `vw` it sampled a
window-sized glow through a keyhole and previewed a flat brown block. The cost is
that a disc is only exactly circular at the aspect ratio the two percentages were
picked for; at other window shapes it stretches with the window, which is the
behaviour a full-window backdrop wants anyway. Do not "fix" that back to a
viewport unit without giving the swatch a backdrop of its own.

### 2026-08-20 — The window has one backdrop, and a theme can draw it

`sys.color.surface.wash` is gone. In its place is `sys.backdrop.*`, seven tokens
that are the CSS `background-*` longhands under their own names, painted on
`.workspace-shell` and nowhere else, with `cmp.pane.background` as the fill the
content pane draws over it.

The wash was painted twice — once by the shell, once by the main pane — because
the pane was opaque and would otherwise have hidden the theme's light.
`background-attachment: fixed` was supposed to keep the two copies in register,
and does, but only while both elements are viewport-sized; the pane is not, and
Airy's glow stopped at the navigation's edge and started again beside it. The
fix is not a better way to synchronise two copies: it is one copy, with the
pane's fill made themeable so Airy can set it to `transparent` and let the
backdrop through. A test now names the only elements allowed to paint the
backdrop image. The work stream's composer dock lost its gradient in the same
change — it lays the composer out as a grid row rather than floating it over the
transcript, so the gradient hid nothing and had only ever been invisible because
it ended on the pane's own colour. Under a transparent pane it became an opaque
rectangle cutting the backdrop off.

The token names are deliberately not new. Sizing, centring, tiling and zoom all
have answers that a decade of use has sanded smooth, and a theme that wants
`background-size: cover` should write exactly that rather than a synonym invented
here. What the theme file adds is the one step it cannot write by hand: `image`
accepts `{"svg": "…"}` for artwork drawn in the theme, `{"url": "https://…"}`
for one fetched over the network, `{"gradient": "…"}`, and an array of those for
a layer stack. Inline SVG is percent-encoded into a data URI; it is rejected
without the SVG namespace, and rejected if it aliases a token, because a data URI
is its own document and cannot read a custom property — encoding the braces and
moving on would have drawn the artwork in its fallback colour under every theme.

The generator also began writing *every* token into *every* theme's block
instead of letting a theme fall through to `:root`. Inheritance worked while
`data-theme` sat on the document, because `[data-theme='light']` and `:root`
match the same element and the more specific block wins. It does not work for a
nested element with a `data-theme` of its own: an alias is substituted where it
is declared, so `--av-cmp-pane-background: var(--av-sys-color-surface-default)`
on `:root` resolves to the *dark* surface and inherits down regardless of the
ramp redeclared beneath it. The Settings miniature is that element, and the Light
swatch previewed a dark surface the moment the pane fill became an alias. Filling
the blocks out costs a few kilobytes and makes `data-theme` mean the same thing
anywhere in the tree; a future change must not "optimise" the repetition back
out.

Not done: the docks that genuinely float over a scrolling transcript still fade
to `sys.color.surface.default`. That is correct for a scrim — it has to hide what
passes under it — but in Airy it means the backdrop's light stops behind them.
Giving those a scrim that shows the backdrop needs a mask, and a mask over the
dock would take the composer inside it with it; it was not worth the complexity
for the small amount of glow involved.

### 2026-08-20 — A theme is a JSON file, and tokens are named by tier

**What changed:** `config/design-tokens/` is now the source of truth: a
`registry.json` declaring every token with its type and its prose, and one file
per theme supplying values. `scripts/build-theme-css.mjs` generates
`themes.css`; `pnpm tokens:check` runs in CI and fails on drift. Every token was
renamed to a three-tier dot-separated taxonomy (`ref` / `sys` / `cmp`) written
to custom properties under an `--av-` namespace — 189 tokens and about 1,300
references. Not one rendered value changed.

**Why:** Asked for, and the flat CSS names had reached the point where they were
guesses. `--line` and `--line-3` were a semantic alias and a ramp step with
nothing in the name to say which; `--label-size` was typography while
`--label-height` was a layout band; `--brand-ink` and `--orange` were the same
colour under two names, as were `--gold` and `--yellow`. A tier prefix answers
"what kind of decision is this" before the reader has to know the system, which
is the property every reference cited converges on.

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

**Consequences:** Adding a theme is a JSON file plus an entry in `themeChoices`.
A number that decides an appearance belongs in that JSON, not in a rule.
`registry.json` is where a token's reasoning lives, and the generator writes it
into the stylesheet, so the prose survives in the place a reader meets it.
Renaming a token means renaming it in the registry, in every theme, and in
`app.css` together — the reference guard fails on a half-done rename, which is
the point.

Two dead references surfaced during the rename and were fixed: `var(--mono)`
and `var(--muted-strong)`, both referenced but never defined since 1.100.0, so
two values had been rendering in the interface font instead of monospace and one
control had been taking whatever colour it inherited. Nothing would have caught
either before the guard existed.

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

### 2026-08-19 — Airy has one ground, the full width of the window

**What changed:** Airy's `--sidebar` is `transparent` rather than a tint, and its
`--canvas` and `--surface` are the same colour. The page and the light across it
now run the full width of the window, under the navigation and the message feed
alike, with only `--sidebar-edge` between them. The other themes are unchanged:
they keep a tinted navigation over a distinct content pane.

**Why:** The tint and the second ground were each a seam. A translucent
navigation still reads as a *layer over* the page rather than as part of it, and
`--surface` sitting two units off `--canvas` put a faint edge down the middle of
a design whose whole idea is one continuous lit surface. Removing both is what
makes the light look like it belongs to the window rather than to two panes that
happen to agree.

**Considered and rejected:** Making `.main-pane` transparent and giving it a
`--pane-fill` token, so the shell's ground would show through it. That is the
general version and it needs a second token — the composer dock fades into the
pane to mask the feed scrolling under it, and a transparent pane leaves that
gradient with nothing to fade *to*, so it would have needed both a fill and a
"what the pane resolves to" colour. Setting `--surface` equal to `--canvas` gets
the same picture with no new vocabulary and no way for the two to drift.

**Consequences:** A theme now says "I have one ground" by making those two
tokens equal, and nothing in the stylesheet needs to know. Anything that fades
into the content pane — the composer dock is the one that exists — keeps fading
to `--surface`, which stays correct whether or not a theme has collapsed the
two. `background-attachment: fixed` on every `--canvas-wash` painter is now
load-bearing for the full-width read, not just for the navigation's edge.

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

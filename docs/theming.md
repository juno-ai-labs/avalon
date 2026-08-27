# Theming

A theme is a JSON file. `config/design-tokens/` holds one file per appearance
and a registry saying which tokens exist and what each one means; a build step
turns them into the stylesheet the renderer loads. Nothing in the interface
knows which theme is running, and no component reads a colour, so adding an
appearance costs a JSON file rather than an audit of a 3,800-line stylesheet.

Read this before adding a theme, adding a token, or writing a colour anywhere in
the renderer. Two rules carry the rest: **`app.css` names tokens and never a
colour**, and **`themes.css` is generated — edit the JSON**. A test fails if
either stops being true.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `config/design-tokens/registry.json` | Every token that exists, its type, and the prose explaining what it is for. The vocabulary. |
| `config/design-tokens/themes/*.json` | One appearance each: values for the registry's paths. The only place a colour is written down. |
| `config/design-tokens/*.schema.json` | JSON Schema for both, so an editor completes and validates them. |
| `scripts/build-theme-assets.mjs` | Turns the JSON into `themes.css`. `pnpm tokens:build` writes it; `pnpm tokens:check` fails on drift. |
| `apps/desktop/src/renderer/styles/themes.css` | **Generated.** The custom properties, one block per theme. |
| `apps/desktop/src/renderer/styles/app.css` | The rules. Names tokens; states no colour of its own. |
| `apps/desktop/src/common/themes.ts` | The vocabulary both processes share: the theme ids, `resolveTheme`, and each theme's window background. |
| `apps/desktop/src/renderer/lib/theme.ts` | Reading, applying, persisting, and re-resolving the choice. Stamps `data-theme`. |
| `apps/desktop/src/renderer/lib/device-preferences.ts` | Where the choice is stored, beside the region and the microphone. |
| `apps/desktop/src/renderer/components/theme-picker.tsx` | The Appearance control in Settings. |
| `apps/desktop/src/main/application-settings.ts` | `themeChoice`, the mirrored copy the main process paints a new window from. |
| `apps/desktop/tailwind.config.ts` | The Tailwind palette, pointed at the same tokens so a utility class cannot diverge. |
| `apps/desktop/src/main/theme-assets.ts` | The two asset schemes: the backdrop policy, and the remote-font cache. |
| `apps/desktop/src/renderer/components/theme-backdrop.tsx` | The sandboxed frame a backdrop document renders in. |
| `apps/desktop/src/renderer/fonts/` | Font files a theme may name as `bundled`, with their licences. |

## A theme file

Shaped after a VS Code colour theme — a little metadata and one flat map of
dotted keys, because flat keys diff cleanly and a nested tree does not:

```json
{
  "$schema": "../theme.schema.json",
  "id": "air-dark",
  "name": "Air Dark",
  "appearance": "dark",
  "description": "Near-black, amber, and a great deal of room.",
  "tokens": {
    "sys.color.surface.canvas": "#100e0c",
    "sys.color.text.default": "{ref.color.neutral.14}"
  }
}
```

`appearance` becomes `color-scheme`, so form controls and scrollbars match.
A value in braces aliases another token rather than repeating its value; the
generator turns it into a `var()` reference and a test rejects an alias that
leads back to itself.

A value may also be an object or an array of them, which is how a background
layer is written:

```json
"sys.backdrop.image": [
  { "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'>…</svg>" },
  { "url": "https://example.test/paper.avif" },
  { "gradient": "radial-gradient(80% 60% at 88% 8%, rgba(224, 140, 58, .09), transparent 62%)" }
]
```

An array is a CSS layer stack, first on top. `svg` is artwork drawn in the theme
file: the generator collapses its whitespace, swaps its double quotes for single
ones and percent-encodes what a `url()` cannot carry, then wraps the result in
`url("data:image/svg+xml,…")`. It must declare the SVG namespace or nothing
renders, and it may not alias a token — a data URI is its own document and cannot
read a custom property, so the generator rejects both rather than emitting a dud.
`url` must be `https:`, which is all the renderer's Content-Security-Policy
allows from the network.

## Fonts

A theme file has a `fonts` array beside its `tokens`, because a family name is a
wish and the file is the fact:

```json
"fonts": [
  { "family": "Geist", "weight": "100 900", "display": "block",
    "src": { "bundled": "geist-latin-variable.woff2" } },
  { "family": "Cadence", "weight": "400",
    "src": { "url": "https://fonts.example/cadence.woff2", "integrity": "sha256-…" } }
]
```

Every theme declares its own — a theme that inherited them would be one you
cannot read on its own — and the generator emits the union once, so switching
appearance never waits on a font.

**`bundled` names a file in `apps/desktop/src/renderer/fonts/`**, which ships
inside the application. That is what removes the substitution flash: the family
is present on the first paint, and `font-display: block` has nothing to block
on. Geist and Geist Mono are bundled for exactly this reason — the interface
named `Inter` for months without shipping it, so every weight resolved against
whatever the platform substituted and the type had two usable weights instead of
nine. Adding a file means adding its licence and a row in that directory's
`README.md`.

**`url` is fetched by the main process, once.** The stylesheet never names the
remote host; it names `avalon-font://cache/<id>.woff2`, where the id is a hash of
the URL. On a miss the main process fetches it, checks `integrity` if the theme
declared one, refuses anything empty or larger than 8 MB, and writes it under
`userData` through a rename so an interrupted launch leaves no half-file.
Nothing expires — a font at a URL is immutable in practice, and a theme that
wants different bytes changes the URL, which changes the id, which misses. A
renderer that asked the remote host itself would announce the reader to whoever
runs it, on every cold start, for as long as the theme was in use.

What that does not remove is the first fetch: a remote family is `swap`, so the
first launch on a new machine paints the fallback and swaps. A theme that wants
no flash at all bundles its font.

## A backdrop that moves

Some backdrops are not values. Both Air variants light the room with a field
that orbits, and there is no `background-image` that orbits — it needs a clock
and a frame loop. Rather
than invent a declarative motion vocabulary that would cover that one case and
none of the next, a theme may bring a whole document:

```json
"backdrop": {
  "description": "Four blurred blooms orbiting a shared centroid.",
  "html": "<div class=\"field\">…</div><style>…</style><script>…</script>"
}
```

The generator wraps it in a page, writes the theme's tokens in as custom
properties — a document on another origin inherits nothing from this one's
cascade — and gives it the theme's own `sys.backdrop.*` stack as its floor.
A theme that brings a document owns the whole backdrop.

### What a backdrop may do

Paint, and animate. That is the entire grant, and three mechanisms enforce it:

| Mechanism | What it withholds |
| --- | --- |
| Served from `avalon-backdrop://`, not the renderer's scheme | The application's origin, and whatever that origin is ever granted. |
| `default-src 'none'` with **no** `connect-src` | Every network call. A backdrop cannot report that it was rendered. |
| `sandbox="allow-scripts"`, **without** `allow-same-origin` | The parent document, storage, cookies, and the preload bridge. Its script runs in an opaque origin. |

All three are load-bearing. The policy without the sandbox attribute is still a
document that can read the application's DOM; the sandbox without the policy is
still a document that can phone home. `script-src 'unsafe-inline'` is the point
of the arrangement rather than a concession to it — the document exists to run
its own animation — and it is only safe inside the other two.

The window's own policy has to *skip* a backdrop response rather than add to it:
that policy ends in `frame-ancestors 'none'`, and a backdrop that cannot be
framed never renders. `isBackdropUrl` is the predicate that does it, for the same
reason the message exporter has one.

**A backdrop that animates must honour `prefers-reduced-motion`.** It is the one
piece of motion in the interface a reader cannot dismiss, scroll past, or wait
out. A test rejects a backdrop that starts a frame loop without naming the query.

Colours may be written down inside a backdrop document. It is part of the theme,
and a theme file is the one place a colour is allowed to be a literal — `app.css`
is not, and the difference is the whole engine.

Adding a theme is that file plus an entry in `themeChoices`. Everything else —
the picker, persistence, the window background — reads from those.

## How it works

### One attribute

`installTheme()` runs from the renderer entry point, before the first React
render, and sets two attributes on `<html>`:

```html
<html data-theme="air-dark" data-theme-family="air" data-theme-mode="system">
```

`data-theme` selects one block out of `themes.css`. The other two record what the
person actually picked, one attribute per axis, because a pinned Dark and
"system, currently dark" produce an identical `data-theme` and the Settings
picker has to tell them apart.

Nothing else in the renderer branches on the theme. No component reads a colour,
and no rule is written twice for two appearances.

### The token taxonomy

Names are dot-separated and **front-loaded by tier**, so a reader can tell what
kind of decision a token is from its first word. The three tiers are Material's
and the shape is GitLab's; the flat dotted keys are VS Code's.

| Tier | Means | Example |
| --- | --- | --- |
| `ref` | A primitive. A step on a ramp, with no opinion about where it is used. | `ref.color.neutral.4` |
| `sys` | A semantic decision. What the interface *means* by a value. | `sys.color.text.subtle` |
| `cmp` | One component's own decision, where no semantic token fits. | `cmp.sidebar.border` |

After the tier comes the category (`color`, `space`, `size`, `font`,
`elevation`), then the concept, then the variant, and any state last —
`sys.color.surface.raised-hover`, not `sys.color.hover.surface.raised`. Context
before property; the value never appears in the name, so a token called
`sys.color.danger.base` can stop being red without becoming a lie.

A path becomes a custom property by prefixing the namespace and swapping dots
for hyphens: `sys.color.text.default` is `--av-sys-color-text-default`. The
`--av-` namespace keeps Rally's properties apart from the ones Radix and
`tw-fade` set on their own elements.

Two structural decisions sit underneath the taxonomy and are worth
understanding before adding any token.

**Surfaces are named, and each theme declares them outright** —
`sys.color.surface.canvas`, `.default`, `.subtle`, `.sunken`, `.raised`,
`.raised-hover`, `.elevated`, `.elevated-hover`. Their *relationship* inverts
between light and dark: a dark theme makes a control recede by darkening it, a
light theme by greying it. Nothing derives one from another, because no
derivation is right in both.

**Everything monotonic lives on a ramp**, ordered by *contrast against the
surface* rather than by lightness, so a rule can name a step without knowing
which way round the theme runs. There are two. `ref.color.neutral.1` … `.14` is
the neutral ramp — fills at the faint end, text at the strong end.
`ref.color.line.1` … `.6` is the line ramp, and every border and outline draws
from it.

They were one ramp until Air needed borders that all but disappear. A border
and a faint fill sit at the same contrast level, so they shared a step: neutral
step four was simultaneously the default border and the selected sidebar row's
background, and making the border vanish took the selection with it. Separating
them lets a theme say "draw with space, not lines" in six values without
touching anything it fills.

On top of those sit the accent families — `brand`, `accent`, `success`,
`warning`, `danger` — named for what they mean rather than for the hue they
happen to be. Each carries the same roles:

| Role | What it is for |
| --- | --- |
| `base` | The hue itself: a fill, a dot, an icon. |
| `strong` | The hovered fill, or a brighter tone. |
| `soft` | The hue as text, readable on the surface. |
| `wash` | The hue as a tinted background block. |
| `edge` | The hue as a border on that block. |
| `on` | Text drawn on top of a filled swatch of the hue. |

`brand` carries `ink`, the brand drawn as a mark or a label on an ordinary
surface — a different question from `base`, because Rally's chartreuse is a
fine fill on white and an illegible label on it. `success` carries `fill` and
`fill-edge` for a filled control, which is neither the vivid hue nor the wash.

`registry.json` holds a prose explanation per group, and the generator writes
them into `themes.css` as comments. That file is where a token's reasoning
lives; the generated stylesheet is where a reader meets it.

### The backdrop

The window has **one** backdrop, painted by `.workspace-shell` and by nothing
else. The sidebar and the content pane sit on top of it, so a theme's ground and
whatever light it casts run the full width of the window, unbroken, under both.

`sys.backdrop.*` is that layer, and every token in it is a CSS `background-*`
longhand under its own name:

| Token | CSS property | What a theme uses it for |
| --- | --- | --- |
| `sys.backdrop.color` | `background-color` | The ground the artwork sits on. |
| `sys.backdrop.image` | `background-image` | Gradients, drawn SVG, a fetched image — one layer or a stack. |
| `sys.backdrop.position` | `background-position` | Where it centres. |
| `sys.backdrop.size` | `background-size` | Zoom: `cover`, `contain`, a percentage pair. |
| `sys.backdrop.repeat` | `background-repeat` | Tiling. |
| `sys.backdrop.attachment` | `background-attachment` | `fixed` anchors it to the viewport. |
| `sys.backdrop.blend-mode` | `background-blend-mode` | How the layers combine. |

Sizing, centring, tiling and zoom are not a vocabulary invented here. Every one
of them already has an answer that a decade of use has sanded smooth, and a
theme reaching for `background-size: cover` should be able to write exactly
that. What the theme file adds is the single step it cannot write by hand —
turning artwork into something a `url()` can carry.

### One mark, two shapes

A navigation row carries one mark at its leading edge. Its **shape** is the
theme's — `cmp.marker.*` — and its **colour** stays the row's state. Holding
those two apart is what lets Air flatten `cmp.row.background-selected` to
`transparent` and mark selection with a line instead, without the navigation
losing what the dot was saying: which stream needs an answer, and which one is
running.

The mark stretches between `cmp.marker.inset-block` and the row rather than
carrying a height, because that one mechanism describes both shapes — a centred
dot is `calc(50% - 3px)`, a line is however far in from the row's edges the theme
wants it to start. A height token would have needed a second rule for the shape
it could not express.

### A card, or a rule

The composer is built from one set of tokens either way. A card sets
`cmp.composer.background`, `border-color` and `radius`; a rule sets those to
nothing and gives `rule-color` a hairline, so the composer reads as a line the
page rests on rather than a box floating over it. Air takes the second.

`rule-color-focus` exists because of what the first shape hides: once the border
is gone, the rule turning warm is the only thing left saying the field is live.
A theme that flattens the frame has to say what focus looks like.

`send-background` follows the same frame. A flat composer carrying a raised
button reads as two surfaces disagreeing about which one the page is.

### Rendered markdown

Markdown's colours were tokens from the start — heading colour, links, the
blockquote rule, `li::marker`, the table header's fill, syntax highlighting.
Its **measurements** were not, and that is a different kind of gap:
`.markdown-body` takes its own size from `sys.font.size.prose`, so a theme that
raised its prose got larger paragraphs and headings that stayed where they were.
Air did exactly that, and rendered an `h2` at 16px under 16.5px body text.

`cmp.markdown.*` is the scale and the rhythm: four heading sizes, their leading
and margin, the weight `strong` and a table header share, list margin and
indent, blockquote and rule margins, table leading, and cell padding. The note
detail keeps a second, larger scale under `article-*`, because a note is read as
a document rather than as a turn in a transcript.

Two tests hold it. One asserts every heading is at least as large as its own
theme's prose and that the levels descend — `>=` rather than `>`, because a
level carried by weight alone is a decision, while one *below* the prose is a
caption. The other rejects a bare `px` font-size, weight or line-height inside a
`.markdown-body` rule, which is the guard that would have caught this: the
engine had one for colour and none for size.

### The navigation is translucent

`--av-cmp-sidebar-background` is a translucent tint rather than an opaque colour,
so the backdrop and the light across it read through the navigation.

A theme may take that to its conclusion. Air sets the tint to `transparent` and
`--av-cmp-pane-background` to `transparent` as well, so it has **one ground**:
the backdrop is the whole window, under the navigation and the message feed
alike, broken only by `--av-cmp-sidebar-border`. The other themes keep an opaque
content pane over the backdrop, which is why the pane's fill is a token at all
rather than the backdrop showing everywhere.

That fill is what the pane is *for*. It must never repaint the backdrop: the
shell and the pane each carried a copy once, so that the opaque pane would still
show the theme's light, and two copies of one gradient cannot be kept in
register — `background-attachment: fixed` holds them together only while both
elements are viewport-sized. A seam ran down the navigation's edge where Air's
glow stopped and started again. A test names the only two elements allowed to
paint `--av-sys-backdrop-image`: the shell, and the Settings miniature, which
draws the *offered* theme's backdrop at swatch scale.

Two states translucency cannot serve have tokens of their own:

| Token | Why it is not the tint |
| --- | --- |
| `--av-cmp-sidebar-background-solid` | The narrow-width drawer sits *over* the content. A see-through drawer shows the work stream through the navigation. |
| `--av-cmp-sidebar-border` | The single divider between navigation and content. A theme may keep it visible after flattening every other border, and Air does. |

Nothing drawn inside the sidebar may paint `--av-cmp-sidebar-background` again: the tint is
already on the surface beneath it, and applying it twice is visibly darker. The
account row at the foot of the navigation paints `transparent` for this reason.

### The families

A theme choice has **two axes**. A *family* is a design; a *mode* is which way
round to run it. They answer different questions — the family is a taste, the
mode is a lighting condition that may change during the day — so the picker
offers them as two rows rather than one list.

| Family | Light | Dark |
| --- | --- | --- |
| **Terra** — Rally's original palette | `terra-light` | `terra` |
| **Air** — amber light on a moving field | `air` | `air-dark` |

`familyAppearances` in `common/themes.ts` is the whole coupling: adding a family
is a row there and two theme files, and nothing else in either process learns a
new name. A test asserts every family brings both halves and no appearance
belongs to two families — a family missing one half is a family the mode row
cannot switch.

**The mode never changes the family.** `system` consults the Mac about the
*lighting* only, so someone on Air who is following the room crosses between
`air` and `air-dark` and is never handed Terra.

### One design at two brightnesses

Air's two appearances share more than a name: a test asserts that every token
which is not a colour is identical between them. Prose at 1.85 leading, roughly
double the vertical spacing, uppercase letterspaced micro-labels, a person's
turn with no bubble, a 2px line where Terra puts a dot, and a composer that is a
rule rather than a card.

What differs is the palette and, in one place that matters, the *blending*:

| | `air` | `air-dark` |
| --- | --- | --- |
| Ground | `#f7f3ec` warm paper | `#100e0c` near-black |
| Accent | `#d2822c` | `#e8a15c` |
| Field blending | `mix-blend-mode: multiply` | normal |
| Bloom alphas | ~.5 at the core | ~.32 at the core |

The blending is not a detail. On paper an additive bloom is glare: it lightens a
ground that is already near-white, so the orb reads as a blown-out patch rather
than as colour. Multiplying darkens toward the pigment instead, which is how ink
behaves on a page — and it is why the light field's alphas are roughly double
the dark field's and still land softer.

Only the warm bloom follows the brand token. The reference writes that one as
the accent and the other three as fixed hues, so a retint moves the light the
theme is named for and leaves the rest of the field where the design put it.

### Choosing one

The choice lives in `localStorage`, in the same `rally:device-preferences`
record as the selected region and the microphone. It is a device preference, not
an account one: an appearance belongs to the screen it is being looked at, and a
person who works on a bright laptop and a dark desktop should not have to keep
changing it back.

**Every open window follows.** A theme is a preference of the device, not of the
window it was chosen in: choosing one in the Settings window and having the work
stream behind it stay as it was is not a preview, it is a bug. The renderer
reports the choice it is drawing over `theme:set-window`, and the main process
relays `theme:changed` to every *other* window, which applies it. Relaying only
on a change is what stops it echoing — a window told to follow reports back, and
that report matches what main already holds and stops there.

The payload carries the **choice**, both axes, and the listener applies it rather
than re-reading the store. Applying it still re-resolves `system` against *that*
window's own `matchMedia`, which is the property re-reading the store was there
to get — but each window is a separate renderer process, and a `localStorage`
write in the window that made the choice is not ordered against an IPC round
trip through main. A window that re-read a store the write had not reached yet
would re-apply the old choice and report *that* back; main would see a
difference and broadcast again, and the guard that stops the echo would instead
be driving one. It settles once storage propagates; in the meantime it is a
flicker across windows.

It is stored as `{ family, mode }`. A record written by an earlier build holds a
flat name instead — `airy`, `dark` — and `parseThemeChoice` migrates it, because
a stored preference outlives the shape it was written in and a rename is not a
reason to hand somebody a different design.

The `system` mode — the default — resolves through
`matchMedia('(prefers-color-scheme: dark)')`, and `watchSystemAppearance()`
re-resolves it when the Mac changes. Only that mode listens: someone who pinned
Dark has said what they want.

### The window background

Electron needs a window's `backgroundColor` at construction, before any renderer
exists to ask. So the renderer reports its *choice* over the `theme:set-window`
channel, the main process stores it as `themeChoice` in
`application-settings.json`, and reads it back at startup before the first window
opens. The renderer stays authoritative; a disagreement resolves itself on the
next report.

**The choice travels, not the appearance**, and main re-resolves it against
`nativeTheme.shouldUseDarkColors` at the moment it builds each window. Two things
depend on that:

- **`system` survives a quit.** An appearance resolved under yesterday's Mac is
  not the appearance to open with today. Storing the resolved value meant a Mac
  that changed overnight opened the first window of the next launch in the old
  colour and corrected itself once the renderer ran — the flash this whole
  mechanism exists to prevent. Because the resolve happens per window rather than
  once at startup, it also follows a Mac that changes while Rally is running.
- **The relay can tell that a preference changed.** Two choices can resolve to
  the same appearance — Terra following a dark Mac, and Terra pinned to Dark —
  so comparing appearances reports no change for a move between them. Every
  other window would keep its old `data-theme-mode`, look identical in that
  moment, and be wrong at sunrise. `sameThemeChoice` compares both axes.

## Invariants

- **`themes.css` is generated.** Editing it works until the next
  `pnpm tokens:build` silently reverts you. `pnpm tokens:check` runs in CI
  through `pnpm test:scripts` and fails if the two disagree.
- **A theme sets only paths the registry declares**, and every alias points at a
  token that exists and never leads back to itself. A self-referential custom
  property is not a CSS error: the property resolves to nothing and every rule
  using it is dropped, so it surfaces as an unstyled interface rather than as a
  failure. Two tokens were exactly this during the taxonomy rename.
- **Every `var()` in `app.css` names a declared token.** With around 1,300
  references and names as long as `--av-sys-color-surface-raised-hover`, a
  transposition is a matter of time, and an unresolved property looks almost
  right rather than broken.
- **`app.css` contains no literal colour** — no hex, no `rgb()`/`hsl()`/`lab()`,
  no colour keyword, including inside a `color-mix()`. A literal that slips back
  in renders correctly under whichever theme it was sampled from and is invisible
  in every other one until somebody switches, which is exactly how the stylesheet
  accumulated 268 of them before this engine existed. `themes.css.node.test.ts`
  is the only thing that catches the 269th.
- **Every theme restates every token whose value is a colour.** The dark block is
  also `:root`, so an omitted token silently inherits a dark colour: a light theme
  missing `--av-cmp-tooltip-foreground` draws near-black on near-black, nothing else looks
  wrong, and nobody finds it until a person hovers something. Lengths, font
  stacks, and aliases onto a ramp are deliberately left to the generator to
  fill in.
- **Every theme's block declares every token.** The generator fills in what a
  theme was content to inherit, because falling through to `:root` works only
  while `data-theme` is on the document. An alias is substituted where it is
  *declared*, so a nested element carrying a different `data-theme` inherits the
  default theme's already-resolved colour and redeclaring the ramp beneath it
  changes nothing. The Settings miniature is exactly that element, and it
  previewed a dark surface under the Light swatch until the blocks were filled
  out.
- **A backdrop document may paint and nothing else.** Its own scheme, a policy
  with no `connect-src`, and a frame sandboxed without `allow-same-origin`. All
  three, every time; any two of them is a hole.
- **A backdrop that animates honours `prefers-reduced-motion`.** It is the one
  piece of motion a reader cannot dismiss, scroll past, or wait out.
- **The renderer never names a remote font host.** It names
  `avalon-font://cache/<id>.woff2`; the main process is the only thing that
  fetches. A stylesheet pointing at `https://` is a per-launch beacon.
- **A markdown heading is never smaller than its prose**, and rendered markdown
  takes no size from a literal. The colour guard could not see a type scale, and
  a whole one leaked past it.
- **A row's mark keeps its state colour.** A theme may reshape it; a theme that
  recoloured it would be a theme that removed information.
- **Every family brings both appearances, and no appearance belongs to two.**
  A family missing one half is a family the mode row cannot switch — the row
  would be there with a position that does nothing.
- **A theme change reaches every window.** One preference, one appearance
  everywhere; a window that kept its own would make the Settings preview a lie.
- **The family never follows the Mac.** Only the lighting does. Switching
  somebody out of the design they chose, at sunset, is the bug the flat list
  made easy.
- **The backdrop is painted once.** Only `.workspace-shell` and the Settings
  miniature may name `--av-sys-backdrop-image`; anything else that paints it
  draws a second copy of one gradient and shows a seam where the two disagree.
- **The backdrop document is mounted by the main window alone.** The standalone
  Settings and meeting windows keep a flat `surface-default` ground: both are
  dense forms, and a field of moving light behind one costs more legibility than
  it buys. On Air that does mean the two windows differ side by side, since
  Settings opens over the work stream — a decision, not an oversight, and the
  one place the "one appearance everywhere" rule below is knowingly relaxed. The
  *choice* still reaches those windows; only the document does not. A test pins
  which surfaces mount `ThemeBackdrop`, because the painted-once guard above
  looks for a second copy and would never notice a missing one.
- **Both ramps are monotonic in contrast against the surface**, in every theme.
- **Lines come off `--av-ref-color-line-*` and fills come off `--av-ref-color-neutral-*`.** A border that reaches
  back onto the neutral ramp re-creates the coupling the split exists to remove,
  and does it silently — it looks right in whichever theme it was written
  against. A test rejects any `border` or `outline` declaration naming `--av-ref-color-neutral-*`.
- **A focus border stays visible in every theme.** `--av-ref-color-line-6` is the one step
  Air does not flatten; an invisible focus indicator is an accessibility defect,
  not a design choice.
- **No component reads a colour.** Two places would otherwise have to: the
  `prism-react-renderer` theme and the per-participant accent, both of which take
  JavaScript values. Both pass `var(--av-sys-color-syntax-*)` and `var(--person-accent)` strings into
  inline styles, which resolve against the element's cascade like any other
  reference — **in the renderer**. The message exporter re-hosts that same markup
  in a standalone document that loads none of this, so it declares the syntax
  tokens itself from the generated `exportSyntaxPalette`; a `var()` that resolves
  nowhere is invalid at computed-value time and falls back to the inherited
  colour, which for a code block is near-black on near-black. Anything else that
  serializes rendered markup out of the renderer inherits that obligation.
- **`themeWindowBackground` equals each theme's own `--av-sys-color-surface-canvas`.** It is the one
  value written down twice, and a test compares the copies.
- **The Tailwind palette resolves to tokens, never to literals.** It is currently
  unused by any component; literal values there were a silent second copy of the
  dark theme waiting for the first person to type `bg-surface`.

## Boundary

This module owns how the renderer decides what a colour is, and the persistence
and resolution of the choice behind it. It does not own layout, component
structure, or any individual rule in `app.css` beyond the requirement that the
rule name tokens.

It deliberately does **not** theme two surfaces:

- **The exported message card** (`apps/desktop/src/main/message-export.ts`) is a
  fixed light artefact rendered in a hidden window outside the renderer's
  document, and stays that way whatever the app theme is — a saved PNG is a
  document, not a screenshot of the app. Being unthemed is not the same as being
  token-free: its `:root` declares the default theme's `sys.color.syntax.*` from
  the generated `exportSyntaxPalette`, because the highlighted code it embeds
  names those tokens in inline styles and nothing else in that document defines
  them. See [`message-export.md`](message-export.md).
- **The application icon** has its own light/dark pair driven by `nativeTheme` in
  the main process, and follows the Mac rather than the in-app theme. Choosing
  Air does not change the Dock icon.

The main process depends on this module only for `common/themes.ts`; it never
reads a stylesheet.

## Failure modes and limits

- **A theme the build no longer has**, found in a stored preference, is dropped by
  the preference parser and the choice falls back to `system`. The rest of the
  record — region, workspace name, microphone — survives, because losing those to
  an appearance is a far worse outcome than an appearance reverting.
- **No `matchMedia`** — jsdom has none, and an Electron window may not early
  enough to be certain of — resolves `system` to light, which is what Chromium
  answers when the platform expresses no preference, and subscribes to nothing.
- **`setWindowTheme` failing** is swallowed. Nothing the renderer draws depends
  on it; the cost is that the next window opens on the previous theme's canvas.
- **A light theme's switch knob** is white on a grey track at about 1.9:1, below
  the 3:1 a graphical control would ideally hold. The knob carries a
  `--av-sys-elevation-shadow-sm` lift, and the state is also conveyed by its position and by the
  track turning green. This is the same trade every light-mode switch makes and
  it was accepted deliberately; a track dark enough for 3:1 reads as *on*.
- **A theme whose backdrop is a document previews as its floor.** The Settings
  miniature draws `sys.backdrop.*`, and Air's blooms live in its document rather
  than in those tokens, so the Air swatch is a flat ground. Mounting a live
  frame per swatch would put four animation loops behind a preference pane to
  show a 92px thumbnail of one.
- **Themes are not animated.** Switching repaints immediately, and the reported
  window background applies to the *next* window rather than the current one.

### Deliberately unfinished

Three things the reference designs specify that Air does not do yet. They are
here rather than only in the pull request that raised them, because a pull
request description is not reachable from the repository.

- **A person's own turn is left-aligned in Air.** Both reference files use
  `align-self: flex-end`, which would put it on the right as Terra does. Left is
  a deliberate instruction that overrides the files, and `cmp.turn.align` is the
  one token that changes it if that is revisited.
- **The send control is a bare arrow.** The reference is an uppercase
  letterspaced label beside it with no button frame. That is markup rather than
  a token, so it is not a theme's decision to make as things stand — a theme
  that wanted the label would need the composer to offer one.
- **There is one row hover.** The reference distinguishes three —
  navigation actions, the automation row, and stream rows — where
  `cmp.row.background-hover` covers all of them; only the stream value matches.
  Pressed and focus states are absent from the reference files entirely and are
  unchanged from Terra.

## Testing

| Suite | What it covers |
| --- | --- |
| `scripts/build-theme-css.test.mjs` | The JSON half: that the committed stylesheet is what the JSON produces, that themes set only declared paths, that aliases resolve and never cycle, that every theme restates every colour and declares every token, that both ramps are ordered by contrast, and that a backdrop layer — gradient, fetched URL, or drawn SVG — becomes the CSS it should. Runs in CI through `pnpm test:scripts`. |
| `src/renderer/styles/themes.css.node.test.ts` | The structural invariants: no literal colour in `app.css`, every `var()` naming a declared token, lines coming off the line ramp, the navigation tint and the backdrop each painted once, and the duplicated window background. Runs against the files on disk. |
| `src/main/theme-assets.test.ts` | The backdrop policy and URL parsing, and the font cache: fetch-once, integrity, the size limit, concurrent asks collapsing to one request, and a 404 for every id no theme declared. |
| `src/common/themes.test.ts` | Resolution and parsing, including that a deliberate choice is never overridden by the Mac. |
| `src/renderer/lib/theme.test.ts` | Applying, persisting, the `system` watcher, and the unknown-theme fallback. |
| `src/renderer/components/theme-picker.test.tsx` | The picker, including that each swatch previews with its own `data-theme`. |
| `src/renderer/lib/device-preferences.test.ts` | That an unknown theme is dropped without discarding the record. |

Run them with `pnpm --filter @rally/desktop test`.

Two traps. The stylesheet tests read from disk rather than importing, because
Vite hands `?raw` an empty string for a file it is already processing as CSS;
they are named `.node.test.ts` so `node:fs` stays out of the renderer program.
And jsdom implements no `matchMedia`, so a test that needs one installs it with
`Object.defineProperty` rather than `vi.stubGlobal` — `unstubGlobals` reverts
stubs before each test and would take the installation with it.

None of this says whether a theme is *legible*. That needs a real window: run the
client under Xvfb and read the screens, per
[`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it). Two of
the defects fixed on the way in — a near-black label on a near-black fill in
Air, and Rally's chartreuse mark on white — passed every assertion above.

## Changelog

### 2026-08-27 — The logo draws from the brand pair, not from each theme's brand

**What changed:** `sys.color.brand.mark` joins the brand group, and it takes only
two values across all four themes: `#ccff00` on the dark ones and `#111210` on
the light ones. Every drawing of the logo paints from it — the turning mark on
the sign-in card, the home heading and the new-automation intro, and the still
`.rally-mark` everywhere else. `brand.ink` keeps its value and is still what
every other brand-coloured thing in the stylesheet uses: eyebrows, mention chips,
selected indicators, the streaming caret.

**Why:** `brand.ink` is each theme's reading of the brand *as a legible label*,
which is why Terra Light darkens it to olive and both Air themes make it orange.
That is right for an eyebrow or a mention chip and wrong for the logo, which the
brand draws two ways and only two: chartreuse on a dark ground, near-black on a
light one. Reusing `ink` gave the sign-in screen an olive logo on one theme and
an orange one on another.

**Considered and rejected:** Chartreuse in every theme, which is what this token
held first and what was reverted before it shipped. On the light themes' cream
`#ccff00` is lower contrast than the olive it replaced, and the 13px marks in
settings and automation rows came out looking faded rather than bright. Also
rejected: changing `brand.ink` itself, which carries about thirty rules that are
not the logo — eyebrow text, the mention chip, the region check, the streaming
caret — where chartreuse as label text on a light surface is close to invisible,
the case the brand group's own prose already warns about. Splitting the logo out
is what lets the mark follow the brand without taking the label rules with it.
And rejected: writing either hex into `app.css` beside the mark rules, which is
the one thing this engine exists to prevent and which a test refuses.

**What a future change has to respect:** a theme picks one of the two brand
values by whether its background is light or dark, and does not invent a third.
The completeness rule already forces every theme to state this token; what this
entry adds is that its *value* is not a per-theme design choice. A theme that
wants a third value is deciding the logo is wrong in its world, which is allowed
and should be deliberate. Both Air themes now draw the mark in the brand pair
rather than in their own orange.

Shipped in TBD.

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

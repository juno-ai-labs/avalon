# Theming

Every colour, radius, and unit of breathing room the desktop renderer draws with
is a CSS custom property declared in one file, and a theme is a block of those
properties rather than a fork of the stylesheet. This is what makes a new
appearance cost about ninety declarations instead of an audit of a 3,800-line
stylesheet, and what stops a component from ever needing to know which theme is
running.

Read this before adding a theme, adding a token, or writing a colour anywhere in
the renderer. The rule that everything else follows from is short: **`app.css`
names tokens and never a colour**, and a test fails if that stops being true.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/styles/themes.css` | Every token value, once per theme. The only file in the renderer where a colour is written down. |
| `apps/desktop/src/renderer/styles/app.css` | The rules. Names tokens; states no colour of its own. |
| `apps/desktop/src/common/themes.ts` | The vocabulary both processes share: the theme ids, `resolveTheme`, and each theme's window background. |
| `apps/desktop/src/renderer/lib/theme.ts` | Reading, applying, persisting, and re-resolving the choice. Stamps `data-theme`. |
| `apps/desktop/src/renderer/lib/device-preferences.ts` | Where the choice is stored, beside the region and the microphone. |
| `apps/desktop/src/renderer/components/theme-picker.tsx` | The Appearance control in Settings. |
| `apps/desktop/src/main/application-settings.ts` | `windowTheme`, the mirrored copy the main process paints a new window with. |
| `apps/desktop/tailwind.config.ts` | The Tailwind palette, pointed at the same tokens so a utility class cannot diverge. |

## How it works

### One attribute

`installTheme()` runs from the renderer entry point, before the first React
render, and sets two attributes on `<html>`:

```html
<html data-theme="airy" data-theme-choice="airy">
```

`data-theme` selects one block out of `themes.css`. `data-theme-choice` records
what the person actually picked, because `dark` and "system, currently dark"
produce an identical `data-theme` and the Settings picker has to tell them apart.

Nothing else in the renderer branches on the theme. No component reads a colour,
and no rule is written twice for two appearances.

### The token vocabulary

Tokens fall into two kinds, and the difference is the one design decision worth
understanding before adding any.

**Surfaces are named, and each theme declares them outright** — `--canvas`,
`--sidebar`, `--surface`, `--surface-2`, `--sunken`, `--raised`,
`--raised-hover`, `--elevated`, `--elevated-hover`. Their *relationship* inverts
between light and dark: a dark theme makes the sidebar recede by darkening it
below the content pane, a light theme by greying it above one. Nothing derives
one from another, because there is no derivation that is right in both.

**Everything monotonic lives on a ramp**, ordered by *contrast against the
surface* rather than by lightness, so a rule can name a step without knowing
which way round the theme runs. There are two, and the split is the second
design decision worth understanding.

`--n-1` … `--n-14` is the neutral ramp: fills at the faint end, text at the
strong end. `--line-1` … `--line-6` is the line ramp, and every border and
outline in the stylesheet draws from it — a divider you should barely see, the
default border, one that should read, one under the pointer, one on an engaged
control, and a focus border.

They were one ramp until Airy needed borders that all but disappear. A border
and a faint fill sit at the same contrast level, so they shared a step: `--n-4`
was simultaneously the default border and the selected sidebar row's background.
Making the border vanish took the selection with it. Separating them lets a
theme say "draw with space, not lines" in six values without touching anything
it fills. A test asserts the monotonicity of both.

On top of those sit the accent families — `brand`, `blue`, `green`, `gold`,
`red` — each with the same six roles:

| Role | What it is for |
| --- | --- |
| `--<f>` | The hue itself: a fill, a dot, an icon. |
| `--<f>-strong` | The hovered fill, or a brighter tone. |
| `--<f>-soft` | The hue as text, readable on the surface. |
| `--<f>-wash` | The hue as a tinted background block. |
| `--<f>-edge` | The hue as a border on that block. |
| `--<f>-on` | Text drawn on top of a filled swatch of the hue. |

`brand` carries two extras. `--brand-ink` is the brand drawn as a mark, a label,
or a one-pixel line on an ordinary surface, and it is a different question from
`--brand`: Avalon's chartreuse is a fine fill on white and an illegible label on
it. `--brand-on` is the dark text that goes on a chartreuse fill. `green` carries
`--green-fill` and `--green-fill-edge` for a filled control — a switch that is
on, a selected preset — which is neither the vivid hue nor the wash.

The rest is geometry (`--radius-*`), density (`--sidebar-width`, `--row-height`,
`--control-height`, `--pane-pad`, `--stack-gap`, `--feed-width`,
`--feed-width-wide`, `--feed-pad-x`, `--feed-pad-y`), type (`--font-*`,
`--text-base`, `--leading-base`, `--weight-strong`, and the four `--label-*`
properties that decide whether a section heading is sentence case or letterspaced
small capitals), depth (`--shadow-*`, `--scrim*`, `--ring*`), and a handful of
things that oppose the theme on purpose: `--tooltip-bg`, `--tooltip-ink`,
`--ink-on`, `--ink-hover`, `--toggle-track`, `--toggle-knob-off`. A tooltip is
light on a dark theme and dark on a light one, so it cannot be a ramp step in
either.

`--canvas-wash` is a `background-image` rather than a colour, painted on `body`,
`.workspace-shell`, and `.main-pane`, always with `background-attachment: fixed`
so every copy is anchored to the viewport and stays in register with the others.
Most themes set it to `none`; Airy uses it for the light in the corner, which no
single element could own.

### The navigation is translucent

`--sidebar` is a translucent tint rather than an opaque colour, so the
background and whatever light a theme casts across it read through the
navigation. `.workspace-shell` paints `--canvas` for that reason — it is what
shows through, and painting `--surface` there would put the content pane's tone
behind the navigation instead of the page's.

A theme may take that to its conclusion. Airy sets `--sidebar: transparent` and
makes `--canvas` and `--surface` the same colour, so it has **one ground**: the
page and the light across it run the full width of the window, under the
navigation and the message feed alike, broken only by `--sidebar-edge`. The
other themes keep a distinct content pane, which is why the two are separate
tokens at all.

Continuity across that whole width is what `background-attachment: fixed` buys.
`.workspace-shell` and `.main-pane` each paint `--canvas-wash`, and a gradient
positioned per-element would put the same glow at two different places and show
a seam down the navigation's edge; anchored to the viewport, the two copies are
in register and read as one light.

Two states translucency cannot serve have tokens of their own:

| Token | Why it is not the tint |
| --- | --- |
| `--sidebar-solid` | The narrow-width drawer sits *over* the content. A see-through drawer shows the work stream through the navigation. |
| `--sidebar-edge` | The single divider between navigation and content. A theme may keep it visible after flattening every other border, and Airy does. |

Nothing drawn inside the sidebar may paint `--sidebar` again: the tint is
already on the surface beneath it, and applying it twice is visibly darker. The
account row at the foot of the navigation paints `transparent` for this reason.

### The themes

`light` and `dark` are the two `system` resolves to. `airy` is a deliberate
choice only — one near-black ground lit from a corner and running the full width
of the window, amber where the others are chartreuse, borders that barely exist,
uppercase letterspaced micro-labels, and roughly half again the spacing, so
negative space does the work the lines used to.

### Choosing one

The choice lives in `localStorage`, in the same `avalon:device-preferences`
record as the selected region and the microphone. It is a device preference, not
an account one: an appearance belongs to the screen it is being looked at, and a
person who works on a bright laptop and a dark desktop should not have to keep
changing it back.

`system` — the default — resolves through `matchMedia('(prefers-color-scheme:
dark)')`, and `watchSystemAppearance()` re-resolves it when the Mac changes.
Only `system` listens. A person who asked for Airy has said what they want.

### The window background

Electron needs a window's `backgroundColor` at construction, before any renderer
exists to ask. So the renderer reports its resolved theme over the
`theme:set-window` channel, the main process stores it as `windowTheme` in
`application-settings.json`, and reads it back at startup before the first window
opens. The renderer stays authoritative; a disagreement resolves itself on the
next report.

## Invariants

- **`app.css` contains no literal colour** — no hex, no `rgb()`/`hsl()`/`lab()`,
  no colour keyword, including inside a `color-mix()`. A literal that slips back
  in renders correctly under whichever theme it was sampled from and is invisible
  in every other one until somebody switches, which is exactly how the stylesheet
  accumulated 268 of them before this engine existed. `themes.css.node.test.ts`
  is the only thing that catches the 269th.
- **Every theme restates every token whose value is a colour.** The dark block is
  also `:root`, so an omitted token silently inherits a dark colour: a light theme
  missing `--tooltip-ink` draws near-black on near-black, nothing else looks
  wrong, and nobody finds it until a person hovers something. Lengths, font
  stacks, and the `var(--n-*)` aliases are deliberately inherited.
- **Both ramps are monotonic in contrast against the surface**, in every theme.
- **Lines come off `--line-*` and fills come off `--n-*`.** A border that reaches
  back onto the neutral ramp re-creates the coupling the split exists to remove,
  and does it silently — it looks right in whichever theme it was written
  against. A test rejects any `border` or `outline` declaration naming `--n-*`.
- **A focus border stays visible in every theme.** `--line-6` is the one step
  Airy does not flatten; an invisible focus indicator is an accessibility defect,
  not a design choice.
- **No component reads a colour.** Two places would otherwise have to: the
  `prism-react-renderer` theme and the per-participant accent, both of which take
  JavaScript values. Both pass `var(--code-*)` and `var(--person-*)` strings into
  inline styles, which resolve against the element's cascade like any other
  reference.
- **`themeWindowBackground` equals each theme's own `--canvas`.** It is the one
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
  document, not a screenshot of the app. See [`message-export.md`](message-export.md).
- **The application icon** has its own light/dark pair driven by `nativeTheme` in
  the main process, and follows the Mac rather than the in-app theme. Choosing
  Airy does not change the Dock icon.

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
  `--shadow-sm` lift, and the state is also conveyed by its position and by the
  track turning green. This is the same trade every light-mode switch makes and
  it was accepted deliberately; a track dark enough for 3:1 reads as *on*.
- **Themes are not animated.** Switching repaints immediately, and the reported
  window background applies to the *next* window rather than the current one.

## Testing

| Suite | What it covers |
| --- | --- |
| `src/renderer/styles/themes.css.node.test.ts` | The structural invariants: no literal colour in `app.css`, every theme restating every colour token, ramp monotonicity, and the duplicated window background. Runs against the files on disk. |
| `src/common/themes.test.ts` | Resolution and parsing, including that a deliberate choice is never overridden by the Mac. |
| `src/renderer/lib/theme.test.ts` | Applying, persisting, the `system` watcher, and the unknown-theme fallback. |
| `src/renderer/components/theme-picker.test.tsx` | The picker, including that each swatch previews with its own `data-theme`. |
| `src/renderer/lib/device-preferences.test.ts` | That an unknown theme is dropped without discarding the record. |

Run them with `pnpm --filter @avalon/desktop test`.

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
Airy, and Avalon's chartreuse mark on white — passed every assertion above.

## Changelog

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

**Why:** Avalon had one appearance and no way to add a second. The colours were
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

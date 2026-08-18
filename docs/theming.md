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

**Everything monotonic lives on the `--n-*` ramp**, fourteen steps running from
the faintest mark a theme can make on its own surface (`--n-1`) to its strongest
text (`--n-14`). The ramp is ordered by *contrast against the surface*, never by
lightness, so `--n-3` is a border and `--n-10` is muted text in every theme, and
a rule can name either without knowing which way round the theme runs. A test
asserts the monotonicity in each direction.

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

`--canvas-wash` is a `background-image` rather than a colour, painted on `body`
and on `.main-pane`. Most themes set it to `none`; Airy uses it for the light in
the corner, which no single element could own.

### The themes

`light` and `dark` are the two `system` resolves to. `airy` is a deliberate
choice only — near-black lit from one corner, amber where the others are
chartreuse, borders that barely exist, uppercase letterspaced micro-labels, and
roughly half again the spacing, so negative space does the work the lines used
to.

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
- **The `--n-*` ramp is monotonic in contrast against the surface**, in every
  theme. A rule that names `--n-3` for a border is relying on this and on nothing
  else.
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

# Avalon Design System

Avalon is a **multiplayer workplace automation** product from Juno AI Labs: a macOS desktop workspace where people and an AI agent move real work forward inside durable, inspectable **work streams**. There are no channels, no DMs, no global inbox — the unit of the product is a piece of work with a home.

Tagline in use: *"Work, still in context."* / *"Give every outcome a place to run."*

## Sources this system was built from

Everything here was read from the product source, not from screenshots:

- **GitHub — https://github.com/juno-ai-labs/avalon** (branch `main`)
  - `apps/desktop/src/renderer/` — the Electron renderer: `styles/app.css` (2,934 lines, the authoritative token + component stylesheet), `components/primitives.tsx`, `components/workstream-blocks.tsx`, `components/workstream-composer.tsx`, `components/inspector-rail.tsx`, `components/sidebar.tsx`, `screens/*`.
  - `apps/site/` — the marketing site: `index.html` and `src/styles.css` (with-avalon.com).
  - `scripts/generate-brand-assets.py` — the canonical brand-asset generator (defines the exact brand hexes and the icon pipeline).
  - `docs/PRD.md`, `docs/DESKTOP_ICONS.md`, `README.md` — product contract, visual intent, icon rules.
- No Figma file, slide template, or brand guideline PDF was provided. **Explore the repositories above** to go deeper than this system captures — the renderer stylesheet in particular carries dozens of screen-specific treatments that were not lifted into components.

Two surfaces are represented: the **desktop workspace** (the product) and the **marketing site**.

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | Global entry — only `@import` lines. Link this one file. |
| `tokens/` | `fonts`, `colors`, `typography`, `spacing`, `radius`, `elevation`, `motion`, `base` |
| `guidelines/` | 18 foundation specimen cards (Colors, Type, Spacing, Brand) |
| `components/core/` | Icon, AvalonMark, Button, IconButton, Badge, StatusDot |
| `components/identity/` | Avatar, AvatarStack |
| `components/feedback/` | Tooltip, EmptyState, InlineError, LoadingState |
| `components/forms/` | TextField, SearchField, SelectField, ToggleSwitch, OptionCard |
| `components/workstream/` | SidebarRow, MessageBlock, ToolBlock, ArtifactBlock, SuggestionBlock, RailCard, Composer, ElicitationPanel |
| `components/site/` | SiteButton, Kicker, FeatureCard, IntegrationTile, SignalStrip |
| `ui_kits/avalon-desktop/` | Clickable recreation of the Electron workspace |
| `ui_kits/avalon-site/` | Clickable recreation of the landing page |
| `assets/brand/` | Avalon mark, Apple logo, favicon, OG card |
| `assets/app-icons/` | Eight user-selectable macOS app icons |
| `assets/imagery/` | Five landscape photographs used behind heroes |
| `SKILL.md`, `github.md` | Agent Skill wrapper; upstream sync record |

### Intentional additions

- **`Icon`** — a thin wrapper over the Lucide glyph set (the product uses `lucide-react`). Needed because these files run without npm; it masks `lucide-static` SVGs so glyphs inherit `currentColor`.
- **`components/site/*`** — the marketing site is plain HTML+CSS upstream, so its recurring patterns were factored into components. Class names and values are unchanged.

Everything else maps one-to-one onto a class or component that exists in the repository.

---

## Content fundamentals

**Voice: calm, declarative, and physical.** Avalon writes about work as a thing with a location and a direction — it *opens*, *moves*, *returns*, *stays attached*. Sentences are short and end on a noun that matters.

- **Two-beat headlines.** Almost every headline is a statement plus a turn, split across a line break, with the second line set in italic DM Serif Display and brand lime: "Describe the outcome. / *Keep the work together.*" · "See the work. / *Not just the answer.*" · "From isolated answers / *to durable work.*"
- **Person:** second person for the reader ("See what needs you"), third person for the agent ("Avalon reads connected context"). Never first person — the product never says "I". Avalon is named, never called "the AI" or "the assistant".
- **Casing:** sentence case everywhere — headlines, buttons, menu items, settings rows. Uppercase appears only in 8–9px monospace eyebrows with 0.06–0.12em tracking ("THE OPERATING MODEL", "NEEDS INPUT").
- **Punctuation:** em dashes unspaced in marketing copy ("Start with the work—not a blank chat"); middots separate metadata ("Avalon · Completed · 2m 14s"); ellipses on progressive labels ("Opening work stream…"). Marketing prose uses curly quotes.
- **Product vocabulary is fixed:** *work stream* (two words), *automation*, *run*, *participant*, *resource*, *connection*, *elicitation* (in code) surfaced to users as *needs input*, *work-stream* hyphenated when adjectival. Never "chat", "thread", "channel", "conversation history", "workflow", or "prompt".
- **Status copy is a state, not a sentence:** "Needs input", "Running", "Completed", "Waiting", "Ready", "Scheduled".
- **Errors say what failed and what happens next:** "Live updates are unavailable. Avalon will keep trying to reconnect." · "Regional service offline. Existing views may be stale."
- **Empty states are an invitation plus a reason:** title, one explanatory line, one action.
- **Claims are hedged honestly.** The site says "Downloads opening soon" and "Private preview · Apple silicon" rather than overselling. Docs are blunt about limits ("Google push webhooks are not implemented").
- **No emoji. Anywhere.** Not in product, not in marketing, not in docs. Unicode glyphs (`↘ → ↗ ＋ ↵ ●  ◌ ×`) do appear in the site's low-fi mock chrome, but real UI uses Lucide icons.
- **Numbers stay concrete:** "12 customer interviews", "2m 14s", "320–380px", "3 signals". No rounded marketing statistics, no invented percentages.

---

## Visual foundations

### The mood in one line
A dense, quiet, dark work surface — near-black with a green cast, one electric lime accent, and photographs of empty landscapes when the product needs to breathe.

### Color
- **Brand primary `#cedc00`** — an acid lime-yellow. It marks: primary buttons, active/complete status, the mark, section kickers, selection tints, the signal strip. Dark text (`#111210`) always sits on it. Used sparingly at small sizes; only the signal strip and the primary button are ever large fields of it.
- **Brand secondary `#47c7fc`** — sky blue for *live/connected* states: running dots, unread rows, socket connected, links inside transcripts, selection highlight, focus rings.
- **Brand warm `#ff6337`** — site-only accent; the alternate art directions swap it into the accent slot.
- **Semantics:** yellow `#e6bd45` needs input · green `#6ecb87` completed tasks / socket · red `#d8756f` failed (a desaturated clay red, never fire-engine) · grey `#77766f` completed-and-quiet.
- **Two surface scales.** The app climbs `#111210 → #181916 → #1d1e1b → #22231f → #292a26 → #30312c`; the site sits deeper and cooler at `#070807 → #0b0d0b → #141613 → #1a1c18 → #22241f`. Every one of these blacks is warm-green, never blue-grey. Add `class="avalon-site"` to switch scopes.
- **Four ink levels only:** `#ecebe5` → `#cac9c2` → `#94948c` → `#706f69`. Off-white, never pure `#fff`.
- **Hairlines:** the app uses solid `#32332e` / `#292a26`; the site uses translucent `rgba(240,239,232,.14)` / `.08`.
- No gradients as decoration. The only gradients are functional: a scrim under the composer, a dark wash over hero photographs, and one very faint 145° sheen on marketing feature cards.

### Type
- **Inter** for everything structural; **DM Serif Display** italic for the second line of a headline (accent only, never body); **SFMono-Regular** for eyebrows, timestamps, code, and status labels.
- Display type: weight **500**, tracking **−0.068 to −0.075em**, line-height **0.86–0.92**. Very large, very tight, very light — the headline is the layout.
- Product type: **9–15px**, line-height 1.48. Emphasis is carried by half-step weights (520 / 560 / 590 / 620 / 650), not by size jumps. 9.5px timestamps and 10.5px metadata are normal here; do not inflate them.
- Transcript body is 14px/1.6 in `#dfded9` — slightly softer than UI ink.

### Spacing and layout
- Off-grid by design: 5, 7, 9, 11, 13, 14, 18, 22px. **Do not snap Avalon values to a 4/8 grid.**
- Fixed layout constants: sidebar **300px** (resizable), context rail **320–380px** (floating, inset 8px, rounded, shadowed — not flush), transcript column **max 860px** centred with 42px top / 150px bottom padding, work-stream header **55px**, titlebar **48px**, site shell **max 1440px** with `clamp(1.1rem, 5vw, 5.4rem)` gutters and `clamp(6.8rem, 12vw, 11rem)` section padding.
- The desktop app never scrolls the page; panes scroll independently.

### Backgrounds and imagery
- **Photography:** cool, desaturated, wide biome landscapes (high desert, boreal wetland, volcanic coast, alpine tundra, an organic panorama). Always `brightness(.74) saturate(.82)`, always under a two-layer dark gradient scrim, always with a soft-light **grain** overlay (3px radial dot pattern at 0.22–0.24 opacity). A whole-page 4px grain at 0.08 sits over the site permanently.
- Photographs drift: a 20s alternating `scale(1.025)` translate. Nothing else on the page moves on its own.
- No illustrations, no 3D, no abstract blobs, no stock people. If imagery is needed and none fits, use a flat surface.

### Cards, borders, radii
- App cards: 1px solid line, 7–13px radius, flat fill, **no shadow** unless the thing floats (composer, rail, dialog, menu, elicitation panel).
- Site cards: 12px base radius scaled by multipliers (`calc(var(--radius-site) * .65 / .72 / 1.2 / 1.4)`), hairline border that turns lime at 36% on hover.
- Shadows are large, soft and pure black: composer `0 7px 28px /.2`, panel `0 10px 34px /.24`, menu `0 12px 35px /.4`, dialog `0 22px 75px /.52`, site window `0 50px 120px /.34`.
- **Blur** is used only on glass over photography or over scrolled content: header `blur(18px)`, hero evidence cards `blur(14–16px)`, theme picker `blur(14px)`. Never on flat dark backgrounds.
- **Protection gradients, not capsules:** the composer sits on a `transparent → surface 18%` fade; the hero bottom fades to canvas. Text over photography relies on gradient scrims, never on a pill behind the words.

### Motion
- Fast and unshowy. 100–140ms for colour/background changes, 180ms on site hovers, 220ms for panels, 650ms `cubic-bezier(.2, .7, .2, 1)` for the one scroll-reveal (22px rise + fade).
- **Activity is signalled by opacity pulse, not spin:** `0.36 → 1 → 0.36` over 1.4s on running dots. A rotating spinner appears only for a blocking load.
- Streaming text ends with a 2px lime caret pulsing at 0.9s. Skeletons pulse at 1.5s.
- **Nothing bounces, springs, or overshoots.** No parallax beyond the hero drift, no page transitions.

### Interaction states
- **Hover (app):** background lifts one surface step (`#292a26 → #30312c`), border to `#41423c`, text to full ink. No transform.
- **Hover (site):** `translateY(-2px)` on buttons and tiles, `-4px` on feature cards, border tints lime; the button's trailing arrow nudges `translate(2px, 2px)`.
- **Active/selected:** a flatter, brighter surface (`#343530`, `#353631`) plus, in settings, a 2px lime left bar. Selected option cards use a lime-mixed fill (`color-mix(in srgb, var(--brand-primary) 8%, …)`) and a lime border — never a filled radio dot.
- **Press:** no scale-down anywhere; the product relies on the hover surface change.
- **Focus:** `2px solid` blue outline at 2px offset in the app, lime at 4px offset on the site. Inputs additionally warm their border and add a 1–2px ring.
- **Disabled:** `opacity: .48` and `cursor: not-allowed`. Nothing is hidden.

### Iconography
- **Lucide only** (`lucide-react` in product, `lucide-static` masked in these prototypes), 13–17px, stroke 1.7–2, inherits `currentColor`. Common glyphs: `circle-dot` (work stream), `repeat` (automation), `sparkles` (HyperSight/suggestions), `paperclip`, `mic`, `arrow-up` (send), `panel-right` (rail), `chevron-down`, `check`, `triangle-alert`, `ellipsis`.
- **The Avalon mark** is a single-channel alpha mask (`assets/brand/avalon-mark.png`), applied via CSS `mask` and painted in one flat colour — lime on dark, ink on light. Never place it in a coloured tile inside the UI; the only enclosed form is the macOS app icon, where the system owns the enclosure. Never redraw or approximate it.
- The **eight app icons** in `assets/app-icons/` are shipped artwork (dark, light, blueprint, holographic, leather, ludicrous-speed, ruby, sunset-sherbet) — use them as-is, full-bleed and unmasked.
- Third-party marks: only the Apple logo (`assets/brand/apple-logo.svg`) is bundled. Connections (Gmail, Drive, GitHub, Linear, Notion) are shown as **text names**, not vendor logos — match that.
- Unicode arrows (`↘ → ↗ ↵`) are used as typographic affordances in marketing copy; that is deliberate and distinct from icons.

### Fonts — substitution note
The repository ships **no font binaries**. Inter and DM Serif Display are loaded here from Google Fonts, and the monospace stack resolves to the platform's SFMono-Regular. This matches the CSS font stacks in the source exactly, but if Avalon has licensed variable-font files, drop them into `assets/fonts/` and replace the `@import` in `tokens/fonts.css` with real `@font-face` rules.

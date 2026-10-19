# Using company brand icons

Rally draws real company marks — Slack's lattice, GitHub's octocat, Granola's
spiral — from [`@thesvg/react`](https://www.npmjs.com/package/@thesvg/react), an
MIT-licensed set of typed React components covering about 6,500 brands.

There is one rule, and it is enforced: **import one brand per subpath.**

```ts
import Github from '@thesvg/react/github';   // ✅
```

```ts
import { Github } from '@thesvg/react';      // ❌ banned
```

Read this before adding a brand mark, adding a connector, or reaching for any
other icon package.

## Why the barrel is banned

It is a build-cost rule, not a style preference.

`@thesvg/icons` — the data package `@thesvg/react` is generated from — declares
each icon by importing a type from its own index:

```ts
// @thesvg/icons/dist/github.d.ts
import type { IconModule } from "./index.js";
```

That index is the barrel over every brand, so **anything that reaches it pulls
all ~6,500 icon declarations into the TypeScript program**. Eight icon imports
took the desktop renderer's program from 575 files to 7,095 — 92% of it icon
types — and the cold `pnpm lint` that then built that program went from about
6.1 GB to 7.9 GB peak and ran out of heap on CI:

```
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

Lint no longer builds that program: `projectService` is scoped to
`apps/api/src` ([why](dev-environment.md#what-pnpm-lint-costs-in-memory)), so
the renderer is parsed syntactically. The barrel still costs exactly this much —
`pnpm typecheck` and every editor's language service now carry it instead, and
neither has lint's cache to hide it. The rule below is unchanged.

The `@thesvg/react` per-icon declarations import only from `react`, so
`@thesvg/react/github` costs what it looks like. The barrel form of that package
still reaches the same index, which is why it is banned too.

`scripts/eslint-rules/thesvg-subpath-imports.mjs` reports a barrel import of
`@thesvg/react`, `@thesvg/icons`, or `thesvg` as an error. It is a lint rule
rather than a convention because the cost is invisible locally: `pnpm lint`
caches, and only CI's cold run pays it.

## Drawing a mark

Do not render a brand component directly. Every **React** surface goes through
`ConnectorMark` in `packages/ui/src/components/primitives.tsx`, which
decides the mark, its colour, and how it is put on the page once:

```tsx
<ConnectorMark mark="slack" />
```

Which mark a connector wears is
`connectorBrandMark(connectorType, displayName)` in
`packages/ui/src/lib/plugin-marks.ts` — the single table, keyed on the
connector's own type, so a connector looks the same in the transcript and in
Settings. [`plugin-activity-rows.md`](plugin-activity-rows.md) owns the
transcript's use of it.

`apple` is in the table without being a connector: the browser client's Mac
download row wears it. The table holds company marks, whatever links to them.

A custom MCP server has no connector type of its own, so it wears the mark of a
company its display name spells out in whole words: "Cloudflare API" draws
`cloudflare`, which is in the table for exactly that. `x` and `apple` never
match a name. A server whose name names no company in the table wears
`model-context-protocol`, the protocol's own mark, which is in the table as that
fallback and never matched against a name. Settings and mention chips take this
route; the transcript does not, and always draws the protocol mark for a custom
server (see [`plugin-activity-rows.md`](plugin-activity-rows.md)).

The public landing is static HTML and has no React runtime, so it cannot go
through `ConnectorMark`. It inlines `@thesvg/react/apple`'s `mono` path on the
download button, painted in `currentColor`, and the `github` and `hugging-face`
`mono` paths on the Team section's founder links. LinkedIn ships no `mono`
variant, so its link there inlines the `default` path with the hard-coded
`#0A66C2` fill swapped for `currentColor`. A Lucide or Tabler stand-in is still
not a company mark there, and adding React to the site just to mount one
component is not the fallback. No automated test pins the
inlined `d` against the pack.

### Marks are monochrome

`ConnectorMark` asks for `variant="mono"`, the package's own single-colour art,
which paints in `currentColor`. Ten of the twelve brands ship one. **Slack and
Granola do not** — their variant unions are `default | wordmark` and
`default | light | dark` — so `PLUGIN_BRAND_MARKS` records that per brand and
asking for `mono` there is a *type error* rather than a silent fallback. Those
two render their colour art, and `.connector-mark` recolours any painted shape
inside: a CSS `fill` beats an SVG presentation attribute, and `[fill="none"]` is
deliberately left alone, because those shapes are hollow and filling them turns
a mark into a blob. Ashby and Fireflies are not in the package; their local
components only ship the monochrome art. Apollo.io uses the catalog's A path without its background tile, and Canva uses the upstream C path without its gradient disc: recolouring both the disc and white letter would make the mark a solid circle.

Two smaller consequences of rendering real SVG, both handled:

- **The `mono` art carries an SVG `<title>`** with the company's name. It is
  metadata rather than page text — `script` and `style` are ignored by
  testing-library for the same reason — so the renderer's test setup adds
  `title` to `defaultIgnore`. Without it a text query for a connector's name
  matches both the label a person reads and the glyph beside it.
- **A `<title>` also draws a native tooltip on hover**, over rows that already
  name the connector, so `.connector-mark > svg` takes `pointer-events: none`.

The `default` art is *not* the safer choice despite having no title: Google's
carries 19 element ids and 18 `url(#…)` references, and two Google cards sit on
the Settings page at once, so inlining it twice duplicates every one of them.

This is a deliberate design decision, not a limitation. Brand colour was built
and compared side by side: X and Notion are near-black and vanish in dark,
Granola's is near-black and vanishes in light, and only some brands ship the
light/dark art that would fix it. One contrasting neutral is legible in both
appearances, needs no appearance-specific artwork, and needs no component that
knows which appearance is on — which [`theming.md`](theming.md) forbids anyway.

Connector icon badges (`.provider-icon`) use the neutral raised surface, default
border, and default text tokens. Standard theme colors were requested in place of Rally’s lime branding on
third-party connectors. The badge identifies a provider rather than acting as a
control; the same policy covers generic connector glyphs.

### Sizing

`.connector-mark` carries a default size and sits low in `app.css`, so a
per-surface size **must out-specify it** rather than tie it and lose on source
order:

```css
.provider-icon .connector-mark { height: 19px; width: 19px; }   /* ✅ */
.provider-mark { height: 19px; width: 19px; }                   /* ❌ inert */
```

Both Settings sizes were written the inert way first and drew at the shared
default; the difference was small enough to pass a visual check.
No automated test covers that every rule sizing a mark names the surface that
owns it; that is verified in a real window. The Settings component test pins
that a mark carries no second class to hang one on.

## Adding a connector

One edit: name its mark in `connectorBrandMark`. The slug is the brand's on
[thesvg.org](https://thesvg.org); add the matching `@thesvg/react/<slug>` import
to `PLUGIN_BRAND_MARKS`. A connector absent from that table draws a generic plug
in Settings and no row at all in the transcript, so the table is the only thing
to update.

If the catalog has no slug — Ashby and Fireflies today — a local component in
`packages/ui/src/lib/brand-marks/` draws the company's own mark the
same way: `currentColor`, through `ConnectorMark`, one file per brand. A Lucide
or Tabler stand-in is not a company mark and is not the fallback. The generic
plug is only for a connector that has not been named in the table yet.

The local file has to fill the same square slot the catalogued marks do.
`.connector-mark` is a square box and the SVG scales by height, so a tall
lockup draws as a sliver — Ashby's stacked marketing mark was 7.5px wide in
the 16px box. Use the company's square product icon (Ashby's is the serif A
punched from the rounded square at `ashbyhq.com/favicon.png`), drop the
wordmark, paint in `currentColor`, and ship no element ids or `url(#…)`
references: two cards on Settings would duplicate them, which is why Google's
`default` art is refused. Look at it at 14px, 15px, and 16px in a real window
before it ships; a passing DOM test does not catch a half-width glyph.

Not every glyph is a company. The two virtual groups, the public web, and an
inbound webhook are shapes no brand owns and keep their Tabler line icons; an
inbound webhook deliberately draws nothing in a Settings row rather than a
placeholder.

## Not markup

An earlier revision of this took SVG **strings** from the `thesvg` package and
would have rendered them with `dangerouslySetInnerHTML`, which is what that
package's own documentation shows. It was drawn as a CSS mask instead, to keep
that call out of a renderer that has no other use of it.

`@thesvg/react` removes the question: the components build real React elements,
so no HTML is injected at all. If a future icon source hands out strings again,
mask it or wrap it — `dangerouslySetInnerHTML` stays absent from this renderer,
per [`security.md`](security.md).

## Licensing

The package is MIT; each mark carries its own upstream licence, exposed as
`license` on the data package's entry. Most of Rally's are `CC0-1.0`. **Granola's
is `brand-use`** — the company's mark shown under its own brand guidelines rather
than a public-domain asset. Ashby's and Fireflies' marks are not in the package;
they are the companies' own art, used the same way. Identifying a connector by
its logo is the ordinary use; reusing one as decoration, in marketing, or
anywhere it could imply endorsement is not, and is not covered by the package's
MIT licence.

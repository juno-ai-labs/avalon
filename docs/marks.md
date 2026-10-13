# Marks

A **mark** is how a Channel, thread or Breakout is recognised: one glyph from the
appearance catalog, one palette colour, and a shape. A Channel (a stored Space)
is a squircle and a thread or Breakout a circle, as in the sidebar. Inside the
app a mark is drawn by React components in `@rally/ui`; this document covers the
two pieces that let a surface **outside** the app draw the same one: the
id-derived mark in `@rally/contracts`, and the public PNG the site serves at

```
https://rallywith.ai/marks/<shape>/<color>/<icon>.png
```

The first consumer is the Slack unfurl card
([`workstream-links.md`](workstream-links.md#what-the-slack-unfurl-shows)),
which can show a picture but not an SVG component. Anything else that needs a
mark as an image (an email, a social card) uses the same address.

## Where the code lives

| Concern | Location |
| --- | --- |
| The id-derived mark, the image path, and its parser | `packages/contracts/src/marks.ts` |
| The app's use of the same derivation | `workstreamAppearance` in `packages/ui/src/components/workstream-glyph.tsx` |
| Every icon as a standalone SVG, emitted at build | `apps/site/src/mark-glyphs.ts`, wired in `apps/site/vite.config.ts` |
| Drawing a PNG from a glyph, colour and shape | `apps/site/worker/marks.ts` |
| Edge caching and the WebAssembly start | `apps/site/worker/index.ts` |
| Which paths start the site Worker | `run_worker_first` in `apps/site/wrangler.jsonc` |
| Colours | `config/design-tokens/base.json`, `config/design-tokens/themes/light.json` |

## How it works

**Glyphs are built; PNGs are drawn on request.** The Vite build renders each of
the storable icon keys through the app's own `APPEARANCE_ICON_COMPONENTS` to
`/marks/glyphs/<icon>.svg`. A request for a PNG starts the site Worker, which
reads that glyph from its assets, places it on the shape in the colour's tint and
ink, rasterises it with resvg (WebAssembly), and stores the result in the
location's cache for a year.

Building every PNG instead was measured and rejected: 264 icons, 19 colours and
two shapes are over ten thousand files and about 25 MB per deploy, nearly all
never requested. Drawing one takes milliseconds, and each is drawn about once
per Cloudflare location.

**The glyphs come from the components, not Lucide's files.** Several stored keys
are Lucide aliases (`smile`, `podcast`, `globe-2`); only the components resolve
them, and drawing through them is what keeps a mark outside the app identical to
the sidebar's.

**Colours follow `markColors` in `@rally/ui`.** A ring colour is its pastel
`project-tint` with its `project-ink`; `black` and the retired colours are the hue
itself with the ink `PALETTE_INK` names. Values are the light appearance's,
because an image cannot follow the reader's theme. Sizes follow the app too: a
circle carries its glyph at half its width with a 1.9 stroke, a squircle at 47%
with a 1.8 stroke and 32% corners.

**An object with no chosen appearance** gets `generatedAppearance(id)`: a ring
colour and one of the generated icons, both seeded by its id. The app and the
API call the same function, so a Slack card and the sidebar never disagree about
an unset mark.

## Invariants

- **The address space is exactly the vocabulary.** A shape, colour or icon outside
  `parseMarkImagePath` is a 404. Widening it lets anyone fill the edge cache with
  junk entries.
- **A stored key's image never changes meaning.** Responses are cached
  `immutable` for a year and Slack keeps its own copy, so a key's URL must keep
  drawing the same thing. A palette retune is accepted as stale until evicted;
  renaming or removing a key is not allowed at all
  (`RETIRED_APPEARANCE_ICON_KEYS` in `appearance-icons.ts` says why).
- **One derivation for an unset mark.** `generatedAppearance` is the only place
  the hash lives. A second copy would let the app and a card draw different
  marks for the same object.
- **A missing glyph is a 500, not a 404.** Every storable key has a glyph in the
  same build; a miss means a broken deploy, and a 404 would be cached by Slack.

## Boundary

This module owns the mark as an image and the id-derived fallback. It does not
own the icon catalog (`appearance-icons.ts`), the palette or its inks
([`theming.md`](theming.md)), or who may see a mark: a link's preview decides
that ([`workstream-links.md`](workstream-links.md)). The image carries no name
and no id, only the three keys, so serving it publicly reveals nothing.

## Failure modes and limits

- **resvg fails to start:** the request throws and returns a 500; the next
  request retries the start rather than keeping the failure.
- **Cold location:** the first request draws the PNG (a few milliseconds plus the
  glyph read); later ones are cache hits.
- **Worker size:** resvg adds about 2.4 MB (950 KB gzipped) to the site Worker,
  which also serves `/help/`. Static pages never start it.

## Testing

`apps/site/test/marks.test.ts` draws real PNGs through `serveMark` with the
built glyphs and reads pixels back: tint, ink, transparent corners, and 404 for
keys outside the vocabulary. `packages/contracts/src/marks.test.ts` pins
`generatedAppearance` to the same ids the app's glyph test pins, and the path
round trip.

## Changelog

### 2026-10-13 — Marks as public images

**What changed:** Added `/marks/<shape>/<color>/<icon>.png` on the site, drawn by
the site Worker from build-time glyph SVGs, and moved the id-derived mark from
`@rally/ui` into `@rally/contracts`.

**Why:** Slack unfurl cards now show a link's Channel and its own colour and
icon, and Slack accepts only PNG, JPEG or GIF by URL.

**Considered and rejected:** Building every PNG (10,032 files, 25 MB per
deploy); drawing in the API Worker (adds 2.4 MB to the one Worker every request
uses); reading Lucide's icon files directly (misses aliased keys).

**Consequences:** A key's URL is permanent and cached for a year. A new icon or
colour needs nothing here beyond being storable; a new shape needs a case in
`markSvg` and `parseMarkImagePath`.

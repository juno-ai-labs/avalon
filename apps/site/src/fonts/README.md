# Site fonts

The site's Content-Security-Policy allows fonts from `'self'` only, so the faces
ship here and Vite fingerprints them into `/assets/`, which `public/_headers`
caches as immutable. Only the latin subset and the faces a page uses are kept;
add one here before using it in CSS.

The marketing pages (`src/site.css`) set their type in Geist, with Geist Mono
for labels and Instrument Serif italic for the one accent word a headline may
carry. Why these three is in
[`docs/site-brand-system.md`](../../../../docs/site-brand-system.md).

| File | Family | Weight | Used by | Upstream |
| --- | --- | --- | --- | --- |
| `geist-latin-wght-normal.woff2` | Geist | 100–900, variable | `site.css` | [`@fontsource-variable/geist`](https://fontsource.org/fonts/geist) 5.3.0 |
| `geist-mono-latin-wght-normal.woff2` | Geist Mono | 100–900, variable | `site.css` | [`@fontsource-variable/geist-mono`](https://fontsource.org/fonts/geist-mono) 5.3.0 |
| `instrument-serif-latin-400-normal.woff2` | Instrument Serif | 400 | `site.css` | [`@fontsource/instrument-serif`](https://fontsource.org/fonts/instrument-serif) 5.3.0 |
| `instrument-serif-latin-400-italic.woff2` | Instrument Serif | 400 italic | `site.css` | [`@fontsource/instrument-serif`](https://fontsource.org/fonts/instrument-serif) 5.3.0 |
| `barlow-latin-400-normal.woff2` | Barlow | 400 | `help.css` | [`@fontsource/barlow`](https://fontsource.org/fonts/barlow) 5.3.0 |
| `barlow-latin-500-normal.woff2` | Barlow | 500 | `help.css` | [`@fontsource/barlow`](https://fontsource.org/fonts/barlow) 5.3.0 |
| `barlow-semi-condensed-latin-500-normal.woff2` | Barlow Semi Condensed | 500 | `help.css` | [`@fontsource/barlow-semi-condensed`](https://fontsource.org/fonts/barlow-semi-condensed) 5.3.0 |

Every family is licensed under the SIL Open Font License 1.1, which must ship
with the fonts. The licence, with each family's copyright line, is in
[`public/fonts/OFL.txt`](../../public/fonts/OFL.txt) so the build publishes it at
`/fonts/OFL.txt` alongside the site that serves the fonts.

The social cards drawn at build time for the comparison and blog pages
(`src/social-cards.ts`) still read Barlow from the `@fontsource/barlow` and
`@fontsource/barlow-semi-condensed` dev dependencies, as WOFF rather than WOFF2,
because `opentype.js` cannot decompress WOFF2. Keep those packages on the
version in the table above. The home page's card, `public/rally-og.jpg`, is a
static image.

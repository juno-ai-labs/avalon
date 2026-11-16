# Site fonts

The pencil homepage, blog, Trust Center and Help Center share the fonts in
`src/site-theme.css`: Instrument Serif headlines, Geist body text, and Geist
Mono for code. Earlier marketing pages use the same families through
`src/landing.css` (see `docs/site-design-system.md`). The site's Content-Security-Policy allows fonts from `'self'` only, so
the faces ship here and Vite fingerprints them into `/assets/`, which
`public/_headers` caches as immutable.

| File | Family | Weight | Upstream |
| --- | --- | --- | --- |
| `instrument-serif-latin-400-normal.woff2` | Instrument Serif | 400 | [`@fontsource/instrument-serif`](https://fontsource.org/fonts/instrument-serif) 5.3.0 |
| `instrument-serif-latin-400-italic.woff2` | Instrument Serif Italic | 400 | [`@fontsource/instrument-serif`](https://fontsource.org/fonts/instrument-serif) 5.3.0 |
| `geist-latin-variable.woff2` | Geist | 100 to 900 | [`@fontsource-variable/geist`](https://fontsource.org/fonts/geist) 5.3.0 |
| `geist-mono-latin-variable.woff2` | Geist Mono | 100 to 900 | [`@fontsource-variable/geist-mono`](https://fontsource.org/fonts/geist-mono) 5.3.0 |
| `barlow-latin-400-normal.woff2` | Barlow | 400 | [`@fontsource/barlow`](https://fontsource.org/fonts/barlow) 5.3.0 |
| `barlow-latin-500-normal.woff2` | Barlow | 500 | [`@fontsource/barlow`](https://fontsource.org/fonts/barlow) 5.3.0 |
| `barlow-semi-condensed-latin-500-normal.woff2` | Barlow Semi Condensed | 500 | [`@fontsource/barlow-semi-condensed`](https://fontsource.org/fonts/barlow-semi-condensed) 5.3.0 |

Every family is licensed under the SIL Open Font License 1.1, which must ship
with the fonts. The licences are in `public/fonts/` (`OFL.txt` for Barlow,
`OFL-instrument-serif.txt`, `OFL-geist.txt` and `OFL-geist-mono.txt`), so the build
publishes them beside the site that serves the fonts.

The pencil blog and help previews use `instrument-serif-regular.ttf`,
`geist-regular.ttf`, and `geist-semibold.ttf` in `reading-card.ts`. These are
build-only static derivatives of the local WOFF2 faces, retaining their OFL
licenses. They were produced with FontTools: load `TTFont`, instantiate the
Geist `wght` axis at 400/600 with `instantiateVariableFont`, set `flavor = None`,
and save as TTF. No font conversion or network request is needed during a site
build; update these derivatives alongside any WOFF2 font replacement.

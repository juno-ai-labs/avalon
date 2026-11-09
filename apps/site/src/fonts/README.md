# Site fonts

The marketing pages (`src/landing.css`) set display type in Inter Tight, body
text in Inter and labels in Geist Mono, the faces the launch films use (see
`docs/site-design-system.md`). The help center (`src/help.css`) still sets
Barlow. The site's Content-Security-Policy allows fonts from `'self'` only, so
the faces ship here and Vite fingerprints them into `/assets/`, which
`public/_headers` caches as immutable.

| File | Family | Weight | Upstream |
| --- | --- | --- | --- |
| `inter-tight-latin-variable.woff2` | Inter Tight | 100 to 900 | [Inter Tight](https://github.com/rsms/inter-tight), copied from `.agents/skills/rally-motion/kit/fonts/` |
| `inter-latin-variable.woff2` | Inter | 100 to 900 | [Inter](https://github.com/rsms/inter), copied from the same kit |
| `geist-mono-latin-variable.woff2` | Geist Mono | 100 to 900 | [Geist](https://github.com/vercel/geist-font), copied from the same kit |
| `barlow-latin-400-normal.woff2` | Barlow | 400 | [`@fontsource/barlow`](https://fontsource.org/fonts/barlow) 5.3.0 |
| `barlow-latin-500-normal.woff2` | Barlow | 500 | [`@fontsource/barlow`](https://fontsource.org/fonts/barlow) 5.3.0 |
| `barlow-semi-condensed-latin-500-normal.woff2` | Barlow Semi Condensed | 500 | [`@fontsource/barlow-semi-condensed`](https://fontsource.org/fonts/barlow-semi-condensed) 5.3.0 |

Every family is licensed under the SIL Open Font License 1.1, which must ship
with the fonts. The licences are in `public/fonts/` (`OFL.txt` for Barlow,
`OFL-inter.txt`, `OFL-inter-tight.txt` and `OFL-geist-mono.txt`), so the build
publishes them beside the site that serves the fonts.

The social cards drawn at build time (`src/social-cards.ts`) read Barlow from
the `@fontsource/barlow` and `@fontsource/barlow-semi-condensed` dev
dependencies instead, as WOFF rather than WOFF2, because `opentype.js` cannot
decompress WOFF2. Keep those packages on the version in the table above.

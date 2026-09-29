# Landing fonts

The landing page (`index.html`, `src/landing.css`) sets its display and body
type in Barlow. The site's Content-Security-Policy allows fonts from `'self'`
only, so the faces ship here and Vite fingerprints them into `/assets/`, which
`public/_headers` caches as immutable. Only the latin subset and the weights the
page uses are kept; add a weight here before using it in CSS.

| File | Family | Weight | Upstream |
| --- | --- | --- | --- |
| `barlow-latin-400-normal.woff2` | Barlow | 400 | [`@fontsource/barlow`](https://fontsource.org/fonts/barlow) 5.3.0 |
| `barlow-latin-500-normal.woff2` | Barlow | 500 | [`@fontsource/barlow`](https://fontsource.org/fonts/barlow) 5.3.0 |
| `barlow-semi-condensed-latin-500-normal.woff2` | Barlow Semi Condensed | 500 | [`@fontsource/barlow-semi-condensed`](https://fontsource.org/fonts/barlow-semi-condensed) 5.3.0 |

Both families are licensed under the SIL Open Font License 1.1, which must ship
with the fonts. The licence is in
[`public/fonts/OFL.txt`](../../public/fonts/OFL.txt) so the build publishes it at
`/fonts/OFL.txt` alongside the site that serves the fonts.

# Bundled fonts

Files a theme may name as a `bundled` font source. They ship inside the
application so the family is available on the first paint and no text is drawn
in a substitute first — which is the whole reason a theme would bundle rather
than fetch. See [`docs/theming.md`](../../../../../docs/theming.md).

| File | Family | Axes | Upstream |
| --- | --- | --- | --- |
| `geist-mono-latin-variable.woff2` | Geist Mono | weight 100–900 | [vercel/geist-font](https://github.com/vercel/geist-font) |

The font is licensed under the SIL Open Font License 1.1; the licence is in
[`OFL.txt`](OFL.txt) and must stay beside the files it covers. Adding a font
here means adding its licence and its row above — a binary in a repository with
no provenance is the thing this file exists to prevent.

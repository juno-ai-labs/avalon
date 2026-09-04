# Desktop appearance

Rally has one visual language with two appearances: light and dark. People can
follow the Mac setting or pin either appearance. There are no named theme
families, user-selectable designs, animated theme documents, or theme-specific
component branches.

The design-token JSON is the source of truth. Generated CSS exposes semantic
custom properties to the renderer, and application rules consume those
properties without knowing which appearance is active.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `config/design-tokens/registry.json` | Declares every supported token path, type, and meaning. |
| `config/design-tokens/themes/light.json` | Rally's light token values and font declarations. |
| `config/design-tokens/themes/dark.json` | Rally's dark token values and font declarations. |
| `config/design-tokens/theme.schema.json` | Validates an appearance file. |
| `scripts/build-theme-assets.mjs` | Generates the renderer stylesheet and remote-font manifest. |
| `apps/desktop/src/renderer/styles/themes.css` | Generated light and dark custom-property blocks. |
| `apps/desktop/src/renderer/styles/app.css` | Component and layout rules expressed through semantic tokens. |
| `apps/desktop/src/common/themes.ts` | The shared `system | light | dark` preference and resolver. |
| `apps/desktop/src/renderer/lib/theme.ts` | Applies the resolved appearance, persists the preference, follows macOS, and synchronizes windows. |
| `apps/desktop/src/renderer/components/theme-picker.tsx` | The Appearance setting. |
| `apps/desktop/src/main/theme-assets.ts` | The private cache for a remote font declared by an appearance. |

## How it works

`ThemeChoice` is the scalar device preference `system`, `light`, or `dark`.
`system` resolves through `prefers-color-scheme`; the other two values resolve
to themselves. The renderer writes the result to `data-theme` on `<html>` and
the original preference to `data-theme-mode`. The generated stylesheet has one
block for `[data-theme='light']` and one for `[data-theme='dark']`; light is also
emitted on `:root` to make the first frame deterministic.

The preference is device-local. `theme.ts` writes it beside the other device
preferences and reports it to the main process. Main stores the scalar in
`application-settings.json`, uses its resolved value for a new BrowserWindow's
initial `backgroundColor`, and broadcasts changes so every open window repaints.
A previous object-shaped preference is accepted only as a migration input: its
`mode` becomes the scalar preference and its former family value is ignored.

Every visual value originates in the token registry and one of the two
appearance JSON files. `pnpm tokens:build` regenerates `themes.css` and
`common/theme-assets.ts`; `pnpm tokens:check` rejects drift. Bundled fonts are
addressed directly. If an appearance declares a remote WOFF2 URL, main fetches
it once, optionally verifies its integrity, stores it under `userData`, and
serves it through `rally-font://`.

## Invariants

- **There is one design and exactly two resolved appearances.** Adding a named
  theme family or another picker axis would restore UI and state the product no
  longer supports.
- **`system` is a preference, not a palette.** It must always resolve to light
  or dark before it reaches `data-theme`; otherwise the generated selectors do
  not provide a complete token set.
- **Renderer rules use semantic tokens.** A literal colour in `app.css` works in
  one appearance and bypasses the contrast decisions in the token files.
- **Both appearance files declare the full registry.** Inheritance between
  appearances makes a missing dark value silently render with the light value.
- **The shell owns the canvas background.** Repainting the same image or
  gradient on nested panes creates seams when the sidebar and feed differ in
  size.
- **The main-process window background matches the canvas token.** A mismatch
  flashes the wrong colour before the renderer's first frame.
- **Appearance files are data.** They cannot carry HTML or JavaScript, and the
  desktop registers no appearance-document protocol or iframe.

## Boundary

This module owns appearance preference, token definitions, token generation,
the renderer's CSS contract, and initial window colouring. Individual
components own their structure and choose semantic component tokens; they do
not own palettes. Application icons, member and connector brand colours, rich
attachment content, and exported message documents have their own presentation
contracts and do not become selectable Rally themes.

The private font scheme is an asset cache, not a theme execution surface. It
serves only generated, hash-addressed WOFF2 entries. The renderer cannot supply
an arbitrary URL to it.

## Failure modes and limits

- A missing or malformed preference falls back to `system`.
- A stored preference from the former object shape retains only its valid
  `mode`; an invalid mode falls back to `system`.
- A remote font response that is empty, exceeds 8 MiB, fails a declared SHA-256
  integrity check, or is not in the generated manifest returns 404 and leaves
  the UI on its fallback font.
- An appearance JSON file that omits a required token, names an undeclared
  token, uses an invalid value type, or duplicates the default fails the token
  build or its tests.

## Testing

- `pnpm tokens:check` proves the committed generated files match the two JSON
  sources.
- `pnpm test:scripts` exercises the generator, schema, token completeness,
  aliases, font declarations, and structural token rules.
- `pnpm --filter @rally/desktop exec vitest run src/common/themes.test.ts src/main/theme-assets.test.ts src/renderer/lib/theme.test.ts src/renderer/components/theme-picker.test.tsx src/renderer/styles/themes.css.node.test.ts`
  covers preference migration, resolution, cross-window behavior, the picker,
  the font cache, and CSS invariants.
- `pnpm lint`, `pnpm typecheck`, and the proportional desktop suite remain the
  repository gates. A visible change must also be inspected in a real Electron
  window in both appearances.

## Security and trust model

Appearance JSON is build-time input and produces CSS plus a fixed font
manifest. It cannot execute code. The retired animated appearance-document
scheme and iframe are absent from the renderer CSP and Electron protocol
registration. Remote font URLs are not exposed directly to the renderer; main
serves only generated IDs and enforces the cache's size and integrity checks.

## Changelog

### 2026-09-04 — Rally has one design with light and dark appearances

**What changed:** The former named palettes, family axis, design swatches,
animated backdrop document, iframe, custom protocol, schema field, generated
module, tests, and supporting CSS were removed. The stored preference is now a
scalar `system | light | dark`; previous object-shaped values migrate by keeping
only their valid appearance mode.

**Why:** The GrokBot rewrite established a single product look. Leaving the old
theme engine behind kept dead visual states, executable decoration, and a
second picker axis available to drift back into the application even though no
current product surface used them.

**Considered and rejected:** Hiding the named-theme controls while preserving
their runtime and token files. That would reduce the Settings UI but retain the
same protocol, generated assets, branches, tests, and maintenance burden.

**Consequences:** Future visual work changes both Rally appearance files rather
than adding a theme. The only compatibility code is the narrow stored-setting
migration, and no appearance can bring executable markup.

Earlier appearance-engine decisions describe code that no longer ships and are
available in the repository history before this entry.

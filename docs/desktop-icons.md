# Desktop application icons

## Current behavior

Rally has a native adaptive default icon and eight user-selectable static icons:

| Asset | Purpose |
| --- | --- |
| `apps/desktop/resources/icon.icon` | Icon Composer source for the default icon. It provides Default, Dark, and generated Mono appearances. |
| `apps/desktop/resources/app-icons/*.png` | Full-bleed 1024×1024 authoring sources for the two current treatments and six custom choices. They are not shipped as Dock icons. |
| `apps/desktop/src/renderer/assets/app-icons/*.png` | Generated 128×128 Retina previews; Vite never bundles the 1024px Dock sources. |
| `apps/desktop/native/selectable-app-icon/icon.json` | Icon Composer template used to give each selectable source a system-owned enclosure and platform effects. |
| `apps/desktop/.native-build/app-icons/*.icns` | Generated static renditions compiled by Apple's `actool` and shipped for Finder and the Dock plug-in. |
| `apps/desktop/.native-build/RallyDockTilePlugin.docktileplugin` | Generated, signed `NSDockTilePlugIn` that keeps the selected icon in the Dock when Rally is not running. |
| `apps/desktop/native/set-application-icon.js` | AppKit bridge that updates Finder and refreshes the Dock icon cache. |
| `apps/desktop/resources/menu-bar/rallyTemplate.png` (+ `@2x`) | Generated macOS template image for the menu bar status item. Black plus alpha only; macOS owns its colour. [`menu-bar.md`](menu-bar.md) owns how it is used. |
| `apps/desktop/resources/icon.icns` | Legacy, pre-masked DMG volume icon. It is not the app icon source. |

With no saved choice, macOS renders `icon.icon`, selects its appearance, and applies the current enclosure and platform effects. Selecting an icon in Settings writes only an allowlisted identifier to `~/Library/Application Support/Rally/application-icon.json`. Packaged launches intentionally keep this app-level preference in the canonical directory even when Chromium is started with `--user-data-dir`, because the out-of-process Dock plugin cannot see that switch. Package smoke tests retain an isolated override.

The packaged app then performs the native macOS flow:

1. Apple's `actool` compiles each full-bleed source through the `.icon` format. The resulting ICNS has the macOS-authored enclosure, transparency, shadow, and optical sizing; Rally never invents or bakes its own mask.
2. `NSWorkspace.setIcon(_:forFile:options:)` sets that compiled custom icon on `Rally.app`, which updates Finder, Spotlight, and Launchpad.
3. The app posts an immediate distributed notification to the Dock tile plugin. The plugin reads the saved choice and updates its `NSDockTile` content, including while Rally is closed.
4. The AppKit bridge asks the Dock to rebuild its icon cache, then notifies the plug-in again so the change appears immediately even if the refresh recreated the tile.

“Use the system icon” removes the saved preference, clears the Finder custom icon, clears the plugin content view, and refreshes the cache. The adaptive `.icon` then resumes automatically.

Product analytics records the actual icon identifier and automatic/custom state
once per initialized launch. A successful selection records the previous and
applied closed identifiers plus both automatic states. The event runs after the
native operation and preference commit; a failed selection or rollback produces
no completion event. Identified Global events update the corresponding current
PostHog person properties.

This follows the architecture described in Granola's [macOS app-icon implementation](https://www.granola.ai/blog/so-you-think-its-easy-to-change-an-app-icon). The cache refresh dynamically calls the private `SLSIconAppearanceConfiguration` selector used by System Settings. It is best-effort: icon selection still succeeds if that selector is unavailable on a later macOS release.

## Artwork rules

Keep both native and selectable source artwork unmasked:

- Do not bake a rounded rectangle, transparent corner mask, optical inset, or platform shadow into a selectable PNG.
- Each selectable PNG must be square, full-bleed, and 1024×1024. The build stages it in an Icon Composer `.icon` package and macOS owns the final app-icon enclosure and rendering.
- Keep the transparent Icon Composer mark source at 1024×1024. Default, Dark, and Mono remain appearance treatments within the one `.icon` asset.
- The legacy `icon.icns` is the only asset that deliberately contains a baked silhouette, because it is used for the DMG volume.
- The menu bar renditions are the one place colour is deliberately discarded: a macOS template image is an alpha mask, so `menu_bar_template_icon` renders the mark in pure black at 16 pt and 32 pt and lets AppKit paint it. Both the `Template` filename suffix and the `@2x` sibling are load-bearing; see [`menu-bar.md`](menu-bar.md).

The renderer preview uses generated 128×128 copies and CSS rounding only to represent the macOS tile. That rounding is not written into the 1024px source files.

## Change the current Rally icon

1. Update `assets/brand/rally-mark-source.png` or the colors/composition in `scripts/generate-brand-assets.py`.
2. Regenerate the derived assets from the repository root:

   ```text
   python3 scripts/generate-brand-assets.py
   ```

3. Open `apps/desktop/resources/icon.icon` in Icon Composer and inspect Default, Dark, and Mono.
4. Build the signed app and inspect the Dock, Finder, Spotlight, and Launchpad in light and dark system appearances.

Do not hand-edit the generated light/dark copies or renderer previews. A later generator run must reproduce them without unrelated diffs. The six custom 1024px PNGs are committed artwork sources rather than output synthesized by this script.

## Add a selectable icon

1. Add an opaque, full-bleed 1024×1024 PNG under `apps/desktop/resources/app-icons`. Do not pre-mask it; `build-macos-icon-components.mjs` compiles it through the checked-in `.icon` template.
2. Add its identifier to `TELEMETRY_APPLICATION_ICON_IDS` in `packages/contracts/src/telemetry.ts`, then add its label to `applicationIconLabels` in `apps/desktop/src/common/application-icons.ts`. The shared identifier allowlist drives the renderer, main IPC validation, filenames, and telemetry schema; IPC never accepts a filesystem path.
3. Add the same identifier to the Dock plugin allowlist in `apps/desktop/native/dock-tile-plugin/RallyDockTilePlugin.m`.
4. Add its identifier to `selectableIconNames` in `apps/desktop/scripts/build-macos-icon-components.mjs`, run `python3 scripts/generate-brand-assets.py` to produce the 128px renderer preview, then import that preview in `apps/desktop/src/renderer/components/application-icon-picker.tsx`.
5. Add the expected resource to `apps/desktop/scripts/verify-macos-app.mjs` and update focused tests.

The Dock plugin is compiled for arm64 during guarded packaging by `apps/desktop/scripts/build-macos-icon-components.mjs`. Do not commit `.native-build` output.

## Bundle and signing constraints

electron-builder compiles `icon.icon` into `Assets.car`, embeds the ICNS fallback, copies the system-compiled selectable ICNS files and AppKit bridge into `Contents/Resources`, and copies the Dock tile plugin into `Contents/PlugIns`. The plugin is nested executable code and must be signed with the same Developer ID identity as the app.

Never manually rewrite signed files under `Contents`. The Finder API does add the standard `Icon\r` file and `com.apple.FinderInfo` metadata at the application-bundle root, just as pasting an icon in Finder’s Get Info window does. On current macOS this leaves non-strict code-signature verification valid, while `codesign --strict` rejects the Finder metadata until the icon is reset. Treat a notarized Gatekeeper assessment and a complete auto-update cycle with a selected icon as release sign-off requirements; do not claim the custom metadata is absent from the bundle.

## Verification

Run focused checks while iterating:

```text
pnpm --filter @rally/desktop test
pnpm --filter @rally/desktop typecheck
# arm64 macOS only:
pnpm --filter @rally/desktop build:macos-icons
pnpm exec eslint apps/desktop/src/main/application-icon.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/components/application-icon-picker.tsx
```

Before release, build the guarded local package:

```text
pnpm package:desktop
```

The package verifier checks:

- `Assets.car`, `CFBundleIconName`, and the ICNS fallback for the native default;
- `NSDockTilePlugIn` and the signed plugin executable;
- all eight selectable ICNS renditions generated by Apple's `actool`;
- the AppKit bridge used for Finder and cache updates; and
- both menu bar template renditions, whose names are resolved at runtime rather than referenced in code.

The plugin build also compiles and executes a smoke harness that invokes `setDockTile:nil`. This catches recursive implementations of the protocol setter before packaging.

Launch the packaged app with `pnpm start:desktop:packaged`, select several icons, quit Rally, and confirm the choice remains in the Dock. Check Finder, Spotlight, and Launchpad, then choose “Use the system icon” and confirm the adaptive icon returns.

For a notarized release candidate, repeat the selected-icon test from an installed copy, run `spctl -a -vvv --type execute /Applications/Rally.app`, and complete one auto-update before release approval. `codesign --verify --deep` should continue to pass with a selected icon; `codesign --verify --deep --strict` is expected to reject Finder's custom-icon attributes until reset.

## Troubleshooting

- **The Dock changes only while Rally runs:** confirm `NSDockTilePlugIn` names `RallyDockTilePlugin.docktileplugin`, the signed plugin is under `Contents/PlugIns`, and the preference file contains an allowlisted identifier.
- **Finder changes but the Dock does not:** inspect the Dock plugin signature and distributed notification name, then relaunch the Dock during development to force plugin discovery.
- **The icon is square or double-masked:** confirm the source PNG is full-bleed and has no baked mask, inset, or platform shadow, then rebuild the selectable ICNS renditions with `pnpm --filter @rally/desktop build:macos-icons`.
- **Reset leaves a stale icon:** confirm the native bridge can resolve `SLSIconAppearanceConfiguration`. The default returns after the Dock cache is rebuilt even when the private best-effort refresh is unavailable.
- **Packaging rejects nested code:** rebuild with `pnpm --filter @rally/desktop build:macos-icons` and verify the plugin contains only an arm64 executable before electron-builder signs it.

## Changelog

### 2026-08-27 — The mark artwork is the redesigned loop and brand primary is #CCFF00

**What changed:** `assets/brand/rally-mark-source.png` now holds the redesigned
Rally mark — a single continuous looping line — rendered at 1024 px from the
canonical SVG (`apps/site/public/brand/rally-mark.svg`), and the generator's
`PRIMARY` moved from `#CEDC00` to `#CCFF00` to match the logo. Every generated
asset was regenerated: the Icon Composer mark, the legacy DMG ICNS, the
generated light/dark selectable icons and their previews, the menu bar
templates, the favicon, the touch icon, and the social card. The social card's
volt motif is now the mark itself, composited from the mask, replacing a
parametric lemniscate that had been drawn in code and no longer resembled the
logo.

**Why:** The public site had already switched to the new mark and the new lime
(shipped with the Convergence hero), leaving the desktop icons, favicon, and
social card carrying the previous woven ring — a visible mismatch between the
browser tab, the Dock, and the page. The site's mark PNGs had been replaced out
of band of the generator, so rerunning it would have regressed them; this
change makes the generator the source of truth again.

**Considered and rejected:** Keeping the woven mark in the source mask and
hand-editing only the web assets. That leaves every future generator run a
regression, which is precisely the failure mode this pipeline exists to
prevent.

**Consequences:** The six custom selectable PNGs are committed artwork and
still carry their own designs untouched. `icon.icon` should be opened in Icon
Composer to inspect Default, Dark, and Mono, and the next signed package build
should be checked in the Dock in both appearances, per this document's
verification section.

### 2026-08-13 — Icon choice has one product and telemetry taxonomy

**What changed:** The selectable icon identifiers now come from the closed
telemetry contract, while the desktop owns labels and generated filenames.
Successful native selections emit previous and applied icon/automatic state;
launch snapshots preserve current state.

**Why:** Product analysis needs to know which icon was actually applied, but a
second analytics-only list would drift when a new selectable icon is added.

**Considered and rejected:** Reporting display labels, filesystem paths, or the
renderer click before the AppKit operation. They are respectively mutable,
unbounded, or capable of recording a selection that rolled back.

**Consequences:** Adding an icon starts at `TELEMETRY_APPLICATION_ICON_IDS` and
must update the desktop label, artwork, plugin, packaging, and telemetry tests.
Product analytics opt-out suppresses the events and current-person updates.

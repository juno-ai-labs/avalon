# Desktop application icons

## Current behavior

Rally has a native adaptive default icon and seven user-selectable static
icons: Light, Dark, Calm, Ludicrous speed, Homage, Builder, and Quiet.
Light and Dark are generated flat treatments. The other five are supplied
artwork, committed as full-bleed PNG sources; no procedural texture renderer
is involved.

| Asset | Purpose |
| --- | --- |
| `apps/desktop/resources/icon.icon` | Icon Composer source for the default icon. It provides Default, Dark, and generated Mono appearances. |
| `apps/desktop/resources/app-icons/*.png` | Full-bleed 1024×1024 authoring sources, one per selectable icon. They are not shipped as Dock icons. |
| `apps/desktop/src/renderer/assets/app-icons/*.png` | Generated 128×128 Retina previews; Vite never bundles the 1024px Dock sources. |
| `apps/desktop/native/selectable-app-icon/icon.json` | Icon Composer template used to give each selectable source a system-owned enclosure and platform effects. |
| `apps/desktop/.native-build/app-icons/manifest.json` | Versioned catalog of selectable IDs, read afresh by the Dock plugin on each notification. |
| `apps/desktop/.native-build/app-icons/*.icns` | Generated static renditions compiled by Apple's `actool` and shipped for Finder and the Dock plug-in. |
| `apps/desktop/.native-build/RallyDockTilePluginV2.docktileplugin` | Generated, signed `NSDockTilePlugIn` that keeps the selected icon in the Dock when Rally is not running. |
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

The selectable list uses `CURRENT_APPLICATION_ICON_IDS`; telemetry ingestion
keeps all shipped IDs in `TELEMETRY_APPLICATION_ICON_IDS` so older clients and
spooled events remain valid. Never reuse a retired ID for different artwork:
Ludicrous speed uses `ludicrous`, while historical `ludicrous-speed` stays retired.
Startup resets the native icon for a recognized retired preference, then clears
the preference. A failed reset leaves the preference intact for a later retry.
The preview generator deletes only previews whose source has been removed; it
never deletes supplied sources.

## Artwork rules

Keep both native and selectable source artwork unmasked:

- Calm, Ludicrous speed, Homage, Builder, and Quiet are committed artwork.
  The brand generator preserves these sources and only refreshes their previews.
- Light and Dark are generator output; change their generator rather than PNGs.
- Do not bake a rounded rectangle, transparent corner mask, optical inset, or platform shadow into a selectable PNG.
- Each selectable PNG must be square, full-bleed, and 1024×1024. The build stages it in an Icon Composer `.icon` package and macOS owns the final app-icon enclosure and rendering.
- Keep the transparent Icon Composer mark source at 1024×1024. Default, Dark, and Mono remain appearance treatments within the one `.icon` asset.
- The legacy `icon.icns` is the only asset that deliberately contains a baked silhouette, because it is used for the DMG volume.
- The menu bar renditions are the one place colour is deliberately discarded: a macOS template image is an alpha mask, so `menu_bar_template_icon` renders the mark in pure black at 16 pt and 32 pt and lets AppKit paint it. Both the `Template` filename suffix and the `@2x` sibling are load-bearing; see [`menu-bar.md`](menu-bar.md).

The renderer preview uses generated 128×128 copies and CSS rounding only to represent the macOS tile. That rounding is not written into the 1024px source files.

## Change the current Rally icon

1. Update `apps/site/public/brand/rally-mark.svg` and
   `assets/brand/rally-mark-source.png` together. Generated flat assets use the
   raster mask; the five supplied artworks must be updated separately if needed.
   Generated colours and composition live in `scripts/generate-brand-assets.py`.
2. Regenerate the derived assets from the repository root:

   ```text
   python3 scripts/generate-brand-assets.py
   ```

3. Open `apps/desktop/resources/icon.icon` in Icon Composer and inspect Default, Dark, and Mono.
4. Build the signed app and inspect the Dock, Finder, Spotlight, and Launchpad in light and dark system appearances.

Do not hand-edit generated flat artwork or renderer previews. A later generator run
must reproduce them without unrelated diffs, so review what the run rewrote and
revert any file whose pixels did not actually change — PNG encoder output
differs between Pillow releases, and that churn is not a change to the artwork.

**The social card is skipped off macOS.** It is the only generated asset with
type in it, set in a system font that exists only there. The script says so
when it skips; regenerating it anywhere else would quietly substitute a
different typeface over the committed card.

## Add a selectable icon

1. Add the supplied artwork to `apps/desktop/resources/app-icons/<id>.png` as
   an opaque, full-bleed 1024×1024 image. Do not pre-mask it: the native build
   compiles it through the checked-in Icon Composer template.
2. Add its identifier to `CURRENT_APPLICATION_ICON_IDS` in `packages/contracts/src/telemetry.ts`, then add its label to `applicationIconLabels` in `apps/desktop/src/common/application-icons.ts`. The current identifier allowlist drives the renderer, main IPC validation, filenames, and telemetry schema; IPC never accepts a filesystem path.
3. Add its identifier to `selectableIconNames` in `apps/desktop/scripts/build-macos-icon-components.mjs`, run `python3 scripts/generate-brand-assets.py` to produce its 128px renderer preview, then import that preview in `apps/desktop/src/renderer/components/application-icon-picker.tsx`.
4. Add the expected resource to `apps/desktop/scripts/verify-macos-app.mjs` and update focused tests.

The build writes `manifest.json` beside the compiled icons from `selectableIconNames`.
The plugin reads that catalog and the image from the installed bundle on every
notification. Do not compile or cache the selectable IDs in the plugin: macOS can
keep its host alive while the updater replaces the app. Identifiers must contain only lowercase ASCII letters, digits, and hyphens
(`[a-z0-9-]+`); the native build and portable release tests enforce this before
packaging. The plugin validates the same grammar before constructing image paths. Missing,
unsupported, or malformed catalogs clear the custom tile; the next notification
retries the read.

The V2 bundle, executable, bundle identifier, and Objective-C principal class form
a new plugin identity. This transitions installations away from the old process
that held a compiled allowlist. Keep the builder, signer, and verifier aligned
with this identity. Catalog-only changes do not require another identity change for in-place updates.
`NSBundle.bundleURL` retains the original installation URL when ShipIt moves the
loaded binary into staging. The file backing the process (shown by `lsof`) can
therefore have a different path without changing resource lookup. The bundle
smoke test loads the actual plugin, replaces the complete app at its original
URL, deletes the staged old binary, and verifies the retained plugin displays new
artwork. Lookup stays local to that installation; global bundle-ID discovery
could instead select a different installed copy of Rally.

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
- all seven selectable ICNS renditions generated by Apple's `actool`;
- the packaged manifest's presence, version, and exact selectable IDs;
- the AppKit bridge used for Finder and cache updates; and
- both menu bar template renditions, whose names are resolved at runtime rather than referenced in code.

The plugin build also compiles and executes a native smoke harness. It rejects
incorrect source dimensions and transparent pixels, exercises `setDockTile:nil`,
and replaces real on-disk icon resources while retaining the same plugin
instance. It verifies new artwork, retired IDs, traversal rejection, unsupported
and missing catalogs, recovery, and reset. The fixture redirects only the
installation and preference directories; parsing, image loading, and refresh
use production code. A separate bundle smoke executable dynamically loads the
built plugin and isolates only preferences, so resource lookup itself is covered.
Both use their own application's real `NSDockTile` and assert its content view.
Portable release tests exercise electron-builder's actual resource matcher and
compare build/verifier IDs to `CURRENT_APPLICATION_ICON_IDS`.

Launch the packaged app with `pnpm start:desktop:packaged`, select several icons, quit Rally, and confirm the choice remains in the Dock. Check Finder, Spotlight, and Launchpad, then choose “Use the system icon” and confirm the adaptive icon returns.

For a notarized release candidate, repeat the selected-icon test from an installed copy, run `spctl -a -vvv --type execute /Applications/Rally.app`, and complete one auto-update before release approval. `codesign --verify --deep` should continue to pass with a selected icon; `codesign --verify --deep --strict` is expected to reject Finder's custom-icon attributes until reset.

## Troubleshooting

- **The Dock changes only while Rally runs:** confirm `NSDockTilePlugIn` names `RallyDockTilePluginV2.docktileplugin`, the signed plugin is under `Contents/PlugIns`, and the preference file contains an identifier listed in the installed `manifest.json`.
- **Finder changes but the Dock does not:** inspect the Dock plugin signature, distributed notification name, and the installed catalog. Use `lsof` on the Dock plugin host to check whether it still maps an older updater bundle. A V2 installation must load the V2 plugin; restarting the whole Dock is not the upgrade mechanism.
- **The icon is square or double-masked:** confirm the source PNG is full-bleed and has no baked mask, inset, or platform shadow, then rebuild the selectable ICNS renditions with `pnpm --filter @rally/desktop build:macos-icons`.
- **Reset leaves a stale icon:** confirm the native bridge can resolve `SLSIconAppearanceConfiguration`. The default returns after the Dock cache is rebuilt even when the private best-effort refresh is unavailable.
- **Packaging rejects nested code:** rebuild with `pnpm --filter @rally/desktop build:macos-icons` and verify the plugin contains only an arm64 executable before electron-builder signs it.

## Changelog

### 2026-09-07 — Verify catalog shipping and real bundle replacement

**What changed:** Included the catalog in electron-builder's ICNS resource filter,
added a portable matcher regression and catalog/contract consistency checks,
and exercised the real dynamically loaded plugin across complete app replacement.
Native checks now cover same-ID image changes, malformed types, and the tile's
content view without reading the developer's preferences.

**Why:** PR review found that generating the catalog did not ensure packaging
copied it. Review also questioned whether a mapped ShipIt path changed resource
lookup; a real bundle test established that NSBundle retains the installation URL,
where the replacement resources are installed, even after deleting the old binary.

**Considered and rejected:** Global Launch Services discovery is unnecessary for
in-place updates and could choose another Rally installation. Accepting unknown
manifest versions would hide incompatible schema changes; additive artwork keeps
version 1. A compiled-list or cached-image regression must fail the native checks.

**Consequences:** The packaging filter is exercised on Linux as well as macOS.
The native bundle test must not override resource lookup. A signed notarized
update cycle remains the release acceptance check beyond these fixtures.

PR: #577.

### 2026-09-07 — Dock hosts read the installed icon catalog across upgrades

**What changed:** Replaced the compiled selectable-ID allowlist with a versioned
catalog generated beside the ICNS resources and read on every refresh. A new V2
plugin identity transitions already-running hosts away from the old implementation.
Packaging signs and verifies the new identity and checks the catalog against the
shipped icons. Native smoke coverage replaces resources beneath a surviving instance.

**Why:** Finder accepted a selection while the Dock continued displaying stale
artwork. The Dock host had retained a binary from a deleted ShipIt staging bundle;
its UUID differed from the installed plugin. Reloading that host restored icon
selection. The procedural artwork change exposed the compiled-list lifetime bug;
it did not change the native setter.

**Considered and rejected:** Restarting the Dock disrupts unrelated apps and fixes
only one session. Recompiling another list leaves the same failure on the next
artwork replacement. The catalog must be re-read, rather than cached at startup.

**Consequences:** The manifest format is a compatibility contract for long-lived
hosts. Keep version 1 for additive artwork changes. A real macOS fixture verified
that replacing a V1 bundle with V2 loads the new plugin while the old host remains
alive. A signed, notarized updater cycle remains a release sign-off requirement.

PR: #577.

### 2026-09-06 — Preserve released icon identities through replacement

**What changed:** Split current selectable IDs from the historical telemetry
allowlist, gave the new Ludicrous speed artwork the unused `ludicrous` ID,
and made startup clean up native icons for retired preferences. Regenerated
previews through the documented Pillow pipeline, restored orphan-preview
cleanup, and added a native packaging gate for opaque 1024px sources.

**Why:** Review found that replacing the ingestion enum rejected old-client
and spooled events, while reusing a retired ID silently selected different art.
The initial previews also used a different resampler than the documented pipeline.

**Considered and rejected:** Rewriting old events or reusing their identifiers
would conflate different artwork. Clearing a retired preference before native
cleanup succeeds would lose the retry signal if Finder reset failed.

**Consequences:** Historical telemetry IDs remain accepted but unselectable.
The full-bleed check runs in native packaging; it cannot detect an opaque image
that visually depicts a baked mask, which still needs visual review.

PR: #566.

### 2026-09-06 — Replace procedural textures with supplied artwork

**What changed:** Calm, Ludicrous speed, Homage, Builder, and Quiet replace the
five procedural materials. Their supplied PNGs are resized to 1024px native
sources and 128px previews. The procedural texture renderer and old assets
are removed, and the brand generator preserves the supplied sources.

**Why:** The requested artwork is the intended visual treatment. Reconstructing
it procedurally would lose the supplied details and composition.

**Considered and rejected:** Keeping the old texture generator alongside the new
artwork would retain unused code and risk restoring retired icons on regeneration.
This reverses the generated-texture decision recorded on 2026-08-27.

**Consequences:** Light, Dark, and the adaptive system icon retain their existing
pipeline. The five supplied designs require explicit artwork updates when the
logo changes. Retired saved identifiers fall back to the automatic system icon;
historical analytics retain their original identifiers.

### 2026-08-27 — The selectable shelf is one mark in seven materials, generated

**What changed:** The six hand-made selectable icons (`sunset-sherbet`,
`ludicrous-speed`, `ruby`, `holographic`, `leather`, `blueprint`) were retired
and replaced by five generated ones: `grass-court`, `clay-court`, `hard-court`,
`ball-felt`, and `night-match`. `light` and `dark` are unchanged. The new
artwork is produced by `scripts/selectable_icon_artwork.py`, which rasterizes
the mark from `apps/site/public/brand/rally-mark.svg` as a distance field and
composites a material around it, and the whole set is now output of
`generate-brand-assets.py` rather than committed artwork.

**Why:** The six custom icons still carried the *previous* woven-ring mark, so
the shelf showed two different logos side by side — the same drift the entry
below fixed for the generated assets, reappearing in the artwork that entry had
deliberately left alone. Generating them closes it permanently: there is no
longer any selectable icon that can fall behind the logo, because none of them
holds a copy of it.

**Considered and rejected:** Redrawing six PNGs by hand with the new mark. It
fixes today's mismatch and rebuilds the same trap — the next mark change would
need six more hand edits, which is exactly the failure that produced this one.
Also rejected: deriving the textured marks from `rally-mark-source.png`, the
raster mask everything else uses. Paint bleeding into grass, dust settling on a
line, fibre overhanging a channel and a neon tube's falloff are all functions of
distance to the stroke centre line, and an 8-bit alpha mask cannot supply it;
the SVG path can.

**Consequences:** Regenerating brand assets now needs Pillow *and* NumPy, and
takes about 25 seconds rather than one. Texture seeds are fixed, so a rerun
reproduces the artwork byte-for-byte on the same Pillow; changing a seed is an
artwork change. A preference holding a retired identifier fails
`parseApplicationIconId` and the app falls back to the automatic light/dark
icon, which is the same path an unset preference takes — retired identifiers
are gone from `TELEMETRY_APPLICATION_ICON_IDS`, so no client can emit one
again, while events already recorded under the old names keep their values.
`generate-brand-assets.py` also now skips the social card off macOS instead of
overwriting it with a substitute typeface; that bug was found by running the
generator in the sandbox for this change.

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

# Desktop application icons

## Current behavior

Avalon has a native adaptive default icon and eight user-selectable static icons:

| Asset | Purpose |
| --- | --- |
| `apps/desktop/resources/icon.icon` | Icon Composer source for the default icon. It provides Default, Dark, and generated Mono appearances. |
| `apps/desktop/resources/app-icons/*.png` | Full-bleed 1024×1024 sources for the two current treatments and six custom choices. |
| `apps/desktop/.native-build/AvalonDockTilePlugin.docktileplugin` | Generated, signed `NSDockTilePlugIn` that keeps the selected icon in the Dock when Avalon is not running. |
| `apps/desktop/native/set-application-icon.js` | AppKit bridge that updates Finder and refreshes the Dock icon cache. |
| `apps/desktop/resources/icon.icns` | Legacy, pre-masked DMG volume icon. It is not the app icon source. |

With no saved choice, macOS renders `icon.icon`, selects its appearance, and applies the current enclosure and platform effects. Selecting an icon in Settings writes only an allowlisted identifier to `~/Library/Application Support/Avalon/application-icon.json`.

The packaged app then performs the native macOS flow:

1. `NSWorkspace.setIcon(_:forFile:options:)` sets the custom icon on `Avalon.app`, which updates Finder, Spotlight, and Launchpad.
2. The app posts a distributed notification to the Dock tile plugin. The plugin reads the saved choice and updates its `NSDockTile` content, including while Avalon is closed.
3. The AppKit bridge asks the Dock to rebuild its icon cache so the change appears immediately.

“Use the system icon” removes the saved preference, clears the Finder custom icon, clears the plugin content view, and refreshes the cache. The adaptive `.icon` then resumes automatically.

This follows the architecture described in Granola's [macOS app-icon implementation](https://www.granola.ai/blog/so-you-think-its-easy-to-change-an-app-icon). The cache refresh dynamically calls the private `SLSIconAppearanceConfiguration` selector used by System Settings. It is best-effort: icon selection still succeeds if that selector is unavailable on a later macOS release.

## Artwork rules

Keep both native and selectable source artwork unmasked:

- Do not bake a rounded rectangle, transparent corner mask, optical inset, or platform shadow into a selectable PNG.
- Each selectable PNG must be square, full-bleed, and 1024×1024. macOS owns the final app-icon enclosure and rendering.
- Keep the transparent Icon Composer mark source at 1024×1024. Default, Dark, and Mono remain appearance treatments within the one `.icon` asset.
- The legacy `icon.icns` is the only asset that deliberately contains a baked silhouette, because it is used for the DMG volume.

The renderer preview uses CSS rounding only to represent the macOS tile. That rounding is not written into the source files.

## Change the current Avalon icon

1. Update `assets/brand/avalon-mark-source.png` or the colors/composition in `scripts/generate-brand-assets.py`.
2. Regenerate the derived assets from the repository root:

   ```text
   python3 scripts/generate-brand-assets.py
   ```

3. Open `apps/desktop/resources/icon.icon` in Icon Composer and inspect Default, Dark, and Mono.
4. Build the signed app and inspect the Dock, Finder, Spotlight, and Launchpad in light and dark system appearances.

Do not hand-edit generated light/dark copies. A later generator run must reproduce them without unrelated diffs.

## Add a selectable icon

1. Add an opaque, full-bleed 1024×1024 PNG under `apps/desktop/resources/app-icons`.
2. Add its identifier, label, and filename to `applicationIconChoices` in `apps/desktop/src/common/application-icons.ts`. This allowlist is shared by renderer and main; IPC never accepts a filesystem path.
3. Add the same identifier to the Dock plugin allowlist in `apps/desktop/native/dock-tile-plugin/AvalonDockTilePlugin.m`.
4. Import the PNG in `apps/desktop/src/renderer/components/application-icon-picker.tsx`.
5. Add the expected resource to `apps/desktop/scripts/verify-macos-app.mjs` and update focused tests.

The Dock plugin is compiled for arm64 during guarded packaging by `apps/desktop/scripts/build-macos-icon-components.mjs`. Do not commit `.native-build` output.

## Bundle and signing constraints

electron-builder compiles `icon.icon` into `Assets.car`, embeds the ICNS fallback, copies the selectable PNGs and AppKit bridge into `Contents/Resources`, and copies the Dock tile plugin into `Contents/PlugIns`. The plugin is nested executable code and must be signed with the same Developer ID identity as the app.

Never rewrite files inside the signed application bundle. `NSWorkspace.setIcon` stores Finder's custom-icon metadata through the supported file-icon API rather than changing signed bundle contents.

## Verification

Run focused checks while iterating:

```text
pnpm --filter @avalon/desktop test
pnpm --filter @avalon/desktop typecheck
pnpm --filter @avalon/desktop build:macos-icons
pnpm exec eslint apps/desktop/src/main/application-icon.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/components/application-icon-picker.tsx
```

Before release, build the guarded local package:

```text
pnpm package:desktop
```

The package verifier checks:

- `Assets.car`, `CFBundleIconName`, and the ICNS fallback for the native default;
- `NSDockTilePlugIn` and the signed plugin executable;
- all eight 1024×1024 selectable PNGs; and
- the AppKit bridge used for Finder and cache updates.

Launch the packaged app with `pnpm start:desktop:packaged`, select several icons, quit Avalon, and confirm the choice remains in the Dock. Check Finder, Spotlight, and Launchpad, then choose “Use the system icon” and confirm the adaptive icon returns.

## Troubleshooting

- **The Dock changes only while Avalon runs:** confirm `NSDockTilePlugIn` names `AvalonDockTilePlugin.docktileplugin`, the signed plugin is under `Contents/PlugIns`, and the preference file contains an allowlisted identifier.
- **Finder changes but the Dock does not:** inspect the Dock plugin signature and distributed notification name, then relaunch the Dock during development to force plugin discovery.
- **The icon is square or double-masked:** confirm the source PNG is full-bleed and has no baked mask, inset, or platform shadow.
- **Reset leaves a stale icon:** confirm the native bridge can resolve `SLSIconAppearanceConfiguration`. The default returns after the Dock cache is rebuilt even when the private best-effort refresh is unavailable.
- **Packaging rejects nested code:** rebuild with `pnpm --filter @avalon/desktop build:macos-icons` and verify the plugin contains only an arm64 executable before electron-builder signs it.

# Desktop application icons

## When to use this system

Use the desktop icon system when:

- changing Avalon's macOS application artwork;
- changing its default, dark, or mono appearance treatment; or
- changing how the app is packaged for current and older macOS releases.

Do not use it for renderer logos, the website favicon, the Apple touch icon, or the social card alone. Those assets share the canonical mark but have different consumers. Update `scripts/generate-brand-assets.py` so every generated surface remains reproducible.

## Current behavior

The macOS app has one native authoring asset and two generated raster consumers:

| Asset | Purpose |
| --- | --- |
| `apps/desktop/resources/icon.icon` | Icon Composer source. It contains one transparent mark plus Default, Dark, and generated Mono appearance treatments; electron-builder compiles it to `Assets.car`, sets `CFBundleIconName`, and generates the bundle's ICNS fallback. |
| `apps/desktop/resources/icon.png` | Full-bleed Windows/Linux packaging and window icon. It is not the macOS application icon source. |
| `apps/desktop/resources/icon.icns` | Legacy, pre-masked DMG volume icon. It is not the macOS application icon source. |

The Icon Composer asset contains an unmasked transparent artwork layer. Its Default appearance uses an off-white background with the dark mark; Dark uses a dark background with the chartreuse mark; Mono is system-generated. macOS selects the appearance and applies the enclosure, shadow, and current platform effects. This keeps the app icon aligned if Apple changes the system shape.

Do not call Electron's `app.dock.setIcon` for the default icon. That API replaces the system-managed bundle icon with a decoded raster image and bypasses the adaptive asset-catalog treatment.

## Change the existing Avalon icon

1. Update the canonical alpha source at `assets/brand/avalon-mark-source.png` or the colors/composition in `scripts/generate-brand-assets.py`.
2. Keep the transparent mark source at 1024×1024. Do not bake a background, rounded mask, or platform shadow into the Icon Composer layer.
3. Regenerate every derived asset from the repository root:

   ```text
   python3 scripts/generate-brand-assets.py
   ```

   This also refreshes `icon.icon/Assets/avalon-mark.png` and the legacy DMG ICNS.

4. Open `apps/desktop/resources/icon.icon` in Apple's Icon Composer and review Default, Dark, and Mono previews. Keep enclosure masking under system control.

5. Compile the asset with the same Xcode toolchain used by packaging:

   ```text
   pnpm package:desktop
   ```

6. Launch the packaged app and review the Dock, Finder, Spotlight, and both system appearances before release.

Do not hand-edit generated copies. A later generator run must reproduce all committed assets without unrelated diffs.

## Native asset versus runtime override

electron-builder compiles the `.icon` package with Xcode's `actool`, embeds `Assets.car`, and also emits `icon.icns` for systems that don't understand the new catalog. The package verifier checks all three pieces: `CFBundleIconName`, the catalog's icon renditions, and the fallback ICNS.

If product requirements later demand a user-selectable icon, treat that as a separately reviewed native macOS feature. Do not reintroduce `app.dock.setIcon`: it affects only a running process, bypasses the adaptive asset, and doesn't update Finder or Spotlight. Never modify files inside a signed application bundle after packaging.

The build path follows electron-builder's [Icon Composer guidance](https://www.electron.build/docs/features/icons-and-images/#macos-icon-format-asset-catalog) and requires Xcode 26 or newer on the macOS packaging machine.

## Verification

Run focused checks while iterating:

```text
pnpm --filter @avalon/desktop test
pnpm --filter @avalon/desktop typecheck
pnpm exec eslint apps/desktop/src/main/index.ts apps/desktop/scripts/verify-macos-app.mjs
```

Before release, build the guarded local package:

```text
pnpm package:desktop
```

The packaging verifier requires the compiled native asset and its compatibility fallback:

```text
Avalon.app/Contents/Resources/icon.icns
Avalon.app/Contents/Resources/Assets.car
Avalon.app/Contents/Info.plist: CFBundleIconName = Icon
```

Launch the packaged app with `pnpm start:desktop:packaged`, switch macOS appearance and icon treatments, and confirm the Dock and Finder remain consistent.

## Troubleshooting

- **Packaging says `actool` is missing or too old:** install Xcode 26 or newer and verify `xcrun actool --version`.
- **The packaged app shows Electron's icon:** confirm `mac.icon` points to `resources/icon.icon`, `Assets.car` exists, and `CFBundleIconName` is `Icon`.
- **The old icon persists after installing a new build:** quit the running process and relaunch it. Finder or Dock caches may require removing and re-adding the item.
- **The icon is square in the Dock:** confirm no code calls `app.dock.setIcon`; a runtime raster override bypasses the system-managed enclosure.

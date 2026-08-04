# Desktop application icons

## When to use this system

Use the desktop icon system when:

- changing Avalon's macOS application artwork;
- adding a light or dark appearance for an existing icon family;
- adding an icon family that may become user-selectable; or
- changing how the running macOS Dock icon follows system appearance.

Do not use it for renderer logos, the website favicon, the Apple touch icon, or the social card alone. Those assets share the canonical mark but have different consumers. Update `scripts/generate-brand-assets.py` so every generated surface remains reproducible.

## Current behavior

The macOS app has one static bundle icon and one runtime icon family:

| Asset | Purpose |
| --- | --- |
| `apps/desktop/resources/icon.icns` | Static icon embedded in `Avalon.app`; Finder, Launchpad, and Spotlight use this fallback. |
| `apps/desktop/resources/icons/avalon-light.icns` | Dock icon while the native appearance is light. |
| `apps/desktop/resources/icons/avalon-dark.icns` | Dock icon while the native appearance is dark. |
| `apps/desktop/resources/icon.png` | Windows/Linux packaging and window icon; it is not copied into the macOS bundle. |

`apps/desktop/src/main/application-icon.ts` is the registry and ICNS loader. `apps/desktop/src/main/index.ts` reads `nativeTheme.shouldUseDarkColors`, applies the matching variant after Electron is ready, and reapplies it when `nativeTheme` emits `updated`.

Electron's `nativeImage` API decodes PNG/JPEG rather than ICNS directly. The loader therefore reads the selected ICNS container, validates its entries, and passes its largest embedded PNG representation to Electron. The ICNS file remains the single macOS source of truth; do not add a parallel macOS runtime PNG.

## Change the existing Avalon icon

1. Update the canonical alpha source at `assets/brand/avalon-mark-source.png` or the colors/composition in `scripts/generate-brand-assets.py`.
2. Keep the source artwork at least 1024×1024. Light and dark variants must remain legible independently; do not assume a particular Dock wallpaper.
3. Regenerate every derived asset from the repository root:

   ```text
   python3 scripts/generate-brand-assets.py
   ```

4. Inspect both ICNS files. On macOS, `iconutil` should extract eight standard representations, including 1024×1024:

   ```text
   iconutil -c iconset apps/desktop/resources/icons/avalon-light.icns
   iconutil -c iconset apps/desktop/resources/icons/avalon-dark.icns
   ```

   `iconutil` writes adjacent `.iconset` directories for this form of the command. Remove those inspection-only directories before committing.

5. Run the checks in [Verification](#verification), then review the icon in both macOS appearances before release.

Do not hand-edit generated copies. A later generator run must reproduce all committed assets without unrelated diffs.

## Add a future selectable icon family

An icon family is one logical choice with a light and dark ICNS variant.

1. Extend `scripts/generate-brand-assets.py` to emit both files under `apps/desktop/resources/icons` using the naming convention `<family>-light.icns` and `<family>-dark.icns`.
2. Add the family and filenames to `applicationIconFamilies` in `apps/desktop/src/main/application-icon.ts`. This registry is the allowed set; do not construct a path from an unvalidated preference string.
3. When the product exposes icon selection, persist only the registered family name in main-process-owned settings. Validate the stored value against the registry before passing it to `setApplicationIcon` in `apps/desktop/src/main/index.ts`. Renderer IPC must accept a family identifier, never an arbitrary filesystem path.
4. Update `apps/desktop/src/main/application-icon.test.ts` and the expected ICNS resources in `apps/desktop/scripts/verify-macos-app.mjs`.
5. No packaging rule is needed for another top-level ICNS file: `electron-builder.yml` already copies `resources/icons/*.icns` into `Contents/Resources/icons` on macOS.

Every family must provide both appearances. Do not silently fall back from a missing dark file to light, because that can hide incomplete release assets.

## Bundle icon versus live Dock icon

`app.dock.setIcon` changes only the running process's Dock icon. It does not rewrite the signed application bundle or permanently update Finder, Launchpad, or Spotlight. When Avalon is not running, macOS uses the static `icon.icns` bundle fallback.

If product requirements later demand a user-selected icon everywhere, treat that as a native macOS feature rather than extending the current Electron override. It requires a reviewed design for a Dock tile plugin, Finder custom-icon handling, persistence, reset behavior, cache refresh, code signing, and upgrades. Never modify files inside the signed application bundle after packaging. Granola's [app icon implementation write-up](https://www.granola.ai/blog/so-you-think-its-easy-to-change-an-app-icon) explains the relevant Dock/Finder distinction and cache behavior.

The package layout follows electron-builder's [Icons & Images guidance](https://www.electron.build/docs/features/icons-and-images/): a prebuilt `icon.icns` is used as-is for the macOS bundle, and platform-specific resources are declared under the matching platform configuration.

## Verification

Run focused checks while iterating:

```text
pnpm --filter @avalon/desktop test
pnpm --filter @avalon/desktop typecheck
pnpm exec eslint apps/desktop/src/main/application-icon.ts apps/desktop/src/main/application-icon.test.ts apps/desktop/src/main/index.ts
```

Before release, build the guarded local package:

```text
pnpm package:desktop
```

The packaging verifier requires all of these files to be valid ICNS resources:

```text
Avalon.app/Contents/Resources/icon.icns
Avalon.app/Contents/Resources/icons/avalon-light.icns
Avalon.app/Contents/Resources/icons/avalon-dark.icns
```

Launch the packaged app with `pnpm start:desktop:packaged`, switch macOS between light and dark appearance, and confirm the running Dock icon changes without restarting Avalon. Also inspect Finder to confirm the static bundle fallback remains correct.

## Troubleshooting

- **Electron logs `application icon could not be loaded`:** confirm the selected file exists in `Contents/Resources/icons`, begins with the `icns` magic bytes, and contains a modern PNG representation.
- **The packaged app shows Electron's icon:** confirm `mac.icon` still points to `resources/icon.icns` and inspect `CFBundleIconFile` in the packaged `Info.plist`.
- **The Dock changes but Finder does not:** this is the expected process-only behavior described above.
- **The icon does not change with appearance:** confirm both family files differ, `nativeTheme` remains set to follow the system, and the app is running while the appearance changes.

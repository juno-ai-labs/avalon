repo: juno-ai-labs/avalon
branch: main
path: apps/

## Last sync

date: 2026-08-10T18:50:00Z

### Updated in this project

- Built the design system from the desktop renderer and marketing-site sources.
- Imported the Avalon mark, eight macOS app icons, and five landscape photographs.
- Tokenised colours, type, spacing, radii, elevation, and motion from `app.css` and site `styles.css`.
- Recreated two UI kits: the Electron workspace and the with-avalon.com landing page.

## Screen map

| Screen / file | Repo files |
| --- | --- |
| tokens/*.css | apps/desktop/src/renderer/styles/app.css, apps/site/src/styles.css |
| components/core, identity, feedback | apps/desktop/src/renderer/components/primitives.tsx, styles/app.css |
| components/forms | apps/desktop/src/renderer/styles/app.css (onboarding, settings, elicitation) |
| components/workstream | apps/desktop/src/renderer/components/workstream-blocks.tsx, workstream-composer.tsx, inspector-rail.tsx, sidebar.tsx |
| components/site | apps/site/src/styles.css, apps/site/index.html |
| ui_kits/avalon-desktop | apps/desktop/src/renderer/{App.tsx, components/app-shell.tsx, screens/*} |
| ui_kits/avalon-site | apps/site/index.html, apps/site/src/styles.css |
| assets/ | assets/brand, apps/desktop/src/renderer/assets, apps/site/public |

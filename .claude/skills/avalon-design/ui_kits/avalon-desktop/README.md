# Avalon desktop UI kit

A recreation of the Electron workspace renderer (`apps/desktop/src/renderer` in juno-ai-labs/avalon).

**Screens** — click the sidebar to move between them.

| Screen | Source |
| --- | --- |
| Work stream (default) | `screens/workstream.tsx`, `components/workstream-blocks.tsx`, `components/workstream-composer.tsx` |
| New work stream / home | `screens/new-workstream.tsx` |
| Automations | `screens/automation-overview.tsx` |
| Settings | `screens/workspace-settings.tsx` |
| Sidebar + context rail | `components/sidebar.tsx`, `components/inspector-rail.tsx`, `components/app-shell.tsx` |

**Interactions:** switch work streams, answer the elicitation panel (or skip it), send a message, toggle the context rail, watch a resource, filter settings navigation.

**Not recreated:** HyperSight blocks, dictation, meeting notes, attachment upload progress, drag-to-resize. The layout constants (300px sidebar, 860px transcript column, 55px header, 45px rail header) are taken from `styles/app.css`.

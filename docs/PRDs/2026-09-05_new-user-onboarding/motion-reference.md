# Installed Grok Bot onboarding motion

Inspected `/Applications/Grok Bot.app/Contents/Resources/app.asar`, version
**0.43.0**, on 2026-09-05. SHA-256:
`1cd3b1c9b1380ec6094f8a23d37d132b32ea32d287ecf5cca0096518d6365a1a`.
The archive was read directly; no application account or private conversations
were accessed. These are verified client behaviors, independent of server rollout.

## Sources

- `dist/renderer/assets/chunk-onboarding-flow-CtJaG-Cm.js`: scene orchestration,
  spring generation, cursor choreography, typing, jobs, floating cast and landing.
- `dist/renderer/assets/chunk-agent-character-picker-C01jzPDy.js`: paused shape
  thumbnails, color selection and selected outlines.
- `dist/renderer/assets/index-CPc3dpjb.js`: character state motion.
- `dist/renderer/assets/index-Biw2_3Gn.css`: step fades and duration tokens.

## Verified behavior and Rally adaptation

| Behavior | Bundle evidence | Rally implementation |
| --- | --- | --- |
| Spring motion | Mass 1. Standard stiffness 175/damping 26; slow 100/20; bounce 175/18.5. Settle threshold .001; 49 CSS `linear()` samples. | `onboarding-motion.ts` independently evaluates the same damped spring. Durations 532, 691 and 747 ms. |
| Meet | Hero starts small; bounce into place. Listening at 420 ms. Typing begins after 700 ms, one character each 35 ms. | Meet Rally scene uses this cadence and original Rally text. |
| Computer demo | Eight cursor/press beats, 900 ms each; positions (-78.3,-62.3), (62.8,-62.3), (-178.4,-105.5), (77.4,71.8), each held for two beats. | Same pointer positions and slow spring; demonstration content shows discussion, context and a plan. |
| Jobs | Hero exits after 800 ms, scales 1.2 and fades over 300 ms. Three characters bounce to (0,-112), (-132,27), (138,7). Labels appear after 1600 ms. | Same timing and offsets with Rally workstream examples. |
| Tools | Three characters bob independently: 3 px/5200 ms/-1200 ms; 5 px/7300 ms/-4700 ms; 4 px/6400 ms/-2600 ms. | Same independent loops above the connector grid. |
| Picker arrival | Blue character springs to an avatar target measured with `getBoundingClientRect`; other characters fade out. | Profile avatar lands at its measured target using the standard spring. The added workspace and invite steps mean Rally starts this arrival on the profile screen rather than maintaining Grok's cast across those extra steps. |
| Character body | Idle breathing; listening lean; working pulse at 1.6 Hz; excited hops at 2.2 Hz; happy body bounce. | Original SVG character shapes use those body-motion formulas, scoped to onboarding. Grok's face renderer, expression atlas, particles and art are not bundled. |
| Picker | Shape thumbnails are paused. Color and shape buttons display selection outlines. | Static thumbnails and explicit selected states. |
| Page fades | Slow token 200 ms ease-out entry; fast token 100 ms ease-in exit, 200 ms exit dwell. | Rally intro uses the same entry, exit and dwell. Server-backed steps advance on successful saves. |
| Final handoff | Grok holds its handoff scene 1500 ms before opening its bot conversation. | After the real creation receipt arrives, Rally holds its character handoff for 1500 ms and opens that workstream. Reduced motion opens immediately. |
| Reduced motion | Scene cast immediately lands; transitions disabled. | CSS and Web Animations respect the live system preference and stop when it changes. |

Rally preserves the interaction timing and character choreography where its
flow matches the reference. Its identity artwork, copy, extra workspace steps,
and real-agent handoff are application-specific adaptations, not a claim of
pixel-identical Grok reproduction.

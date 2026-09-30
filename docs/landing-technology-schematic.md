# Landing technology schematic

The Technology section of the public landing page (`rallywith.ai/#technology`)
shows Rally's stack as a cut-away sphere drawn in points. A starfield gathers
into five nested spheres, one at a time, each labeled with an amber leader
line: the LLM routing core, Authorization, Sidekicks, Connectors, and
Multiplayer collaboration. The octant facing the viewer is cut away so every
layer shows. After a long hold the cut fills in, the sphere becomes a tennis
ball with a neon seam, spins, and breaks back into the starfield, and the loop
starts again.

Read this before changing the animation, its timing, its labels, or how it
loads.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/index.html` | The `#technology` section: heading, the `[data-tech-schematic]` figure, and the five-item layer list that carries the same content as text |
| `apps/site/src/technology.ts` | Page entry: starts the scene when the figure nears the screen, runs the clock only while it is visible, honors reduced motion |
| `apps/site/src/technology-scene.ts` | The scene: `LAYERS`, the timeline (`stateAt`, `MOMENTS`, `LOOP`), particle geometry, the shader with its lighting, and the SVG label overlay |
| `apps/site/src/shell-physics.ts` | The physics engine for the layer points |
| `apps/site/src/landing.css` | `.tech-*` rules: figure size, label type, the amber of the lines, dots and numerals, the layer list |

`LAYERS` is the scene's single source of the layer names, their order (inside
out), and their colors. The text list in `index.html` repeats the names and the
order for screen readers and search, so a change to either lands in both files
in the same commit. The colors are the product's icon palette
(`--av-sys-color-project-*` in `packages/ui/src/styles/themes.css`): amber,
fuchsia, emerald, orange, blue. The seam is `--av-sys-color-brand-base`. The
site does not load that stylesheet, so the hex values are copied, with the
token name beside each; the leader-line amber is copied again in `landing.css`.

## How it works

Each particle carries three positions, a star, a place in the schematic, and a
place on the ball, and the vertex shader blends between them from a few
uniforms that `stateAt(time)` computes. The comments in `technology-scene.ts`
and `shell-physics.ts` describe each part; what follows is what the code does
not say on its own.

- **Timeline:** one loop is `LOOP` seconds: a starfield rest, then each layer
  forms and holds, the last for 20 s; the cut fills, the ball forms and spins,
  and it scatters back to stars.
- **Physics:** every layer point is a body that slides over its sphere, or
  within its cut-wall ring, at a constant slow speed and bounces elastically
  off the cut planes and ring arcs. It steps on the CPU each frame, in steps of
  at most 1/30 s and at most one second per frame, so a seek or a background
  tab never tunnels a body through a wall.
- **Light:** three.js shadow maps need surfaces, and points have none, so the
  shader lights each point itself: wrapped diffuse light from one overhead
  light, and a cast shadow from every formed shell the ray to the light
  crosses outside the cut. The light leans right of the cut so its rim throws
  a shadow band into the corner.
- **Loading:** `technology.ts` imports the scene statically (the repo's
  `rally/no-dynamic-import` rule forbids a lazy import), so three.js ships in
  the landing page's module graph. The WebGL context is created only near the
  viewport, the clock advances only while the figure is on screen, and under
  `prefers-reduced-motion` the scene renders the final five-layer state once.

## Invariants

- **`LAYERS` order is inside out and matches the text list in `index.html`.**
  The geometry assigns radii by index and the labels stack by index; reordering
  one without the other mislabels a layer. No automated guard; verified
  visually.
- **The cut octant, the anchors, and the camera agree.** The cut is the octant
  facing the camera and the anchors sit on its back wall. Moving the camera to a
  side that does not face the cut hides every anchor behind the shell. Verified
  visually, no automated guard.
- **Every phase starts from where the last one ended.** The spin starts at the
  identity at `BALL_START`, and the scatter ends on the star positions the rest
  phase starts from, so the loop has no visible jump. Covered by
  `apps/site/test/technology-scene.test.ts`, which checks the state at the loop
  boundary.
- **The figure stays decorative.** It is `aria-hidden`; the layer list below it
  carries the content for screen readers and search. A change that puts content
  only in the canvas loses it for both.

## Boundary

The scene owns its canvas and overlay and nothing else on the page. It depends
on `three` (`WebGLRenderer`, `Points`, `ShaderMaterial`). It reports nothing to
telemetry; [`landing-page-tracking.md`](landing-page-tracking.md) owns what the
landing page reports, and this section adds no tracked links. The page's CSP
(`script-src 'self'`, `style-src 'self'`) holds: three.js is bundled, and
styles are set through the CSSOM or SVG attributes, never inline markup.

## Failure modes and limits

- **No WebGL**: `WebGLRenderer` throws, the error reaches the console, and the
  figure stays an empty dark panel. The layer list below it still carries the
  content.
- **Point count**: about 23,000 points, about 18,000 of them physics bodies.
  The physics step is linear in body count with no pairwise work; the vertex
  shader does the rest.
- **Pixel ratio** is capped at 2 so a high-density screen does not quadruple
  the fill cost.

## Testing

`apps/site/test/shell-physics.test.ts` (the engine) and
`apps/site/test/technology-scene.test.ts` (the timeline) run in the site's Node
suite, `pnpm --filter @rally/site test`, and never create a WebGL context.

The rendering itself has no automated guard. Check it in a real browser:
Chromium under Playwright with `--use-angle=swiftshader` renders it. Drive time
by importing `/src/technology-scene.ts` from the dev server and calling
`render(MOMENTS.…)` on a fresh canvas; Playwright's fake clock does not hold
the IntersectionObserver that starts the scene, so timing from page load
drifts.

## Changelog

### 2026-09-30 — The technology schematic is added to the landing page

**What changed:** A Technology section after Pricing shows the stack as a
point-cloud cut-away that forms layer by layer, becomes a tennis ball, and
dissolves back into stars on a loop. Each layer's points move under a small
physics engine, bouncing off the cut planes and ring edges, and a directional
light shades them and casts shadows from each shell, in the icon palette's
colors, with a brand-neon seam on the ball.

**Why:** The landing page said what Rally does but nothing about how it is
built. A cut-away shows the layers and how they nest in one picture, and the
tennis ball ties it back to the Rally mark.

**Considered and rejected:** three.js lights and shadow maps. Those shade
meshes; a point has no surface for a shadow map to land on, so the light is
computed per point in the shader against the analytic spheres instead. A
physics library such as Rapier or cannon-es: the motion needs constant-speed
travel on a surface and elastic bounces off planes and spheres, about a hundred
lines, and a general engine adds a large download and a collision broadphase
this scene has no use for. Precomputed 2D projections or a video: both fix the
view and the aspect ratio, cannot place live labels on the cut, and a video
costs more bytes than three.js plus the geometry code. Filling the cut by
adding points to the outer octant alone was tried and dropped: the outer shell
is too sparse on its own to read as a whole sphere, so every structure point
moves onto the outer sphere instead.

**Consequences:** three.js is now part of the landing page's JavaScript. A
future change that adds more WebGL to the site should share it rather than
bundle a second copy.

Shipped in #1028.

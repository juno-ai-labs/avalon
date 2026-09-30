# Landing technology schematic

The Technology section of the public landing page (`rallywith.ai/#technology`)
shows Rally's stack as a cut-away sphere drawn in points. A starfield gathers
into four nested spheres, one at a time, each labeled with a gold leader line:
the LLM routing core, Sidekicks, Authorization, and Channels & Breakouts. The
octant facing the viewer is cut away so every layer shows. After a long hold the
cut fills in, the sphere becomes a tennis ball with a gold seam, spins, and
breaks back into the starfield, and the loop starts again.

Read this before changing the animation, its timing, its labels, or how it
loads.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/index.html` | The `#technology` section: heading, the `[data-tech-schematic]` figure, and the four-item layer list that carries the same content as text |
| `apps/site/src/technology.ts` | Page entry: starts the scene when the figure nears the screen, runs the clock only while it is visible, honors reduced motion |
| `apps/site/src/shell-physics.ts` | The physics engine: bodies held on a sphere or a cut wall, moving at constant speed and bouncing elastically off the cut planes and the ring arcs |
| `apps/site/src/technology-scene.ts` | The scene: `LAYERS` (names and colors), the timeline (`stateAt`, `MOMENTS`, `LOOP`), particle geometry, shaders, and the SVG label overlay |
| `apps/site/src/landing.css` | `.tech-*` rules: figure size, label type, the gold line color, the layer list |

`LAYERS` is the single source of the layer names, their order (inside out), and
their colors. The label overlay and the geometry both read it.

## How it works

### Particles

Every particle carries three positions, fixed at build time:

- **star**: a point in a jittered 3D grid, so the sky is even without looking
  regular. The generator is seeded, so every visitor sees the same sky.
- **shape**: where it starts in the schematic. A layer's points split between its
  sphere shell (with the cut octant `x < 0, y > 0, z > 0` left empty) and the
  three quarter-disc walls the cut exposes. Radii step by an equal amount
  (`STEP`) per layer.
- **ball**: where it sits on the outer sphere once the cut fills. A share of the
  three inner layers' points land on the seam curve instead.

A `group` attribute says which layer a particle belongs to, or that it fills
the cut octant, or that it is only ever a star.

Each sphere's shell is the densest part of its layer, so it reads as a whole
sphere from outside. When the next sphere forms around it, its shell fades to a
trace, so an inner layer shows only through the cut, the way an Earth cut-away
shows its core.

### Physics

The shape position is not fixed: every layer point is a body in
`shell-physics.ts`, so the schematic is always in motion. A shell body slides
over its sphere at a constant slow speed, and the three planes that bound the
cut octant are walls: a body that would cross one bounces off it. A wall body
slides within its quarter-ring and bounces off the ring's straight edges and
off its inner and outer arcs. Bounces are elastic and bodies do not collide
with each other. The engine is flat typed arrays and a tight loop, stepped on
the CPU in steps of at most 1/30 s; each frame the layer range of the shape
buffer is re-uploaded. A jump in time advances the bodies by at most one
second, so a seek or a background tab never tunnels a body through a wall.

### Rendering

The vertex shader blends star → shape → ball → star from a few uniforms. The
CPU work per frame is the physics step, one buffer upload, a few uniform
writes, one render call, and projecting four label anchors. Nothing is precomputed in screen space; the camera and three.js
do the projection.

### Timeline

`stateAt(time)` turns seconds into the uniforms. One loop is `LOOP` seconds:

| Phase | Length |
| --- | --- |
| Starfield rest | `REST` (3 s) |
| Each layer forms, then holds (core first) | `FORM` (3 s) + `HOLD` (4 s) |
| The last layer's hold | `FINAL_HOLD` (20 s) |
| Cut fills: every structure point settles onto the outer sphere, labels fade | `FILL` (2.5 s) |
| Ball: recolor, gold seam lifts, spin starts | `BALL` (3 s) + `SPIN_HOLD` (7 s) |
| Scatter back to the starfield | `SCATTER` (3.5 s) |

Each particle's progress through a phase is staggered by its seed, so layers
gather as a stream rather than a single jump. `MOMENTS` names the midpoint of
each state for anyone who needs to render one.

### Labels

An SVG overlay above the canvas draws each label as text, a straight gold rule
under it, and an angled line to an anchor on the back wall of the cut
(`layerAnchor`). Anchors are projected through the live camera every frame.
Label slots stack top to bottom from the outer layer in; elbows step right as
the slots step down, so the lines fan out without crossing. Wide layouts shift
the sphere right with a view offset to leave the left side for labels; narrow
ones zoom out and shift it down so labels sit above it.

### Loading and motion

`technology.ts` imports the scene statically (the repo's `rally/no-dynamic-import`
rule forbids a lazy import), so three.js ships in the landing page's module
graph and downloads as a deferred module script. The WebGL context is created
only when the figure comes within 400 px of the viewport. The clock advances
only while the figure is on screen and caps each frame's step at 0.1 s, so a
reader always arrives at the starfield and a background tab does not skip ahead.
Under `prefers-reduced-motion: reduce` the scene renders the final four-layer
state once and stops.

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
- **Point count**: about 23,000 points, about 16,000 of them physics bodies.
  The physics step is linear in body count with no pairwise work; the vertex
  shader does the rest.
- **Pixel ratio** is capped at 2 so a high-density screen does not quadruple
  the fill cost.

## Testing

`apps/site/test/shell-physics.test.ts` runs the engine: a body aimed at a cut
plane bounces off it, shell bodies stay on their sphere, out of the cut and at
their speed over 100 simulated seconds, and wall bodies stay in their
quarter-ring and reach its outer arc.

`apps/site/test/technology-scene.test.ts` runs `stateAt` and checks the
timeline: nothing formed at the start, layers forming in order, labels showing
during the final hold and gone once the ball forms, and the loop wrapping back
to the starfield. It runs in the site's Node suite
(`pnpm --filter @rally/site test`) and never creates a WebGL context.

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
physics engine, bouncing off the cut planes and ring edges.

**Why:** The landing page said what Rally does but nothing about how it is
built. A cut-away shows the layers and how they nest in one picture, and the
tennis ball ties it back to the Rally mark.

**Considered and rejected:** A physics library such as Rapier or cannon-es.
The motion needs constant-speed travel on a surface and elastic bounces off
planes and spheres, about a hundred lines; a general engine adds a large
download and a collision broadphase this scene has no use for. Precomputed 2D projections or a video. Both fix the
view and the aspect ratio, cannot place live labels on the cut, and a video
costs more bytes than three.js plus the geometry code. Filling the cut by
adding points to the outer octant alone was tried and dropped: the outer shell
is too sparse on its own to read as a whole sphere, so every structure point
moves onto the outer sphere instead.

**Consequences:** three.js is now part of the landing page's JavaScript. A
future change that adds more WebGL to the site should share it rather than
bundle a second copy.

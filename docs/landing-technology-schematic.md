# Landing technology schematic

The Technology section of the public landing page (`rallywith.ai/#technology`)
shows Rally's stack as a cut-away sphere drawn in points. A starfield gathers
into five nested spheres, one at a time, each labeled with an amber leader
line: the LLM routing core, Authorization, Connectors, Sidekicks, and
Multiplayer collaboration. The octant facing the viewer is cut away so every
layer shows. After a long hold the cut fills in, the sphere becomes a tennis
ball with a neon seam, spins, and breaks back into the starfield, and the loop
starts again.

Read this before changing the animation, its timing, its labels, or how it
loads.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/landing-sections.html` | The `#technology` section, which `site-chrome.ts` inlines into `index.html` at the `rally:landing-sections` marker: heading, the `[data-tech-schematic]` figure, and the five-item layer list that carries the same content as text |
| `apps/site/src/technology-loader.ts` | The only part in the landing page's own bundle: adds the schematic's script when the figure nears the screen |
| `apps/site/src/technology.ts` | The schematic's own build entry: starts the scene, runs the clock only while the figure is visible, honors reduced motion |
| `apps/site/vite.config.ts` | The `technology` input, and `rally-technology-entry`, which rewrites the figure's `data-tech-src` to the hashed bundle |
| `apps/site/src/technology-scene.ts` | The scene: `LAYERS`, the timeline (`stateAt`, `MOMENTS`, `LOOP`), particle geometry, the shader with its lighting, and the SVG label overlay |
| `apps/site/src/landing.css` | `.tech-*` rules: figure size, label type, the amber of the lines, dots and numerals, the layer list |

`LAYERS` is the scene's single source of the layer names, their order (inside
out), and their colors. The text list in `landing-sections.html` repeats the names and the
order for screen readers and search, so a change to either lands in both files
in the same commit. The colors are the product's icon palette
(`--av-sys-color-project-*` in `packages/ui/src/styles/themes.css`): amber,
fuchsia, orange, emerald, blue. The seam is `--av-sys-color-brand-base`. The
site does not load that stylesheet, so the hex values are copied, with the
token name beside each; the leader-line amber is copied again in `landing.css`.

## How it works

Each particle carries three positions, a star, a place in the schematic, and a
place on the ball, and the vertex shader blends between them from a few
uniforms that `stateAt(time)` computes. The comments in `technology-scene.ts`
describe each part; what follows is what the code does
not say on its own.

- **Timeline:** one loop is `LOOP` seconds: a starfield rest, then each layer
  forms and holds, the last for 20 s; the inner layers fade and the outer
  shell closes over the cut, the ball recolors and spins, and it scatters
  back to stars.
- **Starfield:** every star sits behind the spheres as the camera sees them,
  in a slab from just past the outer sphere to well beyond it, and drifts by
  turning about the camera's line of sight, which keeps its depth. Because it
  turns, each depth is a disc sized to the view's farthest corner, not a
  rectangle sized to the view. Stars whose line of sight crosses a formed
  sphere dim, so the spheres read as in front; the dimming lifts as the ball
  scatters.
- **Drift:** every layer point moves, computed in the vertex shader from
  time alone, with no per-frame CPU work or buffer upload. A shell point
  slides along its own great circle; shells are sampled over the whole sphere
  and a point inside the open cut is not drawn, so the hole stays exact and
  the density even. A cut-wall point's angle and radius each follow a triangle
  wave between the edges of its quarter-ring, which is an elastic bounce off
  its straight edges and its arcs.
- **Light:** three.js shadow maps need surfaces, and points have none, so the
  shader lights each point itself: wrapped diffuse light from one overhead
  light, and a cast shadow from every formed shell the ray to the light
  crosses outside the cut. The light leans right of the cut so its rim throws
  a shadow band into the corner.
- **Descriptions:** during a layer's turn, from its label appearing until the
  next layer starts forming, its description from the text list shows under
  its label and the labels below slide down to make room. `technology.ts`
  reads the descriptions from the list, so the copy is written once. On a
  phone the label stack has no room, so the description runs along the bottom
  of the figure instead.
- **Loading:** the schematic and three.js are a separate build entry, not a
  lazy `import()` (which `rally/no-dynamic-import` forbids). The landing
  page's own bundle carries only `technology-loader.ts`, which adds the
  entry's `<script type="module">` when the figure comes within 400 px of the
  viewport, so a reader who never scrolls there downloads none of it. The
  figure names the entry in `data-tech-src`: the source file in development,
  rewritten at build time to the hashed bundle, and the build fails if that
  bundle is missing. The clock advances only while the figure is on screen,
  and under `prefers-reduced-motion` the scene renders the final five-layer
  state once.

## Invariants

- **`LAYERS` order is inside out and matches the text list in `landing-sections.html`.**
  The geometry assigns radii by index, the labels stack by index, and each
  label's description is read from the list item at the same index; reordering
  one without the other mislabels a layer or describes it with another's text. No automated guard; verified
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
(`script-src 'self'`, `style-src 'self'`) holds: three.js is bundled and served
from the site's own origin, and
styles are set through the CSSOM or SVG attributes, never inline markup.

## Failure modes and limits

- **No WebGL**: `WebGLRenderer` throws, the error reaches the console, and the
  figure stays an empty dark panel. The layer list below it still carries the
  content.
- **Point count**: about 23,000 points, all moved and lit in the vertex
  shader. The CPU work per frame is a few uniform writes, one render call and
  five label projections.
- **Pixel ratio** is capped at 2 so a high-density screen does not quadruple
  the fill cost.

## Testing

`apps/site/test/technology-scene.test.ts` checks the timeline in the site's
Node suite, `pnpm --filter @rally/site test`, and never creates a WebGL
context. The drift and the light live in the shader and have no automated
guard.

The rendering itself has no automated guard. Check it in a real browser:
Chromium under Playwright with `--use-angle=swiftshader` renders it. Drive time
by importing `/src/technology-scene.ts` from the dev server and calling
`createSchematic(canvas, overlay).render(MOMENTS.…)` on a fresh canvas; Playwright's fake clock does not hold
the IntersectionObserver that starts the scene, so timing from page load
drifts.

## Changelog

### 2026-09-30 — The starfield covers the view at every turn, and the cut closes as one shell

**What changed:** Each depth of the starfield is now a disc, filled through a
concentric square-to-disc map so the jittered grid stays even, instead of a
wide rectangle. The dimming behind the spheres fades out with the scatter.
During the fill only the outer shell shows: every other layer fades out
before it moves, the shell's points in the cut fade in at full weight, and
the rest return in the ball's colors.

**Why:** The field turns about the line of sight and the clock never wraps
that turn, so within a minute a rectangle's short side swung into the view
and left a bare corner. The dimming read the layers' form, which stays at 1
through the scatter, so a dark disc sat where the ball had been until the
loop wrapped, and then snapped bright. The fill used to move every layer's
points onto the outer sphere at once, still in their own colors, so the cut
read as a swarm rather than the blue shell closing.

**Considered and rejected:** A larger rectangle: any rectangle bares a corner
at some turn. Stopping the turn: the slow drift is what keeps the field alive
during the long holds.

**Consequences:** A future change to the camera zoom or view offsets must keep
the disc's radius past the view's farthest corner. The field is about 18%
sparser for the same star count. The fill should stay one shell and the
recolor its own step; the ball grows denser as the other layers return.

PR: https://github.com/juno-ai-labs/avalon/pull/1036

### 2026-09-30 — The technology schematic is added to the landing page

**What changed:** A Technology section after Pricing shows the stack as a
point-cloud cut-away that forms layer by layer, becomes a tennis ball, and
dissolves back into stars on a loop. Each layer's points drift in the shader,
the cut-wall points bouncing off their ring's edges, and a directional
light shades them and casts shadows from each shell, in the icon palette's
colors, with a brand-neon seam on the ball. Each layer's description shows
under its label during its turn.

**Why:** The landing page said what Rally does but nothing about how it is
built. A cut-away shows the layers and how they nest in one picture, and the
tennis ball ties it back to the Rally mark.

**Considered and rejected:** three.js lights and shadow maps. Those shade
meshes; a point has no surface for a shadow map to land on, so the light is
computed per point in the shader against the analytic spheres instead. A
CPU physics engine for the drift, which this change carried until review: it
stepped about 18,000 bodies on the main thread and re-uploaded about 214 KB of
positions every frame, on phones too, for points moving at a tenth of a unit a
second, where a bounce is barely visible. The shader gives the same picture
for none of that cost; shell points pass under the cut's edge rather than
bouncing off it. A physics library such as Rapier or cannon-es was rejected
earlier for the same reason, with a large download on top. Precomputed 2D projections or a video: both fix the
view and the aspect ratio, cannot place live labels on the cut, and a video
costs more bytes than three.js plus the geometry code. Filling the cut by
adding points to the outer octant alone was tried and dropped: the outer shell
is too sparse on its own to read as a whole sphere, so every structure point
moves onto the outer sphere instead.

**Consequences:** three.js lives in the schematic's own entry, and the landing
page loads it only near the figure; review caught an earlier revision that
put all 137 kB (gzipped) of it in the landing bundle. Anything else added to
`technology.ts`'s imports lands in that entry, not the page. A future change
that adds more WebGL to the site should share this entry's three.js rather
than bundle a second copy.

Shipped in #1028.

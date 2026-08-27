# The brand mark in motion

The Rally mark appears in the desktop client two ways. Almost everywhere it is a
still image behind a CSS mask, sized like an icon and standing in for the
product's name. On the three surfaces where it is large enough to be the
subject — the sign-in card, the home screen's welcome heading, and the intro on
the new-automation screen — it turns, and there it is not an image at all: it is
a curve solved on a unit sphere and re-projected every frame.

Both draw in the same colour, and it is the one colour in the renderer that no
theme reads for itself. `sys.color.brand.mark` takes exactly two values across
every theme — the pair the brand is built on, `#ccff00` on a dark ground and
`#111210` on a light one.

This document owns the turning mark and the logo's colour. Read it before
changing where the mark turns, how fast, how large, what colour it is, or which
drawing it uses.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/rally-seam.ts` | The seam curve and its projection. `seamPath(spin, tilt, scale, segments)` is the only place the geometry is decided, and the rate constants live beside it. |
| `apps/desktop/src/renderer/components/primitives.tsx` | `RallySeam`, the frame loop and the reduced-motion decision — and `RallyMark` above it, the still masked image every other surface uses. |
| `apps/desktop/src/renderer/styles/app.css` | `.rally-seam` holds the drawing's own contract and no size. `.signin-mark`, `.new-workstream-welcome-mark`, and `.automation-builder-mark` each choose a size and the stroke weight that goes with it. |
| `apps/desktop/src/renderer/assets/rally-mark.png` | The still master, behind `.rally-mark`'s mask. Not what the turning mark draws — see below. |

## How it works

### A curve on a sphere, not a picture being rotated

The seam is a closed curve that lies exactly on the unit sphere. `seamPath`
walks it in 168 steps, rotates each point about the vertical by `spin` and then
about the horizontal by `tilt`, drops the depth coordinate, and writes the result
as an SVG polyline into a 100×100 viewBox. `RallySeam` calls it once per
animation frame with a growing `spin` and `tilt` and sets the `d` attribute.

The whole design exists to avoid one alternative. `transform: rotate()` on the
still mark spins a finished drawing in its own plane, like a sticker on a turning
plate: the crossings never pass over one another, and it reads as a flat sign
being twisted rather than as an object being turned in the hand. No CSS
transform of a 2D image can produce the other motion, because the depth
information it needs is not in the image. Solving the curve is the cheapest way
to have it — about two kilobytes of arithmetic and no dependency.

Because the curve is on the unit sphere, every projected point is within `scale`
of the centre at any rotation. That is why a `scale` of 46 and a stroke of 6
fit the viewBox exactly at every angle: the drawing neither clips at one moment
of the turn nor appears to breathe over it.

### Two axes, and what they cost

The turn about the vertical takes about 4.8 seconds. The tilt about the
horizontal takes about 8, and the two rates are deliberately incommensurate, so
the pair never comes back to the same relative position and there is no loop
point for the eye to catch.

The second axis is what makes the motion gyroscopic rather than a spin, and it
is paid for twice.

**It costs a symmetry.** With no tilt the projection is mirror-exact about the
vertical, and a frame that is symmetrical reads as a turn at any size. Tilted
frames are asymmetric, and below roughly 40px across that reads as a wobble.
All three current hosts are far above that; a small one would have to drop to
one axis.

**It costs legibility for part of the cycle.** Near a quarter turn of tilt the
curve is seen almost end-on, and it projects to a flat four-cornered figure that
does not read as the Rally mark at all — it is a true view of the object, just an
unfamiliar one. Roughly a third of the cycle is spent in or near that band. This
is the most likely thing about the motion someone will want to change; the way to
change it is to oscillate the tilt within a bound rather than rotate it, which
keeps two axes and never reaches end-on.

### Reduced motion is decided in the component

`app.css` ends with a global `prefers-reduced-motion` cut that flattens every CSS
animation and transition to a single 0.001ms iteration. A
`requestAnimationFrame` loop is neither an animation nor a transition, so it
would have kept turning under a preference that had visibly stopped everything
else on the screen. `RallySeam` reads the media query itself, holds the resting
frame instead of turning, and re-reads it when the preference changes.

The resting frame is a specific angle — 25° of spin and no tilt, the angle the
still master is drawn at — rather than wherever the loop had got to. Stopping at
an arbitrary frame leaves a drawing that looks like it came out wrong.

### The turning mark and the still mark are not the same drawing

`rally-mark.png` is a refined master, and the solver does not reproduce it. The
gap was measured rather than guessed: sampling the master's own outline from
`apps/site/public/brand/rally-mark.svg` and searching the solver's parameters —
lobe depth, spin, tilt, in-plane rotation, mirror — for the closest match, the
best available fit sits about **2.5% of the mark's width** from the master,
averaged around the outline. At the sizes drawn here that is roughly half a
stroke width: recognisably the same mark, visibly not the same shape when the
two are laid on top of each other.

The search says something useful about *why*. The best-fitting lobe depth comes
out at 0.184 against the 0.190 the solver ships, so the master is not a different
curve family — it is this curve, drawn and then refined by hand. Holding the lobe
depth at the shipped value and searching only the angles gives 3.3%, so most of
the residual is refinement rather than orientation.

**Leaving the two drawings apart is a decision, not an oversight.** Nothing puts
both on screen at the same instant — each turning mark is the only mark on its
surface — so the difference is invisible in use and shows up only by moving
between screens. What it costs is downstream: the application icon, the favicon,
the public site and every email all draw the master, so a new brand asset traced
from the turning mark would not line up with them, and nothing in the test suite
can notice the two definitions drifting.

Closing it means adding harmonic terms to the seam and fitting them to the
master — cheap to attempt, since the fitting harness above is most of the work,
but constrained: the fitted curve must still lie on the unit sphere, or the
rotation stops being a rotation and every guarantee in this document that depends
on that property goes with it. Whether a sphere-constrained fit can reach the
master is unknown. The other direction — regenerating the master from the
solver — settles it immediately but requires new brand assets, which is not an
engineering decision. Until one of those happens, the solver stays confined to
the three surfaces here, because each new call site spreads the difference
instead of settling it.

## Invariants

- **A host of `.rally-seam` names its height, width, and stroke weight
  together.** The curve fills its box, so a size chosen without its stroke comes
  out spindly at large sizes and clotted shut at the crossings at small ones, and
  a box that is not square stretches the drawing along one axis — which, as it
  turns, reads as the mark being squashed rather than as the box being wrong.
  `.rally-seam` deliberately declares none of the three so there is no default to
  inherit by accident. `app.css.node.test.ts` asserts it for all three hosts.
- **`scale` and the stroke weight are chosen against the viewBox together.** At
  `scale` 46 the drawing reaches within 4 units of the edge, which leaves room
  for a stroke of 8. Raising one without the other reintroduces clipping at some
  angles of the turn only, which is invisible in a screenshot taken at the wrong
  moment.
- **Two axes are for display sizes only.** A tilted frame is asymmetric about
  the vertical, and below roughly 40px that reads as a wobble. A smaller host has
  to pass no tilt.
- **The turn is pure rotation.** Nothing scales, bounces, springs, or
  overshoots. A mark that changes size while turning stops reading as an object
  and starts reading as an effect.
- **Reduced motion holds the resting frame, and the component is what enforces
  it.** The stylesheet's global cut does not reach a frame loop. Any future
  motion built on `requestAnimationFrame` has the same obligation.
- **The logo has two colours across the whole application, not one per theme.**
  Both drawings of the mark — the turning one here and the still `.rally-mark`
  everywhere else — paint from `brand.mark`, and every theme sets it to `#ccff00`
  or to `#111210` depending on whether its background is dark or light. That is
  the brand's own pair, not a reading of it: a theme picks the side its ground
  puts it on and nothing else. `brand.ink` is each theme's reading of the brand
  as a *legible label or accent* — olive on Terra Light, orange on both Air
  themes — and it is still what an eyebrow, a mention chip, a selected indicator,
  and the streaming caret use. Pointing either drawing of the mark back at `ink`
  gives the logo four hues instead of two, which is the thing this token exists
  to prevent.

## Boundary

This module owns the geometry of the turning mark, its rates, and the decision to
turn or hold. It names one colour and only through a token: `.rally-seam` paints
from `--av-sys-color-brand-mark`, which the still `.rally-mark` shares, so both
drawings of the logo agree in every theme.
The token vocabulary, the rule that no colour is written into `app.css`, and the
rule that a theme restates every colour rather than inheriting one, all belong to
[`theming.md`](theming.md).

It does not own the still mark's geometry. `RallyMark` and `.rally-mark` are
otherwise unchanged, and every surface other than the three named here uses them.
It does not own any host screen's layout — the welcome heading belongs to
[`workstream-creation.md`](workstream-creation.md), and neither the sign-in card
nor the new-automation intro has a document of its own.

Nothing outside the renderer depends on any of this. The favicon, the native
application icon in [`desktop-icons.md`](desktop-icons.md), the public site's
`brand/rally-mark.svg`, and every email all draw the still master and are
unaffected by a change here.

## Failure modes and limits

- **`matchMedia` is absent.** jsdom defines none, and neither does an Electron
  window in some startup states. The preference is read optionally and its
  absence means *no preference*, so the mark turns. Treating unreadable as
  "reduced" would silently stop the motion on a window that had simply not
  finished starting.
- **The window is hidden or occluded.** Chromium stops delivering frames, so the
  turn pauses and resumes where the clock has moved on to — the angle jumps once
  on the frame the window comes back. Nothing corrects for it and nothing needs
  to: a mark that is always turning has no reference angle to jump *from*, and
  the alternative is holding the last angle across the gap, which costs a frame's
  worth of state to fix something no one can see.
- **Cost.** One loop per mounted seam: 169 points and one `setAttribute` per
  frame, and every host mounts exactly one. The loop is cancelled on unmount, so
  a seam never outlives its screen — the home screen's stops when a work stream
  is launched, and the automation intro's when the first turn replaces it.
- **Sizes in use.** The sign-in card draws at 180px, the automation intro at
  150px, and the welcome heading at 56px, all with a stroke of 6 viewBox units.
  The lower bound for two axes is about 40px; there is no upper bound.

## Testing

- `apps/desktop/src/renderer/lib/rally-seam.test.ts` —
  `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/rally-seam.test.ts`.
  Covers the geometry: that no angle of the turn escapes the radius the scale
  names and that the drawing actually fills it, that a zero tilt is mirror-exact
  about the vertical and a non-zero one is not, and that the polyline is closed.
- `apps/desktop/src/renderer/components/primitives.tsx` is covered by
  `primitives.test.tsx`, which stubs `requestAnimationFrame` and plays the frames
  itself rather than waiting for a real clock. Its three cases are the two-axis
  turn, the resting frame under a reduced-motion preference, and an unreadable
  preference still turning. Both stubs go through `vi.stubGlobal`; the desktop
  config sets `unstubGlobals`, so a stub cannot leak into the next test.
- `apps/desktop/src/renderer/styles/app.css.node.test.ts` guards the size and
  stroke rule for each host, which no component test can see.
- **None of these looks at the screen.** A change to the rates, the sizes, or the
  drawing has to be watched in a real window — see
  [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it). Watch
  a whole cycle rather than a screenshot: the failure mode is a band of the turn,
  not a frame.

## Changelog

### 2026-08-27 — The mark turns wherever it is the subject rather than a label

**What changed:** The sign-in card, the home screen's welcome heading, and the
new-automation intro draw the mark from a curve solved and re-projected every
frame, turning about two axes, instead of from the still masked image. All three
grew: the sign-in mark from 34px to 180px, the automation intro's from 29px to
150px, and the welcome mark from 22px to 56px beside a heading that went from
25px to 38px. A new `sys.color.brand.mark` token replaces the per-theme
`brand.ink` on all of them, and on the still `.rally-mark` as well: `#ccff00` on
the two dark themes and `#111210` on the two light ones, so the logo is the
brand's own pair everywhere instead of four different hues. Everywhere else the
still image is otherwise untouched.

**Why:** The mark was asked to move and to be larger on the surfaces that are
otherwise waiting for the reader — for a sign-in, for a first instruction, for
the description of an automation. A still 22px mark next to a heading is a label;
at these sizes it is the thing on the screen, and a static drawing at 180px looks
like an image that failed to load.

**Considered and rejected:** `transform: rotate()` on the existing masked image.
It costs nothing and is the wrong motion — a 2D rotation turns the finished
drawing in its own plane, so the seam's crossings never pass over one another and
it reads as a flat sign being twisted. The depth needed for the other motion is
not in the image, so no CSS transform can recover it. Also rejected: moving every
surface onto the solver. The solver's curve is visibly not the shipped master,
and spreading that difference across the app is worse than confining it to the
three surfaces where the mark is the subject.

**Consequences:** Two drawings of the same mark now exist in one application,
about 2.5% of the mark's width apart. Keeping them apart was decided rather than
deferred — the section above records the measurement, what it costs, and the two
ways out — and the constraint it leaves is that no further surface moves onto the
solver until one of them is taken.

Two more things a future change has to respect. The reduced-motion obligation
moved: the stylesheet's global cut does not reach a frame loop, so any future
renderer motion built on `requestAnimationFrame` has to read the preference
itself. And roughly a third of the tilt cycle projects the curve almost end-on,
where it reads as a flat four-cornered figure rather than as the mark. That was
put in front of the team beside a bounded-tilt alternative and the full rotation
was kept deliberately: it is the honest motion of the object, and the flat frames
are a true view of it. Bounding the tilt is the change to make if that judgement
is ever revisited — it is a few lines, and it keeps both axes.

The colour is a deliberate hole in the theme engine. A theme no longer decides
what the logo looks like; it only says which side of the brand's pair its
background puts the logo on. The first attempt made every theme chartreuse, and
that was reverted before it shipped: `#ccff00` on the light themes' cream is
lower contrast than the olive it replaced, and the 13px marks in automation and
settings rows came out pale enough to look faded. Black on light and chartreuse
on dark reads correctly at every size, which is why the brand pairs them.

What this constrains: a new theme picks one of the two values, not a third, and
if it wants a third it is deciding the logo is wrong in its world. Both Air
themes now draw the mark in that pair rather than in their own orange brand.

Shipped in TBD.

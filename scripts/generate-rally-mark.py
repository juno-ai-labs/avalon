#!/usr/bin/env python3
"""Generate every vector copy of the Rally mark from its equation.

The mark is the seam of a tennis ball drawn on a unit sphere, seen in
perspective. The sphere itself is never drawn. Run with no arguments to rewrite
the committed SVGs; pass --stdout with any of the options to print one variant.
See docs/desktop-icons.md#where-the-mark-comes-from.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

# The seam: x = a cos t + b cos 3t, y = a sin t - b sin 3t, z = 2 sqrt(ab) sin 2t,
# with a + b = 1, which keeps every point on the unit sphere. b sets how far the
# seam swings from the equator.
SEAM_B = 0.19
# Camera distance from the sphere's centre, in sphere radii.
PERSPECTIVE = 4.4
# Tilt turns the sphere about the screen's horizontal axis; spin turns it about
# the seam's own axis first.
TILT_DEGREES = -18.0
SPIN_DEGREES = 20.0
# The path is a closed Catmull-Rom spline through samples at even steps of t,
# starting at t = 3π/2.
SAMPLES = 96
PHASE = 1.5 * math.pi
# The drawing canvas: a 400 by 400 square with the sphere of radius 124 centred.
CANVAS_CENTRE = 200.0
SPHERE_RADIUS = 124.0

VOLT = "#CCFF00"
INK = "#111210"


def seam_point(
    t: float, seam_b: float, perspective: float, tilt: float, spin: float
) -> tuple[float, float]:
    a = 1 - seam_b
    x = a * math.cos(t) + seam_b * math.cos(3 * t)
    y = a * math.sin(t) - seam_b * math.sin(3 * t)
    z = 2 * math.sqrt(a * seam_b) * math.sin(2 * t)
    spun_x = x * math.cos(spin) + y * math.sin(spin)
    spun_y = -x * math.sin(spin) + y * math.cos(spin)
    depth = spun_x * math.cos(tilt) - z * math.sin(tilt)
    down = spun_x * math.sin(tilt) + z * math.cos(tilt)
    across = -spun_y
    scale = SPHERE_RADIUS * perspective / (perspective - depth)
    return CANVAS_CENTRE + scale * across, CANVAS_CENTRE + scale * down


def centre_line(samples: int) -> list[tuple[float, float]]:
    """Points along the shipped mark's centre line, in canvas units, for raster renderers."""
    tilt, spin = math.radians(TILT_DEGREES), math.radians(SPIN_DEGREES)
    return [
        seam_point(2 * math.pi * i / samples, SEAM_B, PERSPECTIVE, tilt, spin)
        for i in range(samples)
    ]


def number(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text == "-0" else text


def mark_path(
    seam_b: float = SEAM_B,
    perspective: float = PERSPECTIVE,
    tilt_degrees: float = TILT_DEGREES,
    spin_degrees: float = SPIN_DEGREES,
    samples: int = SAMPLES,
) -> tuple[str, list[float]]:
    """Return the path data and the numbers written into it."""
    tilt, spin = math.radians(tilt_degrees), math.radians(spin_degrees)
    points = [
        seam_point(PHASE + 2 * math.pi * i / samples, seam_b, perspective, tilt, spin)
        for i in range(samples)
    ]
    values = list(points[0])
    commands = [f"M{number(values[0])},{number(values[1])}"]
    for i in range(samples):
        before, start = points[i - 1], points[i]
        end, after = points[(i + 1) % samples], points[(i + 2) % samples]
        segment = (
            start[0] + (end[0] - before[0]) / 6,
            start[1] + (end[1] - before[1]) / 6,
            end[0] - (after[0] - start[0]) / 6,
            end[1] - (after[1] - start[1]) / 6,
            *end,
        )
        values.extend(segment)
        text = [number(v) for v in segment]
        commands.append(f"C{text[0]},{text[1]} {text[2]},{text[3]} {text[4]},{text[5]}")
    return " ".join(commands) + "Z", values


def view_box(values: list[float], stroke_width: float) -> tuple[str, str, str]:
    """The square around the path's points, padded by the stroke so caps are not clipped."""
    rounded = [float(number(v)) for v in values]
    xs, ys = rounded[0::2], rounded[1::2]
    side = max(max(xs) - min(xs), max(ys) - min(ys)) + stroke_width
    left = (min(xs) + max(xs)) / 2 - side / 2
    top = (min(ys) + max(ys)) / 2 - side / 2
    return number(left), number(top), number(side)


def svg(stroke_width: float, color: str, favicon: bool = False, **projection: float) -> str:
    path, values = mark_path(**projection)
    left, top, side = view_box(values, stroke_width)
    stroke = f'stroke="{color}" stroke-width="{number(stroke_width)}" stroke-linecap="round" stroke-linejoin="round"'
    if favicon:
        # A tab bar can be light or dark; volt washes out on light, so switch to ink.
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left} {top} {side} {side}" fill="none">\n'
            f"<style>@media (prefers-color-scheme: light) {{ path {{ stroke: {INK}; }} }}</style>\n"
            f'<path d="{path}" {stroke}/>\n'
            "</svg>\n"
        )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left} {top} {side} {side}" fill="none" role="img" aria-labelledby="rally-title">\n'
        '<title id="rally-title">Rally</title>\n'
        f'<path d="{path}" {stroke}></path>\n'
        "</svg>"
    )


def motion_kit() -> str:
    path, values = mark_path()
    left, top, side = view_box(values, 15)
    return (
        "// The Rally mark: a single stroke path in a 249.63 viewBox (from apps/site/public/brand/rally-mark.svg).\n"
        f'const MARK_D = "{path}";\n'
        f"const MARK_VIEWBOX = {{ x: {left}, y: {top}, s: {side} }};\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stdout", action="store_true", help="print one SVG instead of writing files")
    parser.add_argument("--stroke", type=float, default=15)
    parser.add_argument("--color", default=VOLT)
    parser.add_argument("--seam-b", type=float, default=SEAM_B)
    parser.add_argument("--perspective", type=float, default=PERSPECTIVE)
    parser.add_argument("--tilt", type=float, default=TILT_DEGREES)
    parser.add_argument("--spin", type=float, default=SPIN_DEGREES)
    parser.add_argument("--samples", type=int, default=SAMPLES)
    args = parser.parse_args()
    if args.stdout:
        print(
            svg(
                args.stroke,
                args.color,
                seam_b=args.seam_b,
                perspective=args.perspective,
                tilt_degrees=args.tilt,
                spin_degrees=args.spin,
                samples=args.samples,
            )
        )
        return

    brand = ROOT / "apps" / "site" / "public" / "brand"
    outputs = {
        brand / "rally-mark.svg": svg(15, VOLT),
        # The thicker cut for placements narrower than 24 px.
        brand / "rally-mark-small.svg": svg(18, VOLT),
        brand / "rally-mark-ink.svg": svg(15, INK),
        ROOT / "apps" / "site" / "public" / "favicon.svg": svg(18, VOLT, favicon=True),
        ROOT / "apps" / "browser" / "public" / "favicon.svg": svg(18, VOLT, favicon=True),
        ROOT / ".agents" / "skills" / "rally-motion" / "kit" / "mark.js": motion_kit(),
    }
    for path, text in outputs.items():
        path.write_text(text)


if __name__ == "__main__":
    main()

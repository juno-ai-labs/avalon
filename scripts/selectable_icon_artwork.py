#!/usr/bin/env python3
"""Render the textured user-selectable Rally app icons.

Every selectable icon is the one canonical Rally mark laid into a material.
The mark geometry comes from `apps/site/public/brand/rally-mark.svg` rather than
the raster mask, because these treatments need a signed distance to the stroke
centre line — paint bleeding into grass, dust settling on a line, fibres
overhanging a channel and a neon tube's falloff are all functions of that
distance, and an 8-bit alpha mask cannot supply it.

`generate-brand-assets.py` owns the pipeline; this module owns the artwork.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MARK_SVG = ROOT / "apps" / "site" / "public" / "brand" / "rally-mark.svg"

# The generated light and dark icons place the stroked mark's ink box across
# 700 of their 1024 pixels, centred on the tile. Every selectable icon repeats
# that geometry so the shelf reads as one mark in seven materials rather than
# seven marks at seven sizes.
MARK_INK_FRACTION = 700 / 1024

RGB = tuple[float, float, float]


def _srgb(value: str) -> RGB:
    """Return a #rrggbb string as sRGB channels scaled to [0, 1].

    Compositing happens in these values rather than in linear light. That is
    wrong for physical light transport and right here: the numbers below were
    chosen by looking at the result, and a linear pipeline would move all of
    them.
    """
    packed = value.lstrip("#")
    return tuple(int(packed[index:index + 2], 16) / 255 for index in (0, 2, 4))  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# The mark as a distance field
# ---------------------------------------------------------------------------


def _flattened_mark_path(steps: int = 12) -> np.ndarray:
    """Return the mark's closed centre line as a polyline in SVG user units."""
    document = MARK_SVG.read_text(encoding="utf8")
    commands = re.search(r'\sd="([^"]+)"', document)
    if commands is None:
        raise ValueError(f"{MARK_SVG} has no path data")
    body = commands.group(1).strip()
    if not body.startswith("M") or not body.endswith("Z"):
        raise ValueError("The Rally mark must be one closed path that starts with M and ends with Z")
    interior = body[1:-1]
    if not interior.count("C") or set(interior) - set("C0123456789.,- \t\n"):
        raise ValueError("The Rally mark must be one moveto followed by absolute cubic curves")

    numbers = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", interior)]
    start, rest = numbers[:2], numbers[2:]
    if len(rest) % 6:
        raise ValueError("Cubic polybezier coordinates must arrive in groups of six")

    fractions = np.linspace(0, 1, steps, endpoint=False)[:, None]
    points = [start]
    current = np.array(start)
    for index in range(0, len(rest), 6):
        first, second, end = (
            np.array(rest[index:index + 2]),
            np.array(rest[index + 2:index + 4]),
            np.array(rest[index + 4:index + 6]),
        )
        inverse = 1 - fractions
        curve = (
            inverse ** 3 * current
            + 3 * inverse ** 2 * fractions * first
            + 3 * inverse * fractions ** 2 * second
            + fractions ** 3 * end
        )
        points.extend(curve[1:].tolist())
        points.append(end.tolist())
        current = end
    points.append(start)
    return np.array(points, dtype=np.float64)


@dataclass(frozen=True)
class Mark:
    """The Rally mark rasterized as a distance-to-centre-line field."""

    distance: np.ndarray
    """Distance in pixels from every pixel to the mark's centre line."""

    radius: float
    """Half the stroke width, in pixels."""

    def coverage(self, radius: float | None = None, softness: float = 1.0) -> np.ndarray:
        """Return an antialiased 0…1 mask of the stroke at the given radius."""
        edge = self.radius if radius is None else radius
        return np.clip((edge - self.distance) / softness + 0.5, 0, 1)

    def band(self, inner: float, outer: float, softness: float = 1.0) -> np.ndarray:
        """Return a 0…1 mask of the ring between two distances from the centre line."""
        return self.coverage(outer, softness) * (1 - self.coverage(inner, softness))


def mark_field(size: int, reach: float = 0.22) -> Mark:
    """Rasterize the distance to the mark's centre line, clamped beyond `reach`.

    The clamp is what makes this affordable: distances are only evaluated in a
    window around each flattened segment, so cost scales with the stroke's area
    rather than the tile's.
    """
    path = _flattened_mark_path()
    stroke = float(re.search(r'stroke-width="([\d.]+)"', MARK_SVG.read_text(encoding="utf8")).group(1)) / 2
    ink_width = (path[:, 0].max() + stroke) - (path[:, 0].min() - stroke)
    scale = size * MARK_INK_FRACTION / ink_width
    centre = np.array([(path[:, 0].min() + path[:, 0].max()) / 2, (path[:, 1].min() + path[:, 1].max()) / 2])
    points = (path - centre) * scale + size / 2

    limit = size * reach
    distance = np.full((size, size), limit, dtype=np.float32)
    starts, ends = points[:-1], points[1:]
    for (x0, y0), (x1, y1) in zip(starts, ends):
        left = max(int(math.floor(min(x0, x1) - limit)), 0)
        right = min(int(math.ceil(max(x0, x1) + limit)) + 1, size)
        top = max(int(math.floor(min(y0, y1) - limit)), 0)
        bottom = min(int(math.ceil(max(y0, y1) + limit)) + 1, size)
        if left >= right or top >= bottom:
            continue
        xs = np.arange(left, right, dtype=np.float32)[None, :]
        ys = np.arange(top, bottom, dtype=np.float32)[:, None]
        dx, dy = x1 - x0, y1 - y0
        length = dx * dx + dy * dy
        travel = 0.0 if length == 0 else np.clip(((xs - x0) * dx + (ys - y0) * dy) / length, 0, 1)
        near_x, near_y = x0 + travel * dx, y0 + travel * dy
        window = np.hypot(xs - near_x, ys - near_y).astype(np.float32)
        block = distance[top:bottom, left:right]
        np.minimum(block, window, out=block)
    return Mark(distance=distance, radius=stroke * scale)


_MARK_FIELDS: dict[int, Mark] = {}


def cached_mark_field(size: int) -> Mark:
    """Return the distance field for a tile size, rasterizing it at most once."""
    if size not in _MARK_FIELDS:
        _MARK_FIELDS[size] = mark_field(size)
    return _MARK_FIELDS[size]


# ---------------------------------------------------------------------------
# Texture primitives
# ---------------------------------------------------------------------------


def _box_pass(field: np.ndarray, radius: int) -> np.ndarray:
    """Blur vertically: average each column over a window, using a running sum."""
    padded = np.pad(field, ((radius, radius), (0, 0)), mode="edge")
    running = np.cumsum(padded, axis=0, dtype=np.float32)
    running = np.concatenate([np.zeros((1, field.shape[1]), np.float32), running])
    span = 2 * radius + 1
    return (running[span:] - running[:-span]) / span


def blur(field: np.ndarray, sigma: float, vertical: float | None = None) -> np.ndarray:
    """Blur a scalar field by `sigma` horizontally and `vertical` down the tile.

    Three box passes approximate a Gaussian closely enough for lighting and
    bloom, and cost the same regardless of radius — which matters here because
    the neon glows reach a fifth of the tile. The axes are separate because an
    anisotropic blur is what smears a reflection down a wet court or pulls a
    squeegee streak across a dry one; `vertical` defaults to `sigma`, which
    gives the ordinary isotropic blur.
    """
    result = field.astype(np.float32)
    for axis_sigma, down in ((sigma if vertical is None else vertical, True), (sigma, False)):
        if axis_sigma <= 0.6:
            continue
        radius = max(1, int(round((math.sqrt(1 + 4 * axis_sigma * axis_sigma) - 1) / 2)))
        for _ in range(3):
            result = _box_pass(result, radius) if down else _box_pass(result.T, radius).T
    return result


def noise(rng: np.random.Generator, size: int, cells: int, octaves: int = 1, persistence: float = 0.5) -> np.ndarray:
    """Return smooth 0…1 value noise, summed over halving octaves."""
    total = np.zeros((size, size), np.float32)
    amplitude, weight = 1.0, 0.0
    for octave in range(octaves):
        grid = max(2, cells * 2 ** octave)
        lattice = rng.random((grid, grid)).astype(np.float32)
        layer = np.asarray(Image.fromarray(lattice).resize((size, size), Image.Resampling.BICUBIC))
        total += amplitude * layer
        weight += amplitude
        amplitude *= persistence
    return np.clip(total / weight, 0, 1)


def gradient(size: int, x: float, y: float) -> np.ndarray:
    """Return a 0…1 ramp that peaks at the given fractional point and falls to the far corner."""
    axis = np.linspace(0, 1, size, dtype=np.float32)
    distance = np.hypot(axis[None, :] - x, axis[:, None] - y)
    return np.clip(1 - distance / math.sqrt(2), 0, 1)


def strokes(
    size: int,
    rng: np.random.Generator,
    count: int,
    length: tuple[float, float],
    width: tuple[int, int],
    angle: np.ndarray | float,
    palette: list[RGB],
    jitter: float = 0.0,
) -> np.ndarray:
    """Draw short line segments and return them as an RGB float array.

    Grass blades and felt fibres are the texture, not a filter applied over one:
    drawing them individually is what puts a real edge between a lit fibre and
    the shade behind it, which no amount of noise reproduces.
    """
    # `covered` reads coverage back off this canvas, so a stroke drawn in pure
    # black would be indistinguishable from bare canvas and silently vanish.
    if any(max(colour) == 0 for colour in palette):
        raise ValueError("A stroke palette cannot contain pure black; coverage is read from the drawn pixels")
    canvas = Image.new("RGB", (size, size), (0, 0, 0))
    pen = ImageDraw.Draw(canvas)
    xs = rng.random(count) * size
    ys = rng.random(count) * size
    lengths = rng.uniform(length[0], length[1], count) * size
    widths = rng.integers(width[0], width[1] + 1, count)
    tones = rng.integers(0, len(palette), count)
    if isinstance(angle, np.ndarray):
        columns = np.clip((xs / size * angle.shape[1]).astype(int), 0, angle.shape[1] - 1)
        rows = np.clip((ys / size * angle.shape[0]).astype(int), 0, angle.shape[0] - 1)
        angles = angle[rows, columns]
    else:
        angles = np.full(count, angle, dtype=np.float32)
    angles = angles + rng.normal(0, jitter, count) if jitter else angles
    for x, y, span, thickness, tone, heading in zip(xs, ys, lengths, widths, tones, angles):
        colour = palette[tone]
        pen.line(
            [(x, y), (x + math.cos(heading) * span, y + math.sin(heading) * span)],
            fill=tuple(round(channel * 255) for channel in colour),
            width=int(thickness),
        )
    return np.asarray(canvas, dtype=np.float32) / 255


def covered(layer: np.ndarray) -> np.ndarray:
    """Return where a stroke layer drew anything. Lines are not antialiased, so
    this is a hard mask — which is what a blade edge should be."""
    return (layer.sum(axis=2) > 0).astype(np.float32)


def luminance(image: np.ndarray) -> np.ndarray:
    return image @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def tint(field: np.ndarray, colour: RGB) -> np.ndarray:
    """Multiply a scalar field into a flat colour, giving an RGB array."""
    return field[:, :, None] * np.array(colour, dtype=np.float32)


def over(base: np.ndarray, colour: np.ndarray | RGB, alpha: np.ndarray | float) -> np.ndarray:
    """Composite a colour over a base with a per-pixel alpha."""
    layer = colour if isinstance(colour, np.ndarray) else np.array(colour, dtype=np.float32)
    if layer.ndim == 1:
        layer = np.broadcast_to(layer, base.shape)
    weight = alpha[:, :, None] if isinstance(alpha, np.ndarray) else alpha
    return base * (1 - weight) + layer * weight


def screen(base: np.ndarray, colour: np.ndarray | RGB, alpha: np.ndarray | float) -> np.ndarray:
    """Add light to a base without clipping it to the added colour."""
    layer = colour if isinstance(colour, np.ndarray) else np.array(colour, dtype=np.float32)
    if layer.ndim == 1:
        layer = np.broadcast_to(layer, base.shape)
    weight = alpha[:, :, None] if isinstance(alpha, np.ndarray) else alpha
    return 1 - (1 - base) * (1 - np.clip(layer * weight, 0, 1))


def finish(image: np.ndarray) -> Image.Image:
    """Convert a float RGB array to the opaque, full-bleed PNG the build expects."""
    pixels = np.clip(image, 0, 1)
    result = Image.fromarray((pixels * 255 + 0.5).astype(np.uint8), mode="RGB").convert("RGBA")
    if result.getpixel((0, 0))[3] != 255:
        raise ValueError("A selectable icon must be opaque; macOS owns the enclosure and its mask")
    return result


# ---------------------------------------------------------------------------
# The materials
# ---------------------------------------------------------------------------

MOW_STRIPES = 7


def grass_court(size: int = 1024) -> Image.Image:
    """Mown rye grass with sprayed line paint, after Wimbledon."""
    rng = np.random.default_rng(0x6D6F776E)
    mark = cached_mark_field(size)

    # A striped court is one grass colour lit from two directions: the mower
    # lays alternating bands of blades towards and away from the viewer, and
    # the band leaning away shows its lit tips. Leaning the blades is therefore
    # the whole effect, and the tonal stripe below only reinforces it at Dock
    # sizes where individual blades have averaged out.
    band = np.floor(np.linspace(0, MOW_STRIPES, size, endpoint=False, dtype=np.float32))
    lean = np.where(band % 2 < 1, -1.05, -2.05)[None, :]

    soil = _srgb("#20361B")
    mottle = noise(rng, size, 5, 4)
    base = over(tint(np.ones((size, size), np.float32), soil), _srgb("#294520"), mottle * 0.55)

    understorey = strokes(
        size, rng, 26_000, (0.010, 0.020), (2, 4), lean,
        [_srgb("#16290F"), _srgb("#1D3517"), _srgb("#24401C")], jitter=0.5,
    )
    base = over(base, understorey, covered(understorey))
    blades = strokes(
        size, rng, 54_000, (0.014, 0.030), (2, 3), lean,
        [_srgb("#2A5622"), _srgb("#356526"), _srgb("#42782C"), _srgb("#508D35"), _srgb("#63A241")],
        jitter=0.42,
    )
    turf = over(base, blades, covered(blades))

    stripe = blur(np.where(band % 2 < 1, 1.0, 0.0)[None, :].repeat(size, axis=0).astype(np.float32), 5)
    turf *= (0.90 + 0.19 * stripe)[:, :, None]

    # Two weeks of play burn the grass back towards straw in the busiest areas.
    # Without it the turf reads as an even synthetic mat at any size.
    wear = np.clip((noise(rng, size, 3, 3) - 0.52) * 3.4, 0, 1) * (0.35 + 0.65 * gradient(size, 0.5, 0.86))
    turf = over(turf, _srgb("#8A8A4B"), wear * 0.42)

    turf *= (0.84 + 0.30 * gradient(size, 0.30, 0.20))[:, :, None]

    # Line marker paint is sprayed onto the blade tips, so its edge follows the
    # grass rather than the geometry, and the shaded gaps between blades stay
    # green. Both are why a hard-edged white stroke here looks like a sticker.
    ragged = (noise(rng, size, 96, 3) - 0.5) * 11
    painted = mark.coverage(mark.radius + ragged, softness=1.7)
    tips = np.clip((luminance(turf) - 0.10) / 0.16, 0, 1)
    thinning = 0.72 + 0.28 * noise(rng, size, 9, 2)
    paint = painted * (0.30 + 0.70 * tips) * thinning
    chalk = over(tint(np.ones((size, size), np.float32), _srgb("#F3F5E9")), _srgb("#D8DCC6"), noise(rng, size, 160, 2) * 0.5)
    return finish(over(turf, chalk, paint))


def clay_court(size: int = 1024) -> Image.Image:
    """Crushed brick under a drag mat, after Roland-Garros."""
    rng = np.random.default_rng(0x636C6179)
    mark = cached_mark_field(size)

    body = noise(rng, size, 4, 4)
    clay = over(tint(np.ones((size, size), np.float32), _srgb("#8E3216")), _srgb("#B54C25"), body * 0.9)

    # Crushed brick is a loose granular dressing, and a granule is a few pixels
    # across at 1024 — not one. Scattering them as individual specks is the
    # only thing that reads as terre battue rather than as orange plaster;
    # smooth noise at this scale looks airbrushed however much of it is used.
    packed = strokes(
        size, rng, 130_000, (0.0016, 0.0042), (2, 4), 0.0,
        [_srgb("#6E2409"), _srgb("#822F12"), _srgb("#963C1B")], jitter=3.2,
    )
    clay = over(clay, packed, covered(packed) * 0.85)
    drift = np.clip((noise(rng, size, 7, 3) - 0.42) * 2.4, 0, 1)
    loose = strokes(
        size, rng, 150_000, (0.0016, 0.0050), (2, 4), 0.0,
        [_srgb("#B04B24"), _srgb("#C25F35"), _srgb("#CB7245"), _srgb("#DB8B5E")], jitter=3.2,
    )
    clay = over(clay, loose, covered(loose) * (0.22 + 0.55 * drift))

    # The drag mat is pulled in a long arc from the net post. Sweeping a centre
    # far outside the tile is what keeps its grooves from reading as a pattern.
    axis = np.arange(size, dtype=np.float32)
    angle = np.arctan2(axis[:, None] - size * 1.5, axis[None, :] + size * 0.7)
    wander = (noise(rng, size, 6, 3) - 0.5) * 3.0
    swept = angle * 150 + wander * 9
    grooves = np.abs(np.sin(swept)) ** 3
    clay = over(clay, _srgb("#7C2C10"), grooves * 0.17 * (0.3 + 0.7 * noise(rng, size, 20, 2)))
    clay = over(clay, _srgb("#D18A5E"), np.abs(np.sin(swept + 1.5)) ** 3 * 0.11)

    # A slide is the one mark that says a point was played here: the shoe
    # scrapes the dressing away and heaps it at the far end of the streak.
    skid = np.zeros((size, size), np.float32)
    for centre_x, centre_y, span, heading in ((0.23, 0.29, 0.19, -21), (0.74, 0.70, 0.24, 13), (0.47, 0.12, 0.14, 7)):
        stroke = Image.new("F", (size, size), 0.0)
        ImageDraw.Draw(stroke).ellipse(
            (size * (centre_x - span), size * (centre_y - 0.016), size * (centre_x + span), size * (centre_y + 0.016)),
            fill=1.0,
        )
        skid = np.maximum(skid, np.asarray(stroke.rotate(heading, center=(size * centre_x, size * centre_y)), dtype=np.float32))
    scrape = blur(skid, size * 0.0015) * np.clip(noise(rng, size, 90, 3) * 1.7 - 0.25, 0, 1)
    clay = over(clay, _srgb("#8B3517"), scrape * 0.62)
    clay = over(clay, _srgb("#EDBB94"), blur(skid, size * 0.012) * 0.16)

    clay *= (0.84 + 0.28 * gradient(size, 0.32, 0.24))[:, :, None]

    # The lines are tape laid under the dressing, so they are crisp where they
    # are clean and swallowed where the mat has dragged clay back over them.
    edge = (noise(rng, size, 170, 2) - 0.5) * 3.4
    tape = mark.coverage(mark.radius + edge, softness=1.2)
    line = over(tint(np.ones((size, size), np.float32), _srgb("#F1EADE")), _srgb("#C8B7A3"), noise(rng, size, 150, 2) * 0.5)
    clay = over(clay, _srgb("#69270F"), mark.band(mark.radius, mark.radius + size * 0.005, 1.4) * 0.40)
    clay = over(clay, line, tape)
    settled = strokes(
        size, rng, 70_000, (0.0016, 0.0042), (2, 4), 0.0,
        [_srgb("#BE5E33"), _srgb("#CE7B4F"), _srgb("#A9491F")], jitter=3.2,
    )
    dusting = np.clip(noise(rng, size, 9, 4) * 1.6 - 0.34, 0, 1) * (0.35 + 0.65 * grooves)
    return finish(over(clay, settled, tape * covered(settled) * dusting * 0.85))


def hard_court(size: int = 1024) -> Image.Image:
    """Sand-filled acrylic over asphalt, after the US Open."""
    rng = np.random.default_rng(0x68617264)
    mark = cached_mark_field(size)

    body = noise(rng, size, 5, 4)
    court = over(tint(np.ones((size, size), np.float32), _srgb("#0B3F73")), _srgb("#175E9C"), body * 0.85)

    # An acrylic court is paint with silica graded into it, which is why it is
    # matte and slightly abrasive rather than glossy. The sand is the surface:
    # single grains, lit from one side, over a squeegeed film.
    sand = strokes(
        size, rng, 200_000, (0.0014, 0.0034), (2, 3), 0.0,
        [_srgb("#2E74AE"), _srgb("#4A8CC0"), _srgb("#6BA6CF"), _srgb("#123F6C")], jitter=3.2,
    )
    court = over(court, sand, covered(sand) * 0.5)

    # The film is pulled across the court with a squeegee, so what large-scale
    # variation there is runs in one direction. An isotropic blur here would
    # read as cloud instead.
    pulled = blur(rng.random((size, size)).astype(np.float32), size * 0.09, vertical=size * 0.004)
    court = over(court, _srgb("#1F6BA6"), np.clip((pulled - 0.5) * 6 + 0.5, 0, 1) * 0.22)
    court = over(court, _srgb("#093861"), np.clip((0.5 - pulled) * 6 + 0.5, 0, 1) * 0.18)

    # Every ball that lands leaves felt on the court. Groundskeepers scrub them
    # off between sessions and nobody gets them all, and their volt is the same
    # colour the mark is drawn in on the two icons beside this one.
    marks = np.zeros((size, size), np.float32)
    for centre_x, centre_y, radius, heading in (
        (0.16, 0.62, 0.055, 24), (0.83, 0.28, 0.043, -38), (0.38, 0.87, 0.037, 62),
        (0.62, 0.06, 0.030, -12), (0.90, 0.79, 0.034, 41), (0.09, 0.19, 0.028, -55),
    ):
        smudge = Image.new("F", (size, size), 0.0)
        ImageDraw.Draw(smudge).ellipse(
            (size * (centre_x - radius), size * (centre_y - radius * 0.42),
             size * (centre_x + radius), size * (centre_y + radius * 0.42)),
            fill=1.0,
        )
        marks = np.maximum(marks, np.asarray(smudge.rotate(heading, center=(size * centre_x, size * centre_y)), dtype=np.float32))
    scuff = blur(marks, size * 0.010, vertical=size * 0.004) * np.clip(noise(rng, size, 60, 3) * 1.8 - 0.30, 0, 1)
    court = over(court, _srgb("#9EAE49"), scuff * 0.42)

    court = screen(court, _srgb("#7FB6DE"), gradient(size, 0.26, 0.16) ** 3 * 0.22)
    court *= (0.84 + 0.28 * gradient(size, 0.30, 0.22))[:, :, None]

    # Court lines are the same acrylic in white, rolled on over the blue, so
    # they stand a fraction of a millimetre proud of it. At icon sizes that
    # ridge is the whole difference between a painted line and a pasted shape.
    line = mark.coverage(mark.radius + (noise(rng, size, 220, 2) - 0.5) * 1.6, softness=1.1)
    dropped = np.roll(line, (5, 5), axis=(0, 1))
    court = over(court, _srgb("#06294A"), np.clip(dropped - line, 0, 1) * 0.5)
    paint = over(tint(np.ones((size, size), np.float32), _srgb("#F4F8FA")), _srgb("#C9D6DE"), noise(rng, size, 180, 2) * 0.42)
    court = over(court, paint, line)
    white_sand = strokes(
        size, rng, 120_000, (0.0014, 0.0034), (2, 3), 0.0,
        [_srgb("#FFFFFF"), _srgb("#D3DEE5"), _srgb("#B7C6D1")], jitter=3.2,
    )
    court = over(court, white_sand, line * covered(white_sand) * 0.4)
    return finish(screen(court, _srgb("#FFFFFF"), np.clip(line - np.roll(line, (4, 4), axis=(0, 1)), 0, 1) * 0.5))


def ball_felt(size: int = 1024) -> Image.Image:
    """Melton felt with the mark cut through it as the ball's seam."""
    rng = np.random.default_rng(0x66656C74)
    mark = cached_mark_field(size)

    body = noise(rng, size, 6, 4)
    felt = over(tint(np.ones((size, size), np.float32), _srgb("#9FB420")), _srgb("#C4DC33"), body * 0.9)

    # Felt is a nap, not a surface: an under-layer of dark fibre with lit fibre
    # standing above it. Drawing both and blooming only the top layer is what
    # gives the edge its fuzz instead of a cut-out silhouette.
    undercoat = strokes(
        size, rng, 90_000, (0.004, 0.011), (2, 4), 0.0,
        [_srgb("#71861A"), _srgb("#879C1E"), _srgb("#5C6E16")], jitter=3.2,
    )
    felt = over(felt, undercoat, covered(undercoat) * 0.9)
    nap = strokes(
        size, rng, 150_000, (0.005, 0.016), (2, 3), 0.0,
        [_srgb("#B7CE2B"), _srgb("#CBE53A"), _srgb("#DCF255"), _srgb("#CCFF00"), _srgb("#9AB024")],
        jitter=3.2,
    )
    felt = over(felt, nap, covered(nap) * 0.85)
    felt = screen(felt, _srgb("#D9F25A"), blur(covered(nap), size * 0.004) * 0.24)

    # A ball is a sphere, and the only reason a square tile of its cover reads
    # as one is the falloff towards the corners.
    felt *= (0.52 + 0.62 * gradient(size, 0.34, 0.27) ** 0.75)[:, :, None]
    felt = screen(felt, _srgb("#FFFFFF"), gradient(size, 0.30, 0.23) ** 6 * 0.18)

    # The seam is a channel between two felt panels, showing the rubber under
    # them. Fibre falls into it, so the wall is dark and the lip is fuzzy —
    # cutting a clean stroke here would read as a sticker on a tennis ball.
    wobble = (noise(rng, size, 110, 3) - 0.5) * 7
    channel = mark.coverage(mark.radius * 1.02 + wobble, softness=1.9)
    felt = over(felt, _srgb("#4A5A12"), np.clip(mark.coverage(mark.radius * 1.42 + wobble, 6.0) - channel, 0, 1) * 0.62)
    rubber = over(tint(np.ones((size, size), np.float32), _srgb("#F2F1E4")), _srgb("#C9C8B4"), noise(rng, size, 90, 3) * 0.55)
    rubber = screen(rubber, _srgb("#FFFFFF"), gradient(size, 0.30, 0.23) ** 4 * 0.35)
    felt = over(felt, rubber, channel)
    felt = over(felt, _srgb("#7C7C58"), np.clip(channel - mark.coverage(mark.radius * 0.80 + wobble, 4.0), 0, 1) * 0.42)
    overhang = strokes(
        size, rng, 130_000, (0.005, 0.014), (2, 3), 0.0,
        [_srgb("#A8BE28"), _srgb("#C2DA34"), _srgb("#8FA321")], jitter=3.2,
    )
    lip = mark.band(mark.radius * 0.84, mark.radius * 1.26, 8.0)
    return finish(over(felt, overhang, lip * covered(overhang) * 0.8))


def night_match(size: int = 1024) -> Image.Image:
    """A wet court under the lights, with the mark run as a neon tube."""
    rng = np.random.default_rng(0x6E69676874)
    mark = cached_mark_field(size)
    volt, cool = _srgb("#CCFF00"), _srgb("#47C7FC")

    body = noise(rng, size, 6, 4)
    court = over(tint(np.ones((size, size), np.float32), _srgb("#03050A")), _srgb("#0C1524"), body * 0.8)

    # Water sheets and runs, so a wet surface smears its highlights along one
    # axis. Blurring the same noise unevenly is the whole trick.
    sheet = blur(rng.random((size, size)).astype(np.float32), size * 0.004, vertical=size * 0.05)
    court = screen(court, _srgb("#2D4E7A"), np.clip((sheet - 0.5) * 5 + 0.5, 0, 1) * 0.30)

    # A floodlight rig stands off one corner of the court, not above its
    # middle, so the pool is elliptical and most of the tile stays unlit.
    axis = np.linspace(0, 1, size, dtype=np.float32)
    pool = np.clip(1 - np.hypot((axis[None, :] - 0.42) * 1.05, (axis[:, None] + 0.20) * 1.45), 0, 1) ** 2.1
    court = screen(court, _srgb("#FFEFC9"), pool * 0.46)
    court = screen(court, _srgb("#FFE6B0"), blur(pool, size * 0.12) * 0.18)

    # Two court lines, dim enough to be structure rather than subject: without
    # them the tile is atmosphere with no court in it.
    for start, span, horizontal in ((0.84, 0.010, True), (0.90, 0.008, False)):
        band = np.abs(axis - start) < span
        painted = (band[:, None] if horizontal else band[None, :]) * np.ones((size, size), np.float32)
        court = screen(court, _srgb("#9FB2C6"), blur(painted, 1.2) * (0.10 + 0.32 * pool))

    rain = strokes(
        size, rng, 3_400, (0.030, 0.078), (1, 2), 1.31,
        [_srgb("#BFD6EE"), _srgb("#8FB0D2"), _srgb("#E4EEF8")], jitter=0.04,
    )
    court = screen(court, rain, covered(rain) * (0.08 + 0.92 * pool) * 0.62)
    spray = strokes(
        size, rng, 5_000, (0.0012, 0.0030), (2, 3), 0.0,
        [_srgb("#CFE2F5"), _srgb("#8AA8C6")], jitter=3.2,
    )
    court = screen(court, spray, covered(spray) * (0.06 + 0.60 * pool) * 0.30)

    # A neon tube is a hot white filament inside a coloured envelope inside a
    # bloom that reaches much further than the tube is wide. Stacking those
    # three is what separates neon from a stroke with a shadow.
    tube = mark.coverage(mark.radius * 0.96, softness=1.6)
    court = screen(court, cool, blur(tube, size * 0.13) * 0.30)
    court = screen(court, volt, blur(tube, size * 0.085) * 0.52)
    court = screen(court, volt, blur(tube, size * 0.030) * 0.66)
    court = screen(court, volt, blur(tube, size * 0.010) * 0.72)

    # The court is wet, so the tube runs down it. This is the reflection: a
    # vertical smear of the same light, broken up by the water moving over it.
    runoff = blur(tube, size * 0.006, vertical=size * 0.075) * (0.45 + 0.55 * sheet)
    court = screen(court, volt, runoff * 0.38)

    court = screen(court, volt, tube * 0.92)
    court = screen(court, _srgb("#F4FFD2"), mark.coverage(mark.radius * 0.48, softness=1.6) * 0.80)
    return finish(court)


# The identifiers here are the ones in `TELEMETRY_APPLICATION_ICON_IDS`; the
# desktop resolves artwork by identifier, so a name added on one side and not
# the other is a missing file at runtime rather than a type error.
TEXTURED_SELECTABLE_ICONS = {
    "grass-court": grass_court,
    "clay-court": clay_court,
    "hard-court": hard_court,
    "ball-felt": ball_felt,
    "night-match": night_match,
}

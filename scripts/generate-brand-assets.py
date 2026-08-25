#!/usr/bin/env python3
"""Generate Rally web and Electron brand assets from the canonical alpha mask."""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "brand" / "rally-mark-source.png"
APPLICATION_ICON_DIRECTORY = ROOT / "apps" / "desktop" / "resources" / "app-icons"
APPLICATION_ICON_PREVIEW_DIRECTORY = (
    ROOT / "apps" / "desktop" / "src" / "renderer" / "assets" / "app-icons"
)
MENU_BAR_ICON_DIRECTORY = ROOT / "apps" / "desktop" / "resources" / "menu-bar"
MENU_BAR_ICON_POINT_SIZE = 16
# One device pixel of breathing room at 1x. The mark is a full-bleed ring, and a
# status item that touches its own bounds reads as clipped next to the system
# extras, which all carry optical padding of their own.
MENU_BAR_ICON_INSET = 1 / 16
# The source mark carries a wide halo of near-zero alpha. Cropping on the raw
# bounding box would keep it and shrink the visible ring to roughly two thirds of
# the menu bar, so the crop is taken at a threshold instead.
MENU_BAR_ICON_ALPHA_THRESHOLD = 16
PRIMARY = (206, 220, 0, 255)  # #CEDC00
SECONDARY = (71, 199, 252, 255)  # #47C7FC
DARK_CANVAS = (17, 18, 16, 255)  # #111210
LIGHT_CANVAS = (236, 235, 229, 255)  # #ECEBE5
MACOS_ICON_INSET = 100 / 1024
MACOS_ICON_CORNER_EXPONENT = 5
MACOS_ICON_SHADOW_OFFSET = 10 / 1024
MACOS_ICON_SHADOW_RADIUS = 8 / 1024
MACOS_ICON_SHADOW_OPACITY = 64


def mark(size: int, color: tuple[int, int, int, int] = PRIMARY) -> Image.Image:
    source = Image.open(SOURCE).convert("RGBA")
    alpha = source.getchannel("A").resize((size, size), Image.Resampling.LANCZOS)
    result = Image.new("RGBA", (size, size), color)
    result.putalpha(alpha)
    return result


def app_icon(
    size: int,
    canvas: tuple[int, int, int, int] = DARK_CANVAS,
    foreground: tuple[int, int, int, int] = PRIMARY,
) -> Image.Image:
    result = Image.new("RGBA", (size, size), canvas)
    result.alpha_composite(mark(size, foreground))
    return result


def macos_icon_mask(size: int) -> Image.Image:
    """Return the inset continuous-corner silhouette used by legacy ICNS icons."""
    supersampling = 4
    canvas_size = size * supersampling
    inset = size * MACOS_ICON_INSET * supersampling
    center = canvas_size / 2
    radius = center - inset
    points: list[tuple[float, float]] = []

    # A fifth-order superellipse closely follows the macOS continuous-corner
    # app-icon shape without depending on an opaque platform mask at runtime.
    for step in range(2048):
        angle = 2 * math.pi * step / 2048
        cosine = math.cos(angle)
        sine = math.sin(angle)
        x = center + radius * math.copysign(
            abs(cosine) ** (2 / MACOS_ICON_CORNER_EXPONENT), cosine
        )
        y = center + radius * math.copysign(
            abs(sine) ** (2 / MACOS_ICON_CORNER_EXPONENT), sine
        )
        points.append((x, y))

    mask = Image.new("L", (canvas_size, canvas_size), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def macos_app_icon(
    size: int,
    canvas: tuple[int, int, int, int] = DARK_CANVAS,
    foreground: tuple[int, int, int, int] = PRIMARY,
) -> Image.Image:
    """Render a legacy macOS icon with transparent corners and optical padding."""
    inset = round(size * MACOS_ICON_INSET)
    tile_size = size - 2 * inset
    mask = macos_icon_mask(size)

    shadow_alpha = Image.new("L", (size, size), 0)
    shadow_alpha.paste(mask, (0, round(size * MACOS_ICON_SHADOW_OFFSET)))
    shadow_alpha = shadow_alpha.filter(
        ImageFilter.GaussianBlur(size * MACOS_ICON_SHADOW_RADIUS)
    )
    shadow_alpha = shadow_alpha.point(
        lambda alpha: alpha * MACOS_ICON_SHADOW_OPACITY // 255
    )
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.putalpha(shadow_alpha)
    result.alpha_composite(shadow)

    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.alpha_composite(app_icon(tile_size, canvas, foreground), (inset, inset))
    tile.putalpha(mask)
    result.alpha_composite(tile)

    if result.getpixel((0, 0))[3] != 0 or result.getpixel((size // 2, size // 2))[3] != 255:
        raise ValueError("macOS app icon must have transparent corners and an opaque center")
    return result


def menu_bar_template_icon(size: int) -> Image.Image:
    """Render the status-item glyph as a macOS template image.

    A template image carries only an alpha mask; macOS paints it black, white,
    or the accent colour to match the menu bar it is drawn into, which is the
    only treatment that survives the translucent menu bar in macOS 26 and 27.
    Any colour baked in here would be discarded, so the artwork is pure black.
    """
    source = Image.open(SOURCE).convert("RGBA")
    alpha = source.getchannel("A")
    box = alpha.point(
        lambda value: 255 if value >= MENU_BAR_ICON_ALPHA_THRESHOLD else 0
    ).getbbox()
    if box is None:
        raise ValueError("The Rally mark source has no visible artwork")
    inset = round(size * MENU_BAR_ICON_INSET)
    extent = size - 2 * inset
    glyph = alpha.crop(box).resize((extent, extent), Image.Resampling.LANCZOS)
    stencil = Image.new("RGBA", (extent, extent), (0, 0, 0, 255))
    stencil.putalpha(glyph)
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.alpha_composite(stencil, (inset, inset))
    return result


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = (
        ["/System/Library/Fonts/SFNS.ttf", "DejaVuSans-Bold.ttf"]
        if bold
        else ["/System/Library/Fonts/SFNS.ttf", "DejaVuSans.ttf"]
    )
    for name in names:
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def social_card() -> Image.Image:
    width, height = 1200, 630
    result = Image.new("RGBA", (width, height), (240, 239, 232, 255))
    draw = ImageDraw.Draw(result)
    draw.ellipse((-175, -190, 315, 300), fill=SECONDARY)
    draw.ellipse((825, -210, 1315, 280), fill=(255, 99, 55, 255))
    draw.polygon(((0, 480), (325, 480), (405, 630), (0, 630)), fill=(255, 99, 55, 255))
    draw.polygon(((1140, 390), (1200, 390), (1200, 630), (1060, 630)), fill=SECONDARY)
    draw.text((62, 145), "rally", font=font(210, bold=True), fill=DARK_CANVAS)
    draw.text((68, 376), "AI is multiplayer now.", font=font(38, bold=True), fill=DARK_CANVAS)
    points = []
    for step in range(241):
        angle = 2 * math.pi * step / 240
        denominator = 1 + math.sin(angle) ** 2
        x = 790 + 235 * math.cos(angle) / denominator
        y = 490 + 145 * math.sin(angle) * math.cos(angle) / denominator
        points.append((x, y))
    draw.line(points, fill=PRIMARY, width=42, joint="curve")
    draw.ellipse((620, 463, 674, 517), fill=PRIMARY)
    draw.ellipse((906, 463, 960, 517), fill=PRIMARY)
    return result


def save(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)


def save_social_card(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(path, format="JPEG", quality=88, optimize=True, progressive=True)


def generate_application_icon_previews() -> None:
    """Build compact Retina thumbnails without duplicating 1024px app assets in Vite."""
    for source_path in sorted(APPLICATION_ICON_DIRECTORY.glob("*.png")):
        with Image.open(source_path) as source:
            preview = source.convert("RGBA").resize((128, 128), Image.Resampling.LANCZOS)
            save(preview, APPLICATION_ICON_PREVIEW_DIRECTORY / source_path.name)


def main() -> None:
    transparent = mark(1024)
    generic_icon = app_icon(1024)
    dark_macos_icon = macos_app_icon(1024)
    save(transparent, ROOT / "assets" / "brand" / "rally-mark.png")
    save(transparent, ROOT / "apps" / "desktop" / "src" / "renderer" / "assets" / "rally-mark.png")
    save(transparent, ROOT / "apps" / "site" / "public" / "brand" / "rally-mark.png")
    save(generic_icon, ROOT / "apps" / "desktop" / "resources" / "icon.png")
    # User-selectable artwork stays full-bleed. The native build stages these
    # sources in a .icon package so Apple's actool owns the enclosure, masking,
    # and platform effects in the shipped ICNS renditions.
    save(app_icon(1024, LIGHT_CANVAS, DARK_CANVAS), APPLICATION_ICON_DIRECTORY / "light.png")
    save(app_icon(1024, DARK_CANVAS, PRIMARY), APPLICATION_ICON_DIRECTORY / "dark.png")
    # Icon Composer recolors this transparent mark for each appearance and
    # lets macOS own the enclosure. The separate ICNS is only the DMG volume
    # icon, whose legacy format still requires a baked silhouette.
    save(
        transparent,
        ROOT
        / "apps"
        / "desktop"
        / "resources"
        / "icon.icon"
        / "Assets"
        / "rally-mark.png",
    )
    save(dark_macos_icon, ROOT / "apps" / "desktop" / "resources" / "icon.icns")
    # `…Template` is what makes AppKit treat the file as a mask, and the `@2x`
    # sibling is how `nativeImage` finds the Retina rendition. Both names are
    # load-bearing; renaming either turns the menu bar item into a black square
    # on a dark menu bar.
    save(
        menu_bar_template_icon(MENU_BAR_ICON_POINT_SIZE),
        MENU_BAR_ICON_DIRECTORY / "rallyTemplate.png",
    )
    save(
        menu_bar_template_icon(MENU_BAR_ICON_POINT_SIZE * 2),
        MENU_BAR_ICON_DIRECTORY / "rallyTemplate@2x.png",
    )
    save(app_icon(64), ROOT / "apps" / "site" / "public" / "favicon.png")
    save(app_icon(180), ROOT / "apps" / "site" / "public" / "apple-touch-icon.png")
    social = social_card()
    save_social_card(social, ROOT / "apps" / "site" / "public" / "rally-social.jpg")
    save_social_card(social, ROOT / "apps" / "site" / "public" / "og-2026.jpg")
    generate_application_icon_previews()


if __name__ == "__main__":
    main()

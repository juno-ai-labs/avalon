#!/usr/bin/env python3
"""Generate Avalon web and Electron brand assets from the canonical alpha mask."""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "brand" / "avalon-mark-source.png"
APPLICATION_ICON_DIRECTORY = ROOT / "apps" / "desktop" / "resources" / "app-icons"
APPLICATION_ICON_PREVIEW_DIRECTORY = (
    ROOT / "apps" / "desktop" / "src" / "renderer" / "assets" / "app-icons"
)
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
    result = Image.new("RGBA", (width, height), DARK_CANVAS)
    draw = ImageDraw.Draw(result)
    draw.ellipse((930, -270, 1370, 170), fill=(71, 199, 252, 18))
    draw.ellipse((-220, 430, 220, 870), fill=(206, 220, 0, 18))
    logo = mark(300)
    result.alpha_composite(logo, (72, 165))
    draw.text((410, 206), "Avalon", font=font(90, bold=True), fill=(236, 235, 229, 255))
    draw.text((416, 318), "Work, still in context.", font=font(34), fill=(202, 201, 194, 255))
    draw.rounded_rectangle((416, 388, 510, 396), radius=4, fill=PRIMARY)
    draw.rounded_rectangle((518, 388, 560, 396), radius=4, fill=SECONDARY)
    return result


def save(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)


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
    save(transparent, ROOT / "assets" / "brand" / "avalon-mark.png")
    save(transparent, ROOT / "apps" / "desktop" / "src" / "renderer" / "assets" / "avalon-mark.png")
    save(transparent, ROOT / "apps" / "site" / "public" / "brand" / "avalon-mark.png")
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
        / "avalon-mark.png",
    )
    save(dark_macos_icon, ROOT / "apps" / "desktop" / "resources" / "icon.icns")
    save(app_icon(64), ROOT / "apps" / "site" / "public" / "favicon.png")
    save(app_icon(180), ROOT / "apps" / "site" / "public" / "apple-touch-icon.png")
    save(social_card(), ROOT / "apps" / "site" / "public" / "og.png")
    generate_application_icon_previews()


if __name__ == "__main__":
    main()

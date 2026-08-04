#!/usr/bin/env python3
"""Generate Avalon web and Electron brand assets from the canonical alpha mask."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "brand" / "avalon-mark-source.png"
PRIMARY = (206, 220, 0, 255)  # #CEDC00
SECONDARY = (71, 199, 252, 255)  # #47C7FC
DARK_CANVAS = (17, 18, 16, 255)  # #111210
LIGHT_CANVAS = (236, 235, 229, 255)  # #ECEBE5


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


def main() -> None:
    transparent = mark(1024)
    dark_icon = app_icon(1024)
    light_icon = app_icon(1024, LIGHT_CANVAS, DARK_CANVAS)
    save(transparent, ROOT / "assets" / "brand" / "avalon-mark.png")
    save(transparent, ROOT / "apps" / "desktop" / "src" / "renderer" / "assets" / "avalon-mark.png")
    save(transparent, ROOT / "apps" / "site" / "public" / "brand" / "avalon-mark.png")
    save(dark_icon, ROOT / "apps" / "desktop" / "resources" / "icon.png")
    # Keep the conventional icon.icns path as the static bundle fallback. The
    # named family below is copied into the bundle for appearance-aware Dock
    # rendering and leaves room for additional user-selectable families.
    save(dark_icon, ROOT / "apps" / "desktop" / "resources" / "icon.icns")
    save(
        light_icon,
        ROOT / "apps" / "desktop" / "resources" / "icons" / "avalon-light.icns",
    )
    save(
        dark_icon,
        ROOT / "apps" / "desktop" / "resources" / "icons" / "avalon-dark.icns",
    )
    save(app_icon(64), ROOT / "apps" / "site" / "public" / "favicon.png")
    save(app_icon(180), ROOT / "apps" / "site" / "public" / "apple-touch-icon.png")
    save(social_card(), ROOT / "apps" / "site" / "public" / "og.png")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Generate every icon and splash asset both apps need, from one definition.

Store assets are the part of shipping an app that quietly rots: a designer
hands over a PNG, it is resized by hand into eight sizes, and six months later
nobody knows which is canonical. So the mark is defined here as geometry, and
every asset is derived from it. Changing the brand is changing this file and
re-running it.

    python3 tools/brand/src/generate.py

Adaptive icons are drawn with the safe zone in mind: Android masks the outer
~27% of the foreground layer to whatever shape the launcher wants, so the mark
occupies the middle 60% and nothing important goes near an edge.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Brand:
    slug: str
    app_dir: Path
    background: tuple[int, int, int]
    mark: tuple[int, int, int]
    accent: tuple[int, int, int]
    #: True for the driver app, whose mark points the other way.
    driver: bool


BRANDS = [
    Brand(
        slug="rider",
        app_dir=ROOT / "apps" / "rider",
        background=(139, 47, 214),
        mark=(255, 255, 255),
        accent=(255, 214, 92),
        driver=False,
    ),
    Brand(
        slug="driver",
        app_dir=ROOT / "apps" / "driver",
        background=(12, 12, 15),
        mark=(255, 255, 255),
        accent=(139, 47, 214),
        driver=True,
    ),
]


def rounded_square(size: int, radius_ratio: float, fill) -> Image.Image:
    """A squircle-ish rounded square, used as the legacy icon shape."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = int(size * radius_ratio)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=fill)
    return image


def draw_mark(
    image: Image.Image,
    brand: Brand,
    box: tuple[float, float, float, float],
    hole_fill: tuple[int, int, int, int] | tuple[int, int, int] = (0, 0, 0, 0),
) -> None:
    """
    The mark: a stylised route with a pin at its end.

    A route is what both apps are about, and it reads at 48px in a way a
    wordmark never does. The same geometry serves both apps; what differs is
    which end is emphasised — a rider looks at where they are going, so the
    pin carries the accent; a driver looks at where they are, so the origin
    does. Reversing the path itself only made the pin collide with the curve.
    """
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = box
    width = right - left
    height = bottom - top

    # A gentle S-curve across the box, sampled as a polyline.
    points = []
    steps = 64
    for i in range(steps + 1):
        t = i / steps
        x = left + width * t
        # Two half-waves, so it reads as a road rather than an arc.
        y = top + height * (0.5 + 0.34 * math.sin(t * math.pi * 1.6 - math.pi * 0.55))
        points.append((x, y))

    stroke = max(3, int(width * 0.14))
    # Stamped as overlapping discs rather than a polyline: Pillow's line
    # joints leave anti-aliased seams on a curve, which are invisible at 48px
    # and obvious on a 1024px store asset.
    radius = stroke / 2
    for x, y in points:
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=brand.mark)

    start = points[0]
    end = points[-1]
    # The origin dot. On the driver app this is "you", so it takes the accent.
    cap = stroke * 0.62
    draw.ellipse(
        [start[0] - cap, start[1] - cap, start[0] + cap, start[1] + cap],
        fill=brand.accent if brand.driver else brand.mark,
    )

    # The pin sits above where the route ends, so the two shapes read as one
    # object rather than a blob.
    pin_color = brand.mark if brand.driver else brand.accent
    pin_radius = stroke * 1.25
    pin_center = (end[0], end[1] - pin_radius * 1.5)
    # Point first, so the head draws over its base.
    draw.polygon(
        [
            (pin_center[0] - pin_radius * 0.78, pin_center[1] + pin_radius * 0.34),
            (pin_center[0] + pin_radius * 0.78, pin_center[1] + pin_radius * 0.34),
            (pin_center[0], pin_center[1] + pin_radius * 2.1),
        ],
        fill=pin_color,
    )
    draw.ellipse(
        [
            pin_center[0] - pin_radius,
            pin_center[1] - pin_radius,
            pin_center[0] + pin_radius,
            pin_center[1] + pin_radius,
        ],
        fill=pin_color,
    )
    # The hole in the pin head. What shows through depends on what is behind
    # the mark, which only the caller knows — punching transparent on the
    # legacy icon would knock a hole through its own ground.
    hole = pin_radius * 0.40
    draw.ellipse(
        [
            pin_center[0] - hole,
            pin_center[1] - hole,
            pin_center[0] + hole,
            pin_center[1] + hole,
        ],
        fill=hole_fill,
    )


def app_icon(brand: Brand, size: int) -> Image.Image:
    """The legacy launcher icon: mark on the brand ground, rounded."""
    image = rounded_square(size, 0.22, brand.background)
    inset = size * 0.22
    draw_mark(
        image,
        brand,
        (inset, inset, size - inset, size - inset * 1.15),
        hole_fill=(*brand.background, 255),
    )
    return image


def adaptive_foreground(brand: Brand, size: int) -> Image.Image:
    """
    The adaptive-icon foreground layer.

    Transparent, with the mark inside the safe zone — Android crops the outer
    ~27% to whatever shape the launcher masks with.
    """
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inset = size * 0.30
    draw_mark(image, brand, (inset, inset, size - inset, size - inset * 1.1))
    return image


def splash(brand: Brand, size: int = 1284) -> Image.Image:
    """A square splash image; Expo centres it on the brand background."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inset = size * 0.30
    draw_mark(image, brand, (inset, inset, size - inset, size - inset * 1.1))
    return image


def feature_graphic(brand: Brand, name: str) -> Image.Image:
    """
    The Play Store feature graphic: exactly 1024×500, no transparency.
    """
    image = Image.new("RGB", (1024, 500), brand.background)
    layer = Image.new("RGBA", (1024, 500), (0, 0, 0, 0))
    # Inset from the right edge so the pin — which sits above the route — is
    # not clipped by the fixed 1024×500 canvas.
    draw_mark(layer, brand, (540, 150, 880, 400), hole_fill=(*brand.background, 255))
    image.paste(layer, (0, 0), layer)

    draw = ImageDraw.Draw(image)
    # A wordmark drawn as blocks rather than text: no font file to ship, and
    # it survives any locale.
    x, y = 72, 210
    for index, width in enumerate((150, 96, 210)):
        draw.rounded_rectangle(
            [x, y + index * 34, x + width, y + index * 34 + 20],
            radius=10,
            fill=brand.accent if index == 0 else brand.mark,
        )
    return image


def write(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    print(f"  {path.relative_to(ROOT)}")


def main() -> None:
    for brand in BRANDS:
        print(f"{brand.slug}:")
        assets = brand.app_dir / "assets"

        write(app_icon(brand, 1024), assets / "icon.png")
        write(adaptive_foreground(brand, 1024), assets / "adaptive-icon.png")
        write(splash(brand), assets / "splash.png")
        # The web favicon, and the notification icon Android wants monochrome.
        write(app_icon(brand, 48), assets / "favicon.png")

        store = ROOT / "docs" / "store" / brand.slug
        # Play requires exactly 512×512 for the listing icon.
        write(app_icon(brand, 512), store / "play-icon-512.png")
        write(feature_graphic(brand, brand.slug), store / "play-feature-graphic.png")

    print("\nDone. Re-run after changing any brand colour or the mark itself.")


if __name__ == "__main__":
    main()

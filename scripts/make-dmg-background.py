#!/usr/bin/env python3
"""Renders the drag-to-Applications DMG background used by build-v2-app.sh.

Writes assets/dmg/background.png (660x400) and background@2x.png (1320x800);
build-v2-app.sh combines them into a Retina-aware background.tiff. Icon
positions here must stay in sync with ICON_X/APPS_X/ICON_Y in that script.
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 660, 400
ICON_X, APPS_X, ICON_Y = 180, 480, 228

TOP = (252, 251, 246)
BOTTOM = (238, 237, 226)
TITLE = (48, 61, 14)
SUBTITLE = (109, 116, 88)
ARROW = (139, 150, 105)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "dmg")


def font(size, bold=False):
    for path, variation in (
        ("/System/Library/Fonts/SFNS.ttf", b"Bold" if bold else b"Regular"),
        ("/System/Library/Fonts/HelveticaNeue.ttc", None),
    ):
        if not os.path.exists(path):
            continue
        f = ImageFont.truetype(path, size)
        if variation:
            try:
                f.set_variation_by_name(variation)
            except Exception:
                pass
        return f
    return ImageFont.load_default()


def centered(draw, text, f, cx, top, fill):
    left, up, right, _ = draw.textbbox((0, 0), text, font=f)
    draw.text((cx - (right - left) / 2 - left, top - up), text, font=f, fill=fill)


def render(scale):
    # Supersample by 2 so the arrow's diagonals stay clean after downsampling.
    s = scale * 2
    img = Image.new("RGB", (W * s, H * s), TOP)
    draw = ImageDraw.Draw(img)

    for y in range(H * s):
        t = y / (H * s - 1)
        draw.line(
            [(0, y), (W * s, y)],
            fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)),
        )

    # Arrow: shaft plus a chevron head, spanning the gap between the two icons.
    y = ICON_Y * s
    x0, x1 = 276 * s, 392 * s
    head = 20 * s
    draw.line([(x0, y), (x1 - head * 0.55, y)], fill=ARROW, width=round(4 * s))
    draw.polygon(
        [(x1, y), (x1 - head, y - head * 0.62), (x1 - head, y + head * 0.62)],
        fill=ARROW,
    )

    centered(draw, "Install Token Widget", font(27 * s, bold=True), W * s / 2, 58 * s, TITLE)
    centered(
        draw,
        "Drag Token Widget to the Applications folder",
        font(14 * s),
        W * s / 2,
        99 * s,
        SUBTITLE,
    )

    return img.resize((W * scale, H * scale), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    render(1).save(os.path.join(OUT, "background.png"))
    render(2).save(os.path.join(OUT, "background@2x.png"))
    print("wrote", OUT)


if __name__ == "__main__":
    main()

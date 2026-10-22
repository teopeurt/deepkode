#!/usr/bin/env python3
"""Helmsman icon PNG generator.

The geometry matches web/public/favicon.svg exactly (the vector master is the SVG; this script only rasterizes it).
Downsamples a 512px supersampled master with LANCZOS to each target size, keeping small sizes crisp.

Usage: python3 web/scripts/gen-icons.py
Output: web/public/favicon-16x16.png / favicon-32x32.png / apple-touch-icon.png /
      android-chrome-192x192.png / android-chrome-512x512.png
"""
import math
import os
from PIL import Image, ImageDraw

BASE = 512      # side length of the supersampled master
S = 8.0         # scale from the 64-unit design grid -> master pixels
OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "public"))

BG_TOP = (0x18, 0x26, 0x42)   # gradient top (deep sea)
BG_BOT = (0x0B, 0x12, 0x20)   # gradient bottom (abyss)
LIGHT = (0xDC, 0xE6, 0xF5)    # wheel body (Night Voyage text color)
BLUE = (0x6C, 0xB0, 0xF5)     # hub (abyss blue)
LIGHT_A = LIGHT + (235,)      # stroke-opacity 0.92

SIZES = {
    "favicon-16x16.png": 16,
    "favicon-32x32.png": 32,
    "apple-touch-icon.png": 180,
    "android-chrome-192x192.png": 192,
    "android-chrome-512x512.png": 512,
}


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def c(x, y):
    return int(x * S), int(y * S)


def r(v):
    return int(v * S)


def render_master():
    # 1) Vertical-gradient rounded square
    grad = Image.new("RGB", (BASE, BASE))
    gd = ImageDraw.Draw(grad)
    for y in range(BASE):
        t = y / (BASE - 1)
        gd.line([(0, y), (BASE, y)], fill=lerp(BG_TOP, BG_BOT, t))
    mask = Image.new("L", (BASE, BASE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, BASE - 1, BASE - 1], radius=r(14), fill=255)
    img = Image.composite(grad.convert("RGBA"), Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0)), mask)

    d = ImageDraw.Draw(img)

    # 2) Wheel rim (the SVG stroke is centered on r=18.5, width 3 -> 17..20;
    #    PIL's ellipse outline strokes inward from the bbox radius, so the bbox radius is 18.5+1.5=20)
    d.ellipse([c(32 - 20, 32 - 20), c(32 + 20, 32 + 20)], outline=LIGHT_A, width=r(3))

    # 3) 8 spokes (r=6 -> r=17, width 3 with round caps = a radius-1.5 circle added at each end)
    for deg in range(0, 360, 45):
        rad = math.radians(deg)
        p1 = (32 + 6.0 * math.cos(rad), 32 + 6.0 * math.sin(rad))
        p2 = (32 + 17.0 * math.cos(rad), 32 + 17.0 * math.sin(rad))
        d.line([c(*p1), c(*p2)], fill=LIGHT_A, width=r(3))
        for (x, y) in (p1, p2):
            d.ellipse([c(x - 1.5, y - 1.5), c(x + 1.5, y + 1.5)], fill=LIGHT_A)

    # 4) 8 handle knobs (r=21.5, radius 2.4)
    for deg in range(0, 360, 45):
        rad = math.radians(deg)
        x, y = 32 + 21.5 * math.cos(rad), 32 + 21.5 * math.sin(rad)
        d.ellipse([c(x - 2.4, y - 2.4), c(x + 2.4, y + 2.4)], fill=LIGHT_A)

    # 5) Hub + blue axle
    d.ellipse([c(32 - 5.5, 32 - 5.5), c(32 + 5.5, 32 + 5.5)], fill=LIGHT)
    d.ellipse([c(32 - 2.2, 32 - 2.2), c(32 + 2.2, 32 + 2.2)], fill=BLUE)

    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    master = render_master()
    for name, size in SIZES.items():
        out = os.path.join(OUT, name)
        master.resize((size, size), Image.LANCZOS).save(out)
        print(f"  {name}  {size}x{size}")


if __name__ == "__main__":
    main()

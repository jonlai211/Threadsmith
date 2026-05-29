"""
Generate Threadsmith Chrome extension icons.
Outputs icons/icon16.png, icons/icon48.png, icons/icon128.png.
"""

import os
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Brand colours
C1 = (16, 185, 129)    # #10b981  emerald
C2 = (99, 102, 241)    # #6366f1  indigo

FONT_PATHS = [
    r"C:\Windows\Fonts\seguibl.ttf",    # Segoe UI Black
    r"C:\Windows\Fonts\arialbd.ttf",    # Arial Bold
    r"C:\Windows\Fonts\calibrib.ttf",   # Calibri Bold
    r"C:\Windows\Fonts\segoeui.ttf",    # Segoe UI (fallback)
]


def load_font(size):
    for p in FONT_PATHS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_gradient(size):
    """135° diagonal gradient from C1 (top-left) to C2 (bottom-right)."""
    x = np.linspace(0, 1, size)
    y = np.linspace(0, 1, size)
    xx, yy = np.meshgrid(x, y)
    t = np.clip((xx + yy) / 2, 0, 1)   # 0 = top-left corner, 1 = bottom-right

    r = (C1[0] + (C2[0] - C1[0]) * t).astype(np.uint8)
    g = (C1[1] + (C2[1] - C1[1]) * t).astype(np.uint8)
    b = (C1[2] + (C2[2] - C1[2]) * t).astype(np.uint8)
    a = np.full((size, size), 255, dtype=np.uint8)

    return Image.fromarray(np.stack([r, g, b, a], axis=2), "RGBA")


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def add_gloss(img, size):
    """Subtle top-left highlight to give depth."""
    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(gloss)
    # soft ellipse in the top-left quadrant
    r = int(size * 0.6)
    d.ellipse([-r // 3, -r // 3, r, r], fill=(255, 255, 255, 26))
    img = Image.alpha_composite(img, gloss)
    return img


def draw_letter_T(img, size):
    """Draw a bold white 'T' centred on the icon."""
    # font size tuned to fill ~55% of the icon height
    font_size = max(8, int(size * 0.56))
    font = load_font(font_size)

    # Measure on a scratch canvas
    scratch = ImageDraw.Draw(Image.new("RGBA", (size * 4, size * 4)))
    bbox = scratch.textbbox((0, 0), "T", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    # Centre (nudge up very slightly for optical balance)
    tx = (size - tw) / 2 - bbox[0]
    ty = (size - th) / 2 - bbox[1] - size * 0.03

    d = ImageDraw.Draw(img)

    # Soft drop-shadow pass
    shadow_offset = max(1, size // 32)
    d.text(
        (tx + shadow_offset, ty + shadow_offset),
        "T",
        font=font,
        fill=(0, 0, 0, 60),
    )

    # Main white letter
    d.text((tx, ty), "T", font=font, fill=(255, 255, 255, 245))

    return img


def make_icon(size):
    # Corner radius: 22.5% (matches CSS border-radius 7px on 32px → ~22%)
    radius = max(2, int(size * 0.225))

    # 1. Gradient background
    img = make_gradient(size)

    # 2. Apply rounded-rect clipping mask
    img.putalpha(rounded_mask(size, radius))

    # 3. Subtle gloss
    if size >= 48:
        img = add_gloss(img, size)

    # 4. 'T' lettermark
    img = draw_letter_T(img, size)

    return img


SIZES = [16, 32, 48, 128]

for s in SIZES:
    icon = make_icon(s)
    out = os.path.join(OUTPUT_DIR, f"icon{s}.png")
    icon.save(out, optimize=True)
    print(f"  OK  {out}  ({s}x{s})")

print("\nAll icons written to icons/")

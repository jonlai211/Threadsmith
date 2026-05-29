"""
Resize icons/source.png into the Chrome extension icon sizes.

Outputs:
  icons/icon16.png
  icons/icon32.png
  icons/icon48.png
  icons/icon128.png
"""

import os
from PIL import Image

ICONS_DIR = os.path.join(os.path.dirname(__file__), "icons")
SOURCE = os.path.join(ICONS_DIR, "source.png")
SIZES = [16, 32, 48, 128]


def main():
    if not os.path.exists(SOURCE):
        raise SystemExit(f"Missing source image: {SOURCE}")

    src = Image.open(SOURCE).convert("RGBA")
    print(f"Source: {SOURCE}  ({src.size[0]}x{src.size[1]})")

    for size in SIZES:
        out = os.path.join(ICONS_DIR, f"icon{size}.png")
        src.resize((size, size), Image.LANCZOS).save(out, optimize=True)
        print(f"  OK  {out}  ({size}x{size})")


if __name__ == "__main__":
    main()

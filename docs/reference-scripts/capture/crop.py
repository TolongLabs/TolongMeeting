"""Crop watcher frames to the shared-screen area: crop.py SRC_DIR OUT_DIR [--webp]

The share sits left of the chat panel and below the thumbnail strip on a near-black canvas,
so its box is the span of rows/columns that carry enough non-dark pixels.
"""
import os
import sys

from PIL import Image

REGION = (0, 290, 1410, 962)  # x0, y0, x1, y1: below the "You are viewing" bar, left of chat
DARK = 40          # luminance below this is canvas
MIN_FRACTION = 0.04


def span(values, n):
    hits = [i for i, v in enumerate(values) if v / n >= MIN_FRACTION]
    return (hits[0], hits[-1] + 1) if hits else (0, len(values))


def autocrop(img):
    reg = img.crop(REGION).convert("L")
    w, h = reg.size
    px = reg.load()
    cols = [sum(px[x, y] > DARK for y in range(0, h, 2)) for x in range(w)]
    rows = [sum(px[x, y] > DARK for x in range(0, w, 2)) for y in range(h)]
    x0, x1 = span(cols, h / 2)
    y0, y1 = span(rows, w / 2)
    return img.crop((REGION[0] + x0, REGION[1] + y0, REGION[0] + x1, REGION[1] + y1))


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    webp = "--webp" in sys.argv
    os.makedirs(out, exist_ok=True)
    for n in sorted(os.listdir(src)):
        if not n.endswith(".png"):
            continue
        im = autocrop(Image.open(os.path.join(src, n)).convert("RGB"))
        dst = os.path.join(out, n[:-4] + (".webp" if webp else ".png"))
        im.save(dst, quality=90) if webp else im.save(dst)
        print(n, im.size)

"""Tile frames into labelled 3x2 sheets: grid.py FRAME_DIR STEP_SECONDS OUT_PREFIX"""
import os
import sys

from PIL import Image, ImageDraw

d, step, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
files = sorted(f for f in os.listdir(d) if f.endswith(".jpg"))
for s in range(0, len(files), 6):
    tiles = [Image.open(os.path.join(d, f)) for f in files[s:s + 6]]
    w, h = tiles[0].size
    sheet = Image.new("RGB", (w * 2, h * 3), "white")
    for i, t in enumerate(tiles):
        x, y = (i % 2) * w, (i // 2) * h
        sheet.paste(t, (x, y))
        sec = (s + i) * step + step / 2
        ImageDraw.Draw(sheet).rectangle([x, y, x + 70, y + 22], fill="black")
        ImageDraw.Draw(sheet).text((x + 5, y + 5), f"{int(sec // 60)}:{int(sec % 60):02d}", fill="yellow")
    sheet.save(f"{out}_{s // 6 + 1}.jpg", quality=80)
    print(f"{out}_{s // 6 + 1}.jpg")

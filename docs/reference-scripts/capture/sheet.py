"""Contact sheet of watcher keyframes: sheet.py FRAMES_DIR OUT.jpg [first_index] [count]"""
import os
import sys

from PIL import Image, ImageDraw

src, out = sys.argv[1], sys.argv[2]
first = int(sys.argv[3]) if len(sys.argv) > 3 else 1
count = int(sys.argv[4]) if len(sys.argv) > 4 else 12
names = sorted(n for n in os.listdir(src) if n.endswith(".png") and int(n[:3]) >= first)[:count]
tw, th, cols = 480, 270, 3
rows = max(1, (len(names) + cols - 1) // cols)
sheet = Image.new("RGB", (tw * cols, (th + 18) * rows), "white")
draw = ImageDraw.Draw(sheet)
for i, n in enumerate(names):
    im = Image.open(os.path.join(src, n)).convert("RGB")
    im.thumbnail((tw, th))
    x, y = (i % cols) * tw, (i // cols) * (th + 18)
    sheet.paste(im, (x, y + 18))
    draw.text((x + 4, y + 2), n, fill="black")
sheet.save(out, quality=80)
print(out, len(names), "frames")

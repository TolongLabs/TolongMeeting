"""Dump text per page and render pages to PNG: pdf_dump.py SRC_DIR OUT_DIR"""
import os
import sys

import pymupdf

src, out = sys.argv[1], sys.argv[2]
for name in sorted(os.listdir(src)):
    if not name.endswith(".pdf"):
        continue
    stem = name[:-4]
    doc = pymupdf.open(os.path.join(src, name))
    os.makedirs(os.path.join(out, stem), exist_ok=True)
    with open(os.path.join(out, stem + ".txt"), "w", encoding="utf-8") as f:
        for i, page in enumerate(doc, 1):
            f.write(f"\n===== page {i} =====\n{page.get_text()}")
            page.get_pixmap(dpi=90).save(os.path.join(out, stem, f"{i:02d}.png"))
    words = sum(len(p.get_text().split()) for p in doc)
    print(f"{stem}: {doc.page_count} pages, {words} words, size {doc[0].rect.width:.0f}x{doc[0].rect.height:.0f}pt")

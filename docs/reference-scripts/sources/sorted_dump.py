"""Dump PDF text with position sorting (blocks top-to-bottom, left-to-right): sorted_dump.py PDF OUT_TXT"""
import sys
import pymupdf
doc = pymupdf.open(sys.argv[1])
with open(sys.argv[2], "w", encoding="utf-8") as f:
    for i, page in enumerate(doc, 1):
        f.write(f"\n===== page {i} =====\n{page.get_text(sort=True)}")

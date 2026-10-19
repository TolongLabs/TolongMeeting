"""Order-independent check: word-count differences between PDF dump and Markdown, plus PDF metadata
and per-page word counts. Usage: python bagdiff.py PDF PDF_TXT MD_FILE"""
import re
import sys
from collections import Counter

import pymupdf

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from mddiff import load_md, load_pdf  # noqa: E402

pdf, txt, md = sys.argv[1:4]
doc = pymupdf.open(pdf)
print("metadata:", doc.metadata)
print("pages:", doc.page_count)
counts = [len(p.get_text().split()) for p in doc]
print("words/page:", counts)
print("images/page:", [len(p.get_images()) for p in doc])
raw = open(txt, encoding="utf-8").read()
for pat in [r"(?i)version", r"(?i)updated", r"(?i)effective", r"(?i)dated", r"(?i)revis", r"(?i)\bv\d", r"(?i)last"]:
    for m in re.finditer(pat, raw):
        print("hit", pat, "::", raw[max(0, m.start() - 60):m.end() + 60].replace("\n", " | "))
a, b = Counter(load_md(md)), Counter(load_pdf(txt))
print("\nin MD not PDF (count diff):", sorted((a - b).items()))
print("\nin PDF not MD (count diff):", sorted((b - a).items()))

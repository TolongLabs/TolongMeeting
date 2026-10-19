"""Word-level diff of a PDF text dump vs a cleaned Markdown file, after normalisation.

Usage: python mddiff.py PDF_TXT MD_FILE
Prints each non-equal opcode with context; marks chunks whose text also appears
elsewhere in the other document as MOVED (layout scrambling, not a real change).
"""
import difflib
import re
import sys


def norm_words(text):
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    text = re.sub(r"https?://\S+", " ", text)
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text.split()


def load_pdf(path):
    raw = open(path, encoding="utf-8").read()
    raw = re.sub(r"===== page \d+ =====", " ", raw)
    # join words hyphenated across line breaks: "sponsor-\nprovided" -> "sponsor-provided"
    raw = re.sub(r"(\w)-[ \t]*\n[ \t]*(\w)", r"\1-\2", raw)
    lines = [ln for ln in raw.splitlines() if not re.fullmatch(r"\s*\d{1,3}\s*", ln)]
    return norm_words("\n".join(lines))


def load_md(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    out, in_contents = [], False
    for ln in lines:
        if ln.startswith("Contents:"):
            in_contents = True
            continue
        if in_contents:
            if ln.startswith("## "):
                in_contents = False
            else:
                continue
        if ln.startswith("## See also"):
            break
        if re.fullmatch(r"\|[\s\-|]+\|", ln):
            continue
        ln = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", ln)
        out.append(ln)
    # drop H1 + intro (first two non-empty lines)
    body = "\n".join(out)
    first_h2 = body.find("\n## ")
    return norm_words(body[first_h2:])


def main():
    a = load_md(sys.argv[2])
    b = load_pdf(sys.argv[1])
    sa, sb = " ".join(a), " ".join(b)
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    print(f"md words {len(a)}, pdf words {len(b)}, ratio {sm.ratio():.4f}")
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        da, db = " ".join(a[i1:i2]), " ".join(b[j1:j2])
        moved = ""
        if da and len(a[i1:i2]) >= 3 and da in sb:
            moved += " [MD-chunk found elsewhere in PDF]"
        if db and len(b[j1:j2]) >= 3 and db in sa:
            moved += " [PDF-chunk found elsewhere in MD]"
        ctx = " ".join(a[max(0, i1 - 8):i1])
        print(f"\n--- {tag}{moved}  ctx: ...{ctx}")
        if da:
            print(f"  MD : {da[:600]}")
        if db:
            print(f"  PDF: {db[:600]}")


if __name__ == "__main__":
    main()

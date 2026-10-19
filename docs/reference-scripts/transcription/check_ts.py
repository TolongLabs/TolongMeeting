"""For each **[HH:MM:SS] Speaker:** paragraph, find the medium segment that best matches its opening words
within +/-90 s and report paragraphs whose stamp is more than 4 s off. Args: transcript.md medium.json"""
import difflib
import json
import re
import sys

md, js = sys.argv[1], sys.argv[2]
segs = json.load(open(js, encoding="utf-8"))["segments"]


def sec(h):
    a = [int(x) for x in h.split(":")]
    return a[0] * 3600 + a[1] * 60 + a[2]


def ts(t):
    t = int(t)
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def norm(s):
    return re.sub(r"[^a-z ]", "", s.lower())


for m in re.finditer(r"^\*\*\[(\d\d:\d\d:\d\d)\] ([^:]+):\*\* (.+)$", open(md, encoding="utf-8").read(), flags=re.M):
    stamp, who, text = sec(m.group(1)), m.group(2), m.group(3)
    head = norm(" ".join(text.split()[:7]))
    best, score = None, 0
    for s in segs:
        if abs(s["start"] - stamp) > 90:
            continue
        words = norm(s["text"]).split()
        for i in range(max(1, len(words))):
            r = difflib.SequenceMatcher(None, head, " ".join(words[i:i + 7])).ratio()
            if r > score:
                best, score = s["start"] + (s["end"] - s["start"]) * i / max(1, len(words)), r
    flag = "" if best is not None and abs(best - stamp) <= 4 else "  <<"
    if flag or score < 0.6:
        print(f"{m.group(1)} {who[:14]:14} best={ts(best) if best is not None else '-'} score={score:.2f}{flag} | {text[:50]}")

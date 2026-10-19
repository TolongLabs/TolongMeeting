"""Side-by-side: Whisper medium paragraphs (timestamped) vs gpt-4o-transcribe text, per 3-minute window.

Args: OUT.md WHISPER_MEDIUM.json CHUNK_DIR (the directory run.sh wrote chunk_NN.json into)."""
import json
import os
import sys

segs = json.load(open(sys.argv[2]))["segments"]


def ts(t):
    t = int(t)
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def paragraphs(items):
    paras, cur, last = [], None, None
    for s in items:
        if cur is None or s["start"] - last > 1.2 or len(cur[1]) > 400:
            cur = [s["start"], ""]
            paras.append(cur)
        cur[1] += " " + s["text"].strip()
        last = s["end"]
    return "\n".join(f"[{ts(p[0])}]{p[1]}" for p in paras)


out = []
for i in range(30):
    a, b = i * 180, (i + 1) * 180
    window = [s for s in segs if a <= s["start"] < b]
    other = json.load(open(os.path.join(sys.argv[3], f"chunk_{i:02d}.json")))["text"]
    out.append(f"### W{i:02d} {ts(a)}-{ts(b)}\nM:\n{paragraphs(window)}\nO: {other}\n")
out.append("### after 01:30:00 (medium only)\n" + paragraphs([s for s in segs if s["start"] >= 5400]))
open(sys.argv[1], "w").write("\n".join(out))
print(sum(len(x) for x in out), "chars")

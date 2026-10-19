"""Print whisper-1 verbose_json segments from stdin as [HH:MM:SS] text, offset by argv[1] seconds."""
import json
import sys

off = float(sys.argv[1])
d = json.load(sys.stdin)


def ts(t):
    t = int(off + t)
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


segs = d.get("segments")
print(" | ".join(f"[{ts(s['start'])}] {s['text'].strip()}" for s in segs) if segs else d)

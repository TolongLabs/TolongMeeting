"""Meeting watcher: keyframes slide changes from OBS, tracks the meeting window, stops recording at the end.

  watch.py --title "Meeting topic" --out DIR [--stop-after 21:30] [--hard-stop 23:30]

One event per stdout line (also appended to DIR/watch.log):
  SLIDES +k (total n)       batched at most every 3 min
  ALERT ...                 needs attention (meeting window gone early, recording inactive)
  ENDED ...                 meeting over, recording stopped; process exits
  HEARTBEAT ...             every 10 min
  ERROR ...
"""
import argparse
import base64
import datetime as dt
import io
import os
import sys
import time

from PIL import Image, ImageChops, ImageStat

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "desktop"))  # packaged layout: wins.py
from obs_setup import client  # noqa: E402
from wins import windows  # noqa: E402

CHANGE = 7.0      # mean abs diff (0-255) vs last kept frame that counts as a new scene
STABLE = 2.0      # max diff vs the previous sample for the new scene to count as settled
HASH_DUP = 12     # dhash hamming distance under which a frame repeats an earlier keyframe
DIFF_WIDTH = 0.74  # compare only the left part of the frame: the chat panel lives on the right


def now():
    return dt.datetime.now()


def emit(log, msg):
    line = f"{now():%H:%M:%S} {msg}"
    print(line, flush=True)
    with open(log, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def grab(cl):
    r = cl.get_source_screenshot("Scene", "png", 1920, 1080, -1)
    return Image.open(io.BytesIO(base64.b64decode(r.image_data.split(",", 1)[1]))).convert("RGB")


def thumb(img):
    w, h = img.size
    return img.crop((0, 0, int(w * DIFF_WIDTH), h)).convert("L").resize((128, 72))


def diff(a, b):
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]


def dhash(img):
    g = img.crop((0, 0, int(img.width * DIFF_WIDTH), img.height)).convert("L").resize((17, 16))
    px = list(g.getdata())
    return sum(1 << i for i in range(256) if px[(i // 16) * 17 + i % 16] > px[(i // 16) * 17 + i % 16 + 1])


def meeting_present(title):
    return any(title.lower() in w["title"].lower() for w in windows("chrome.exe"))


def at(hhmm):
    h, m = map(int, hhmm.split(":"))
    return now().replace(hour=h, minute=m, second=0, microsecond=0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--stop-after", default="21:30")
    ap.add_argument("--hard-stop", default="23:30")
    a = ap.parse_args()
    frames = os.path.join(a.out, "frames")
    os.makedirs(frames, exist_ok=True)
    log = os.path.join(a.out, "watch.log")
    stop_after, hard_stop = at(a.stop_after), at(a.hard_stop)

    cl = client()
    emit(log, f"START title={a.title!r} stop_after={a.stop_after} hard_stop={a.hard_stop}")
    kept_thumb, prev_thumb, hashes = None, None, []
    total, batch, last_batch, last_beat, last_latest = 0, 0, time.time(), time.time(), 0.0
    absent_since, alerted_absent, alerted_rec = None, False, False

    while True:
        try:
            rec = cl.get_record_status()
            tc = rec.output_timecode.split(".")[0] if rec.output_active else "--:--:--"

            # meeting window
            if meeting_present(a.title):
                absent_since, alerted_absent = None, False
            else:
                absent_since = absent_since or time.time()
                gone = time.time() - absent_since
                if gone >= 60 and now() >= stop_after:
                    path = cl.stop_record().output_path if rec.output_active else "(not recording)"
                    emit(log, f"ENDED meeting window gone {int(gone)}s after {a.stop_after}; recording stopped: {path}")
                    return
                if gone >= 60 and not alerted_absent:
                    emit(log, f"ALERT meeting window ({a.title!r}) gone for {int(gone)}s before {a.stop_after} at rec {tc}")
                    alerted_absent = True
            if now() >= hard_stop:
                path = cl.stop_record().output_path if rec.output_active else "(not recording)"
                emit(log, f"ENDED hard stop {a.hard_stop}; recording stopped: {path}")
                return

            if not rec.output_active and not alerted_rec:
                emit(log, "ALERT recording is not active")
                alerted_rec = True
            elif rec.output_active:
                alerted_rec = False

            # keyframes
            img = grab(cl)
            t = thumb(img)
            if time.time() - last_latest >= 30:
                img.save(os.path.join(a.out, "latest.jpg"), quality=85)
                last_latest = time.time()
            settled = prev_thumb is not None and diff(t, prev_thumb) <= STABLE
            changed = kept_thumb is None or diff(t, kept_thumb) >= CHANGE
            if settled and changed:
                h = dhash(img)
                if all(bin(h ^ o).count("1") > HASH_DUP for o in hashes):
                    total += 1
                    batch += 1
                    name = f"{total:03d}_{now():%H%M%S}_rec{tc.replace(':', '')}.png"
                    img.save(os.path.join(frames, name))
                    hashes.append(h)
                kept_thumb = t
            prev_thumb = t

            if batch and time.time() - last_batch >= 180:
                emit(log, f"SLIDES +{batch} (total {total}) rec {tc}")
                batch, last_batch = 0, time.time()
            if time.time() - last_beat >= 600:
                emit(log, f"HEARTBEAT rec {tc} frames {total} meeting_present={absent_since is None}")
                last_beat = time.time()
        except Exception as e:  # OBS hiccup: report and reconnect
            emit(log, f"ERROR {type(e).__name__}: {e}")
            time.sleep(5)
            try:
                cl = client()
            except Exception:
                pass
        time.sleep(2)


if __name__ == "__main__":
    main()

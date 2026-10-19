"""Download link-shared Drive files: drive_get.py OUT_DIR id=name ..."""
import os
import sys
import urllib.request

out = sys.argv[1]
for arg in sys.argv[2:]:
    fid, name = arg.split("=", 1)
    dst = os.path.join(out, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        print("skip", name); continue
    url = f"https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dst + ".part", "wb") as f:
        ctype = r.headers.get("Content-Type", "")
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(dst + ".part", dst)
    print(f"{name}\t{os.path.getsize(dst):,} bytes\t{ctype}", flush=True)

"""Recursively list a link-shared Drive folder via embeddedfolderview. Prints depth, kind, id, name."""
import html
import re
import sys
import urllib.request

UA = {"User-Agent": "Mozilla/5.0"}


def entries(folder_id):
    url = f"https://drive.google.com/embeddedfolderview?id={folder_id}#list"
    page = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "replace")
    for m in re.finditer(r'<a href="([^"]+)"[^>]*>.*?<div class="flip-entry-title">(.*?)</div>', page, flags=re.S):
        href, name = html.unescape(m.group(1)), html.unescape(m.group(2)).strip()
        fm = re.search(r"/folders/([\w-]+)", href)
        im = re.search(r"/d/([\w-]+)", href) or re.search(r"[?&]id=([\w-]+)", href)
        yield ("folder", fm.group(1), name) if fm else ("file", im.group(1) if im else href, name)


def walk(folder_id, depth=0):
    for kind, fid, name in entries(folder_id):
        print(f"{'  ' * depth}{kind}\t{fid}\t{name}")
        if kind == "folder":
            walk(fid, depth + 1)


walk(sys.argv[1])

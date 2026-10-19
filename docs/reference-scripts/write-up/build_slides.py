"""Build slides.md: header, intro, contents (GitHub anchors) and the transcribed slide body."""
import re
import sys

body_path, out_path = sys.argv[1], sys.argv[2]
body = open(body_path, encoding="utf-8").read().strip() + "\n"

INTRO = """# Opening briefing slides

Every slide shown during the SDC Hackathon 2026 online orientation, the opening ceremony and preliminary round briefing held on Zoom on 19 October 2026, each with its image and its text. The [transcript](transcript.md) covers what was said and the [meeting chat](chat.md) what attendees typed.

Slides were captured from the screen share whenever it changed, including stills from the organisers' tutorial videos. Sponsor slides shown from about 8:09 PM to 8:16 PM, between slides 07 and 08, are missing because the capture lost the screen share; what was said then, including RunPod's introduction, is in the transcript from 00:20:20 to 00:26:50. [covered] marks text hidden behind a video callout, a cursor or a name label.

Contents:

"""


def slug(heading):
    s = heading.strip().lower()
    s = re.sub(r"[^\w\- ]", "", s)
    return s.replace(" ", "-")


titles = re.findall(r"^## (Slide \d\d: .+)$", body, flags=re.M)
contents = "".join(f"1.  [{t}](#{slug(t)})\n" for t in titles)
open(out_path, "w", encoding="utf-8", newline="\n").write(INTRO + contents + "\n" + body)
print(len(titles), "slides")

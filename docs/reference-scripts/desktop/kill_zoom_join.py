"""For N seconds, close any Zoom desktop join/name dialog (WM_CLOSE, no focus needed)."""
import ctypes
import sys
import time

from wins import windows

user32 = ctypes.windll.user32
WM_CLOSE = 0x0010
deadline = time.time() + int(sys.argv[1] if len(sys.argv) > 1 else 30)
while time.time() < deadline:
    for w in windows("Zoom.exe"):
        if w["class"] in ("zWaitingMeetingIDWndClass", "ZPConfJoinWndClass") or w["class"].startswith("zWaiting"):
            user32.PostMessageW(w["hwnd"], WM_CLOSE, 0, 0)
            print("closed", w["class"], w["title"], flush=True)
        elif w["class"] == "ZPPTEnhanceLoginMainWindowClassEx" and not w["minimized"]:
            user32.ShowWindow(w["hwnd"], 7)  # SW_SHOWMINNOACTIVE: out of the way, focus untouched
            print("minimized", w["class"], flush=True)
    time.sleep(0.2)

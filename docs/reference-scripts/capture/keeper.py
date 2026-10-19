"""Keep the meeting's Chrome window un-minimized: restore it unfocused at the back of the z-order.

  keeper.py "WINDOW TITLE SUBSTRING" LOGFILE X Y W H
"""
import ctypes
import ctypes.wintypes as wt
import datetime as dt
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "desktop"))  # packaged layout: wins.py
from wins import windows  # noqa: E402

ctypes.windll.shcore.SetProcessDpiAwareness(2)
u = ctypes.windll.user32


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [("length", wt.UINT), ("flags", wt.UINT), ("showCmd", wt.UINT),
                ("ptMinPosition", wt.POINT), ("ptMaxPosition", wt.POINT), ("rcNormalPosition", wt.RECT)]


title, log = sys.argv[1], sys.argv[2]
x, y, w, h = map(int, sys.argv[3:7])
while True:
    for win in windows("chrome.exe"):
        if title in win["title"] and win["minimized"]:
            fg = u.GetForegroundWindow()
            wp = WINDOWPLACEMENT()
            wp.length = ctypes.sizeof(WINDOWPLACEMENT)
            u.GetWindowPlacement(win["hwnd"], ctypes.byref(wp))
            wp.showCmd = 4  # SW_SHOWNOACTIVATE
            wp.rcNormalPosition = wt.RECT(x, y, x + w, y + h)
            u.SetWindowPlacement(win["hwnd"], ctypes.byref(wp))
            u.SetWindowPos(win["hwnd"], 1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)  # HWND_BOTTOM
            with open(log, "a", encoding="utf-8") as f:
                f.write(f"{dt.datetime.now():%H:%M:%S} ALERT chrome meeting window was minimized; restored "
                        f"(focus unchanged: {u.GetForegroundWindow() == fg})\n")
    time.sleep(1)

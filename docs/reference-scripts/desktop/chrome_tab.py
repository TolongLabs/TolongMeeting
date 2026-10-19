"""Chrome tab helper via UIA, restoring the user's focus afterwards and keeping Chrome at the back.

  chrome_tab.py list
  chrome_tab.py activate SUBSTRING
  chrome_tab.py close SUBSTRING
"""
import ctypes
import sys
import time

import uiautomation as auto

from wins import windows

u = ctypes.windll.user32
auto.SetGlobalSearchTimeout(3)


def chrome_hwnd():
    return next(w["hwnd"] for w in windows("chrome.exe") if w["title"].endswith("Google Chrome"))


def tabs(win):
    return [c for c, _ in auto.WalkControl(win, maxDepth=14) if c.ControlTypeName == "TabItemControl"]


def restore(fg, hwnd):
    if u.GetForegroundWindow() != fg:
        u.SwitchToThisWindow(fg, True)
    u.SetWindowPos(hwnd, 1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)  # HWND_BOTTOM, no move/size/activate


if __name__ == "__main__":
    cmd = sys.argv[1]
    hwnd = chrome_hwnd()
    win = auto.ControlFromHandle(hwnd)
    fg = u.GetForegroundWindow()
    ts = tabs(win)
    if cmd == "list":
        for t in ts:
            print(repr(t.Name[:90]))
        sys.exit()
    t = next(t for t in ts if sys.argv[2] in t.Name)
    if cmd == "activate":
        t.GetPattern(auto.PatternId.SelectionItemPattern).Select()
    elif cmd == "close":
        btn = next(c for c, _ in auto.WalkControl(t, maxDepth=3) if c.ControlTypeName == "ButtonControl")
        btn.GetInvokePattern().Invoke()
    time.sleep(0.5)
    restore(fg, hwnd)
    print(cmd, "done; window title:", auto.ControlFromHandle(hwnd).Name[:70],
          "| focus restored:", u.GetForegroundWindow() == fg)

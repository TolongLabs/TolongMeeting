"""Put a window on a rect without activating it (un-maximizes first): place.py HWND X Y W H"""
import ctypes
import ctypes.wintypes as wt
import sys

ctypes.windll.shcore.SetProcessDpiAwareness(2)
u = ctypes.windll.user32
SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOZORDER = 4, 0x0010, 0x0004


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [("length", wt.UINT), ("flags", wt.UINT), ("showCmd", wt.UINT),
                ("ptMinPosition", wt.POINT), ("ptMaxPosition", wt.POINT), ("rcNormalPosition", wt.RECT)]


hwnd, x, y, w, h = map(int, sys.argv[1:6])
fg = u.GetForegroundWindow()
wp = WINDOWPLACEMENT()
wp.length = ctypes.sizeof(WINDOWPLACEMENT)
u.GetWindowPlacement(hwnd, ctypes.byref(wp))
wp.showCmd = SW_SHOWNOACTIVATE
wp.rcNormalPosition = wt.RECT(x, y, x + w, y + h)
u.SetWindowPlacement(hwnd, ctypes.byref(wp))
u.SetWindowPos(hwnd, 0, x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER)
print("foreground unchanged:", u.GetForegroundWindow() == fg)

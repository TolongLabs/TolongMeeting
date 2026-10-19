"""Desktop helper: screenshot / click / key / window focus, in physical pixels.

  desk.py shot OUT.png [x y w h]     screenshot (default: primary monitor)
  desk.py click X Y [right|double]
  desk.py key ctrl+v | alt+h | enter ...
  desk.py focus HWND                  bring a window to the foreground
  desk.py type TEXT
"""
import ctypes
import sys
import time

ctypes.windll.shcore.SetProcessDpiAwareness(2)
from PIL import ImageGrab  # noqa: E402  (after DPI awareness)

user32 = ctypes.windll.user32
VK = {"ctrl": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B, "enter": 0x0D, "esc": 0x1B,
      "tab": 0x09, "space": 0x20, "f": 0x46, "h": 0x48, "a": 0x41, "v": 0x56, "u": 0x55,
      "w": 0x57, "f11": 0x7A, "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27}


def shot(out, box=None):
    if box:
        x, y, w, h = box
        img = ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True)
    else:
        img = ImageGrab.grab()  # primary monitor
    img.save(out)
    print(out, img.size)


def click(x, y, kind="left"):
    user32.SetCursorPos(x, y)
    time.sleep(0.05)
    down, up = (0x0008, 0x0010) if kind == "right" else (0x0002, 0x0004)
    for _ in range(2 if kind == "double" else 1):
        user32.mouse_event(down, 0, 0, 0, 0)
        user32.mouse_event(up, 0, 0, 0, 0)
        time.sleep(0.05)


def key(combo):
    keys = [VK[k] if k in VK else ord(k.upper()) for k in combo.lower().split("+")]
    for k in keys:
        user32.keybd_event(k, 0, 0, 0)
    for k in reversed(keys):
        user32.keybd_event(k, 0, 2, 0)


def focus(hwnd):
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.keybd_event(0x12, 0, 0, 0)  # alt tap lets SetForegroundWindow succeed
    user32.SetForegroundWindow(hwnd)
    user32.keybd_event(0x12, 0, 2, 0)


def type_text(text):
    for ch in text:
        for flag in (0, 2):  # KEYEVENTF_UNICODE via SendInput is overkill; use WM_CHAR-free VkKeyScan
            vk = user32.VkKeyScanW(ord(ch))
            if vk & 0x100 and flag == 0:
                user32.keybd_event(0x10, 0, 0, 0)
            user32.keybd_event(vk & 0xFF, 0, flag, 0)
            if vk & 0x100 and flag == 2:
                user32.keybd_event(0x10, 0, 2, 0)
        time.sleep(0.01)


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "shot":
        shot(args[0], tuple(map(int, args[1:5])) if len(args) >= 5 else None)
    elif cmd == "click":
        click(int(args[0]), int(args[1]), args[2] if len(args) > 2 else "left")
    elif cmd == "key":
        key(args[0])
    elif cmd == "focus":
        focus(int(args[0]))
    elif cmd == "type":
        type_text(" ".join(args))

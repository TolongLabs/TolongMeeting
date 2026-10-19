"""List visible top-level windows of a process (title, class, rect, minimized)."""
import ctypes
import ctypes.wintypes as wt
import os
import sys

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def _exe(pid):
    h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ""
    buf = ctypes.create_unicode_buffer(1024)
    n = wt.DWORD(1024)
    kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n))
    kernel32.CloseHandle(h)
    return os.path.basename(buf.value)


def windows(exe_name="Zoom.exe"):
    out = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if _exe(pid.value).lower() != exe_name.lower():
            return True
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        out.append({
            "hwnd": hwnd, "title": title.value, "class": cls.value,
            "rect": (r.left, r.top, r.right - r.left, r.bottom - r.top),
            "minimized": bool(user32.IsIconic(hwnd)),
        })
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


if __name__ == "__main__":
    for w in windows(sys.argv[1] if len(sys.argv) > 1 else "Zoom.exe"):
        print(w)

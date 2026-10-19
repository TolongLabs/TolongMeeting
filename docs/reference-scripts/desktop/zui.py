"""Zoom UI Automation helper (no mouse, no focus stealing where the control supports patterns).

  zui.py tree CLASS_OR_TITLE [depth]        dump a Zoom window's control tree
  zui.py invoke CLASS_OR_TITLE NAME [type]  invoke/toggle/select the first control named NAME
  zui.py windows                            list top-level Zoom windows
"""
import sys

import uiautomation as auto

auto.SetGlobalSearchTimeout(3)


def zoom_windows():
    import subprocess
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Zoom.exe", "/FO", "CSV", "/NH"],
                         capture_output=True, text=True).stdout
    pids = {int(line.split('","')[1]) for line in out.splitlines() if line.startswith('"Zoom.exe"')}
    return [w for w in auto.GetRootControl().GetChildren() if w.ProcessId in pids]


def find_window(key):
    for w in zoom_windows():
        if key in (w.ClassName, w.Name) or key in w.Name:
            return w
    raise SystemExit(f"no window matching {key!r}; have {[(w.Name, w.ClassName) for w in zoom_windows()]}")


def tree(ctrl, depth, indent=0):
    for c, d in auto.WalkControl(ctrl, maxDepth=depth):
        state = ""
        try:
            if c.GetPattern(auto.PatternId.TogglePattern):
                state = f" toggle={c.GetTogglePattern().ToggleState}"
        except Exception:
            pass
        print("  " * d + f"{c.ControlTypeName} {c.Name!r} [{c.ClassName}] {c.AutomationId!r}{state}")


def invoke(ctrl, name, ctype=None):
    for c, _ in auto.WalkControl(ctrl, maxDepth=25):
        if c.Name == name and (ctype is None or c.ControlTypeName == ctype):
            for pid, act in ((auto.PatternId.InvokePattern, lambda p: p.Invoke()),
                             (auto.PatternId.TogglePattern, lambda p: p.Toggle()),
                             (auto.PatternId.SelectionItemPattern, lambda p: p.Select())):
                p = c.GetPattern(pid)
                if p:
                    act(p)
                    print("ok", c.ControlTypeName, repr(c.Name), pid)
                    return
            c.Click(simulateMove=False)
            print("clicked", c.ControlTypeName, repr(c.Name))
            return
    raise SystemExit(f"control {name!r} not found")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "windows":
        for w in zoom_windows():
            print(repr(w.Name), w.ClassName, w.BoundingRectangle)
    elif cmd == "tree":
        tree(find_window(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 12)
    elif cmd == "invoke":
        invoke(find_window(sys.argv[2]), sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
深夜书房 · 桌面壳（C 方案）

- 无边框，铺满桌面
- 默认「置底」：在桌面图标之上、普通窗口之下（像壁纸）
- 可切「置顶」：永远在最前（像桌宠）
- 不抢焦点：点角色不会把你正在用的窗口切走
- 托盘/快捷键：Ctrl+Alt+D 切置底，Ctrl+Alt+T 切置顶，Ctrl+Alt+Q 退出
- 可选开机自启

用法：
  python app.py            # 启动
  python app.py --top      # 以置顶模式启动
  python app.py --install  # 安装开机自启
  python app.py --uninstall
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import threading
import time
from pathlib import Path

import webview

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "shell.json"
TITLE = "深夜书房"

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
HWND_BOTTOM = 1
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
WM_HOTKEY = 0x0312
VK_D, VK_T, VK_Q = 0x44, 0x54, 0x51

state = {"mode": "bottom", "hwnd": None}


def load_cfg() -> dict:
    if CONFIG.exists():
        try:
            return json.loads(CONFIG.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"mode": "bottom", "autostart": False}


def save_cfg(cfg: dict) -> None:
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def find_hwnd() -> int:
    return user32.FindWindowW(None, TITLE)


def apply_style(hwnd: int) -> None:
    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)


def set_mode(mode: str) -> None:
    hwnd = state["hwnd"] or find_hwnd()
    if not hwnd:
        return
    state["hwnd"] = hwnd
    state["mode"] = mode
    if mode == "top":
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    elif mode == "bottom":
        user32.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    else:  # normal
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)


def keep_bottom_loop() -> None:
    """置底模式下定期把窗口压回底层（被其他窗口盖住后仍然在桌面最上层）"""
    while True:
        time.sleep(1.5)
        if state["mode"] == "bottom" and state["hwnd"]:
            user32.SetWindowPos(state["hwnd"], HWND_BOTTOM, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)


def hotkey_loop() -> None:
    ids = {1: ("bottom", VK_D), 2: ("top", VK_T), 3: ("quit", VK_Q)}
    for hid, (_, vk) in ids.items():
        user32.RegisterHotKey(None, hid, MOD_CONTROL | MOD_ALT, vk)
    msg = wt.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
        if msg.message == WM_HOTKEY:
            hid = msg.wParam
            if hid == 1:
                set_mode("bottom")
            elif hid == 2:
                set_mode("top")
            elif hid == 3:
                for w in webview.windows:
                    w.destroy()
                break


class Api:
    def quit(self):
        for w in webview.windows:
            w.destroy()

    def set_mode(self, mode: str):
        set_mode(mode)
        cfg = load_cfg()
        cfg["mode"] = mode
        save_cfg(cfg)
        return mode

    def get_mode(self):
        return state["mode"]


def install_autostart() -> None:
    startup = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    lnk = startup / "深夜书房.lnk"
    py = sys.executable
    script = ROOT / "app.py"
    ps = (
        f'$s=(New-Object -ComObject WScript.Shell).CreateShortcut("{lnk}");'
        f'$s.TargetPath="{py}";$s.Arguments="{script}";'
        f'$s.WorkingDirectory="{ROOT}";$s.WindowStyle=7;$s.Save()'
    )
    os.system(f'powershell -NoProfile -Command "{ps}"')
    print(f"已安装开机自启：{lnk}")


def uninstall_autostart() -> None:
    startup = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    lnk = startup / "深夜书房.lnk"
    if lnk.exists():
        lnk.unlink()
        print(f"已移除：{lnk}")
    else:
        print("没有找到自启项")


def main() -> None:
    cfg = load_cfg()
    mode = "top" if "--top" in sys.argv else cfg.get("mode", "bottom")

    screen_w = user32.GetSystemMetrics(0)
    screen_h = user32.GetSystemMetrics(1)

    webview.create_window(
        TITLE,
        url=(ROOT / "index.html").as_uri(),
        width=screen_w,
        height=screen_h,
        x=0,
        y=0,
        frameless=True,
        easy_drag=False,
        resizable=False,
        on_top=(mode == "top"),
        background_color="#06080f",
        js_api=Api(),
    )

    def after_start():
        for _ in range(60):
            hwnd = find_hwnd()
            if hwnd:
                state["hwnd"] = hwnd
                apply_style(hwnd)
                set_mode(mode)
                break
            time.sleep(0.1)
        threading.Thread(target=keep_bottom_loop, daemon=True).start()
        threading.Thread(target=hotkey_loop, daemon=True).start()

    webview.start(after_start, debug=False)


if __name__ == "__main__":
    if "--install" in sys.argv:
        install_autostart()
    elif "--uninstall" in sys.argv:
        uninstall_autostart()
    else:
        main()

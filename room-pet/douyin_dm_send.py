"""发抖音私信（UI 自动化；顺带把发送请求的路子记下来）

为什么用 UI：网页版私信的发送走的是前端内部协议（点发送后才出现），
直接构造协议没有可靠的 cmd 号；而「点输入框 + 真键盘输入 + 回车」实测能发出去。

用法：
  python douyin_dm_send.py --to 居居罗 --text "你好"
  python douyin_dm_send.py --to 居居罗 --text "你好" --dry    # 只输入不回车
"""
import argparse
import asyncio
import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EDGE = os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe")
PROFILE = os.environ.get("DY_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "browseprofile")
PORT = 9237
FRIEND_URL = "https://www.douyin.com/friend"

user32 = ctypes.windll.user32


def focus_window() -> bool:
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, l):
        if not user32.IsWindowVisible(h):
            return True
        n = user32.GetWindowTextLengthW(h)
        b = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(h, b, n + 1)
        if "抖音" in b.value or "douyin" in b.value.lower():
            found.append(h)
        return True

    user32.EnumWindows(cb, 0)
    if found:
        user32.ShowWindow(found[0], 9)
        user32.SetForegroundWindow(found[0])
        time.sleep(0.8)
        return True
    return False


def http_json(url, timeout=6):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


async def _send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return m


async def ev(ws, expr, mid, timeout_s=30):
    return await asyncio.wait_for(_send(ws, mid, "Runtime.evaluate",
                                        {"expression": expr, "returnByValue": True, "awaitPromise": True}),
                                  timeout=timeout_s)


def val(r):
    try:
        return ((r.get("result") or {}).get("result") or {}).get("value")
    except Exception:
        return None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", default="", help="会话名（昵称的一部分）")
    ap.add_argument("--to-last", default="", help="按最后一条消息内容定位会话（拿不到昵称时用）")
    ap.add_argument("--first", action="store_true", help="直接点第一个会话（最新消息那个）")
    ap.add_argument("--text", required=True)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    # 确保 /friend 页面存在
    try:
        pages = [x for x in http_json(f"http://127.0.0.1:{PORT}/json/list") if x.get("type") == "page"]
    except Exception:
        subprocess.Popen([EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                          "--no-first-run", "--no-default-browser-check", "--mute-audio", FRIEND_URL])
        await asyncio.sleep(9)
        pages = [x for x in http_json(f"http://127.0.0.1:{PORT}/json/list") if x.get("type") == "page"]

    target = next((p for p in pages if "/friend" in (p.get("url") or "")), None)
    if not target:
        target = pages[0]
    print("[页面]", (target.get("url") or "")[:60])

    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
        mid = 1
        if "/friend" not in (target.get("url") or ""):
            await _send(ws, mid, "Page.navigate", {"url": FRIEND_URL})
            mid += 1
            await asyncio.sleep(10)

        print("[聚焦窗口]", focus_window())

        # 选会话：--first 直接点第一个（最新）
        if args.first:
            picked = await ev(ws, """(() => {
              const items = [...document.querySelectorAll('[class*="conversation"]')]
                .filter(e => (e.innerText || '').trim().length > 2);
              if (!items.length) return JSON.stringify({ok: false});
              items[0].click();
              return JSON.stringify({ok: true, text: (items[0].innerText || '').slice(0, 40)});
            })()""", mid)
            mid += 1
            pv = val(picked) or "{}"
            print("[第一个会话]", pv)
            try:
                if not json.loads(pv).get("ok"):
                    print("[失败] 会话列表是空的")
                    return
            except Exception:
                print("[失败] 选会话异常:", pv)
                return
            await asyncio.sleep(2)

        # 选会话：优先昵称；没有昵称就按最后一条消息内容找
        if not args.to and args.to_last:
            picked = await ev(ws, """(() => {
              const snippet = %s;
              const items = [...document.querySelectorAll('[class*="conversation"]')];
              const hit = items.find(e => (e.innerText || '').includes(snippet));
              if (!hit) return JSON.stringify({ok: false, count: items.length});
              hit.click();
              const t = (hit.innerText || '').trim();
              return JSON.stringify({ok: true, text: t.slice(0, 40), nick: t.split(' ')[0]});
            })()""" % json.dumps(args.to_last, ensure_ascii=False), mid)
            mid += 1
            pv = val(picked) or "{}"
            print("[按消息选会话]", pv)
            try:
                if not json.loads(pv).get("ok"):
                    print("[失败] 没找到包含这段文字的会话")
                    return
            except Exception:
                print("[失败] 选会话异常:", pv)
                return
            await asyncio.sleep(2)

        if args.to:
            picked = await ev(ws, """(() => {
              const name = %s;
              const items = [...document.querySelectorAll('[class*="conversation"]')];
              const hit = items.find(e => (e.innerText || '').includes(name));
              if (!hit) return JSON.stringify({ok: false, count: items.length});
              hit.click();
              return JSON.stringify({ok: true, text: (hit.innerText || '').replace(/\\n/g, ' ').slice(0, 30)});
            })()""" % json.dumps(args.to, ensure_ascii=False), mid)
            mid += 1
            picked_val = val(picked) or "{}"
            print("[选会话]", picked_val)
            try:
                if not json.loads(picked_val).get("ok"):
                    print("[失败] 没找到这个人的会话")
                    return
            except Exception:
                print("[失败] 选会话返回异常:", picked_val)
                return
            await asyncio.sleep(2)

        # 找输入框
        pos = await ev(ws, """(() => {
          const el = document.querySelector('[contenteditable="true"]');
          if (!el) return JSON.stringify({x: null});
          el.scrollIntoView({block: 'center'});
          const rc = el.getBoundingClientRect();
          return JSON.stringify({x: Math.round(rc.left + rc.width / 2), y: Math.round(rc.top + rc.height / 2)});
        })()""", mid)
        mid += 1
        pos_val = val(pos) or "{}"
        print("[输入框]", pos_val)
        try:
            pj = json.loads(pos_val)
        except Exception:
            pj = {}
        if pj.get("x") is None:
            print("[失败] 没有输入框")
            return

        for tp in ("mousePressed", "mouseReleased"):
            await _send(ws, mid, "Input.dispatchMouseEvent",
                        {"type": tp, "x": pj["x"], "y": pj["y"], "button": "left", "clickCount": 1})
        mid += 1
        await asyncio.sleep(0.4)

        for ch in args.text:
            await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyDown", "text": ch})
            await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyUp", "text": ch})
            await asyncio.sleep(0.04)
        await asyncio.sleep(0.5)

        typed = await ev(ws, """(() => {
          const el = document.querySelector('[contenteditable="true"]');
          return el ? (el.innerText || '').replace(/\\n/g, ' ').trim().slice(0, 40) : '';
        })()""", mid)
        mid += 1
        typed_val = val(typed) or ""
        print("[已输入]", typed_val)

        if args.dry:
            print("[dry] 只输入不发送")
            return
        if not typed_val:
            print("[放弃] 输入框是空的")
            return

        await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "windowsVirtualKeyCode": 13})
        await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "windowsVirtualKeyCode": 13})
        mid += 1
        await asyncio.sleep(2.5)

        check = await ev(ws, """JSON.stringify({
          appeared: document.body.innerText.includes(%s),
          box: ((document.querySelector('[contenteditable="true"]') || {}).innerText || '').trim().slice(0, 20)
        })""" % json.dumps(args.text[:12], ensure_ascii=False), mid)
        print("[结果]", val(check))


if __name__ == "__main__":
    asyncio.run(main())

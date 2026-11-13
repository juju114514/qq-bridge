"""发评论 + 立刻抓 cid + 用签名接口删除（一条龙）

为什么这样设计：
  · 抖音评论列表默认按热度排序，新评论要翻很多页才找得到 cid
  · 所以发送时用 CDP 的 Network 域监听 /comment/publish/ 的响应，响应里就有 cid
  · 拿到 cid 后直接调 /aweme/v1/web/comment/delete/（页面里 XHR，bdms 自动签名）

用法：
  python douyin_post_and_delete.py --aweme <id> --text "内容" --post --delete
  python douyin_post_and_delete.py --aweme <id> --text "内容" --post          # 只发，记 cid
  python douyin_post_and_delete.py --aweme <id> --cid <cid> --delete         # 只删
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

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(ROOT, "douyin", "comments.json")
EDGE = os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe")
PROFILE = os.environ.get("DY_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "browseprofile")
PORT = 9237


def focus_window():
    user32 = ctypes.windll.user32
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


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_state(items):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(items[-200:], f, ensure_ascii=False, indent=2)


async def _send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return m


async def ev(ws, expr, mid, timeout_s=60):
    return await asyncio.wait_for(_send(ws, mid, "Runtime.evaluate",
                                        {"expression": expr, "returnByValue": True, "awaitPromise": True}),
                                  timeout=timeout_s)


JS_DELETE = """(async () => {
  const url = '/aweme/v1/web/comment/delete/?device_platform=webapp&aid=6383&channel=channel_pc_web'
            + '&aweme_id=%s&cid=%s';
  const d = await new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    x.onload = () => { try { res(JSON.parse(x.responseText)); } catch(e) { res({raw: x.responseText.slice(0,200)}); } };
    x.onerror = () => rej(new Error('xhr')); x.send('');
  });
  return JSON.stringify(d).slice(0, 300);
})()"""

JS_CHECK_GONE = """(async () => {
  const url = '/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&channel=channel_pc_web'
            + '&aweme_id=%s&cursor=0&count=50&item_type=0';
  const d = await new Promise((res, rej) => {
    const x = new XMLHttpRequest(); x.open('GET', url, true);
    x.onload = () => { try { res(JSON.parse(x.responseText)); } catch(e) { rej(e); } };
    x.onerror = () => rej(new Error('xhr')); x.send();
  });
  const list = d.comments || [];
  const hit = list.find(c => String(c.cid) === '%s');
  return JSON.stringify({checked: list.length, stillThere: !!hit});
})()"""


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aweme", required=True)
    ap.add_argument("--text", default="")
    ap.add_argument("--cid", default="")
    ap.add_argument("--post", action="store_true")
    ap.add_argument("--delete", action="store_true")
    args = ap.parse_args()

    url = f"https://www.douyin.com/video/{args.aweme}"
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=5) as r:
            json.loads(r.read().decode())
        print("[浏览器] 复用已开的窗口")
    except Exception:
        print("[浏览器] 新开窗口")
        subprocess.Popen([EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                          "--no-first-run", "--no-default-browser-check", "--mute-audio", url])
        await asyncio.sleep(8)

    target = None
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
                for x in json.loads(r.read().decode()):
                    if x.get("type") == "page" and "/video/" in (x.get("url") or ""):
                        target = x
            if not target:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
                    pages = [x for x in json.loads(r.read().decode()) if x.get("type") == "page"]
                target = pages[0] if pages else None
        except Exception:
            pass
        if target:
            break
        await asyncio.sleep(0.5)
    if not target:
        print("[错误] 没有可用页面")
        return

    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
        mid = 1
        if "/video/" not in (target.get("url") or "") or args.aweme not in (target.get("url") or ""):
            await _send(ws, mid, "Page.navigate", {"url": url})
            mid += 1
            await asyncio.sleep(8)
        print("[页面]", url)

        # 等 bdms 接管 XHR
        for _ in range(30):
            r = await ev(ws, "JSON.stringify({p: !/native code/.test(String(XMLHttpRequest.prototype.open))})", mid)
            mid += 1
            try:
                ok = json.loads((r.get("result") or {}).get("result", {}).get("value") or "{}").get("p")
            except Exception:
                ok = False
            if ok:
                print("[签名] XHR 已被 bdms 接管")
                break
            await asyncio.sleep(1.5)

        cid = args.cid
        if args.post:
            if not args.text:
                print("[错误] --post 需要 --text")
                return
            # 开 Network 监听
            await _send(ws, mid, "Network.enable", {})
            mid += 1

            focus_window()
            info = await ev(ws, """(() => {
              const b = [...document.querySelectorAll('[class*="comment-input"]')].find(x=>x.getBoundingClientRect().width>100);
              if (!b) return JSON.stringify({found:false});
              b.scrollIntoView({block:'center'});
              const rc = b.getBoundingClientRect();
              return JSON.stringify({found:true, x: Math.round(rc.left+rc.width/2), y: Math.round(rc.top+rc.height/2)});
            })()""", mid)
            mid += 1
            print("[输入框]", (info.get("result") or {}).get("result", {}).get("value"))
            try:
                pos = json.loads((info.get("result") or {}).get("result", {}).get("value") or "{}")
            except Exception:
                pos = {}
            if not pos.get("found"):
                print("[失败] 没有评论输入框")
                return

            for tp in ("mousePressed", "mouseReleased"):
                await _send(ws, mid, "Input.dispatchMouseEvent",
                            {"type": tp, "x": pos["x"], "y": pos["y"], "button": "left", "clickCount": 1})
            mid += 1
            await asyncio.sleep(0.4)
            for ch in args.text:
                await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyDown", "text": ch})
                await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyUp", "text": ch})
                await asyncio.sleep(0.04)
            await asyncio.sleep(0.5)
            print("[已输入]", args.text)

            # 点发送
            await ev(ws, """(() => {
              const b = [...document.querySelectorAll('[class*="comment-input"]')].find(x=>x.getBoundingClientRect().width>100);
              const span = b && b.querySelector('span[class*="wchsYBpK"]');
              if (!span) return 'no-span';
              span.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
              return 'clicked';
            })()""", mid)
            mid += 1
            print("[发送] 已点击")

            # 抓 publish 响应里的 cid
            print("[等 cid] 监听 /comment/publish/ 响应…")
            deadline = time.time() + 25
            body = None
            while time.time() < deadline and not body:
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
                except asyncio.TimeoutError:
                    continue
                if msg.get("method") != "Network.responseReceived":
                    continue
                u = ((msg.get("params") or {}).get("response") or {}).get("url") or ""
                if "comment/publish" in u:
                    rid = (msg["params"]["requestId"])
                    got = await _send(ws, mid, "Network.getResponseBody", {"requestId": rid})
                    mid += 1
                    body = (got.get("result") or {}).get("body") or ""
                    print("[publish 响应]", body[:300])
            if body:
                try:
                    j = json.loads(body)
                    cid = str(((j.get("comment") or {}).get("cid")) or j.get("cid") or "")
                except Exception:
                    cid = ""
            if not cid:
                print("[失败] 没抓到 cid")
            else:
                print("[cid]", cid)
                items = load_state()
                items.append({"aweme": args.aweme, "cid": cid, "text": args.text, "ts": int(time.time())})
                save_state(items)
                print("[记录]", STATE_FILE)

        if args.delete:
            if not cid:
                print("[错误] --delete 需要 cid（--post 会自动拿到）")
                return
            r = await ev(ws, JS_DELETE % (args.aweme, cid), mid, timeout_s=40)
            mid += 1
            print("[删除响应]", ((r.get("result") or {}).get("result", {}) or {}).get("value"))
            await asyncio.sleep(2)
            r2 = await ev(ws, JS_CHECK_GONE % (args.aweme, cid), mid, timeout_s=40)
            print("[复查]", ((r2.get("result") or {}).get("result", {}) or {}).get("value"))


if __name__ == "__main__":
    asyncio.run(main())

"""抖音直播弹幕 → 直播中控

用无头 Edge（CDP）打开直播间页面，定时抓聊天区的新消息，POST 到 room-pet 的 /live/msg。
不调用抖音的私有接口，只在页面里读 DOM，登录态用一份独立的浏览器配置目录。

用法：
  python live_douyin.py --url https://live.douyin.com/123456789
  python live_douyin.py --probe --url ...      # 只打印页面里能抓到什么，便于排查选择器
  python live_douyin.py --url ... --post http://127.0.0.1:8796
"""
import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
import urllib.request

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EDGE_CANDIDATES = [
    os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
    os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
]
PROFILE = os.environ.get("DY_LIVE_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "liveprofile")
PORT = 9226

# 直播间聊天区：抖音前端类名带哈希，用「包含 chatroom / chat 且像条目」的宽松选择器兜底
JS_COLLECT = r"""
(() => {
  const out = [];
  const seen = new Set();
  const nodes = document.querySelectorAll('[class*="webcast-chatroom___item"]');
  for (const n of nodes) {
    const cls = String(n.className || '');
    if (cls.includes('wrapper')) continue;
    // 取最内层的条目：如果它内部还有 ___item 就跳过
    if (n.querySelector('[class*="webcast-chatroom___item"]')) continue;
    const t = (n.innerText || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length < 2 || t.length > 200) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return JSON.stringify(out.slice(-60));
})()
"""

JS_INFO = r"""
(() => {
  const c = (s) => { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
  return JSON.stringify({
    title: document.title,
    url: location.href,
    chatLike: c('[class*="chat"]'),
    chatroom: c('[class*="chatroom"]'),
    items: c('[class*="chatroom"] [class*="item"]'),
    bodyLen: document.body ? document.body.innerText.length : 0,
    head: (document.body ? document.body.innerText : '').slice(0, 300)
  });
})()
"""


def find_edge():
    for p in EDGE_CANDIDATES:
        import os
        if os.path.exists(p):
            return p
    raise SystemExit("找不到 msedge.exe")


def http_json(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def post_json(url, body, timeout=8):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


async def connect_page(port, url, timeout_s=40):
    t = None
    for _ in range(timeout_s * 2):
        try:
            for x in http_json(f"http://127.0.0.1:{port}/json/list"):
                if x.get("type") == "page" and (x.get("url") or "").startswith("https://live.douyin.com"):
                    t = x
                    break
        except Exception:
            pass
        if t:
            break
        await asyncio.sleep(0.5)
    if not t:
        return None
    ws = await websockets.connect(t["webSocketDebuggerUrl"], max_size=2 ** 24)
    return ws


async def _send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return (m.get("result") or {})


async def evaluate(ws, expr, mid):
    await ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            res = (m.get("result") or {}).get("result") or {}
            return res.get("value")


def split_user(text: str):
    """抖音聊天行一般是「昵称：内容」或「昵称 内容」。"""
    for sep in ("：", ":"):
        if sep in text:
            u, _, t = text.partition(sep)
            if 0 < len(u) <= 24 and t.strip():
                return u.strip(), t.strip()
    parts = text.split(" ", 1)
    if len(parts) == 2 and len(parts[0]) <= 24:
        return parts[0].strip(), parts[1].strip()
    return "观众", text.strip()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://live.douyin.com/")
    ap.add_argument("--post", default="http://127.0.0.1:8796")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--interval", type=float, default=1.5)
    ap.add_argument("--minutes", type=float, default=0, help="0 = 一直跑")
    ap.add_argument("--headless", action="store_true", help="不弹窗口（部分直播间可能不放行）")
    args = ap.parse_args()

    edge = find_edge()
    anti_throttle = [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
    ]
    extra = (["--headless=new"] if args.headless else ["--window-size=1100,760"]) + ["--mute-audio"] + anti_throttle
    proc = subprocess.Popen([edge, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                             "--no-first-run", "--no-default-browser-check",
                             "--disable-blink-features=AutomationControlled",
                             "--window-size=1280,800", *extra, args.url])
    print(f"[启动] {edge} 端口 {PORT}")
    try:
        ws = await connect_page(PORT, args.url)
        if not ws:
            print("[错误] 没拿到直播间页面")
            return
        mid = 1
        await asyncio.sleep(14)
        # 页面加载完再最小化（一启动就最小化会让聊天区不渲染）
        try:
            wid = (await _send(ws, mid, "Browser.getWindowForTarget")) or {}
            if wid.get("windowId"):
                await _send(ws, mid + 100, "Browser.setWindowBounds",
                            {"windowId": wid["windowId"], "bounds": {"windowState": "minimized"}})
                print("[窗口] 已最小化")
        except Exception as e:
            print("[窗口] 最小化失败（不影响抓取）:", e)
        info = json.loads(await evaluate(ws, JS_INFO, mid) or "{}")
        print("[页面]", json.dumps(info, ensure_ascii=False)[:400])

        if args.probe:
            raw = await evaluate(ws, JS_COLLECT, mid + 1)
            print("[可抓到的条目]", raw[:1200] if raw else "（空）")
            await ws.close()
            return

        seen = set()
        deadline = None
        if args.minutes > 0:
            import time
            deadline = time.time() + args.minutes * 60
        import time
        n = 0
        while True:
            if deadline and time.time() > deadline:
                break
            mid += 1
            raw = await evaluate(ws, JS_COLLECT, mid)
            try:
                lines = json.loads(raw) if raw else []
            except Exception:
                lines = []
            for line in lines:
                h = hashlib.md5(line.encode("utf-8")).hexdigest()
                if h in seen:
                    continue
                seen.add(h)
                user, text = split_user(line)
                try:
                    post_json(args.post + "/live/msg", {"user": user, "text": text, "kind": "chat"})
                    n += 1
                    print(f"  [{n}] {user}: {text[:60]}")
                except Exception as e:
                    print("  转发失败:", e)
            if len(seen) > 5000:
                seen = set(list(seen)[-2000:])
            await asyncio.sleep(args.interval)
        await ws.close()
    finally:
        proc.terminate()
        print("[结束] 浏览器已关闭")


if __name__ == "__main__":
    asyncio.run(main())

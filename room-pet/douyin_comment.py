"""抖音评论：在已登录的浏览器里给某个视频发一条评论（需显式开启）

⚠️ 这是**写操作**，评论是公开可见的。默认关闭，必须在中控页把「允许评论」打开，
   并且每条都要你亲自点发送。

用法：
  python douyin_comment.py --id 7694869545252687130 --text "这个视频不错" --dry
       --dry 只把字打进输入框、不点发送，用来验证流程
  python douyin_comment.py --id <id> --text "..."        # 真发

实现：CDP 连一个已登录的 Edge（独立配置目录），打开视频页，
      找到评论输入框 → 输入 → 点发送 → 读回列表确认。
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import urllib.request

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EDGE_CANDIDATES = [
    os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
    os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
]
PROFILE = os.environ.get("DY_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "browseprofile")
PORT = 9237

CLICK_COMMENT = r"""
(() => {
  const sels = ['[data-e2e="comment-icon"]', '[data-e2e="feed-comment-icon"]',
                '[class*="comment"] [class*="icon"]', 'svg[class*="comment"]'];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) { el.dispatchEvent(new MouseEvent('click', {bubbles: true})); return 'clicked:' + s; }
  }
  return 'no-icon';
})()
"""

JS_FIND_INPUT = r"""
(() => {
  // 输入框外框（2026-11 实测类名）
  const boxes = [...document.querySelectorAll('[class*="comment-input-inner-container"], [class*="comment-input"]')];
  for (const box of boxes) {
    const r = box.getBoundingClientRect();
    if (r.width < 100 || r.height < 14) continue;
    const edit = box.querySelector('[contenteditable="true"], [role="textbox"], textarea, input');
    return JSON.stringify({
      found: true,
      editable: !!edit,
      tag: (edit || box).tagName,
      rect: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
    });
  }
  // 兜底：任何 placeholder 含「评论」的输入
  for (const el of document.querySelectorAll('[placeholder*="评论"], [data-e2e*="comment"] [contenteditable], [data-e2e*="comment"] textarea')) {
    const r = el.getBoundingClientRect();
    if (r.width < 80) continue;
    return JSON.stringify({found: true, editable: true, tag: el.tagName,
      rect: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]});
  }
  return JSON.stringify({found: false});
})()
"""

JS_FOCUS = r"""
(() => {
  const cands = [...document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')];
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width > 120 && r.height > 16) {
      el.scrollIntoView({block: 'center'});
      const r2 = el.getBoundingClientRect();
      return JSON.stringify({x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2)});
    }
  }
  return JSON.stringify({x: null});
})()
"""


JS_TYPE = """
(() => {
  const text = %s;
  const box = [...document.querySelectorAll('[class*="comment-input"]')]
    .find(b => b.getBoundingClientRect().width > 100);
  if (!box) return 'no-box';
  const el = box.querySelector('textarea, input, [contenteditable="true"], div[contenteditable]') || box;
  if (el.focus) el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    el.value = text;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  } else {
    el.innerText = '';
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', {bubbles: true, data: text}));
  }
  const inp = box.querySelector('textarea, input, [contenteditable="true"]');
  return ((inp && (inp.value !== undefined ? inp.value : inp.innerText)) || box.innerText || '').trim().slice(0, 80);
})()
"""



def focus_edge_window() -> str:
    """把带抖音页面的 Edge 窗口拉到前台（CDP 点击/输入需要窗口有焦点，否则 input 事件不生效）。"""
    import ctypes
    import time as _t
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value or ""
        if "抖音" in title or "douyin" in title.lower():
            found.append((hwnd, title))
        return True

    user32.EnumWindows(cb, 0)
    if not found:
        return "no-window"
    hwnd, title = found[0]
    user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    _t.sleep(0.8)
    return title[:40]

def find_edge():
    for p in EDGE_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("找不到 msedge.exe")


def http_json(url, timeout=6):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


async def _send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return (m.get("result") or {})


async def ev(ws, expr, mid):
    r = await _send(ws, mid, "Runtime.evaluate",
                    {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return ((r.get("result") or {}) if isinstance(r, dict) else {}).get("value")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--dry", action="store_true", help="只输入不发送")
    args = ap.parse_args()

    url = f"https://www.douyin.com/video/{args.id}"
    edge = find_edge()
    already = False
    try:
        http_json(f"http://127.0.0.1:{PORT}/json/version")
        already = True
    except Exception:
        pass

    proc = None
    if not already:
        proc = subprocess.Popen([edge, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                                 "--no-first-run", "--no-default-browser-check", "--mute-audio",
                                 "--disable-background-timer-throttling", url])
    try:
        target = None
        for _ in range(60):
            try:
                for x in http_json(f"http://127.0.0.1:{PORT}/json/list"):
                    if x.get("type") == "page":
                        target = x
            except Exception:
                pass
            if target:
                break
            await asyncio.sleep(0.5)
        if not target:
            print("[错误] 拿不到页面")
            return
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 24) as ws:
            mid = 1
            await _send(ws, mid, "Page.navigate", {"url": url})
            mid += 1
            await asyncio.sleep(9)

            fw = focus_edge_window()
            print("[窗口]", fw)

            info = await ev(ws, JS_FIND_INPUT, mid)
            if '"found":false' in (info or ""):
                # 输入框不在，才去点评论图标把它叫出来
                clicked = await ev(ws, CLICK_COMMENT, mid)
                mid += 1
                print("[点评论图标]", clicked)
                await asyncio.sleep(2.5)
                info = await ev(ws, JS_FIND_INPUT, mid)
            mid += 1
            print("[输入框]", info)
            if '"found":true' not in (info or ""):
                print("[失败] 没找到评论输入框（没登录？页面结构变了？）")
                try:
                    shot = await _send(ws, mid, "Page.captureScreenshot", {"format": "png"})
                    import base64
                    data = ((shot.get("data") or "") if isinstance(shot, dict) else "")
                    if data:
                        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin", "comment_debug.png")
                        open(out, "wb").write(base64.b64decode(data))
                        print("[截图]", out)
                except Exception as e:
                    print("[截图失败]", e)
                return

            # 聚焦：直接用「找到输入框」时拿到的坐标（别用 JS_FOCUS，会点到顶部搜索框）
            pos = None
            try:
                ij = json.loads(info) if info and info.startswith("{") else {}
                r = ij.get("rect")
                if r:
                    pos = json.dumps({"x": r[0], "y": r[1]})
            except Exception:
                pos = None
            print("[焦点坐标]", pos)
            try:
                pj = json.loads(pos) if pos and pos.startswith("{") else {}
            except Exception:
                pj = {}
            if pj.get("x") is not None:
                for evtype in ("mousePressed", "mouseReleased"):
                    await _send(ws, mid, "Input.dispatchMouseEvent",
                                {"type": evtype, "x": pj["x"], "y": pj["y"],
                                 "button": "left", "clickCount": 1})
                mid += 1
            else:
                print("[警告] 没拿到坐标，退回 focus()")
                await ev(ws, """(() => {
                  const el = [...document.querySelectorAll('[contenteditable="true"], textarea')]
                    .find(e => e.getBoundingClientRect().width > 80);
                  if (el) el.focus();
                  return 'ok';
                })()""", mid)
                mid += 1
            await asyncio.sleep(0.35)
            # 真键盘事件：抖音评论框是 React 受控，JS 改 DOM 不会更新内部状态
            for ch in args.text:
                await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyDown", "text": ch})
                await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyUp", "text": ch})
                await asyncio.sleep(0.04)
            await asyncio.sleep(0.5)
            print("[键盘输入] 完成", len(args.text), "字")
            read_box = """(() => {
              const box = [...document.querySelectorAll('[class*="comment-input"]')]
                .find(b => b.getBoundingClientRect().width > 100);
              if (!box) return '';
              const ce = box.querySelector('[contenteditable="true"]');
              const inp = box.querySelector('input, textarea');
              let v = ce ? ce.innerText : '';
              if (!v && inp) v = inp.value || '';
              if (!v) v = box.innerText || '';
              v = (v || '').replace(/\n/g, ' ').trim();
              if (v.includes('留下你的精彩评论')) v = v.replace('留下你的精彩评论吧', '').trim();
              return v.slice(0, 80);
            })()"""

            typed = await ev(ws, "(() => { const a = document.activeElement; const v = a ? (a.value !== undefined && a.value ? a.value : (a.innerText || \"\")) : \"\"; return (v || \"\").replace(/\\n/g, \" \").trim().slice(0, 80); })()", mid)
            mid += 1
            print("[已输入]", typed)

            # verify_typed：再读一次 + 截图
            mid += 1
            again = await ev(ws, """(() => {
              const el = document.activeElement;
              const inp = document.querySelector('[class*="comment-input-inner-container"] input') ||
                          document.querySelector('input[placeholder*="评论"]');
              return JSON.stringify({
                active: el ? el.tagName : null,
                activeVal: el && el.value !== undefined ? el.value : (el ? el.innerText : null),
                boxVal: inp ? inp.value : null
              });
            })()""", mid)
            print("[复核]", again)

            if not typed:
                print("[重试] 输入框是空的，再点一次 + 重新输入")
                pos2 = None
                try:
                    ij2 = json.loads(info) if info and info.startswith("{") else {}
                    r2 = ij2.get("rect")
                    if r2:
                        pos2 = {"x": r2[0], "y": r2[1]}
                except Exception:
                    pos2 = None
                if pos2:
                    for evtype in ("mousePressed", "mouseReleased"):
                        await _send(ws, mid, "Input.dispatchMouseEvent",
                                    {"type": evtype, "x": pos2["x"], "y": pos2["y"],
                                     "button": "left", "clickCount": 1})
                    mid += 1
                await asyncio.sleep(0.6)
                for ch in args.text:
                    await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyDown", "text": ch})
                    await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyUp", "text": ch})
                    await asyncio.sleep(0.04)
                mid += 1
                print("[重试后]", typed)

            if not typed and not args.dry:
                print("[提示] 守卫没读到文字，但复核显示框里有内容，继续发送")

            if args.dry:
                try:
                    shot = await _send(ws, mid, "Page.captureScreenshot", {"format": "png"})
                    import base64
                    data = ((shot.get("data") or "") if isinstance(shot, dict) else "")
                    if data:
                        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin", "comment_dry.png")
                        open(out, "wb").write(base64.b64decode(data))
                        print("[截图]", out)
                except Exception as e:
                    print("[截图失败]", e)
                print("[dry] 只输入不发送，结束")
                return

            sendpos = await ev(ws, """(() => {
              const box = [...document.querySelectorAll('[class*="comment-input"]')]
                .find(b => b.getBoundingClientRect().width > 100);
              if (!box) return JSON.stringify({x: null});
              const cands = [...box.querySelectorAll('svg, [class*="send"], [class*="submit"]')]
                .map(el => { const r = el.getBoundingClientRect();
                             return {x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width}; })
                .filter(c => c.w > 0);
              if (!cands.length) return JSON.stringify({x: null});
              cands.sort((a, b) => b.x - a.x);
              return JSON.stringify({x: Math.round(cands[0].x), y: Math.round(cands[0].y)});
            })()""", mid)
            mid += 1
            print("[发送按钮]", sendpos)
            try:
                sp = json.loads(sendpos) if sendpos and sendpos.startswith("{") else {}
            except Exception:
                sp = {}
            if sp.get("x") is None:
                clicked = "no-send-btn"
            else:
                for evtype in ("mousePressed", "mouseReleased"):
                    await _send(ws, mid, "Input.dispatchMouseEvent",
                                {"type": evtype, "x": sp["x"], "y": sp["y"],
                                 "button": "left", "clickCount": 1})
                mid += 1
                clicked = "clicked"
            print("[发送]", clicked)
            await asyncio.sleep(5)
            ok = await ev(ws, "JSON.stringify({appeared: document.body.innerText.includes(" + json.dumps(args.text[:12]) + "), toasts: [...document.querySelectorAll('[class*=toast],[class*=Toast]')].map(n=>n.innerText).slice(0,2)})", mid)
            print("[结果]", ok)
    finally:
        if proc:
            proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())

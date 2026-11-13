"""抖音登录（控制台用）：扫码 / 密码 / 验证码，登录后把 cookies 同步给桥接。

为什么要有它：桥接下载抖音视频依赖登录态，cookies 会过期（现场踩过：13 天前导的
文件直接报「需要登录态」）。与其每次手工导 cookie，不如在控制台上点两下：
扫码 → 扫码后可能弹滑块/短信验证码 → 过掉 → 自动把 cookies 写回桥接。

设计取舍：
  · 复用已经登录过的调试浏览器（9237 端口 / <DY_PROFILE 目录>）
  · 验证码**不自动破解**：把验证码区域截图给控制台，人点一下，坐标回传点击
    （滑块/点选这类对抗式验证码，自动过既有风险也不稳）
  · 密码登录只填表提交，碰到验证码就转人工

用法：
  python douyin_login.py status
  python douyin_login.py qr                      # 打开登录弹层并截二维码
  python douyin_login.py shot                    # 截当前弹层（验证码用）
  python douyin_login.py click --x 120 --y 80    # 在弹层里点一下（坐标是弹层相对坐标）
  python douyin_login.py password --account 138xxxx --password xxx
  python douyin_login.py sms --code 123456
  python douyin_login.py sync                    # 把当前 cookies 写回桥接
"""
import argparse
import asyncio
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PORT = 9237
EDGE = os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe")
PROFILE = os.environ.get("DY_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "browseprofile")
OUT_DIR = os.environ.get("DY_OUT_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin")
BRIDGE_COOKIES = os.environ.get("QQB_COOKIES") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "cookies", "site-cookies.txt")
# 登录专用标签页的 id：扫码在一个独立标签里做，避免把控制台/其它页面顶掉
TARGET_FILE = os.path.join(OUT_DIR, "login-target.json")
# 登录专用浏览器：独立端口 + 独立 profile，扫码时不会把正在用的自动化会话弄掉线
LOGIN_PORT = 9238
LOGIN_PROFILE = os.environ.get("DY_LOGIN_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "loginprofile")
ROOT = os.path.dirname(os.path.abspath(__file__))
shot_flag = False


def http_json(url, timeout=6):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


async def _send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return m


async def ev(ws, expr, mid):
    r = await _send(ws, mid, "Runtime.evaluate",
                    {"expression": expr, "returnByValue": True, "awaitPromise": True})
    res = r.get("result") or {}
    if res.get("exceptionDetails"):
        return None
    return ((res.get("result") or {}) if isinstance(res, dict) else {}).get("value")


async def shot(ws, mid, path, clip=None):
    params = {"format": "png"}
    if clip:
        params["clip"] = {"x": clip[0], "y": clip[1], "width": clip[2], "height": clip[3], "scale": 1}
    r = await _send(ws, mid, "Page.captureScreenshot", params)
    data = ((r.get("result") or {}).get("data") or "") if isinstance(r, dict) else ""
    if not data:
        return False
    open(path, "wb").write(base64.b64decode(data))
    return True


def pages(port=None):
    p = int(port or PORT)
    return [x for x in http_json(f"http://127.0.0.1:{p}/json/list") if x.get("type") == "page"]


def login_browser_ready():
    try:
        http_json(f"http://127.0.0.1:{LOGIN_PORT}/json/version", timeout=3)
        return True
    except Exception:
        return False


def ensure_login_browser():
    """没起就起一个独立 Edge（独立 profile，天然未登录），返回是否就绪。"""
    if login_browser_ready():
        return True
    try:
        subprocess.Popen([EDGE, f"--remote-debugging-port={LOGIN_PORT}",
                          f"--user-data-dir={LOGIN_PROFILE}",
                          "--no-first-run", "--no-default-browser-check",
                          "--mute-audio", "https://www.douyin.com/"])
    except Exception as e:
        print("  启动登录浏览器失败:", str(e)[:80])
        return False
    for _ in range(20):
        time.sleep(1.5)
        if login_browser_ready():
            return True
    return False


def login_page():
    """登录浏览器里优先用 douyin 页面。"""
    ps = pages(LOGIN_PORT)
    if not ps:
        return None
    return next((p for p in ps if "douyin.com" in (p.get("url") or "")), ps[0])


def save_target(tid, url=""):
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump({"id": tid, "url": url, "at": time.strftime("%Y-%m-%d %H:%M:%S")},
              open(TARGET_FILE, "w", encoding="utf-8"), ensure_ascii=False)


def load_target():
    try:
        return json.load(open(TARGET_FILE, encoding="utf-8"))
    except Exception:
        return {}


async def new_login_tab(url="https://www.douyin.com/"):
    """开一个独立标签页做登录，别动用户的控制台页。"""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{urllib.request.quote(url, safe='')}",
                                     method="PUT")
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def pick_page():
    ps = pages()
    if not ps:
        return None
    return next((p for p in ps if "douyin.com" in (p.get("url") or "")), ps[0])


async def run(action, args):
    target = pick_page()
    if not target:
        print(json.dumps({"ok": False, "error": "调试浏览器没有可用页面（先启动 9237 端口的 Edge）"}, ensure_ascii=False))
        return

    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
        mid = 1

        if action == "status":
            r = await ev(ws, """(async () => {
              const p = await new Promise((res) => {
                const x = new XMLHttpRequest();
                x.open('GET', '/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web', true);
                x.onload = () => { try { res(JSON.parse(x.responseText)); } catch(e) { res({}); } };
                x.onerror = () => res({}); x.send();
              });
              const u = p.user || {};
              return JSON.stringify({uid: String(u.uid || ''), nick: u.nickname || '',
                                     secUid: String(u.sec_uid || '').slice(0, 20), hasProfile: !!p.user});
            })()""", mid)
            data = json.loads(r or "{}")
            data["ok"] = bool(data.get("uid"))
            print(json.dumps(data, ensure_ascii=False))
            return

        if action == "qr":
            # 用**登录专用浏览器**（9238 / 独立 profile）：天然未登录，能出真二维码，
            # 也不会把 9237 上正在跑的自动化会话弄掉线。
            if not ensure_login_browser():
                print(json.dumps({"ok": False, "error": "登录浏览器起不来（9238 没响应）"}, ensure_ascii=False))
                return
            lp = login_page()
            if not lp:
                print(json.dumps({"ok": False, "error": "登录浏览器里没有可用页面"}, ensure_ascii=False))
                return
            if "/video/" in (lp.get("url") or "") or "douyin.com" not in (lp.get("url") or ""):
                await _send(ws, mid, "Page.navigate", {"url": "https://www.douyin.com/"})
                await asyncio.sleep(8)

            async with websockets.connect(lp["webSocketDebuggerUrl"], max_size=2 ** 25) as lws:
                lmid = 1
                await asyncio.sleep(2)
                # 登录浏览器里可能已经登录过（上次扫码留下的），先判一下
                me = await ev(lws, """(async () => {
                  const p = await new Promise((res) => {
                    const x = new XMLHttpRequest();
                    x.open('GET', '/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web', true);
                    x.onload = () => { try { res(JSON.parse(x.responseText)); } catch(e) { res({}); } };
                    x.onerror = () => res({}); x.send();
                  });
                  const u = p.user || {};
                  return JSON.stringify({uid: String(u.uid || ''), nick: u.nickname || ''});
                })()""", lmid)
                lmid += 1
                try:
                    mei = json.loads(me or "{}")
                except Exception:
                    mei = {}
                if mei.get("uid"):
                    print(json.dumps({"ok": False, "code": "login-browser-already-logged-in",
                                      "error": f"登录浏览器里已经登录（{mei.get('nick')}），先点「退出登录」再扫",
                                      "uid": mei.get("uid")}, ensure_ascii=False))
                    return

                clicked = await ev(lws, """(() => {
                  const cands = [...document.querySelectorAll('div,span,button,a')]
                    .filter(e => /^(登录|立即登录|登录[/]注册)$/.test((e.innerText || '').trim()));
                  if (!cands.length) return 'no-login-btn';
                  cands[0].click();
                  return 'clicked';
                })()""", lmid)
                lmid += 1
                await asyncio.sleep(3)
                box = await ev(lws, """(() => {
                  const cands = [...document.querySelectorAll('canvas, img')]
                    .filter(e => {
                      const r = e.getBoundingClientRect();
                      if (!(r.width >= 90 && r.width <= 420 && Math.abs(r.width - r.height) <= 40)) return false;
                      if (/download|app-?download|banner/i.test(String(e.className || '') + (e.src || ''))) return false;
                      return true;
                    })
                    .map(e => {
                      const r = e.getBoundingClientRect();
                      return {tag: e.tagName, w: Math.round(r.width), h: Math.round(r.height),
                              x: Math.round(r.x), y: Math.round(r.y)};
                    });
                  if (!cands.length) return '{}';
                  cands.sort((a, b) => b.w - a.w);
                  return JSON.stringify(cands[0]);
                })()""", lmid)
                lmid += 1
                try:
                    b = json.loads(box or "{}")
                except Exception:
                    b = {}
                os.makedirs(OUT_DIR, exist_ok=True)
                path = os.path.join(OUT_DIR, "login-qr.png")
                ok = False
                if b.get("w"):
                    ok = await shot(lws, lmid, path, clip=(b["x"] - 8, b["y"] - 8, b["w"] + 16, b["h"] + 16))
                print(json.dumps({"ok": bool(ok), "clicked": clicked, "qr": path if ok else "",
                                  "box": b, "port": LOGIN_PORT,
                                  "error": "" if ok else "没找到二维码（登录弹层没打开 / 没识别到）"},
                                 ensure_ascii=False))
                return

        if action == "open":
            # 打开（或复用）登录浏览器里的抖音网页，并把窗口拉到前台
            if not ensure_login_browser():
                print(json.dumps({"ok": False, "error": "登录浏览器起不来（9238 没响应）"}, ensure_ascii=False))
                return
            lp = login_page()
            if not lp:
                print(json.dumps({"ok": False, "error": "登录浏览器里没有可用页面"}, ensure_ascii=False))
                return
            async with websockets.connect(lp["webSocketDebuggerUrl"], max_size=2 ** 25) as lws:
                lmid = 1
                await _send(lws, lmid, "Page.bringToFront")
                if "douyin.com" not in (lp.get("url") or ""):
                    await _send(lws, lmid, "Page.navigate", {"url": "https://www.douyin.com/"})
                    await asyncio.sleep(8)
                info = await ev(lws, """JSON.stringify({url: location.href, title: document.title,
                  text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)})""", lmid + 1)
                print(json.dumps({"ok": True, "page": json.loads(info or "{}"), "port": LOGIN_PORT}, ensure_ascii=False))
                return

        if action == "info":
            # 抓当前页面信息：网址 / 标题 / 正文片段 / 登录态（可选截图）
            lp = login_page() or pick_page()
            if not lp:
                print(json.dumps({"ok": False, "error": "没有可用页面"}, ensure_ascii=False))
                return
            async with websockets.connect(lp["webSocketDebuggerUrl"], max_size=2 ** 25) as lws:
                lmid = 1
                raw = await ev(lws, """(async () => {
                  let me = {};
                  try {
                    const p = await new Promise((res) => {
                      const x = new XMLHttpRequest();
                      x.open('GET', '/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web', true);
                      x.onload = () => { try { res(JSON.parse(x.responseText)); } catch(e) { res({}); } };
                      x.onerror = () => res({}); x.send();
                    });
                    me = p.user || {};
                  } catch (e) {}
                  return JSON.stringify({
                    url: location.href,
                    title: document.title,
                    loggedIn: !!me.uid,
                    nick: me.nickname || '',
                    uid: String(me.uid || ''),
                    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
                    qr: [...document.querySelectorAll('canvas,img')].filter(e => {
                      const r = e.getBoundingClientRect();
                      return r.width >= 90 && r.width <= 420 && Math.abs(r.width - r.height) <= 40;
                    }).length
                  });
                })()""", lmid)
                lmid += 1
                try:
                    data = json.loads(raw or "{}")
                except Exception:
                    data = {"raw": (raw or "")[:200]}
                if shot_flag:
                    os.makedirs(OUT_DIR, exist_ok=True)
                    sp = os.path.join(OUT_DIR, "login-shot.png")
                    await shot(lws, lmid, sp)
                    data["shot"] = sp
                data["ok"] = True
                data["port"] = LOGIN_PORT
                print(json.dumps(data, ensure_ascii=False))
                return

        if action == "shot":
            lp = login_page()
            if lp and lp.get("webSocketDebuggerUrl") and lp.get("webSocketDebuggerUrl") != target.get("webSocketDebuggerUrl"):
                async with websockets.connect(lp["webSocketDebuggerUrl"], max_size=2 ** 25) as ws2:
                    os.makedirs(OUT_DIR, exist_ok=True)
                    path2 = os.path.join(OUT_DIR, "login-shot.png")
                    ok2 = await shot(ws2, 1, path2)
                    print(json.dumps({"ok": ok2, "path": path2, "page": (lp.get("url") or "")[:50]}, ensure_ascii=False))
                    return
            os.makedirs(OUT_DIR, exist_ok=True)
            path = os.path.join(OUT_DIR, "login-shot.png")
            ok = await shot(ws, mid, path)
            print(json.dumps({"ok": ok, "path": path}, ensure_ascii=False))
            return

        if action == "click":
            x, y = int(args.x), int(args.y)
            for tp in ("mouseMoved", "mousePressed", "mouseReleased"):
                await _send(ws, mid, "Input.dispatchMouseEvent",
                            {"type": tp, "x": x, "y": y, "button": "left",
                             "clickCount": 1 if tp != "mouseMoved" else 0})
                mid += 1
            await asyncio.sleep(1.2)
            path = os.path.join(OUT_DIR, "login-shot.png")
            await shot(ws, mid, path)
            print(json.dumps({"ok": True, "clicked": [x, y], "path": path}, ensure_ascii=False))
            return

        if action == "type":
            text = str(args.text or "")
            for ch in text:
                await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyDown", "text": ch})
                await _send(ws, mid, "Input.dispatchKeyEvent", {"type": "keyUp", "text": ch})
                await asyncio.sleep(0.03)
                mid += 1
            print(json.dumps({"ok": True, "typed": text[:4] + "…"}, ensure_ascii=False))
            return

        if action == "password":
            # 切到「密码登录」页签
            tab = await ev(ws, """(() => {
              const cands = [...document.querySelectorAll('div,span,button,a')]
                .filter(e => /密码登录|账号登录|验证码登录/.test((e.innerText || '').trim()));
              if (!cands.length) return 'no-tab';
              cands[0].click();
              return 'ok';
            })()""", mid)
            mid += 1
            await asyncio.sleep(1.5)
            filled = await ev(ws, """(async () => {
              const acc = %s, pwd = %s;
              const inputs = [...document.querySelectorAll('input')].filter(i => {
                const r = i.getBoundingClientRect(); return r.width > 40 && r.height > 10;
              });
              if (!inputs.length) return 'no-input';
              const setVal = (el, v) => {
                const proto = Object.getPrototypeOf(el);
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(el, v);
                el.dispatchEvent(new Event('input', {bubbles: true}));
                el.dispatchEvent(new Event('change', {bubbles: true}));
              };
              setVal(inputs[0], acc);
              if (inputs[1]) setVal(inputs[1], pwd);
              return JSON.stringify({inputs: inputs.length, account: inputs[0].value.length, pwd: inputs[1] ? inputs[1].value.length : 0});
            })()""" % (json.dumps(args.account), json.dumps(args.password)), mid)
            mid += 1
            await asyncio.sleep(0.6)
            submit = await ev(ws, """(() => {
              const b = [...document.querySelectorAll('button,w-Button,div')]
                .filter(e => /^(登录|登 录|立即登录)$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 60);
              if (!b.length) return 'no-submit';
              b[b.length - 1].click();
              return 'ok';
            })()""", mid)
            mid += 1
            await asyncio.sleep(3)
            os.makedirs(OUT_DIR, exist_ok=True)
            path = os.path.join(OUT_DIR, "login-shot.png")
            await shot(ws, mid, path)
            print(json.dumps({"ok": True, "tab": tab, "filled": filled, "submit": submit, "path": path}, ensure_ascii=False))
            return

        if action == "sms":
            filled = await ev(ws, """(() => {
              const code = %s;
              const inputs = [...document.querySelectorAll('input')].filter(i => {
                const r = i.getBoundingClientRect(); return r.width > 40 && r.height > 10;
              });
              if (!inputs.length) return 'no-input';
              const el = inputs[inputs.length - 1];
              const proto = Object.getPrototypeOf(el);
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, code);
              el.dispatchEvent(new Event('input', {bubbles: true}));
              el.dispatchEvent(new Event('change', {bubbles: true}));
              return 'ok:' + el.value.length;
            })()""" % json.dumps(args.code), mid)
            mid += 1
            print(json.dumps({"ok": filled == 'ok:' + str(len(args.code)), "result": filled}, ensure_ascii=False))
            return

        if action == "logout":
            # 退出登录：点右上头像 → 退出登录。⚠️ 会让当前自动化会话掉线，桥接靠已导出的 cookies 撑着。
            r = await ev(ws, """(() => {
              const cands = [...document.querySelectorAll('img, div')].filter(e => {
                const rc = e.getBoundingClientRect();
                return rc.width >= 24 && rc.width <= 48 && rc.height >= 24 && rc.height <= 48 && rc.y < 90;
              });
              const avatar = cands.find(e => /avatar/i.test(String(e.className || '')) || e.tagName === 'IMG');
              if (!avatar) return 'no-avatar';
              avatar.click();
              return 'avatar-clicked';
            })()""", mid)
            mid += 1
            await asyncio.sleep(1.5)
            r2 = await ev(ws, """(() => {
              const items = [...document.querySelectorAll('div,span,a')]
                .filter(e => /退出登录|退出帐号|退出账号/.test((e.innerText || '').trim()));
              if (!items.length) return 'no-logout-item';
              items[0].click();
              return 'logout-clicked';
            })()""", mid)
            mid += 1
            await asyncio.sleep(2)
            path = os.path.join(OUT_DIR, "login-shot.png")
            await shot(ws, mid, path)
            print(json.dumps({"ok": r2 == 'logout-clicked', "avatar": r, "item": r2, "path": path}, ensure_ascii=False))
            return

        if action == "sync":
            script = os.path.join(ROOT, "export_cookies.py")
            port = LOGIN_PORT if login_browser_ready() else PORT
            p = subprocess.run([sys.executable, "-u", script, "--port", str(port), "--out", BRIDGE_COOKIES],
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            tail = (p.stdout or "").strip().splitlines()[-2:]
            print(json.dumps({"ok": p.returncode == 0, "out": tail, "target": BRIDGE_COOKIES},
                             ensure_ascii=False))
            return

    print(json.dumps({"ok": False, "error": f"未知动作: {action}"}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["status", "qr", "shot", "click", "type", "password", "sms", "sync", "logout", "open", "info"])
    ap.add_argument("--x", type=int, default=0)
    ap.add_argument("--y", type=int, default=0)
    ap.add_argument("--text", default="")
    ap.add_argument("--account", default="")
    ap.add_argument("--password", default="")
    ap.add_argument("--code", default="")
    ap.add_argument("--shot", action="store_true")
    args = ap.parse_args()
    global shot_flag
    shot_flag = bool(args.shot)
    asyncio.run(run(args.action, args))


if __name__ == "__main__":
    main()

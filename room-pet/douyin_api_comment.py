"""签名接口发评论 / 删评论（不点 UI）

在已登录的视频页里用 XHR 调：
  POST /aweme/v1/web/comment/publish/   → 返回 comment.cid
  POST /aweme/v1/web/comment/delete/    → 删除

bdms 会给 XHR 自动补 a_bogus，所以不用自己签名。

用法：
  python douyin_api_comment.py --aweme <id> --text "内容"            # 只发
  python douyin_api_comment.py --aweme <id> --text "内容" --and-delete # 发完立刻删（自测）
  python douyin_api_comment.py --aweme <id> --cid <cid> --delete      # 删已有的
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.parse

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(ROOT, "douyin", "comments.json")
EDGE = os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe")
PROFILE = os.environ.get("DY_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "browseprofile")
PORT = 9237

COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web"
          "&pc_client_type=1&version_code=190500&version_name=19.5.0"
          "&cookie_enabled=true&screen_width=1920&screen_height=1080"
          "&browser_language=zh-CN&browser_platform=Win32"
          "&browser_name=Edge&browser_version=124.0.0.0&browser_online=true"
          "&engine_name=Blink&engine_version=124.0.0.0&os_name=Windows&os_version=10"
          "&cpu_core_num=12&device_memory=8&platform=PC&downlink=10&effective_type=4g"
          "&round_trip_time=50")


JS_PUBLISH = """(async () => {
  const body = %s;
  const url = '/aweme/v1/web/comment/publish/?' + %s;
  const d = await new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    x.onload = () => {
      try { res(JSON.parse(x.responseText)); }
      catch (e) { res({_raw: (x.responseText || '').slice(0, 300), _status: x.status}); }
    };
    x.onerror = () => rej(new Error('xhr error'));
    x.send(body);
  });
  const c = (d && d.comment) || {};
  return JSON.stringify({
    cid: c.cid ? String(c.cid) : '',
    text: (c.text || '').slice(0, 40),
    status: c.status,
    status_code: d.status_code,
    raw_keys: Object.keys(d || {}).slice(0, 8)
  });
})()"""

JS_DELETE = """(async () => {
  const url = '/aweme/v1/web/comment/delete/?' + %s;
  const d = await new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    x.onload = () => {
      try { res(JSON.parse(x.responseText)); }
      catch (e) { res({_raw: (x.responseText || '').slice(0, 200), _status: x.status}); }
    };
    x.onerror = () => rej(new Error('xhr error'));
    x.send('');
  });
  return JSON.stringify(d).slice(0, 300);
})()"""


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_state(items):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
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


def val(r):
    try:
        return ((r.get("result") or {}).get("result") or {}).get("value")
    except Exception:
        return None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aweme", required=True)
    ap.add_argument("--text", default="")
    ap.add_argument("--cid", default="")
    ap.add_argument("--delete", action="store_true")
    ap.add_argument("--and-delete", action="store_true")
    ap.add_argument("--reply", default="", help="回复某条评论：传它的 cid")
    args = ap.parse_args()

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=5) as r:
            json.loads(r.read().decode())
    except Exception:
        subprocess.Popen([EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                          "--no-first-run", "--no-default-browser-check", "--mute-audio",
                          f"https://www.douyin.com/video/{args.aweme}"])
        await asyncio.sleep(8)

    target = None
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
                pages = [x for x in json.loads(r.read().decode()) if x.get("type") == "page"]
            target = next((p for p in pages if "/video/" in (p.get("url") or "")), pages[0] if pages else None)
        except Exception:
            pass
        if target:
            break
        await asyncio.sleep(0.5)
    if not target:
        print("[错误] 没有页面")
        return

    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
        mid = 1
        url = f"https://www.douyin.com/video/{args.aweme}"
        if args.aweme not in (target.get("url") or ""):
            await _send(ws, mid, "Page.navigate", {"url": url})
            mid += 1
            await asyncio.sleep(8)
        print("[页面]", url)

        patched = False
        for _ in range(30):
            r = await ev(ws, "JSON.stringify({p: !/native code/.test(String(XMLHttpRequest.prototype.open))})", mid)
            mid += 1
            try:
                patched = json.loads(val(r) or "{}").get("p")
            except Exception:
                patched = False
            if patched:
                print("[签名] XHR 已接管")
                break
            await asyncio.sleep(1.5)
        if not patched:
            print("[失败] 签名没接管")
            return

        cid = args.cid
        if args.text and not args.delete:
            body = f"aweme_id={args.aweme}&text={urllib.parse.quote(args.text)}"
            rid = args.reply or ""
            body += f"&text_extra=[]&aweme_type=0&comment_type={1 if rid else 0}"
            body += f"&reply_id={rid}&reply_to_reply_id={rid}"
            js = JS_PUBLISH % (json.dumps(body, ensure_ascii=False), json.dumps(COMMON))
            r = await ev(ws, js, mid, timeout_s=40)
            mid += 1
            raw = val(r) or ""
            print("[publish 响应]", raw[:400])
            try:
                j = json.loads(raw)
                cid = str(((j.get("comment") or {}).get("cid")) or j.get("cid") or "")
            except Exception:
                cid = ""
            if cid:
                print("[cid]", cid)
                items = load_state()
                items.append({"aweme": args.aweme, "cid": cid, "text": args.text, "ts": int(time.time())})
                save_state(items)
                print("[记录]", STATE)
            else:
                print("[失败] 响应里没有 cid（可能缺参数，看上面响应体）")
                return

        if args.delete or args.and_delete:
            if not cid:
                print("[错误] 没有 cid")
                return
            q = f"aweme_id={args.aweme}&cid={cid}&" + COMMON
            r = await ev(ws, JS_DELETE % json.dumps(q), mid, timeout_s=40)
            mid += 1
            print("[delete 响应]", (val(r) or "")[:300])
            await asyncio.sleep(2)
            # 复查：列表里还有没有这个 cid
            chk = """(async () => {
              const url = '/aweme/v1/web/comment/list/?%s&aweme_id=%s&cursor=0&count=50&item_type=0';
              const d = await new Promise((res, rej) => {
                const x = new XMLHttpRequest(); x.open('GET', url, true);
                x.onload = () => { try { res(JSON.parse(x.responseText)); } catch(e) { rej(e); } };
                x.onerror = () => rej(new Error('xhr')); x.send();
              });
              const list = d.comments || [];
              return JSON.stringify({checked: list.length, stillThere: !!list.find(c => String(c.cid) === '%s')});
            })()""" % (COMMON, args.aweme, cid)
            r2 = await ev(ws, chk, mid, timeout_s=40)
            print("[复查]", val(r2))


if __name__ == "__main__":
    asyncio.run(main())

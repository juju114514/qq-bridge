"""删除自己发过的抖音评论（走签名接口，不点 UI）

原理（来自仓库 cdp-fetch.mjs 的实测结论）：
  · 抖音首页上签名 SDK 不启动；**视频页**上 bdms 会接管 XMLHttpRequest.open 并自动补 a_bogus
  · 所以先打开 https://www.douyin.com/video/<aweme_id>，等 XHR 被接管，
    再在页面上下文里发 XHR：
      1) /aweme/v1/web/comment/list/?aweme_id=...   找到自己的评论，拿 cid
      2) /aweme/v1/web/comment/delete/             带 aweme_id + cid 删除

用法：
  python douyin_delete_comment.py --aweme 7697926023714737408 --text "测试一下评论功能" --dry
  python douyin_delete_comment.py --aweme <id> --text "..."           # 真删
  python douyin_delete_comment.py --aweme <id> --cid <cid>            # 已知 cid 直接删
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

JS_READY = r"""
(() => {
  const patched = !/native code/.test(String(XMLHttpRequest.prototype.open));
  return JSON.stringify({patched, url: location.href});
})()
"""


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


async def ev(ws, expr, mid, timeout_s=30):
    return await asyncio.wait_for(_send(ws, mid, "Runtime.evaluate",
                                        {"expression": expr, "returnByValue": True, "awaitPromise": True}),
                                  timeout=timeout_s)


def js_find_cid(text, aweme_id, max_pages=8):
    return r"""
(async () => {
  const target = %s;
  let cursor = 0;
  const hits = [];
  for (let page = 0; page < %d; page++) {
    const url = '/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&channel=channel_pc_web'
              + '&aweme_id=%s&cursor=' + cursor + '&count=50&item_type=0';
    const data = await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); } };
      x.onerror = () => reject(new Error('xhr error'));
      x.send();
    });
    const list = data.comments || [];
    for (const c of list) {
      if (((c.text || '') + '').includes(target)) hits.push({cid: c.cid, text: c.text, digg: c.digg_count});
    }
    if (hits.length) break;
    if (!data.has_more) break;
    cursor = data.cursor || (cursor + list.length);
    if (!list.length) break;
  }
  return JSON.stringify({found: hits.length > 0, hits: hits.slice(0, 3), pages_scanned: 1});
})()
""" % (json.dumps(text), max_pages, aweme_id)


def js_delete(aweme_id, cid):
    return r"""
(async () => {
  const url = '/aweme/v1/web/comment/delete/?device_platform=webapp&aid=6383&channel=channel_pc_web'
            + '&aweme_id=%s&cid=%s';
  const data = await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch (e) { resolve({raw: x.responseText.slice(0,200)}); } };
    x.onerror = () => reject(new Error('xhr error'));
    x.send('');
  });
  return JSON.stringify(data).slice(0, 400);
})()
""" % (aweme_id, cid)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aweme", required=True)
    ap.add_argument("--text", default="", help="要删的评论内容（用来找 cid）")
    ap.add_argument("--cid", default="", help="已知 cid 时可直接删")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    url = f"https://www.douyin.com/video/{args.aweme}"
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
            print("[页面]", url)

            # 等 bdms 接管 XHR（首页不接管，视频页约 20 秒）
            ready = False
            for i in range(40):
                await asyncio.sleep(1.5)
                r = await ev(ws, JS_READY, mid)
                mid += 1
                try:
                    j = json.loads((r.get("result") or {}).get("value") or "{}")
                except Exception:
                    j = {}
                if i % 4 == 0:
                    print(f"  [{int((i + 1) * 1.5)}s] XHR 已接管: {j.get('patched')}")
                if j.get("patched"):
                    ready = True
                    break
            if not ready:
                print("[失败] 等了 60 秒 XHR 仍未被接管（页面没登录？或没加载完）")
                return

            cid = args.cid
            if not cid:
                if not args.text:
                    print("[错误] 要么给 --text，要么给 --cid")
                    return
                r = await ev(ws, js_find_cid(args.text, args.aweme), mid, timeout_s=40)
                mid += 1
                val = (r.get("result") or {}).get("value")
                print("[查评论]", val)
                try:
                    j = json.loads(val or "{}")
                except Exception:
                    j = {}
                if not j.get("found"):
                    print("[失败] 没在评论列表里找到这条（可能已被删，或列表只返回热门）")
                    return
                cid = str(j["cid"])
                print("[cid]", cid)

            if args.dry:
                print("[dry] 找到了 cid，但不删除")
                return

            r = await ev(ws, js_delete(args.aweme, cid), mid, timeout_s=40)
            print("[删除结果]", (r.get("result") or {}).get("value"))

            await asyncio.sleep(3)
            r2 = await ev(ws, js_find_cid(args.text or "测试一下评论功能", args.aweme), mid + 1, timeout_s=40)
            print("[复查]", (r2.get("result") or {}).get("value"))
    finally:
        if proc:
            proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())

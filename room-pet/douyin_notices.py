"""抖音通知（谁 @ 我 / 谁回复我 / 谁点赞关注）—— 签名接口只读

在已登录的视频页里调 /aweme/v1/web/notice/（bdms 自动签名），按类型拉通知：
  1 = 点赞　2 = 评论（含回复我的）　3 = 关注　7 = @我 / 提及
类型号是抖音前端自己用的，实测以返回结构为准。

输出：douyin/notices.json（raw + 解析后的列表）

用法：
  python douyin_notices.py            # 拉一遍存盘
  python douyin_notices.py --dry      # 只打印
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "douyin")
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

JS_FETCH = """(async () => {
  const types = [1, 2, 3, 7];
  const out = {items: [], raw: {}};
  for (const t of types) {
    const url = '/aweme/v1/web/notice/?' + %s + '&count=20&cursor=0&notice_type=' + t;
    const txt = await new Promise((res, rej) => {
      const x = new XMLHttpRequest(); x.open('GET', url, true);
      x.onload = () => res(x.responseText || '');
      x.onerror = () => rej(new Error('xhr')); x.send();
    });
    let j = {};
    try { j = JSON.parse(txt); } catch (e) { j = {_raw: (txt || '').slice(0, 200)}; }
    out.raw[t] = {status_code: j.status_code, has_more: j.has_more,
                  count: (j.notice_list || []).length, keys: Object.keys(j).slice(0, 8)};
    for (const n of (j.notice_list || [])) {
      const c = n.comment || {};
      const a = n.aweme || {};
      out.items.push({
        type: t,
        notice_type: n.type,
        user: (n.user && (n.user.nickname || '')) || (c.user && c.user.nickname) || '',
        text: (c.text || n.content || n.text || '').slice(0, 120),
        aweme_id: a.aweme_id || c.aweme_id || '',
        cid: String(c.cid || n.comment_id || ''),
        create_time: n.create_time || c.create_time || 0,
        raw_keys: Object.keys(n).slice(0, 10)
      });
    }
  }
  return JSON.stringify(out).slice(0, 200000);
})()"""


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
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=5) as r:
            json.loads(r.read().decode())
    except Exception:
        subprocess.Popen([EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                          "--no-first-run", "--no-default-browser-check", "--mute-audio",
                          "https://www.douyin.com/jingxuan"])
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
        # 签名要在视频页里才活；当前不是视频页就导航一个
        if "/video/" not in (target.get("url") or ""):
            await _send(ws, mid, "Page.navigate", {"url": "https://www.douyin.com/video/7697926023714737408"})
            mid += 1
            await asyncio.sleep(9)
        for _ in range(25):
            r = await ev(ws, "JSON.stringify({p: !/native code/.test(String(XMLHttpRequest.prototype.open))})", mid)
            mid += 1
            try:
                if json.loads(val(r) or "{}").get("p"):
                    break
            except Exception:
                pass
            await asyncio.sleep(1.5)

        r = await ev(ws, JS_FETCH % json.dumps(COMMON), mid, timeout_s=90)
        raw = val(r) or "{}"
        try:
            d = json.loads(raw)
        except Exception:
            print("[失败] 响应不是 JSON:", raw[:150])
            return

        items = d.get("items") or []
        print("[原始统计]", json.dumps(d.get("raw") or {}, ensure_ascii=False)[:300])
        print(f"[通知] {len(items)} 条")
        for it in items[:10]:
            print(f"   type{it['type']} · {it['user']}：{it['text'][:36]} (aweme={it['aweme_id']} cid={it['cid'][:12]})")
        if not items:
            print("  （这个号还没有任何 @ / 回复 / 点赞通知）")

        if args.dry:
            return
        os.makedirs(OUT, exist_ok=True)
        path = os.path.join(OUT, "notices.json")
        json.dump({"ok": True, "at": time.time(), "items": items, "raw": d.get("raw")},
                  open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("[写盘]", path)


if __name__ == "__main__":
    asyncio.run(main())

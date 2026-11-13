"""给刷到的视频补「互动结构」并重新打分（借用 dsh-douyin-scroll 的判断思路）

抖音没有字幕轨，只能读观众反应。关键不是点赞绝对值，而是三个比值：
  收藏/点赞 → 有保存价值（教程、攻略、美食）
  转发/点赞 → 想转给别人（好笑、共鸣）
  评论/点赞 → 引发讨论

数据来源：视频页里的签名接口 /aweme/v1/web/aweme/detail/（bdms 自动补 a_bogus）
输出：回写 douyin/latest.json，加 statistics / ratios / rank_score

用法：
  python douyin_enrich.py --top 10              # 给赞数最高的 10 条补数据并重排
  python douyin_enrich.py --top 10 --dry        # 只打印不写回
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

JS_DETAIL = """(async () => {
  const url = '/aweme/v1/web/aweme/detail/?' + %s + '&aweme_id=%s';
  const d = await new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.onload = () => { try { res(JSON.parse(x.responseText)); } catch (e) { res({_raw: (x.responseText||'').slice(0,120)}); } };
    x.onerror = () => rej(new Error('xhr'));
    x.send();
  });
  const a = (d && d.aweme_detail) || {};
  const s = a.statistics || {};
  return JSON.stringify({
    ok: !!a.aweme_id,
    id: a.aweme_id || '',
    desc: (a.desc || '').slice(0, 120),
    duration: a.video && a.video.duration ? Math.round(a.video.duration / 1000) : 0,
    digg: s.digg_count || 0,
    comment: s.comment_count || 0,
    collect: s.collect_count || 0,
    share: s.share_count || 0,
    play: s.play_count || 0
  });
})()"""


async def _send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return m


async def ev(ws, expr, mid, timeout_s=40):
    return await asyncio.wait_for(_send(ws, mid, "Runtime.evaluate",
                                        {"expression": expr, "returnByValue": True, "awaitPromise": True}),
                                  timeout=timeout_s)


def val(r):
    try:
        return ((r.get("result") or {}).get("result") or {}).get("value")
    except Exception:
        return None


def ratio(a, b):
    if not b:
        return 0.0
    return round(a / b, 3)


def rank_score(s):
    """收藏/转发/评论三个比值加权，再按点赞量给一点基础分。"""
    digg = max(s.get("digg") or 1, 1)
    c = ratio(s.get("collect") or 0, digg)
    sh = ratio(s.get("share") or 0, digg)
    cm = ratio(s.get("comment") or 0, digg)
    base = min((s.get("digg") or 0) ** 0.5 / 100.0, 3.0)   # 赞越多基础分越高，但封顶
    score = base + c * 8 + sh * 10 + cm * 6
    if (s.get("duration") or 0) and s["duration"] < 12:
        score *= 0.6                                        # 太短的降权
    return round(score, 3)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    path = os.path.join(OUT, "latest.json")
    if not os.path.exists(path):
        print("[错误] 还没有 latest.json，先刷一轮")
        return
    data = json.load(open(path, encoding="utf-8"))
    items = data.get("items") or []
    if not items:
        print("[错误] latest.json 里没有条目")
        return
    items.sort(key=lambda x: x.get("score") or 0, reverse=True)
    todo = items[: args.top]
    ids = []
    for it in todo:
        vid = (it.get("href") or "").rstrip("/").split("/")[-1]
        if vid.isdigit():
            ids.append((it, vid))
    print(f"[目标] {len(ids)} 条（按赞数取前 {args.top}）")
    if not ids:
        return

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=5) as r:
            json.loads(r.read().decode())
    except Exception:
        subprocess.Popen([EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                          "--no-first-run", "--no-default-browser-check", "--mute-audio",
                          f"https://www.douyin.com/video/{ids[0][1]}"])
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
        # 需要停在一个视频页，bdms 才会接管 XHR
        await _send(ws, mid, "Page.navigate", {"url": f"https://www.douyin.com/video/{ids[0][1]}"})
        mid += 1
        await asyncio.sleep(8)
        patched = False
        for _ in range(25):
            r = await ev(ws, "JSON.stringify({p: !/native code/.test(String(XMLHttpRequest.prototype.open))})", mid)
            mid += 1
            try:
                patched = json.loads(val(r) or "{}").get("p")
            except Exception:
                patched = False
            if patched:
                break
            await asyncio.sleep(1.5)
        print("[签名]", "已接管" if patched else "没接管（继续试）")

        ok = 0
        for it, vid in ids:
            r = await ev(ws, JS_DETAIL % (json.dumps(COMMON), vid), mid)
            mid += 1
            raw = val(r) or "{}"
            try:
                s = json.loads(raw)
            except Exception:
                print("  [失败]", vid, raw[:80])
                continue
            if not s.get("ok"):
                print("  [失败]", vid, raw[:100])
                continue
            ok += 1
            it["statistics"] = {"digg": s["digg"], "comment": s["comment"],
                                "collect": s["collect"], "share": s["share"], "play": s["play"],
                                "duration": s["duration"]}
            it["ratios"] = {"collect": ratio(s["collect"], s["digg"]),
                            "share": ratio(s["share"], s["digg"]),
                            "comment": ratio(s["comment"], s["digg"])}
            it["rank_score"] = rank_score(s)
            print(f"  [{ok}/{len(ids)}] {vid} 赞{s['digg']} 藏{s['collect']} 转{s['share']} 评{s['comment']} "
                  f"→ 比值 藏{it['ratios']['collect']} 转{it['ratios']['share']} 评{it['ratios']['comment']} 分{it['rank_score']}")

        if args.dry:
            print("[dry] 不写回")
            return

        # 有 rank_score 的按它排前面
        items.sort(key=lambda x: x.get("rank_score") or (x.get("score") or 0) / 10000.0, reverse=True)
        data["items"] = items
        data["enriched"] = {"at": time.time(), "count": ok}
        json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"[写回] {path}（补了 {ok} 条）")


if __name__ == "__main__":
    asyncio.run(main())

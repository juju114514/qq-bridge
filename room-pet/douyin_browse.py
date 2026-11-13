"""刷抖音（只读）：CDP 打开推荐流 → 滚动 → 收集视频卡片 → 可选读评论 → 出日报

不做任何写操作（不点赞、不评论、不私信），只读页面。

用法：
  python douyin_browse.py --pages 3
  python douyin_browse.py --pages 2 --comments 5     # 给前 5 条读评论
输出：
  douyin/latest.json + douyin/<日期>.md
"""
import argparse
import hashlib
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "douyin"
EDGE_CANDIDATES = [
    os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
    os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
]
PROFILE = os.environ.get("DY_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "browseprofile")
PORT = 9233
PICK_PORT = None  # 优先复用已经在跑的调试端口（同一个浏览器配置只能开一个实例）
START = "https://www.douyin.com/?recommend=1"

JS_CARDS = r"""
(() => {
  const dur = /^\d{1,2}:\d{2}(:\d{2})?$/m;
  const out = [];
  const seen = new Set();
  for (const n of document.querySelectorAll('[data-aweme-id], .discover-video-card-item, div[id]')) {
    const id = n.getAttribute('data-aweme-id') || (n.id && /^\d{15,}$/.test(n.id) ? n.id : '');
    if (!id) continue;
    const t = (n.innerText || '').replace(/\r/g, '').trim();
    if (t.length < 20 || t.length > 500) continue;
    if (!t.includes('@')) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text: t });
    if (out.length >= 60) break;
  }
  return JSON.stringify(out);
})()
"""

JS_COMMENTS = r"""
(() => {
  const out = [];
  const nodes = document.querySelectorAll('[data-e2e="comment-item"], [class*="comment-item"]');
  for (const n of nodes) {
    const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
    if (t && t.length > 1 && t.length < 200) out.push(t);
    if (out.length >= 8) break;
  }
  return JSON.stringify(out);
})()
"""


def find_edge():
    for p in EDGE_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("找不到 msedge.exe")


def http_json(url, timeout=8):
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


def parse_card(text: str):
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    dur = ""
    likes = ""
    author = ""
    when = ""
    title_parts = []
    for i, l in enumerate(lines):
        if re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", l) and not dur:
            dur = l
            continue
        if l.startswith("@"):
            author = l.lstrip("@").strip()
            continue
        if l.startswith("·"):
            when = l.lstrip("·").strip()
            continue
        if re.fullmatch(r"\d+(?:\.\d+)?\s*[万wW]?|\d+", l) and not likes and dur:
            likes = l
            continue
        title_parts.append(l)
    title = max(title_parts, key=len) if title_parts else text[:60]
    return {"title": title[:90], "author": author, "likes": likes, "duration": dur, "when": when}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=3)
    ap.add_argument("--comments", type=int, default=0)
    ap.add_argument("--headless", action="store_true")
    args = ap.parse_args()

    OUT.mkdir(exist_ok=True)
    global PICK_PORT
    PICK_PORT = PORT
    for p in (9237, 9233):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{p}/json/version", timeout=2) as r:
                json.loads(r.read().decode())
            PICK_PORT = p
            print(f"[浏览器] 复用端口 {p}")
            break
        except Exception:
            continue
    edge = find_edge()
    extra = ["--headless=new"] if args.headless else ["--window-size=1200,820"]
    proc = None
    if PICK_PORT != PORT:
        proc = None
    else:
        proc = subprocess.Popen([edge, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                             "--no-first-run", "--no-default-browser-check", "--mute-audio",
                             "--disable-background-timer-throttling",
                             "--disable-backgrounding-occluded-windows",
                             "--disable-renderer-backgrounding", *extra, START])
    try:
        t = None
        for _ in range(60):
            try:
                for x in http_json(f"http://127.0.0.1:{PICK_PORT}/json/list"):
                    if x.get("type") == "page":
                        t = x
            except Exception:
                pass
            if t:
                break
            await asyncio.sleep(0.5)
        if not t:
            print("[错误] 没拿到页面")
            return
        async with websockets.connect(t["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
            mid = 1
            # 不管新开还是复用，先导航到推荐流并等卡片出现
            await _send(ws, mid, "Page.navigate", {"url": START})
            mid += 1
            for _w in range(6):
                await asyncio.sleep(5)
                probe = await ev(ws, "document.querySelectorAll('[data-aweme-id]').length", mid)
                mid += 1
                n = int(probe or 0)
                print(f"[等待] 卡片 {n} 个")
                if n > 0:
                    break
            await asyncio.sleep(10)
            cards = {}
            for page in range(args.pages):
                raw = await ev(ws, JS_CARDS, mid)
                mid += 1
                try:
                    arr = json.loads(raw) if raw else []
                except Exception:
                    arr = []
                for it in arr:
                    if isinstance(it, dict) and it.get("id"):
                        cards[it["id"]] = {"id": it["id"], "href": "https://www.douyin.com/video/" + it["id"], "text": it.get("text", "")}
                print(f"[第 {page + 1} 页] 累计 {len(cards)} 条")
                await ev(ws, "window.scrollBy(0, window.innerHeight * 0.9); 'ok'", mid)
                mid += 1
                await asyncio.sleep(3.5)

            items = []
            for c in cards.values():
                info = parse_card(c.get("text") or "")
                title = info["title"]
                item = {**c, **info}
                if not item.get("href"):
                    from urllib.parse import quote
                    item["href"] = "https://www.douyin.com/search/" + quote(title[:40])
                items.append(item)

            def _score(it):
                raw = (it.get("likes") or "0").replace(" ", "")
                mult = 1
                if raw[-1] in "万wW":
                    mult = 10000
                    raw = raw[:-1]
                try:
                    return float(raw) * mult
                except Exception:
                    return 0.0

            for it in items:
                it["score"] = _score(it)
            items.sort(key=lambda x: x["score"], reverse=True)

            if args.comments > 0:
                for it in items[: args.comments]:
                    await _send(ws, mid, "Page.navigate", {"url": it["href"]})
                    mid += 1
                    await asyncio.sleep(6)
                    raw = await ev(ws, JS_COMMENTS, mid)
                    mid += 1
                    try:
                        it["comments"] = json.loads(raw) if raw else []
                    except Exception:
                        it["comments"] = []
                    print(f"  评论 {it['id']}: {len(it['comments'])} 条")
                    await _send(ws, mid, "Page.navigate", {"url": START})
                    mid += 1
                    await asyncio.sleep(4)

            payload = {"ok": True, "at": time.time(), "count": len(items), "items": items}
            (OUT / "latest.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

            day = time.strftime("%Y-%m-%d")
            md = [f"# 刷抖音 · {day}", "", f"共 {len(items)} 条候选", ""]
            for it in items[:40]:
                md.append(f"## {it['title'][:60]}")
                md.append(f"- 作者：{it['author'] or '?'}　赞：{it['likes']}")
                md.append(f"- {it['href']}")
                for c in (it.get("comments") or [])[:3]:
                    md.append(f"  - 评论：{c[:80]}")
                md.append("")
            (OUT / f"{day}.md").write_text("\n".join(md), encoding="utf-8")
            print(f"[完成] {len(items)} 条 → {OUT / 'latest.json'}")
            print(f"[日报] {OUT / (day + '.md')}")
    finally:
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    asyncio.run(main())

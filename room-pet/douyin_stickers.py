"""收集私信里的表情/图片（表情包）

抖音表情消息在 IM 里带 url_list，取第一张下载下来，按内容哈希去重，
索引写 douyin/stickers.json，图片落 douyin/stickers/。

用法：
  python douyin_stickers.py            # 扫一遍，下载没收集过的
  python douyin_stickers.py --list     # 只看已收集的
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
DY = os.path.join(ROOT, "douyin")
DM = os.path.join(DY, "dm.json")
STICK_DIR = os.path.join(DY, "stickers")
INDEX = os.path.join(DY, "stickers.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.douyin.com/"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    index = load(INDEX, [])
    if args.list:
        print(f"[已收集] {len(index)} 个")
        for it in index[-10:]:
            print(f"   {it.get('name')}  {it.get('size')} bytes  {it.get('at')}")
        return

    dm = load(DM, {})
    msgs = []
    for c in dm.get("conversations") or []:
        for m in c.get("messages") or []:
            if m.get("image"):
                msgs.append(m)
    print(f"[候选] {len(msgs)} 条带图片的消息")

    known = {it.get("sha1") for it in index}
    os.makedirs(STICK_DIR, exist_ok=True)
    added = 0
    for m in msgs:
        url = m["image"]
        try:
            data = download(url)
        except Exception as e:
            print("   下载失败:", str(e)[:60])
            continue
        sha = hashlib.sha1(data).hexdigest()
        if sha in known:
            continue
        ext = ".jpg" if data[:3] == b"\xff\xd8\xff" else (".gif" if data[:3] == b"GIF" else ".png")
        path = os.path.join(STICK_DIR, sha[:16] + ext)
        try:
            open(path, "wb").write(data)
        except Exception as e:
            print("   写文件失败:", str(e)[:60])
            continue
        known.add(sha)
        added += 1
        index.append({
            "sha1": sha, "path": path, "size": len(data),
            "name": (m.get("text") or "")[:24] or sha[:8],
            "from": m.get("from"), "at": m.get("at") or time.strftime("%Y-%m-%d %H:%M"),
            "aweme": m.get("aweme") or "",
        })
        print(f"   + {sha[:10]} {len(data)} bytes  {(m.get('text') or '')[:20]}")

    save(INDEX, index[-500:])
    print(f"[完成] 新增 {added} 个，共 {len(index)} 个 → {INDEX}")


if __name__ == "__main__":
    main()

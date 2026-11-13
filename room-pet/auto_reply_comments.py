"""自动回复「别人回复了我的评论」

链路：
  1 从 douyin/comments.json 取我们自己发过的评论（aweme_id + cid）
  2 每个评论调 /aweme/v1/web/comment/list/reply/ 拿回复列表
  3 过滤掉「我自己发的」和「已经回过的」（comment_replies.json 记指纹）
  4 用 人设 + 共享记忆 生成一句回复 → publish 接口带 reply_id 发出

用法：
  python auto_reply_comments.py             # 真回（需要 auto.json -> reply_comments=true）
  python auto_reply_comments.py --dry       # 只生成不发送
  python auto_reply_comments.py --scan      # 只列出待回，不生成
"""
import argparse
import json
import os
import subprocess
import sys

from safety_words import is_safety, load_words, resolve_config, read_pause, write_pause
import time
import urllib.request

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
DY = os.path.join(ROOT, "douyin")
COMMENTS = os.path.join(DY, "comments.json")
MEM = os.path.join(DY, "memory.json")
CFG = os.path.join(DY, "auto.json")
REPLIED = os.path.join(DY, "comment_replies.json")
PORT = 9237
OLLAMA = "http://127.0.0.1:11434/api/generate"
MODEL = "qwen2.5vl:3b-cpu"

COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web"
          "&pc_client_type=1&version_code=190500&version_name=19.5.0"
          "&cookie_enabled=true&screen_width=1920&screen_height=1080"
          "&browser_language=zh-CN&browser_platform=Win32"
          "&browser_name=Edge&browser_version=124.0.0.0&browser_online=true"
          "&engine_name=Blink&engine_version=124.0.0.0&os_name=Windows&os_version=10"
          "&cpu_core_num=12&device_memory=8&platform=PC&downlink=10&effective_type=4g"
          "&round_trip_time=50")


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def http_json(url, timeout=6):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


async def send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return m


async def ev(ws, expr, mid, timeout_s=60):
    r = await asyncio.wait_for(send(ws, mid, "Runtime.evaluate",
                                    {"expression": expr, "returnByValue": True, "awaitPromise": True}),
                               timeout=timeout_s)
    res = r.get("result") or {}
    if res.get("exceptionDetails"):
        return None
    return ((res.get("result") or {}) if isinstance(res, dict) else {}).get("value")


async def collect(aweme_cids):
    """在页里逐个拉回复列表，返回 [(aweme, my_cid, reply)]。"""
    pages = [x for x in http_json(f"http://127.0.0.1:{PORT}/json/list") if x.get("type") == "page"]
    target = next((p for p in pages if "/video/" in (p.get("url") or "")), pages[0] if pages else None)
    if not target:
        return [], None
    out = []
    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
        mid = 1
        # 我的 uid
        me = await ev(ws, f"""(async () => {{
          const r = await new Promise((res, rej) => {{
            const x = new XMLHttpRequest(); x.open('GET', '/aweme/v1/web/user/profile/self/?{COMMON}', true);
            x.onload = () => {{ try {{ res(JSON.parse(x.responseText)); }} catch(e){{ rej(e); }} }};
            x.onerror = () => rej(new Error('xhr')); x.send();
          }});
          return JSON.stringify({{uid: String((r.user||{{}}).uid || ''), nick: (r.user||{{}}).nickname || ''}});
        }})()""", mid)
        mid += 1
        try:
            meinfo = json.loads(me or "{}")
        except Exception:
            meinfo = {}
        my_uid = meinfo.get("uid") or ""
        print(f"[我] {meinfo.get('nick','?')} uid={my_uid}")

        for aweme, cid in aweme_cids:
            r = await ev(ws, f"""(async () => {{
              const u = '/aweme/v1/web/comment/list/reply/?{COMMON}&aweme_id={aweme}&comment_id={cid}&cursor=0&count=20&item_type=0';
              const d = await new Promise((res, rej) => {{
                const x = new XMLHttpRequest(); x.open('GET', u, true);
                x.onload = () => {{ try {{ res(JSON.parse(x.responseText)); }} catch(e){{ rej(e); }} }};
                x.onerror = () => rej(new Error('xhr')); x.send();
              }});
              return JSON.stringify({{
                total: d.total || 0,
                items: (d.comments || []).map(c => ({{
                  cid: String(c.cid), text: (c.text || '').slice(0, 120),
                  uid: String((c.user || {{}}).uid || ''), nick: (c.user || {{}}).nickname || '',
                  at: c.create_time || 0
                }}))
              }});
            }})()""", mid)
            mid += 1
            try:
                d = json.loads(r or "{}")
            except Exception:
                d = {}
            for it in d.get("items") or []:
                if my_uid and it.get("uid") == my_uid:
                    continue
                out.append((aweme, cid, it))
            print(f"   {aweme}/{cid[:10]}… 回复 {len(d.get('items') or [])} 条（总 {d.get('total',0)}）")
    return out, my_uid


def memory_hits(text, mem):
    pool = [v.get("summary") or "" for v in mem.get("videos") or []] + \
           [m.get("text") or "" for m in mem.get("memes") or []]
    scored = []
    for t in pool:
        if not t:
            continue
        overlap = len(set(text) & set(t))
        if overlap >= 3:
            scored.append((overlap, t))
    scored.sort(reverse=True)
    return [t for _, t in scored[:2]]


def gen_reply(cfg, target_text, mem):
    sc = resolve_config(cfg)
    if sc["enabled"] and is_safety(target_text, sc["words"]):
        print(f"   [安全词] 不生成回复：{target_text[:30]}")
        if sc["action"] == "pause":
            write_pause(sc["pause_minutes"], reason=target_text[:40])
            print(f"   [安全词] 已静默 {sc['pause_minutes']} 分钟")
        return ""
    persona = cfg.get("persona") or "蓝色大肥鱼：说话直、爱吐槽、不端着。"
    hits = memory_hits(target_text, mem)
    hint = "；".join(h[:40] for h in hits) if hits else "没有"
    prompt = f"""你是「{persona}」
有人在抖音评论区回复了你，内容：{target_text[:60]}
你可以顺手提一下你最近刷到的东西（不相关就别提）：{hint}

回一句，不超过 25 字，口语，不要引号、不要解释。"""
    payload = {"model": MODEL, "prompt": prompt, "stream": False,
               "options": {"num_gpu": 0, "temperature": 0.7, "num_predict": 60}}
    req = urllib.request.Request(OLLAMA, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return (json.loads(r.read().decode()).get("response") or "").strip().strip('"')[:60]
    except Exception as e:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--scan", action="store_true")
    args = ap.parse_args()

    cfg = load(CFG, {})
    left = read_pause()
    if left > 0:
        print(f"[停止] 安全词静默中（剩 {left} 秒），本轮不回评论")
        return
    if not cfg.get("reply_comments") and not (args.dry or args.scan):
        print("[停止] auto.json 里 reply_comments 没开")
        return

    mine = load(COMMENTS, [])
    if not mine:
        print("[提示] 还没有我们自己发的评论（comments.json 为空）")
        return
    pairs = []
    for c in mine[-20:]:
        aweme, cid = str(c.get("aweme") or ""), str(c.get("cid") or "")
        if aweme.isdigit() and cid.isdigit():
            pairs.append((aweme, cid))
    print(f"[我的评论] {len(pairs)} 条")

    try:
        replies, my_uid = __import__("asyncio").run(collect(pairs))
    except Exception as e:
        print("[失败] 拉回复:", str(e)[:120])
        return

    replied = load(REPLIED, {})
    todo = []
    for aweme, my_cid, it in replies:
        key = f"{aweme}|{it['cid']}"
        if key in replied:
            continue
        todo.append((aweme, my_cid, it, key))

    print(f"[待回] {len(todo)} 条")
    for aweme, my_cid, it, key in todo[:6]:
        print(f"   {it.get('nick','?')}: {it.get('text','')[:40]}")
    if args.scan or not todo:
        return

    mem = load(MEM, {})
    for aweme, my_cid, it, key in todo[:3]:
        text = gen_reply(cfg, it.get("text") or "", mem)
        print(f"   → {text or '(没生成)'}")
        if not text:
            continue
        if args.dry:
            continue
        r = subprocess.run([sys.executable, "-u", os.path.join(ROOT, "douyin_api_comment.py"),
                            "--aweme", aweme, "--cid", my_cid, "--reply", it["cid"], "--text", text],
                           cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        ok = "cid" in (r.stdout or "").lower()
        print(f"     发送 {'成功' if ok else '看日志'}")
        if ok:
            replied[key] = {"at": time.strftime("%Y-%m-%d %H:%M"), "text": text}
            save(REPLIED, replied)

    print("[完成]")


if __name__ == "__main__":
    import asyncio
    main()

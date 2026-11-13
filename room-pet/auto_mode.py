"""抖音自动模式（一轮）

设计原则：
  · 所有「写」动作都有开关，默认全关；只有把开关打开才会真的点赞/收藏/评论/发私信
  · 每个决定都留证据（比值、判断、理由），写进 memory.json 供以后翻阅
  · 重要程度由结构分决定，超过阈值才 @ 管理员

一轮做什么：
  1. 刷一轮（douyin_browse.py）
  2. 补互动数据（douyin_enrich.py）
  3. 语义判断（douyin_judge.py）
  4. 给判定过的视频写「总结 + 热梗 + 为什么用」→ 存共享记忆
  5. 结构分达标的：按开关自动点赞 / 收藏
  6. 按开关自动评论（用记忆里的梗 + 人设）
  7. 重要视频按开关 @ 管理员（写 alerts.json，可选推 QQ）

用法：
  python auto_mode.py --pages 1 --top 3            # 跑一轮（遵守 auto.json 开关）
  python auto_mode.py --pages 1 --top 3 --dry      # 只读不写
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
DY = os.path.join(ROOT, "douyin")
CFG_PATH = os.path.join(DY, "auto.json")
MEM_PATH = os.path.join(DY, "memory.json")
ALERT_PATH = os.path.join(DY, "alerts.json")
PORT = 9237
OLLAMA = "http://127.0.0.1:11434/api/generate"
MODEL = "qwen2.5vl:3b-cpu"

DEFAULT_CFG = {
    "enabled": False,
    "auto_comment": False,
    "auto_like": False,
    "auto_collect": False,
    "admin_at": False,
    "alert_score": 9.0,
    "like_min_score": 6.0,
    "collect_min_score": 7.5,
    "comment_min_score": 8.0,
    "persona": "蓝色大肥鱼：说话直、爱吐槽、不端着，偶尔自嘲；喜欢有趣的东西，讨厌标题党。",
    "comment_style": "一句话，不超过 25 字，口语，不刷屏、不带链接、不@人",
    "dm_reply": False,
    "reply_comments": False,
    "dm_style": "一句口语，像朋友聊天，别太长，不用敬语",
}


def load_cfg():
    cfg = dict(DEFAULT_CFG)
    try:
        if os.path.exists(CFG_PATH):
            cfg.update(json.load(open(CFG_PATH, encoding="utf-8")))
    except Exception:
        pass
    return cfg


def save_cfg(cfg):
    os.makedirs(DY, exist_ok=True)
    json.dump(cfg, open(CFG_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def load_json(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def run(script, args):
    print(f"  → {script} {' '.join(args)}", flush=True)
    p = subprocess.run([sys.executable, "-u", os.path.join(ROOT, script)] + args,
                       cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    tail = (p.stdout or "").strip().splitlines()[-3:]
    for l in tail:
        print("    " + l[:110])
    return p.returncode


def ollama(prompt, timeout=120, num_predict=120):
    payload = {"model": MODEL, "prompt": prompt, "stream": False,
               "options": {"num_gpu": 0, "temperature": 0.5, "num_predict": num_predict}}
    req = urllib.request.Request(OLLAMA, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return (json.loads(r.read().decode()).get("response") or "").strip()


# ── 页面内调用签名接口（点赞 / 收藏 / 评论发布） ──
import asyncio

import websockets

COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web"
          "&pc_client_type=1&version_code=190500&version_name=19.5.0"
          "&cookie_enabled=true&screen_width=1920&screen_height=1080"
          "&browser_language=zh-CN&browser_platform=Win32"
          "&browser_name=Edge&browser_version=124.0.0.0&browser_online=true"
          "&engine_name=Blink&engine_version=124.0.0.0&os_name=Windows&os_version=10"
          "&cpu_core_num=12&device_memory=8&platform=PC&downlink=10&effective_type=4g"
          "&round_trip_time=50")


def _pages():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=6) as r:
        return [x for x in json.loads(r.read().decode()) if x.get("type") == "page"]


async def _ev(ws, expr, mid):
    await ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            r = m.get("result") or {}
            if r.get("exceptionDetails"):
                return None
            return ((r.get("result") or {}) if isinstance(r, dict) else {}).get("value")


async def _ensure_video_page(aweme_id):
    pages = _pages()
    target = next((p for p in pages if f"/video/{aweme_id}" in (p.get("url") or "")), None)
    if target:
        return target["webSocketDebuggerUrl"]
    t = next((p for p in pages if "/video/" in (p.get("url") or "")), pages[0] if pages else None)
    if not t:
        return None
    async with websockets.connect(t["webSocketDebuggerUrl"], max_size=2 ** 24) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Page.navigate",
                                  "params": {"url": f"https://www.douyin.com/video/{aweme_id}"}}))
        await asyncio.sleep(6)
    return t["webSocketDebuggerUrl"]


async def _call(aweme_id, path_tpl):
    url = await _ensure_video_page(aweme_id)
    if not url:
        return None
    async with websockets.connect(url, max_size=2 ** 24) as ws:
        expr = """(async () => {
          const u = %s;
          const txt = await new Promise((res, rej) => {
            const x = new XMLHttpRequest(); x.open('POST', u, true);
            x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            x.onload = () => res(x.responseText || ''); x.onerror = () => rej(new Error('xhr')); x.send('');
          });
          try { const j = JSON.parse(txt); return JSON.stringify({code: j.status_code, raw: txt.slice(0, 120)}); }
          catch (e) { return JSON.stringify({raw: (txt || '').slice(0, 120)}); }
        })()""" % json.dumps(path_tpl + "&" + COMMON)
        return await _ev(ws, expr, 1)


def do_like(aweme_id, dry=False):
    if dry:
        return {"dry": True, "action": "like"}
    r = asyncio.run(_call(aweme_id, f"/aweme/v1/web/commit/item/digg/?aweme_id={aweme_id}&type=1"))
    return {"result": r}


def do_collect(aweme_id, dry=False):
    if dry:
        return {"dry": True, "action": "collect"}
    r = asyncio.run(_call(aweme_id, f"/aweme/v1/web/aweme/collect/?aweme_id={aweme_id}&action=1"))
    return {"result": r}


def summarize(it, cfg):
    st = it.get("statistics") or {}
    ra = it.get("ratios") or {}
    j = it.get("judge") or {}
    prompt = f"""这是一条抖音视频的证据，请用两行中文回答，不要解释：
第一行：一句话总结这条视频讲了什么（20 字内）
第二行：它带的热梗或记忆点是什么，为什么容易传播（25 字内）

标题：{(it.get('title') or '')[:80]}
作者：{it.get('author') or '?'}
时长：{st.get('duration') or '?'} 秒
点赞 {st.get('digg')}　收藏 {st.get('collect')}　转发 {st.get('share')}　评论 {st.get('comment')}
比值 收藏{ra.get('collect')} 转发{ra.get('share')} 评论{ra.get('comment')}
判断：{j.get('verdict')} · {j.get('reason')}"""
    try:
        out = ollama(prompt)
    except Exception as e:
        return {"summary": "", "meme": "", "error": str(e)[:60]}
    lines = [l.strip(" -•\t") for l in out.split("\n") if l.strip()]
    def clean(t):
        for pre in ("第一行：", "第一行:", "第二行：", "第二行:", "总结：", "热梗：", "- "):
            if t.startswith(pre):
                t = t[len(pre):].strip()
        return t[:60]
    return {"summary": clean(lines[0]) if lines else "",
            "meme": clean(lines[1]) if len(lines) > 1 else ""}


def gen_comment(it, mem, cfg):
    hits = [m.get("meme") for m in mem[:5] if m.get("meme")]
    prompt = f"""你是「{cfg['persona']}」
现在要在这条视频下留一句评论：{cfg['comment_style']}。
可以参考这些最近的热梗（用得上才用，不要硬塞）：{'；'.join(hits) if hits else '没有'}

视频标题：{(it.get('title') or '')[:70]}
视频总结：{(it.get('summary') or '')[:50]}
只输出评论本身，不要引号。"""
    try:
        return ollama(prompt, num_predict=60).strip().strip('"')[:60]
    except Exception:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=1)
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    cfg = load_cfg()
    print(f"[配置] {'开' if cfg['enabled'] else '关'} · 评论{cfg['auto_comment']} 赞{cfg['auto_like']} "
          f"藏{cfg['auto_collect']} @管理员{cfg['admin_at']}")
    if not cfg["enabled"] and not args.dry:
        print("[停止] 自动模式没开")
        return

    print("[1/4] 刷取")
    if run("douyin_browse.py", ["--pages", str(args.pages)]) != 0:
        print("[停止] 刷取失败")
        return
    print("[2/4] 补互动数据")
    run("douyin_enrich.py", ["--top", str(args.top)])
    print("[3/4] 语义判断")
    run("douyin_judge.py", ["--top", str(args.top)])

    data = load_json(os.path.join(DY, "latest.json"), {})
    items = data.get("items") or []
    judged = [it for it in items if it.get("judge")]
    print(f"[4/4] 处理 {len(judged)} 条（总结 / 点赞 / 收藏 / 评论 / 提醒）")

    mem = load_json(MEM_PATH, {"videos": [], "memes": []})
    known = {v.get("aweme") for v in mem.get("videos") or []}
    alerts = load_json(ALERT_PATH, [])
    acts = {"like": 0, "collect": 0, "comment": 0, "alert": 0, "summary": 0}

    for it in judged[: args.top]:
        aid = (it.get("href") or "").rstrip("/").split("/")[-1]
        if not aid.isdigit():
            continue
        score = float(it.get("rank_score") or 0)
        j = it.get("judge") or {}

        # 总结 + 热梗
        if aid not in known:
            s = summarize(it, cfg)
            it["summary"], it["meme"] = s.get("summary"), s.get("meme")
            if s.get("summary"):
                acts["summary"] += 1
                mem.setdefault("videos", []).append({
                    "aweme": aid, "title": it.get("title"), "author": it.get("author"),
                    "summary": s.get("summary"), "meme": s.get("meme"),
                    "verdict": j.get("verdict"), "score": score,
                    "ratios": it.get("ratios"), "at": time.strftime("%Y-%m-%d %H:%M"),
                })
                if s.get("meme"):
                    hit = next((m for m in mem.setdefault("memes", []) if m.get("text") == s["meme"]), None)
                    if hit:
                        hit["count"] = hit.get("count", 1) + 1
                    else:
                        mem["memes"].append({"text": s["meme"], "aweme": aid, "count": 1,
                                             "at": time.strftime("%Y-%m-%d %H:%M")})
                known.add(aid)
            print(f"   总结 [{score:.2f}] {(it.get('title') or '')[:24]} → {s.get('summary','')[:30]}")

        # 点赞 / 收藏
        if cfg["auto_like"] and score >= cfg["like_min_score"] and not args.dry:
            r = do_like(aid)
            acts["like"] += 1
            print(f"   点赞 {aid} → {str(r)[:60]}")
        if cfg["auto_collect"] and score >= cfg["collect_min_score"] and not args.dry:
            r = do_collect(aid)
            acts["collect"] += 1
            print(f"   收藏 {aid} → {str(r)[:60]}")

        # 评论
        if cfg["auto_comment"] and score >= cfg["comment_min_score"] and not args.dry:
            text = gen_comment(it, mem.get("memes") or [], cfg)
            if text:
                r = subprocess.run([sys.executable, "-u", os.path.join(ROOT, "douyin_api_comment.py"),
                                    "--aweme", aid, "--text", text],
                                   cwd=ROOT, capture_output=True, text=True,
                                   encoding="utf-8", errors="replace")
                ok = "cid" in (r.stdout or "").lower() or "success" in (r.stdout or "").lower()
                acts["comment"] += 1
                print(f"   评论 {aid} 「{text}」→ {'成功' if ok else '看日志'}")
                it["auto_comment"] = {"text": text, "ok": ok, "at": time.strftime("%H:%M")}

        # @ 管理员
        if cfg["admin_at"] and score >= cfg["alert_score"]:
            alerts.append({"aweme": aid, "title": (it.get("title") or "")[:60],
                           "score": score, "verdict": j.get("verdict"),
                           "reason": j.get("reason"), "summary": it.get("summary"),
                           "at": time.strftime("%Y-%m-%d %H:%M")})
            acts["alert"] += 1
            print(f"   @管理员 已记录 {aid}（{score:.2f}）")

    save_json(MEM_PATH, mem)
    save_json(ALERT_PATH, alerts[-200:])
    data["items"] = items
    data["auto"] = {"at": time.time(), "cfg": cfg, "acts": acts}
    save_json(os.path.join(DY, "latest.json"), data)
    print(f"[完成] 总结{acts['summary']} 赞{acts['like']} 藏{acts['collect']} 评论{acts['comment']} 提醒{acts['alert']}")


if __name__ == "__main__":
    main()

"""自动回私信（开关控制；人设 + 记忆 + 上下文）

一轮：
  1. 拉一次私信（douyin_dm.py --read）
  2. 找出「对方最后一句比我们上次回复更新」的会话
  3. 用 人设 + 共享记忆 + 最近几条对话 生成一句回复
  4. 走 douyin_dm_send.py 发出去（--to-last 定位会话，避免昵称问题）
  5. 记 dm_replies.json，防重复回

用法：
  python auto_dm_reply.py --dry        # 只生成不发送
  python auto_dm_reply.py              # 真发（需要开关 auto.json -> dm_reply=true）
"""
import argparse
import json
import os
import subprocess
import sys

from safety_words import is_safety, load_words, resolve_config, read_pause, write_pause
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
DY = os.path.join(ROOT, "douyin")
CFG = os.path.join(DY, "auto.json")
DM = os.path.join(DY, "dm.json")
MEM = os.path.join(DY, "memory.json")
REPLIED = os.path.join(DY, "dm_replies.json")
OLLAMA = "http://127.0.0.1:11434/api/generate"
MODEL = "qwen2.5vl:3b-cpu"


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def ollama(prompt, num_predict=80, timeout=120):
    payload = {"model": MODEL, "prompt": prompt, "stream": False,
               "options": {"num_gpu": 0, "temperature": 0.7, "num_predict": num_predict}}
    req = urllib.request.Request(OLLAMA, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return (json.loads(r.read().decode()).get("response") or "").strip()




def resolve_nick(last_text: str) -> str:
    """去 /friend 列表里按「最后一条消息」找到那一行，取它的昵称。"""
    import asyncio
    try:
        import websockets
    except Exception:
        return ""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT_DM}/json/list", timeout=6) as r:
            pages = [x for x in json.loads(r.read().decode()) if x.get("type") == "page"]
    except Exception:
        return ""
    target = next((p for p in pages if "/friend" in (p.get("url") or "")), None)
    if not target:
        return ""
    snippet = (last_text or "").strip()[:20]

    async def grab():
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
                "expression": """(() => {
                  const snip = %s;
                  const rows = [...document.querySelectorAll('[class*="conversation"]')]
                    .map(e => (e.innerText || '').replace(/\n/g, ' ').trim())
                    .filter(t => t && t.length > 2);
                  const hit = rows.find(t => t.includes(snip));
                  if (!hit) return '';
                  // 行文本形如「昵称 刚刚 最后一句」或「昵称 时间 内容」
                  return hit.split(' ')[0] || '';
                })()""" % json.dumps(snippet, ensure_ascii=False),
                "returnByValue": True}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == 1:
                    return ((m.get("result") or {}).get("result") or {}).get("value") or ""

    try:
        return asyncio.run(grab())
    except Exception:
        return ""

def memory_hits(text, mem, limit=3):
    """极简检索：视频总结 / 热梗里跟这句话有字面重合的挑出来。"""
    pool = []
    for v in mem.get("videos") or []:
        pool.append(("视频", v.get("summary") or "", v.get("title") or ""))
    for m in mem.get("memes") or []:
        pool.append(("热梗", m.get("text") or "", ""))
    scored = []
    for kind, txt, title in pool:
        if not txt:
            continue
        overlap = len(set(text) & set(txt))
        if overlap >= 3:
            scored.append((overlap, kind, txt, title))
    scored.sort(reverse=True)
    return scored[:limit]


def gen_reply(persona, style, history, hits):
    mem_txt = "；".join(f"[{k}]{t[:40]}" for _, k, t, _ in hits) if hits else "没有"
    hist = "\n".join(f"{ '我' if m.get('from')=='me' else '对方' }: {m.get('text','')[:60]}"
                     for m in history[-6:])
    prompt = f"""你是「{persona}」
现在在抖音私信里回对方，风格：{style}
可以自然地带出你最近刷到的东西（别硬塞，用不上就不用）：{mem_txt}

最近对话：
{hist}

只输出你要回的那一句（不超过 30 字），不要引号、不要解释。"""
    try:
        return ollama(prompt).strip().strip('"')[:60]
    except Exception as e:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    cfg = load(CFG, {})
    if not cfg.get("dm_reply") and not args.dry:
        print("[停止] auto.json 里 dm_reply 没开")
        return

    print("[1/3] 拉私信")
    r = subprocess.run([sys.executable, "-u", os.path.join(ROOT, "douyin_dm.py"), "--read"],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    for l in (r.stdout or "").strip().splitlines()[-3:]:
        print("   ", l[:110])

    dm = load(DM, {})
    convs = dm.get("conversations") or []
    mem = load(MEM, {})
    replied = load(REPLIED, {})
    print(f"[2/3] 会话 {len(convs)} 个，看谁的最后一句还没回")

    todo = []
    for c in convs:
        msgs = c.get("messages") or []
        if not msgs:
            continue
        last = msgs[-1]
        if last.get("from") != "them":
            continue
        key = c.get("conv_id") or ""
        stamp = f"{last.get('at')}|{last.get('text')[:20]}"
        if replied.get(key) == stamp:
            continue
        todo.append((c, last, stamp))

    if not todo:
        print("   没有需要回的")
        return

    left = read_pause()
    if left > 0:
        print(f"[停止] 安全词静默中（剩 {left} 秒），本轮不回复")
        return

    persona = cfg.get("persona") or "蓝色大肥鱼：说话直、爱吐槽、不端着。"
    style = cfg.get("dm_style") or "一句口语，像朋友聊天，别太长，不用敬语"
    sw = load_words(cfg)
    for c, last, stamp in todo:
        last_text = last.get("text") or ""
        if is_safety(last_text, sw):
            # 对方说了安全词：这一条不生成、不发送，并把它标记成已处理，避免下一轮又回
            print(f"   [安全词] 跳过：{last_text[:30]}")
            sc = resolve_config(cfg)
            if sc["action"] == "pause":
                write_pause(sc["pause_minutes"], reason=last_text[:40])
                print(f"   [安全词] 已静默 {sc['pause_minutes']} 分钟（写 dy_safety_pause.json）")
            replied[c.get("conv_id") or ""] = stamp
            save(REPLIED, replied)
            continue
        hits = memory_hits(last.get("text") or "", mem)
        text = gen_reply(persona, style, c.get("messages") or [], hits)
        print(f"   ← {last.get('text','')[:30]}")
        print(f"   → {text or '(没生成出来)'}   [记忆 {len(hits)} 条]")
        if not text:
            continue
        if args.dry:
            continue
        nick = resolve_nick(last.get("text") or "")
        print(f"   会话昵称: {nick or '(没解析出来)'}")
        if nick:
            send_args = ["--to", nick]
        elif len((last.get("text") or "")) >= 6:
            send_args = ["--to-last", (last.get("text") or "")[:20]]
        else:
            print("   昵称没解析出来，退回「点第一个会话」（它是最新消息那条）")
            send_args = ["--first"]
        send = subprocess.run([sys.executable, "-u", os.path.join(ROOT, "douyin_dm_send.py"),
                               *send_args, "--text", text],
                              cwd=ROOT, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        ok = "appeared" in (send.stdout or "") and "true" in (send.stdout or "")
        print(f"   发送 {'成功' if ok else '看日志'}")
        if ok:
            replied[c.get("conv_id")] = stamp
            save(REPLIED, replied)

    print("[3/3] 完成")


if __name__ == "__main__":
    main()

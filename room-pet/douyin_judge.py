"""语义判断：这条视频值不值得点开（本地模型，证据包 + 一句话理由）

思路抄 dsh-douyin-scroll 的第 2/3 层：
  · 输入不是原始 JSON，是压缩证据包（文案/作者/时长/互动比值/高赞评论）
  · 模型必须引用具体证据，禁止「感觉有趣」
  · 证据不够就进「判断不了」，不硬推

用法：
  python douyin_judge.py --top 10          # 判断前 10 条并写回 latest.json
  python douyin_judge.py --top 3 --dry     # 只打印
"""
import argparse
import json
import os
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "douyin")
OLLAMA = "http://127.0.0.1:11434/api/generate"
MODEL = "qwen2.5vl:3b-cpu"

PROMPT = """用一句中文（不超过 25 字）说明这条抖音好在哪，只根据下面的数据，不要编：

标题：{title}
时长：{duration} 秒
收藏/赞 {r_collect}　转发/赞 {r_share}　评论/赞 {r_comment}

只能输出那一句话，不要引号、不要英文、不要解释，也不要出现「一句话」「证据」「根据」这些字。"""

BANNED = ("一句话", "必须引用", "根据", "证据", "JSON", "verdict")


def rule_verdict(score: float) -> str:
    if score >= 9:
        return "值得看"
    if score >= 6:
        return "顺带一看"
    if score >= 4:
        return "判断不了"
    return "不推荐"


def rule_reason(it: dict) -> str:
    ra = it.get("ratios") or {}
    c = (ra.get("collect") or 0) * 100
    sh = (ra.get("share") or 0) * 100
    cm = (ra.get("comment") or 0) * 100
    if c >= 25:
        return f"收藏率 {c:.0f}%，典型的值得存下来的内容"
    if sh >= 25:
        return f"转发率 {sh:.0f}%，看完想发给别人的那种"
    if cm >= 3:
        return f"评论率 {cm:.1f}%，能把人聊起来"
    return f"收藏 {c:.0f}% 转发 {sh:.0f}%，中规中矩"


def clean_reason(text: str) -> str:
    t = (text or "").strip().strip('"').strip("“”").replace("\n", " ")
    t = t.split("。")[0].strip()
    if not t or len(t) < 4:
        return ""
    for b in BANNED:
        if b in t:
            return ""
    return t[:40]


def call_model(prompt: str, timeout: int = 180) -> str:
    payload = {
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"num_gpu": 0, "temperature": 0.2, "num_predict": 160},
    }
    req = urllib.request.Request(OLLAMA, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read().decode())
    return (d.get("response") or "").strip()


def normalize_verdict(v: str) -> str:
    v = (v or "").strip()
    known = ["值得看", "顺带一看", "判断不了", "不推荐"]
    for k in known:
        if v == k:
            return k
    for k in known:
        if k in v:
            return k
    return "判断不了"


def parse_json(text: str):
    import re
    m = re.search(r"\{.*?\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def build_prompt(it: dict) -> str:
    st = it.get("statistics") or {}
    ra = it.get("ratios") or {}
    cm = "；".join((it.get("comments") or [])[:3])[:200] or "（没抓到）"
    return PROMPT.format(
        title=(it.get("title") or "")[:80],
        author=it.get("author") or "?",
        duration=st.get("duration") or it.get("duration") or "?",
        digg=st.get("digg") or it.get("likes") or "?",
        collect=st.get("collect", "?"),
        share=st.get("share", "?"),
        comment=st.get("comment", "?"),
        r_collect=f"{(ra.get('collect') or 0) * 100:.1f}%",
        r_share=f"{(ra.get('share') or 0) * 100:.1f}%",
        r_comment=f"{(ra.get('comment') or 0) * 100:.1f}%",
        comments=cm,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    path = os.path.join(OUT, "latest.json")
    if not os.path.exists(path):
        print("[错误] 没有 latest.json")
        return
    data = json.load(open(path, encoding="utf-8"))
    items = data.get("items") or []
    if not items:
        print("[错误] 没有条目")
        return

    # 清掉上一轮的判定，避免旧结论挂在没重新判断的条目上
    for it in items:
        it.pop("judge", None)
    items.sort(key=lambda x: x.get("score") or 0, reverse=True)   # 和 enrich 一致：按点赞量排
    todo = items[: args.top]
    print(f"[判断] {len(todo)} 条，模型 {MODEL}（CPU，约 10~20 秒/条）")

    ok = 0
    t0 = time.time()
    for i, it in enumerate(todo, 1):
        prompt = build_prompt(it)
        try:
            raw = call_model(prompt)
        except Exception as e:
            print(f"  [{i}/{len(todo)}] 失败：{e}")
            continue
        score = it.get("rank_score") or 0
        verdict = rule_verdict(score)
        reason = clean_reason(raw) or rule_reason(it)
        it["judge"] = {"verdict": verdict, "score": round(float(score), 2), "reason": reason}
        ok += 1
        print(f"  [{i}/{len(todo)}] {verdict} {score:.2f}分 · {reason[:46]}")

    print(f"[完成] {ok}/{len(todo)} 条，用时 {int(time.time() - t0)} 秒")
    if args.dry:
        print("[dry] 不写回")
        return
    data["items"] = items
    data["judged"] = {"at": time.time(), "count": ok}
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"[写回] {path}")


if __name__ == "__main__":
    main()

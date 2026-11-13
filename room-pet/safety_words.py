"""安全词：对方在抖音里说出这些词，自动回复立刻停下（不生成、不发送）。

开关（auto.json）：
  "safetyWords": ["安全词", "别回了", "停下"]   # 词表；空数组 = 关闭
  "safetyAction": "skip" | "pause" | "off"      # 默认 skip
  "safetyPauseMinutes": 30                       # pause 时静默多久

三种动作：
  off    安全词完全不生效
  skip   命中就跳过这一条（不生成、不发送，标记已处理）
  pause  命中就跳过 **并且** 整个自动回复静默 N 分钟（写 dy_safety_pause.json）

为什么只在抖音侧加：QQ 侧已经在 personaPolicy 里带了安全词（说出来就关掉该群放开策略）。
两边都要有，否则一边关了另一边还在自动回。
"""

import json
import os
import time

DEFAULT_SAFETY_WORDS = ["安全词", "别回了", "停下"]
ACTIONS = ("skip", "pause", "off")

# 静默标记文件：与 auto.json 同目录
ROOT = os.path.dirname(os.path.abspath(__file__))
PAUSE_FILE = os.path.join(ROOT, "dy_safety_pause.json")


def load_words(cfg=None):
    """从 auto.json（dict）读安全词；没配就用默认。"""
    raw = (cfg or {}).get("safetyWords")
    if isinstance(raw, list):
        return [str(w).strip() for w in raw if str(w).strip()]
    return list(DEFAULT_SAFETY_WORDS)


def resolve_config(cfg=None):
    """读出完整开关：{enabled, action, words, pause_minutes}"""
    cfg = cfg or {}
    action = str(cfg.get("safetyAction") or "skip").lower()
    if action not in ACTIONS:
        action = "skip"
    words = load_words(cfg)
    enabled = action != "off" and bool(words)
    minutes = max(1, min(24 * 60, int(cfg.get("safetyPauseMinutes") or 30)))
    return {"enabled": enabled, "action": action, "words": words, "pause_minutes": minutes}


def is_safety(text, words=None):
    """文本里是否出现安全词。"""
    s = "".join(str(text or "").split())
    if not s:
        return False
    ws = words if words is not None else DEFAULT_SAFETY_WORDS
    return any(w and "".join(w.split()) in s for w in ws)


def read_pause():
    """读静默标记；返回剩余秒数（0 = 未静默）。"""
    try:
        with open(PAUSE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        until = float(data.get("until") or 0)
    except Exception:
        return 0
    return max(0, int((until - time.time() * 1000) / 1000))


def write_pause(minutes, reason=""):
    """写静默标记（覆盖）。"""
    until = int(time.time() * 1000) + max(1, int(minutes)) * 60000
    try:
        with open(PAUSE_FILE, "w", encoding="utf-8") as f:
            json.dump({"until": until, "minutes": int(minutes), "reason": reason,
                       "at": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return until


def clear_pause():
    try:
        os.remove(PAUSE_FILE)
    except Exception:
        pass

"""轮询 qq-bridge 状态，推断“她在想 / 她说完了”。

只用桥接已有的只读接口：
  GET /api/status             → socialV2Busy（正在生成的会话）
  GET /api/socialV2/states    → 每个会话的 unreadCount / lastAiReplyAt

规则：
  未读总数增加 / busy 非空      → thinking
  lastAiReplyAt 变大（有新回复）→ speaking（2.2 秒）→ idle
  连续 thinking 超过 45 秒      → 强制 idle（防止卡住）
"""
from __future__ import annotations

import json
import threading
import time
import urllib.request

TOKEN_FILE = os.environ.get("QQB_CONSOLE_TOKEN") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "console-token")
BASE = "http://127.0.0.1:3100"
DEBUG = os.environ.get("QQB_POLLER_LOG") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "poller.log")
BRIDGE_LOG = os.environ.get("QQB_BRIDGE_LOG") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "bridge.log")


def _token() -> str:
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _get(path: str, tok: str):
    try:
        with urllib.request.urlopen(f"{BASE}{path}?token={tok}", timeout=4) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _dbg(line: str) -> None:
    try:
        with open(DEBUG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {line}\n")
    except Exception:
        pass


def start(on_state, interval: float = 1.2) -> threading.Thread:
    def loop() -> None:
        tok = _token()
        prev_unread = None
        prev_reply = None
        sent_offset = None
        thinking_since = 0.0
        state = "idle"

        while True:
            time.sleep(interval)
            st = _get("/api/status", tok)
            sv = _get("/api/socialV2/states", tok)
            if st is None and sv is None:
                continue

            busy = bool(st and st.get("socialV2Busy"))
            unread_total = 0
            last_reply = 0
            if sv and isinstance(sv.get("conversations"), list):
                for c in sv["conversations"]:
                    try:
                        unread_total += int(c.get("unreadCount") or 0)
                        last_reply = max(last_reply, int(c.get("lastAiReplyAt") or 0))
                    except Exception:
                        pass

            if prev_unread is None:
                prev_unread = unread_total
                prev_reply = last_reply
                _dbg(f"init unread={unread_total} reply={last_reply}")
                continue

            new_msg = unread_total > prev_unread
            new_reply = last_reply > (prev_reply or 0)

            # 桥接日志里出现新的「已发送」= 真的发出去了（private 会话不写 lastAiReplyAt，只能看日志）
            sent_now = False
            try:
                import os
                size = os.path.getsize(BRIDGE_LOG)
                if sent_offset is None:
                    sent_offset = size
                elif size > sent_offset:
                    with open(BRIDGE_LOG, "r", encoding="utf-8", errors="replace") as f:
                        f.seek(sent_offset)
                        chunk = f.read()
                    sent_offset = size
                    if "已发送" in chunk:
                        sent_now = True
            except Exception:
                pass
            if sent_now:
                new_reply = True

            if new_reply:
                on_state("speaking", "……")
                _dbg(f"speaking (reply={last_reply})")
                prev_reply = last_reply
                prev_unread = unread_total
                state = "speaking"
                thinking_since = 0.0
                time.sleep(2.2)
                on_state("idle", "")
                state = "idle"
                _dbg("idle after speaking")
                continue

            if new_msg and state != "thinking":
                on_state("thinking", "")
                state = "thinking"
                thinking_since = time.time()
                _dbg(f"thinking busy={busy} unread={unread_total}")

            if state == "thinking":
                if thinking_since and time.time() - thinking_since > 45:
                    on_state("idle", "")
                    state = "idle"
                    _dbg("idle (thinking timeout)")
                elif thinking_since and time.time() - thinking_since > 20:
                    on_state("idle", "")
                    state = "idle"
                    _dbg("idle (no busy)")

            prev_unread = unread_total

    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t

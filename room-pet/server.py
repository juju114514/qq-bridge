#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
room-pet 本地服务
- 静态文件
- SSE 状态推送（给页面）
- POST /state（给 qq-bridge / 脚本调用）

用法：python server.py [端口]   默认 8796
"""
from __future__ import annotations

import json
import dsh_pet_link
import lan_link
import punch_link
import mimetypes
import queue
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8796

LINK = dsh_pet_link.DshPetLink()
LAN = None
PUNCH = None
PET_ON = True

VALID = {"peer_say", "idle", "thinking", "listening", "speaking", "happy", "sleep", "study", "crying", "hugging", "petting"}

_lock = threading.Lock()
_state = {"state": "idle", "text": "", "ts": time.time()}
_clients: list[queue.Queue] = []
_clients_lock = threading.Lock()


def load_settings() -> dict:
    p = ROOT / "settings.json"
    d = {}
    if p.exists():
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            d = {}
    lan = d.setdefault("lan", {})
    lan.setdefault("enabled", True)
    if not lan.get("code"):
        import secrets
        lan["code"] = secrets.token_hex(3)
        p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[lan] 已生成配对码：{lan['code']}（settings.json）")
    lan.setdefault("mirror", True)
    lan.setdefault("approved", [])
    lan.setdefault("manual", [])
    lan.setdefault("publicMode", False)
    if not d.get("instance_key"):
        import uuid
        d["instance_key"] = uuid.uuid4().hex[:8]
        p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    d.setdefault("name", "room-pet")
    return d


def save_settings(d: dict) -> None:
    (ROOT / "settings.json").write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def _menu_watch() -> None:
    """桌宠右键「书房模式」被点时，打开书房页面。"""
    import webbrowser
    while True:
        try:
            ev = LINK.menu_events("room-pet")
            if isinstance(ev, dict):
                hits = [k for k, v in (ev.get("events") or {}).items() if v]
                if hits:
                    print(f"[dsh-pet] 菜单触发：{hits}")
                    webbrowser.open(f"http://127.0.0.1:{PORT}/")
        except Exception:
            pass
        time.sleep(3)






def vision_config() -> dict:
    try:
        cfg = load_settings()
    except Exception:
        cfg = {}
    v = cfg.get("vision") or {}
    return {
        "enabled": bool(v.get("enabled")),
        "baseUrl": str(v.get("baseUrl") or "").rstrip("/"),
        "apiKey": str(v.get("apiKey") or ""),
        "model": str(v.get("model") or ""),
    }


def _shrink_data_url(data_url: str, max_side: int = 448) -> str:
    """把图缩到最长边 768，再按 JPEG 85 重编码：CPU 推理快一倍以上。"""
    try:
        import base64
        from io import BytesIO
        from PIL import Image
        head, b64 = data_url.split(",", 1)
        raw = base64.b64decode(b64)
        im = Image.open(BytesIO(raw)).convert("RGB")
        if max(im.size) > max_side:
            im.thumbnail((max_side, max_side), Image.LANCZOS)
        buf = BytesIO()
        im.save(buf, format="JPEG", quality=85)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        print("[vision] 缩图失败，用原图:", e)
        return data_url


def vision_describe(data_url: str, prompt: str = "") -> dict:
    """把一帧画面交给多模态模型，返回一句描述。

    需要在 settings.json 配：
      "vision": {"enabled": true, "baseUrl": "https://api.xxx/v1", "apiKey": "...", "model": "qwen-vl-max"}
    OpenAI 兼容的 /chat/completions + image_url 格式。
    """
    if not data_url.startswith("data:image/"):
        return {"ok": False, "error": "image 必须是 data:image/... 的 dataURL"}
    c = vision_config()
    if not c["enabled"] or not c["baseUrl"] or not c["apiKey"] or not c["model"]:
        return {"ok": False, "error": "未配置视觉模型（settings.json → vision）", "configured": False}
    data_url = _shrink_data_url(data_url)
    text = prompt or "用一两句话描述这张图里有什么，重点说人物、场景和明显的东西。中文回答。"
    payload = {
        "model": c["model"],
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": text},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }],
        "max_tokens": 200,
    }
    req = urllib.request.Request(
        c["baseUrl"] + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + c["apiKey"]},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            d = json.loads(r.read().decode("utf-8"))
        msg = (((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        return {"ok": bool(msg), "text": msg, "configured": True}
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}: {e.read().decode('utf-8','replace')[:160]}", "configured": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:160], "configured": True}



ASR_URL = "http://127.0.0.1:5111"


def asr_transcribe(raw: bytes) -> dict:
    """把浏览器录的 webm 交给本地 ASR 服务（5111）转文字。"""
    import subprocess
    import tempfile
    tmpdir = ROOT / "asr-tmp"
    tmpdir.mkdir(exist_ok=True)
    fd, path = None, None
    try:
        f = tempfile.NamedTemporaryFile(suffix=".webm", delete=False, dir=str(tmpdir))
        f.write(raw)
        f.close()
        path = f.name
        payload = json.dumps({"path": path}).encode()
        req = urllib.request.Request(ASR_URL + "/transcribe", data=payload,
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.loads(r.read().decode("utf-8"))
        return {"ok": bool(d.get("ok")), "text": str(d.get("text") or "").strip(),
                "seconds": d.get("seconds")}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"ASR 服务没起（5111）：{e.reason}"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:160]}
    finally:
        try:
            if path: Path(path).unlink(missing_ok=True)
        except Exception:
            pass


TTS_CACHE = ROOT / "tts-cache"
MEM_FILE = ROOT / "memory.json"




def tts_stream_start(handler, text: str) -> None:
    """流式 TTS：边合成边把 mp3 分片写给浏览器（chunked）。"""
    import asyncio
    try:
        import edge_tts
    except Exception as e:
        handler._json({"ok": False, "error": f"没有 edge-tts: {e}"}, 500)
        return
    handler.send_response(200)
    handler.send_header("Content-Type", "audio/mpeg")
    handler.send_header("Transfer-Encoding", "chunked")
    handler.send_header("Cache-Control", "no-store")
    handler._cors()
    handler.end_headers()

    async def run():
        comm = edge_tts.Communicate(text, "zh-CN-XiaoyiNeural")
        async for chunk in comm.stream():
            if chunk["type"] == "audio" and chunk["data"]:
                data = chunk["data"]
                handler.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
                handler.wfile.flush()

    try:
        asyncio.run(run())
    except Exception as e:
        print("[tts-stream] 中断:", e)
    finally:
        try:
            handler.wfile.write(b"0\r\n\r\n")
            handler.wfile.flush()
        except Exception:
            pass


def tts_synth(text: str) -> bytes | None:
    """用 edge-tts 合成 mp3；同文本走缓存。"""
    import asyncio
    import hashlib
    try:
        import edge_tts
    except Exception as e:
        print("[tts] 没有 edge-tts:", e)
        return None
    TTS_CACHE.mkdir(exist_ok=True)
    key = hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]
    f = TTS_CACHE / (key + ".mp3")
    if f.exists():
        return f.read_bytes()

    async def run() -> bytes:
        voice = "zh-CN-XiaoyiNeural"
        comm = edge_tts.Communicate(text, voice)
        buf = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf += chunk["data"]
        return bytes(buf)

    try:
        data = asyncio.run(run())
    except Exception as e:
        print("[tts] 合成失败:", e)
        return None
    if data:
        f.write_bytes(data)
    return data or None


def _mem_load() -> list:
    try:
        return json.loads(MEM_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _mem_save(items: list) -> None:
    MEM_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")




OLLAMA_URL = "http://127.0.0.1:11434"
EMBED_MODEL = "nomic-embed-text-cpu"


def embed_text(text: str) -> list:
    """本地 embedding（Ollama nomic-embed-text）；失败返回空列表。"""
    text = (text or "").strip()
    if not text:
        return []
    payload = json.dumps({"model": EMBED_MODEL, "prompt": text[:2000]}).encode()
    req = urllib.request.Request(OLLAMA_URL + "/api/embeddings", data=payload,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read().decode("utf-8"))
        return list(d.get("embedding") or [])
    except Exception as e:
        print("[embed] 失败:", e)
        return []


def cosine(a: list, b: list) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def memory_ensure_embeddings(rebuild: bool = False) -> int:
    """给没有向量的记忆补算 embedding。返回补了几条。"""
    items = _mem_load()
    n = 0
    for it in items:
        if rebuild or not it.get("emb"):
            v = embed_text(it.get("text", ""))
            if v:
                it["emb"] = v
                n += 1
    if n:
        _mem_save(items)
    return n


def memory_search(q: str, k: int = 5) -> dict:
    if not q.strip():
        return {"ok": False, "error": "q 不能为空"}
    items = _mem_load()
    if not items:
        return {"ok": True, "items": []}
    memory_ensure_embeddings()
    items = _mem_load()
    qv = embed_text(q)
    if not qv:
        return {"ok": False, "error": "embedding 不可用（Ollama 没起？）"}
    scored = []
    for it in items:
        s = cosine(qv, it.get("emb") or [])
        if s > 0.2:
            scored.append((s, it))
    scored.sort(key=lambda x: -x[0])
    return {"ok": True, "items": [{"score": round(s, 3), "text": it.get("text"), "id": it.get("id"),
                                   "at": it.get("at"), "tag": it.get("tag")} for s, it in scored[:k]]}


def familiarity_score() -> dict:
    """了解度 0~100：按去重后的记忆条数（对数曲线）+ 覆盖话题数估算，不是准确率。"""
    items = _mem_load()
    seen = set()
    tags = set()
    for it in items:
        t = (it.get("text") or "").strip()
        if t and t not in seen:
            seen.add(t)
            if it.get("tag"):
                tags.add(it["tag"])
    n = len(seen)
    import math
    base = 1 - math.exp(-n / 24.0)          # 24 条到 ~63%
    bonus = min(0.12, len(tags) * 0.02)     # 话题覆盖最多加 12 分
    score = int(round(min(100, (base + bonus) * 100)))
    return {"ok": True, "score": score, "memories": n, "tags": sorted(tags),
            "note": "按去重记忆条数估算，不代表准确率"}




MUSIC_DIR = ROOT / "music"
STREAM_STATE = {"playing": False, "volume": 0.55, "mode": "seq", "saySeq": 0, "sayText": ""}
STREAM_LOCK = threading.Lock()


def music_list() -> list:
    MUSIC_DIR.mkdir(exist_ok=True)
    exts = (".mp3", ".m4a", ".ogg", ".wav", ".flac")
    return sorted(f.name for f in MUSIC_DIR.iterdir() if f.suffix.lower() in exts)


def stream_state() -> dict:
    with STREAM_LOCK:
        d = dict(STREAM_STATE)
    d["ok"] = True
    d["songs"] = music_list()
    return d


def stream_cmd(body: dict) -> dict:
    with STREAM_LOCK:
        for k in ("playing", "volume", "mode"):
            if k in body:
                STREAM_STATE[k] = body[k]
        return dict(STREAM_STATE)


def stream_say(text: str) -> dict:
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "text 不能为空"}
    with STREAM_LOCK:
        STREAM_STATE["saySeq"] = int(STREAM_STATE.get("saySeq") or 0) + 1
        STREAM_STATE["sayText"] = text
        seq = STREAM_STATE["saySeq"]
    try:
        push("speaking", text)
    except Exception:
        pass
    return {"ok": True, "saySeq": seq, "text": text}



LIVE_QUEUE = []
LIVE_SEQ = 0
LIVE_LOCK = threading.Lock()




LIVE_WATCH = {"proc": None, "url": "", "started": 0.0, "log": ""}
LIVE_WATCH_LOCK = threading.Lock()


def live_watch_start(url: str) -> dict:
    import subprocess
    global LIVE_WATCH
    if not url.startswith("https://live.douyin.com/") and not url.startswith("https://www.douyin.com/"):
        return {"ok": False, "error": "只支持 live.douyin.com 直播间地址"}
    with LIVE_WATCH_LOCK:
        proc = LIVE_WATCH.get("proc")
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
        script = ROOT / "live_douyin.py"
        if not script.exists():
            return {"ok": False, "error": "找不到 live_douyin.py"}
        log_path = ROOT / "live_douyin.log"
        fh = open(log_path, "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen([sys.executable, "-u", str(script), "--url", url, "--post",
                                 "http://127.0.0.1:8796"], stdout=fh, stderr=subprocess.STDOUT,
                                cwd=str(ROOT), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        LIVE_WATCH = {"proc": proc, "url": url, "started": time.time(), "log": str(log_path)}
        return {"ok": True, "pid": proc.pid, "url": url}


def live_watch_stop() -> dict:
    global LIVE_WATCH
    with LIVE_WATCH_LOCK:
        proc = LIVE_WATCH.get("proc")
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
        LIVE_WATCH["proc"] = None
        return {"ok": True}


def live_watch_status() -> dict:
    proc = LIVE_WATCH.get("proc")
    running = bool(proc and proc.poll() is None)
    tail = ""
    path = LIVE_WATCH.get("log")
    if path:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            tail = "".join(lines[-6:])
        except Exception:
            pass
    return {"ok": True, "running": running, "url": LIVE_WATCH.get("url", ""),
            "started": LIVE_WATCH.get("started", 0), "tail": tail}





# ── 抓取来源：web（网页版 CDP） / desktop（电脑版客户端） ──
DOUYIN_SOURCE = {"douyin": "web", "live": "web", "ocr": "winocr", "comment": "off", "dm_send": "off"}
SOURCE_FILE = None


def _source_path():
    global SOURCE_FILE
    if SOURCE_FILE is None:
        SOURCE_FILE = ROOT / "douyin" / "source.json"
    return SOURCE_FILE


def load_sources():
    try:
        p = _source_path()
        if p.exists():
            d = json.loads(p.read_text(encoding="utf-8"))
            for k, allowed in (("douyin", ("web", "desktop")), ("live", ("web", "desktop")),
                               ("ocr", ("winocr", "vision")), ("comment", ("on", "off")), ("dm_send", ("on", "off"))):
                if d.get(k) in allowed:
                    DOUYIN_SOURCE[k] = d[k]
    except Exception:
        pass
    return dict(DOUYIN_SOURCE)


def save_sources():
    try:
        p = _source_path()
        p.parent.mkdir(exist_ok=True)
        p.write_text(json.dumps(DOUYIN_SOURCE, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def get_source(which: str = "douyin") -> str:
    return DOUYIN_SOURCE.get(which, "web")


def set_source(which: str, source: str) -> dict:
    allowed = {"douyin": ("web", "desktop"), "live": ("web", "desktop"),
               "ocr": ("winocr", "vision"), "comment": ("on", "off"), "dm_send": ("on", "off")}
    if which not in allowed or source not in allowed[which]:
        return {"ok": False, "error": "参数不对（which=douyin|live|ocr|comment|dm_send）"}
    DOUYIN_SOURCE[which] = source
    save_sources()
    return {"ok": True, "source": dict(DOUYIN_SOURCE)}


DOUYIN_DIR = ROOT / "douyin"
DOUYIN_WATCH = {"proc": None, "started": 0.0, "pages": 0}
DOUYIN_LOCK = threading.Lock()










# ── 定时刷抖音 ──
SCHED = {"enabled": False, "time": "09:00", "pages": 2, "top": 5, "last": ""}
SCHED_FILE = ROOT / "douyin" / "schedule.json"


def load_sched():
    try:
        if SCHED_FILE.exists():
            d = json.loads(SCHED_FILE.read_text(encoding="utf-8"))
            for k in ("enabled", "time", "pages", "top", "last"):
                if k in d:
                    SCHED[k] = d[k]
    except Exception:
        pass
    return dict(SCHED)


def save_sched():
    try:
        SCHED_FILE.parent.mkdir(exist_ok=True)
        SCHED_FILE.write_text(json.dumps(SCHED, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def sched_set(body: dict) -> dict:
    for k in ("enabled", "time", "pages", "top"):
        if k in body:
            SCHED[k] = body[k]
    save_sched()
    return {"ok": True, "schedule": dict(SCHED)}


def schedule_loop():
    """每 20 秒看一次：到点且今天没跑过就触发流水线。"""
    load_sched()
    while True:
        try:
            if SCHED.get("enabled"):
                now = time.strftime("%H:%M")
                day = time.strftime("%Y-%m-%d")
                if now == SCHED.get("time") and SCHED.get("last") != day:
                    proc = DOUYIN_WATCH.get("proc")
                    if not (proc and proc.poll() is None):
                        r = douyin_pipeline(int(SCHED.get("pages") or 2), int(SCHED.get("top") or 5))
                        SCHED["last"] = day
                        save_sched()
                        print("[定时] 触发流水线:", r)
        except Exception as e:
            print("[定时] 出错:", e)
        time.sleep(20)

def douyin_pipeline(pages: int = 2, top: int = 5) -> dict:
    """刷一轮 → 补互动数据 → 语义判断，一条龙。"""
    import subprocess
    with DOUYIN_LOCK:
        proc = DOUYIN_WATCH.get("proc")
        if proc and proc.poll() is None:
            return {"ok": False, "error": "上一轮还在跑"}
        script = ROOT / "douyin_pipeline.py"
        if not script.exists():
            return {"ok": False, "error": "找不到 douyin_pipeline.py"}
        DOUYIN_DIR.mkdir(exist_ok=True)
        fh = open(DOUYIN_DIR / "pipeline.log", "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen([sys.executable, "-u", str(script),
                                 "--pages", str(pages), "--top", str(top)],
                                stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        DOUYIN_WATCH.update({"proc": proc, "started": time.time(), "pages": pages})
        return {"ok": True, "pid": proc.pid, "pages": pages, "top": top}

def douyin_enrich(top: int = 10) -> dict:
    """给最新一轮的高赞视频补互动数据（签名接口），并重排。"""
    import subprocess
    path = DOUYIN_DIR / "latest.json"
    if not path.exists():
        return {"ok": False, "error": "还没有结果，先刷一轮"}
    script = ROOT / "douyin_enrich.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 douyin_enrich.py"}
    (ROOT / "douyin").mkdir(exist_ok=True)
    log_path = DOUYIN_DIR / "enrich.log"
    fh = open(log_path, "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script), "--top", str(top)],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid, "log": str(log_path)}

def douyin_comment(aweme_id: str, text: str, dry: bool = False) -> dict:
    """给视频发一条评论（写操作，必须先把「允许评论」打开）。"""
    import subprocess
    if DOUYIN_SOURCE.get("comment") != "on" and not dry:
        return {"ok": False, "error": "评论开关没开（先在中控页打开「允许评论」）"}
    if not (aweme_id or "").strip().isdigit():
        return {"ok": False, "error": "aweme_id 不对"}
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "评论内容不能为空"}
    if len(text) > 200:
        return {"ok": False, "error": "评论太长了（>200）"}
    script = ROOT / "douyin_api_comment.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 douyin_api_comment.py"}
    args = [sys.executable, "-u", str(script), "--aweme", aweme_id, "--text", text]
    log_path = ROOT / "douyin" / "comment.log"
    try:
        (ROOT / "douyin").mkdir(exist_ok=True)
        fh = open(log_path, "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen(args, stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return {"ok": True, "pid": proc.pid, "dry": dry, "log": str(log_path)}
    except Exception as e:
        return {"ok": False, "error": f"启动失败: {e}"}









# ── 私信轮询 ──
DM_POLL = {"enabled": False, "every": 30, "announce": False}
DM_SEEN = set()
DM_NEW = []
DM_FILE = ROOT / "douyin" / "dm_poll.json"
DM_LOCK = threading.Lock()


def dm_load_cfg():
    try:
        if DM_FILE.exists():
            d = json.loads(DM_FILE.read_text(encoding="utf-8"))
            for k in ("enabled", "every", "announce"):
                if k in d:
                    DM_POLL[k] = d[k]
    except Exception:
        pass
    return dict(DM_POLL)


def dm_save():
    try:
        DM_FILE.parent.mkdir(exist_ok=True)
        DM_FILE.write_text(json.dumps(DM_POLL, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def dm_set(body: dict) -> dict:
    for k in ("enabled", "every", "announce"):
        if k in body:
            DM_POLL[k] = body[k]
    dm_save()
    return {"ok": True, "poll": dict(DM_POLL)}


def dm_new_items() -> dict:
    with DM_LOCK:
        return {"ok": True, "items": list(DM_NEW[-50:]), "total": len(DM_NEW)}


def dm_scan_once() -> dict:
    """拉一次私信，找出「对方新说的话」。"""
    import subprocess
    script = ROOT / "douyin_dm.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 douyin_dm.py"}
    try:
        r = subprocess.run([sys.executable, "-u", str(script), "--read"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           cwd=str(ROOT), timeout=60,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        (ROOT / "douyin" / "dm.log").write_text((r.stdout or "") + (r.stderr or ""), encoding="utf-8")
    except Exception as e:
        return {"ok": False, "error": f"拉取失败: {e}"}
    path = ROOT / "douyin" / "dm.json"
    if not path.exists():
        return {"ok": False, "error": "dm.json 不存在"}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e)}
    fresh = []
    for conv in d.get("conversations") or []:
        for m in conv.get("messages") or []:
            if m.get("from") != "them":
                continue
            key = f"{conv.get('conv_id')}|{m.get('at')}|{m.get('text')}"
            if key in DM_SEEN:
                continue
            DM_SEEN.add(key)
            item = {"conv": conv.get("conv_id"), "peer": conv.get("peer_uid"),
                    "text": m.get("text"), "at": m.get("at"), "key": key}
            fresh.append(item)
    if len(DM_SEEN) > 5000:
        with DM_LOCK:
            DM_SEEN.clear()
    if fresh:
        with DM_LOCK:
            DM_NEW.extend(fresh)
            while len(DM_NEW) > 200:
                DM_NEW.pop(0)
        if DM_POLL.get("announce"):
            for it in fresh[-3:]:
                try:
                    stream_say(f"私信：{it['text'][:60]}")
                except Exception:
                    pass
    return {"ok": True, "new": len(fresh), "items": fresh, "count": d.get("count")}


def dm_poll_loop():
    dm_load_cfg()
    while True:
        try:
            if DM_POLL.get("enabled"):
                dm_scan_once()
        except Exception as e:
            print("[私信轮询] 出错:", e)
        time.sleep(max(10, int(DM_POLL.get("every") or 30)))







# ── 自动模式 ──
AUTO_CFG_PATH = ROOT / "douyin" / "auto.json"
AUTO_DEFAULT = {
    "enabled": False, "auto_comment": False, "auto_like": False,
    "auto_collect": False, "admin_at": False, "alert_score": 9.0,
    "like_min_score": 6.0, "collect_min_score": 7.5, "comment_min_score": 8.0,
    "persona": "蓝色大肥鱼：说话直、爱吐槽、不端着，偶尔自嘲；喜欢有趣的东西，讨厌标题党。",
    "comment_style": "一句话，不超过 25 字，口语，不刷屏、不带链接、不@人",
    "dm_reply": False,
    "reply_comments": False,
    "dm_style": "一句口语，像朋友聊天，别太长，不用敬语",
}


def auto_cfg() -> dict:
    cfg = dict(AUTO_DEFAULT)
    try:
        if AUTO_CFG_PATH.exists():
            cfg.update(json.loads(AUTO_CFG_PATH.read_text(encoding="utf-8")))
    except Exception:
        pass
    return cfg


def auto_set(body: dict) -> dict:
    cfg = auto_cfg()
    for k, v in (body or {}).items():
        if k in AUTO_DEFAULT:
            cfg[k] = v
    AUTO_CFG_PATH.parent.mkdir(exist_ok=True)
    AUTO_CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "cfg": cfg}


def auto_run(pages: int = 1, top: int = 3) -> dict:
    import subprocess
    if not auto_cfg().get("enabled"):
        return {"ok": False, "error": "自动模式没开"}
    script = ROOT / "auto_mode.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 auto_mode.py"}
    DOUYIN_DIR.mkdir(exist_ok=True)
    fh = open(DOUYIN_DIR / "auto.log", "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script), "--pages", str(pages), "--top", str(top)],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid}


def auto_dm_reply_run() -> dict:
    import subprocess
    if not auto_cfg().get("dm_reply"):
        return {"ok": False, "error": "回私信开关没开"}
    script = ROOT / "auto_dm_reply.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 auto_dm_reply.py"}
    DOUYIN_DIR.mkdir(exist_ok=True)
    fh = open(DOUYIN_DIR / "dm_reply.log", "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script)],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid}


def auto_comment_reply_run() -> dict:
    import subprocess
    if not auto_cfg().get("reply_comments"):
        return {"ok": False, "error": "回评论开关没开"}
    script = ROOT / "auto_reply_comments.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 auto_reply_comments.py"}
    DOUYIN_DIR.mkdir(exist_ok=True)
    fh = open(DOUYIN_DIR / "comment_reply.log", "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script)],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid}


def auto_memory() -> dict:
    path = DOUYIN_DIR / "memory.json"
    if not path.exists():
        return {"ok": True, "videos": [], "memes": []}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e), "videos": [], "memes": []}
    d["ok"] = True
    d["videos"] = list(reversed((d.get("videos") or [])[-50:]))
    d["memes"] = sorted(d.get("memes") or [], key=lambda m: -(m.get("count") or 0))[:30]
    return d


def auto_alerts() -> dict:
    path = DOUYIN_DIR / "alerts.json"
    if not path.exists():
        return {"ok": True, "items": []}
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        items = []
    return {"ok": True, "items": list(reversed(items[-50:]))}



# ── 抖音登录（扫码 / 密码 / 验证码 / 同步 cookies）──
def douyin_login(action: str, **kw) -> dict:
    import subprocess
    script = ROOT / "douyin_login.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 douyin_login.py"}
    args = [sys.executable, "-u", str(script), action]
    if action == "click":
        args += ["--x", str(int(kw.get("x") or 0)), "--y", str(int(kw.get("y") or 0))]
    elif action == "password":
        args += ["--account", str(kw.get("account") or ""), "--password", str(kw.get("password") or "")]
    elif action == "sms":
        args += ["--code", str(kw.get("code") or "")]
    t0 = time.time()
    p = subprocess.run(args, cwd=str(ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=180)
    out = (p.stdout or "").strip().splitlines()
    payload = {}
    if out:
        try:
            payload = json.loads(out[-1])
        except Exception:
            payload = {"raw": out[-1][:200]}
    payload.setdefault("ok", p.returncode == 0)
    payload["ms"] = int((time.time() - t0) * 1000)
    return payload

def douyin_share(aweme_or_url: str, to: str, note: str = "") -> dict:
    """把一条视频分享给好友：优先发**卡片**（分享给朋友），失败再退回文字+链接。"""
    import subprocess
    if DOUYIN_SOURCE.get("dm_send") != "on":
        return {"ok": False, "error": "发私信开关没开"}
    raw = (aweme_or_url or "").strip()
    if raw.isdigit():
        aid = raw
    elif raw.startswith("http"):
        aid = raw.rstrip("/").split("/")[-1].split("?")[0]
    else:
        return {"ok": False, "error": "给视频 id 或链接"}
    if not aid.isdigit():
        return {"ok": False, "error": "解析不出视频 id"}
    if not (to or "").strip():
        return {"ok": False, "error": "要给好友名"}

    script = ROOT / "douyin_share_card.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 douyin_share_card.py"}
    DOUYIN_DIR.mkdir(exist_ok=True)
    fh = open(DOUYIN_DIR / "share.log", "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script), "--aweme", aid, "--to", to],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid, "mode": "card", "aweme": aid, "to": to,
            "log": str(DOUYIN_DIR / "share.log")}


def douyin_share_link(aweme_or_url: str, to: str, note: str = "") -> dict:
    """退路：发「一句话 + 链接」（不是卡片，但一定能发出去）。"""
    import subprocess
    if DOUYIN_SOURCE.get("dm_send") != "on":
        return {"ok": False, "error": "发私信开关没开"}
    raw = (aweme_or_url or "").strip()
    if raw.isdigit():
        url = f"https://www.douyin.com/video/{raw}"
    elif raw.startswith("http"):
        url = raw
    else:
        return {"ok": False, "error": "给视频 id 或链接"}
    text = ((note or "").strip() or "分享一个视频") + " " + url
    script = ROOT / "douyin_dm_send.py"
    fh = open(DOUYIN_DIR / "share.log", "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script), "--to", to, "--text", text],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid, "mode": "link", "text": text,
            "log": str(DOUYIN_DIR / "share.log")}


def douyin_dm_send(to: str, text: str) -> dict:
    """发私信（UI 自动化）。必须先打开「允许发私信」开关。"""
    import subprocess
    if DOUYIN_SOURCE.get("dm_send") != "on":
        return {"ok": False, "error": "发私信开关没开（页面点「发送：开」）"}
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "内容不能为空"}
    if len(text) > 200:
        return {"ok": False, "error": "太长了（>200）"}
    script = ROOT / "douyin_dm_send.py"
    if not script.exists():
        return {"ok": False, "error": "找不到 douyin_dm_send.py"}
    (ROOT / "douyin").mkdir(exist_ok=True)
    fh = open(ROOT / "douyin" / "dm_send.log", "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script), "--to", to, "--text", text],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid, "log": str(ROOT / "douyin" / "dm_send.log")}



def douyin_stickers(collect: bool = False) -> dict:
    """表情包：collect=True 时扫私信下载一次，否则读索引。"""
    import subprocess
    path = DOUYIN_DIR / "stickers.json"
    if collect:
        script = ROOT / "douyin_stickers.py"
        if not script.exists():
            return {"ok": False, "error": "找不到 douyin_stickers.py"}
        DOUYIN_DIR.mkdir(exist_ok=True)
        fh = open(DOUYIN_DIR / "stickers.log", "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen([sys.executable, "-u", str(script)],
                                stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return {"ok": True, "pid": proc.pid}
    if not path.exists():
        return {"ok": True, "items": [], "count": 0}
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e), "items": []}
    return {"ok": True, "count": len(items), "items": list(reversed(items[-30:]))}

def douyin_dm(refresh: bool = False) -> dict:
    """读私信（IM 协议，只读）。refresh=True 时先拉一遍。"""
    import subprocess
    path = DOUYIN_DIR / "dm.json"
    if refresh:
        script = ROOT / "douyin_dm.py"
        if not script.exists():
            return {"ok": False, "error": "找不到 douyin_dm.py"}
        DOUYIN_DIR.mkdir(exist_ok=True)
        fh = open(DOUYIN_DIR / "dm.log", "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen([sys.executable, "-u", str(script), "--read"],
                                stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return {"ok": True, "started": proc.pid}
    if not path.exists():
        return {"ok": True, "count": 0, "conversations": [], "note": "还没拉过私信"}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e), "conversations": []}
    d["ok"] = True
    return d

def douyin_notices(refresh: bool = False) -> dict:
    """读通知缓存；refresh=True 时先拉一遍。"""
    import subprocess
    path = DOUYIN_DIR / "notices.json"
    if refresh:
        script = ROOT / "douyin_notices.py"
        if not script.exists():
            return {"ok": False, "error": "找不到 douyin_notices.py"}
        DOUYIN_DIR.mkdir(exist_ok=True)
        fh = open(DOUYIN_DIR / "notices.log", "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen([sys.executable, "-u", str(script)],
                                stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return {"ok": True, "started": proc.pid}
    if not path.exists():
        return {"ok": True, "items": [], "note": "还没拉过通知"}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e), "items": []}
    items = d.get("items") or []
    for it in items:
        ts = it.get("create_time") or 0
        it["when"] = time.strftime("%m-%d %H:%M", time.localtime(ts)) if ts else ""
    d["ok"] = True
    d["count"] = len(items)
    return d


def douyin_reply(aweme_id: str, cid: str, text: str) -> dict:
    """回复某条评论（写操作，走评论开关）。"""
    import subprocess
    if DOUYIN_SOURCE.get("comment") != "on":
        return {"ok": False, "error": "评论开关没开"}
    if not (aweme_id or "").isdigit() or not (cid or "").isdigit() or not (text or "").strip():
        return {"ok": False, "error": "参数不对"}
    script = ROOT / "douyin_api_comment.py"
    DOUYIN_DIR.mkdir(exist_ok=True)
    fh = open(DOUYIN_DIR / "comment.log", "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script), "--aweme", aweme_id,
                             "--text", text, "--reply", cid],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid}

def douyin_comment_delete(aweme_id: str, cid: str) -> dict:
    """用签名接口删自己发过的评论（cid 来自 comments.json）。"""
    import subprocess
    if get_source("douyin") == "desktop":
        return {"ok": False, "error": "删除只能走网页版（要页面里的签名）"}
    if DOUYIN_SOURCE.get("comment") != "on":
        return {"ok": False, "error": "评论开关没开（先打开「允许评论」）"}
    if not (aweme_id or "").strip().isdigit() or not (cid or "").strip().isdigit():
        return {"ok": False, "error": "aweme/cid 不对"}
    script = ROOT / "douyin_api_comment.py"
    log_path = ROOT / "douyin" / "comment.log"
    (ROOT / "douyin").mkdir(exist_ok=True)
    fh = open(log_path, "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([sys.executable, "-u", str(script), "--aweme", aweme_id,
                             "--cid", cid, "--delete"],
                            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "pid": proc.pid, "log": str(log_path)}


def douyin_comments() -> dict:
    """已经通过我们发出去的评论（含 cid，可用于删除）。"""
    path = ROOT / "douyin" / "comments.json"
    if not path.exists():
        return {"ok": True, "items": []}
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e), "items": []}
    for it in items:
        it["when"] = time.strftime("%m-%d %H:%M", time.localtime(it.get("ts") or 0))
    return {"ok": True, "items": list(reversed(items[-50:]))}

def douyin_run(pages: int = 2, comments: int = 0) -> dict:
    import subprocess
    with DOUYIN_LOCK:
        proc = DOUYIN_WATCH.get("proc")
        if proc and proc.poll() is None:
            return {"ok": False, "error": "上一轮还在跑"}
        if get_source("douyin") == "desktop":
            script = ROOT / "douyin_desktop.py"
            extra_args = ["--capture", "--json"]
            if DOUYIN_SOURCE.get("ocr") == "vision":
                extra_args.append("--vision")
        else:
            script = ROOT / "douyin_browse.py"
            extra_args = ["--pages", str(pages), "--comments", str(comments)]
        if not script.exists():
            return {"ok": False, "error": "找不到 douyin_browse.py"}
        DOUYIN_DIR.mkdir(exist_ok=True)
        fh = open(DOUYIN_DIR / "browse.log", "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen([sys.executable, "-u", str(script), *extra_args],
                                stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        DOUYIN_WATCH.update({"proc": proc, "started": time.time(), "pages": pages})
        return {"ok": True, "pid": proc.pid, "pages": pages}


def douyin_status() -> dict:
    proc = DOUYIN_WATCH.get("proc")
    running = bool(proc and proc.poll() is None)
    tail = ""
    for name in ("pipeline.log", "browse.log"):
        try:
            lines = (DOUYIN_DIR / name).read_text(encoding="utf-8", errors="replace").splitlines()
            if lines:
                tail = "\n".join(lines[-6:])
                break
        except Exception:
            continue
    return {"ok": True, "running": running, "pages": DOUYIN_WATCH.get("pages", 0),
            "started": DOUYIN_WATCH.get("started", 0), "tail": tail}


def douyin_latest() -> dict:
    if get_source("douyin") == "desktop":
        dpath = DOUYIN_DIR / "desktop.json"
        if dpath.exists():
            try:
                d = json.loads(dpath.read_text(encoding="utf-8"))
                d["ok"] = True
                d["count"] = len(d.get("lines") or [])
                return d
            except Exception:
                pass
        return {"ok": True, "source": "desktop", "count": 0, "items": [], "lines": []}
    path = DOUYIN_DIR / "latest.json"
    if not path.exists():
        return {"ok": True, "count": 0, "items": []}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e), "items": []}
    d["ok"] = True
    return d


def douyin_digest(limit: int = 10) -> dict:
    d = douyin_latest()
    items = (d.get("items") or [])[:limit]
    if not items:
        return {"ok": False, "error": "还没有结果，先刷一轮"}
    lines = [f"今天刷到 {len(items)} 条值得看的：", ""]
    for i, it in enumerate(items, 1):
        lines.append(f"{i}. {it['title'][:40]}")
        lines.append(f"   @{it.get('author') or '?'} · 赞 {it.get('likes') or '?'} · {it.get('duration') or ''}")
        lines.append(f"   {it['href']}")
    text = "\n".join(lines)
    day = time.strftime("%Y-%m-%d")
    try:
        (DOUYIN_DIR / f"{day}-分享.md").write_text(text, encoding="utf-8")
    except Exception:
        pass
    return {"ok": True, "text": text, "count": len(items)}

def live_push(user: str, text: str, kind: str = "chat") -> dict:
    global LIVE_SEQ
    user = (user or "").strip()[:40]
    text = (text or "").strip()[:300]
    if not text:
        return {"ok": False, "error": "text 不能为空"}
    with LIVE_LOCK:
        LIVE_SEQ += 1
        item = {"seq": LIVE_SEQ, "user": user or "观众", "text": text, "kind": kind, "ts": time.time()}
        LIVE_QUEUE.append(item)
        while len(LIVE_QUEUE) > 200:
            LIVE_QUEUE.pop(0)
    return {"ok": True, "item": item}


def live_recent(limit: int = 50) -> dict:
    with LIVE_LOCK:
        items = LIVE_QUEUE[-limit:]
    return {"ok": True, "items": items, "seq": LIVE_SEQ}

def memory_list() -> list:
    return _mem_load()


def memory_add(text: str, tag: str = "") -> dict:
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "text 不能为空"}
    items = _mem_load()
    item = {"id": str(int(time.time() * 1000)), "text": text[:500], "tag": tag[:40], "at": time.strftime("%Y-%m-%d %H:%M")}
    emb = embed_text(item["text"])
    if emb:
        item["emb"] = emb
    items.append(item)
    _mem_save(items[-500:])
    return {"ok": True, "item": item, "count": len(items)}




def memory_update(item_id: str, text: str, tag: str = "") -> dict:
    items = _mem_load()
    for it in items:
        if str(it.get("id")) == str(item_id):
            if text:
                it["text"] = text[:500]
                emb = embed_text(it["text"])
                if emb:
                    it["emb"] = emb
            if tag:
                it["tag"] = tag[:40]
            it["editedAt"] = time.strftime("%Y-%m-%d %H:%M")
            _mem_save(items)
            return {"ok": True, "item": it}
    return {"ok": False, "error": "没找到这条记忆"}

def memory_delete(item_id: str) -> dict:
    items = [x for x in _mem_load() if str(x.get("id")) != str(item_id)]
    _mem_save(items)
    return {"ok": True, "count": len(items)}


BRIDGE_DIR = Path(os.environ.get("QQB_DIR") or Path(__file__).resolve().parent.parent)


def house_chat(text: str) -> dict:
    """把书房里说的话转给 qq-bridge 的 agent，用同一个会话 key，实现记忆互通。"""
    try:
        cfg = json.loads((BRIDGE_DIR / "config.json").read_text(encoding="utf-8"))
        owner = str(cfg.get("ownerQQ") or "").strip()
        token = (BRIDGE_DIR / "state" / "console-token").read_text(encoding="utf-8").strip()
        port = int(cfg.get("consolePort") or 3100)
    except Exception as e:
        return {"ok": False, "error": f"读不到桥接配置：{e}"}
    if not owner:
        return {"ok": False, "error": "桥接里没有 ownerQQ"}
    hint = "（这是在她的小屋里面对面说话，不要在 QQ 里发消息，只把回答写进回复里）\n"
    try:
        hits = memory_search(text, 3).get("items") or []
        if hits:
            lines = "\n".join("- " + h["text"] for h in hits if h.get("score", 0) >= 0.35)
            if lines:
                hint += "【相关记忆】\n" + lines + "\n（自然地用上，不要逐条复述）\n"
    except Exception:
        pass
    payload = json.dumps({"text": hint + text, "key": f"private:{owner}", "tools": True}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/agent/chat?token={token}",
        data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            d = json.loads(r.read().decode("utf-8"))
        return {"ok": bool(d.get("ok")), "reply": str(d.get("reply") or "").strip(), "model": d.get("model")}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200]
        return {"ok": False, "error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:160]}


def _sync_pet(state: str, text: str = "") -> None:
    if state == "thinking":
        LINK.work_status("thinking")
        LINK.anim("工作状态-思考冒泡")
    elif state == "speaking":
        LINK.say(text or "……", 8000)
        LINK.anim("碎碎念-发呆碎碎念")
    elif state == "sleep":
        LINK.sleep()
    else:
        LINK.work_status("idle")
        LINK.anim("待机呼吸休闲")


def push(state: str, text: str = "") -> dict:
    if state not in VALID:
        state = "idle"
    with _lock:
        _state.update({"state": state, "text": text[:300], "ts": time.time()})
        payload = dict(_state)
    with _clients_lock:
        for q in list(_clients):
            try:
                q.put_nowait(payload)
            except Exception:
                pass
    try:
        with open(ROOT / "board.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {state} {text[:40]}\n")
    except Exception:
        pass
    if PET_ON:
        try:
            _sync_pet(state, text)
        except Exception:
            pass
    try:
        if LAN is not None and LAN.enabled and LAN.mirror and state in ("speaking", "thinking"):
            threading.Thread(target=LAN.broadcast_state, args=(state, text), daemon=True).start()
    except Exception:
        pass
    return payload


_RATE: dict[str, list[float]] = {}
_RATE_LOCK = threading.Lock()


def _rate_ok(ip: str, limit: int = 60, window: float = 60.0) -> bool:
    now = time.time()
    with _RATE_LOCK:
        arr = [t for t in _RATE.get(ip, []) if now - t < window]
        if len(arr) >= limit:
            _RATE[ip] = arr
            return False
        arr.append(now)
        _RATE[ip] = arr
    return True


def _public_mode() -> bool:
    try:
        return bool((load_settings().get("lan") or {}).get("publicMode"))
    except Exception:
        return False


def _code_ok(handler) -> bool:
    ip = handler.client_address[0]
    if ip in ("127.0.0.1", "::1"):
        return True
    if LAN is None or not LAN.code:
        return False
    if _public_mode() and len(LAN.code) < 16:
        print("[lan] publicMode 已开启但配对码短于 16 位，拒绝所有外部请求")
        return False
    got = str(handler.headers.get("X-Room-Pet-Code") or "")
    return got == LAN.code


class Handler(BaseHTTPRequestHandler):
    server_version = "RoomPet/1.0"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path):
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _pet_routes(self, p: str) -> bool:
        if not (p.startswith("/pet/") or p.startswith("/peers") or p.startswith("/punch/") or p.startswith("/net/") or p.startswith("/pair/") or p.startswith("/house/") or p.startswith("/tts") or p.startswith("/memory") or p.startswith("/asr") or p.startswith("/stream") or p.startswith("/music") or p.startswith("/live") or p.startswith("/douyin") or p.startswith("/vision") or p.startswith("/memory/search") or p.startswith("/memory/score") or p.startswith("/memory/rebuild") or p == "/presence"):
            return False
        if self.client_address[0] not in ("127.0.0.1", "::1") and not _rate_ok(self.client_address[0]):
            self._json({"ok": False, "error": "rate-limited"}, 429)
            return True
        if not _code_ok(self):
            self._json({"ok": False, "error": "pair-code-required"}, 403)
            return True
        if p == "/vision/describe":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            self._json(vision_describe(str(body.get("image") or ""), str(body.get("prompt") or "")))
            return True
        if p == "/asr":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
            except Exception:
                raw = b""
            if not raw:
                self._json({"ok": False, "error": "没收到音频"}, 400)
                return True
            self._json(asr_transcribe(raw))
            return True
        if p == "/tts":
            from urllib.parse import parse_qs
            q = parse_qs(urlparse(self.path).query)
            text = (q.get("text") or [""])[0].strip()
            if not text:
                self._json({"ok": False, "error": "text 不能为空"}, 400)
                return True
            from urllib.parse import parse_qs as _pq
            _q = _pq(urlparse(self.path).query)
            if (_q.get("stream") or [""])[0] == "1":
                tts_stream_start(self, text)
                return True
            data = tts_synth(text)
            if not data:
                self._json({"ok": False, "error": "合成失败（检查网络或 edge-tts）"}, 500)
                return True
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(data)
            return True
        if p.startswith("/memory/search"):
            from urllib.parse import parse_qs
            q = parse_qs(urlparse(self.path).query)
            self._json(memory_search((q.get("q") or [""])[0], int((q.get("k") or ["5"])[0])))
            return True
        if p.startswith("/memory/score"):
            self._json(familiarity_score())
            return True
        if p.startswith("/memory/rebuild"):
            n = memory_ensure_embeddings(rebuild=True)
            self._json({"ok": True, "rebuilt": n})
            return True
        if p.startswith("/douyin/pipeline"):
            from urllib.parse import parse_qs as _pq2
            _q2 = _pq2(urlparse(self.path).query)
            self._json(douyin_pipeline(int(_q2.get("pages", ["2"])[0] or 2),
                                       int(_q2.get("top", ["5"])[0] or 5)))
            return True
        if p.startswith("/douyin/enrich"):
            from urllib.parse import parse_qs as _eq
            _t = int(_eq(urlparse(self.path).query).get("top", ["10"])[0] or 10)
            self._json(douyin_enrich(_t))
            return True
        if p.startswith("/douyin/schedule"):
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(sched_set(body))
            else:
                self._json({"ok": True, "schedule": load_sched()})
            return True
        if p.startswith("/douyin/login"):
            if p.endswith("qr.png") or p.endswith("shot.png"):
                name = "login-qr.png" if p.endswith("qr.png") else "login-shot.png"
                fp = DOUYIN_DIR / name
                if not fp.exists():
                    self.send_error(404)
                    return True
                data = fp.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return True
            if p.startswith("/douyin/login/status"):
                self._json(douyin_login("status"))
                return True
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                act = p.rstrip("/").split("/")[-1]
                if act in ("qr", "shot", "click", "password", "sms", "sync", "logout", "open", "info"):
                    self._json(douyin_login(act, **body))
                else:
                    self._json({"ok": False, "error": "未知动作"})
            else:
                self._json({"ok": True, "hint": "POST /douyin/login/qr|shot|click|password|sms|sync"})
            return True
        if p.startswith("/douyin/auto/run"):
            from urllib.parse import parse_qs as _aq
            _q = _aq(urlparse(self.path).query)
            self._json(auto_run(int(_q.get("pages", ["1"])[0] or 1), int(_q.get("top", ["3"])[0] or 3)))
            return True
        if p.startswith("/douyin/auto/comment_reply_run"):
            self._json(auto_comment_reply_run())
            return True
        if p.startswith("/douyin/auto/dm_run"):
            self._json(auto_dm_reply_run())
            return True
        if p.startswith("/douyin/auto/memory"):
            self._json(auto_memory())
            return True
        if p.startswith("/douyin/auto/alerts"):
            self._json(auto_alerts())
            return True
        if p.startswith("/douyin/auto"):
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(auto_set(body))
            else:
                self._json({"ok": True, "cfg": auto_cfg()})
            return True
        if p.startswith("/douyin/share"):
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                _mode = str(body.get("mode") or "card")
                _args = (str(body.get("aweme") or ""), str(body.get("to") or ""), str(body.get("note") or ""))
                self._json(douyin_share_link(*_args) if _mode == "link" else douyin_share(*_args))
            else:
                self._json({"ok": False, "error": "用 POST"})
            return True
        if p.startswith("/douyin/dm/send"):
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(douyin_dm_send(str(body.get("to") or ""), str(body.get("text") or "")))
            else:
                self._json({"ok": True, "dm_send": DOUYIN_SOURCE.get("dm_send", "off")})
            return True
        if p.startswith("/douyin/stickers"):
            from urllib.parse import parse_qs as _sq2
            _c = _sq2(urlparse(self.path).query).get("collect", ["0"])[0] in ("1", "true")
            self._json(douyin_stickers(_c))
            return True
        if p.startswith("/douyin/dm/poll"):
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(dm_set(body))
            else:
                self._json({"ok": True, "poll": dm_load_cfg()})
            return True
        if p.startswith("/douyin/dm/new"):
            self._json(dm_new_items())
            return True
        if p.startswith("/douyin/dm/scan"):
            self._json(dm_scan_once())
            return True
        if p.startswith("/douyin/dm"):
            from urllib.parse import parse_qs as _dq3
            _rf = _dq3(urlparse(self.path).query).get("refresh", ["0"])[0] in ("1", "true")
            self._json(douyin_dm(_rf))
            return True
        if p.startswith("/douyin/notices"):
            from urllib.parse import parse_qs as _nq
            _fresh = _nq(urlparse(self.path).query).get("refresh", ["0"])[0] in ("1", "true")
            self._json(douyin_notices(_fresh))
            return True
        if p.startswith("/douyin/reply"):
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(douyin_reply(str(body.get("aweme") or ""), str(body.get("cid") or ""),
                                        str(body.get("text") or "")))
            else:
                self._json({"ok": False, "error": "用 POST"})
            return True
        if p.startswith("/douyin/comments"):
            self._json(douyin_comments())
            return True
        if p.startswith("/douyin/comment/delete"):
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(douyin_comment_delete(str(body.get("aweme") or ""), str(body.get("cid") or "")))
            else:
                self._json({"ok": False, "error": "用 POST"})
            return True
        if p.startswith("/douyin/comment"):
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(douyin_comment(str(body.get("id") or ""), str(body.get("text") or ""),
                                          bool(body.get("dry"))))
            else:
                self._json({"ok": True, "comment": DOUYIN_SOURCE.get("comment", "off")})
            return True
        if p.startswith("/douyin/source"):
            from urllib.parse import parse_qs as _sq
            _qs = _sq(urlparse(self.path).query)
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                which = str(body.get("which") or _qs.get("which", ["douyin"])[0])
                src = str(body.get("source") or _qs.get("source", ["web"])[0])
                self._json(set_source(which, src))
            else:
                load_sources()
                self._json({"ok": True, "source": dict(DOUYIN_SOURCE)})
            return True
        if p.startswith("/douyin/run"):
            from urllib.parse import parse_qs as _dq
            _q = _dq(urlparse(self.path).query)
            _pages = int(_q.get("pages", ["2"])[0] or 2)
            _comments = int(_q.get("comments", ["0"])[0] or 0)
            self._json(douyin_run(_pages, _comments))
            return True
        if p.startswith("/douyin/status"):
            self._json(douyin_status())
            return True
        if p.startswith("/douyin/latest"):
            self._json(douyin_latest())
            return True
        if p.startswith("/douyin/digest"):
            from urllib.parse import parse_qs as _dq2
            _lim = int(_dq2(urlparse(self.path).query).get("limit", ["10"])[0] or 10)
            self._json(douyin_digest(_lim))
            return True
        if p.startswith("/live/watch/start"):
            from urllib.parse import parse_qs as _wq
            _u = (_wq(urlparse(self.path).query).get("url", [""])[0])
            self._json(live_watch_start(_u))
            return True
        if p.startswith("/live/watch/stop"):
            self._json(live_watch_stop())
            return True
        if p.startswith("/live/watch/status"):
            self._json(live_watch_status())
            return True
        if p.startswith("/live/msg"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            self._json(live_push(str(body.get("user") or ""), str(body.get("text") or ""), str(body.get("kind") or "chat")))
            return True
        if p.startswith("/live/recent"):
            from urllib.parse import parse_qs as _lq
            _limit = int(_lq(urlparse(self.path).query).get("limit", ["50"])[0] or 50)
            self._json(live_recent(_limit))
            return True
        if p.startswith("/stream/state"):
            self._json(stream_state())
            return True
        if p.startswith("/stream/cmd"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            self._json(stream_cmd(body))
            return True
        if p.startswith("/stream/say"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            self._json(stream_say(str(body.get("text") or "")))
            return True
        if p.startswith("/music/list"):
            self._json({"ok": True, "files": music_list()})
            return True
        if p.startswith("/music/file"):
            from urllib.parse import parse_qs
            q = parse_qs(urlparse(self.path).query)
            name = (q.get("name") or [""])[0]
            target = (MUSIC_DIR / name).resolve()
            if not str(target).startswith(str(MUSIC_DIR.resolve())) or not target.exists():
                self.send_error(404)
                return True
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Accept-Ranges", "none")
            self._cors()
            self.end_headers()
            self.wfile.write(data)
            return True
        if p == "/memory":
            if self.command == "GET":
                self._json({"ok": True, "items": memory_list()})
                return True
            if self.command == "POST":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(memory_add(str(body.get("text") or ""), str(body.get("tag") or "")))
                return True
            if self.command == "DELETE":
                from urllib.parse import parse_qs
                q = parse_qs(urlparse(self.path).query)
                self._json(memory_delete((q.get("id") or [""])[0]))
                return True
            if self.command == "PUT":
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._json(memory_update(str(body.get("id") or ""),
                                         str(body.get("text") or ""),
                                         str(body.get("tag") or "")))
                return True
        if p == "/house/chat":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            text = str(body.get("text") or "").strip()
            if not text:
                self._json({"ok": False, "error": "text 不能为空"}, 400)
                return True
            self._json(house_chat(text))
            return True
        if p == "/presence" and self.command == "GET":
            self._json({"ok": True, "page": bool(LAN and LAN.page_alive)})
            return True
        if p == "/presence":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            if LAN:
                LAN.set_page(bool(body.get("alive", True)))
            self._json({"ok": True, "page": bool(body.get("alive", True))})
            return True
        if p == "/pair/info":
            cfg = load_settings()
            lan = cfg.get("lan") or {}
            code = str(lan.get("code") or "")
            self._json({"ok": True, "code": code, "length": len(code),
                        "publicMode": bool(lan.get("publicMode")),
                        "name": str(cfg.get("name") or ""),
                        "instance": str(cfg.get("instance_key") or "")})
            return True
        if p == "/pair/code":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            new_code = str(body.get("code") or "").strip()
            cfg = load_settings()
            public = bool((cfg.get("lan") or {}).get("publicMode"))
            need = 16 if public else 6
            if len(new_code) < need:
                self._json({"ok": False, "error": "too-short", "need": need})
                return True
            cfg.setdefault("lan", {})["code"] = new_code
            cfg["lan"]["approved"] = []
            cfg["lan"]["manual"] = []
            save_settings(cfg)
            if LAN:
                LAN.set_code(new_code)
                LAN.approved.clear()
            if PUNCH:
                PUNCH.set_code(new_code)
            self._json({"ok": True, "code": new_code})
            return True
        if p == "/pair/mode":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            cfg = load_settings()
            cfg.setdefault("lan", {})["publicMode"] = bool(body.get("publicMode"))
            save_settings(cfg)
            self._json({"ok": True, "publicMode": cfg["lan"]["publicMode"],
                        "need": 16 if cfg["lan"]["publicMode"] else 6})
            return True
        if p == "/net/advice":
            try:
                self._json(punch_link.net_advice(PORT))
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
            return True
        if p == "/punch/invite":
            self._json(PUNCH.invite() if PUNCH else {"ok": False, "error": "punch-off"})
            return True
        if p == "/punch/status":
            self._json(PUNCH.status() if PUNCH else {"ok": False})
            return True
        if p == "/punch/connect":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            self._json(PUNCH.connect(str(body.get("invite") or "")) if PUNCH else {"ok": False})
            return True
        if p == "/punch/say":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            ok = bool(PUNCH and PUNCH.send_say(str(body.get("text") or "")))
            self._json({"ok": ok})
            return True
        if p == "/peers":
            self._json({"ok": True, "self": LAN.instance if LAN else None,
                        "name": LAN.name if LAN else None,
                        "peers": LAN.list_peers() if LAN else []})
            return True
        if p.startswith("/peers/"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            pid = str(body.get("id") or "")
            if p == "/peers/approve":
                ok = bool(LAN and LAN.approve(pid))
                if ok:
                    cfg = load_settings()
                    ap = cfg.setdefault("lan", {}).setdefault("approved", [])
                    if pid not in ap:
                        ap.append(pid)
                        save_settings(cfg)
                self._json({"ok": ok})
                return True
            if p == "/peers/reject":
                ok = bool(LAN and LAN.reject(pid))
                if ok:
                    cfg = load_settings()
                    ap = cfg.setdefault("lan", {}).setdefault("approved", [])
                    if pid in ap:
                        ap.remove(pid)
                        save_settings(cfg)
                self._json({"ok": ok})
                return True
            if p == "/peers/add":
                host = str(body.get("host") or "").strip()
                port = int(body.get("port") or 0)
                res = LAN.add_manual(host, port) if LAN else {"ok": False, "error": "lan-off"}
                if res.get("ok"):
                    cfg = load_settings()
                    ml = cfg.setdefault("lan", {}).setdefault("manual", [])
                    if not any(m.get("host") == host and int(m.get("port") or 0) == port for m in ml):
                        ml.append({"host": host, "port": port, "name": res["peer"]["name"]})
                    ap = cfg["lan"].setdefault("approved", [])
                    if res["peer"]["id"] not in ap:
                        ap.append(res["peer"]["id"])
                    save_settings(cfg)
                self._json(res)
                return True
            if p == "/peers/remove":
                host = str(body.get("host") or "").strip()
                port = int(body.get("port") or 0)
                ok = bool(LAN and LAN.remove_manual(host, port))
                if ok:
                    cfg = load_settings()
                    cfg.setdefault("lan", {})["manual"] = [
                        m for m in (cfg.get("lan", {}).get("manual") or [])
                        if not (m.get("host") == host and int(m.get("port") or 0) == port)
                    ]
                    save_settings(cfg)
                self._json({"ok": ok})
                return True
            if p == "/peers/say":
                text = str(body.get("text") or "").strip()
                ok = bool(LAN and pid and text and LAN.send(pid, "/pet/say", {"text": text, "durationMs": 8000, "state": "peer"}))
                self._json({"ok": ok})
                return True
            self._json({"ok": False, "error": "unknown"}, 404)
            return True
        if p == "/pet/status":
            self._json(dsh_pet_link.ping())
            return True
        if p in ("/pet/say", "/pet/anim"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                body = {}
            if p == "/pet/say":
                txt = str(body.get("text") or "")
                from urllib.parse import unquote
                from_name = unquote(str(self.headers.get("X-Room-Pet-Name") or "朋友"))
                from_id = str(self.headers.get("X-Room-Pet-Id") or "")
                print(f"[pet] 收到 say（来自 {from_name}）：{txt[:40]}")
                if from_id:
                    try:
                        push("peer_say", f"{from_name}|{txt}")
                    except Exception:
                        pass
                ok = LINK.say(txt, int(body.get("durationMs") or 8000))
            else:
                ok = LINK.anim(str(body.get("name") or ""))
            self._json({"ok": ok})
            return True
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        p = urlparse(self.path).path
        if self._pet_routes(p):
            return
        if p == "/health":
            with _lock:
                self._json({"ok": True, "state": _state["state"]})
            return
        if p == "/events":
            self._sse()
            return
        if p == "/":
            p = "/index.html"
        target = (ROOT / p.lstrip("/")).resolve()
        if not str(target).startswith(str(ROOT)):
            self.send_error(403)
            return
        self._file(target)

    def _sse(self):
        q: queue.Queue = queue.Queue(maxsize=32)
        with _clients_lock:
            _clients.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            with _lock:
                first = dict(_state)
            self.wfile.write(f"data: {json.dumps(first, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    payload = q.get(timeout=15)
                    self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _clients_lock:
                if q in _clients:
                    _clients.remove(q)

    def do_DELETE(self):
        p = urlparse(self.path).path
        if self._pet_routes(p):
            return
        self.send_error(404)

    def do_PUT(self):
        p = urlparse(self.path).path
        if self._pet_routes(p):
            return
        self.send_error(404)

    def do_POST(self):
        p = urlparse(self.path).path
        if self._pet_routes(p):
            return
        if p != "/state":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._json({"ok": False, "error": "bad json"}, 400)
            return
        payload = push(str(data.get("state") or "idle"), str(data.get("text") or ""))
        try:
            with open(ROOT / "board.log", "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {payload.get('state')} {payload.get('text','')}\n")
        except Exception:
            pass
        self._json({"ok": True, **payload})


def main():
    try:
        if LINK.register_menu():
            print("[dsh-pet] 已在右键菜单注册「书房模式」")
        else:
            print("[dsh-pet] 未发现桌宠插件（找到后自动匹配）")
    except Exception as e:
        print(f"[dsh-pet] 注册菜单失败：{e}")

    try:
        threading.Thread(target=_menu_watch, daemon=True).start()
    except Exception as e:
        print(f"[dsh-pet] 菜单监听启动失败：{e}")

    try:
        import bridge_poller
        bridge_poller.start(push)
        print("[poller] 已启动：轮询 qq-bridge /api/status")
    except Exception as e:
        print(f"[poller] 启动失败（不影响手动推送）：{e}")

    global LAN
    try:
        cfg = load_settings()
        lan_cfg = cfg.get("lan") or {}
        LAN = lan_link.LanLink(
            str(cfg.get("name") or "room-pet"), PORT,
            str(lan_cfg.get("code") or ""), bool(lan_cfg.get("enabled", True)),
            instance_key=str(cfg.get("instance_key") or ""), approved=list(lan_cfg.get("approved") or []),
            manual=list(lan_cfg.get("manual") or []),
            on_peer_say=lambda name, text: push("peer_say", f"{name}|{text}"),
        )
        LAN.mirror = bool(lan_cfg.get("mirror", True))
        LAN.start()
    except Exception as e:
        print(f"[lan] 启动失败：{e}")

    global PUNCH
    try:
        code = str((load_settings().get("lan") or {}).get("code") or "room-pet")
        PUNCH = punch_link.PunchLink(code, on_message=lambda n, t: push("peer_say", f"{n}|{t}"), name=str((load_settings().get("name") or "room-pet")))
        print("[punch] 公网直连模块已就绪（用 /punch/invite 生成邀请码）")
    except Exception as e:
        print(f"[punch] 初始化失败：{e}")

    try:
        import atexit, signal
        atexit.register(lambda: LAN and LAN.say_bye())
        signal.signal(signal.SIGTERM, lambda *a: (LAN and LAN.say_bye(), sys.exit(0)))
    except Exception:
        pass

    bind_host = "0.0.0.0" if (LAN and LAN.enabled) else "127.0.0.1"
    srv = ThreadingHTTPServer((bind_host, PORT), Handler)
    print(f"room-pet: http://127.0.0.1:{PORT}/  (bind {bind_host})")
    print(f"状态接口: POST /state  {{\"state\":\"thinking\",\"text\":\"...\"}}")
    srv.serve_forever()


load_sources()
threading.Thread(target=schedule_loop, daemon=True).start()
threading.Thread(target=dm_poll_loop, daemon=True).start()


if __name__ == "__main__":
    main()

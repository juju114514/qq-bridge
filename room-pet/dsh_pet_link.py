"""和 dsh-pet 桌宠插件对接（自动发现 + 自动匹配）。

原理：dsh-pet 的宿主半侧把 HTTP 接口挂在 DSH 自己的 Web 服务上，
前缀固定 `/dsh-pet-7340`，只监听 127.0.0.1，无需鉴权。

自动发现：
  1. 先看 qq-bridge 的 config.json 里 dsh.baseUrl（最准）
  2. 再扫本机 LISTENING 的回环端口，探测 /dsh-pet-7340/state
  3. 结果缓存 30 秒；调用失败就丢掉缓存重新发现

用法：
  link = DshPetLink()
  link.say("你好")            # 气泡（需要锁，内部自动取）
  link.anim("东张西望")
  link.work_status("thinking")
"""
from __future__ import annotations

import json
import socket
import threading
import time
import urllib.error
import urllib.request

PREFIX = "/dsh-pet-7340"
BRIDGE_CONFIG = os.environ.get("QQB_CONFIG") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")
CACHE_TTL = 30.0
PET_ID = "main"
SURFACE = "both"


def _http(method: str, url: str, body=None, timeout: float = 4.0):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw)
            except Exception:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw
    except Exception as e:
        return None, str(e)


def _listening_ports() -> list[int]:
    ports = []
    try:
        import subprocess
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10).stdout
        for line in out.splitlines():
            if "LISTENING" not in line:
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            addr = parts[1]
            if ":" not in addr:
                continue
            host, _, port = addr.rpartition(":")
            if host not in ("127.0.0.1", "0.0.0.0", "[::]", "[::1]"):
                continue
            try:
                p = int(port)
            except ValueError:
                continue
            if 1024 < p < 65535:
                ports.append(p)
    except Exception:
        pass
    return sorted(set(ports))


def _probe(base: str, timeout: float = 0.8) -> bool:
    st, _ = _http("GET", base.rstrip("/") + PREFIX + "/state", timeout=timeout)
    return st == 200


class DshPetLink:
    def __init__(self, pet_id: str = PET_ID):
        self.pet_id = pet_id
        self._base = None
        self._base_at = 0.0
        self._lock_id = None
        self._lock_exp = 0.0
        self._lock = threading.Lock()

    # ---------- 发现 ----------

    def _from_bridge_config(self):
        try:
            with open(BRIDGE_CONFIG, encoding="utf-8") as f:
                cfg = json.load(f)
            base = (cfg.get("dsh") or {}).get("baseUrl")
            if base:
                return str(base).rstrip("/")
        except Exception:
            pass
        return None

    def discover(self, force: bool = False) -> str | None:
        now = time.time()
        if not force and self._base and now - self._base_at < CACHE_TTL:
            return self._base

        cands: list[str] = []
        b = self._from_bridge_config()
        if b:
            cands.append(b)
        for p in _listening_ports():
            u = f"http://127.0.0.1:{p}"
            if u not in cands:
                cands.append(u)

        for base in cands:
            if _probe(base):
                self._base = base
                self._base_at = now
                return base
        self._base = None
        return None

    # ---------- 占用锁 ----------

    def _ensure_lock(self) -> str | None:
        with self._lock:
            if self._lock_id and time.time() < self._lock_exp - 5:
                return self._lock_id
            base = self.discover()
            if not base:
                return None
            st, body = _http(
                "POST",
                f"{base}{PREFIX}/lock?pet={self.pet_id}&surface={SURFACE}",
                {},
            )
            if isinstance(body, dict) and body.get("ok"):
                self._lock_id = body.get("lockId")
                exp = float(body.get("expiresAt") or 0) / 1000.0
                self._lock_exp = exp if exp else time.time() + 60
                return self._lock_id
            return None

    def release(self) -> None:
        with self._lock:
            if not self._lock_id:
                return
            base = self.discover()
            if base:
                _http(
                    "POST",
                    f"{base}{PREFIX}/lock/release?pet={self.pet_id}",
                    {"lockId": self._lock_id},
                )
            self._lock_id = None
            self._lock_exp = 0.0

    # ---------- 动作 ----------

    def _call(self, path: str, body=None) -> bool:
        base = self.discover()
        if not base:
            return False
        lock = self._ensure_lock()
        if not lock:
            return False
        q = f"?pet={self.pet_id}&surface={SURFACE}&lock={lock}"
        st, res = _http("POST", f"{base}{PREFIX}{path}{q}", body)
        if isinstance(res, dict) and res.get("ok"):
            return True
        if isinstance(res, dict) and res.get("reason") in ("lock-lost", "lock-required"):
            self._lock_id = None
            lock = self._ensure_lock()
            if lock:
                st, res = _http("POST", f"{base}{PREFIX}{path}?pet={self.pet_id}&surface={SURFACE}&lock={lock}", body)
                return bool(isinstance(res, dict) and res.get("ok"))
        return False

    def say(self, text: str, duration_ms: int = 8000) -> bool:
        if not text:
            return False
        return self._call("/broadcast", {"text": str(text)[:200], "durationMs": duration_ms})

    def anim(self, name: str) -> bool:
        if not name:
            return False
        return self._call("/anim", {"name": name})

    def sleep(self) -> bool:
        base = self.discover()
        if not base:
            return False
        st, res = _http("POST", f"{base}{PREFIX}/sleep?pet={self.pet_id}&surface={SURFACE}", {})
        return bool(isinstance(res, dict) and res.get("ok"))

    def wake(self) -> bool:
        base = self.discover()
        if not base:
            return False
        st, res = _http("POST", f"{base}{PREFIX}/wake?pet={self.pet_id}&surface={SURFACE}", {})
        return bool(isinstance(res, dict) and res.get("ok"))

    def work_status(self, state: str, task: str | None = None) -> bool:
        base = self.discover()
        if not base:
            return False
        body = {"state": state}
        if task:
            body["task"] = task
        st, res = _http("POST", f"{base}{PREFIX}/work-status", body)
        return bool(isinstance(res, dict) and res.get("ok"))

    def state(self) -> dict | None:
        base = self.discover()
        if not base:
            return None
        st, res = _http("GET", f"{base}{PREFIX}/state")
        return res if isinstance(res, dict) else None

    def register_menu(self, owner: str = "room-pet", labels=("书房模式",)) -> bool:
        base = self.discover()
        if not base:
            return False
        st, res = _http("POST", f"{base}{PREFIX}/menu/item", {"owner": owner, "labels": list(labels)})
        return bool(isinstance(res, dict) and res.get("ok"))

    def menu_events(self, owner: str = "room-pet") -> dict | None:
        base = self.discover()
        if not base:
            return None
        st, res = _http("GET", f"{base}{PREFIX}/menu/events?owner={owner}&wait=0")
        return res if isinstance(res, dict) else None


def ping() -> dict:
    link = DshPetLink()
    base = link.discover(force=True)
    return {"found": bool(base), "base": base, "pet": PET_ID if base else None}

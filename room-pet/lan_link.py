"""局域网自动发现 / 配对（让两台机器上的书房看板互相找到）。

机制：
  · UDP 广播（默认 47321）：每 4 秒发一次 announce，同时监听同端口
  · 每个实例有持久化的 instance_key（settings.json），对端按它记"是否同意"
  · 首次发现只是「待确认」；点「同意」后才写进 approved，之后才互推
  · 只有 pairCode 相同的实例才会出现在列表里

安全：
  · 非回环地址调用 /pet/*、/peers 必须带 X-Room-Pet-Code
  · 未同意的对端只显示、不自动互推
"""
from __future__ import annotations

import hashlib
import json
import socket
import threading
import time
import urllib.parse
import urllib.request
import uuid

MAGIC = "rp-announce-v1"
DEFAULT_PORT = 47321
PEER_TTL = 12.0   # 3 次心跳没来就判离线（announce 每 4 秒一次）


def code_hash(code: str) -> str:
    if not code:
        return ""
    return hashlib.sha256(code.encode("utf-8")).hexdigest()[:16]


def _self_ip() -> str:
    """挑一个真正的局域网地址：读 `route print -4`，取默认路由的 Interface 列。"""
    import ipaddress

    def ok(ip: str) -> bool:
        try:
            a = ipaddress.ip_address(ip)
        except Exception:
            return False
        if ip.startswith("100.") and 64 <= int(ip.split(".")[1]) <= 127:
            return True  # Tailscale 100.64.0.0/10
        return a.is_private and not a.is_loopback and not a.is_link_local and not ip.startswith("198.18.")

    best = ""
    try:
        import subprocess
        out = subprocess.run(["route", "print", "-4"], capture_output=True, text=True, timeout=8).stdout
        for line in out.splitlines():
            f = line.split()
            if len(f) < 5:
                continue
            dest, _mask, gw, iface = f[0], f[1], f[2], f[3]
            if dest == "0.0.0.0" and ok(gw) and ok(iface):
                return iface
            if ok(iface) and not best and dest.count(".") == 3:
                best = iface
    except Exception:
        pass
    return best


class LanLink:
    def __init__(self, name: str, http_port: int, code: str = "", enabled: bool = False,
                 instance_key: str | None = None, approved: list[str] | None = None,
                 manual: list[dict] | None = None, on_peer_say=None):
        self.name = name
        self.http_port = http_port
        self.code = code or ""
        self.code_hash = code_hash(self.code)
        self.enabled = enabled
        self.instance = instance_key or uuid.uuid4().hex[:8]
        self.mirror = True
        self.page_alive = False        # 本机页面是否开着（由 /presence 更新）
        self.page_at = 0.0
        self.approved: set[str] = set(approved or [])
        self.peers: dict[str, dict] = {}
        # 手动添加的远端：跨家庭网络用，形如 [{"host": "100.x.y.z", "port": 8796, "name": "..."}]
        self.manual: list[dict] = list(manual or [])
        self.on_peer_say = on_peer_say
        self._lock = threading.Lock()
        self._sock = None

    def set_page(self, alive: bool) -> None:
        self.page_alive = bool(alive)
        self.page_at = time.time()

    def say_bye(self) -> None:
        try:
            msg = json.dumps({"t": "rp-bye", "id": self.instance, "ts": int(time.time())}).encode()
            self._sock.sendto(msg, ("255.255.255.255", DEFAULT_PORT))
            self._sock.sendto(msg, ("127.0.0.1", DEFAULT_PORT))
        except Exception:
            pass

    def set_code(self, code: str) -> None:
        self.code = code or ""
        self.code_hash = code_hash(self.code)
        print(f"[lan] 配对码已更新（{len(self.code)} 位）")

    # ---------- 广播 / 监听 ----------

    def start(self) -> None:
        if not self.enabled:
            return
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        try:
            self._sock.bind(("0.0.0.0", DEFAULT_PORT))
        except OSError as e:
            print(f"[lan] 端口 {DEFAULT_PORT} 绑定失败（可能已有实例）：{e}")
            return
        self._sock.settimeout(1.0)
        threading.Thread(target=self._listen, daemon=True).start()
        threading.Thread(target=self._announce, daemon=True).start()
        threading.Thread(target=self._gc, daemon=True).start()
        threading.Thread(target=self._refresh_presence, daemon=True).start()
        if self.manual:
            threading.Thread(target=self._refresh_manual, daemon=True).start()
        print(f"[lan] 已启动：端口 {DEFAULT_PORT}，配对码 {self.code or '(未设置)'}，id {self.instance}")

    def _announce(self) -> None:
        ip = _self_ip()
        while True:
            # 每轮重新构造：page 状态会变，构造在循环外会一直发旧值
            msg = json.dumps({
                "t": MAGIC,
                "id": self.instance,
                "name": self.name,
                "port": self.http_port,
                "code": self.code_hash,
                "ip": ip,
                "page": bool(self.page_alive),
                "ts": int(time.time()),
            }).encode("utf-8")
            for host in ("255.255.255.255", "127.0.0.1"):
                try:
                    self._sock.sendto(msg, (host, DEFAULT_PORT))
                except Exception:
                    pass
            time.sleep(4)

    def _listen(self) -> None:
        while True:
            try:
                data, addr = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except Exception:
                time.sleep(0.5)
                continue
            try:
                m = json.loads(data.decode("utf-8"))
            except Exception:
                continue
            if m.get("id") == self.instance:
                continue
            if m.get("t") == "rp-bye":
                with self._lock:
                    self.peers.pop(str(m.get("id")), None)
                continue
            if m.get("t") != MAGIC:
                continue
            if self.code_hash and m.get("code") != self.code_hash:
                continue
            key = str(m.get("id"))
            src = addr[0]
            declared = str(m.get("ip") or "")
            ts = src.startswith("100.") and 64 <= int(src.split(".")[1]) <= 127
            use_ip = src if (src.startswith("192.168.") or src.startswith("10.") or ts) else (declared or src)
            with self._lock:
                self.peers[key] = {
                    "id": key,
                    "ip": use_ip,
                    "port": int(m.get("port") or self.http_port),
                    "name": str(m.get("name") or ""),
                    "approved": key in self.approved,
                    "page": bool(m.get("page")),
                    "last": time.time(),
                }

    def _gc(self) -> None:
        while True:
            now = time.time()
            with self._lock:
                for k in [k for k, v in self.peers.items() if now - v["last"] > PEER_TTL]:
                    self.peers.pop(k, None)
            time.sleep(5)

    def _probe_remote(self, host: str, port: int) -> dict | None:
        """探测一个手动添加的远端，返回 {id, name} 或 None。"""
        req = urllib.request.Request(
            f"http://{host}:{port}/peers",
            headers={"X-Room-Pet-Code": self.code},
        )
        try:
            with urllib.request.urlopen(req, timeout=3.5) as r:
                d = json.loads(r.read().decode("utf-8"))
            if not isinstance(d, dict):
                return None
            return {"id": str(d.get("self") or f"{host}:{port}"), "name": str(d.get("name") or host)}
        except Exception:
            return None

    def add_manual(self, host: str, port: int) -> dict:
        host = (host or "").strip()
        port = int(port or 0)
        if not host or port <= 0:
            return {"ok": False, "error": "bad-address"}
        hit = self._probe_remote(host, port)
        if not hit:
            return {"ok": False, "error": "unreachable"}
        if hit["id"] == self.instance:
            return {"ok": False, "error": "self"}
        entry = {"host": host, "port": port, "name": hit["name"]}
        with self._lock:
            if not any(m["host"] == host and int(m["port"]) == port for m in self.manual):
                self.manual.append(entry)
            self.approved.add(hit["id"])
            self.peers[hit["id"]] = {
                "id": hit["id"], "ip": host, "port": port, "name": hit["name"],
                "approved": True, "manual": True, "last": time.time(),
            }
        return {"ok": True, "peer": {"id": hit["id"], "name": hit["name"], "host": host, "port": port}}

    def remove_manual(self, host: str, port: int) -> bool:
        host = (host or "").strip()
        port = int(port or 0)
        with self._lock:
            self.manual = [m for m in self.manual if not (m["host"] == host and int(m["port"]) == port)]
            for k, v in list(self.peers.items()):
                if v.get("manual") and v["ip"] == host and int(v["port"]) == port:
                    self.peers.pop(k, None)
                    self.approved.discard(k)
        return True

    def _refresh_manual(self) -> None:
        while True:
            for m in list(self.manual):
                hit = self._probe_remote(m["host"], int(m["port"]))
                with self._lock:
                    if hit:
                        self.peers[hit["id"]] = {
                            "id": hit["id"], "ip": m["host"], "port": int(m["port"]),
                            "name": hit["name"], "approved": True, "manual": True, "last": time.time(),
                        }
                        self.approved.add(hit["id"])
            time.sleep(20)

    def _probe_page(self, ip: str, port: int) -> bool | None:
        req = urllib.request.Request(
            f"http://{ip}:{port}/presence",
            headers={"X-Room-Pet-Code": self.code},
        )
        try:
            with urllib.request.urlopen(req, timeout=2.5) as r:
                d = json.loads(r.read().decode("utf-8"))
            return bool(d.get("page"))
        except Exception:
            return None

    def _refresh_presence(self) -> None:
        """UDP 广播可能被同机多实例抢端口，所以再走 HTTP 确认一次页面状态。"""
        while True:
            try:
                for p in self.list_peers():
                    got = self._probe_page(p["ip"], int(p["port"]))
                    if got is not None:
                        with self._lock:
                            if p["id"] in self.peers:
                                self.peers[p["id"]]["page"] = got
            except Exception:
                pass
            time.sleep(4)

    # ---------- 对外 ----------

    def list_peers(self) -> list[dict]:
        now = time.time()
        with self._lock:
            return [dict(p, age=round(now - p["last"], 1)) for p in self.peers.values()]

    def approve(self, peer_id: str) -> bool:
        with self._lock:
            if peer_id not in self.peers:
                return False
            self.approved.add(peer_id)
            self.peers[peer_id]["approved"] = True
        return True

    def reject(self, peer_id: str) -> bool:
        with self._lock:
            self.approved.discard(peer_id)
            if peer_id in self.peers:
                self.peers[peer_id]["approved"] = False
        return True

    def send(self, peer_id: str, path: str, body: dict, timeout: float = 4.0) -> bool:
        with self._lock:
            p = self.peers.get(peer_id)
        if not p:
            return False
        req = urllib.request.Request(
            f"http://{p['ip']}:{p['port']}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Room-Pet-Code": self.code,
                "X-Room-Pet-Id": self.instance,
                "X-Room-Pet-Name": urllib.parse.quote(self.name),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status == 200
        except Exception:
            return False

    def broadcast_state(self, state: str, text: str = "") -> int:
        if not self.mirror:
            return 0
        ok = 0
        for p in self.list_peers():
            if not p.get("approved"):
                continue
            if self.send(p["id"], "/pet/say", {"text": text or "……", "durationMs": 8000, "state": state}):
                ok += 1
        return ok

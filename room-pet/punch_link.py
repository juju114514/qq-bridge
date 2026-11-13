"""公网直连：STUN 取外网地址 + 手动信令 + UDP 打洞。

思路（不需要我们自己有服务器）：
  1. 双方各自向公共 STUN 服务器发一次 binding 请求，拿到自己 NAT 后的 公网 ip:port
  2. 生成「邀请码」，用任何渠道（QQ/微信）发给对方
  3. 对方把邀请码粘进来；两边同时往对方的外网地址狂发 punch 包
     两边的 NAT 各开一个洞，第一个包穿过之后连接就通了
  4. 通了之后走同一对 socket 传 JSON（说话/动作），带 HMAC 防冒名

已知限制（必须写在文档里）：
  · 对称型 NAT（Symmetric NAT，部分运营商/企业网）打洞会失败，只能退 Tailscale
  · 邀请码里的端口有有效期（NAT 映射通常几分钟），超时重新生成
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import socket
import struct
import threading
import time

STUN_HOSTS = [("stun.l.google.com", 19302), ("stun1.l.google.com", 19302), ("stun.cloudflare.com", 3478)]

MAGIC = "punch-v1"

def local_ipv4_list() -> list[str]:
    """列出本机所有 IPv4（不依赖第三方库）。"""
    out = []
    try:
        import subprocess
        txt = subprocess.run(["ipconfig"], capture_output=True, text=True, timeout=8).stdout
        import re
        for m in re.finditer(r"IPv4[^:：]*[:：]\s*([0-9.]+)", txt):
            ip = m.group(1)
            if ip not in out:
                out.append(ip)
    except Exception:
        pass
    return out


def tailscale_info() -> dict:
    """判断本机是否装了 Tailscale，以及它的虚拟内网地址。"""
    ips = [ip for ip in local_ipv4_list() if ip.startswith("100.") and 64 <= int(ip.split(".")[1]) <= 127]
    exe = ""
    for cand in (
        os.path.join(os.environ.get("ProgramFiles", ""), "Tailscale", "tailscale.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Tailscale", "tailscale.exe"),
    ):
        try:
            import os
            if os.path.exists(cand):
                exe = cand
                break
        except Exception:
            pass
    return {"installed": bool(ips or exe), "ip": ips[0] if ips else None, "exe": exe or None}



def net_advice(port: int = 8796) -> dict:
    """给出"该走哪条路"的建议：有 Tailscale 就优先它，否则打洞。"""
    ts = tailscale_info()
    if ts["installed"] and ts["ip"]:
        return {
            "recommended": "tailscale",
            "address": f"{ts['ip']}:{port}",
            "tailscale": ts,
            "title": "已检测到 Tailscale，建议直接用它连",
            "detail": "把下面的地址发给朋友，双方各自在「手动添加」里填对方的地址即可，不受 NAT 限制。",
        }
    if ts["installed"]:
        return {
            "recommended": "tailscale-offline",
            "address": None,
            "tailscale": ts,
            "title": "Tailscale 已安装，但没拿到 100.x 地址",
            "detail": "打开 Tailscale 并登录，状态变成 Connected 后刷新本页；也可以先试下面的打洞。",
        }
    return {
        "recommended": "punch",
        "address": None,
        "tailscale": ts,
        "title": "没装 Tailscale，先试打洞",
        "detail": "家用网络多数能打通；如果 25 秒没通，再按提示装 Tailscale。",
    }


def advice_for_failure() -> dict:
    """打洞失败时给可执行的下一步。"""
    ts = tailscale_info()
    if ts["installed"] and ts["ip"]:
        return {
            "code": "use-tailscale",
            "title": "打洞没成功，但你已经有 Tailscale",
            "steps": [
                "把本机 Tailscale 地址发给对方：" + ts["ip"],
                "对方在「手动添加」里填：" + ts["ip"] + ":8796",
                "对方的地址同样填到你这边（地址在你 Tailscale 面板里看）",
                "双方配对码一致即可直接连通，不再受 NAT 影响",
            ],
            "tailscaleIp": ts["ip"],
        }
    if ts["installed"]:
        return {
            "code": "tailscale-offline",
            "title": "装了 Tailscale 但没拿到 100.x 地址",
            "steps": [
                "打开 Tailscale 并登录",
                "确认状态是 Connected，复制它的 100.x.y.z",
                "双方互相在「手动添加」里填 对方的 100.x.y.z:8796",
            ],
            "tailscaleIp": None,
        }
    return {
        "code": "suggest-tailscale",
        "title": "打洞失败：你们的 NAT 类型不支持直连",
        "steps": [
            "双方各装一个 Tailscale（免费，5 分钟）：https://tailscale.com/download",
            "登录同一个 tailnet（或用邀请链接加入）",
            "各自拿到 100.x.y.z 地址",
            "在「手动添加」里填 对方的 100.x.y.z:8796",
            "配对码保持一致，就能直连，不受 NAT 限制",
        ],
        "tailscaleIp": None,
    }



def stun_local_addr(timeout: float = 2.5):
    """向公共 STUN 服务器查询自己映射后的公网 ip:port。返回 (ip, port, sock) 或 None。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    s.bind(("0.0.0.0", 0))
    txn = os.urandom(12)
    # STUN binding request: type=0x0001, length=0, magic cookie, txn id
    msg = struct.pack(">HHI", 0x0001, 0, 0x2112A442) + txn
    for host, port in STUN_HOSTS:
        try:
            s.sendto(msg, (host, port))
            data, _ = s.recvfrom(2048)
        except Exception:
            continue
        if len(data) < 20 or struct.unpack(">H", data[0:2])[0] != 0x0101:
            continue
        i = 20
        while i + 4 <= len(data):
            atype, alen = struct.unpack(">HH", data[i:i + 4])
            val = data[i + 4:i + 4 + alen]
            if atype == 0x0020 and len(val) >= 8:      # XOR-MAPPED-ADDRESS
                fam = val[1]
                if fam == 0x01:
                    xport = struct.unpack(">H", val[2:4])[0] ^ 0x2112
                    xip = bytes(b ^ c for b, c in zip(val[4:8], struct.pack(">I", 0x2112A442)))
                    return socket.inet_ntoa(xip), xport, s
            if atype == 0x0001 and len(val) >= 8:      # MAPPED-ADDRESS
                return socket.inet_ntoa(val[4:8]), struct.unpack(">H", val[2:4])[0], s
            i += 4 + alen + ((4 - alen % 4) % 4)
    s.close()
    return None


def make_invite(ip: str, port: int, code: str) -> str:
    """邀请码：base64(json)。"""
    raw = json.dumps({"v": 1, "ip": ip, "port": port, "tag": hashlib.sha256(code.encode()).hexdigest()[:8]})
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def parse_invite(text: str) -> dict | None:
    try:
        pad = "=" * (-len(text) % 4)
        d = json.loads(base64.urlsafe_b64decode(text + pad).decode("utf-8"))
        if d.get("v") != 1 or not d.get("ip") or not d.get("port"):
            return None
        return d
    except Exception:
        return None


class PunchLink:
    def __init__(self, code: str, on_message, name: str = "room-pet"):
        self.code = code or ""
        self.tag = hashlib.sha256(self.code.encode()).hexdigest()[:8]
        self.on_message = on_message
        self.name = name
        self.sock: socket.socket | None = None
        self.public: tuple[str, int] | None = None
        self.peer: tuple[str, int] | None = None
        self.connected = False
        self.last_seen = 0.0
        self._lock = threading.Lock()
        self._stop = False
        self._recv_started = False

    def set_code(self, code: str) -> None:
        self.code = code or ""
        self.tag = hashlib.sha256(self.code.encode()).hexdigest()[:8]

    # ---------- 邀请码 ----------

    def invite(self) -> dict:
        if self.sock is None:
            got = stun_local_addr()
            if not got:
                return {"ok": False, "error": "stun-failed"}
            ip, port, s = got
            self.sock = s
            self.public = (ip, port)
        ip, port = self.public
        if not self._recv_started:
            self._recv_started = True
            threading.Thread(target=self._recv_loop, daemon=True).start()
        return {"ok": True, "invite": make_invite(ip, port, self.code), "public": f"{ip}:{port}",
                "tailscale": tailscale_info()}

    # ---------- 打洞 ----------

    def connect(self, invite_text: str) -> dict:
        inv = parse_invite(invite_text)
        if not inv:
            return {"ok": False, "error": "bad-invite"}
        if self.code and inv.get("tag") and inv["tag"] != self.tag:
            return {"ok": False, "error": "code-mismatch"}
        if self.sock is None:
            got = stun_local_addr()
            if not got:
                return {"ok": False, "error": "stun-failed"}
            ip, port, s = got
            self.sock = s
            self.public = (ip, port)
        self.peer = (inv["ip"], int(inv["port"]))
        threading.Thread(target=self._punch_loop, daemon=True).start()
        if not self._recv_started:
            self._recv_started = True
            threading.Thread(target=self._recv_loop, daemon=True).start()
        deadline = time.time() + 25
        while time.time() < deadline and not self.connected:
            time.sleep(0.3)
        res = {"ok": self.connected, "peer": "%s:%s" % self.peer,
               "public": "%s:%d" % self.public, "error": None if self.connected else "timeout"}
        if not self.connected:
            res["advice"] = advice_for_failure()
        return res

    def _punch_loop(self) -> None:
        hello = self._pack({"t": "hello", "name": self.name})
        while not self._stop and self.peer:
            try:
                self.sock.sendto(hello, self.peer)
            except Exception:
                pass
            if self.connected:
                time.sleep(10)          # 保活
            else:
                time.sleep(0.4)

    def _pack(self, obj: dict) -> bytes:
        body = json.dumps({**obj, "magic": MAGIC, "tag": self.tag}, ensure_ascii=False).encode("utf-8")
        mac = hmac.new(self.code.encode() or b"room-pet", body, hashlib.sha256).hexdigest()[:16].encode()
        return mac + b"|" + body

    def _unpack(self, data: bytes) -> dict | None:
        try:
            mac, body = data.split(b"|", 1)
            want = hmac.new(self.code.encode() or b"room-pet", body, hashlib.sha256).hexdigest()[:16].encode()
            if not hmac.compare_digest(mac, want):
                return None
            d = json.loads(body.decode("utf-8"))
            return d if d.get("magic") == MAGIC else None
        except Exception:
            return None

    def _recv_loop(self) -> None:
        self.sock.settimeout(1.0)
        while not self._stop:
            try:
                data, addr = self.sock.recvfrom(4096)
            except socket.timeout:
                continue
            except Exception:
                break
            msg = self._unpack(data)
            if not msg:
                continue
            if not self.connected:
                self.connected = True
                self.peer = addr
                print(f"[punch] 打洞成功：{addr[0]}:{addr[1]}")
                try:
                    self.sock.sendto(self._pack({"t": "hello", "name": self.name}), addr)
                except Exception:
                    pass
            self.last_seen = time.time()
            if msg.get("t") == "say":
                try:
                    self.on_message(str(msg.get("from") or "朋友"), str(msg.get("text") or ""))
                except Exception:
                    pass

    def send_say(self, text: str) -> bool:
        if not self.connected or not self.peer or not self.sock:
            return False
        try:
            self.sock.sendto(self._pack({"t": "say", "text": text, "from": self.name}), self.peer)
            return True
        except Exception:
            return False

    def local_port(self) -> int | None:
        try:
            return self.sock.getsockname()[1] if self.sock else None
        except Exception:
            return None

    def status(self) -> dict:
        return {
            "ok": True,
            "localPort": self.local_port(),
            "connected": self.connected,
            "peer": ("%s:%s" % self.peer) if self.peer else None,
            "public": ("%s:%d" % self.public) if self.public else None,
            "lastSeenAgo": round(time.time() - self.last_seen, 1) if self.last_seen else None,
        }

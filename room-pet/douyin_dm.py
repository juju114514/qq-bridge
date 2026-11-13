"""抖音私信（只读）：走 imapi 的 protobuf 接口，不点 UI

协议搬运自 dsh-douyin-scroll 的 tools/im-http.py（已按其注释"从零构造"的说明改造）：
  · imapi.douyin.com 只认 Cookie，不需要 a_bogus
  · 一次请求拿到全部「已建立会话」+ 每会话最近 N 条消息（带毫秒时间戳和发送者 uid）
  · Cookie 从我们正在跑的浏览器里用 CDP Network.getAllCookies 取（HttpOnly 的 sessionid 也能拿到）

用法：
  python douyin_dm.py --read                # 拉一遍存盘 douyin/dm.json
  python douyin_dm.py --read --limit 30
  python douyin_dm.py --cookie "sessionid=..."   # 绕过浏览器，直接给 Cookie
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "douyin")
PORT = 9237
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
IM_HOST = "https://imapi.douyin.com"
WWW = "https://www.douyin.com"
COMMON = "device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"


# ── protobuf 最小编码 ──
def ev(n):
    o = bytearray()
    v = int(n)
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            o.append(b | 0x80)
        else:
            o.append(b)
            return bytes(o)


def enc_v(fn, n):
    return ev((fn << 3) | 0) + ev(n)


def enc_ld(fn, d):
    b = d if isinstance(d, bytes) else str(d).encode("utf-8")
    return ev((fn << 3) | 2) + ev(len(b)) + b


def enc_empty(fn):
    return ev((fn << 3) | 2) + ev(0)


def rv(b, i):
    shift = 0
    result = 0
    while True:
        x = b[i]
        i += 1
        result |= (x & 0x7F) << shift
        if not (x & 0x80):
            return result, i
        shift += 7


def parse(b):
    m = {}
    i = 0
    n = len(b)
    while i < n:
        try:
            tag, i = rv(b, i)
        except IndexError:
            break
        fn = tag >> 3
        wt = tag & 7
        if not fn:
            break
        try:
            if wt == 0:
                val, i = rv(b, i)
            elif wt == 1:
                val = b[i:i + 8]
                i += 8
            elif wt == 5:
                val = b[i:i + 4]
                i += 4
            elif wt == 2:
                ln, i = rv(b, i)
                val = b[i:i + ln]
                i += ln
            else:
                break
        except IndexError:
            break
        m.setdefault(fn, []).append(val)
    return m


def g1(m, k, d=None):
    v = m.get(k)
    return v[0] if v else d


def as_str(v):
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return "" if v is None else str(v)


_SEQ = [10000 + int(time.time() * 1000) % 89]


def build_envelope(cmd, body):
    _SEQ[0] += 1

    def kv(k, v):
        return enc_ld(15, enc_ld(1, k) + enc_ld(2, v))

    return b"".join([
        enc_v(1, cmd), enc_v(2, _SEQ[0]), enc_ld(3, "0.1.8"), enc_empty(4),
        enc_v(5, 3), enc_v(6, 1), enc_ld(7, "0d50935:feat/pc-im-group"),
        enc_ld(8, body), enc_ld(9, "0"), enc_ld(11, "douyin_pc"), enc_ld(14, "360000"),
        kv("session_aid", "6383"), kv("session_did", "0"), kv("app_name", "douyin_pc"),
        kv("priority_region", "cn"), kv("user_agent", UA), kv("cookie_enabled", "true"),
        kv("browser_language", "zh-CN"), kv("browser_platform", "Win32"),
        kv("browser_name", "Mozilla"),
        kv("browser_version", "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"),
        kv("browser_online", "true"), kv("screen_width", "800"), kv("screen_height", "600"),
        kv("timezone_name", "Asia/Shanghai"), kv("deviceId", "0"), kv("is-retry", "0"),
        enc_v(18, 1), enc_ld(21, "douyin_web"), enc_ld(22, "web_sdk"),
    ])


def iso(ms):
    if not ms or ms <= 0:
        return ""
    dt = datetime.fromtimestamp(ms // 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def message_content(raw):
    """解析消息正文：文字 / 分享卡片（aweType 800 里有 itemId = 视频 id）。"""
    text = ""
    kind = "text"
    extra = {}
    try:
        c = json.loads(raw)
        awe = int(c.get("aweType") or 0)
        text = str(c.get("text") or c.get("content_title") or "").strip()
        if awe not in (0, 700):
            # 表情/图片消息：抓一个图片地址出来
            for key in ("url", "image_url", "content_url", "cover_url"):
                v = c.get(key)
                if isinstance(v, str) and v.startswith("http"):
                    extra["image"] = v
                    break
                if isinstance(v, dict):
                    urls = v.get("url_list") or []
                    if urls:
                        extra["image"] = urls[0]
                        break
        if awe == 800:
            kind = "card"
            item = str(c.get("itemId") or c.get("item_id") or "")
            if item:
                extra["aweme"] = item
            if len(text) > 60:
                text = text[:60]
            if not text and item:
                text = "分享了视频 " + item
        elif awe and awe != 700:
            kind = "card"
    except Exception:
        text = (raw or "")[:120]
    if not text:
        return None
    out = {"text": text[:200], "kind": kind}
    out.update(extra)
    return out


def peer_uid_of(conv_id, my_uid):
    parts = str(conv_id or "").split(":")
    uids = [p for p in parts if p.isdigit() and len(p) >= 8]
    other = next((u for u in uids if u != my_uid), None)
    return other or (uids[-1] if uids else "")


def cookie_from_browser() -> str:
    """页面级 Network.getCookies（新版 Chromium 的浏览器级 getAllCookies 返回空）。"""
    import asyncio
    import websockets

    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
        pages = [x for x in json.loads(r.read().decode()) if x.get("type") == "page"]
    if not pages:
        raise SystemExit(f"调试端口 {PORT} 上没有页面")
    target = next((p for p in pages if "douyin.com" in (p.get("url") or "")), pages[0])

    async def grab():
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Network.getCookies",
                                      "params": {"urls": ["https://www.douyin.com",
                                                          "https://imapi.douyin.com"]}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == 1:
                    return (m.get("result") or {}).get("cookies") or []

    cookies = asyncio.run(grab())
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--read", action="store_true")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--cookie", default="")
    args = ap.parse_args()
    if not args.read:
        print("只支持 --read")
        return

    from curl_cffi import requests as creq

    cookie = args.cookie or cookie_from_browser()
    if "sessionid=" not in cookie:
        print("[失败] Cookie 里没有 sessionid（没登录？）")
        return
    print(f"[Cookie] {len(cookie)} 字符")

    t0 = time.time()
    with creq.Session(impersonate="chrome") as s:
        s.headers.update({"User-Agent": UA, "Cookie": cookie,
                          "Referer": WWW + "/", "Origin": WWW})
        try:
            me = s.get(WWW + "/aweme/v1/web/user/profile/self/?" + COMMON, timeout=15).json()
        except Exception as e:
            print("[失败] 查登录态:", str(e)[:120])
            return
        my_uid = str((me.get("user") or {}).get("uid") or "")
        nick = (me.get("user") or {}).get("nickname") or ""
        print(f"[我] {nick} uid={my_uid}")
        if not my_uid:
            print("[失败] 登录态异常:", json.dumps(me, ensure_ascii=False)[:200])
            return

        try:
            resp = s.post(IM_HOST + "/v1/message/get_message_by_init",
                          data=build_envelope(2043, enc_ld(2043, b"")),
                          headers={"Content-Type": "application/x-protobuf",
                                   "Accept": "application/x-protobuf"}, timeout=15)
        except Exception as e:
            print("[失败] IM 请求:", str(e)[:120])
            return
        if resp.status_code != 200:
            print("[失败] IM HTTP", resp.status_code)
            return

        env = parse(resp.content)
        status = as_str(g1(env, 4))
        print(f"[IM] status={status} 用时 {int((time.time()-t0)*1000)}ms 响应 {len(resp.content)} 字节")
        if status != "OK":
            print("[失败] IM 返回", status or "(空)")
            return

        wrap = parse(g1(env, 6) or b"")
        sub = parse(g1(wrap, 2043) or b"")
        convs = []
        for blob in sub.get(1) or []:
            if not isinstance(blob, bytes):
                continue
            conv = parse(blob)
            core = parse(g1(conv, 1) or b"")
            conv_id = as_str(g1(core, 1))
            msgs = []
            for m in conv.get(2) or []:
                if not isinstance(m, bytes):
                    continue
                f = parse(m)
                sender = as_str(g1(f, 7))
                content = message_content(as_str(g1(f, 8)))
                if content is None:
                    continue
                at = int(g1(f, 10) or 0)
                item_msg = {"from": "me" if sender == my_uid else "them",
                            "text": content["text"], "kind": content["kind"],
                            "_at": at, "at": iso(at)}
                if content.get("aweme"):
                    item_msg["aweme"] = content["aweme"]
                if content.get("image"):
                    item_msg["image"] = content["image"]
                msgs.append(item_msg)
            msgs.sort(key=lambda x: x["_at"] or 0)
            # 去重：同一条系统消息在双方视角各出现一次（文本+时间相同就留一条）
            dedup = []
            for m in msgs:
                if dedup and dedup[-1]["text"] == m["text"] and dedup[-1]["at"] == m["at"]:
                    continue
                dedup.append(m)
            msgs = dedup
            for m in msgs:
                m.pop("_at", None)
            convs.append({"conv_id": conv_id, "short_id": as_str(g1(core, 2)),
                          "type": int(g1(core, 3) or 0),
                          "peer_uid": peer_uid_of(conv_id, my_uid),
                          "message_count": len(msgs),
                          "last": (msgs[-1] if msgs else {}),
                          "messages": msgs[-args.limit:]})

    print(f"[会话] {len(convs)} 个")
    for c in convs[:10]:
        last = c.get("last") or {}
        print(f"   type{c['type']} conv={c['conv_id'][:22]} peer={c['peer_uid'][:12]} "
              f"{c['message_count']} 条 · 最后：{last.get('text','')[:30]}")

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "dm.json")
    json.dump({"ok": True, "at": time.time(), "my_uid": my_uid, "nickname": nick,
               "count": len(convs), "conversations": convs},
              open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("[写盘]", path)


if __name__ == "__main__":
    main()

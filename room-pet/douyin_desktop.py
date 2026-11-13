"""抖音电脑版（客户端）抓取：先探 UIA，再看能不能走 CDP

客户端是 Chromium 壳（resources/app.asar），正常情况下：
  · 若能带 --remote-debugging-port 启动 → 和网页版一样用 CDP 读 DOM（最稳）
  · 否则用 Windows UIA 读无障碍树（Chromium 在 UIA 客户端连上后会开无障碍）

用法：
  python douyin_desktop.py --probe         # 列窗口 + 打印 UIA 能读到什么
  python douyin_desktop.py --cdp           # 只探调试端口
  python douyin_desktop.py --json          # 探针结果输出 JSON（给服务端用）
"""
import argparse
import ctypes
import ctypes.wintypes
import json
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CDP_PORTS = (9240, 9241, 9242, 9243, 9244, 9245)
USER32 = ctypes.windll.user32
PROCESS_QUERY = 0x1000


def find_douyin_windows():
    """枚举属于 douyin.exe 的顶层窗口。"""
    import subprocess
    pids = set()
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq douyin.exe", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, timeout=10).stdout
        for line in out.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) >= 2 and parts[0].lower() == "douyin.exe":
                pids.add(int(parts[1]))
    except Exception:
        pass

    result = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, lparam):
        pid = ctypes.c_ulong()
        USER32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and USER32.IsWindowVisible(hwnd):
            length = USER32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(length + 1)
            USER32.GetWindowTextW(hwnd, buf, length + 1)
            result.append({"hwnd": int(hwnd), "pid": pid.value, "title": buf.value})
        return True

    USER32.EnumWindows(cb, 0)
    return result


def cdp_probe():
    for port in CDP_PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
                info = json.loads(r.read().decode())
            return {"ok": True, "port": port, "browser": info.get("Browser")}
        except Exception:
            continue
    return {"ok": False, "ports": list(CDP_PORTS)}


def uia_probe(hwnd, limit=40):
    try:
        import comtypes
        comtypes.CoInitialize()
        import comtypes.client
        from comtypes.gen import UIAutomationClient as UIA
    except Exception as e:
        return {"ok": False, "error": f"comtypes/UIA 不可用: {e}"}
    try:
        uia = comtypes.client.CreateObject(
            "{FF48DBA4-60EF-4201-AA87-54103EEF594E}",
            interface=UIA.IUIAutomation)
        el = uia.ElementFromHandle(hwnd)
        if el is None:
            return {"ok": False, "error": "ElementFromHandle 返回空"}
        walker = uia.CreateTreeWalker(uia.RawViewWalker)
        out = []
        stack = [el]
        visited = 0
        while stack and len(out) < limit and visited < 4000:
            node = stack.pop()
            visited += 1
            try:
                name = (node.CurrentName or "").strip()
                ctype = node.CurrentControlType
                if name and len(name) > 1:
                    out.append({"type": int(ctype), "name": name[:120]})
            except Exception:
                pass
            try:
                child = walker.GetFirstChildElement(node)
            except Exception:
                child = None
            while child:
                stack.append(child)
                try:
                    child = walker.GetNextSiblingElement(child)
                except Exception:
                    child = None
        return {"ok": True, "elements": len(out), "visited": visited, "sample": out[:limit]}
    except Exception as e:
        return {"ok": False, "error": f"UIA 遍历失败: {e}"}




def capture_window(hwnd: int, out_path: str) -> dict:
    """PrintWindow 抓窗口画面（PW_RENDERFULLCONTENT=2，能抓到 Chromium 内容）。"""
    from PIL import Image
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    rect = ctypes.wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return {"ok": False, "error": "GetWindowRect 失败"}
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w <= 0 or h <= 0:
        return {"ok": False, "error": "窗口尺寸为 0"}
    hwnd_dc = user32.GetWindowDC(hwnd)
    mfc_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bmp = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
    gdi32.SelectObject(mfc_dc, bmp)
    ok = user32.PrintWindow(hwnd, mfc_dc, 2)
    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                    ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                    ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                    ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                    ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                    ("biClrImportant", ctypes.c_uint32)]
    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h
    bi.biPlanes = 1
    bi.biBitCount = 32
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mfc_dc, bmp, 0, h, buf, ctypes.byref(bi), 0)
    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    img.save(out_path)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mfc_dc)
    user32.ReleaseDC(hwnd, hwnd_dc)
    return {"ok": bool(ok), "path": out_path, "size": [w, h]}


def ollama_read_text(image_path: str, model: str = "qwen2.5vl:3b-cpu", timeout: int = 420) -> dict:
    """把截图交给本地多模态模型，只让它列文字。"""
    import base64
    import os
    try:
        from PIL import Image
        import io as _io
        img = Image.open(image_path).convert("RGB")
        # 本地视觉对分辨率很敏感：缩到宽 640 才跑得动
        if img.width > 640:
            h = int(img.height * 640 / img.width)
            img = img.resize((640, h), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        return {"ok": False, "error": f"读图失败: {e}"}
    payload = {
        "model": model,
        "prompt": "把这张截图里能看清的文字按行输出，只输出文字，不要解释，不要加序号。看不清就跳过。",
        "images": [b64],
        "stream": False,
        "options": {"num_gpu": 0},
    }
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:11434/api/generate",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode())
        return {"ok": True, "text": (d.get("response") or "").strip()}
    except Exception as e:
        return {"ok": False, "error": f"本地视觉失败: {e}"}




def _clean_cjk(line: str) -> str:
    """Windows OCR 会在每个汉字之间插空格，这里去掉。"""
    import re
    out = []
    for ch in line:
        if ch == " " and out and "\u4e00" <= out[-1] <= "\u9fff":
            prev = out[-1]
            out.pop()
            out.append(prev)
            continue
        out.append(ch)
    t = "".join(out)
    t = re.sub(r"(?<=[\u4e00-\u9fff]) (?=[\u4e00-\u9fff])", "", t)
    return t.strip()


UI_NOISE = {
    "全部", "公开课", "游戏", "二次元", "音乐", "影视", "美食", "知识", "小剧场", "生活vlog",
    "体育", "旅行", "亲子", "动物", "三农", "汽车", "美妆穿搭", "消息", "投稿", "通知", "壁纸",
    "客户端", "充钻石", "搜索", "关注", "朋友", "我的", "直播", "放映厅", "短剧", "小游戏",
    "精选", "推荐", "AI抖音", "搜索你感兴趣的内容", "抖音精选", "下载APP", "手机随时看更方便",
    "囗", "×", "∨", ">",
}


def filter_lines(lines):
    """去掉导航词、纯数字/时间、太短的噪声行。"""
    import re
    out = []
    for t in lines:
        t = t.strip()
        if not t or len(t) < 2:
            continue
        bare = t.replace(" ", "")
        if bare in UI_NOISE:
            continue
        if re.fullmatch(r"[\d:：/\-\.\s]+", bare):
            continue
        if re.fullmatch(r"[^\w\u4e00-\u9fff]+", bare):
            continue
        out.append(t)
    return out


def win_ocr_lines(image_path: str):
    """Windows 自带 OCR（毫秒级）。返回 (lines, err)。"""
    try:
        from PIL import Image
        import winocr
    except Exception as e:
        return None, f"winocr 不可用: {e}"
    try:
        img = Image.open(image_path)
        res = winocr.recognize_pil_sync(img, "zh-Hans-CN")
        lines = []
        for l in res.get("lines") or []:
            t = (l.get("text") if isinstance(l, dict) else str(l)) or ""
            t = _clean_cjk(t).strip()
            if t:
                lines.append(t)
        return filter_lines(lines), None
    except Exception as e:
        return None, f"OCR 失败: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--cdp", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--capture", action="store_true", help="截图 + OCR 读文字")
    ap.add_argument("--vision", action="store_true", help="强制用本地视觉模型（慢，约 100 秒）")
    ap.add_argument("--watch", type=float, default=0, help="连续抓：每隔 N 秒截一次，只打印新出现的行")
    ap.add_argument("--seconds", type=float, default=0, help="配合 --watch：跑多少秒后自己停（0=一直跑）")
    args = ap.parse_args()

    result = {"windows": find_douyin_windows(), "cdp": cdp_probe()}
    if result["windows"]:
        result["uia"] = uia_probe(result["windows"][0]["hwnd"])
    else:
        result["uia"] = {"ok": False, "error": "没有找到抖音窗口（客户端没开？）"}

    if args.watch > 0 and result["windows"]:
        import os
        import time as _tw
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin", "desktop_capture.png")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        seen = set()
        hwnd = result["windows"][0]["hwnd"]
        print(f"[watch] 每 {args.watch} 秒截一次，Ctrl+C 结束", flush=True)
        deadline = _tw.time() + args.seconds if args.seconds > 0 else None
        try:
            while True:
                if deadline and _tw.time() > deadline:
                    print("[watch] 到时结束")
                    break
                cap = capture_window(hwnd, out)
                if not cap.get("ok"):
                    print("[截图失败]", cap.get("error"))
                    _tw.sleep(args.watch)
                    continue
                lines, err = win_ocr_lines(out)
                if lines is None:
                    print("[OCR 失败]", err)
                    _tw.sleep(args.watch)
                    continue
                new = [l for l in lines if l not in seen]
                for l in new:
                    seen.add(l)
                if new:
                    print(_tw.strftime("[%H:%M:%S]"), "新出现", len(new), "行")
                    for l in new[:8]:
                        print("   +", l[:60])
                _tw.sleep(args.watch)
        except KeyboardInterrupt:
            print("[watch] 结束")
        return

    if args.capture and result["windows"]:
        import os
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin", "desktop_capture.png")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        cap = capture_window(result["windows"][0]["hwnd"], out)
        result["capture"] = cap
        if cap.get("ok"):
            print("[截图]", out)
            import time as _t0
            t_start = _t0.time()
            if args.vision:
                print("[识别] 本地视觉模型（慢）…")
                ocr = ollama_read_text(out)
                result["ocr"] = ocr
                lines = [l.strip() for l in (ocr.get("text") or "").split("\n") if l.strip()]
            else:
                lines, err = win_ocr_lines(out)
                if lines is None:
                    print("[Windows OCR 不可用]", err, "→ 回退视觉模型")
                    ocr = ollama_read_text(out)
                    lines = [l.strip() for l in (ocr.get("text") or "").split("\n") if l.strip()]
                result["ocr"] = {"ok": True, "engine": "windows-ocr", "lines": lines}
            result["elapsed"] = round(_t0.time() - t_start, 2)
            print(f"[文字] {len(lines)} 行，用时 {result['elapsed']} 秒")
            for l in lines[:20]:
                print("   ", l[:60])
        else:
            print("[截图失败]", cap.get("error"))

    if args.capture:
        import os
        import time as _t
        lines = list((result.get("ocr") or {}).get("lines") or [])
        if not lines:
            txt = ((result.get("ocr") or {}).get("text") or "").strip()
            if txt:
                lines = [l.strip() for l in txt.split("\n") if l.strip()]
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin", "desktop.json")
        try:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "w", encoding="utf-8") as f:
                json.dump({"ok": True, "source": "desktop", "at": _t.time(),
                           "capture": result.get("capture"), "lines": lines}, f, ensure_ascii=False)
        except Exception:
            pass

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
        return

    print("[窗口]")
    for w in result["windows"]:
        print(f"  hwnd={w['hwnd']} pid={w['pid']} title={w['title'][:40]}")
    if not result["windows"]:
        print("  （没有抖音窗口 —— 客户端没开或最小化到托盘）")
    print("[CDP]", json.dumps(result["cdp"], ensure_ascii=False))
    u = result["uia"]
    if u.get("ok"):
        print(f"[UIA] 读到 {u['elements']} 个有名字的元素（遍历 {u['visited']} 个节点）")
        for e in u["sample"][:20]:
            print(f"   type={e['type']}  {e['name']}")
    else:
        print("[UIA]", u.get("error"))


if __name__ == "__main__":
    main()

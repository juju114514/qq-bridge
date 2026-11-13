"""用抖音自己的「分享给朋友」把视频以**卡片**发给好友

逻辑抄自 dsh-douyin-scroll 的 tools/card-share.mjs（已按其注释里的三个坑改写）：
  ① 分享图标没有 onClick，是 onMouseEnter 的 hover 弹窗 —— 必须真实鼠标轨迹移过去
  ② 面板不在 [data-e2e="video-share-container"] 里（改版后是 0×0 壳）——
     改按叶子文字「分享给朋友」反查，向上找第一个宽>250 高>100 的祖先
  ③ 页面可能 30 秒才画好 —— 轮询等分享图标真的有尺寸

用法：
  python douyin_share_card.py --aweme 7695655459017882341 --to 居居罗
  python douyin_share_card.py --aweme ... --to 居居罗 --dry     # 只展开面板看结构
  python douyin_share_card.py --aweme ... --to 居居罗 --peek     # 打印面板每行
"""
import argparse
import asyncio
import json
import subprocess
import sys
import time
import urllib.request

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EDGE = os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe")
PROFILE = os.environ.get("DY_PROFILE") or os.path.join(os.path.expanduser("~"), "QQBot", "temp", "dy", "browseprofile")
PORT = 9237


def http_json(url, timeout=6):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


async def send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return m


async def ev(ws, expr, mid, timeout_s=40):
    r = await asyncio.wait_for(send(ws, mid, "Runtime.evaluate",
                                    {"expression": expr, "returnByValue": True, "awaitPromise": True}),
                               timeout=timeout_s)
    res = r.get("result") or {}
    if res.get("exceptionDetails"):
        return None
    return ((res.get("result") or {}) if isinstance(res, dict) else {}).get("value")


async def mv(ws, mid, x, y):
    await send(ws, mid, "Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})


async def click(ws, mid, x, y):
    await mv(ws, mid, x, y)
    await asyncio.sleep(0.12)
    await send(ws, mid, "Input.dispatchMouseEvent",
               {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1})
    await send(ws, mid, "Input.dispatchMouseEvent",
               {"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1})


PANEL_FN = r"""function findPanel(){
  var hit = null;
  document.querySelectorAll('div,span,p').forEach(function(e){
    if (!hit && !e.children.length && (e.innerText||'').replace(/\s+/g,' ').trim() === '分享给朋友') hit = e;
  });
  if (hit) {
    for (var box = hit, i = 0; box && i < 10; i++, box = box.parentElement) {
      var r = box.getBoundingClientRect();
      if (r.width > 250 && r.height > 100) return box;
    }
  }
  var sc = document.querySelector('[data-e2e="video-share-container"]');
  if (sc && (sc.innerText||'').replace(/\s+/g,' ').trim()) return sc;
  return null;
}"""


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aweme", required=True)
    ap.add_argument("--to", required=True, help="好友昵称")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--peek", action="store_true")
    args = ap.parse_args()

    try:
        pages = [x for x in http_json(f"http://127.0.0.1:{PORT}/json/list") if x.get("type") == "page"]
    except Exception:
        subprocess.Popen([EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                          "--no-first-run", "--no-default-browser-check", "--mute-audio",
                          f"https://www.douyin.com/video/{args.aweme}"])
        await asyncio.sleep(9)
        pages = [x for x in http_json(f"http://127.0.0.1:{PORT}/json/list") if x.get("type") == "page"]

    target = next((p for p in pages if "/video/" in (p.get("url") or "")), pages[0] if pages else None)
    if not target:
        print("[错误] 没有页面")
        return

    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 25) as ws:
        mid = 1
        await send(ws, mid, "Page.navigate", {"url": f"https://www.douyin.com/video/{args.aweme}"})
        mid += 1
        print("[页面]", args.aweme)

        # ① 等分享图标真的有尺寸（最多 30 秒）
        pos = {}
        for t in range(30):
            await asyncio.sleep(1)
            r = await ev(ws, """(function(){
              var ic = document.querySelector('[data-e2e="video-share-icon-container"]');
              if (!ic) return '{}';
              var b = ic.getBoundingClientRect();
              if (!(b.width > 8 && b.height > 8)) return '{}';
              return JSON.stringify({x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2)});
            })()""", mid)
            mid += 1
            try:
                pos = json.loads(r or "{}")
            except Exception:
                pos = {}
            if pos.get("x"):
                print(f"[图标] {pos}（等了 {t+1}s）")
                break
        if not pos.get("x"):
            print("[失败] 找不到分享图标（30 秒还没画好）")
            return

        # ② 真实轨迹 hover（el.click() 打不开）
        await mv(ws, mid, 20, 20)
        await asyncio.sleep(0.25)
        for i in range(1, 9):
            await mv(ws, mid, round(20 + (pos["x"] - 20) * i / 8), round(20 + (pos["y"] - 20) * i / 8))
            await asyncio.sleep(0.07)
        await mv(ws, mid, pos["x"], pos["y"])
        mid += 1
        await asyncio.sleep(2)

        # ③ 等面板展开（最多 4 秒）
        panel = ""
        for _ in range(8):
            await asyncio.sleep(0.5)
            panel = await ev(ws, f"(function(){{{PANEL_FN};var sc=findPanel();return sc ? (sc.innerText||'').replace(/\\s+/g,' ').slice(0,400) : ''}})()", mid)
            mid += 1
            if panel:
                break
        if not panel:
            print("[失败] 分享面板没展开")
            return
        print("[面板]", panel[:220])

        if args.peek:
            rows = await ev(ws, f"""(function(){{{PANEL_FN};var sc=findPanel();
              if(!sc) return '[]';
              var out=[];
              sc.querySelectorAll('div').forEach(function(e){{
                var t=(e.innerText||'').replace(/\\s+/g,' ').trim();
                if(!t || t.length>40 || t==='分享') return;
                var b=e.getBoundingClientRect();
                out.push({{t:t, x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), w:Math.round(b.width)}});
              }});
              return JSON.stringify(out.slice(0,30));
            }})()""", mid)
            mid += 1
            print("[面板行]", rows[:800])

        # ④ 按昵称找那一行 + 它的「分享」按钮
        found = await ev(ws, f"""(function(){{{PANEL_FN};var sc=findPanel();var who={json.dumps(args.to, ensure_ascii=False)};
          if(!sc) return JSON.stringify({{err:'no-panel'}});
          var nodes=Array.prototype.slice.call(sc.querySelectorAll('div,span,p')).filter(function(e){{
            return (e.innerText||'').trim()===who;
          }}).sort(function(a,b){{ return a.getBoundingClientRect().width - b.getBoundingClientRect().width }});
          if(!nodes.length) return JSON.stringify({{err:'no-name', text:(sc.innerText||'').replace(/\\s+/g,' ').slice(0,160)}});
          var out=[];
          nodes.forEach(function(nameNode){{
            var row=nameNode;
            for(var i=0;i<6 && row;i++){{
              var btns=Array.prototype.slice.call(row.querySelectorAll('div,span,button')).filter(function(e){{
                return (e.innerText||'').trim()==='分享';
              }});
              if(btns.length){{
                var b=btns[0], r=b.getBoundingClientRect();
                if(r.width>16 && r.height>12){{
                  out.push({{btn:{{x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}}}});
                }}
                break;
              }}
              row=row.parentElement;
            }}
          }});
          return JSON.stringify({{candidates:out}});
        }})()""", mid)
        mid += 1
        try:
            f = json.loads(found or "{}")
        except Exception:
            f = {"err": "bad-json"}
        if f.get("err"):
            print("[失败] 找不到该好友那一行:", f)
            return
        cands = f.get("candidates") or []
        print(f"[候选] {len(cands)} 个 → {cands[:3]}")
        if not cands:
            print("[失败] 面板里没有这个人的分享按钮")
            return
        if args.dry:
            print("[dry] 面板结构与按钮都拿到了，不点")
            return

        b = cands[0]["btn"]
        await click(ws, mid, b["x"], b["y"])
        mid += 1
        await asyncio.sleep(2.5)

        after = await ev(ws, f"""(function(){{{PANEL_FN};var sc=findPanel();
          return JSON.stringify({{
            panelStillOpen: sc ? sc.getBoundingClientRect().height > 10 : false,
            panelText: sc ? (sc.innerText||'').replace(/\\s+/g,' ').slice(0,160) : '',
            toast: (document.body.innerText||'').indexOf('已发送')>=0 || (document.body.innerText||'').indexOf('发送成功')>=0
          }});
        }})()""", mid)
        print("[结果]", after)
        time.sleep(0) if False else None


if __name__ == "__main__":
    asyncio.run(main())

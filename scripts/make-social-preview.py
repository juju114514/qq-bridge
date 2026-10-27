#!/usr/bin/env python3
"""生成 GitHub 仓库的 social preview 图（1280×640）。

用法：
    python scripts/make-social-preview.py            # 输出 assets/social-preview.png
    python scripts/make-social-preview.py --out x.png

为什么是一个脚本而不是一张图：
  · 改文案/改配色时能重出，不用开设计软件
  · 320×160 的缩略图尺寸下也能看清（标题 52px、正文 24px 是有意放大到这个程度的）

依赖：Pillow（本仓库不需要它跑桥接，只用于这个脚本）
字体：Windows 自带 msyhbd/msyh + consola；找不到会退回 PIL 默认字体并告警。

素材来历：右侧形象取自 assets/deepseek娘.png（DeepSeek 鲸鱼形象，归属见 assets/README.md）。
处理方式：从四边做**容差 flood fill** 扣掉浅灰背景，保留围裙/袜子的白色（它们不与边缘连通）。
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASCOUT = os.path.join(ROOT, "assets", "deepseek娘.png")
W, H = 1280, 640

# ── 配色（深色底 + DeepSeek 蓝）────────────────────────────────────────────
BG_TOP = (10, 18, 32)
BG_BOTTOM = (18, 32, 58)
ACCENT = (77, 163, 255)
TEXT = (233, 240, 252)
DIM = (150, 168, 196)
CHIP_BG = (18, 30, 51)
CHIP_BORDER = (42, 59, 87)
CHIP_TEXT = (201, 214, 234)

FONT_DIR = r"C:\Windows\Fonts"


def load_font(names, size):
    for name in names:
        path = os.path.join(FONT_DIR, name) if os.name == "nt" else name
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    print(f"  ⚠️ 找不到字体 {names}，退回默认字体（排版会难看）", file=sys.stderr)
    return ImageFont.load_default()


def gradient(size, top, bottom):
    """竖直线性渐变。逐行画线比逐像素快得多。"""
    img = Image.new("RGB", size, top)
    d = ImageDraw.Draw(img)
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        d.line(
            [(0, y), (size[0], y)],
            fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return img


def cut_background(img, tolerance=26):
    """从四边 flood fill 抠掉浅色背景；不与边缘连通的白色（围裙/袜子）会保留。"""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    bg = px[0, 0][:3]

    def is_bg(p):
        return (
            abs(p[0] - bg[0]) <= tolerance
            and abs(p[1] - bg[1]) <= tolerance
            and abs(p[2] - bg[2]) <= tolerance
        )

    seen = bytearray(w * h)
    stack = []
    for x in range(w):
        stack.append((x, 0))
        stack.append((x, h - 1))
    for y in range(h):
        stack.append((0, y))
        stack.append((w - 1, y))

    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        idx = y * w + x
        if seen[idx]:
            continue
        seen[idx] = 1
        if not is_bg(px[x, y]):
            continue
        px[x, y] = (0, 0, 0, 0)
        stack.append((x + 1, y))
        stack.append((x - 1, y))
        stack.append((x, y + 1))
        stack.append((x, y - 1))

    # 边缘抗锯齿：把 alpha 轻微外扩再模糊，避免白边
    alpha = img.getchannel("A").filter(ImageFilter.MinFilter(3))
    img.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.6)))
    return img


def fit(img, max_w, max_h):
    scale = min(max_w / img.width, max_h / img.height)
    return img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)


def pill(draw, x, y, text, font, pad_x=18, pad_y=11):
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    w, h = tw + pad_x * 2, th + pad_y * 2
    draw.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=CHIP_BG, outline=CHIP_BORDER, width=1)
    draw.text((x + pad_x, y + pad_y - box[1]), text, font=font, fill=CHIP_TEXT)
    return w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "assets", "social-preview.png"))
    args = ap.parse_args()

    canvas = gradient((W, H), BG_TOP, BG_BOTTOM).convert("RGBA")

    # 右上角的柔光：让形象不像是"贴"上去的
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([760, 20, 1300, 620], fill=(36, 92, 170, 120))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(90)))

    # ── 右侧形象 ──────────────────────────────────────────────────────────
    if os.path.exists(MASCOUT):
        mascot = cut_background(Image.open(MASCOUT))
        mascot = fit(mascot, 470, 560)
        canvas.alpha_composite(mascot, (W - mascot.width - 60, H - mascot.height - 40))
    else:
        print(f"  ⚠️ 缺少 {MASCOUT}，跳过形象", file=sys.stderr)

    d = ImageDraw.Draw(canvas)
    f_kicker = load_font(["consola.ttf", "consolab.ttf"], 20)
    f_title = load_font(["msyhbd.ttc", "simhei.ttf"], 52)
    f_desc = load_font(["msyh.ttc", "simhei.ttf"], 23)
    f_chip = load_font(["msyh.ttc", "simhei.ttf"], 20)
    f_footer = load_font(["consola.ttf", "consolab.ttf"], 18)

    x = 72

    # kicker
    d.text((x, 78), "qq-bridge   ·   MIT   ·   OneBot v11", font=f_kicker, fill=ACCENT)

    # 标题
    d.text((x, 122), "把 QQ 接进 DeepSeek", font=f_title, fill=TEXT)
    d.text((x, 188), "Harness 桥接", font=f_title, fill=TEXT)

    # 分隔线
    d.rounded_rectangle([x, 268, x + 76, 272], radius=2, fill=ACCENT)

    # 一句话定位
    d.text((x, 296), "AI 不直连 QQ —— 出站消息全过白名单 · 额度 · 脱敏", font=f_desc, fill=DIM)
    d.text((x, 332), "群聊拟人、人格卡、语音点歌、控制台、崩溃自动拉起", font=f_desc, fill=DIM)

    # 能力胶囊（两行）
    rows = [["群聊拟人", "人格卡", "语音 · 点歌"], ["控制台", "守护进程", "45 套回归"]]
    cy = 392
    for row in rows:
        cx = x
        for label in row:
            cx += pill(d, cx, cy, label, f_chip) + 12
        cy += 52

    # 页脚
    d.text((x, H - 78), "github.com/juju114514/qq-bridge", font=f_footer, fill=DIM)
    d.text((x, H - 52), "node >= 22.13    ·    Windows / Linux", font=f_footer, fill=(110, 128, 156))

    canvas.convert("RGB").save(args.out, "PNG", optimize=True)
    size_kb = round(os.path.getsize(args.out) / 1024)
    print(f"  ✓ {args.out}  {W}×{H}  {size_kb} KB")


if __name__ == "__main__":
    main()

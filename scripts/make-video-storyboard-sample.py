#!/usr/bin/env python3
"""生成「视频故事板」文档配图（合成内容，不含任何真人画面/隐私）。

为什么不用真实截图当配图：故事板是从用户发的视频里抽的帧，里面可能有聊天、账号、桌面内容。
文档配图用**合成图**演示版式就够了（3×3、每格左上角时间戳、格间 4px 白边）。

用法：
    python scripts/make-video-storyboard-sample.py            # 输出 assets/video-storyboard-sample.jpg
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "video-storyboard-sample.jpg")

COLS, ROWS = 3, 3
CELL_W, CELL_H = 420, 236
PAD = 4
W = COLS * CELL_W + PAD * (COLS + 1)
H = ROWS * CELL_H + PAD * (ROWS + 1)
FONT = r"C:\Windows\Fonts\msyh.ttc"
MONO = r"C:\Windows\Fonts\consola.ttf"

# 9 格各写一句"剧情"，模拟均匀采样看到的画面演进
CAPTIONS = [
    ("0.5s", "开场：鲸鱼游过对话框"),
    ("2.0s", "镜头推进：屏幕录制"),
    ("4.1s", "设置页：安全 → 排除项"),
    ("6.1s", "选中一行，弹出菜单"),
    ("8.1s", "确认弹窗：是否继续"),
    ("10.1s", "回到列表，勾选生效"),
    ("12.2s", "切到日志页看结果"),
    ("14.2s", "滚动到列表底部"),
    ("16.2s", "结束：停在成功提示"),
]


def main():
    canvas = Image.new("RGB", (W, H), (24, 28, 38))
    draw = ImageDraw.Draw(canvas)
    f_label = ImageFont.truetype(MONO, 20)
    f_title = ImageFont.truetype(FONT, 26)
    f_body = ImageFont.truetype(FONT, 18)

    for i, (ts, caption) in enumerate(CAPTIONS):
        col, row = i % COLS, i // COLS
        x = PAD + col * (CELL_W + PAD)
        y = PAD + row * (CELL_H + PAD)
        # 每格底色略作差别，模拟画面演进
        shade = 46 + i * 4
        draw.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], fill=(shade, shade + 6, shade + 16))
        # 假"画面内容"
        draw.rounded_rectangle([x + 16, y + 52, x + CELL_W - 16, y + CELL_H - 20], radius=8,
                               fill=(250, 250, 252), outline=(210, 214, 224))
        draw.text((x + 30, y + 66), caption, font=f_title, fill=(28, 34, 48))
        draw.text((x + 30, y + 104), "故事板示例 · 不是真实截图", font=f_body, fill=(130, 140, 158))
        draw.text((x + 30, y + 132), f"第 {i + 1}/{COLS * ROWS} 格", font=f_body, fill=(130, 140, 158))
        # 左上角时间戳（真实故事板由 ffmpeg drawtext 烧上去，样式一致）
        box = draw.textbbox((0, 0), ts, font=f_label)
        tw, th = box[2] - box[0], box[3] - box[1]
        draw.rectangle([x + 6, y + 6, x + 6 + tw + 10, y + 6 + th + 8], fill=(0, 0, 0))
        draw.text((x + 11, y + 9), ts, font=f_label, fill=(255, 255, 255))

    canvas.save(OUT, "JPEG", quality=82, optimize=True)
    print(f"  ✓ {OUT}  {W}×{H}  {round(os.path.getsize(OUT) / 1024)} KB")


if __name__ == "__main__":
    main()

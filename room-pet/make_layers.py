"""从整图帧里拆出"够用"的分层，并导出 Cubism 可导入的 PSD。

拿到的是什么：
  face       脸部底图（把眼睛/嘴挖掉并 inpaint）
  eyes_open  睁眼（来自 idle）
  eyes_closed 闭眼（来自 blink）
  mouth_closed / mouth_open（来自 idle / crying）
  body       整张立绘（不含头部五官，作为最底）

局限（必须知道）：
  · 不是原画分层，是从同一张图里抠的，边缘会有少量重影
  · 头发、眉毛没有独立分层 → Cubism 里做不了发丝摆动
  · 这已经足够做「眨眼 + 张嘴 + 转头」三件事，也就是 L2D 最常用的三个参数
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "assets" / "character"
OUT = ROOT / "assets" / "layers"
OUT.mkdir(parents=True, exist_ok=True)


def load(name: str) -> np.ndarray:
    img = cv2.imread(str(SRC / f"{name}.png"), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(name)
    return img


def bbox_from_diff(a: np.ndarray, b: np.ndarray, thr: int = 60) -> list[tuple[int, int, int, int]]:
    d = np.abs(a[:, :, :3].astype(np.int16) - b[:, :, :3].astype(np.int16)).sum(axis=2)
    mask = (d > thr).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    boxes = []
    for i in range(1, n):
        x, y, w, h, a_ = stats[i]
        if a_ >= 2000:
            boxes.append((int(x), int(y), int(w), int(h)))
    return boxes


def crop_with_alpha(img: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x, y, w, h = box
    patch = img[y:y + h, x:x + w].copy()
    return patch


def save_png(img: np.ndarray, name: str) -> Path:
    p = OUT / name
    cv2.imwrite(str(p), img)
    return p


def build_psd(layers: list[tuple[str, np.ndarray, tuple[int, int]]], size: tuple[int, int]) -> Path:
    psd = PSDImage.new(mode="RGBA", size=size)
    # 数组是 (H, W, 4)，psd-tools 需要 (H, W, 4) uint8
    for name, arr, (left, top) in layers:
        layer = PixelLayer.frompil(Image.fromarray(cv2.cvtColor(arr, cv2.COLOR_BGRA2RGBA)), psd, name)
        layer.left, layer.top = left, top
        psd.append(layer)
    out = ROOT / "assets" / "tujingjing.psd"
    psd.save(out)
    return out


def main() -> None:
    idle = load("idle")
    blink = load("blink")
    cry = load("crying")
    H, W = idle.shape[:2]
    print(f"  画布 {W}x{H}")

    # 1) 固定几何：从 idle/blink 的对齐关系手动量出来的（画布 1254x1254）
    eyes = [(450, 470, 185, 165), (665, 470, 185, 165)]
    mouth = (630, 620, 95, 62)
    print("  眼睛区块:", eyes, " 嘴巴:", mouth)

    # 2) 脸部底图：把眼睛和嘴挖掉再 inpaint
    face = idle.copy()
    mask = np.zeros((H, W), np.uint8)
    for (x, y, w, h) in eyes:
        mask[y:y + h, x:x + w] = 255
    x, y, w, h = mouth
    mask[y:y + h, x:x + w] = 255
    mask = cv2.dilate(mask, np.ones((9, 9), np.uint8), iterations=2)
    face[:, :, :3] = cv2.inpaint(face[:, :, :3], mask, 5, cv2.INPAINT_TELEA)
    save_png(face, "face.png")

    # 预览：底图 + 闭眼，确认没穿帮
    preview = face.copy()
    for i, box in enumerate(eyes, 1):
        x, y, w, h = box
        preview[y:y + h, x:x + w] = blink[y:y + h, x:x + w]
    save_png(preview, "preview_closed.png")

    # 4) 眼睛开/闭、嘴开/闭
    layers: list[tuple[str, np.ndarray, tuple[int, int]]] = []
    for i, box in enumerate(eyes, 1):
        o = crop_with_alpha(idle, box)
        c = crop_with_alpha(blink, box)
        save_png(o, f"eye{i}_open.png")
        save_png(c, f"eye{i}_closed.png")
        layers.append((f"eye{i}_open", o, (box[0], box[1])))
        layers.append((f"eye{i}_closed", c, (box[0], box[1])))

    if mouth:
        mc = crop_with_alpha(idle, mouth)
        mo = crop_with_alpha(cry, mouth)
        save_png(mc, "mouth_closed.png")
        save_png(mo, "mouth_open.png")
        layers.append(("mouth_closed", mc, (mouth[0], mouth[1])))
        layers.append(("mouth_open", mo, (mouth[0], mouth[1])))

    layers.append(("face", face, (0, 0)))
    layers.append(("body", idle, (0, 0)))

    out = build_psd(layers, (W, H))
    meta = {
        "canvas": [W, H],
        "eyes": eyes,
        "mouth": mouth,
        "layers": [n for n, _, _ in layers],
        "note": "face 已挖掉五官；eye*/mouth* 是局部贴片，导入 Cubism 后按位置绑定即可",
    }
    (OUT / "layers.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("  分层目录:", OUT)
    print("  PSD:", out, f"{out.stat().st_size/1024:.0f} KB")


if __name__ == "__main__":
    main()

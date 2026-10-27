# assets/ 素材归属

本目录放**运行时用到的图片素材**。先声明归属：

| 文件 | 用途 | 权利方 | 本仓库的立场 |
| --- | --- | --- | --- |
| `deepseek娘.png` | `GET /api/socialV2/self-image` —— 让模型"看到自己长什么样"（AI 形象） | DeepSeek 的鲸鱼形象：著作权与商标归 **DeepSeek（杭州深度求索）** | 仅作**个人自用示例**。本仓库的 MIT **不覆盖**这张图；不声称任何授权，也不用于商业用途 |
| `video-storyboard-sample.jpg` | [docs/guides/VIDEO.md](../docs/guides/VIDEO.md) 的版式配图 | **本仓库自制**（`scripts/make-video-storyboard-sample.py` 生成，纯合成） | MIT 覆盖，可自由使用 |
| `social-preview.png` | GitHub「Social preview」（1280×640）：分享链接时的缩略图 | 同上 —— 它**派生自** `deepseek娘.png`（抠背景 + 排版），归属与限制与上面一行完全一致 | 同样不落 MIT；生成脚本是 `scripts/make-social-preview.py`，想换形象就覆盖后重跑 |

## social-preview.png 怎么重做

```bash
python scripts/make-social-preview.py          # 需要 Pillow；改完文案/配色重跑即可
```

它做的事：读 `deepseek娘.png` → 从四边做**容差 flood fill** 抠掉浅灰背景（围裙/袜子的白不与边缘
连通，所以保得住）→ 缩放进 1280×640 的深色版式 → 左边标题/一句话定位/能力胶囊。

上传位置：GitHub 仓库 → **Settings → Social preview → Upload image**（这个只能用网页传，没有 API）。

## 如果你是权利方

开 issue 说明即可，会**立刻移除**该文件并改用占位符，不需要任何流程。

## 想换成自己的形象

直接**同名覆盖** `assets/deepseek娘.png` 即可（代码里路径是固定的）：

```bash
cp 你的图.png assets/deepseek娘.png
systemctl restart qq-bridge        # 或重启桥接进程
```

建议 ≤ 1 MB、正方形或接近正方形（模型侧会自动缩放）。

## 为什么这张图值得单独说明

它的作用不是装饰，而是**让模型知道"自己"是什么样**——没有它，模型在群里聊到形象时只能瞎编，或者把别人的二创当成自己。也正因为如此，它必须是一张**你能说清来源**的图；用官方形象做个人自用没问题，但如果哪天这个仓库被当成"官方周边"或用于商业场景，就踩线了。

> 一句话：图可以留着，归属必须写清，别让它变成"不明来源的素材"。

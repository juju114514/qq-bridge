# NOTICE —— room-pet 的代码许可与素材边界

本目录（`room-pet/`）是 `qq-bridge` 仓库的一部分，**代码**沿用仓库根的 MIT 许可
（见 [../LICENSE](../LICENSE)）。

## 一、代码（MIT）

`*.py` / `*.js` / `*.html` / `*.css` / `*.md` 这些文件是本项目写的代码与文档，
按 MIT 授权：可以商用、修改、再分发，保留版权声明即可。

## 二、素材（不在仓库里，也不在授权范围内）

以下内容**没有**进入本仓库，也不适用 MIT：

| 类别 | 例子 | 权利情况 |
| --- | --- | --- |
| Live2D 模型 / 立绘 | `assets/character/*.png`、`assets/layers/*.png`、`assets/tujingjing.psd` | 第三方绘制/建模，本项目无分发权 |
| 互动页背景与素材 | 创意工坊来源（见 `README.md` 顶部） | 原作者所有，**仅限个人使用** |
| 字体 / 语音 | 系统字体、`edge-tts` 生成的音频 | 各自许可 |
| 抖音 / QQ 的商标与界面 | 图标、截图 | 各自权利人所有 |

如果你从别处拿到这些素材：那是你和素材权利人之间的事，本项目不做授权。

## 三、账号与数据

- 仓库里**没有任何**账号、cookies、令牌、群号、抖音号
- `douyin/`（抓下来的页面数据）、`settings.json`、`dy_safety_pause.json`、`*.log` 全部 gitignore
- cookies 由 `export_cookies.py` 在**本机**导出，路径用 `QQB_COOKIES` 或默认 `state/cookies/`

## 四、使用边界（代码能做到 ≠ 允许做）

这个目录里是**操作你自己账号**的工具。用它做下面这些事，责任在你自己：

- 违反抖音/腾讯的用户协议（批量、自动化营销、刷量）
- 未告知对方就自动回复、批量私信
- 把 Live2D / 立绘素材二次分发

代码里的 `safety_words.py` 与默认关闭的 `auto_like/auto_collect/auto_comment`
就是为了**别越界**：默认不点、不收藏、不发评论。

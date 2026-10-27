# 视频理解：把视频拆成「一张故事板 + 一段转写」

> 模型**看不了视频**。DSH 的图片入口只吃静态图，所以「识别视频」在工程上的唯一解法是
> **降维**：均匀抽几帧拼成一张图（故事板），再把音轨转成文字。别指望"把视频传给模型"。

---

## 一、结论先看（能力边界）

| 能做到 | 做不到 |
| --- | --- |
| 「这个视频里发生了什么」（画面 + 谁说了什么） | 实时播放 / 流式理解 |
| 知道**第几秒**出现了什么（每格左上角烧了时间戳） | 逐帧分析（成本爆炸，没意义） |
| 只看文字：`mode=transcript`（口播、录屏、会议） | 3 分钟以上完整理解（只均匀看前 3 分钟） |
| ASR 不可用时降级成"只有画面" | 视频生成 / 剪辑 |

---

## 二、管线（四段，每段可降级）

```
QQ 视频消息（OneBot v11 的 video 段：file / url / duration）
  │
  ├─ 1) 流式下载   safeDownloadToFile（与网页抓取同一套 SSRF 闸门，边下边写盘，默认 ≤64 MB）
  │
  ├─ 2) 探元数据   ffprobe：时长 / 宽高 / 有没有音轨
  │                 ⚠️ 拿不到时长就不能抽帧——按上限取点会取出不存在的时刻（黑格）
  │
  ├─ 3) 抽帧       ffmpeg：fps = 帧数/时长 → scale=cellWidth → drawtext 烧时间戳
  │                 → tile=3×3 拼成一张 JPEG（默认 420px/格，总宽 ≤1280）
  │
  └─ 4) 转写       抽 16k 单声道音轨 → POST :5111/transcribe → 带约略时间戳的文本
```

**为什么拼图而不是散图**：9 帧散着给 = 9 张图的 token；拼成一张 3×3 ≈ **1 张图**的 token。
细节不够时才有必要上散图（本仓库暂未做）。

---

## 三、怎么开

### 3.1 必要服务

| 依赖 | 说明 |
| --- | --- |
| `ffmpeg` + `ffprobe` | 抽帧/探元数据。`socialV2.voice.ffmpegPath` 或 `FFMPEG_PATH`；ffprobe 默认在同一目录 |
| **ASR 常驻服务**（可选但强烈建议） | `python asr_server.py 5111 small` → `POST /transcribe {path}`；模型走 faster-whisper，首次会下到 `HF_HOME` |

> ASR 是**外部常驻服务**：桥接只探 `/health`、不代启动（和 OCR 一样的原则）。
> 没开也能用视频，只是没有转写，交付里会写明「没有声音转写（原因）」。

想让它跟着机器人一起起，把 ASR 加进 `launcher.deps`（启动器会按端口判断是否已在跑）：

```jsonc
{ "name": "ASR", "command": "D:\\\\QQBot\\\\tts\\\\Scripts\\\\python.exe",
  "args": "D:\\\\QQBot\\\\launcher\\\\asr_server.py 5111 small", "ports": [5111], "waitMs": 120000 }
```

### 3.2 配置

```jsonc
"socialV2": { "media": { "video": {
  "enabled": true,
  "frames": 9, "cols": 3, "cellWidth": 420,   // 9 帧 3×3，每格 420px
  "maxSeconds": 180,                          // 最长看 3 分钟，超出标 truncated
  "maxBytes": 67108864,                       // 下载上限 64 MB
  "downloadTimeoutMs": 180000,
  "asr": true, "asrUrl": "http://127.0.0.1:5111",
  "asrTimeoutMs": 120000, "transcriptMaxChars": 1200
} } }
```

`enabled: false` 时行为与改动前完全一致（视频消息只显示 `[视频]`）。

---

## 四、模型怎么用

工具：**`qq_get_message_video`**（参数 `key` / `messageId` / `mode` / `token`）

| mode | 交付 | 适合 |
| --- | --- | --- |
| `storyboard`（默认） | 1 张故事板 + 转写文本 | 「这视频讲啥」 |
| `transcript` | 只有转写（不抽帧） | 口播、录屏、会议、纯音乐没意义时 |

端点是 `GET /api/socialV2/video?key=&messageId=&mode=`（与 `/api/images/message` 共用实现：
`kind:'video'` 的条目在 `fetchMediaData` 里走「故事板 + 转写」）。

**交付里会自带说明**，模型不用猜：

```
视频 8s 抽 8 帧拼成 3×3 故事板（每格左上角是时间戳，行优先 左上→右下）
声音转写：在的在的，我这不是来了吗？
```

---

## 五、踩过的坑

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 故事板有黑格 / 只出几格 | 拿不到时长，按 180s 均匀取点 → 取到片外 | **必须先 `probeVideo`**；拿不到时长就退化成"只取第一帧" |
| 故事板糊得看不清 | 格子太宽导致整张超过 1280，被二次缩小 | `cellW = min(想要的, (maxLongEdge - 间距)/cols)`，代码里已夹 |
| 时间戳没烧上 | `drawtext` 找不到字体（Linux/无字体包） | Windows 用 `fontfile='C\:/Windows/Fonts/consola.ttf'`；Linux 装 DejaVu 后改路径 |
| 视频下载把内存吃满 | 直接用 `safeFetchBuffer`（整段进内存） | 用 `safeDownloadToFile` 流式写盘 |
| 内网/回环地址被拒 | 这是**故意的** SSRF 防护 | 别用 `http://127.0.0.1` 测；要本地测就先临时改成 file:// 读（还是走同一条 CLI 逻辑） |
| 转写为空但视频明明有人说话 | 音轨是纯音乐/静音，或 ASR 服务没起 | 看交付里的「没有声音转写（原因）」；`curl :5111/health` 确认服务 |
| 转写耗时很长 | whisper `small` 在 CPU 上约 1 秒/秒音频 | 换 `tiny` 提速；或接受"先回话、后补转写" |
| 视频消息里只有 `file` 没有 `url` | 网关实现差异 | 目前会明确报"网关没有给视频地址"，需要网关侧支持或改用文件发送 |

---

## 六、测试

```bash
node scripts/test-video-frames.mjs
```

| 断言 | 内容 |
| --- | --- |
| 布局 | 8s→8 帧、75s→9 帧、600s→截断到 180s；采样点都落在片内；无时长时不会 0 帧 |
| 宽度 | `cols×cellW + 间距 ≤ 1280`（否则二次缩小会把字糊掉） |
| **真跑** | ffmpeg 合成 6 秒测试视频 → `probeVideo` 读对时长/尺寸/有无音轨 → 故事板 JPEG ≤1MB → 音轨 wav 有内容且 cleanup 生效 |
| 接线 | bridge 认 `video` 段、走 `videoToModelParts`、ASR 不可用要写原因、有独立端点 |
| 边界 | ASR 客户端**不许 spawn 进程**（只探测）；`enabled:false` 能整体关掉 |

---

## 七、给接手的 AI

```
1. 用户说"机器人看不懂视频" → 先确认三件事：
   · config.json 的 socialV2.media.video.enabled 是不是 true
   · ffprobe 在不在（同 ffmpeg 目录）
   · :5111/health 通不通（不通就只有画面、没有转写）
2. 故事板黑格 → 90% 是 probeVideo 失败（时长 0），别去调 tile 参数
3. 想省钱 → 让模型用 mode=transcript；想看画面 → 默认 storyboard
4. 单条视频的耗时大致是：下载（看网速）+ 抽帧 0.2~1s + 转写（约 1s/秒音频）+ 拼图
5. 别把整段视频塞给模型 —— 那是不可能实现的，只有故事板 + 转写这一条路
```

## 相关

- 图片/动图/长图那套归一化：[COMPAT.md](../COMPAT.md)「四之四、喂模型前的图片归一化」
- 长图切片（视频故事板的邻居问题）：[SESSION-BUSY.md](SESSION-BUSY.md) 不相关；看 COMPAT 同节
- 语音/唱歌：[SINGING.md](SINGING.md)
- 媒体类常见故障：[TROUBLESHOOTING.md](../TROUBLESHOOTING.md) 的 H 段

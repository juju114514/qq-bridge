# 让 AI「唱歌」：四条链路、踩过的坑、现在的真实状态

> 这篇写给**想给自己的机器人加"会唱歌"的人**。结论先放前面：
> **能稳定复现的是「TTS 念歌词 + 变调」和「点歌」**；**换声翻唱（RVC）本仓库不内置**，
> 本机的 RVC 链路只跑到"训练能跑、导出失败"，**还没有一条成功的翻唱成品**。
> 别信任何"已经会唱了"的说法 —— 下面每条都标了验证到哪一步。

---

## 一、先分清四件事（混着说就会得出错误结论）

| 链路 | 干什么 | 依赖 | 本仓库内置？ | 现在状态 |
| --- | --- | --- | --- | --- |
| **A `qq_say`** | 说一句话（可带情绪） | edge-tts（`zh-CN-XiaoyiNeural`）+ ffmpeg | ✅ 工具在仓库，**语音合成脚本在仓库外**（`launcher/speak.ps1`） | ✅ 已跑通 |
| **B `qq_sing`** | **唱歌**：歌词按字/词切，逐单元变调合成再拼 | 同 A | ⚠️ 工具在仓库，**合成逻辑在仓库外**（`launcher/sing.ps1`） | ✅ 已跑通（能听出"在唱"） |
| **C `qq_song`** | 点歌：搜歌 → 下载 → 截一段 | 网易云接口 + ffmpeg | ⚠️ 同上（`launcher/song.ps1`） | ✅ 已跑通（VIP 版权会退化选翻唱） |
| **D 换声翻唱** | 用 RVC 把**别人唱的歌**换成你的音色 | RVC 环境 + 训练好的 `.pth`/`.index` + 显存 | ❌ **不内置**，属本机私有扩展 | ❌ **未跑通**（训练 OK，导出失败，无成品） |

**A/B 不是"换声"，是"变调念词"** —— 它没有音高曲线、没有换气编排，靠"多单元 + 音高预设 + 抖动"
让人听出旋律感。**C 是别人的声音**，只是截一段发给你。**只有 D 才叫翻唱。**

> 一句话：`qq_sing` 能让你笑一下，`D` 才是"唱得像"。而 `D` 的门槛不在代码，在**音色素材 + 显存**。

---

## 二、链路 B（TTS 唱）：模型运用顺序

这是仓库外 `launcher/sing.ps1` 的真实流程（124 行，逐行读出来的）：

```
歌词（-Lyric / -LyricFile / -Song 从网易云取副歌）
  ↓ 1. 按字切分：只保留中文/英文/数字，最多 40 字
  ↓ 2. 按「词单元」分组：长度在 2~4 之间循环（3,2,4,3,2,3）
  ↓ 3. 每个单元一次 edge-tts：
        --voice zh-CN-XiaoyiNeural
        --rate  = 预设 rate + jitter(0,3,-2,5,-3)   ← 抖动，避免机械等距
        --pitch = 预设 pitch[i] Hz（±120~480）
  ↓ 4. 每 3 个单元插一段 150ms 静音（气口，anullsrc 生成）
  ↓ 5. ffmpeg concat 拼接 → loudnorm=I=-16:TP=-2:LRA=11
  ↓ 6. 落 audio/gen/sing_MMddHHmmss.mp3 → POST /api/voice/send（带 verify 回读）
```

**曲风预设**（每个字的音高偏移数组 / 语速 / 音量）：

| 风格 | pitch 序列（Hz） | rate | 效果 |
| --- | --- | --- | --- |
| 儿歌 | 0,120,240,120,0,-120,0,120,240,120,0,0 | +3% | 跳跃、幼稚，最稳 |
| 流行 | 0,60,120,180,120,60,0,-60,-120,-60,0,60 | 0% | 起伏小，像念 |
| 悲伤 | 0,-60,-120,-180,-240,… | −12% | 往下掉，慢 |
| 欢快 | 120,240,360,240,… | +10% | 一路往上 |
| 说唱 | 0,0,-60,0,60,… | +15% | 贴近念白 |
| **跑调** | 300,-200,450,-150,380,… | 0% | **节目效果最好** |

```powershell
# 唱一句
powershell -File D:\QQBot\launcher\sing.ps1 -Lyric "小鲸鱼游啊游" -Style 儿歌 -Target private:123456789
# 唱某首歌的副歌（自动从网易云取歌词）
powershell -File D:\QQBot\launcher\sing.ps1 -Song "晴天" -Style 流行
```

**性能**：每个单元一次 TTS（约 0.4s），**6~12 个字最舒服**；40 字要 20 秒以上。所以工具侧把
默认值压到 ≤20 字。

---

## 三、链路 C（点歌）：模型运用顺序

```
歌名 → netmusic_resolve.py（weapi 搜索 + 取播放地址 + 下载）
  ↓ 打分：歌手匹配 +4 / 歌名匹配 +2 / 时长 90~400s +2 / 伴奏·翻唱·DJ·片段 -6
  ↓ ffmpeg -ss -t 截取 → afade in/out → 24kHz 单声道 96kbps
  ↓ audio/music/<歌名>_HHmmss.mp3 → /api/voice/send
```

**已知限制（真实踩过）**：周杰伦等热门原唱多为 VIP 版权，`/song/media/outer/url` 拿不到地址，
脚本会**退而选到翻唱版**并在日志里打印选中的是哪一首。想要 320k 原版必须登录会员
（`netmusic_login.py` weapi 手机号+验证码，cookie 存 `config\netmusic-cookie.txt`，**会过期**）。

---

## 四、链路 D（RVC 换声）：本机跑到哪一步了

> ⚠️ 这一节是**本机私有环境**的记录（`D:\QQBot\...`），不在本仓库里。写出来是为了让接手的人
> 不用重踩。**下面每条都是实测**，失败的地方明确标失败。

### 4.1 训练管线：六步，顺序不能乱

```
0. 素材池          真实人声 / 分离出的人声（demucs）
   ↓ 清洗：与目标声线质心相似度 <0.50 的片段移出（不删，进 clips_dropped 可复查）
   ↓       平均音量 RMS <0.012（接近静音）同样移出
1. preprocess      ffmpeg 切片（目标 44.1k/48k 单声道）+ 静音检测（silencedetect 找 3~10s 段）
2. f0              train.dataset.extract_f0（rmvpe）
3. hubert          train.dataset.extract_hubert_feature（v2 特征）
4. filelist        汇总训练清单
5. train           train.train -bs 1 -te 15~30 -pg assets/pretrained_v2/f0G48k.pth -pd ...
6. export + index  export 出 .pth + faiss 索引（提升相似度）
```

**模型运用顺序的关键点**：
- **rmvpe 先于 hubert**：f0 提取要先把音高轨迹算出来，hubert 只提音色特征；两者都基于 preprocess 的切片
- **预训练权重（f0G48k / f0D48k）再叠数据集**：不加载预训练直接训，3 GB 显存下 15 epoch 根本出不来东西
- **index 最后建**：它是对 hubert 特征做 faiss 索引，特征没生成完就建 = 空索引
- **推理侧顺序**：下载原曲 → 切片（**只切要唱的那段，全曲转换太慢**）→ rvc-cover.py（16k 单声道进，
  44.1k 立体声出）→ mp3 → 发送

### 4.2 小显存（GTX 1060 **3 GB**）必须的四个参数

```powershell
$env:RVC_MIN_GPU_GB = '3.3'                      # 低于这个值 RVC 会拒绝启动
$env:PYTORCH_CUDA_ALLOC_CONF = 'max_split_size_mb:64'   # 防碎片化 OOM
train.train ... -bs 1 -g 0                       # batch 必须 1
-te 15 ~ 30                                      # 再多收益很小，时间翻倍
```

### 4.3 当前状态（诚实版）

| 步骤 | 结果 |
| --- | --- |
| 环境（torch 2.5.1+cu121、rvc-python、rmvpe/hubert 权重） | ✅ 装好了 |
| preprocess / f0 / hubert | ✅ `exit=0`（fatfish3 / fatfish4 / fatfish5 都跑通） |
| **train** | ⚠️ fatfish3 `exit=0`；fatfish4/5 起了但日志停在"开始训练"；pipeline2 那次 `exit=-1`（被强杀） |
| **export（出 .pth）** | ❌ **`exit=1`**，日志里有 Traceback；`rvc-models\fatfish4_e10.pth` 存在但来源不确定（可能是中途手动导的） |
| index | ✅ `exit=0`（`added_IVF465_Flat_nprobe_1_fatfish3_v2.index` 1.4 MB） |
| **推理（真发一条翻唱）** | ❌ **没有**。`audio/music/` 里 6 个文件全是 10-24 的点歌截取，**没有 `_rvc_` 产物** |
| `config\rvc.json` | ⚠️ 还是模板：`"modelPath": "D:\\QQBot\\rvc-models\\在此填你的模型.pth"` |

**所以"换声翻唱"这条链路的真实进度是：训练前四步 100%、训练本身不稳定、导出失败、推理没接。**
谁接手，第一件事就是修 export（大概率是 **权重路径/`assets/pretrained_v2` 缺失** 或 **faiss 版本**）。

---

## 五、踩坑总表（现象 → 原因 → 解决）

### 5.1 音频/ffmpeg

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 语音时长全是 0 / 列表不显示时长 | `probeAudio()` 用了 `ffprobe -o <file>`，**`-o` 是 FFmpeg 6 才有的**，4.x 直接报错 | 去掉 `-o`，改 `fs.openSync` 拿句柄当 `stdio[1]`（仓库已在 `src/voice-core.js` 修掉，见 TROUBLESHOOTING **J3**） |
| 拼出来的歌像"一字一顿" | 逐字 TTS，字与字之间没有连读 | **按 2~4 字成组**再合成；组间只留 150ms 气口；rate 加 `±5%` 抖动 |
| 整体音量忽大忽小 | 每段 TTS 自带响度不同 | 最后统一 `loudnorm=I=-16:TP=-2:LRA=11` |
| 拼完中间有杂音/爆音 | concat 的 list 文件里路径用了反斜杠/中文 | list 用 **ASCII** 写，路径斜杠统一 `/`，`-safe 0` |
| 长图式"整段移调"后声音发薄发尖 | 变调是**等比缩放**，共振峰不跟随（见 §6） | 少移调；>4 半音就换歌/换源，别硬上 |

### 5.2 PowerShell / 编码

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 中文歌词传进去变乱码 | PS 5.1 的 `-File` 参数按 ANSI 传 | **歌词走文件**（`-LyricFile x.txt`，UTF-8），别走命令行参数 |
| `Invoke-WebRequest` 发出去的中文被截断 | 默认按 ASCII 编码 body | `[Text.Encoding]::UTF8.GetBytes($json)` 显式转字节（仓库里所有 POST 都这么写） |
| 响应中文乱码 | PS 5.1 默认按 ISO-8859-1 解码 | 显式 `[Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())` |
| `.ps1` 解析报"意外的标记" | 文件存成了无 BOM 的 UTF-8，PS 5.1 按 GBK 读 | **所有 `.ps1` 存 UTF-8 带 BOM** |

### 5.3 网络/依赖

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `pip install torch` 卡住/超时 | 走默认源 | 下 wheel 到本地再 `pip install --no-deps`（`download-torch-cuda.ps1` 就是这么干的） |
| HuggingFace 下载 rmvpe/hubert 失败 | 直连不通 | `HF_ENDPOINT=https://hf-mirror.com` + `HF_HOME` 指到 D 盘（`rvc-cover.py` 开头已设） |
| 网易云登录 `401 ENC` | 老接口 `/api/login/cellphone` 已被加密 | 改 **weapi**：`netmusic_login.py --phone --code`（先发短信验证码） |
| 取到的是翻唱不是原唱 | VIP 版权，`outer/url` 无地址 | 登录会员；或接受翻唱（日志会打印选中哪首） |

### 5.4 RVC / 训练

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `CUDA out of memory`（3 GB 卡） | batch>1、或没设分配策略 | `-bs 1` + `PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:64` + `RVC_MIN_GPU_GB=3.3` |
| 训练完**导出失败 `exit=1`** | 本机就卡在这（Traceback 未细查） | 优先查：`assets/pretrained_v2/` 是否齐、`logs/<exp>/` 里权重名是否与 export 脚本预期一致、faiss 版本 |
| 转出来的声音"不像本人 / 像卡通" | 素材里混进了别人的声音（B 站二创、多人对话） | 训练前用**相似度清洗**：与目标质心 <0.50 的移出；再抽查转写内容是不是同一角色 |
| 数据太少过拟合 | 只有 2~3 分钟素材 | `atempo 0.95 / 1.05` 轻度增广（**不改音高音色**）凑到 5~7 分钟，比硬训有效 |
| 高音区"卡嗓子" | 模型训练语料是**说话**，音高分布只有 10 个半音 | 见 §6 |

---

## 六、外部大纲 v9 里值得借的结论（**未在本机实现**，标注来源）

2026-10-27 有人给了份 `大肥鱼-演唱总大纲-v9.md`（567 行）。**核实结论：它引用的仓库文件
（`src/sing-studio.js`、`src/sing-pipeline.js`、`soulx/feiyu_svs_server.py`、`:5112` 服务、
`D:\DSH\GZQ\...`）在本机**一个都不存在 —— 是**另一台机器/另一分支**的状态，不能当既有能力照抄。
但其中的**测量方法与工程结论是真东西**，值得记下来：

### 6.1 「音域」要拆成三层（这条最有用）

| 名字 | 是什么 | 谁能改 |
| --- | --- | --- |
| 输入音域 | 源唱的人能唱多高 | 选曲 |
| **模型可用音域** | 目标音色在哪个音高区间**音色不变形** | **只能训练** |
| 听感音域 | 听众觉得"唱得开不开" | 训练 + 后期 |

混着说就会以为"把 pitch 调小点"能解决问题 —— 调参数只动第一层和第三层，**动不了第二层**。

### 6.2 六个可测指标（拿它验收 RVC，比"我感觉像不像"靠谱）

| 指标 | 怎么测 | 健康值 |
| --- | --- | --- |
| 中位 F0 | 逐帧 F0 的中位数 | 与源差 ≤1 个半音 |
| 音准偏差 | 输出 vs 期望每帧半音差 | 中位 ≤0.2 半音 |
| **共振峰 F1 跟随比** | 输出 F1 / 源 F1，随音高是否变化 | **0.5~0.8**（真人）；恒定 1.6+ = 完全不跟随 |
| 频谱平坦度 | `spectral_flatness` | ≤ 源 ×2（暴涨 = 气声/噪声多） |
| >6 kHz 能量占比 | STFT 分带 | ≤1%（暴涨 = 尖薄刺） |
| 颤音深度 | 长音 F0 去趋势后的标准差 | ≥ 源 ×0.8 |

那份大纲实测基线（未训练，pitch 0）：F1 比 **1.71**、平坦度 **×5.8**、>6k **×42**、颤音 **−45%** ——
结论是 **"不升调、原样进 RVC 音色就已经塌了"**，问题在换嗓模型，不在变调。

### 6.3 正解是「RVC 换音色 + SVS 造音高」

```
有谱：SVS 按谱唱（音高由谱决定，天然覆盖宽音域）→ RVC 只在原音高做音色转换（0 移调）
无谱：录原唱 → 移调 → RVC（就是现在的做法，受"模型可用音域"限制）
```

本机没有 SVS（`:5112` 不在听），所以**现在只有无谱那条路**，音域受限是必然的。

### 6.4 两条能直接用的公式

```text
自动定变调：pitch = clamp(round(12 * log2(330 / medianF0)), -6, 12)     # 目标 ~330Hz
难度系数：  0.50 + (0.35·音域跨度 + 0.25·转音 + 0.20·咬字 + 0.20·情绪 − 1.0) × 0.20，硬夹 [0.50, 1.50]
```

第一条比人工填 ±12 稳；第二条只适合"给演唱打分"，别塞进聊天流程。

### 6.5 它标记的一个真 bug（我们将来一定会撞）

> `mixMaster` 只给人声移调、伴奏没移 → 走完整管线必然**调性错位**。
> 修法：伴奏用同一 `pitch` 同步移调，或**先对整首移调再分离**。

### 6.6 不采纳的部分

- **酷狗 WASAPI 内录**：版权与 ToS 都在灰区，写进公开指南等于替使用者担责。想用请自行评估，本仓库不提供。
- 庞大的评分体系（4 角色评审团 / 10 档难度 / 老虎机学习）：和"给自己机器人加唱歌"不是一个量级，
  最多当"怎么判断唱得好不好"的参考。

---

## 七、演示（都是本机真跑过的命令）

```powershell
# A. 说话（7 种情绪，音色 zh-CN-XiaoyiNeural，整体抬音高做"童声基线"）
powershell -File D:\QQBot\launcher\speak.ps1 -Text "晚安啦" -Mood 温柔 -Target private:123456789

# B. 唱歌（TTS 变调，6 种曲风；跑调最有节目效果）
powershell -File D:\QQBot\launcher\sing.ps1 -Lyric "小鲸鱼游啊游" -Style 跑调 -Target private:123456789
#    产出：audio\gen\sing_1027093252.mp3（22.4 KB，约 3 秒）

# C. 点歌（截 45 秒）
powershell -File D:\QQBot\launcher\song.ps1 -Name "孤勇者" -Seconds 45 -Target private:123456789
#    产出：audio\music\孤勇者_222038.mp3（274 KB）

# D. 换声翻唱（本机环境存在，但当前会失败在导出/没有模型）
powershell -File D:\QQBot\launcher\rvc-sing.ps1 -Name "晴天" -Seconds 60 -NoSend
#    期待：audio\music\晴天_rvc_HHmmss.mp3 ；实际：先要修 config\rvc.json 的 modelPath
```

**耗时参考**（本机 GTX 1060 3 GB）：TTS 唱一句（10 字）约 6~8 秒；点歌端到端 10~20 秒；
RVC 转换 45 秒歌约 50 秒；人声分离（demucs）45 秒歌约 **172 秒** —— 大头在分离。

---

## 八、想给"自己的机器人"加唱歌：最小可行路径

| 阶段 | 做什么 | 成本 |
| --- | --- | --- |
| 0 | 先把 `qq_say` / `qq_sing` 跑通（edge-tts + ffmpeg，**不需要 GPU**） | 半小时 |
| 1 | 加"点歌"（网易云 + ffmpeg 截取），把版权限制说清楚 | 1 小时 |
| 2 | 如果想"唱得像"：攒 **5~10 分钟干净人声**（同一人、无伴奏、无背景音） | 数天（最难的是素材） |
| 3 | 训 RVC（§4.1 六步），**先把 export 跑通再谈效果** | 一晚 |
| 4 | 接推理：切片 → 换声 → mp3 → `/api/voice/send` | 1 小时 |
| 5 | 想让音域更宽：要么换 **SVS**（有谱），要么接受"只能唱中音区" | 以周计 |

> **最容易低估的**：不是代码，是**素材**。RVC 换出来的像不像，80% 由训练数据决定；
> 3 分钟杂素材训出来的模型，不如 8 分钟干净素材训的一半 epoch。

---

## 九、给接手的 AI：最短判断路径

```
1. 用户说"机器人不会唱歌" → 先看是哪种：
   · 要它"说" → qq_say / speak.ps1（不需要 GPU，最快能修好）
   · 要它"唱一句" → qq_sing / sing.ps1（同上，检查 ffmpeg 路径与 edge-tts 装没装）
   · 要它"翻唱某首歌" → RVC 链路，先确认三件事：
       config\rvc.json 的 modelPath 是不是真文件、D:\QQBot\rvc\Scripts\python.exe 在不在、
       audio\music\ 里有没有 *_rvc_*.mp3（没有就是从来没成功过）
2. 不要从"调 pitch"开始 —— 先量：F0 准不准、F1 跟不跟随、>6k 能量多少（§6.2）
3. 修 RVC 的顺序：export 能不能出 .pth → index 有没有 → 推理能不能出 wav → 才谈"像不像"
```

---

## 相关文档

- 语音/点歌的完整环境说明（音色表、语音库、ffprobe 补丁）：本机 `launcher\TTS-音色说明.md`
- 语音工具在仓库里的边界：[COMPAT.md](../../COMPAT.md)「平台能力表」（非 Windows 不支持语音）
- 语音发送链路上的坑：[TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) 的 **H2 / H6 / J3**
- 消息出口必须过护栏（含语音）：[RULES.md](../../RULES.md) 设计不变量 **L8**

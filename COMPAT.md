# COMPAT.md · 兼容与适配手册（给 AI 与人）

> **你（AI）在别的机器上接手这个仓库时读这份。**
> 目标：让"换一台电脑 / 换一个 DSH 版本 / 换一个 OneBot 实现"能**按步骤适配**，
> 而不是靠猜着改代码。
>
> 机器可读版：[`compat.json`](compat.json)（矩阵 + 契约清单，脚本会拿它比对）。
> 人类快速上手：[README.md](README.md)；AI 入口：[AGENTS.md](AGENTS.md)。

## 一、先跑这三条，5 秒定位"环境对不对"

```bash
node --version                 # 必须 >= 22.13（内置 WebSocket 从 22 起）
node scripts/test-audit.mjs    # 43 套回归；全绿说明「代码自身」没问题
node scripts/test-portability.mjs  # 6 项：换机器会不会废
```

- 第 1 条过、第 2 条绿 → 代码没问题，去查**环境/配置**（第二节）。
- 第 2 条红 → 是代码被你改坏了，按报错修，别去动环境。

## 二、环境矩阵（不一致时的处置）

| 依赖 | 要求 | 实测过 | 不一致时的处置 |
| --- | --- | --- | --- |
| Node | `>= 22.13.0` | 24.21.0 | 低于 22 直接不跑（`globalThis.WebSocket` 不存在）；建议 22 LTS 或 24 |
| DeepSeek Harness（DSH） | `>= 0.2.0` | 0.2.1-rc.2 | 0.2.0 起 inbox 投影路径变过；0.2.1 起 system prompt 只注册 `provider`/`model` 两个变量，写 `{{cwd}}` 会 fail loud |
| SnowLuma | `>= 1.14.0` | 2.1.1 | 1.14.17 起才有 `bot_status`（账号上下线）；HTTP(3000) 与 WS(3001) 是**两个不同 token** |
| OneBot 实现 | 任意 v11 兼容 | SnowLuma / NapCat / Lagrange | 见第三节「硬契约」；动作缺失会在启动或首次调用时明确报错 |

**本项目不再依赖**：`@snowluma/sdk`、`@snowluma/mcp`（已移除）。OneBot 客户端是自带的
`src/onebot-ws.js`，只用 Node 内置 `WebSocket`。所以：

- 不需要 `postinstall` 补丁，也**不会修改任何第三方包**；
- 你想换成 `ws` 包也行，改 `src/onebot-ws.js` 的 `WebSocketCtor` 注入即可。

## 三、硬契约（只改这些是不允许的）

> 判断标准：**只要换掉它、外面的行为就变了**，那就是契约。

### 3.1 传输层

```
WS  : ws://<host>:3001/?access_token=<token>        ← 鉴权走 query，不是 header
HTTP: http://<host>:3000/<action>  Authorization: Bearer <token>

动作上行：{ action, params, echo }
响应下行：{ status: 'ok'|'failed', retcode: 0, data, echo }   ← 靠 echo 配对
事件下行：带 post_type 的帧
```

### 3.2 需要支持的动作（26 个，缺哪个就哪个功能坏）

| 分类 | 动作 |
| --- | --- |
| 基础 | `get_login_info` `get_status` `get_version_info` `get_msg` `get_image` `fetch_face_entity` |
| 发送 | `send_private_msg` `send_group_msg` `send_msg` `send_private_forward_msg` `send_group_forward_msg` |
| 群/成员 | `get_group_member_list` `get_group_member_info` |
| 互动 | `send_like` `group_poke` `send_poke` |
| 表情 | `fetch_custom_face_detail` `add_custom_face` `modify_custom_face` |
| 转发/消息 | `get_forward_msg` |
| QQ 空间 | `get_qzone_feeds` `get_qzone_msg_list` `send_qzone_msg` `like_qzone` `unlike_qzone` `comment_qzone` |

### 3.3 需要消费的事件

| post_type | 必需字段 | 用途 |
| --- | --- | --- |
| `message` / `message_sent` | `message_type`(private/group)、`user_id`、`group_id`、`raw_message`、`message`、`sender`、`self_id` | 聊天主链路；`message_sent` 是自己发的回显，也要按 message 处理 |
| `notice` + `notify` | `sub_type`（拍一拍等） | 拍一拍提醒 |
| `notice` + `bot_status` | `sub_type`(online/offline)、`user_id`（**必须是 number**） | 账号上下线判活 |
| `meta_event` + `heartbeat` | `interval` | 心跳判活（不参与业务） |
| `request` | `request_type`、`flag` | 只旁路统计，**不自动同意** |

### 3.4 角色卡契约（换机器/搬迁时最容易坏的一块）

```
roles/<任意文件名>.md
  ---
  id: xiaojingyu        ← 身份（ASCII 小写，唯一）；state 只存它
  name: 小鲸鱼（已测试）    ← 显示名，自由文本
  ---
  正文…
```

| 规则 | 原因 |
| --- | --- |
| `id` 必须 ASCII 小写、唯一 | 要能安全当状态键与文件名；中文名做 id 会在不同平台/编码下出岔子 |
| 改 `name` **不影响** `state/current-role.json` / `roles-by-key.json` | 绑定存的是 id，不是名字 |
| 改文件名**不影响**任何绑定 | id 在文件里；桥接靠索引找 `entry.file`，不靠拼路径 |
| 老卡（无 front matter）用文件名哈希当 id | 保证同一份文件在任何机器上得到同一个 id |
| 元数据不得出现在注入文本里 | `selectRoleText` / `parseRoleSections` 统一剥 front matter |

迁移工具：`node scripts/migrate-roles-to-ids.mjs`（`--dry-run` 默认；`--apply` 真写）。
回归：`scripts/test-role-id.mjs`（9 项，含「改文件名 id 不变」）。

### 3.4b 模型 provider（DeepSeek 已测 / 其他未测）

桥接**不直连厂商**：它把 `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` 原样交给 DSH，
再从 `session.modelCatalog` 读档位。所以"换模型"主要是 **DSH 侧**的事，桥接无需改代码。

| provider | 状态 | 说明 |
| --- | --- | --- |
| `deepseek-official` | ✅ 已测试 | 43 套离线回归 + 54 项全功能自测都在这个组合下跑过 |
| `openai` 及其他兼容 provider | ⚠️ **已接入，未测试** | 代码路径透传；计价按 `deepseek-flash` 兜底估算（标 `estimated`）；思考强度词表/工具调用/多模态/人格协议均未验证 |

细节、接入步骤与验证清单见 [docs/guides/MODELS.md](docs/guides/MODELS.md)。
探针：`node scripts/probe-dsh-providers.mjs`（打印 DSH 现有 provider 分组与模型接入相关 settings 路径）。

> 启动时若 `dsh.provider` 不是 `deepseek-official`，桥接会在日志里打三条如实提示
> （计价估算 / 档位词表 / 工具与人格未验证），这是刻意设计的"不夸大支持范围"。

### 3.5 启动方式（Windows 一键 / Linux systemd）

| 平台 | 入口 | 说明 |
| --- | --- | --- |
| Windows | `.\start-bridge.ps1` | 起守护 → 起桥接；崩溃自动拉起、单实例、退避重启。启动器**不代启 SnowLuma**（只探测 `:3000/:3001`）。契约见 [docs/guides/LAUNCHER.md](docs/guides/LAUNCHER.md) |
| Linux | `deploy/first-run.sh`（首次准备）→ `deploy/install-server.sh` + systemd | `systemctl start qq-bridge`；unit 见 `deploy/qq-bridge.service` |

不要绕过入口直接长跑 `node src\bridge.js`：那样没有单实例保护、崩了没人拉起。
退出码契约（0/1/2/3/4/5）在 LAUNCHER.md，改启动逻辑必须同步更新那张表。

### 3.6 配置键（换 DSH/换机器要重配的）

`compat.json` 的 `contracts.configKeys` 有完整清单。最常需要改的四个：

```jsonc
{
  "dsh": { "baseUrl": "http://127.0.0.1:<实际端口>" },   // DSH 端口每次重启可能变
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "<token>" },
  "paths": { "tools": "<放外部脚本的目录>" },              // 语音/点歌脚本；为空则用 <项目>/tools
  "allow": { "groups": [], "private": [<你的QQ>] }        // 白名单；空 = 只放行 ownerQQ
}
```

## 四、适配步骤（照着做，别自由发挥）

```
1. 跑第一节的三条命令，确认「代码自身是好的」
2. 对照 compat.json：
     · Node / DSH / SnowLuma 在主版本区间内？不在 → 看第二节处置
     · OneBot 实现是否支持 3.2 的动作？缺 → 只改「适配层」，不要改业务
3. 只允许改这些地方（适配层）：
     · src/onebot-ws.js        ← 换传输实现（WebSocket → ws 包、HTTP 轮询等）
     · src/dsh-client.js       ← 换 DSH 版本的 API 差异
     · config.json             ← 端口/路径/白名单
   不允许改：路由语义、发送额度与回滚、唤醒状态机、协议细节（echo/事件分发）
4. 改完必须跑：node scripts/test-audit.mjs（39）→ 必须全绿
5. 再跑 node scripts/test-onebot-ws.mjs（18）→ 覆盖 echo 配对/事件分发/重连
6. 最后人工抽测：发一条、收一条、表情、拍一拍（见 MIGRATION.md 第五节）
```

## 四之二、自检套件：哪一套在保护什么

改代码前后跑 `node scripts/test-audit.mjs`（43 套）。它不只跑功能，还跑"只有特定条件下才炸"
的回归。单独跑某一套也可以：

| 套件 | 保护什么 | 什么时候必须单独跑 |
| --- | --- | --- |
| `test-audit.mjs` | 全量入口（43 套） | 任何改动之后 |
| `test-onebot-ws.mjs` | echo 配对、事件分发、超时、断线重连（手写协议层） | 动 `src/onebot-ws.js` |
| `test-http-layer.mjs` | 硬化头、请求体限额、**前导关每条拒绝**、路由表顺序 | 动 `src/http/*` |
| `test-role-id.mjs` | front matter、**改文件名 id 不变**、注入不含元数据 | 动角色卡/`role-card.js` |
| `test-launcher-scripts.mjs` | L6（不代启 SnowLuma）、退出码齐全、`.ps1` BOM | 动启动器/守护 |
| `test-portability.mjs` | 硬编码盘符、示例配置本机值、平台闸门 | 加任何新路径/新可执行 |
| `test-compat.mjs` | `compat.json` 动作清单 ↔ 代码、平台能力 ↔ 闸门 | 加接口/加动作/改平台行为 |
| `test-packaging.mjs` | 单一锁文件、LICENSE 纯净、**归属完整性**（角色卡/素材） | 加依赖/加素材 |
| `test-first-run.mjs` | `first-run.ps1` 的契约：不覆盖 config、不代启 SnowLuma、DryRun 行为 | 动首次引导脚本 |
| `test-long-image.mjs` | 长图切片（长宽比≥2.4 → 每片短边 1000、有重叠、片数≤6） | 改图片归一化时 |
| `diag-session-busy.mjs` | 会话繁忙诊断（忙着的原因/时长/租约/暂存数） | 用户报「AI 不回」且日志有「会话繁忙」时 |
| `preflight.mjs` | 全新环境体检（Node/依赖/config/端口/DSH/SnowLuma/人格卡） | **首次安装、换机器**：`node scripts/preflight.mjs`（装依赖前就能跑） |
| `test-console.mjs` | 控制台真机冒烟（打 `127.0.0.1:3100`） | **不在审计里**，手动：`node scripts/test-console.mjs` |
| `probe-dsh-providers.mjs` | 打印 DSH 的 provider 分组与模型接入 settings 路径（接新模型前先跑） | 换 provider / 换 DSH 版本 |
| `live-full-test.ps1` | **全功能自测（54 项，会真发消息）**：只读接口 + 守卫 + 人格 CRUD + 真实 QQ 动作 + 媒体 | 改完功能、上线前手工跑：`powershell -File scripts\live-full-test.ps1`（`-MaxSends` 控发送量） |

## 四之三、抓网页的安全契约（`web_fetch` / `src/safe-fetch.js`）

只要模型能抓网址，就必须有这五道闸。缺任何一道都是 SSRF/资源类漏洞：

| # | 闸门 | 实现位置 | 说明 |
| --- | --- | --- | --- |
| 1 | **只允许 http/https** | `validateFetchUrl` | 拒绝 `file:` / `gopher:` 等；同时拒绝 URL 里带凭据（`user:pass@`） |
| 2 | **解析后校验 IP，禁止内网** | `resolveSafeAddresses` + `isPrivateIp` | 域名先 DNS 解析（`all:true`），**任一**解析结果落在私网就整条拒绝 |
| 3 | **每跳重定向重新校验** | `safeFetch` 循环 | 最多 5 跳；每跳对新 URL 重新解析+校验；重定向正文**不下载**（否则可被用来耗尽连接） |
| 4 | **限体积 + 限超时** | `maxChars`/`maxBytes` + 总 deadline | 文本超限**截断并标 `truncated`**；图片超限**硬失败**；总预算 20s、单地址尝试 8s |
| 5 | **非文本不解析** | `isNonTextContentType` | `image/*`、`audio/*`、`video/*`、`font/*`、`application/pdf|zip|gzip|octet-stream|…` 一律在读正文**之前**拒掉 |

补充两条容易被忽略的：

- **DNS rebinding 的根治办法是"把校验过的 IP 钉死"**：解析出地址后直接连
  `hostname: <已校验 IP>`，但保留原始 `Host` 与 TLS `servername`（SNI）—— 这样连接阶段
  **不会再解析一次**，重绑定就无从下手。换地址重试时同样不重新解析。
- **保守放行未知类型**：没写 Content-Type 或 `application/x-unknown` 仍然放行，
  因为站点漏写很常见，误拒会让 `web_fetch` 大面积失败。

> ⚠️ 已知限制（写出来是为了不被当成"已解决"）：**字符集只按 UTF-8 解码**。
> GBK/Big5 页面会出乱码（历史上一直如此），当前不做编码嗅探。

## 四之四、喂模型前的图片归一化（`src/media-normalize.js`）

模型不是"看到原图"：所有进模型的图都要先过这一层。三件事，顺序不能反：

| 情况 | 处理 | 为什么 |
| --- | --- | --- |
| **动图**（GIF/动态表情） | 抽帧拼成 `cols×rows` 网格，说明写「N 帧/…s，行优先 左上→右下」 | DSH 对 `image/gif` 只解第一帧，模型永远看不到动作 |
| **长图**（长宽比 ≥ `sliceAspectMin`=2.4，短边 ≥480） | **沿长边切片**：每片短边 `sliceShort`=1000、片长 ≈1.35×短边、相邻重叠 6%（≤60px），片数 ≤ `maxSlices`=6，每片带「第 i/n 片（原文 x-y px）」 | 整体等比缩会把 1080×6000 压成 230×1280，**字全糊**；切片后每片照样能读 |
| **普通大图** | 长边缩到 `maxLongEdge`=1280 + 重编码（最多三轮降质） | 手机直出 4000×3000 缩完 150–250KB，够描述 |

> 长图如果切不开（没 ffmpeg / 超时），会**退回整体缩**并在说明里写清"只能给概览，细节可能看不清"——
> 绝不静默给出糊图让模型瞎猜。

**长图还有第三条路：OCR（`src/ocr.js` + `scripts/ocr-image.ps1`，Windows 自带 `Windows.Media.Ocr`）。**

| 什么时候 | 走哪条 | 成本 |
| --- | --- | --- |
| `mode=auto`（默认）+ 长宽比 ≥2.4 | **先 OCR**，拿到 ≥20 字就用文字，拿不到再切片 | OCR ≈ 几百 token；切片 5 片 ≈ 1.5 万 token |
| `mode=text` | 一律 OCR；不可用/没字则退回给图 | 同上 |
| `mode=image` | 不 OCR，直接给图（长图切片） | 看图的成本 |

三条工程约束（别在"优化"时弄丢）：

1. **进程间只走文件**：`powershell` 的 stdio 全 ignore，结果写临时 JSON 再读 —— 受限沙箱下
   `spawn` + `stdio:'pipe'` 会 EPERM（与 `voice-core.js` / `media-normalize.js` 同一条教训）。
2. **必须抹掉汉字间的空格**：Windows OCR 会把 `这是第 1 行` 识别成 `这 是 第 1 行`；不归一化
   等于把省下来的 token 又吐回去。规则是"只删全角标点/汉字的邻接空格"，`krystal: 这是`
   这种半角冒号后的空格要保留。
3. **失败必须降级**：非 Windows / 没装语言包 / 超时 → `{ok:false, reason}`，调用方退回切片，
   绝不让 OCR 抛异常打断整条消息。

### 四之五、视频：只能「故事板 + 转写」，没有第二条路

DSH 的图片入口只吃静态图，所以视频必须是**降维**而不是"传进去"：

| 步骤 | 实现 | 关键约束 |
| --- | --- | --- |
| 下载 | `safeDownloadToFile`（同一个 `safe-fetch` 模块，同样的 SSRF 闸门） | **流式写盘**，不能整段进内存；默认上限 64 MB |
| 探元数据 | `probeVideo`（ffprobe） | **拿不到时长就不能抽帧**（按上限取点会取到片外 → 黑格） |
| 抽帧 | `normalizeVideoForModel`（ffmpeg `fps`→`scale`→`drawtext`→`tile`） | `cols × cellW + 间距 ≤ maxLongEdge`，否则整张二次缩小把字糊掉 |
| 转写 | `extractVideoAudio` → `POST :5111/transcribe` | ASR **只探测不代启动**；不可用必须降级成"只有画面"并写明原因 |

交付形态：`qq_get_message_video` 的 `mode=storyboard`（1 张拼图 + 转写）/ `mode=transcript`（只要文字）。

**链接这条路（B站/抖音）**多两道闸：① 站点**白名单**（`src/video-link.js`，非白名单一律拒——
否则"看视频"就成了任意 URL 下载器）；② **只下前 N 秒**（`--download-sections`，实测 84MB/8s → 1.5MB/3s）。
`qq_open_video` 走 `POST /api/socialV2/video-link`，与消息附件那条路共用同一套故事板+转写。

**抖音例外**：yt-dlp 的 Douyin extractor 要 a_bogus 签名（无签名 403，登录也无效），
所以抖音先走 `src/douyin-resolve.js` 的分享页解析（cookies.txt + iPhone UA → `play_addr` → playwm 去水印），
失败才回退 yt-dlp。cookie 只挑 `douyin.com` 域，且只存在于 `state/cookies/`（gitignore）。

cookie 还有**主动体检**：`GET /api/socialV2/video-cookies` →
`ok` / `cookie-aging` / `cookie-expired` / `cookie-missing`，并给出 `remaining`（人话剩余时间）。
过期不会表现成「视频不存在」，而是明确的「重导一次」。
`socialV2.media.video.enabled=false` 时行为与改动前完全一致（视频只显示 `[视频]`）。

### 四之六、安装期的内联脚本（`npm run postinstall` 这类）

`package.json` 里凡是用 `node -e "…"` 写的内联脚本，都属于**安装期代码**：它坏了，
`npm install` 会在 postinstall 阶段直接失败，用户看到的是 `ELIFECYCLE` —— 而 `node --check package.json`
查不出来（JSON 本身合法）。

所以契约是三条，缺一不可（`scripts/test-packaging.mjs` 每次真跑一遍）：

1. **引号配对**（内层脚本里单引号数量必须是偶数）
2. **不含私用区字符**（`U+E000–U+F8FF` 是 UTF-8 被当 GBK 读过的典型痕迹）
3. **真执行退出码为 0**，且 postinstall 的输出要带 `[qq-bridge]` 前缀（用户在 npm 日志里能认出来）

## 五、失败特征表（症状 → 根因）

| 症状 | 最可能根因 | 怎么确认 / 怎么修 |
| --- | --- | --- |
| 启动即退，日志 `globalThis.WebSocket is not defined` | Node < 22 | 升到 22.13+ |
| `/api/status` 的 `dshReady=false`，日志「连不上 DSH」 | `dsh.baseUrl` 端口变了 | 看日志里打印的 URL 与错误；改成实际端口 |
| DSH 401 / 「铸造 cookie 失败」 | 读不到 `$DSH_HOME/.credentials.yaml` | Linux 降权用户要按 SERVER.md 给 ACL；或填 `dsh.authToken` |
| `snowluma.connected=false` 但 curl 3000 通 | WS token 与 HTTP token 不是同一个 | 让桥接自愈（首次 1006 后会自动刷新）；或手动更新 `snowluma.accessToken` |
| 收不到消息但连接正常 | 上游只接了 HTTP，没订阅事件 / 白名单过滤 | 看 `onEvent` 旁路统计（日志会打 `lastPacketKind`） |
| 首次引导给的默认人设是「傲娇助手」 | 角色卡名带后缀导致精确匹配失败（已修） | 确认 `role.defaultName` 是稳定名、且 `resolveRoleName` 生效 |
| `say`/`sing`/`song` 报「依赖 Windows PowerShell」 | 非 Windows 平台 | 设 `QQBOT_SAY_SCRIPT` 等指向平台脚本；或用自带 TTS |
| 换机器后反复「会话不存在」 | `state/sessions.json` 带着旧 sessionId | 清空 `state/sessions.json`（见 MIGRATION.md） |
| 备份解不开 | DPAPI 绑定用户+机器 | 跨机改用 7-Zip 密码归档（MIGRATION.md） |

## 六、你（AI）不该做的事

1. **不要为了让某台机器跑起来去改业务语义**（额度、唤醒、白名单、脱敏）。这些是多机一致的护栏，改一处就会在别的机器上行为不同。
2. **不要重新引入 `@snowluma/*` 依赖** —— 移除它们是为了让「不依赖、不修改、不分发」成立（见 [`docs/design/decisions/0002`](docs/design/decisions/0002-drop-snowluma-npm-deps.md)）。测试 `test-compat.mjs` 会拦。
3. **不要把机器相关的值写进代码或示例配置**：`test-portability.mjs` 会拦盘符、本机端口、真实 QQ 号。
4. **不要在 `LICENSE` 里追加说明**：GitHub 会因此判成 `NOASSERTION`（说明放 `NOTICE.md`）。
5. **不要跳过审计**：43 套里有一半是"只在特定条件下才炸"的回归（额度回滚、租约、BOM、
   归属完整性、启动器契约、HTTP 前导关）。

## 七、把这份手册变得更准

`compat.json` 的 `contracts` 是**契约的唯一来源**。你发现某台机器需要额外契约（比如某实现要求 `send_msg` 带 `message_type`），做法是：

1. 先改 `compat.json`（加动作/字段/环境差异）
2. 再改代码适配
3. 跑 `node scripts/test-compat.mjs` —— 它会检查「文档里写的动作，代码里真的用到了；代码里用到的动作，文档里也写了」

这样下一个人接手时，看到的永远是**当下真实**的契约。

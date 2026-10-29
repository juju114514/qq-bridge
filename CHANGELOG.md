# 更新日志

只记**用户能感知的变化**与**踩过的坑**。按日期倒序。

## 2026-10-30 — 0.3.0：拆到 10.7k 行 + 三件新功能 + 十个测试护栏

> 升级方式见 [docs/UPGRADE.md](docs/UPGRADE.md)。这一版**没有破坏性变更**，
> 但新增了几个配置项与一次自动生成的 `state/people.json`，升级后建议跑一次 `/自检`。

### 新功能（用户能感知）

- **`/自检`（管理员）**：一条指令看清 网关 / DSH / 队列 / 会话表 / 数据量 / 最近错误 /
  **网关重连次数** / **抖音 cookies 剩余**。命令由桥接直接执行、不经过模型，零 token。
- **抖音轻量档**：`qq_open_video(mode="meta")` 与"消息里出现抖音链接自动附元数据"——
  只取 作者/标题/文案/封面，**不下载视频**（下载才是风控高危动作），同会话 10 秒冷却。
  可用 `socialV2.media.video.links.autoMeta=false` 关掉自动附加。
- **静默时段**：`socialV2.quietHours = [23, 8]`，夜里不主动搭话；消息照常记录，
  `admin` / `bootstrap` 不受限。默认关闭。
- **人物库**（`src/people.js`）：身份只认 QQ 号（改群名片不再断成两个人），
  关系升档要求"消息数 + 活跃天数"同时达标（一天刷 500 条也不算熟人）。
  首次启动会按白名单群存量成员标 `listed`，不会把老群友当新人欢迎。
- **命令清单进提示词**：模型不再答"我没有自检功能"，被问起会直接告诉你发什么命令。

### 重构（bridge.js 11,236 → 10,728 行，−4.5%）

一晚十刀，每刀一个模块一提交、都能单独回滚：
`console-dsh` / `socialV2-video` / `console-ops` / `incoming-commands` /
`incoming-status-commands` / `session-registry` / `session-reset` / `incoming-guards` /
`preset-sim` / `workspace-reset` / `group-members` / `slang-submit` / `mux-learner` / `mux-tools`。

### 修复（都是"线上会静默坏掉"的那类）

| 现象 | 根因 |
| --- | --- |
| 机器人在线但**一条消息都不回** | 拆分后漏 import（`node --check` 查不出、VM 审计按名注入还掩盖） |
| 私聊全部 `cfg is not defined` | 把 `main` 的局部变量写进 `main` 之外的函数 |
| `/like` `/song` 报 `cmdText is not defined` | 半截搬迁：搬走定义、留下用法 |
| 控制台启动即炸 | TDZ（引用了后文 `const`），改惰性创建 |
| 抖音解析第一次就"冷却 9 秒" | cooldown 把"没有记录"当成"上次在 0 时刻" |
| `/status` 一按就 ReferenceError | 只写了调用、没写实例定义 |

### 测试（73 → 84 个脚本）

新增护栏：`test-bridge-imports`（静态扫"用了但没来源"的工厂）、`test-file-size`（体积棘轮，
新文件 >800 行直接失败）、`test-incoming-guards`、`test-session-registry`、`test-selfcheck`、
`test-workspace-reset`、`test-douyin-meta`、`test-mux-pump`（假 mux 喂帧）、`test-mux-learner`、
`test-mux-tools`。

### 文档

- 运维指南新增 §20「拆分期最危险的五个坑」；`docs/sessions/2026-10-30.md` 交接记录；
  `docs/validation/linux-run-2026-10-30.md`（另一台 Linux 独立复跑，审计 84/84）
- **新增 [docs/UPGRADE.md](docs/UPGRADE.md)**：按版本写"升级要做什么"

## 2026-10-29 — 网关可替换：NapCat 实测通过 + 登录体验修复

- 实测 NapCat（OneBot v11）替代 SnowLuma：桥接零改动，只改 `snowluma.wsUrl`
- 踩坑记录写进 QUICKSTART：HTTP+WS 都要开、不能与 QQ 客户端同时登录、二维码要放大
- `scripts/napcat-login.ps1`：一键拉起 + 二维码放大 4 倍（147px 手机扫不动）
- 登录助手里的示例账号是占位符，仓库不含真实 QQ 号与 token

## 2026-10-29 — 装机体验：体检 + 一键安装 + 一页版快速开始

- `npm run doctor`：逐条诊断四大卡点（Node / DSH 路径 / SnowLuma / 官方凭证），**每条失败都带修法**
- `scripts/setup.ps1`：一键装（便携 Node、官方凭证当场验证、自动打开扫码页、绝不覆盖已有 config）
- `QUICKSTART.md`：一页版，读完就能判断自己该走哪条路线
- README「装起来」改成三条路线对照 + 四大卡点表

## 2026-10-28

### 新增

- **视频理解**：`qq_get_message_video` / `qq_open_video` —— 视频降维成「一张 3×3 故事板（每格烧时间戳）+ 音轨转写」。模型第一次能"看视频"。见 [docs/guides/VIDEO.md](docs/guides/VIDEO.md)
- **视频链接识别**：B站 / 抖音 / 快手 / 小红书 / YouTube 五站白名单；yt-dlp 只下前 180 秒（实测 84MB/8s → 1.5MB/3s）
- **抖音专用解析器**（`src/douyin-resolve.js`）：yt-dlp 的 Douyin extractor 要 a_bogus 签名（无签名 403，**登录也无效**），改走分享页 `play_addr` + `playwm→play` 去水印；实测 97 秒 / 6.2MB
- **cookies.txt 兜底**：`socialV2.media.video.links.cookiesPath`（优先级高于 `cookiesFromBrowser`）—— Chrome/Edge 127+ 的 app-bound 加密让 `--cookies-from-browser` 读不出
- **cookie 体检**：`GET /api/socialV2/video-cookies` → `ok` / `cookie-aging` / `cookie-expired` / `cookie-missing` + `remaining`（人话剩余时间）。抖音链接成功时若即将过期会附提醒；失败时直接说「重导一次」而不是「视频不存在」
- **技能**：vendored `caveman`（Apache-2.0，纯 markdown）+ `scripts/install-skills.ps1`；边界是「**只压日志和输出，代码逐字**」。见 [docs/guides/SKILLS.md](docs/guides/SKILLS.md)
- 排障脚本：`verify-video-live.ps1`（真机验证视频）、`probe-video-cookies.ps1`（探测哪个浏览器能出 cookie）、`set-video-cookies.ps1`（自动发现并接上导出的 cookies.txt）

### 新增（长期记忆 · LivingMemory 式结构）

- `src/memory-store.js`：记忆原子 `{text,tags,weight,createdAt,lastHitAt,hits,source}`，
  有效权重 = `weight · 0.5^(天数/30)`（半衰期 30 天）；命中 `weight += 0.3`（封顶 3）；
  打分 = `0.6·关键词覆盖 + 0.3·归一化权重 + 0.1·新鲜度`；Jaccard≥0.6 合并；有效权重<0.05 归档
- 接线：`memory-append` 落长期层（话题/群友印象；临时想法不落），`GET /api/socialV2/memory`
  注入 top-K（6 条 / 800 字预算，支持 `?q=` 按查询排序）；**老会话现场迁移**，升级即可见
- **合并留原文**：被 Jaccard 吞掉的文本进 `atom.variants[]`（每条最多 5 份），
  新增 `POST /api/socialV2/memory-split` 把任一条拆回独立原子（幂等）
- `scripts/test-memory-store.mjs`：13 项契约测试（分词/衰减/强化/打分/预算/合并/容量/归档/迁移/接线）

### 新增（官方通道 · 协议层）

- **QQ 官方机器人客户端** `src/qqbot-official.js`：AppID+AppSecret → access_token（缓存/提前刷新）、
  gateway、WebSocket（op10 HELLO / op2 IDENTIFY / op6 RESUME / op1 心跳）、事件翻译（群 @ / 群全量 / 单聊）、
  被动回复自动分配 `msg_seq`（**官方上限 5 次**，超了抛错而不是静默丢）
- `scripts/official-probe.mjs`：端到端验证（票据 → gateway → 收事件 → 回复一条）
- `scripts/test-official-client.mjs`：11 项离线契约测试（`<@!id>` 清洗、openid 不当 QQ 号、seq 上限、路由）
- `docs/guides/OFFICIAL-QQ.md`：两条腿的差异、加群前置（个人主体只能加自己管理的群）、协议要点、接入设计与**诚实状态表**

> **2026-10-28 端到端已实测通过**（真机器人 1906089685 + 真群）：
> token ✓ → gateway ✓ → WS 鉴权 ✓ → 收到群 @ 事件（「测试」）✓ → **被动回复成功** ✓。
> 复现：`node scripts\official-probe.mjs --creds <state/official.json> --seconds 180`

### 修复（官方通道 · 端到端打通）

一条「群里 @ 了却不下话」的排查，连续挖出 6 个坑，全部修掉并各自有测试/日志兜底：

- **@ 标记**：官方 @ 由网关在事件层剥掉 → 唤醒判定认 `__official.atBot`
- **配置登记**：`loadConfig()` 逐字段装配，漏登记 `official` 段 → 启用等于没启用（且零日志）
- **会话 key 正则**：`canonicalV2Key` / `isSessionAllowedInCurrentMode` 只认数字 → 官方 `official-<openid>` 被静默丢弃
- **空 @**：只 @ 不打字时 `content` 为空，被"空消息"分支丢掉 → 合成上下文让模型自己应
- **发送分流**：`sendToQQ` 直连 OneBot，官方 id 被 `Number()` 打成 NaN → 按前缀分流走官方 API
- **id 守卫短路**：`!Number.isFinite(id)` 对字符串恒真，压根没走到白名单 → `typeof id !== 'string' &&`
- **首回复闸门**：模型被唤醒先做 5 分钟"沉睡前观察"，群里 5 分钟没回复 → 未发言时观察请求直接 409
- **中止回合**：`⏹️ 已停止` 顶替了模型已生成的正文 → 有正文时发正文

另修：**DSH 搬目录后 MCP 区块被改名 `.disabled`** → QQ 会话完全没有 `qq_*` 工具（已恢复并写进 TROUBLESHOOTING S2）。

### 修复

- **排队消息落盘**：队列原来只在内存里，桥接重启就丢（真实吞过一条消息）。现在写
  `state/pending-queue.json`（临时文件 + rename 原子替换），启动时按「24 小时 / 每会话 50 条」剪枝恢复，
  DSH 就绪后自动补投；坏文件/旧版本一律降级成空队列并写日志，不会把桥接拖死
- **DSH 端口漂移自愈**：DSH 每次重启都换随机端口（54694 → 65452 → 50075），以前 QQ 侧只会回「⏳ 消息已排队」。
  现在桥接连不上时会问系统「DSH 在听哪个端口」（`Get-NetTCPConnection` + HTTP 探活），
  找到就写回 `config.json` 并重建客户端；日志有 `[dsh] 端口漂移：… → …`

- **`package.json` 的 postinstall 坏了**（少一个右引号 + 中文 mojibake）→ 任何人 `npm install` 都会在 postinstall 阶段失败。已修，并用 `test-packaging` 真跑一遍钉住
- 视频以 **`image` 段 + `.mp4`** 到达（不是 `video` 段）导致识别不了 → 按扩展名兜底识别
- 双 BOM 的 `.ps1` 会让 PowerShell 5.1 解析失败（`param()` 报"赋值表达式无效"）→ 加断言：所有 `.ps1` 必须恰好一个 BOM
- 视频链路曾因缺 `import fs` / `probeVideo` / 变量名写错，**把桥接打死**（守护自动拉起）→ 加「导入完整性」静态断言
- 抖音解析分支漏挂 `cleanup` → 临时目录永远删不掉（`r.cleanup is not a function`），已修并钉住

### 安全 / 稳定性

- **播放地址域名白名单**：解析出来的 `play_addr` 属于"数据不是信任"——下载器现在**每一跳**都校验
  `snssdk.com` / `douyinvod.com` / `amemv.com` / `byteimg.com` 等媒体域，跳数上限 3。
  只校验第一跳等于没校验（一个 302 就能带走）。
- **解析器 fixture 回归**：`scripts/fixtures/video/*.html` 存脱敏页面快照，
  上游改版时 `test-video-resolve.mjs` 直接红，而不是等用户发链接失败。
- 新增 [docs/guides/VIDEO-SOURCES.md](docs/guides/VIDEO-SOURCES.md)：**站点 → 路径 → 为什么**。
  实测结论：B 站 HTML 会 412（同一 URL 两个 IP 两种结果，按 IP 判定），公开 API 无 cookie 也通；
  抖音必须爬分享页（yt-dlp 缺 a_bogus 签名，登录也 403），而且**爬也要 cookie**（无 cookie 页面没有 `play_addr`）。

- **体检包含「视频工具就绪」**：`verify.ps1` 新增第 16 项，调用 `diag-tools.mjs` 判断三件套会不会注册
  （`[OK] 视频工具` / `[WARN]` 附原因与改法）；新人不必等到模型说"没这个工具"才发现
- **修掉一个假 FAIL**：`verify.ps1` 的依赖检查还硬编码着 `node_modules/@snowluma/sdk`，
  而该依赖在 `8f65bac` 就移除了（自带 OneBot 客户端）——全新机器体检会稳定报「缺 node_modules」，
  其实什么都不缺。现在改为读 `package.json` 的 `dependencies` 逐个核对
- **一条命令查工具可见性**：`node scripts\diag-tools.mjs` —— 桥接侧 / 代码侧 / 运行侧三条线索
  一次摊开并给结论（`0` 全注册 / `1` 有缺失且指出改什么 / `2` 连不上），支持 `--json`、`--skip-mcp`
- **工具可见性可诊断**：MCP 启动时打印「工具注册完成：N 个｜视频/图片：…✓…」与被关闭的工具清单
  （以前 `disabledTools` 收完就丢，模型看不到某个工具时只能靠猜）；桥接新增只读端点
  `GET /api/socialV2/tools`，直接告诉你三个视频工具会不会注册、以及 `getImages=false` 的后果

### 测试

- 审计 **50/50**；新增 `test-video-frames`（12 项）、`test-video-link`（12 项）、`test-video-resolve`（13 项）

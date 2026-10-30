# 更新日志

只记**用户能感知的变化**与**踩过的坑**。按日期倒序。

## 2026-10-31 — 0.3.2：新手开箱（零基础指南 / 自检.bat / 占位截图）+ 角色卡按节奏注入

> 无破坏性变更。新增 1 个配置项 `socialV2.roleInjectEvery`（默认 `1` = 行为不变）。

### 新手开箱

- **零基础八步指南** `docs/guides/BEGINNER.md`：从空电脑到「她在群里回话」，
  每步都写「做什么 / 应该看到什么 / 没看到怎么办」+ 卡点速查表 + 术语小抄
- **`自检.bat`**：双击就能跑环境体检（12 项），末尾 `pause` 不闪退，按退出码给结论
- 第 5 步拆成 6 个带**截图位**的子步骤；`assets/beginner/` 已放入占位图（覆盖同名文件即可换真图）
- README 顶部与「什么都没有」两条路径都指向零基础指南

### 省 token：角色卡按节奏注入

- `socialV2.roleInjectEvery`（默认 `1` = 每轮全量，行为不变）
- 设成 `8`：首次/换卡全量，其后每 8 轮一次 —— 实测提示词 **33,473 → 10,282 字节**
  （≈15K → 4.7K tokens），**每轮省约 10K**
- 只影响提示词，不影响服务端权限判定；脏配置（0/负数/字符串）一律退化成每轮全量

### 验证

- **干净克隆**（新文件夹、无 node_modules/config/state）→ 审计全绿、文档链接全通
- 顺带修掉 4 处「本地没事、仓库读者会撞」的文档漂移：
  体检项数写错（16→12）、体检提示没指向新手文档、README 表格串行、README 缺新手入口

### 已知未做

- `scripts/first-run.ps1 -DryRun` 在全新克隆里 exit=1（体检 FAIL: 无 config.json），
  对新手有误导；下次改成 0/2 并加说明
## 2026-10-31 — 0.3.1：波次 4 收官（bridge.js 11.2k → 10.0k）+ 三条外部模型路线验证

> 升级方式见 [docs/UPGRADE.md](docs/UPGRADE.md)。**没有破坏性变更**；
> 新增 1 个配置项（`socialV2.notifyAgentErrors`），其余行为不变。

### 用户能感知的变化

- **回复更快、更稳**：`bridge.js` 从 11,236 行降到 **10,050**，内联路由从 41 条降到 **1 条** ——
  以后加接口只能写进 `src/api/*.js` 并接进派发链（有棘轮守着，不会再长回去）。
- **技术报错不再刷屏**：新增 `socialV2.notifyAgentErrors`（默认 `true`）。
  换成第三方模型时 `No API key` / `context overflow` 这类消息不再推到 QQ，只进日志。
- **换模型不再静默失败**：非 DeepSeek 的 provider（如千问、Bedrock）若模型不支持"思考强度"，
  桥接会自动去掉该字段重试一次，并在日志里写明原因 —— 以前是失败两次然后**静默退回默认模型**。
- **`/api/voice/send` 修好了**：这个操作者通道此前一直是 500（三个依赖没注入），现在能正常发语音。
- **角色卡可以"按节奏注入"**：新增 `socialV2.roleInjectEvery`（默认 `1` = 每轮全量，行为不变）。
  设成 `8` 之后：首次/换卡全量，其后每 8 轮一次 —— 实测提示词从 **33,473 → 10,282 字节**
  （≈15K → 4.7K tokens），**每轮省约 10K tokens**。只影响提示词，不影响权限判定。

### 修复

- **角色卡不再写死管理员 QQ**：改用 `isOwner` 标记（号码由服务端校验）。
  之前隐私脱敏把号码换成了占位值，导致机器人**不认老板** —— 这是一次真实的回退。
- **`consolePort` 现在会校验**：写成 `"abc"` / `99999` 会在启动时直接报错并说清范围，
  以前是 `listen EACCES` 之后控制台静默打不开。
- **干净克隆 113 → 116 个测试套全绿**（新增：`check-privacy` / `test-config-dirty` /
  `test-model-effort-fallback`）。

### 外部模型路线（实测记录）

| 路线 | 文本 | 工具调用 |
| --- | --- | --- |
| DeepSeek（默认） | ✅ | ✅ |
| 千问 `qwen-max` | ✅ | ✅ |
| 千问 `qwen-flash` / `qwen-plus` | ✅ | ❌ 工具参数传错 |
| 暴喵网关（实际是小米 MiMo） | ✅ | ✅ 但窗口小、常空收尾 |

细节见 [docs/guides/GPT-ROUTE-STATUS.md](docs/guides/GPT-ROUTE-STATUS.md)。
**生产配置仍是 `deepseek-official / deepseek-flash`。**

### 踩过的坑（写下来免得再踩）

- 按**缩进**切代码 → 误删了相邻的 `/api/security` 整块；必须按大括号配平 + 复核 diff。
- 按**命令行**过滤进程 → 误杀了真机；要按端口归属（3100 真机 / 3199 沙箱）。
- 自定义 provider 不写 `contextWindow` → 一上来就 `context overflow`。
- 中转站先问一句"你是哪个模型"再付钱。
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

- **`/诊断`（管理员）**：回答"这条消息为什么没回我"。桥接记下每条消息的决策链
  （闸门 → 暂停 → 唤醒命中/未命中 → 投递），环形缓冲 80 条、只记截断文本。
  `/诊断` 看本会话最近 8 条，`/诊断 全部` 看全局，`/诊断 #12` 查单条。
- **`qq_people_note` 工具**：模型终于能"记事"和"纠错"——以前人物库只读，
  记错只能 `/reset` 全清。`op=add/list/clear`，作用域可到群或全局；
  档位太低（陌生人/仅名单）时笔记暂不注入，`list` 会明确告诉你有几条被隐藏。

### 重构（bridge.js 11,236 → 10,728 行，−4.5%）

一晚十刀，每刀一个模块一提交、都能单独回滚：
`console-dsh` / `socialV2-video` / `console-ops` / `incoming-commands` /
`incoming-status-commands` / `session-registry` / `session-reset` / `incoming-guards` /
`preset-sim` / `workspace-reset` / `group-members` / `slang-submit` / `mux-learner` / `mux-tools`。

### 按公开 issue 核对后的修复（2026-10-30 收尾）

拿上游公开 issue 清单逐条对照**当前代码**核，不照抄结论。结果：#110 / #114 / #115 成立并已修；
#112 在本仓库不复现；#80 / #109 / #111 仍待验证（见下）。

**已修复**

- **DSH 凭据读取恢复（#110）**：不再把一次瞬时读取失败永久缓存成"匿名可用"。
  成功值才缓存；失败按 2s / 4s / 8s…（上限 30s）退避重试。
  以前 DSH 还没写出 `.credentials.yaml` 时，一次失败就要重启进程才能恢复。
- **限频重试定时器（#114）**：真正开始一次新的唤醒时清掉仍在排队的限频重试定时器。
  否则它到点会**再起一个回合**（重复调模型、可能重复回复）。
- **令牌日志脱敏（#115）**：移除 4 处令牌片段日志（控制台令牌前 6 位、
  SnowLuma WS / HTTP 令牌前 4 位、连接探测结果前 4 位）。现在只说明"已生成 / 已更新"。

**验证**

| 项 | 结果 |
| --- | --- |
| 审计套件 | **88/88** 通过 |
| 干净克隆 | `git clone` → **85/88**（3 个失败的含义见下，不是"全过"） |
| 重启后运行状态 | 已验证（SnowLuma / DSH / 官方通道全就绪，日志无令牌片段） |
| 黄金快照 | 一致（`snapshot-prompt.mjs --diff 2026-10-29T17-13-36`） |

**仍待验证（不要当成已解决）**

- **#80 / #79 提示词注入**：目前只有部分防线（`slang-learner` 对群聊文本做标签转义与控制字符剔除；
  工具守卫拒绝未知工具）。**主聊天提示词的段落伪造边界尚未系统验证**，列为下一轮 P0。
- **#109 mark_read 水位语义**：`pendingWakeKeys` / `unread` / `markReadCalledKeys` 三者的
  "已收到"与"已处理"语义尚未统一验证，需要专门一轮追踪，不做猜测式修改。
- **#111 Clash TUN / fake-ip**：需要在真实代理环境复现；**不得以修复兼容性为由削弱 SSRF 防护**。
- **#112 干净克隆 ENOENT**：本仓库 `docs/guides/VOICE.md` 已纳入版本控制，不复现。

### 已知不稳定项（如实记录）

`scripts/test-reply-wait.mjs` **偶发失败**：单独跑 10/10 通过，全量审计时偶尔红一次
（本轮 3 次全量里红 1 次）。原因是它依赖真实的静默窗口计时，机器负载高时会被挤压。
**这不是功能回归**，但会让人误判。下一轮处理方向：
要么把窗口改成可注入的假时钟，要么在审计里给它单独的重跑一次。

### 文档一致性修复（2026-10-30 夜间）

一次完整的文档复核抓到 5 类问题，全部已修：

| 问题 | 修法 |
| --- | --- |
| TROUBLESHOOTING 有两个 `S` 节、`R` 跑到 `S` 后面 | 官方通道排错整段搬到 [OFFICIAL-QQ.md 第九节](docs/guides/OFFICIAL-QQ.md)，原文只留指针；`R` 回到 `Q` 之后 |
| 目录漏列官方通道 | 目录补一行，直接跳 OFFICIAL-QQ 第九节 |
| 审计套数三个数字（43 / 69 / 73→78） | 统一为 **88**，并写明"以脚本输出为准" |
| bridge.js 行数三种说法（10,940 / 约 1.2 万 / 11,236→10,940） | 统一为 **约 1.1 万（当前 10,771，以 wc -l 为准）** |
| 真机器人号 / 群友昵称 / 群 openid 未脱敏 | 全部替换为 `<你的机器人QQ号>` / `<群友昵称>` / `official-<openid>` |
| OFFICIAL-QQ 第六节标题写"下一步"、状态表写"已接入" | 改为「接入设计（已落地）」+ 每行标 ✅ |
| ttl=86400 的结论容易被误读成"依赖 86400" | 补一句"不要用 ttl 做任何超时/缓存决策" |
| 端口示例数字会被误当固定值 | 三处改为 `<旧端口>` / `<新端口>` 并注明每次启动不同 |
| 作者本机代理写死 | 标注"作者本机，按需替换" |

另：TROUBLESHOOTING 顶部新增**症状 → 节号**索引表（19 行），AI 和人都不用读全文。

### 干净克隆实测（2026-10-30 收尾，如实记录）

在 `git clone` 出来的目录里跑审计：**85/88**。三个失败的归因：

| 脚本 | 原因 | 是否代码缺陷 |
| --- | --- | --- |
| `test-qq-model-view.mjs` | 依赖复制不全（缺 `zod-to-json-schema` 等传递依赖；本机无 npm 可装） | 否（环境） |
| `test-qq-mode-plugin.mjs` | 同上（缺 `@deepseek-ai/cosmokit`） | 否（环境） |
| **`test-first-run.mjs`** | **它直接读仓库根目录的 `config.json`，而该文件被 gitignore** | **是** |

最后一条是本轮新发现，与 #112 同源：**审计脚本不应假设本地状态文件存在**。
修法（下一轮）：让该脚本自己写一份临时 `config.json` 到沙箱目录再跑，
而不是读工作区里那份。**在此之前，不要把"干净克隆全绿"写进任何发布说明。**

> 本次验证的局限：本机打包环境没有 npm，`node_modules` 是从开发目录复制的，
> 所以**没有覆盖"全新安装（npm ci）"这条路**。

### 修复（都是"线上会静默坏掉"的那类）

| 现象 | 根因 |
| --- | --- |
| 机器人在线但**一条消息都不回** | 拆分后漏 import（`node --check` 查不出、VM 审计按名注入还掩盖） |
| 私聊全部 `cfg is not defined` | 把 `main` 的局部变量写进 `main` 之外的函数 |
| `/like` `/song` 报 `cmdText is not defined` | 半截搬迁：搬走定义、留下用法 |
| 控制台启动即炸 | TDZ（引用了后文 `const`），改惰性创建 |
| 抖音解析第一次就"冷却 9 秒" | cooldown 把"没有记录"当成"上次在 0 时刻" |
| `/status` 一按就 ReferenceError | 只写了调用、没写实例定义 |
| 真机 500 `agentTokenOk is not defined` | 新 handler 建在了 `main` 层，而它依赖 console 作用域的 const |
| `/诊断` 被人设菜单吞掉 | 管理命令放在了公开命令之后（与 `/自检` 同源） |

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

> **2026-10-28 端到端已实测通过**（真机器人 + 真群）：
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

另修：**DSH 搬目录后 MCP 区块被改名 `.disabled`** → QQ 会话完全没有 `qq_*` 工具（已恢复并写进 docs/guides/OFFICIAL-QQ.md 第九节 9.2）。

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

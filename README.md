# QQ ↔ DeepSeek Harness 桥接

> **这是个人增强分支（fork）**：在上游 `qq-bridge` 基础上加了攻略模板、点歌/唱歌/说话、斗图、
> 点赞、发动态、人格卡、守护进程等能力，改动清单见 [FORK.md](FORK.md)。
> 上游版权归 Derpyu520 与各位贡献者；本分支同样 **MIT**（[LICENSE](LICENSE) 是纯 MIT 正文，
> 第三方组件与数据出机清单在 [NOTICE.md](NOTICE.md)）。**仓库不含任何真实账号、群号、令牌或 Cookie。**

> **已经装过、要升级？** → [docs/UPGRADE.md](docs/UPGRADE.md)（按版本看要做什么，含回滚）
> **第一次用（没写过代码）？** → [docs/guides/BEGINNER.md](docs/guides/BEGINNER.md)（零基础八步：每步都写了「应该看到什么 / 没看到怎么办」）
> **想直接跑起来（会命令行）？** → [QUICKSTART.md](QUICKSTART.md)（一页版：体检 → 三条路线选一条 → 验证）
>
### 你已经装了什么？不用换，直接用

| 你现在的环境 | 能不能直接用 | 怎么做 |
| --- | --- | --- |
| **已装 NapCat**（AstrBot / 其它方案常带） | ✅ **不用换网关** | `gateway-select` 自动识别 SnowLuma 与 NapCat，谁在跑用谁；一个挂了自动降级，带 60 秒冷却不回跳 |
| 已装 SnowLuma | ✅ 主通道 | 默认就走它 |
| 正在用 **AstrBot** | ✅ 可以共存 | 先开只读模式试跑，两条轨道互不影响 → [迁移指南](docs/guides/MIGRATE-FROM-ASTRBOT.md) |
| 什么都没有 | ✅ 从零装 | → [BEGINNER.md](docs/guides/BEGINNER.md)（零基础）或 [QUICKSTART.md](QUICKSTART.md)（一页版） |

**只想先看看效果、不想动现有机器人？** 用只读模式：

```powershell
# 群里只记录、不回复（AI 潜水观察），随时可以关
node src/bridge.js   # 然后 /role 里切到 silent，或控制台点「暂停」
```

命令行快速体验（不需要 QQ 账号，30 秒）：`npm run demo`

### 选一条路，别从头读

```
你现在的情况？
│
├─ 只想先看看它怎么想   →  npm run demo          （不用 QQ、不联网，30 秒）
│
├─ 什么都没有（新手）    →  docs/guides/BEGINNER.md（零基础八步，含截图）
  │
  ├─ 什么都没有（会命令行）→  QUICKSTART.md          （体检 → 三条路线选一条）
│      └ 装不上/报错    →  npm run doctor        （逐条告诉你缺什么）
│
├─ 已经装了 NapCat      →  直接用，不用换         （start-all.ps1 -StatusOnly 自检）
│
├─ 正在用 AstrBot       →  MIGRATE-FROM-ASTRBOT.md（字段对照 + 只读试用）
│
└─ 卡住了 / 行为怪       →  运维指南.md           （17 节，全是真实事故）
```

> **踩坑了 / 要换网关？** → [docs/运维指南.md](docs/运维指南.md)（人工 + AI 双视角：症状速查、网关能力差异、双 token、改 bridge.js 的固定动作）
> 装不上先跑 `npm run doctor`，它会逐条告诉你缺什么、怎么修。

## 这个分支和上游、以及别的分叉有什么不一样

上游是 **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（★3.2k，最后更新 2026-10-22）**，
本仓库是它的个人增强分支之一。生态里还有不少兄弟分支，各自的取舍不同：

| 分支 | 它擅长什么 | 适合谁 |
| --- | --- | --- |
| [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（上游） | 基线实现，★3.2k | 想要"原汁原味 + 最多 eyeball" |
| [h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq)（★80） | TOTP 三级权限、控制中心、定时任务、跨平台 | 要给一群人用 |
| [adj18311/qq-bridge-plus](https://github.com/adj18311/qq-bridge-plus)（★29） | 贴吧集成、B 站视频教程 | Windows + 想玩贴吧 |
| [Lu-mi-nous/whale-talk](https://github.com/Lu-mi-nous/whale-talk) | bridge.js 拆得干净（约 6.9k 行）、测试多 | 想读架构 |
| **本分支（juju114514/qq-bridge）** | **QQ 官方通道（合规、不封号）+ Docker + 死信队列 + 外部触发 API** | 想长期跑、又怕封号 |

### 我们独有或明显更完整的四件事

1. **两条轨道同时跑**：本地注入（全群消息、可分条斗图）+ 官方 Bot（合规不封号）。
   别人通常只做一条；两条共用同一套人格卡、记忆、工具与白名单。
   见 [TWO-TRACKS.md](docs/guides/TWO-TRACKS.md)。
2. **官方通道的完整闭环**：被动回复窗口管理、主动消息、互动召回、意向识别
   （"明天见"只开窗不发）。见 [OFFICIAL-QQ.md](docs/guides/OFFICIAL-QQ.md)。
3. **可运维性**：死信队列（失败消息可补偿）、外部触发 `POST /api/inject`（webhook / CI / 监控）、
   Docker 部署、健康检查、Windows 一键脚本与守护进程。
4. **给 AI 与人共用的排障手册**：[docs/运维指南.md](docs/运维指南.md) —— 17 节，全部来自真实事故
   （网关能力差异、双 token、配置不生效、备份误提交、测试写死绝对路径……）。

### 我们**不**擅长的（诚实说明）

- **star 与用户量**：本分支 ★0，没有经过大量真实用户验证。上游和 h-D-ACE 更成熟。
- **多用户权限体系**：没有 TOTP / 多管理员分级，我们是"单人自用"取向。
- **官方通道的多媒体是"部分实现"**：图片与表情包**已实现并真机验证**（上传 → `msg_type=7`）；
  **语音未实现**（官方要 silk 编码，需要额外转码链路）。

> 如果你的诉求是"给一群人用、要权限分级"，优先看 h-D-ACE；
> 如果你是"自己长期挂一个、最怕封号"，这个分支值得一试。

---

把 QQ 接进 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）：群里/私聊的消息变成
DSH 会话里的用户消息，AI 的回复（分条、表情、语音、拍一拍、点歌）发回 QQ。

**两条独立的轨道，可以只跑一条，也可以同时跑**（[TWO-TRACKS.md](docs/guides/TWO-TRACKS.md)）：

| 轨道 | 身份 | 注册难度 | 能力边界 |
| --- | --- | --- | --- |
| **本地注入** | 你自己的 QQ 号（SnowLuma / OneBot v11） | 低（扫码即用） | 能读到**全群消息**，可分条/潜水/斗图（拟人的地基） |
| **官方机器人** | 独立的 bot 账号（q.qq.com · QQ Bot） | 高（主体认证、个人主体仅限自建群） | 默认只收 @、被动回复 5 分钟/5 条；**合规、不封号**，可主动消息与互动召回 |

两条轨道**共用**人格卡、记忆、工具、白名单与额度，只在外层换协议 —— 所以能力不重复实现。

**AI 不直连 QQ** —— 所有出站消息都要过桥接的白名单、额度、脱敏与令牌校验。这是刻意的：
模型被提示词注入怂恿也刷不了屏、越不了权。

```
QQ（个人号）──► SnowLuma（OneBot v11）──┐
                                      ├──► 本桥接 ──► DSH ──► DeepSeek / 其他 provider
QQ（官方 Bot）──► q.qq.com WebSocket ──┘        ▲                    │
                                               └──── AI 用工具回消息 ─┘
```

## 谁在用（如实写）

这个仓库 **star 是 0，但有真实用户在跑** —— 这点必须说清楚，否则会被当成"没人用的实验品"。

| 谁 | 怎么用 | 状态 |
| --- | --- | --- |
| 作者本人 | 个人号 + 官方 Bot 双轨，7×24 挂在一台 Windows 机器上 | 日常使用 |
| 一个约 **10 人**的小圈子 | 直接 `git pull` 取代码自建，不走 Star / Fork | 长期使用中 |

> 为什么 star 是 0：这些人是**直接拉代码**用的，没点 star 也不提 issue。
> 所以别用 star 数判断它有没有人用——它只是没被"发现"，不是没被"使用"。

### 独立环境验证（不是只有作者在跑）

| 环境 | 结果 |
| --- | --- |
| **Linux**（Debian / Node 22 / 4 核 7.9G，非作者开发机） | 审计 **84/84**，[复跑报告](docs/validation/linux-run-2026-10-30.md) |
| **Windows**（作者日常） | 双轨长期运行（本地注入 + 官方 Bot） |
| **官方通道** | 图片/表情**真机验证过**（[实作记录](docs/guides/OFFICIAL-MEDIA.md)） |

> 欢迎你复跑后把结果贴进 Issues —— 一张"能在你机器上跑通"的截图，比作者自述有用得多。

### 如果你也在用，欢迎留一句

不用写长文，一句话就够（贴在 [Issues](https://github.com/juju114514/qq-bridge/issues) 里，标题写「使用反馈」）：

```
- 跑在什么环境（Windows / Linux / Docker）
- 用哪条轨道（本地注入 / 官方 Bot / 两条都用）
- 最有用的一点 / 最坑的一点
```

真实的使用反馈比作者自吹有用得多；发现 bug 也请直接开 issue，
`docs/运维指南.md` 里的每一条几乎都来自真实事故。

---

## 它现在能干什么

| 类别 | 能力 |
| --- | --- |
| **聊天与人格** | 多会话人格卡（身份存文件里的 `id`，改名不影响绑定）、首次使用引导、`/role` 热切换、按需小节注入 |
| **群聊拟人** | 分条发送 + 随机间隔、潜水/唤醒状态机（`wakeConfig`）、拍一拍、收藏表情/斗图、黑话学习、**静默时段**（夜里不主动搭话） |
| **认人** | **人物库**：身份只认 QQ 号（改名片不断档），关系升档要「消息数 + 活跃天数」同时达标；模型可用 `qq_people_note` **记事与纠错**（记错能删，不用 `/reset` 全清） |
| **可观测** | `/自检`（网关 / DSH / 队列 / cookies 一屏看完）与 **`/诊断`**（这条消息为什么没回：闸门→暂停→唤醒→投递，逐段给判定） |
| **媒体** | 识图看表情（长图自动切片 + OCR 取字）、语音（TTS 现场合成 / 语音库）、唱歌、点歌（网易云）、合并转发、表情包管理 —— 唱歌的四条链路与踩坑见 [SINGING.md](docs/guides/SINGING.md) |
| **视频** | **模型看不了视频，所以降维**：抽 9 帧拼成一张 3×3 故事板（每格烧时间戳）+ 音轨 ASR 转写；两种模式 `storyboard` / `transcript`。详见 [VIDEO.md](docs/guides/VIDEO.md) |
| **视频链接** | 贴个链接就能看：**B站 / 抖音 / 快手 / 小红书 / YouTube** 白名单（其他站点一律拒）。yt-dlp 只下前 180 秒；抖音三档：`meta`（只取作者/标题/文案，**不下载**、秒回）/ `transcript`（转写）/ `storyboard`（抽帧看画面）；消息里出现抖音链接会**自动附元数据**；cookie 有体检与剩余天数 |
| **控制台** | `127.0.0.1:3100`：人格、黑话、表情库、令牌与花费看板、会话与工作区、安全 |
| **运维** | 守护进程（崩溃自动拉起、单实例、退避重启）、一键安装/体检、登录自启、换机器迁移清单 |
| **安全** | 自带 OneBot 客户端（不依赖第三方 SDK）、SSRF 五道闸、出站脱敏、控制台令牌、`state/` ACL |
| **官方机器人** | 收群 @ / 单聊、被动回复、**主动消息**（手动 + cron 定时播报）、**互动召回**（30 天 4 周期）、意向识别（"明天见"只开窗不发，真约定才召回）—— [OFFICIAL-QQ.md](docs/guides/OFFICIAL-QQ.md) |
| **外部触发** | `POST /api/inject`：webhook / CI / 监控推机器人（独立令牌，只能注入消息；`prompt` 交给 AI、`say` 直发）—— [INJECT.md](docs/guides/INJECT.md) |
| **可靠性** | 队列落盘 + 重启恢复 + 失败重投；**死信**（丢弃必留原文，可查看/重放）；state **schema 版本与迁移**（迁移前自动备份）；官方通道**实例互斥**（宿主机与容器不互相踢线） |
| **部署** | Windows 一键脚本；**Docker**（`docker compose up -d`，容器内可跑官方通道）—— [DOCKER.md](docs/guides/DOCKER.md) |
| **模型** | `deepseek-official`（✅ 已测试）｜`openai` / GPT 等兼容 provider（⚠️ **已接入、未测试**，见 [MODELS.md](docs/guides/MODELS.md)） |

> **第一次用？** 别看 README，先看 [docs/guides/BEGINNER.md](docs/guides/BEGINNER.md)
> —— 零基础八步，每步都写了「你应该看到什么 / 没看到怎么办」。

## 版本怎么看

> **以 `git tag` 和 [CHANGELOG.md](CHANGELOG.md) 为准** —— GitHub 的 Releases 页只是里程碑，
> 可能落后于 `main`。当前：**v0.3.2**（2026-10-31，[Release](https://github.com/juju114514/qq-bridge/releases/tag/v0.3.2)）。
>
> 想知道两个版本之间改了什么：`git log v0.3.0..v0.3.1 --oneline`。

## 最近更新

| 日期 | 内容 | 看这里 |
| --- | --- | --- |
| 2026-10-31 | **波次 4 收官**：`bridge.js` 11,236 → **10,050** 行，内联路由 **41 → 1 条**（棘轮只许减），审计 88 → **115** 个脚本；新增路由总表 [docs/ROUTES.md](docs/ROUTES.md) 与**隐私守卫** `check-privacy.mjs`；真机实测 8 条"真发"端点（发消息/语音/点歌），脏环境七场景全过 | [docs/sessions/2026-10-31.md](docs/sessions/2026-10-31.md) |
| 2026-10-30 | **可维护性大修**：bridge.js 11,236 → **10,771** 行（硬上限压到 10,800，由棘轮守住），拆出 15 个模块，审计 73 → **87** 个脚本；新增 [ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 `find-symbol`（查符号不用读整文件） | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 2026-10-30 | **`/诊断`**：回答「这条消息为什么没回我」——闸门 / 暂停 / 唤醒 / 投递逐段给判定，环形缓冲 80 条，只记截断文本 | [COMMANDS.md](COMMANDS.md) |
| 2026-10-30 | **`qq_people_note`**：模型能记事也能纠错（人物库以前只读，记错只能 `/reset`）；档位低时笔记不注入会明确告知 | [CHANGELOG](CHANGELOG.md) |
| 2026-10-30 | **`/自检`**：一条指令看清 DSH / 网关 / 队列 / 会话 / 最近错误 / 网关重连次数 / 抖音 cookies 剩余（不花 token） | [COMMANDS.md](COMMANDS.md) |
| 2026-10-30 | **抖音轻量档 + 自动附元数据**：只取作者 / 标题 / 文案、不下载；消息里出现链接自动拼进上下文（10 秒冷却，可关） | [VIDEO.md](docs/guides/VIDEO.md) |
| 2026-10-30 | **版本 0.3.0 + 升级指南**：按版本看「升级要做什么」，含备份 / 三种部署形态 / 回滚 / 故障对照 | [UPGRADE.md](docs/UPGRADE.md) |
| 2026-10-29 | **装机不再折腾**：`npm run doctor` 逐条诊断四大卡点并给修法；`scripts/setup.ps1` 一键装（含便携 Node、官方凭证当场验证、自动打开扫码页） | [README](#装起来) |
| 2026-10-29 | **Docker 真机跑通**：镜像构建 + 容器 `healthy`；容器内必须对齐 `consoleHost/consolePort`（已内置环境变量） | [DOCKER.md](docs/guides/DOCKER.md) |
| 2026-10-29 | **外部触发入口** `POST /api/inject`：独立令牌，webhook/CI 可推机器人说话 | [INJECT.md](docs/guides/INJECT.md) |
| 2026-10-29 | **实例互斥**：同一 bot 只允许一个进程连官方 gateway，宿主机与容器不再互相踢线 | [DOCKER.md](docs/guides/DOCKER.md) |
| 2026-10-29 | **丢消息兜底**：队列满/白名单变更导致丢弃时写死信（原文保留，可重放） | [CHANGELOG](CHANGELOG.md) |
| 2026-10-29 | **state schema 迁移**：升级前自动备份旧 JSON，版本不符自动迁移，失败不写版本号 | [CHANGELOG](CHANGELOG.md) |
| 2026-10-28 | **视频理解**：故事板 + 转写；五站链接识别；抖音专用解析器；cookie 体检 | [CHANGELOG](CHANGELOG.md) / [VIDEO.md](docs/guides/VIDEO.md) |
| 2026-10-28 | **技能**：引入 `caveman`（只压日志和输出，代码逐字）；`scripts/install-skills.ps1` 可装可卸 | [SKILLS.md](docs/guides/SKILLS.md) |
| 2026-10-29 | **两套实现方案**：本地注入（个人号）与官方机器人是**两条独立轨道**——官方渠道注册难，注册不下来时本地照常可用 → [TWO-TRACKS.md](docs/guides/TWO-TRACKS.md) | [TWO-TRACKS.md](docs/guides/TWO-TRACKS.md) |
| 2026-10-28 | **长期记忆**：LivingMemory 式原子（权重/衰减/命中强化/打分检索/合并/归档），老数据自动迁移 → [MEMORY.md](docs/guides/MEMORY.md) | [MEMORY.md](docs/guides/MEMORY.md) |
| 2026-10-28 | **官方通道可用**：QQ 官方机器人（q.qq.com）已实测通过 —— 收群 @ 消息 + 被动回复成功；协议层 + 11 项离线测试 → [OFFICIAL-QQ.md](docs/guides/OFFICIAL-QQ.md) | [OFFICIAL-QQ.md](docs/guides/OFFICIAL-QQ.md) |
| 2026-10-28 | **稳定性**：DSH 端口漂移自愈（自动发现并写回配置）；排队消息落盘，重启不再丢消息 | [CHANGELOG](CHANGELOG.md) |
| 2026-10-28 | 修复 `package.json` 的 postinstall（少引号 + 乱码，曾让 `npm install` 必失败） | [CHANGELOG](CHANGELOG.md) |

## 装起来

**先选路线** —— 大多数人卡住，是因为一开始就选了最难的那条：

| 路线 | 适合谁 | 要做的事 | 需要 Node？ |
| --- | --- | --- | --- |
| **Docker**（最省事） | 只想跑起来、机器上已有 Docker | `docker compose up -d` | ❌ 不需要 |
| **一键脚本**（推荐 Windows） | 想用个人号 + 官方通道，能装 Node | `powershell -File scripts\setup.ps1` | ✅ 脚本能帮你装便携版 |
| **手动** | 要改代码 / 别的系统 | 照下面步骤来 | ✅ 自己装 |

不确定缺什么？先跑体检，它会**逐条告诉你缺什么、怎么修**：

```powershell
npm run doctor          # 或 node src/doctor.js
```

```
✓ Node 24.21.0 —— ≥ 22 满足要求
✓ DSH 目录：C:\Users\<你>\.dsh
✓ SnowLuma 在线（端口 5099） —— 扫码页：http://127.0.0.1:5099
⚠ 官方通道未就绪 —— 未启用；缺 AppID / AppSecret
   → 跑 scripts/setup.ps1 按提示粘贴 AppID/AppSecret（会当场验证），或手动填 config.official
```

### 四个常见卡点（以及怎么绕过）

| 卡点 | 症状 | 一键脚本怎么处理 | 手动怎么办 |
| --- | --- | --- | --- |
| **Node 版本** | `npm` 报 `EBADENGINE` / 启动就崩 | 检测到 <22 时**下载便携 Node 到 `tools\node`**（不动系统环境） | `winget install OpenJS.NodeJS.LTS` |
| **DSH 路径** | 装 preset 找不到 `.dsh` | 自动在 `DSH_HOME` / 家目录 / 常见安装目录里找 | 设 `DSH_HOME=<你的 .dsh>` |
| **SnowLuma 扫码** | 个人号通道永远连不上 | 探到 5099 就**自动打开扫码页** | 起 SnowLuma → 打开 `127.0.0.1:5099` 扫码 |
| **官方 AppID/Secret** | 官方通道 `100016 invalid appid or secret` | 粘贴后**当场调 `getAppAccessToken` 验证**，通过才写盘 | 填 `config.official.appid/secret` |

> 官方通道完全可选：没有 AppID 也能只跑个人号（`setup.ps1 -SkipOfficial`）。

前提：**DSH 已安装并登录**、**SnowLuma 已启动并扫码登录 QQ 小号**。这两个都是外部程序，仓库里不含，
本项目**不会代为安装或启动**（设计不变量 L6）。

```powershell
# Windows
git clone https://github.com/juju114514/qq-bridge.git
cd qq-bridge
.\scripts\first-run.ps1          # 体检 → 装依赖 → 生成 config → 装 DSH preset →（可选）启动
```

```bash
# Linux / macOS
git clone https://github.com/juju114514/qq-bridge.git
cd qq-bridge
./deploy/first-run.sh            # 同样的五步
```

先看会做什么、什么都不改：`.\scripts\first-run.ps1 -DryRun` / `./deploy/first-run.sh --dry-run`。
只想体检（不装任何东西）：`node scripts/preflight.mjs`。

> `install.ps1`（老的一键安装，带 DSH 端口/SnowLuma token 自动探测）仍然可用；
> 两者的区别：`first-run` 只编排权威工具、每一步都可单独重跑，失败会直接给出文档锚点。

## 出问题了先看哪

| 症状 | 去哪 |
| --- | --- |
| 不知道从哪下手 / 全新机器 | [docs/guides/FRESH-INSTALL.md](docs/guides/FRESH-INSTALL.md)（按阶段列全所有坑） |
| 具体报错 | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)（96 条，按 A~S 分段） |
| 能连上但不回话 | 先查 `GET /api/socialV2/activity` 的 `paused`（[E.0](TROUBLESHOOTING.md)） |
| 守护/启动 | [docs/guides/LAUNCHER.md](docs/guides/LAUNCHER.md)（退出码契约） |
| 换机器 | [docs/guides/MIGRATION.md](docs/guides/MIGRATION.md)（DPAPI 备份跨机不可解密等） |
| 换模型 / GPT | [docs/guides/MODELS.md](docs/guides/MODELS.md) |
| 让 AI 帮你装/修 | [AGENTS.md](AGENTS.md)（AI 入口）→ [AGENT-INSTALL.md](AGENT-INSTALL.md) → [COMPAT.md](COMPAT.md)（硬契约） |

常用命令速查：[COMMANDS.md](COMMANDS.md)　文档总索引：[docs/README.md](docs/README.md)　目录/脚本命名：[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)

## 自测：三层，职责不同

| 层 | 命令 | 说明 |
| --- | --- | --- |
| 离线回归 | `node scripts/test-audit.mjs` | **50 套**，不需要 SnowLuma / QQ / DSH；CI 也跑其中一部分 |
| 活体自测 | `powershell -File scripts/live-full-test.ps1` | **54 项**，对着活的桥接跑，**会真的发 QQ 消息**（只发你自己私聊，`-MaxSends` 限流） |
| 控制台冒烟 | `node scripts/test-console.mjs` | 打 `127.0.0.1:3100` 的真机冒烟 |

## 诚实声明（别把"能跑"当"验证过"）

- **GPT / OpenAI 兼容 provider**：代码路径是透传，**功能已接入但未测试**。计价表只有 DeepSeek 的，
  其他模型按 `deepseek-flash` 兜底估算；工具调用/多模态/人格表现未验证 → [MODELS.md](docs/guides/MODELS.md)
- **Linux**：有完整的 `deploy/` 脚本与 `bash -n` 回归，但**没有真机端到端验证过**（只在 Windows 上跑通的）
- **字符集**：抓网页只按 UTF-8 解码，GBK/Big5 页面会乱码（不做编码嗅探）
- **SnowLuma**：第三方程序，本项目不依赖、不修改、不分发它的代码，只按公开的 OneBot v11 协议通信
- **QQ 账号风险**：用的是非官方协议，风控/封号风险由使用者自负

---


---

## 附：上游 README（原样保留）

> 下面是上游 `Derpyu520/qq-bridge` 的 README 正文，保留在这里是为了**与上游逐项对照**
> （版本适配历史、协议代次、安全守卫对账等细节都在里面）。本分支的改动清单见 [FORK.md](FORK.md)。

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 🗂️ 文档索引（全部文档一句话说明 + 是否仍然有效）见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。
>
> 🎤 独立的「发语音」工具已拆到仓库上一级的 **`../voice-tool/`**（命令行 `voice-cli.mjs` / 图形界面 `voice-gui.mjs`），不再依赖 qq-bridge 运行。

把 QQ 消息接入 DSH agent：QQ 好友/群发来的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 QQ。

<details>
<summary>版本与 DSH 适配历史（点开看；当前 <code>v0.2.1-r1</code> / DSH <code>0.2.1-rc.2</code>）</summary>

> ⚠️ **当前版本 `v0.2.1-r1`，适配 DSH 0.2.1-rc.2**（0.2.0-rc.2 亦兼容；两个版本上都逐项实测：`npm run verify:adaptation`）。
> 鉴权用 `~/.dsh` 里持久化的浏览器会话签名密钥**离线铸造 Cookie** —— DSH 0.1.7 起进程启动 token
> 只存在于内存、不再落盘，旧版「从 guard 日志里读 token」的方式已失效。agent preset 是 DSH 0.1.7 起的
> `@deepseek-ai/dsh-agent-preset` Cordis 行（`~/.dsh/.agent-presets/` 目录机制已废）。协议代次
> （Cookie 鉴权 / 斜杠 RPC / `/api/remote.mux` 事件流）自 DSH `0.1.2-alpha.1` 起引入，与更早的点号
> endpoint 协议不兼容 —— **DSH `0.1.1-rc.2` 及更早**请改用 tag
> [`v0.1.0`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.0)；**DSH 0.1.5-rc.1** 用
> [`v0.1.5`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.5)；**DSH 0.1.7-rc.2** 用
> [`v0.1.7`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.7)。
>
> v0.2.0 修的主要是**会话待处理队列读不出来**：桥接退役/重置 QQ 会话时要先清掉 DSH 侧没跑的队列，
> 而那段解析认的是一个**从来不存在的字段**（`session/control` baseline 的 `value.queues[<id>]`）——
> 于是**每一次**退役都抛 `invalid session/control baseline`，队列清不掉、旧任务继续在 DSH 里跑，
> 而日志里只有一行警告。**注意：这不是 0.2.0 引入的**——该代码随 v0.1.7 发布，报错日志早于
> 0.2.0-rc.2 的发布，0.2.0 只是把它翻了出来。现在读队列以一元 RPC `session/projections` 为主路径、
> 以 `projections[<id>].values.inbox` 为回退形状，并补了两条回归网。
> 同一轮还按 0.2.0 的真实工具清单重新对账了 QQ 安全守卫（新增 15 个必须隐藏的工具名，
> 含全局层默认启用的 `read_mcp_resource`、`plugin_manager`、`subagent_codex` 等）。
>
> 逐条改动说明见 [docs/guides/DSH_020_ADAPTATION.md](docs/guides/DSH_020_ADAPTATION.md)（0.2.0）
> 与 [docs/guides/DSH_021_ADAPTATION.md](docs/guides/DSH_021_ADAPTATION.md)（0.2.1）。
>
> **r4 主要改动**：QQ 表情包/动图链路（表情 CDN 优先、`emoji_id` 兜底、DNS 多地址故障切换）、
> 联网搜索改用与 DSH 同源的 DeepSeek 搜索（Bing 仅兜底）、`qq_wait_for_messages` 改 5 分钟长轮询、
> 控制台切模式被 5 秒轮询改回去、回合永久「繁忙」、机器人身份未注入等 issue 修复，外加一轮整体体检。
> 逐条见 [**Release v0.2.0-r4**](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.2.0-r4)。
>
> **v0.2.1-r1 主要改动**：适配 DSH 0.2.1-rc.2。修掉一处 **P0**——persona 里的 `{{cwd}}`
> 提示词变量在 0.2.1 被删除，导致**每个回合在系统提示词装配阶段直接 error、模型一次都不跑**
> （QQ 侧表现为「发消息完全没反应」）；同时把 0.2.1 新进全局层的 `working_directory`
> 与 terminal / session-query / plugin_market 一族补进安全守卫名单。
> 逐条见 [docs/guides/DSH_021_ADAPTATION.md](docs/guides/DSH_021_ADAPTATION.md)。
>
> 默认分支 `main` **就是**本版本，`git clone` 直接拿到，无需切换分支。

</details>

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

## 一键安装（推荐）

前提：**DSH 已安装并登录**、**SnowLuma 已扫码登录 QQ 小号**。这两个是外部程序，仓库里不含。

```powershell
git clone https://github.com/juju114514/qq-bridge.git
cd qq-bridge
powershell -ExecutionPolicy Bypass -File .\install.ps1 -OwnerQQ 你的QQ号
```

脚本会自动：

| 步骤 | 说明 |
| --- | --- |
| 检查 Node | 需要 >= 22.13（找不到就去常见安装路径和 DSH 自带运行时里找） |
| 探测 DSH | 找 DeepSeek Harness 进程监听的端口，不用手填 |
| 探测 SnowLuma | 找进程安装目录 → 读 `config/onebot_*.json` → 拿 HTTP/WS token 和端口 |
| 写配置 | 从 `config.example.json` 生成 `config.json`（已存在则备份后更新） |
| 装依赖 | `npm install`（失败自动换镜像重试） |
| 启动 + 验收 | 起桥接，轮询 `/api/status`，打印 `dshReady` / `snowluma.good` |

常用参数：

```powershell
# 也放行这几个群
.\install.ps1 -OwnerQQ 123456789 -Groups "111,222"
# 只写配置，不启动
.\install.ps1 -OwnerQQ 123456789 -NoStart
# 自动探测失败时手动指定
.\install.ps1 -OwnerQQ 123456789 -DshUrl http://127.0.0.1:54694 -SnowlumaHome "D:\SnowLuma"
```

**让 AI 帮你装**：把仓库交给任意能执行命令的 AI agent，让它按 [`AGENT-INSTALL.md`](AGENT-INSTALL.md)
一步步做——里面有期望输出、失败分支、必须停下来问人的点（登录 DSH、扫码 QQ）和验收标准。

### 日常启动（一键 + 守护）

Windows 下**只需要这一个命令**：

```powershell
.\start-bridge.ps1            # 起守护 → 守护起桥接；崩了自动拉起
.\start-bridge.ps1 -Status    # 看谁在跑、端口、SnowLuma、DSH
.\start-bridge.ps1 -Stop      # 优雅停止
.\start-bridge.ps1 -InstallStartup   # 登录自动起（计划任务）
```

三层关系：`start-bridge.ps1` → `scripts\bridge-supervisor.ps1` → `node src\bridge.js`。
**SnowLuma 不在这条链上**（第三方程序，你自己启动并登录；守护只探测 `:3000/:3001`，
不会代启）。退出码契约、重启退避、排障速查见 [docs/guides/LAUNCHER.md](docs/guides/LAUNCHER.md)。

Linux 用 systemd，不用这个：见 [docs/guides/SERVER.md](docs/guides/SERVER.md)。

### 日常维护

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\maintain.ps1          # 只报告
powershell -ExecutionPolicy Bypass -File .\scripts\maintain.ps1 -Apply   # 加密备份 + 裁日志 + 清用量
```

备份/隐私/凭据轮换/账号风控/孤儿会话/跨机灾备/非 Windows —— 见 **[docs/OPERATIONS.md](docs/OPERATIONS.md)**。

### 出问题先看排错手册

**[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** —— 按「卡在哪一步」索引，覆盖安装/启动/DSH/SnowLuma/不回话/人设/媒体/控制台/兼容性/性能，
共 96 条具体错误，每条都是「现象 → 原因 → 排查 → 解决」。

### 版本对了才能跑

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-versions.ps1
```

比对 `compat.json`（被验证过的 DSH / SnowLuma / @snowluma/sdk / Node 组合）与你的实际环境。
别人能用你不能、或你 clone 的版本较旧时，先跑这个。

### 装完/出问题时体检

```powershell
powershell -ExecutionPolicy Bypass -File .\verify.ps1
```

会逐项检查 Node、依赖、config、DSH 端口、SnowLuma 端口与 token、白名单、角色卡、
桥接进程、`/api/status`（dshReady / QQ 在线 / AI 是否被暂停）、日志目录是否可写。

退出码：`0` 全通过、`2` 有警告仍可用、`1` 有致命问题。
`-Restart` 可在桥接没跑时顺手把它拉起来。

手装流程见 [SETUP.md](SETUP.md)。

## 全新机器：一条命令走完准备

```powershell
.\scripts\first-run.ps1            # Windows：体检 → 装依赖 → 生成 config → 装 DSH preset →（可选）启动
.\scripts\first-run.ps1 -DryRun    # 只看会做什么，不装不改不启动

./deploy/first-run.sh               # Linux/macOS：同样的五步（见 docs/guides/FRESH-INSTALL.md）
./deploy/first-run.sh --dry-run
```

它**只调用权威工具**（`preflight.mjs` / `npm install` / `setup-dsh.mjs` / `start-bridge.ps1`），
任一步失败就停，并打印「下一步看哪一节」。两条硬边界写进了测试：

- **绝不覆盖已存在的 `config.json`**（你的配置永远是你的）
- **不启动、不安装 SnowLuma**（第三方程序，设计不变量 L6）

只想单独体检（不装任何东西）：

```bash
node scripts/preflight.mjs
```

它不依赖 `npm install`（只用 Node 内置模块），逐项检查：Node 版本、仓库完整性、
依赖、`config.json` 与关键字段、`state/` 可写、端口占用、DSH 与 SnowLuma 可达性、
人格卡元数据。每条结论都带「下一步看哪一节」。

会踩的坑与对应排查的完整清单（按阶段组织）：**[docs/guides/FRESH-INSTALL.md](docs/guides/FRESH-INSTALL.md)**。

## 模型接入（DeepSeek 已测 / GPT 等未测）

桥接**不直连任何模型厂商**：它把 `config.json` 里的 `dsh.provider` / `dsh.model` /
`dsh.reasoningEffort` 原样交给 DSH，并从 DSH 的模型目录读可用档位。

| provider | 状态 |
| --- | --- |
| `deepseek-official`（默认） | ✅ 已测试（本仓库所有回归与自测都在这个组合下跑） |
| `openai`（GPT 及其他 OpenAI 兼容 provider） | ⚠️ **功能已接入，但未测试** |

```jsonc
// config.json —— 换成 GPT 时只动这三行
"dsh": { "provider": "openai", "model": "gpt-4o", "reasoningEffort": "off" }
```

**"未测试"具体指什么**（不要当成"已支持"）：

- 计价表只有 DeepSeek 的模型价 → 其他模型按 `deepseek-flash` **兜底估算**（控制台会标 estimated，金额别当真）；
- 思考强度档位词表来自 DSH 模型目录，换 provider 可能没有对应档；
- 工具调用协议、多模态（识图/表情）、人格卡与分条节奏**都没有在非 DeepSeek 模型上验证**；
- 启动日志会主动打一条醒目提示，提醒这三件事。

接入步骤（在 DSH 侧配 provider + 三行 config）、已知缺口表、验证清单：
见 **[docs/guides/MODELS.md](docs/guides/MODELS.md)**。接新模型前先跑
`node scripts/probe-dsh-providers.mjs` 看清 DSH 认识哪些 provider。

> 不要把 API Key 写进仓库：DSH 走 `apiKeyEnv`（环境变量名）而不是明文 key。

## 安全

| 面 | 文档 |
| --- | --- |
| 提示词注入 / 花费熔断 / 远程暴露 / 最小权限 / 告警 | **[docs/guides/SECURITY.md](docs/guides/SECURITY.md)** |
| 花费熔断脚本 | `scripts/guard.ps1`（超限自动停 AI + 私聊告警） |
| 备份 / 隐私 / 账号风控 | **[docs/OPERATIONS.md](docs/OPERATIONS.md)** |
| 杀软干扰 | **[docs/guides/KASPERSKY.md](docs/guides/KASPERSKY.md)** |

## 服务器 / Linux 部署

```bash
sudo ./deploy/install-server.sh --owner-qq 你的QQ号
sudo ./deploy/verify-server.sh
```

systemd 托管、崩了自动重启、日志进 journald；维护与熔断脚本见
> 先确认该不该上服务器：**[docs/guides/TOPOLOGY.md](docs/guides/TOPOLOGY.md)**（桥接是最轻的组件；DSH/SnowLuma 留在桌面时，搬桥接只会多一段链路）

**[docs/guides/SERVER.md](docs/guides/SERVER.md)**（`deploy/maintain-server.sh` / `guard-server.sh`）。

## 项目展示

📽️ [AI 仿真群友 - 项目介绍视频](https://github.com/Derpyu520/qq-bridge/releases/download/v0.1.5/project-intro.mp4)（约 11 MB）

> 视频改由 **Release 附件**托管，不在仓库里——只想安装桥接的人不必再下载这 11 MB（它此前占整个仓库体积的 88%）。
>
> **来源说明**：这段视频是上游原作者 [Derpyu520](https://github.com/Derpyu520/qq-bridge) 制作并托管在他自己仓库 Release 里的，不是本仓库生成或托管的文件。本仓库只保留链接。

## 代码结构

`src/bridge.js` 目前约 1.34 万行（`main()` 占 1.1 万行、147 处路由分派）。
**分阶段拆法与进度工具**见 **[docs/REFACTOR-BRIDGE.md](docs/REFACTOR-BRIDGE.md)**：

```powershell
node scripts/route-inventory.mjs   # 导出全部路由（115 条唯一路径）
node scripts/test-router.mjs       # 路由表单测
```

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：适配 DSH 0.1.2 起引入、**0.2.1-rc.2 上逐项复核**的协议——用本机持久化签名密钥铸造会话 Cookie 鉴权、`/api/<namespace>/<method>` 斜杠 RPC、`/api/remote.mux` + `session/follow` 事件流（`session/control` 的队列读 `value.projections[<id>].values.inbox`，另有一元 `session/projections` 主路径）；复用 `AbstractApiClient` 传输层但不再依赖旧版 zod value schema。会话模型由桥接按 `config.json` 的 `dsh.model` 逐会话 `session.selectModel` 固定（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：QQ 动作**安全子集**（查状态/查群/查消息/发消息，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：**只有** `snowluma_status`（只读探活 `get_login_info`）。
    ⚠️ **v0.1.5 起移除了 `start_snowluma` / `stop_snowluma`**（以及 `snowluma.allowProcessControl` 配置项）——
    原因是 **SnowLuma EULA §5.4** 规定「将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**」
    须事先取得书面授权，而原生组件属专有组件。本程序**只探测、不部署**：SnowLuma 的安装、启动与扫码
    始终由你自己完成（详见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)）。
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 查网络用语/资料。
    **搜索优先复用 DSH 原本的联网搜索**（同一个 DeepSeek Anthropic 兼容端点 + `web_search` 服务端工具，凭据按 `config.webSearch.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → DSH 的 `.credentials.yaml` 顺序解析），
    因而结果质量与 DSH 内的搜索一致、且**不再默认把群聊关键词发给 Bing**（Bing RSS 只在 DeepSeek 不可用时兜底）。
    抓取仍由桥接自己做 SSRF 校验并限制正文大小；**黑话学习默认开启**，会把群聊里提取的词条交给所选的搜索后端。
    数据出机清单见 [NOTICE.md](NOTICE.md) 的「数据出机清单」，不需要就关掉黑话自动研究（`slang.autoResearch`）或把 `webSearch.provider` 设为 `bing`。
- **会话模型**：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话，统一归组到「QQ 聊天」工作区（不再散落未分组）；映射持久化在 `state/sessions.json`
- **性格定制**：QQ 会话默认使用 `qq-chat` agent preset，`reserved2` 使用 `qq-chat-v2`。DSH 0.1.7 起 preset 不再是 `~/.dsh/.agent-presets/<名>/` 目录，而是 `plugins/qq-agent-presets/` bundle 生成并插入 profile 的一条 `@deepseek-ai/dsh-agent-preset` 行（重启 DSH 后生效）；人格与默认 DSH 一致（coding agent），仅附加 QQ 场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（群友无法更改）
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——左侧按操作任务分为「运行总览 / 会话与审批 / 人格与角色 / 二代仿真 / 一代仿真 / 黑话词库 / 令牌与花费 / 访问与安全 / 调试与运维 / 工具参考」十个页面，右上角搜索框可跨页定位任意功能项；支持**浅色 / 深色双主题**（顶栏一键切换，未选择时跟随系统）；切换运行模式（chat / closed-agent / reserved / reserved2）、设置角色、静默开关、查看活动日志、修改管理员/控制台令牌，全部即时生效；访问需要令牌（`config.json` 的 `consoleToken`，未配置时自动生成并打印在启动日志；控制台内可手动修改或重新生成）
  - **令牌与花费看板**：实时显示 AI 的 token 消耗与折算金额（元），可下钻到**每个群 / 每个好友 / 每一轮对话**（轮次、步数、缓存命中/未命中输入、输出、命中率、花费、峰谷时段），并有**按时间的消耗走势图**（24 小时 / 3 天 / 7 天 / 30 天，柱子按高峰/空闲着色，一眼看出什么时候烧得凶、哪几个小时是 2 倍价）。累计总量取自 DSH 的 `tokenUsage` 投影（精确，含桥接启动前的历史），逐轮明细由 `assistant/message` 的 `usage` 折叠而来；金额按 DeepSeek 官方价目表折算并区分**高峰 / 空闲时段**（高峰单价为空闲的 2 倍，已内置中国法定节假日）。详见 [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)
  - **人格（角色扮演）管理**：列表点选即可载入查看/编辑提示词，支持新建、保存修改、改名（自动重命名文件）、另存为副本、删除；超过注入上限或含一代专用指令会实时提示
  - **两层提示词可分别查看与修改**：「仿真提示词」（预设内置，管行为与协议，保存后同步到 DSH，需重启生效）与「人格提示词」（`roles/*.md`，管人设与语气，保存即生效）；仿真层保存前做安全不变量校验与自动备份，可一键还原
  - **会话初始提示词**（二代仿真）：「二代仿真 → 初始提示词」里可以给某个群/私聊预写一段环境说明（圈子主题、群内氛围、常见话题、忌讳），AI **只在该会话第一次唤醒时收到一次**（之后已在会话上下文里，不再重复注入）。可在群还没说过话时提前写；AI 既读不到也改不了这份设置（仅控制台接口）。会话被重置（「会话映射」里的重置或「重置二代状态」）后，下一次首次唤醒会重新带上它。字数上限见 `socialV2.initialPromptMaxChars`
  - **DSH 思考强度**：默认 `max`，可选 `high` / `low`，档位从 DSH 实际公布的能力读取，保存后下一条消息生效；控制台会明示该设置同时写入 DSH 全局默认（`~/.dsh/settings.yaml`）
- **运行模式**：
  - `chat`：白名单群 + 白名单私聊 → qq-chat 安全聊天
  - `closed-agent`：仅私聊 owner（config.json 的 ownerQQ，可在控制台设置）→ 完整工具（默认用 DSH 自己声明的默认 preset，即 `standard`；可在控制台「closed-agent preset」下拉改为任意 DSH preset），可在 QQ 上操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `qq-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 QQ，回复即自动应答
  - agent 请求工具审批时，转发到 QQ，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；引用机器人自己时会被视为必回
  - **图片/表情（含动图 GIF）**：表情包优先走 QQ 的 CDN 直链，`get_image` 失败时用 `emoji_id` 推出 CDN 地址兜底；媒体元数据保留 `emoji_id`/`summary`/`sub_type` 等字段。下载走同一套 SSRF 防护传输，并修掉了「DNS 先返回 IPv6、本机没有 IPv6 出口 → 每次白等 20 秒」的根因（改为 **IPv4 优先 + 逐地址故障切换**），动图表情不再时好时坏。单条消息上限默认 8MB / 64MP / 5 张（`socialV2.media`）
  - MCP 发送工具支持可选 `replyToMessageId`，并新增专用 `qq_reply` 工具：AI 可以先用 `qq_get_group_history` 拿到真实消息 id，再引用/回复某条消息（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `qq_send_message` 数组）

## 前置条件

1. 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）
2. 运行中的 SnowLuma，且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `dsh.authToken` | DSH launch token（进程启动凭据）。**通常应留空**：留空时桥接用 `~/.dsh/.credentials.yaml` 里持久化的签名密钥**离线铸造**会话 Cookie，不依赖任何进程期状态（DSH 0.1.7 起启动 token 只存在于内存、日志里那条是上一个进程的陈旧值，换 Cookie 只会 401）。只有显式填了才会优先走 token 交换 |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.followDiscoveredEndpoint` | 默认 `true`。换 QQ 账号后 token 与端口都会变，桥接会自愈：重新发现并**跟随** SnowLuma 的端点（同时写回 `config.json`）。**想跑第二个实例 / 指向另一份 SnowLuma 安装（多账号、测试）时设为 `false`** —— 那时只自愈 token，绝不动 URL，也不写回 URL。详见「已知行为」 |
| `snowluma.silenceWarnMs` | 上游静默告警阈值（毫秒），默认 `600000`（10 分钟）。已连接但这么久没收到任何事件包（含心跳）时打警告；这只是**提示**，不确定性的判断交给 `good` |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 安装目录（用于 token/端点自发现）。⚠️ 桥接**不会**启动或停止 SnowLuma（见 `LICENSE`） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `qq-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `qq-chat-v2` |
| `socialV2.initialPromptMaxChars` | 会话「初始提示词」（控制台为某个群/私聊预写的环境说明）的字数上限，默认 2000，允许 100~8000。越界值会在启动时收敛并保持原文件不动 |
| `socialV2.media` | 图片/表情的上限：`maxBytes`（单条消息总字节，默认 8MB）、`maxPixels`（单张像素，默认 64MP）、`maxCount`（单条最多处理几张，默认 5）。越界值启动时收敛 |
| `webSearch.provider` | 联网搜索后端：`auto`（默认，优先 DeepSeek、失败回退 Bing）/ `deepseek`（仅 DeepSeek，无凭据时报错）/ `bing` |
| `webSearch.apiKeyEnv` / `apiKey` | 搜索凭据的环境变量名（默认 `DEEPSEEK_API_KEY`）/ 直接写死 key（不推荐）。都不设置时读 DSH 的 `$DSH_HOME/.credentials.yaml` 里同名 ref |
| `webSearch.baseURL` / `model` / `maxUses` / `maxResults` | 搜索端点（默认 `https://api.deepseek.com/anthropic/v1`，必须 https 且解析到公网）、模型（默认 `deepseek-v4-flash`）、单次搜索最多用几次工具、返回条数上限 |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`qq-chat` / `qq-chat-v2`）并挂载 MCP。**单机新装同样必须执行这一步**（不是只有「另一台设备」才需要），装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `qq-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖。之后可在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换模式，控制台会同时写入 DSH 设置与本地兜底文件。

详细步骤见 **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 6 步。DSH 已安装并运行，缺的是 SnowLuma 本体 + 桥接侧的 DSH 端安装（**第 2、3 步最容易漏，漏了 QQ 上会毫无反应**）：

1. **DSH**（已运行，无需操作）
   确认 `http://127.0.0.1:3080` 能打开即可。

2. **装桥接并复制配置**
   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   npm install
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   **示例模板里 `allow.private` / `allow.groups` 是空数组**——空白名单 + `allowAllWhenEmpty: false` 时桥接不响应任何消息（这是刻意的 fail-closed 默认值）。白名单在第 5 步填。

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   装完**必须重启 DSH**——preset 与 MCP 只在 DSH 启动时加载。
   跳过这步桥接不会崩，但群聊会话拿不到 `qq-chat` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到带 bash/文件工具的默认 preset），表现同样是 QQ 上没反应。

4. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

5. **首次引导（WebUI）+ 填写桥接配置**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）
   - 回到 `config.json` 填好 `snowluma` 段，并把 `allow.private` / `allow.groups` 换成**你自己的 QQ 号 / 群号**：

     ```json
     "snowluma": {
       "wsUrl": "ws://127.0.0.1:3001",
       "httpUrl": "http://127.0.0.1:3000",
       "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
     }
     ```

   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。

6. **启动桥接**

   Windows（推荐，带守护）：
   ```powershell
   .\start-bridge.ps1          # 起守护 → 守护起桥接；崩了自动拉起
   ```

   任意平台（前台裸跑，没有守护，只适合调试）：
   ```bash
   npm start
   ```

   看到 `SnowLuma 已连接` 即成功；然后 QQ 上给机器人账号发条消息测试。
   Linux 上生产请用 systemd（见 [docs/guides/SERVER.md](docs/guides/SERVER.md)）。

## 运行与运维

```powershell
.\start-bridge.ps1            # 一键启动（守护托管：崩溃自动拉起、单实例、退避重启）
.\start-bridge.ps1 -Status    # 看谁在跑、端口、SnowLuma、DSH
.\start-bridge.ps1 -Stop      # 优雅停止
.\start-bridge.ps1 -InstallStartup   # 登录自动起（计划任务，失败则退到启动文件夹）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 `start-bridge.ps1` 启动**：它起的是 `scripts/bridge-supervisor.ps1`（守护），
  崩溃后按 5/10/20/40/60 秒退避重启，连败 5 次才放弃。入口契约见
  [docs/guides/LAUNCHER.md](docs/guides/LAUNCHER.md)
- 桥接异常/消息无反应时：`.\start-bridge.ps1 -Stop` 然后重新 `-Start`；
  或直接看 `state\logs\supervisor.log` 与 `state\bridge.log`
- **SnowLuma 不在守护范围内**：它是第三方程序，必须你自己启动并登录；守护只探测
  `:3000/:3001`，不会代启（设计不变量 L6）
- **重启 DSH 通常不需要动桥接**：每 5 秒探活，DSH 不可用期间收到的 QQ 消息在桥接进程内排队（最多 96 条/会话，满后丢最旧项），恢复后尝试补投。桥接进程退出会丢失内存队列；断线期间已经结束的回复暂不保证补发。
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `dsh/agent-presets/`（改完要跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```

## 自测（不需要 SnowLuma / QQ）

> 想连**真的**桥接/QQ 一起测，用 `scripts/live-full-test.ps1`（54 项，只发你自己私聊，
> 有 `-MaxSends` 限流）。下面这些是不需要任何外部依赖的离线回归。

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
npm run test:audit
```

reserved2 的 token 开销优化、消息水位协议、升级及回退说明（该专项分析为本地文档，未随仓库发布。）专项离线回归可运行 `npm run test:token`，已包含在上面的完整回归中。

控制台「令牌与花费」看板的账本与价目表回归（峰谷分时、幂等折叠、基线合并、压缩与容错）：

```bash
npm run test:tokens        # 单元测试
npm run test:console-ui    # 离线浏览器回归（含看板渲染与逐轮下钻）
```

本轮审查与修复明细为本地审计文档，未随仓库发布。升级后会为没有权限元数据的历史映射重建一次 QQ 会话；模式或 preset 变化也会自动重建，避免保留旧权限。旧历史仍在 DSH 中。

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

## 目录结构

```
qq-bridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  README.md / README.en.md / RULES.md   # 根目录只留这三个文档，其余全在 docs/
  docs/
    README.md           # 文档索引（每篇一句话 + 是否仍然有效）
    FOLDER_MAP.md       # 目录结构与 scripts/ 命名约定
    guides/             # 面向使用者/运维：PROJECT_GUIDE / DSH_SETUP / VOICE / TOKEN_USAGE_CONSOLE / CONSOLE-UI-TESTING
    design/             # 设计与规划：GEN2_SIMULATION_PLAN / SOCIAL_MODE_PLAN / DSH_QQ_TOOLS_PLAN / 真人语感策略
    research/           # 调研：SnowLuma功能调研 / QQ消息免打扰 / 表情包能力 / 本地模型选型
    audits/             # 审查与优化报告（体检、控制台、token）
    legacy/             # 历史归档（已被取代或问题已全部修复的旧报告）
  audio/                # 语音库：把准备好的音频放这里，可作 QQ 语音发出（用法见 docs/README.md 文档索引）
  dsh/agent-presets/    # qq-chat / qq-chat-v2 的 DSH agent preset 模板
  plugins/qq-mode-console  # DSH 插件：注册 qq-mode 设置命名空间（仅 host 半，UI 卡片未实现）
  src/
    bridge.js           # 主程序
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
  scripts/              # 测试/运维脚本
    onebot-ws.js 的测试见 scripts/test-onebot-ws.mjs（自带客户端，不依赖 @snowluma/sdk）
  state/                # 运行时数据（不入库）
```

> 🎤 **独立的「发语音」工具不在这里**：它是仓库上一级的 `../voice-tool/`（`voice-cli.mjs` /
> `voice-gui.mjs` / `public/voice.html` / `发语音.cmd`）。图形界面双击上一级的「发语音-图形界面.cmd」。
> 它只依赖 SnowLuma，共享内核仍由本仓库 `src/voice-core.js` / `src/snowluma-conn.js` 提供（单一实现）。
>
> ```bash
> cd ../voice-tool
> node voice-cli.mjs status     # 账号/token 自动发现 + 连通性
> node voice-cli.mjs list       # 可发的群聊/私聊 + 语音库
> node voice-cli.mjs            # 交互菜单
> node voice-gui.mjs            # 图形界面（本地小服务 + 浏览器 UI）
> ```

## SnowLuma 版本与上游健康（「连上了但收不到消息」）

「注入」在这个技术栈里只发生在一处：**SnowLuma 用原生组件挂进 QQ 客户端进程**（它自己日志里叫
`[Hook]`，载体是安装目录的 `native/snowluma-win32-x64.{dll,node}`）。**本桥接没有任何原生/注入面**
（依赖全为纯 JS，源码里没有 `.dll` / `.node` / FFI / 进程注入），也不启动、不控制 SnowLuma 或 QQ ——
所以「QQ 注入失败」不可能是本桥接造成的。但**桥接过去无法把这个失败讲清楚**，于是它经常被误报成
「qq-bridge 的问题」。现在桥接会主动把上游健康报出来。

### 已知行为：连上了 ≠ 收得到

SnowLuma 的 `[Hook]` 会退化：它的进程和 OneBot WebSocket **都还活着**，但收不到 QQ 侧的数据。
它自己的日志长这样：

```
WARN [Hook] receive path stale: PID=… UIN=… silentFor=136193ms; reporting good=false
WARN [Hook] process enumeration timed out after 4000ms (worker abandoned)
```

这时桥接这边**一切正常**：WebSocket 通、日志打过 `SnowLuma 已连接`、控制台没有异常，但群里一条消息都不来。
桥接现在对此做两件事：

1. **主信号**：每 30 秒一次的 `meta_event/heartbeat` 载荷里的 `status.good`（SnowLuma 对「QQ → 原生 hook → 我」这条**接收链路**的自评，静默约 105 秒后翻 `false`）。心跳是 SnowLuma 自己的定时器无条件发的，所以这条信号免费且及时，且不需要较新的运行时。
   兜底：每 60 秒问一次 `get_status`（`{online, good}`）。加分项：`bot_status`（账号会话上下线，**SnowLuma 1.14.20 才真的有**）+「距最近一个事件包的时长」（只能证明进程/WS 还活着，**不能**证明收得到 QQ 数据 —— 心跳会一直来）。
   > ⚠️ **不要用 `get_login_info` 取 `good`**：它只返回 `{user_id, nickname}`，而 SDK 不校验 data 载荷 ⇒ 不会报错、`good` 永远是 `null`、这条判断变成永不触发的死代码。（本功能的第一版实现正是这么写错的，回归里已加反面断言钉住。）
2. 判定退化时：日志打**明确指向 SnowLuma `[Hook]`** 的警告、控制台「运行总览」出现 `SnowLuma 上游` 卡片、
   「访问与安全」页出现告警条，`GET /api/status` 的 `snowluma` 字段给出 `degraded` / `good` / `hint`。

排查顺序：控制台看 `SnowLuma 上游` 卡片 → 看 SnowLuma 的 `logs/snowluma-*.log` 里的 `[Hook]` 行 → 再考虑升级 SnowLuma（**升级不换原生组件，见下**）。

### 版本要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| SnowLuma **运行时**（QQ 网关本体） | **1.14.20 已实测**（1.14.9 亦兼容） | **实测记录（2026-10-03，SnowLuma 1.14.20 + QQ 在线）**：包 SHA256 与官方发布摘要一致；心跳 `status.good=true`／`interval=30000`；桥接走完「首次 1006 → 自愈 WS token → 已连接」；收到群消息（`lastPacketKind: message/group`）；完整往返成功（唤醒 → DSH 建会话挂 `qq-chat-v2` → 工具发送 1/1 条 → 实际发出两条回复）。 ⚠️ **升级运行时不会更换注入用的原生组件**：实测 `native/snowluma-win32-x64.{dll,node}` 与 `websocket-win32-x64.node` 在 **1.14.9 与 1.14.20 之间逐字节完全相同**（三方对比：官方 1.14.9 包 == 本机安装 == 官方 1.14.20 包），变的只有 `index.mjs`（+414 KB）等 JS 层。所以**升级能带来 OneBot 事件流水线、收发与新区块链路上的修复（`bot_status`、markdown 带 text、事件种类订阅更全），但不会修「原生 hook 挂不上 QQ」这类问题** —— 那种要走 SnowLuma 自己的排查。**升级 SnowLuma 是使用者自己的事**：本桥接只探测、不部署（见 [NOTICE.md](NOTICE.md) 与 [RULES.md](RULES.md)） |
| `@snowluma/sdk` / `@snowluma/mcp`（本仓库依赖） | 已钉 `^1.14.20` | 客户端库；OneBot v11 是稳定契约，新库可连旧运行时（本项目实测：库 1.14.20 + 运行时 1.14.9 可正常收发） |
| `bot_status`（账号上下线） | **1.14.20 有；1.14.9 没有** | 逐一核对的只有这两个版本：`bot_status` 在 1.14.9 的 `index.mjs` 里出现 **0** 次、1.14.20 里 **3** 次（带 `sub_type`/`user_id`）。**具体从哪个版本引入未逐版核对**。桥接对老运行时**优雅降级**：订阅不到就只靠心跳 `good` 与 `get_status` |

### 已知行为：HTTP token 与 WS token 是**两个不同的值**

SnowLuma 同一个账号的 **HTTP token（默认 3000 端口）与 WebSocket token（默认 3001 端口）并不相同**
（实测；`snowluma.accessToken` 里通常只能存一个 —— 存的是 HTTP 那个）。因此：

- **桥接每次启动的首次 WS 连接几乎必然失败一次**（日志里 `SnowLuma 连接断开（code=1006）` →
  `SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）`），随后自愈重新发现 WS token、
  重连成功，才打出 `SnowLuma 已连接`。**这条序列是正常的，不是故障。**
- 真正会一直连不上的情况：**自愈无从下手** —— `snowluma.homeDir` 没配 / 被移动 / 读不到
  SnowLuma 的 `config/onebot_<QQ号>.json`，或权限不足。这时日志里会有 `token 自愈失败`，
  而 QQ 侧表现为**完全收不到消息**。先确认 `homeDir` 指向真正的 SnowLuma 安装目录。

### 已知行为：端点自愈会覆盖你写的 `wsUrl`

换 QQ 账号后 OneBot 端口与 token 都会变，所以桥接在连不上时会自愈：重新发现 SnowLuma 的端点并
**写回 `config.json`**。这在主场景下是对的，但它不区分「配置里是个过期值」和「你就是要指向别处」——
想跑第二个实例或指向另一份 SnowLuma 安装时会连错账号。要关掉：

```json
"snowluma": { "followDiscoveredEndpoint": false }
```

关掉后**只自愈 token**（换账号仍能恢复），绝不动 URL、也不写回 URL。

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 `socialV2.send.maxMessageChars`（默认 500 字，可用 `social.maxReplyChars` 调整）自动按句读/URL 边界分段
- 图片及部分表情可以通过安全下载接入多模态模型；语音/视频以及无法取得图片字节的消息仍使用占位文本
- **发**语音是支持的（独立工具的图形界面 / 命令行 / AI 工具，见 `docs/README.md` 的文档索引）；但**收**到的语音目前只显示占位文本，不做语音转写入上下文
- **AI 发语音默认关闭**（`socialV2.voice.enabled` 与 `tools.sendVoice` 默认 `false`）：先把音频放进 `audio/`，再到控制台打开开关；你自己发语音不受这个开关影响
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- **不再依赖 `@snowluma/*`**：QQ 侧的 OneBot 客户端是本仓库自带的 `src/onebot-ws.js`（公开 OneBot v11 协议 + Node 内置 WebSocket）。之前为了绕开 `@snowluma/sdk` 的 ESM 打包 bug 需要 `postinstall` 去修改它的 `dist`，那条链路已一并删除——**本仓库不再修改任何第三方包**

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
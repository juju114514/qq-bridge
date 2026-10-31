# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注） · 🗄️ 已被取代（保留作背景）

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
- [运维指南](运维指南.md) —— 人工 + AI 双视角的排障手册：症状速查、网关能力差异（SnowLuma/NapCat）、双 token、改 bridge.js 的固定动作
- [升级指南](UPGRADE.md) —— 按版本看升级要做什么（备份 / 3 种部署形态 / 固定 7 步 / 回滚 / 故障对照）
- [借鉴方案：熟悉度 + 定时静默](plan-familiarity-and-quiet.md) —— 从兄弟仓库借四条规则，落地两个小模块（不移植）
- [模块化路线](plan-modularization.md) —— 真实体积、5 种职责、能力模块契约、6 波拆分顺序、体积闸门
- [架构说明](ARCHITECTURE.md) —— 为什么拆了还难改、rt 三个接缝、「改 X 去哪」索引
- [明天的 bridge.js 计划（2026-10-31）](plan-bridge-2026-10-31.md) —— 按收益÷风险排的五个批次 + 验收标准
- [2026-10-30 夜间工作记录](sessions/2026-10-30.md) —— 拆分清单、6 个真实缺陷、新功能、当前状态、回滚方法
- [Linux 独立环境复跑报告](validation/linux-run-2026-10-30.md) —— 另一台 Linux 上审计 84/84（含核对与复现步骤）
- [从 AstrBot 迁过来](guides/MIGRATE-FROM-ASTRBOT.md) —— 不用换 NapCat、字段对照、只读试用、迁移检查清单
| [../CHANGELOG.md](../CHANGELOG.md) | **更新日志**：按日期倒序，只记用户能感知的变化与踩过的坑 |
| guides/PROJECT_GUIDE.md | **权威项目说明书**（113 KB / 1450+ 行）：架构、内外核划分、数据流、配置全解、安全机制、调试与改进指南，含 2026-08-20 ~ 2026-09-11 的逐轮更新记录 | ✅ **唯一权威版本**（另一份同名精简版已归档到 legacy，见下） |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：`qq-chat` / `qq-chat-v2` preset 与三个 MCP server 怎么挂到目标设备的 DSH 上 | ✅ |
| [guides/VOICE.md](guides/VOICE.md) | 语音发送全解：独立工具（`voice-tool/` 的图形界面与命令行）、桥接 CLI、AI 工具、控制台面板，以及**工具拆出后的配置解析顺序** | ✅ 2026 整理时已更新（工具移到上一级 `voice-tool/`） |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 | ✅ 2026 整理时自 `scripts/` 移入 |
| [guides/LAUNCHER.md](guides/LAUNCHER.md) | **启动与守护**：三层链条（`start-bridge.ps1` → `bridge-supervisor.ps1` → `node src\bridge.js`）、退出码契约（0/1/2/3/4/5）、运行态文件、重启退避、登录自启的两种实现（计划任务 / 启动文件夹 `.vbs`）、与旧看门狗共存的禁忌 | ✅ 2026-10-27 |
| [guides/INSTALL-SKILL.md](guides/INSTALL-SKILL.md) | **一键安装 Skill**：把这份手册给能执行命令的 AI 助手，它替你装；用户只在三处动手（扫码/白名单/确认）；含自愈顺序与风险声明 | ✅ 2026-10-31 |
| [guides/RELEASE.md](guides/RELEASE.md) | **发版流程**：tag + Release 一条命令；含「gh 猜错仓库」「token 缺 read:org」「正文必须与标签一致」三个坑 | ✅ 2026-10-31 |
| [guides/BEGINNER.md](guides/BEGINNER.md) | **零基础八步**：从空电脑到「她在群里回话」。每步三件事——做什么 / 应该看到什么 / 没看到怎么办；含常见卡点速查表与术语小抄 | ✅ 2026-10-31 |
| [guides/FRESH-INSTALL.md](guides/FRESH-INSTALL.md) | **全新机器安装**（入口：Windows `.\scripts\first-run.ps1` / Linux `./deploy/first-run.sh`，或 `node scripts/preflight.mjs` 只体检）：按阶段（系统准备→取代码→装依赖→配置→装 DSH/SnowLuma→首次启动→首次对话）列出会踩的坑，每条标「有没有对应排查」；含本次补的 4 个缺口（没有 npm / PowerShell 执行策略 / preset 没装 / postinstall 提示不是错误）。入口命令 `node scripts/preflight.mjs` | ✅ 2026-10-27 |
| [guides/INJECT.md](guides/INJECT.md) | **外部触发入口**：webhook/cron 推机器人（独立令牌、白名单、限流、prompt\|say 两种模式） | ✅ 2026-10-29 |
| [../QUICKSTART.md](../QUICKSTART.md) | **一页版快速开始**：体检 → 三条路线 → 验证 → 卡住了怎么办 | ✅ 2026-10-29 |
| [guides/DOCKER.md](guides/DOCKER.md) | **Docker 部署**：能跑什么/不能跑什么（只跑官方通道）、三步起、必须改的三处、健康检查与排障 | ✅ 2026-10-29 |
| [guides/TWO-TRACKS.md](guides/TWO-TRACKS.md) | **两套实现方案**：本地注入（个人号）vs 官方机器人（q.qq.com）。为什么必须分开、注册难度、配置怎么切、共同层是什么 | ✅ 2026-10-29 |
| [guides/MEMORY.md](guides/MEMORY.md) | **长期记忆**：原子结构、衰减/强化公式、打分检索、合并与归档、迁移策略 | ✅ 2026-10-29 |
| [guides/OFFICIAL-QQ.md](guides/OFFICIAL-QQ.md) | **QQ 官方机器人通道**：与 SnowLuma 的差异、加群前置（个人主体只能加自己管理的群）、协议要点（openid/msg_id/5 次上限）、端到端验证脚本、接进桥接的设计与**当前真实状态** | ✅ 2026-10-28 **端到端已实测通过**（收群 @ + 被动回复） |
- [官方通道富媒体（图片）](guides/OFFICIAL-MEDIA.md) —— 两步上传、三个真机坑（file_name / ttl / msg_seq）、错误码速查
| [guides/VIDEO-SOURCES.md](guides/VIDEO-SOURCES.md) | **视频来源策略**：站点 → 路径 → 为什么；B 站 HTML 会 412（按 IP 判定）而抖音必须爬（缺 a_bogus 签名）；爬虫范围限制清单 + 失败码表 | ✅ 2026-10-28 |
| [guides/SKILLS.md](guides/SKILLS.md) | **技能**：装了哪个（caveman）、其余 4 个为什么不装、**压缩只许针对日志/输出（代码一律逐字）**、怎么加/卸载 | ✅ 2026-10-28 |
| [guides/VIDEO.md](guides/VIDEO.md) | **视频理解**：模型看不了视频，唯一解法是「抽帧故事板 + 音轨转写」。含四段管线（流式下载→ffprobe→tile 抽帧→ASR）、**链接识别（B站/抖音，yt-dlp 只下前 180 秒）**、`mode=storyboard\|transcript` 的取舍、8 类踩坑（黑格/糊/时间戳/内存/SSRF/空转写/慢/无 url）、测试与量测 | ✅ 2026-10-27 |
| [guides/SINGING.md](guides/SINGING.md) | **让 AI 唱歌**：四条链路（说话 / TTS 变调唱 / 点歌 / RVC 换声）各自能做什么、**模型运用顺序**（TTS 分词→变调→气口→拼接；RVC 六步训练）、踩坑总表（ffmpeg / PowerShell 编码 / 网络 / 显存 / 导出失败）、**诚实的测试状态**（TTS 与点歌已通，RVC 训练到 train、导出失败、无翻唱成品）、外部大纲 v9 里可借的六个音域指标与「RVC 换音色 + SVS 造音高」的分工结论 | ✅ 2026-10-27 |
| [guides/SESSION-BUSY.md](guides/SESSION-BUSY.md) | **「会话繁忙，暂存唤醒原因」**：这行日志什么时候是正常背压、什么时候是回合卡住（AI 一句不回）。含机制（四个 busy 来源 + 回合租约/唤醒租约两道保险）、**逐行日志解释表**、正常 vs 卡住的判据、三档处置（等租约/切模式/重启）、根因清单与预防；配套 `node scripts/diag-session-busy.mjs` | ✅ 2026-10-27 |
| [guides/MODELS.md](guides/MODELS.md) | **模型接入**：DeepSeek 官方（✅ 已测试）与 OpenAI / GPT 等兼容 provider（⚠️ **已接入但未测试**）。含架构（桥接只透传给 DSH）、接入步骤、**已知缺口表**（计价兜底估算 / 档位词表 / 工具协议 / 多模态 / 人格表现）、接入后的验证清单 | ✅ 2026-10-27 |
| [guides/GPT-ROUTE-STATUS.md](guides/GPT-ROUTE-STATUS.md) | **GPT/OpenAI 通道现状**（2026-10-31 实测）：key 有效但额度 0 → `429 credit_balance_exhausted`；含 DSH 0.2.1-rc.2 的 provider 能力证据、`gpt-smoke.mjs` 用法、充值后的六步验证顺序 | ⛔ 当前被余额卡住 |
| [guides/MIGRATION.md](guides/MIGRATION.md) | **换一台机器**：哪些能带走 / 哪些必须丢（`sessions.json` 的 sessionId、DPAPI 备份）、新机器必须重做的四件事（DSH 端口与凭据、预设、外部工具路径、白名单）、按顺序检错的七步 | ✅ 2026-10-27 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/工具面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单、改动检查单 | ✅ **改动安全相关代码前必读**（2026-09-20 新增） |

## validation/ 与 sessions/ —— 实测记录与现场（越新越权威）

> 规矩：**没实测过的，不写"已支持"**。这一节就是"实测过什么"的账本。

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [ROUTES.md](ROUTES.md) | **路由总表**（自动生成）：109 条模块路由 + 仍在 bridge 内联的条目，附行号。改路由后跑 `node scripts/gen-route-index.mjs --write` | ✅ 由 `check-route-index-fresh.mjs` 守住新鲜度 |
| [validation/regression-2026-10-31.md](validation/regression-2026-10-31.md) | 波次 4 拆完 5 批后的**整体回归**：干净克隆 113/113 + 46 条 GET 端点探测（404/400 逐条解释） | ✅ |
| [validation/live-endpoints-2026-10-31.md](validation/live-endpoints-2026-10-31.md) | **8 条"真发"端点实测**（发消息/语音/点歌/表情同步/长轮询），含每条的日志证据；顺带抓到 `/api/voice/send` 长期 500 | ✅ 含未覆盖项说明 |
| [validation/dirty-env-2026-10-31.md](validation/dirty-env-2026-10-31.md) | **脏环境七场景**：坏状态文件/垃圾字段/`__proto__`/坏 config/双实例/.tmp 残留/脏端口 | ✅ 并据此加了 `consolePort` 校验 |
| [validation/clean-clone-2026-10-31.md](validation/clean-clone-2026-10-31.md) | 干净克隆 + 全量审计（证明"没有只有本机能过的测试"） | ✅ |
| [sessions/2026-10-31.md](sessions/2026-10-31.md) | 那一夜的会话记录：10 批迁移明细、12 个真缺陷、自己犯的 5 个错 | ✅ |
| [plan-2026-11-01.md](plan-2026-11-01.md) | 次日计划：脏环境一键脚本、波次 5、红包提示词接线、历史清理的取舍 | 📋 待执行 |

## design/ —— 设计与规划（读设计意图用）

> ⚠️ 本目录被 `.gitignore` 排除（见 FOLDER_MAP 第三节）：只在本机可见，公开仓库里是死链。
> 决策记录在 `design/decisions/`（0001 SnowLuma 许可询问 / 0002 移除 `@snowluma/*` 依赖）。

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| design/GEN2_SIMULATION_PLAN.md | 二代仿真（`reserved2`）「一切皆工具」实施计划：WakeConfig 唤醒调度、MCP 工具集、控制台参数、`qq-chat-v2` preset | ⚠️ 骨架/API/调度/MCP/UI 均已落地，文中「状态：实施中」与残留 TODO 以当前代码为准 |
| design/SOCIAL_MODE_PLAN.md | 一代仿真模式（`reserved`）的头脑风暴定案：规则引擎管「何时说」、LLM 管「说什么」 | ⚠️ 描述的一代状态机已实现；`reserved2` 已是默认模式，设计背景仍有效 |
| design/DSH_QQ_TOOLS_PLAN.md | 「一切皆工具」总路线与交接文档：当前能力盘点、安全性设计、分阶段计划 | ⚠️ 阶段计划大部分已完成，作为路线/安全设计参考仍有效 |
| design/真人语感策略.md | 拟人化策略：短句碎片、接梗、错别字、话题漂移、选择性沉默、括号用法 | ⚠️ 文首已自注：部分「现状」写于旧版随机分句时期，最新行为以 PROJECT_GUIDE / 代码为准 |

## research/ —— 调研记录（结论可直接引用，过程可能过时）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| research/SnowLuma功能调研.md | SnowLuma 除「OneBot WS + 基础收发」之外还有哪些 QQ 相关功能与机制（API 面、可扩展点） | ✅ 调研对象 v1.14.9；换 SnowLuma 大版本后需复核 |
| research/RESEARCH_QQ_MESSAGE_DND.md | QQ 群「消息免打扰」到底影响不影响 SnowLuma 收发消息 —— 结论：不影响，只是不提醒 | ✅ |
| research/RESEARCH_SNOWLUMA_EMOJI_STICKER.md | SnowLuma 的表情包/收藏表情能力（`fetch_custom_face*` 等），本仓库收藏表情功能的依据 | ✅ |
| research/LOCAL_MODEL_SIZING.md | 若要本地复刻：本项目对模型的真实负载、显存门槛、27–35B 起步、双 3090 是性价比拐点 | ✅ 调研日期 2026-09-17 |

## audits/ —— 审查 / 体检 / 优化报告（按时间读，越新越权威）

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | **DSH 0.2.1 适配改动记录**（0.2.0 → 0.2.1）：两处真实断裂——P0 `{{cwd}}` 提示词变量被删（每回合直接 error、QQ 完全不回）、P1 `working_directory` 进全局层；含协议面零漂移的实测结论与逐条"判定无需改动"表 | ✅ **最新**；升级 DSH 前先看 §6 的增量清单 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配改动记录**（v0.1.7 → v0.2.0）：逐条列出为适配 0.2.0-rc.2 做的改动（现象/为什么必须改/证据/怎么验证），并单独列出「复核后判定兼容、因此没改」的部分与「同批但不属于适配」的改动 | ✅ 仍有效（0.2.1 未推翻其中任何结论）；升级 DSH 前先读 §10 的操作清单。放在 `guides/` 是因为 `audits/`、`design/`、`legacy/`、`research/` 都在 `.gitignore` 里（见该文件第 52–64 行），放进那几处的文档**不会进公开仓库** |
| audits/AUDIT_FIXES_2026-09-20.md | **那一轮（第二轮）三路并行审计与修复记录**：桥接内核 / 控制台与打包 / 文档基线；逐条列出已修、已确认无问题、列为规划 | ✅（取代下面那份的结论；`CODE_AUDIT` 中当时未修完的项已在此结清）⚠️ **本文件不在公开仓库里**（`docs/audits/` 被 `.gitignore` 排除），只在本地可见 |
| audits/CODE_AUDIT_2026-09-20.md | 同日较早的代码体检（P0/P1/P2/P3 清单与实现细节、指标统计：monolith 度量、重复代码盘点） | ⚠️ **多数已修**：修复状态以 AUDIT_FIXES 为准；本文的实现细节与度量仍有参考价值（2026-09-20 补登进索引） |
| audits/AUDIT_REPORT_2026-09-20.md | 全项目体检：四条独立审计线（状态机与重连、安全边界、健壮性与资源、配置/脚本/文档一致性）+ 按影响排序的修复 | ✅ 结论仍有效（取代 2026-09-18 那份） |
| audits/CONSOLE_FEATURES_REPORT.md | 控制台功能增强：人格管理、两层提示词（仿真层/人格层）、DSH 思考强度 | ✅ |
| audits/CONSOLE_UI_REDESIGN_REPORT.md | 控制台改版报告：九页导航 + 全局搜索 + 浅色/深色主题，纯前端改造 | ⚠️ 页数已增至 10（新增「令牌与花费」），其余仍有效 |
| audits/TOKEN_OPTIMIZATION.md | `reserved2` 的 token 开销优化与消息水位协议、升级与回退说明（README 直接引用它） | ✅ |
| audits/TOKEN_COST_ANALYSIS.md | token 成本实测档案与优化清单（含本文档形成时的个人用量数据） | ⚠️ 数据是当时的实测快照；结论方向仍被 TOKEN_OPTIMIZATION 引用，具体数字别当现值 |

## legacy/ —— 历史归档（**不要照着做**，留作背景与追溯）

| 文档 | 一句话说明 | 为什么归档 |
| --- | --- | --- |
| legacy/PROJECT_GUIDE.public-condensed.md | 面向公开仓库的**精简版**项目说明书（约 375 行、10 节，末行自述「公开版文档，不包含本地开发历史与个人配置」） | 🗄️ **被 `guides/PROJECT_GUIDE.md` 取代**：内容更全的那份一直持续更新到 2026-09-11（新增「近期更新」章节到第 25 节），精简版只覆盖到早期的 10 节；两份同名文档并存正是「界面叫法不同步」的来源（见 CONSOLE_UI_REDESIGN_REPORT 第 6 条）。**未删除**，保留以便需要对外发布脱敏版时取用 |
| legacy/AUDIT_REPORT_2026-09-18.md | 2026-09-18 的架构审查与修复报告（基线 `3c54e6b`，P0~P3 清单） | 🗄️ **被 `audits/AUDIT_REPORT_2026-09-20.md` 取代**：后者是对同一代码库的更新一轮体检，并已覆盖前者的待办 |
| legacy/ARCH_REVIEW.md | 2026-08-18 的架构审查：严重 #1~#6、中等 #7~#15、轻微 #16~#20、新增 #21~#30 | 🗄️ **问题已全部修复**：文首两份「修复状态」清单逐条标 ✅（含复查残留项），属已结案的历史记录 |

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 搞懂整体架构 / 全部配置项 | guides/PROJECT_GUIDE.md |
| 在新设备上把 qq-bridge 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 发语音 / 换 QQ 账号后语音工具 401 | [guides/VOICE.md](guides/VOICE.md)（独立工具在仓库上一级 `../voice-tool/`） |
| 看 AI 烧了多少钱 / 计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md)、audits/TOKEN_COST_ANALYSIS.md |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md)、audits/CONSOLE_UI_REDESIGN_REPORT.md |
| 改代码前先知道有哪些坑 | [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md)（最新，DSH 适配）、audits/AUDIT_FIXES_2026-09-20.md、audits/AUDIT_REPORT_2026-09-20.md |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 这个项目要往哪走（QSH） | 上位目录的 `../../QSH-plan/`（总索引 `README.md`；另有工具面/技能/云部署/新仓库与官网四份专项） |

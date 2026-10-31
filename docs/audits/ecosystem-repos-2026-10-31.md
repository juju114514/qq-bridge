# QQ ↔ DSH 生态仓库分析（2026-10-31）

> 来源：`qq-dsh-生态仓库对比表.xlsx`（19 个仓库）。本文**只写我自己克隆后实测到的东西**，
> 不和表格互相印证；表格里说"未验证"的，我这边也标了实测结果。
>
> 克隆位置：`D:\repo-refs\`（22 个目录，含表格里 19 个 + 3 个表格外的）。
> 口径：源码 = `.js/.mjs/.cjs/.ts/.java/.py` 行数，排除 `node_modules/dist/build`。

## 一、先给一个整体判断

**这个生态里 13 个是同一个代码库的分叉**（qq-bridge 血缘），彼此高度相似；
真正独立的代码库只有 6 个：2 个重写（AI-group-friends、Warm-Isle）、4 个 DSH 插件。
所以"逐个分析"的实际含义是：**看每个 fork 相对上游多做了什么**，而不是看它整体。

## 二、实测总览

| 仓库 | 源码文件 | 行数 | 许可 | 类别 | 相对上游的实质增量 |
| --- | --- | --- | --- | --- | --- |
| xmanrui/dsh-im | 784 | 279,080 | MIT | 插件 | 9 个 IM 通道（含 QQ 官方 connector） |
| Lu-mi-nous/whale-talk | 488 | 88,037 | MIT | fork | 183 个测试、控制台插件、7 步安装流 |
| Sa1ted-Fi5h/better-qq-bridge-plus | 236 | 80,173 | MIT | fork | 贴吧（117KB！）、视频理解、GPT-SoVITS 语音 |
| adj18311/qq-bridge-plus | 228 | 76,998 | MIT | fork | 贴吧 + B 站教程 |
| MichengAI/dsh-im-connect | 344 | 64,864 | **Apache-2.0** | 插件 | 9 通道、TS 源码 + lib 双份 |
| h-D-ACE/dsh-qq | 222 | 54,772 | MIT | fork | TOTP 三级权限、控制中心、voice-tool 拆出 |
| Elysia10024/AI-group-friends | 340 | 53,710 | MIT | 重写 | `src/core/*` + 32 domains、qzone、bili-look |
| cyberhu-riaty/qq-bridge-gen3 | 147 | 48,393 | MIT | fork | 熟悉度评分、该不该回的判断、可撤销管理动作 |
| CUIGUFUFU/dsh-qq-bridge | 195 | 48,702 | MIT | fork | launcher/控制中心、interface-platform 抽象 |
| cheesehaqi/dsh-qq-onebot-bridge | 138 | 47,245 | MIT | 插件 | inbox.jsonl 录制回放、supervisor、napcat 拉起 |
| mario841859784/dsh-onebot | 144 | 44,564 | **BSD-3** | 插件 | t2i 文字卡、STT、306 用例、反向/正向 WS |
| Anran3366/Warm-Isle | 219 | 37,911 | **AGPL-3.0** | 重写 | Java/Spring Boot、记忆 v2、网页后台 |
| skk-art/qq-bridge-xiaojingyu | 122 | 36,733 | MIT | fork | 私聊主动唤醒修复 + B 站 MCP 工具 |
| Derpyu520/qq-bridge | 117 | 35,940 | MIT | 基线 | 生态原点，已停更 |
| sanskcz/qq-bridge-custom | 111 | 32,725 | MIT | fork | **零 token 小时压缩** + 每日配额预警 |
| YingMuZJ/douyin-group-bridge | 126 | 35,325 | MIT | 跑题 | 抖音群桥接（不是 QQ） |
| sliverp/DeepSeek-harness-qqbot | 17 | 2,853 | MIT | 插件 | 极简官方 Bot 插件（附件/文件工具） |
| happysnaker/qq-ai-bot | — | — | — | 不可用 | **实测：仓库 404**（表格标的"未验证"是对的） |

> 我们自己的 juju114514/qq-bridge 不在这个目录里（在 `D:\QQBot-open\qq-bridge`），
> 128 个源码文件、约 10.1k 行 `bridge.js` + 109 个 API 模块、117 个测试脚本。

## 三、值得抄的 8 个点（带文件位置）

| # | 点 | 出处 | 我们能抄什么 | 成本 |
| --- | --- | --- | --- | --- |
| 1 | **零 token 小时压缩** | `custom-sanskcz/src/hourly-summary.mjs`（9.8KB）+ `daily-quota.mjs`（9.9KB） | 低活跃小时把多轮压成摘要再进上下文；配额预警 | 小 |
| 2 | **贴吧抓取全套** | `betterplus-salted/src/tieba-lib.js`（117KB） | 我们没有贴吧；这是现成的实现（注意 MIT 可用） | 中 |
| 3 | **视频理解** | `betterplus-salted/src/video-understand.mjs`（7.7KB） | 我们有 `video-link/frames`，但它的"抽帧+转写+摘要"串法可对照 | 小 |
| 4 | **熟悉度 + 该不该回** | `gen3-cyberhu`（README 第 2/4 节） | 我们靠 `wake` 配置；它有"熟悉度评分 → 主动开口概率"的连续量 | 中 |
| 5 | **可撤销的管理动作** | `gen3-cyberhu`（第 9 节） | 改名片/发说说前存 undo 记录，误操作能回滚 | 小 |
| 6 | **TOTP 三级权限** | `hdace-dsh-qq` | 管理员二次验证（手机 TOTP），比单 token 强 | 小 |
| 7 | **inbox 录制回放** | `cheesehaqi-dsh-qq-onebot/lib/ops.js` + `control/lib/replay.mjs` | 把入站事件录成 jsonl，可离线回放复现 bug —— **对调试极有用** | 小 |
| 8 | **t2i 文字卡片** | `mario-dsh-onebot`（@napi-rs/canvas + fontkit） | 长文本渲染成图片发，规避 QQ 长消息限制 | 中 |

**明确不能抄的**：`Warm-Isle` 是 **AGPL-3.0**，代码不能进我们的 MIT 仓库；
`dsh-im-connect` 是 Apache-2.0，可以抄但要保留 NOTICE。

## 四、他们做对了、我们该反思的三件事

1. **插件式（装进 DSH）确实减少了运维**：`dsh-onebot` / `dsh-im` 都不用额外守护进程，
   随 DSH 生命周期走。我们的独立进程 + 守护脚本是"重"的。
2. **安装流程可以写成"七步"**：`whale-talk` 的 README 就是 0~7 步，每步一个命令 + 一句"应该看到什么"。
   —— 我们刚做的 `BEGINNER.md` 是同一思路，可以互相对照补漏。
3. **测试数量差异巨大**：`whale-talk` 183 个、`dsh-onebot` 306 用例，我们 117 个。
   但我们的测试是"护栏型"（棘轮/隐私/路由），不是"功能型" —— 数量不可直接比较。

## 五、能不能做成 DSH 插件？（重点）

### 结论先说

**能，但不该"整体转"；应该"薄插件 + 复用核心"。**

### 插件是怎么写的（看这 4 个真实实现）

| 插件 | 关键结构 | 对我们的启发 |
| --- | --- | --- |
| `dsh-onebot` | Cordis 插件，`inject = ['agents']`；自带**反向 WS 服务器**（NapCat 连进来）；CQ 解析 → 每会话一个 agent → 出站发送；自带 t2i/STT | 协议层可以自持，不依赖 SnowLuma 的 SDK |
| `dsh-im` | 同时挂 9 个通道 connector（QQ 官方、企微、钉钉、飞书、TG、Discord…），统一成 channel 抽象 | **多通道抽象**值得学：一个 `Channel` 接口，QQ 只是其中一个实现 |
| `dsh-qq-onebot-bridge` | 每群/每私聊一个 agent；**旁路录制**（inbox.jsonl）+ 回放 + supervisor | 旁路设计：录制/回放不参与决策，坏了也不影响发消息 |
| `sliverp-harness-qqbot` | 17 个文件、2.8k 行，只做官方 Bot + 附件 + `qq_send_file` | 最小可行插件就长这样 |

### 我们的三条可选路线

| 路线 | 做什么 | 工作量 | 值不值 |
| --- | --- | --- | --- |
| **A. 不转** | 保持独立进程 | 0 | 现阶段值：我们的价值在"行为层"（唤醒/记忆/表情/控制台），这些需要常驻进程与自己的调度 |
| **B. 薄插件 + 复用核心** | 写一个 Cordis 插件：接 OneBot → 调用我们抽出来的 `src/domains/*`（prompt 构建 / 唤醒判定 / 记忆 / 表情），进程内跑 | **大**（要先把 10k 行 `bridge.js` 里的领域逻辑抽成无副作用库，含调度器改造） | 只有当我们想做"DSH 生态里的主力 QQ 通道"时才值 |
| **C. 伴侣插件（推荐先做）** | 不发通道插件，发**能力插件**：人格卡包、工具白名单、控制台面板 —— 让用 `dsh-onebot`/`dsh-im` 的人也能用上我们的东西 | **小**（我们已有 `plugins/qq-agent-presets` 的雏形） | 立刻能做，且能引流到主仓库 |

### 如果真要做 B，最小可行切法

1. 抽 `prompt-builder`（现 `socialV2-prompt.js` + `role-card.js`）→ 纯函数，输入 state 输出字符串
2. 抽 `wake-policy`（何时该醒）→ 纯函数 + 定时器适配层
3. 抽 `memory`（人物库/长期记忆）→ 已有 `state/people.json`，改成可注入存储
4. 插件只做：OneBot 事件 → 组装 → 调这四块 → 发送
5. 控制台与调度器**留在独立进程**，插件通过 HTTP 连它 —— 这样只转"消息通路"，不转"大脑"

**风险**：两套运行形态会分叉（插件版少功能 → 文档/issue 混乱）。所以要么只做 C，要么 B 一次做对。

## 六、建议下一步（按性价比）

1. **抄 #1（零 token 小时压缩）** —— 直接对冲我们"每轮 15K tokens"的成本问题，和已有的 `roleInjectEvery` 互补
2. **抄 #7（inbox 录制回放）** —— 调 `reserved2` 的时序 bug 会快很多
3. **做 C（伴侣插件）** —— 让人用官方/插件通道也能装我们的 preset 与工具白名单
4. **B 暂缓** —— 除非明确要"进 DSH 生态当主通道"

## 七、附：克隆清单（22 个目录）

`AI-group-friends` `aigroup-elysia` `betterplus-salted` `cheesehaqi-dsh-qq-onebot`
`cuigu-dsh-qq` `custom-sanskcz` `douyin-bridge` `dsh-im-connect-micheng`
`firefly575` `gen3-cyberhu` `hdace-dsh-qq` `leonathan-mac` `mario-dsh-onebot`
`plus-adj18311` `sliverp-harness-qqbot` `upstream-derpyu520` `warm-isle-anran`
`whaletalk` `xiaojingyu` `xiaojingyu-skk` `qq-ai-bot-happysnaker`（失败，仓库 404）

表格里的 19 个 = 其中 19 个；多出来的是 `aigroup-elysia`、`firefly575`、`leonathan-mac`（之前就在）。